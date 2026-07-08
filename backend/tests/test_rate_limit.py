"""Tests for rate_limit — no real DB, no network, no time.sleep.

All tests use an injectable monotonic clock (for the RPM tier) and an
injectable ``now`` (for the UTC-day daily tier), plus ``tmp_path`` for the
file-backed daily store. Deterministic and fully offline — mirrors the
injectable/offline style of ``tests/test_golfapi_cache.py``.

Covers plan §9:
  1. RPM window boundary (Nth allowed, N+1th raises 429)
  2. Sliding-window recovery (full window pass + partial-expiry capacity)
  3. 429 shape + Retry-After (status, calm detail, header bounds)
  4. Per-user isolation
  5. Daily-budget cap + UTC rollover + file round-trip (survives "restart")
  6. Est-token cap (independent of request count)
  7. Fail-OPEN on a raising store
  8. Kill-switch (CADDIE_RATE_ENABLED semantics via `enabled=False`)
  9. Memory eviction (stale deque key removed; MAX_TRACKED_USERS sweep)
  10. Owner multiplier (owner gets N x ceiling; non-owner gets 1x)
"""

from __future__ import annotations

import datetime

import pytest
from fastapi import HTTPException

from app.services.rate_limit import (
    CaddieRateLimiter,
    DailyBudgetStore,
    FileDailyBudgetStore,
    SlidingWindowLimiter,
    _CALM_429_DETAIL,
)


# ── Fakes ───────────────────────────────────────────────────────────────────────

class FakeClock:
    """Manually-advanced monotonic-style clock (seconds, float)."""

    def __init__(self, start: float = 1000.0) -> None:
        self._t = start

    def __call__(self) -> float:
        return self._t

    def advance(self, seconds: float) -> None:
        self._t += seconds


class FakeNow:
    """Manually-advanced UTC `datetime` clock for the daily-budget tier."""

    def __init__(self, start: datetime.datetime | None = None) -> None:
        self._t = start or datetime.datetime(2026, 7, 8, 12, 0, 0)

    def __call__(self) -> datetime.datetime:
        return self._t

    def advance(self, **kwargs) -> None:
        self._t += datetime.timedelta(**kwargs)

    def set_next_day(self) -> None:
        self._t = (self._t + datetime.timedelta(days=1)).replace(
            hour=0, minute=5, second=0, microsecond=0
        )


class InMemoryDailyBudgetStore(DailyBudgetStore):
    """Dict-backed daily budget — no file I/O. UTC-day-aware like the file store."""

    def __init__(self, now=datetime.datetime.utcnow) -> None:
        self._now = now
        self._day: str | None = None
        self._users: dict[str, dict] = {}

    def _current_day(self) -> str:
        return self._now().strftime("%Y-%m-%d")

    def _roll_if_needed(self) -> None:
        day = self._current_day()
        if self._day != day:
            self._day = day
            self._users = {}

    def get(self, user_id: str) -> dict:
        self._roll_if_needed()
        entry = self._users.get(user_id, {})
        return {"requests": int(entry.get("requests", 0)), "est_tokens": int(entry.get("est_tokens", 0))}

    def add(self, user_id: str, *, requests: int, est_tokens: int) -> dict:
        self._roll_if_needed()
        prior = self._users.get(user_id, {"requests": 0, "est_tokens": 0})
        entry = {
            "requests": prior["requests"] + requests,
            "est_tokens": prior["est_tokens"] + est_tokens,
        }
        self._users[user_id] = entry
        return entry


class RaisingDailyBudgetStore(DailyBudgetStore):
    """Always raises — used to prove fail-OPEN."""

    def get(self, user_id: str) -> dict:
        raise RuntimeError("simulated storage failure")

    def add(self, user_id: str, *, requests: int, est_tokens: int) -> dict:
        raise RuntimeError("simulated storage failure")


def _make_limiter(
    *,
    rpm: int = 30,
    window_s: float = 60,
    daily_requests_cap: int = 1500,
    daily_tokens_cap: int = 4_000_000,
    clock=None,
    now=None,
    daily_store=None,
    enabled: bool = True,
    owner_id: str | None = None,
    owner_multiplier: float = 1.0,
    max_tracked_users: int = 10_000,
) -> tuple[CaddieRateLimiter, FakeClock, FakeNow]:
    clock = clock or FakeClock()
    now = now or FakeNow()
    window_limiter = SlidingWindowLimiter(
        rpm=rpm, window_s=window_s, clock=clock, max_tracked_users=max_tracked_users
    )
    store = daily_store if daily_store is not None else InMemoryDailyBudgetStore(now=now)
    limiter = CaddieRateLimiter(
        enabled=enabled,
        window_limiter=window_limiter,
        daily_store=store,
        daily_requests_cap=daily_requests_cap,
        daily_tokens_cap=daily_tokens_cap,
        owner_id=owner_id,
        owner_multiplier=owner_multiplier,
        now=now,
    )
    return limiter, clock, now


