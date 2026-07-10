"""
Tests for the shared politeness stack extracted into fetch_discipline.py
(specs/teetime-availability-everywhere-plan.md §3).

`CircuitBreaker` / `_as_int` / `_as_price` / `_format_time12h` are already
exercised heavily (indirectly) by test_tee_time_foreup.py — this file adds
DIRECT unit coverage plus the new `SingleFlight` abstraction, which has no
other direct test (only indirect coverage via ForeUpProvider's single-flight
test).
"""

from __future__ import annotations

import asyncio

from app.services.tee_times.fetch_discipline import (
    CircuitBreaker,
    SingleFlight,
    _as_int,
    _as_price,
    _format_time12h,
)


class TestAsInt:
    def test_bool_before_int_guard(self):
        assert _as_int(True) is None
        assert _as_int(False) is None

    def test_real_int_passes_through(self):
        assert _as_int(4) == 4
        assert _as_int(0) == 0

    def test_numeric_string_coerces(self):
        assert _as_int("3") == 3

    def test_malformed_and_missing_are_none(self):
        assert _as_int("not-a-number") is None
        assert _as_int(None) is None
        assert _as_int([1, 2]) is None


class TestAsPrice:
    def test_bool_is_never_a_price(self):
        assert _as_price(True) is None
        assert _as_price(False) is None

    def test_zero_and_negative_are_unknown_never_fabricated(self):
        assert _as_price(0) is None
        assert _as_price(-5) is None

    def test_positive_numeric_passes_through_as_float(self):
        assert _as_price(49) == 49.0
        assert _as_price(49.5) == 49.5

    def test_numeric_string_coerces(self):
        assert _as_price("30") == 30.0

    def test_malformed_and_missing_are_none(self):
        assert _as_price("nope") is None
        assert _as_price(None) is None


class TestFormatTime12h:
    def test_morning(self):
        assert _format_time12h("07:10") == "7:10 AM"

    def test_noon(self):
        assert _format_time12h("12:00") == "12:00 PM"

    def test_midnight(self):
        assert _format_time12h("00:05") == "12:05 AM"

    def test_afternoon(self):
        assert _format_time12h("14:30") == "2:30 PM"


class TestCircuitBreakerDirect:
    def test_closed_allows(self):
        breaker = CircuitBreaker()
        assert breaker.allow() is True

    def test_three_failures_opens_and_blocks(self):
        clock = {"t": 0.0}
        breaker = CircuitBreaker(clock=lambda: clock["t"])
        for _ in range(3):
            breaker.record_failure()
        assert breaker.allow() is False

    def test_reopens_after_window_then_half_open_single_trial(self):
        clock = {"t": 0.0}
        breaker = CircuitBreaker(open_seconds=300.0, clock=lambda: clock["t"])
        for _ in range(3):
            breaker.record_failure()
        assert breaker.allow() is False
        clock["t"] += 300.0
        assert breaker.allow() is True   # half-open trial admitted
        assert breaker.allow() is False  # second concurrent trial blocked

    def test_success_resets(self):
        breaker = CircuitBreaker()
        breaker.record_failure()
        breaker.record_failure()
        breaker.record_success()
        breaker.record_failure()
        breaker.record_failure()
        # Only 2 consecutive failures since the reset — still closed.
        assert breaker.allow() is True


class TestSingleFlight:
    async def test_concurrent_calls_share_one_underlying_fetch(self):
        sf = SingleFlight()
        calls = []

        async def fetch():
            calls.append(1)
            await asyncio.sleep(0)
            return "result"

        results = await asyncio.gather(*[sf.run("k", fetch) for _ in range(5)])
        assert len(calls) == 1
        assert all(r == "result" for r in results)

    async def test_different_keys_do_not_share(self):
        sf = SingleFlight()
        calls = []

        async def fetch(key):
            calls.append(key)
            return key

        await asyncio.gather(sf.run("a", lambda: fetch("a")), sf.run("b", lambda: fetch("b")))
        assert sorted(calls) == ["a", "b"]

    async def test_sequential_calls_after_completion_each_run_again(self):
        sf = SingleFlight()
        calls = []

        async def fetch():
            calls.append(1)
            return len(calls)

        first = await sf.run("k", fetch)
        second = await sf.run("k", fetch)
        assert first == 1
        assert second == 2
        assert len(calls) == 2

    async def test_exception_propagates_to_all_waiters_and_clears_inflight(self):
        sf = SingleFlight()
        started = asyncio.Event()
        release = asyncio.Event()

        async def boom():
            started.set()
            await release.wait()
            raise RuntimeError("upstream exploded")

        async def run_and_capture():
            try:
                await sf.run("k", boom)
                return None
            except RuntimeError as exc:
                return str(exc)

        # Start the owning call first and let it actually begin the fetch
        # (an internal await point) before the two waiters join the SAME
        # in-flight future — otherwise there's no real concurrency to dedupe.
        owner = asyncio.create_task(run_and_capture())
        await started.wait()
        waiters = [asyncio.create_task(run_and_capture()) for _ in range(2)]
        await asyncio.sleep(0)  # let waiters reach `await existing`
        release.set()

        results = await asyncio.gather(owner, *waiters)
        assert results == ["upstream exploded"] * 3
        # Inflight entry was cleaned up — a subsequent call runs fresh.
        assert "k" not in sf._inflight
