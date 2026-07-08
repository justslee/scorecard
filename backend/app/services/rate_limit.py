"""
Caddie / voice LLM rate limiting.

Two-tier per-user limiter guarding the paid LLM (+ compute-heavy) endpoints.
See ``specs/caddie-llm-rate-limiting-plan.md`` for the full design.

  1. **Tier 1 — sliding-window RPM (in-process).** A per-user ``deque`` of
     request timestamps. Catches fast bursts (a bug-loop hammering an
     endpoint). In-process is correct at ``--workers 1`` (current prod); a
     restart harmlessly clears it.
  2. **Tier 2 — daily budget (file-backed, survives restarts).** A JSON file
     keyed by UTC calendar day holding per-user request counts (and a coarse
     estimated-token accumulator), modeled line-for-line on
     ``FileBudgetStore`` in ``app/services/golfapi_cache.py``. Catches a
     slow-but-relentless leak that stays under the RPM ceiling.

Both tiers share **one bucket per user** across every protected endpoint.

Fail-OPEN: availability over strictness for a golf app (NORTHSTAR: calm,
fail-to-honest-state). Any internal error in the limiter's own storage/logic
is logged loudly at ERROR and the request is ALLOWED. The only exception that
ever escapes ``CaddieRateLimiter.enforce`` is the intentional
``HTTPException(429)``.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import time
from abc import ABC, abstractmethod
from collections import deque
from math import ceil
from pathlib import Path
from typing import Callable, Optional

from fastapi import Depends, HTTPException

from app.services.clerk_auth import OWNER_CLERK_USER_ID, current_user_id

log = logging.getLogger("looper.ratelimit")

_DATA_DIR = Path(__file__).parent.parent.parent / "data"

# Short, in-character, no machine markers — kept under 90 chars so
# `humanizeVoiceError` on the frontend treats it as raw and shows its own
# calm fallback (see plan §5); this string is for logs / curl / a future FE tweak.
_CALM_429_DETAIL = "Easy — too many at once. Give me a sec and ask again."

# Soft cap on distinct tracked users in the in-process RPM dict (defense against
# unbounded memory growth). User ids are authenticated Clerk subs, so growth is
# bounded by real users; this is a belt-and-suspenders sweep, not a real limit.
MAX_TRACKED_USERS = 10_000

# Coarse per-request token estimate accumulated into the daily token budget.
# The dependency-injection dependency (`caddie_rate_limited_user`) has no
# access to the request body, so we use a fixed conservative estimate derived
# from the documented worst case (plan §1): ~4000-char input cap (~1000
# tokens) + max_tokens=300 completion.
DEFAULT_EST_TOKENS_PER_REQUEST = 1000 + 300


# ── Tier 1 — in-process sliding-window RPM ─────────────────────────────────────

class SlidingWindowLimiter:
    """In-process sliding-window RPM limiter, keyed by ``user_id``.

    Holds ``dict[user_id, deque[float]]`` of request timestamps (from an
    injectable ``clock``, default ``time.monotonic`` — immune to wall-clock
    jumps/NTP/DST). Fully synchronous (no ``await``), so it is atomic under
    the single-threaded event loop — no lock needed.
    """

    def __init__(
        self,
        rpm: int,
        window_s: float,
        clock: Callable[[], float] = time.monotonic,
        max_tracked_users: int = MAX_TRACKED_USERS,
    ) -> None:
        self.rpm = rpm
        self.window_s = window_s
        self._clock = clock
        self._max_tracked_users = max_tracked_users
        self._windows: dict[str, deque] = {}

    def _evict(self, window: deque, now: float) -> None:
        while window and now - window[0] >= self.window_s:
            window.popleft()

    def check(self, user_id: str, *, rpm: Optional[int] = None) -> Optional[float]:
        """Returns ``None`` when allowed (and records the request), else the
        Retry-After seconds (float, always >= 0) when the window is full."""
        limit = rpm if rpm is not None else self.rpm
        now = self._clock()
        window = self._windows.setdefault(user_id, deque())
        self._evict(window, now)

        if len(window) >= limit:
            retry_after = max(0.0, self.window_s - (now - window[0]))
            result: Optional[float] = retry_after
        else:
            window.append(now)
            result = None

        if len(self._windows) > self._max_tracked_users:
            self.sweep(now)

        return result

    def sweep(self, now: Optional[float] = None) -> int:
        """Evict stale timestamps from every tracked user's window and drop
        any user whose window is empty afterward (mitigation for unbounded
        memory growth — see plan §6). Returns the number of users dropped.

        Safe to call directly (e.g. periodic hygiene, or from tests); called
        automatically from ``check`` once the tracked-user soft cap is
        exceeded.
        """
        now = now if now is not None else self._clock()
        dropped = 0
        for uid in list(self._windows.keys()):
            window = self._windows[uid]
            self._evict(window, now)
            if not window:
                del self._windows[uid]
                dropped += 1
        return dropped


# ── Tier 2 — file-backed daily budget ──────────────────────────────────────────

class DailyBudgetStore(ABC):
    """Abstract per-user daily request/token counter. Injectable for tests."""

    @abstractmethod
    def get(self, user_id: str) -> dict:
        """Return ``{"requests": int, "est_tokens": int}`` for ``user_id`` on
        the current UTC day (zeroed if the stored day has rolled over)."""
        raise NotImplementedError

    @abstractmethod
    def add(self, user_id: str, *, requests: int, est_tokens: int) -> dict:
        """Increment counters for ``user_id``; return the new totals dict."""
        raise NotImplementedError


class FileDailyBudgetStore(DailyBudgetStore):
    """JSON-file-backed daily per-user counter: ``backend/data/caddie_rate_limit.json``.

    Modeled line-for-line on ``FileBudgetStore`` in ``golfapi_cache.py``.
    Resets automatically when the UTC calendar day changes. File structure::

        {"day": "2026-07-08", "users": {"user_abc": {"requests": 12, "est_tokens": 15840}}}

    UTC-day boundary via an injectable ``now`` callable (mirrors
    ``FileBudgetStore._current_month``) — DST-safe by construction because
    the boundary is UTC, not local.
    """

    def __init__(
        self,
        path: Optional[Path] = None,
        now: Callable[[], datetime.datetime] = datetime.datetime.utcnow,
    ) -> None:
        self._path = path or (_DATA_DIR / "caddie_rate_limit.json")
        self._now = now

    def _current_day(self) -> str:
        return self._now().strftime("%Y-%m-%d")

    def _load(self) -> dict:
        if not self._path.exists():
            return {}
        try:
            return json.loads(self._path.read_text())
        except Exception:
            return {}

    def _save(self, data: dict) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(json.dumps(data, indent=2))

    def get(self, user_id: str) -> dict:
        data = self._load()
        if data.get("day") != self._current_day():
            return {"requests": 0, "est_tokens": 0}
        entry = data.get("users", {}).get(user_id, {})
        return {
            "requests": int(entry.get("requests", 0)),
            "est_tokens": int(entry.get("est_tokens", 0)),
        }

    def add(self, user_id: str, *, requests: int, est_tokens: int) -> dict:
        data = self._load()
        day = self._current_day()
        if data.get("day") != day:
            data = {"day": day, "users": {}}
        users = data.setdefault("users", {})
        prior = users.get(user_id, {})
        entry = {
            "requests": int(prior.get("requests", 0)) + requests,
            "est_tokens": int(prior.get("est_tokens", 0)) + est_tokens,
        }
        users[user_id] = entry
        self._save(data)
        log.info(
            "caddie_rate_limit: daily +%d req (+%d est_tokens) user=%s day=%s total=%d req/%d tok",
            requests, est_tokens, user_id[:12], day, entry["requests"], entry["est_tokens"],
        )
        return entry


# ── Composition ─────────────────────────────────────────────────────────────────

class CaddieRateLimiter:
    """Composes the RPM + daily-budget tiers into one per-user ``enforce`` call.

    Fail-OPEN: any internal (non-HTTPException) error during enforcement is
    logged loudly at ERROR and the request is ALLOWED. Only the intentional
    ``HTTPException(429)`` escapes ``enforce``.
    """

    def __init__(
        self,
        *,
        enabled: bool,
        window_limiter: SlidingWindowLimiter,
        daily_store: DailyBudgetStore,
        daily_requests_cap: int,
        daily_tokens_cap: int,
        owner_id: Optional[str] = None,
        owner_multiplier: float = 1.0,
        now: Callable[[], datetime.datetime] = datetime.datetime.utcnow,
    ) -> None:
        self.enabled = enabled
        self._window = window_limiter
        self._daily = daily_store
        self._daily_requests_cap = daily_requests_cap
        self._daily_tokens_cap = daily_tokens_cap
        self._owner_id = owner_id
        self._owner_multiplier = owner_multiplier
        self._now = now

    @classmethod
    def from_env(cls) -> "CaddieRateLimiter":
        """Build the module singleton from env (see plan §1 for the table).
        Only used for the process-wide singleton — tests construct
        ``CaddieRateLimiter`` directly with explicit args, never via env."""
        enabled = os.getenv("CADDIE_RATE_ENABLED", "1") != "0"
        rpm = int(os.getenv("CADDIE_RATE_RPM", "30"))
        window_s = float(os.getenv("CADDIE_RATE_WINDOW_S", "60"))
        daily_requests = int(os.getenv("CADDIE_RATE_DAILY_REQUESTS", "1500"))
        daily_tokens = int(os.getenv("CADDIE_RATE_DAILY_TOKENS", "4000000"))
        owner_multiplier = float(os.getenv("CADDIE_RATE_OWNER_MULTIPLIER", "1.0"))
        return cls(
            enabled=enabled,
            window_limiter=SlidingWindowLimiter(rpm=rpm, window_s=window_s),
            daily_store=FileDailyBudgetStore(),
            daily_requests_cap=daily_requests,
            daily_tokens_cap=daily_tokens,
            owner_id=OWNER_CLERK_USER_ID,
            owner_multiplier=owner_multiplier,
        )

    def _is_owner(self, user_id: str) -> bool:
        return bool(self._owner_id) and user_id == self._owner_id

    def _seconds_to_utc_midnight(self) -> float:
        now = self._now()
        tomorrow_midnight = (now + datetime.timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        return max(0.0, (tomorrow_midnight - now).total_seconds())

    def _reject(
        self,
        tier: str,
        retry_after: float,
        user_id: str,
        *,
        count: int,
        limit: int,
        is_owner: bool,
    ) -> None:
        retry_int = max(1, ceil(retry_after))
        log.warning(
            "ratelimit hit tier=%s user=%s count=%d limit=%d retry_after=%ds owner=%s",
            tier, user_id[:12], count, limit, retry_int, is_owner,
        )
        raise HTTPException(
            status_code=429,
            detail=_CALM_429_DETAIL,
            headers={"Retry-After": str(retry_int)},
        )

    async def enforce(
        self, user_id: str, *, est_tokens: int = DEFAULT_EST_TOKENS_PER_REQUEST
    ) -> None:
        """Enforce both tiers for ``user_id``. Raises ``HTTPException(429)``
        on a limit hit; otherwise returns (allowed) and records the request."""
        if not self.enabled:
            return

        try:
            is_owner = self._is_owner(user_id)
            mult = self._owner_multiplier if is_owner else 1.0

            # Tier 1 — sliding-window RPM.
            rpm_limit = max(1, int(self._window.rpm * mult))
            retry = self._window.check(user_id, rpm=rpm_limit)
            if retry is not None:
                self._reject(
                    "rpm", retry, user_id, count=rpm_limit, limit=rpm_limit, is_owner=is_owner
                )

            # Tier 2 — daily budget (requests + coarse est-token ceiling).
            daily_req_cap = max(1, int(self._daily_requests_cap * mult))
            daily_tok_cap = max(1, int(self._daily_tokens_cap * mult))
            current = self._daily.get(user_id)

            if current["requests"] >= daily_req_cap:
                self._reject(
                    "daily",
                    self._seconds_to_utc_midnight(),
                    user_id,
                    count=current["requests"],
                    limit=daily_req_cap,
                    is_owner=is_owner,
                )
            if current["est_tokens"] >= daily_tok_cap:
                self._reject(
                    "daily",
                    self._seconds_to_utc_midnight(),
                    user_id,
                    count=current["est_tokens"],
                    limit=daily_tok_cap,
                    is_owner=is_owner,
                )

            self._daily.add(user_id, requests=1, est_tokens=est_tokens)
        except HTTPException:
            raise
        except Exception:
            log.exception(
                "ratelimit fail-open: internal error enforcing limit for user=%s — allowing request",
                user_id[:12] if user_id else user_id,
            )
            return


# ── Module singleton + dependency factory ──────────────────────────────────────

_limiter = CaddieRateLimiter.from_env()


async def caddie_rate_limited_user(user_id: str = Depends(current_user_id)) -> str:
    """Drop-in replacement for ``Depends(current_user_id)`` on paid/heavy
    endpoints: composes auth with per-user rate limiting and returns the same
    user id, so callers need no other signature change (see plan §4)."""
    await _limiter.enforce(user_id)
    return user_id