# ── 1. RPM window boundary ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_rpm_window_boundary_nth_allowed_n_plus_1_rejected() -> None:
    limiter, clock, _ = _make_limiter(rpm=3, window_s=60)

    for _ in range(3):
        await limiter.enforce("user-a")  # 1st..3rd allowed

    with pytest.raises(HTTPException) as exc_info:
        await limiter.enforce("user-a")  # 4th rejected

    assert exc_info.value.status_code == 429


# ── 2. Sliding-window recovery ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_sliding_window_recovers_after_full_window_pass() -> None:
    limiter, clock, _ = _make_limiter(rpm=2, window_s=60)

    await limiter.enforce("user-a")
    await limiter.enforce("user-a")
    with pytest.raises(HTTPException):
        await limiter.enforce("user-a")

    clock.advance(61)  # past the window
    await limiter.enforce("user-a")  # allowed again


@pytest.mark.asyncio
async def test_sliding_window_partial_expiry_capacity() -> None:
    limiter, clock, _ = _make_limiter(rpm=3, window_s=60)

    await limiter.enforce("user-a")  # t=0
    clock.advance(50)
    await limiter.enforce("user-a")  # t=50
    clock.advance(20)  # t=70 -> first request (t=0) now stale (>60s old)

    # Capacity should be RPM - (still-in-window=1) = 2 more allowed.
    await limiter.enforce("user-a")  # allowed (window: [50,70] -> now has 70,70)
    await limiter.enforce("user-a")  # allowed
    with pytest.raises(HTTPException):
        await limiter.enforce("user-a")  # window full again


# ── 3. 429 shape + Retry-After ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_429_shape_rpm() -> None:
    limiter, clock, _ = _make_limiter(rpm=1, window_s=60)
    await limiter.enforce("user-a")

    with pytest.raises(HTTPException) as exc_info:
        await limiter.enforce("user-a")

    exc = exc_info.value
    assert exc.status_code == 429
    assert exc.detail == _CALM_429_DETAIL
    assert "{" not in exc.detail
    assert "detail" not in exc.detail
    retry_after = int(exc.headers["Retry-After"])
    assert retry_after > 0
    assert retry_after <= 60


@pytest.mark.asyncio
async def test_429_shape_daily() -> None:
    limiter, _, now = _make_limiter(rpm=1000, daily_requests_cap=1)
    await limiter.enforce("user-a")

    with pytest.raises(HTTPException) as exc_info:
        await limiter.enforce("user-a")

    exc = exc_info.value
    assert exc.status_code == 429
    assert exc.detail == _CALM_429_DETAIL
    retry_after = int(exc.headers["Retry-After"])
    assert 0 < retry_after <= 86400


# ── 4. Per-user isolation ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_per_user_isolation_rpm() -> None:
    limiter, clock, _ = _make_limiter(rpm=1, window_s=60)
    await limiter.enforce("user-a")

    with pytest.raises(HTTPException):
        await limiter.enforce("user-a")

    await limiter.enforce("user-b")  # unaffected by user-a's exhaustion


@pytest.mark.asyncio
async def test_per_user_isolation_daily() -> None:
    limiter, _, _ = _make_limiter(rpm=1000, daily_requests_cap=1)
    await limiter.enforce("user-a")

    with pytest.raises(HTTPException):
        await limiter.enforce("user-a")

    await limiter.enforce("user-b")  # unaffected


# ── 5. Daily-budget cap + UTC rollover + file round-trip ────────────────────────

@pytest.mark.asyncio
async def test_daily_cap_and_utc_rollover() -> None:
    limiter, _, now = _make_limiter(rpm=1000, daily_requests_cap=2)

    await limiter.enforce("user-a")
    await limiter.enforce("user-a")
    with pytest.raises(HTTPException):
        await limiter.enforce("user-a")

    now.set_next_day()  # UTC day rolls over
    await limiter.enforce("user-a")  # allowed again


def test_file_daily_budget_store_round_trip_survives_restart(tmp_path) -> None:
    path = tmp_path / "caddie_rate_limit.json"
    now = FakeNow()

    store1 = FileDailyBudgetStore(path=path, now=now)
    store1.add("user-a", requests=3, est_tokens=900)

    # A brand-new store instance pointed at the same path == "restart".
    store2 = FileDailyBudgetStore(path=path, now=now)
    result = store2.get("user-a")

    assert result == {"requests": 3, "est_tokens": 900}


