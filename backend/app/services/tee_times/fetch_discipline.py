"""
Shared "politeness stack" for tee-time availability adapters
(specs/teetime-availability-everywhere-plan.md §3).

Extracted verbatim (behavior-for-behavior) from `foreup.py` (S1) so every new
engine adapter (TeeItUp, and later rungs) reuses the exact same discipline
instead of re-implementing it: an honest identifying User-Agent, a bounded
request timeout, a per-host circuit breaker, an asyncio single-flight
dedupe helper, and the `false`-instead-of-null coercion guards that keep a
malformed upstream field from silently mis-stating capacity or price.

CRITICAL: this module changes ZERO foreUP runtime behavior — `foreup.py`
imports these names instead of defining them; every S1 foreUP test still
exercises the exact same code, just via one more import hop. Each adapter
gets its OWN `CircuitBreaker` / rate limiter / cache instances (per-host,
never shared across engines — see plan §3 "keep foreUP's own singletons
foreUP-scoped").
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Awaitable, Callable, Literal, TypeVar

log = logging.getLogger(__name__)

# ─── Module constants (pinned literals) ────────────────────────────────────────

USER_AGENT = "Looper/1.0 (golf tee-time availability)"   # same style as osm.py
REQUEST_TIMEOUT_S = 8.0
AVAILABILITY_CACHE_TTL_S = 480          # 8 min — inside the required 5-10 min band


# ─── Defensive value coercion — bool-before-int is load-bearing ───────────────

def _as_int(v: object) -> int | None:
    """Coerce an upstream field to a real int, or None when absent/malformed.

    `isinstance(v, bool)` MUST be checked before `isinstance(v, int)` —
    Python bools are ints, so a field like `available_spots: false` (or
    `true`) would otherwise pass as 0 (or 1) and silently mis-state capacity.
    """
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, str):
        try:
            return int(v)
        except ValueError:
            return None
    return None


def _as_price(v: object) -> float | None:
    """Coerce an upstream fee field to a positive float, or None. `0`/negative/
    non-numeric/bool/false/missing are all "unknown" — NEVER fabricated,
    never coerced to 0."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v) if v > 0 else None
    if isinstance(v, str):
        try:
            f = float(v)
        except ValueError:
            return None
        return f if f > 0 else None
    return None


def _format_time12h(hhmm: str) -> str:
    """"07:10" -> "7:10 AM" — mirrors frontend formatTime12hOrEmpty."""
    h, m = (int(x) for x in hhmm.split(":"))
    period = "AM" if h < 12 else "PM"
    hour = h % 12 or 12
    return f"{hour}:{m:02d} {period}"


# ─── Circuit breaker ────────────────────────────────────────────────────────────

class CircuitBreaker:
    """Small per-host circuit breaker (one instance per engine host).

    closed -> (>=3 consecutive failures) -> open (300s) -> half-open (ONE
    trial) -> success closes (resets failure count) / failure re-opens for
    another `open_seconds`.
    """

    def __init__(
        self,
        failure_threshold: int = 3,
        open_seconds: float = 300.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._failure_threshold = failure_threshold
        self._open_seconds = open_seconds
        self._clock = clock
        self._failures = 0
        self._state: Literal["closed", "open", "half_open"] = "closed"
        self._opened_at: float | None = None

    def allow(self) -> bool:
        if self._state == "closed":
            return True
        if self._state == "half_open":
            # Exactly one trial already admitted — block until it resolves
            # (record_success / record_failure).
            return False
        # open
        if self._opened_at is not None and self._clock() - self._opened_at >= self._open_seconds:
            self._state = "half_open"
            return True
        return False

    def record_success(self) -> None:
        self._failures = 0
        self._state = "closed"
        self._opened_at = None

    def record_failure(self, reason: str | None = None) -> None:
        self._failures += 1
        if self._state == "half_open" or self._failures >= self._failure_threshold:
            log.warning(
                "fetch_discipline breaker OPEN (%d consecutive failures, last status=%s) — "
                "serving routing fallback for %ds",
                self._failures, reason, int(self._open_seconds),
            )
            self._state = "open"
            self._opened_at = self._clock()


# ─── asyncio single-flight ──────────────────────────────────────────────────────

_T = TypeVar("_T")


class SingleFlight:
    """Generalizes `ForeUpProvider._fetch_day`'s inflight-future dedup (S1) so
    every adapter can reuse it: concurrent callers sharing a `key` await ONE
    in-flight coroutine instead of issuing duplicate upstream requests.

    Each adapter owns its own `SingleFlight` instance (per-host, like the
    breaker/limiter) — callers pass a zero-arg async `fn` that does its own
    double-checked cache read + fetch + cache write.
    """

    def __init__(self) -> None:
        self._inflight: dict[str, "asyncio.Future[_T]"] = {}

    async def run(self, key: str, fn: Callable[[], Awaitable[_T]]) -> _T:
        existing = self._inflight.get(key)
        if existing is not None:
            return await existing

        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._inflight[key] = fut
        try:
            result = await fn()
            fut.set_result(result)
            return result
        except BaseException as exc:
            if not fut.done():
                fut.set_exception(exc)
            raise
        finally:
            del self._inflight[key]