def test_file_daily_budget_store_resets_on_utc_day_rollover(tmp_path) -> None:
    path = tmp_path / "caddie_rate_limit.json"
    now = FakeNow()

    store = FileDailyBudgetStore(path=path, now=now)
    store.add("user-a", requests=5, est_tokens=100)
    assert store.get("user-a")["requests"] == 5

    now.set_next_day()
    assert store.get("user-a") == {"requests": 0, "est_tokens": 0}

    # Re-adding on the new day starts fresh, not accumulated onto the old count.
    store.add("user-a", requests=1, est_tokens=10)
    assert store.get("user-a") == {"requests": 1, "est_tokens": 10}


# ── 6. Est-token cap ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_est_token_cap_independent_of_request_count() -> None:
    limiter, _, _ = _make_limiter(rpm=1000, daily_requests_cap=1000, daily_tokens_cap=100)

    await limiter.enforce("user-a", est_tokens=60)
    await limiter.enforce("user-a", est_tokens=60)  # total 120 >= 100 cap, but this call itself allowed pre-check

    with pytest.raises(HTTPException) as exc_info:
        await limiter.enforce("user-a", est_tokens=1)

    assert exc_info.value.status_code == 429


# ── 7. Fail-OPEN ──────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_fail_open_on_raising_daily_store(caplog) -> None:
    limiter, _, _ = _make_limiter(daily_store=RaisingDailyBudgetStore())

    with caplog.at_level("ERROR", logger="looper.ratelimit"):
        await limiter.enforce("user-a")  # must NOT raise — fail-open

    assert any("fail-open" in rec.message for rec in caplog.records)


# ── 8. Kill-switch ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_kill_switch_disabled_always_allows() -> None:
    limiter, clock, _ = _make_limiter(rpm=1, window_s=60, enabled=False)

    for _ in range(10):
        await limiter.enforce("user-a")  # never raises, even far past rpm=1


# ── 9. Memory eviction ────────────────────────────────────────────────────────────

def test_sliding_window_sweep_removes_stale_empty_keys() -> None:
    clock = FakeClock()
    window = SlidingWindowLimiter(rpm=5, window_s=60, clock=clock)

    window.check("user-a")
    assert "user-a" in window._windows

    clock.advance(61)  # user-a's only timestamp is now stale
    dropped = window.sweep()

    assert dropped == 1
    assert "user-a" not in window._windows


def test_sliding_window_max_tracked_users_auto_sweep() -> None:
    clock = FakeClock()
    window = SlidingWindowLimiter(rpm=5, window_s=60, clock=clock, max_tracked_users=3)

    # Fill 3 users, then let them all go stale.
    window.check("user-1")
    window.check("user-2")
    window.check("user-3")
    assert len(window._windows) == 3

    clock.advance(61)  # all 3 users' timestamps are now stale

    # The 4th distinct user pushes tracked-count over max_tracked_users,
    # triggering an automatic sweep that drops the stale ones.
    window.check("user-4")

    assert "user-1" not in window._windows
    assert "user-2" not in window._windows
    assert "user-3" not in window._windows
    assert "user-4" in window._windows


# ── 10. Owner multiplier ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_owner_multiplier_doubles_rpm_ceiling() -> None:
    limiter, clock, _ = _make_limiter(
        rpm=2, window_s=60, owner_id="owner-123", owner_multiplier=2.0
    )

    # Owner gets 2x == 4 allowed before a 429.
    for _ in range(4):
        await limiter.enforce("owner-123")
    with pytest.raises(HTTPException):
        await limiter.enforce("owner-123")


@pytest.mark.asyncio
async def test_owner_multiplier_does_not_affect_non_owner() -> None:
    limiter, clock, _ = _make_limiter(
        rpm=2, window_s=60, owner_id="owner-123", owner_multiplier=2.0
    )

    # A non-owner still gets the base 1x ceiling == 2.
    await limiter.enforce("regular-user")
    await limiter.enforce("regular-user")
    with pytest.raises(HTTPException):
        await limiter.enforce("regular-user")


@pytest.mark.asyncio
async def test_owner_multiplier_doubles_daily_ceiling() -> None:
    limiter, _, _ = _make_limiter(
        rpm=1000, daily_requests_cap=2, owner_id="owner-123", owner_multiplier=2.0
    )

    for _ in range(4):
        await limiter.enforce("owner-123")
    with pytest.raises(HTTPException):
        await limiter.enforce("owner-123")


# ── 10.6 (plan) manual sanity — inline as an automated test too ─────────────────

@pytest.mark.asyncio
async def test_manual_sanity_rpm_2_third_call_429_with_retry_after() -> None:
    limiter, clock, _ = _make_limiter(rpm=2, window_s=60)

    await limiter.enforce("sanity-user")
    await limiter.enforce("sanity-user")

    with pytest.raises(HTTPException) as exc_info:
        await limiter.enforce("sanity-user")

    exc = exc_info.value
    assert exc.status_code == 429
    assert "Retry-After" in exc.headers
    assert int(exc.headers["Retry-After"]) >= 1
