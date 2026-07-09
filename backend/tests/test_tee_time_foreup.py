"""
Tests for ForeUpProvider (specs/teetime-s1-foreup-plan.md §8b).

The fixture (backend/tests/fixtures/foreup_18mile_times.json) is a REAL live
capture of foreUP's public times endpoint for 18 Mile Creek Golf Course
(Hamburg, NY) — captured via
`scripts/validate_foreup_courses.py --capture-fixture`. NEVER hand-edit it.
Every assertion below is DERIVED from the fixture's actual contents at test
runtime (re-implementing the documented normalize/filter rules independently,
not by calling into the provider) — never a hand-typed count or time that
could quietly drift or be bent.
"""

from __future__ import annotations

import asyncio
import dataclasses
import inspect
import json
import re
from datetime import datetime
from pathlib import Path

import httpx

import app.services.tee_times.foreup as foreup_module
from app.services.rate_limit import SlidingWindowLimiter
from app.services.tee_times.base import BookingDetails, TeeTimeQuery, TeeTimeSlot
from app.services.tee_times.capability_store import CourseBookingCapability
from app.services.tee_times.foreup import (
    FOREUP_HOST,
    MAX_SLOTS_PER_COURSE,
    USER_AGENT,
    CircuitBreaker,
    ForeUpProvider,
)

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "foreup_18mile_times.json"
FIXTURE_RAW: list[dict] = json.loads(FIXTURE_PATH.read_text())
FIXTURE_DATE = FIXTURE_RAW[0]["time"].split(" ")[0]


# ── Sanity gate: the capture is real (plan §8a) ────────────────────────────────

def test_fixture_is_a_real_nonempty_capture():
    assert isinstance(FIXTURE_RAW, list)
    assert len(FIXTURE_RAW) > 0
    for e in FIXTURE_RAW:
        assert isinstance(e.get("time"), str) and e["time"].startswith(FIXTURE_DATE)
        assert "available_spots" in e


# ── Fixtures / fakes ────────────────────────────────────────────────────────────

def _cap(**overrides) -> CourseBookingCapability:
    defaults = dict(
        platform="foreup",
        course_id=None,
        foreup_booking_id="20410",
        schedule_id="4467",
        booking_url="https://foreupsoftware.com/index.php/booking/20410/4467",
        phone="(716) 648-4410",
        is_private=False,
        verified_at="2026-07-09T00:00:00Z",
        name="18 Mile Creek Golf Course",
        lat=42.714304,
        lng=-78.813114,
        aliases=(),
    )
    defaults.update(overrides)
    return CourseBookingCapability(**defaults)


def _query(**overrides) -> TeeTimeQuery:
    defaults = dict(
        date=FIXTURE_DATE,
        time_window_start="00:00",
        time_window_end="23:59",
        party_size=1,
    )
    defaults.update(overrides)
    return TeeTimeQuery(**defaults)


class FakeCacheStore:
    """Minimal in-memory SearchCacheStore fake with an injectable clock."""

    def __init__(self, now_fn=lambda: 0.0, ttl_seconds: float = 480.0) -> None:
        self._now = now_fn
        self._ttl = ttl_seconds
        self._data: dict[str, tuple[float, list]] = {}

    def get(self, key: str):
        entry = self._data.get(key)
        if entry is None:
            return None
        cached_at, value = entry
        if self._now() - cached_at >= self._ttl:
            return None
        return value

    def set(self, key: str, value) -> None:
        self._data[key] = (self._now(), value)


def _fixture_transport(*, status_code: int = 200, calls: list | None = None) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(request)
        return httpx.Response(status_code, json=FIXTURE_RAW)
    return httpx.MockTransport(handler)


def _provider(*, transport=None, cache=None, limiter=None, breaker=None) -> ForeUpProvider:
    return ForeUpProvider(
        cache=cache if cache is not None else FakeCacheStore(),
        transport=transport if transport is not None else _fixture_transport(),
        limiter=limiter if limiter is not None else SlidingWindowLimiter(rpm=1000, window_s=60),
        breaker=breaker if breaker is not None else CircuitBreaker(),
    )


def _fixture_qualifying(
    party_size: int, *, window_start: str = "00:00", window_end: str = "23:59"
) -> list[dict]:
    """Independently re-derive the expected qualifying entries straight from
    the raw fixture by re-implementing the documented rules (§3d/§3e) — NOT
    by calling into the provider. Used to assert provider output without any
    hand-typed counts/times."""
    ws = datetime.strptime(window_start, "%H:%M").time()
    we = datetime.strptime(window_end, "%H:%M").time()
    out = []
    for e in FIXTURE_RAW:
        date_part, _, time_part = e["time"].partition(" ")
        if date_part != FIXTURE_DATE:
            continue
        t = datetime.strptime(time_part, "%H:%M").time()
        if not (ws <= t <= we):
            continue
        spots = e.get("available_spots")
        if not isinstance(spots, int) or isinstance(spots, bool) or spots < party_size:
            continue
        out.append({"time": time_part, "players": spots, "green_fee": e.get("green_fee")})
    out.sort(key=lambda d: d["time"])
    return out


# ── Request shape (§3c) ─────────────────────────────────────────────────────────

class TestRequestShape:
    async def test_exact_params_and_headers(self):
        calls: list[httpx.Request] = []
        provider = _provider(transport=_fixture_transport(calls=calls))
        slots = await provider.slots_for_capability(_cap(), _query())
        assert slots is not None
        assert len(calls) == 1

        req = calls[0]
        assert req.url.host == FOREUP_HOST
        assert req.url.path == "/index.php/api/booking/times"
        params = dict(req.url.params)
        assert params["time"] == "all"
        assert params["date"] == datetime.strptime(FIXTURE_DATE, "%Y-%m-%d").strftime("%m-%d-%Y")
        assert params["holes"] == "all"
        assert params["players"] == "1"
        assert params["booking_class"] == "false"
        assert params["schedule_id"] == "4467"
        assert params["specials_only"] == "0"
        assert params["api_key"] == "no_limits"
        assert req.headers["api-key"] == "no_limits"
        assert req.headers["user-agent"] == USER_AGENT


# ── Parse / normalize ────────────────────────────────────────────────────────────

class TestParseNormalize:
    async def test_emitted_slots_match_fixture_derived_shape(self):
        cap = _cap()
        provider = _provider()
        slots = await provider.slots_for_capability(cap, _query(party_size=1))
        assert slots

        expected = _fixture_qualifying(1)
        assert len(slots) == min(len(expected), MAX_SLOTS_PER_COURSE)

        expected_times = {e["time"] for e in expected}
        for s in slots:
            assert s.provider == "foreup"
            assert s.route is None
            assert s.estimated is False
            assert s.date == FIXTURE_DATE
            assert s.booking_url == cap.booking_url
            assert s.id == f"foreup-{cap.foreup_booking_id}-{FIXTURE_DATE}-{s.time}-{slots.index(s)}"
            assert s.time in expected_times


# ── Window filter ────────────────────────────────────────────────────────────────

class TestWindowFilter:
    async def test_derived_subwindow_returns_exact_fixture_times(self):
        window_start, window_end = "12:00", "15:00"
        expected = _fixture_qualifying(1, window_start=window_start, window_end=window_end)
        assert expected, "sanity: the chosen window must contain fixture times"
        assert len(expected) < len(FIXTURE_RAW), "sanity: window must be a strict subset"

        provider = _provider()
        slots = await provider.slots_for_capability(
            _cap(), _query(time_window_start=window_start, time_window_end=window_end)
        )
        assert [s.time for s in slots] == [e["time"] for e in expected][:MAX_SLOTS_PER_COURSE]

    async def test_window_with_no_fixture_times_is_verified_empty(self):
        all_times = {e["time"].split(" ")[1] for e in FIXTURE_RAW}
        assert "01:00" not in all_times and "02:00" not in all_times  # sanity

        provider = _provider()
        slots = await provider.slots_for_capability(
            _cap(), _query(time_window_start="01:00", time_window_end="02:00")
        )
        assert slots == []  # verified empty, not None

    async def test_malformed_window_returns_none(self):
        provider = _provider()
        slots = await provider.slots_for_capability(
            _cap(), _query(time_window_start="not-a-time", time_window_end="10:00")
        )
        assert slots is None


# ── Party filter ──────────────────────────────────────────────────────────────────

class TestPartyFilter:
    async def test_party_size_filter_matches_derived_expectation(self):
        party_size = 4
        expected = _fixture_qualifying(party_size)
        assert expected, "sanity: some entries must pass"
        assert len(expected) < len(FIXTURE_RAW), "sanity: some entries must fail"

        provider = _provider()
        slots = await provider.slots_for_capability(_cap(), _query(party_size=party_size))
        assert [s.time for s in slots] == [e["time"] for e in expected][:MAX_SLOTS_PER_COURSE]

        expected_by_time = {e["time"]: e for e in expected}
        for s in slots:
            assert s.players >= party_size
            # players is the real available_spots — never an echo of party_size.
            assert s.players == expected_by_time[s.time]["players"]


# ── Price mapping ─────────────────────────────────────────────────────────────────

class TestPriceMapping:
    async def test_numeric_green_fee_maps_to_float_from_fixture(self):
        provider = _provider()
        slots = await provider.slots_for_capability(_cap(), _query(party_size=1))
        assert slots

        fixture_by_hhmm = {e["time"].split(" ")[1]: e for e in FIXTURE_RAW}
        for s in slots:
            fee = fixture_by_hhmm[s.time]["green_fee"]
            if isinstance(fee, (int, float)) and not isinstance(fee, bool) and fee > 0:
                assert s.price_usd == float(fee)


_SYNTHETIC_FALSE_HEAVY = [
    {"time": f"{FIXTURE_DATE} 09:00", "available_spots": False, "green_fee": 45, "teesheet_holes": 18},
    {"time": f"{FIXTURE_DATE} 10:00", "available_spots": 2, "green_fee": False, "teesheet_holes": False},
    {"time": f"{FIXTURE_DATE} 11:00", "available_spots": 4, "green_fee": 0, "teesheet_holes": 9},
    {"time": f"{FIXTURE_DATE} 12:00", "available_spots": True, "green_fee": 30, "teesheet_holes": 18},
]


class TestFalseHandling:
    """A hand-built SYNTHETIC payload (labeled as such — never presented as
    the live capture) exercising foreUP's documented `false`-instead-of-null
    quirk across every field."""

    async def test_false_heavy_synthetic_payload_never_raises(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=_SYNTHETIC_FALSE_HEAVY)

        provider = _provider(transport=httpx.MockTransport(handler))
        slots = await provider.slots_for_capability(_cap(), _query(party_size=1))
        assert slots is not None

        by_time = {s.time: s for s in slots}
        # available_spots=False -> whole slot dropped (never overstate capacity).
        assert "09:00" not in by_time
        # available_spots=True (bool) -> also dropped (bool-as-int trap).
        assert "12:00" not in by_time
        # green_fee False + teesheet_holes False -> price None, holes defaults to 18.
        ten = by_time["10:00"]
        assert ten.price_usd is None
        assert ten.holes == 18
        # green_fee == 0 -> treated as unknown, never fabricated as free; holes=9 kept.
        eleven = by_time["11:00"]
        assert eleven.price_usd is None
        assert eleven.holes == 9


# ── max_price_usd ─────────────────────────────────────────────────────────────────

class TestMaxPrice:
    async def test_over_budget_dropped_unknown_price_kept(self):
        payload = [
            {"time": f"{FIXTURE_DATE} 09:00", "available_spots": 2, "green_fee": 100, "teesheet_holes": 18},
            {"time": f"{FIXTURE_DATE} 10:00", "available_spots": 2, "green_fee": False, "teesheet_holes": 18},
            {"time": f"{FIXTURE_DATE} 11:00", "available_spots": 2, "green_fee": 20, "teesheet_holes": 18},
        ]

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=payload)

        provider = _provider(transport=httpx.MockTransport(handler))
        slots = await provider.slots_for_capability(
            _cap(), _query(party_size=1, max_price_usd=50.0)
        )
        times = {s.time for s in slots}
        assert "09:00" not in times   # over budget -> dropped
        assert "10:00" in times       # unknown price -> kept (never claimed in budget)
        assert "11:00" in times       # under budget -> kept


# ── MAX_SLOTS_PER_COURSE truncation ────────────────────────────────────────────

class TestTruncation:
    async def test_truncates_to_earliest_n_sorted_ascending(self):
        expected = _fixture_qualifying(1)
        assert len(expected) > MAX_SLOTS_PER_COURSE, "sanity: fixture must exceed the cap"

        provider = _provider()
        slots = await provider.slots_for_capability(_cap(), _query(party_size=1))
        assert len(slots) == MAX_SLOTS_PER_COURSE
        expected_times = [e["time"] for e in expected][:MAX_SLOTS_PER_COURSE]
        assert [s.time for s in slots] == expected_times
        assert expected_times == sorted(expected_times)


# ── Error legs — never raise ────────────────────────────────────────────────────

class TestErrorLegs:
    async def test_transport_error_returns_none(self):
        def handler(request: httpx.Request):
            raise httpx.ConnectError("boom", request=request)
        provider = _provider(transport=httpx.MockTransport(handler))
        assert await provider.slots_for_capability(_cap(), _query()) is None

    async def test_timeout_returns_none(self):
        def handler(request: httpx.Request):
            raise httpx.TimeoutException("timeout", request=request)
        provider = _provider(transport=httpx.MockTransport(handler))
        assert await provider.slots_for_capability(_cap(), _query()) is None

    async def test_http_500_returns_none(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="server error")
        provider = _provider(transport=httpx.MockTransport(handler))
        assert await provider.slots_for_capability(_cap(), _query()) is None

    async def test_http_403_returns_none(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(403, text="forbidden")
        provider = _provider(transport=httpx.MockTransport(handler))
        assert await provider.slots_for_capability(_cap(), _query()) is None

    async def test_non_array_json_body_returns_none(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"not": "an array"})
        provider = _provider(transport=httpx.MockTransport(handler))
        assert await provider.slots_for_capability(_cap(), _query()) is None

    async def test_malformed_date_returns_none_without_network_call(self):
        calls: list[httpx.Request] = []
        provider = _provider(transport=_fixture_transport(calls=calls))
        assert await provider.slots_for_capability(_cap(), _query(date="not-a-date")) is None
        assert calls == []

    async def test_search_availability_error_legs_return_empty_never_raise(self):
        def handler(request: httpx.Request):
            raise httpx.ConnectError("boom", request=request)
        provider = ForeUpProvider(
            capabilities=lambda: (_cap(),),
            cache=FakeCacheStore(),
            transport=httpx.MockTransport(handler),
            limiter=SlidingWindowLimiter(rpm=1000, window_s=60),
            breaker=CircuitBreaker(),
        )
        slots = await provider.search_availability(_query(area=f"{_cap().lat},{_cap().lng}"))
        assert slots == []

    async def test_search_availability_no_origin_returns_empty(self):
        provider = _provider(cache=FakeCacheStore())
        assert await provider.search_availability(_query(area=None)) == []


# ── Cache ────────────────────────────────────────────────────────────────────────

class TestCache:
    async def test_second_call_within_ttl_makes_zero_http_calls(self):
        calls: list[httpx.Request] = []
        cache = FakeCacheStore()
        provider = _provider(transport=_fixture_transport(calls=calls), cache=cache)
        await provider.slots_for_capability(_cap(), _query())
        assert len(calls) == 1
        await provider.slots_for_capability(_cap(), _query())
        assert len(calls) == 1  # still one — served from cache

    async def test_refetch_after_ttl_expiry(self):
        calls: list[httpx.Request] = []
        clock = {"t": 0.0}
        cache = FakeCacheStore(now_fn=lambda: clock["t"], ttl_seconds=480.0)
        provider = _provider(transport=_fixture_transport(calls=calls), cache=cache)
        await provider.slots_for_capability(_cap(), _query())
        assert len(calls) == 1
        clock["t"] += 480.0
        await provider.slots_for_capability(_cap(), _query())
        assert len(calls) == 2

    async def test_verified_empty_day_is_a_valid_cache_hit(self):
        calls: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(200, json=[])

        cache = FakeCacheStore()
        provider = _provider(transport=httpx.MockTransport(handler), cache=cache)
        assert await provider.slots_for_capability(_cap(), _query()) == []
        assert await provider.slots_for_capability(_cap(), _query()) == []
        assert len(calls) == 1  # no re-poll storm on a sold-out day


# ── Single-flight ────────────────────────────────────────────────────────────────

class TestSingleFlight:
    async def test_five_concurrent_calls_make_exactly_one_http_call(self):
        calls: list[httpx.Request] = []
        provider = _provider(transport=_fixture_transport(calls=calls), cache=FakeCacheStore())
        results = await asyncio.gather(*[
            provider.slots_for_capability(_cap(), _query()) for _ in range(5)
        ])
        assert len(calls) == 1
        assert all(r is not None for r in results)


# ── Rate limiter ───────────────────────────────────────────────────────────────────

class TestRateLimiter:
    async def test_limiter_at_cap_returns_none_zero_http_no_breaker_failure(self):
        calls: list[httpx.Request] = []
        limiter = SlidingWindowLimiter(rpm=1, window_s=60)
        limiter.check(FOREUP_HOST)  # consume the one slot in the window
        breaker = CircuitBreaker()
        provider = _provider(transport=_fixture_transport(calls=calls), limiter=limiter, breaker=breaker)

        result = await provider.slots_for_capability(_cap(), _query())
        assert result is None
        assert calls == []
        assert breaker.allow() is True  # self-throttling never counts as a breaker failure


# ── Circuit breaker ────────────────────────────────────────────────────────────────

class TestCircuitBreaker:
    async def test_three_consecutive_failures_open_then_fourth_call_makes_no_http(self):
        calls: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(500, text="err")

        breaker = CircuitBreaker()
        limiter = SlidingWindowLimiter(rpm=1000, window_s=60)
        provider = _provider(transport=httpx.MockTransport(handler), breaker=breaker, limiter=limiter)

        for _ in range(3):
            assert await provider.slots_for_capability(_cap(), _query()) is None
        assert len(calls) == 3

        assert await provider.slots_for_capability(_cap(), _query()) is None
        assert len(calls) == 3  # breaker open — zero additional HTTP

    async def test_half_open_trial_success_closes_breaker(self):
        calls: list[httpx.Request] = []
        state = {"fail": True}

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            if state["fail"]:
                return httpx.Response(500, text="err")
            return httpx.Response(200, json=FIXTURE_RAW)

        clock = {"t": 0.0}
        breaker = CircuitBreaker(clock=lambda: clock["t"])
        limiter = SlidingWindowLimiter(rpm=1000, window_s=60, clock=lambda: clock["t"])
        provider = _provider(transport=httpx.MockTransport(handler), breaker=breaker, limiter=limiter)

        for _ in range(3):
            await provider.slots_for_capability(_cap(), _query())
        assert len(calls) == 3

        clock["t"] += 300.0
        state["fail"] = False
        result = await provider.slots_for_capability(_cap(), _query())
        assert result is not None
        assert len(calls) == 4

    async def test_half_open_trial_failure_reopens(self):
        calls: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(500, text="err")

        clock = {"t": 0.0}
        breaker = CircuitBreaker(clock=lambda: clock["t"])
        limiter = SlidingWindowLimiter(rpm=1000, window_s=60, clock=lambda: clock["t"])
        provider = _provider(transport=httpx.MockTransport(handler), breaker=breaker, limiter=limiter)

        for _ in range(3):
            await provider.slots_for_capability(_cap(), _query())
        assert len(calls) == 3

        clock["t"] += 300.0
        result = await provider.slots_for_capability(_cap(), _query())
        assert result is None
        assert len(calls) == 4  # the one half-open trial

        result2 = await provider.slots_for_capability(_cap(), _query())
        assert result2 is None
        assert len(calls) == 4  # re-opened — no further HTTP until another 300s


# ── book() ─────────────────────────────────────────────────────────────────────────

class TestBook:
    async def test_book_returns_needs_human_with_time_and_course_name(self):
        provider = _provider()
        slot = TeeTimeSlot(
            id="foreup-20410-2026-07-11-07:10-0",
            course_id="foreup-20410",
            course_name="18 Mile Creek Golf Course",
            city="",
            date="2026-07-11",
            time="07:10",
            players=2,
            price_usd=24.0,
            cart_included=False,
            distance_miles=0.0,
            rating=0.0,
            provider="foreup",
            holes=18,
            booking_url="https://foreupsoftware.com/index.php/booking/20410/4467",
            route=None,
        )
        result = await provider.book(slot, BookingDetails(name="Owner", party_size=2))
        assert result.status == "needs_human"
        assert result.confirmation_number is None
        assert result.booking_url == slot.booking_url
        assert "7:10 AM" in (result.message or "")
        assert "18 Mile Creek Golf Course" in (result.message or "")

    async def test_name_property(self):
        assert _provider().name == "foreup"


# ── S2 invariants (specs/teetime-s2-plan.md §3b) ────────────────────────────
# foreUP booking is ALWAYS a deep-link handoff — never programmatic booking.
# These pin the five S2 invariants at the source-code level so a future edit
# to foreup.py that starts confirming/charging fails a test, not a review hope.

def _s2_slot(**overrides) -> TeeTimeSlot:
    defaults = dict(
        id="foreup-20410-2026-07-11-07:10-0",
        course_id="foreup-20410",
        course_name="18 Mile Creek Golf Course",
        city="",
        date="2026-07-11",
        time="07:10",
        players=2,
        price_usd=24.0,
        cart_included=False,
        distance_miles=0.0,
        rating=0.0,
        provider="foreup",
        holes=18,
        booking_url="https://foreupsoftware.com/index.php/booking/20410/4467",
        route=None,
    )
    defaults.update(overrides)
    return TeeTimeSlot(**defaults)


class TestS2Invariants:
    async def test_universal_needs_human_across_a_sweep_of_slot_shapes(self):
        """Every book() result -> status=needs_human, confirmation_number=None,
        regardless of booking_url/time/route on the slot. The missing-
        booking_url case must yield an honestly-absent booking_url — never a
        fabricated one."""
        provider = _provider()
        sweep = [
            _s2_slot(),
            _s2_slot(booking_url=None),  # missing booking_url case
            _s2_slot(time=""),
            _s2_slot(route="book_on_site"),
            _s2_slot(booking_url=None, time="", route="book_on_site"),
        ]
        for slot in sweep:
            result = await provider.book(slot, BookingDetails(name="Owner", party_size=2))
            assert result.status == "needs_human", slot
            assert result.confirmation_number is None, slot

        # Missing-booking_url case: honestly absent, never invented.
        missing_url_result = await provider.book(
            _s2_slot(booking_url=None), BookingDetails(name="Owner", party_size=2)
        )
        assert missing_url_result.booking_url is None

    def test_provider_surface_guard_no_confirm_no_write_verbs_no_card_data(self):
        """Source-level guard: the foreUP provider module can never confirm a
        booking, can never write to foreUP (GET-only), and structurally
        cannot carry card/payment/credential data."""
        src = inspect.getsource(foreup_module)
        assert 'status="confirmed"' not in src
        assert "client.post" not in src
        assert "client.put" not in src
        assert re.search(r"card|payment|cvv|credit", src, re.I) is None

        # Anti-scope-creep guard: BookingDetails may carry ONLY the golfer's
        # own identity + the honest requested search window (S3 added
        # time_window_start/end so the AI-call route can ask the pro shop for a
        # real window when a routed slot has no time of its own). It must NEVER
        # grow a card/payment/credential field — that is the invariant. Any new
        # field forces a conscious update here.
        field_names = {f.name for f in dataclasses.fields(BookingDetails)}
        assert field_names == {
            "name", "party_size", "email", "phone",
            "time_window_start", "time_window_end",
        }
        # Belt-and-suspenders: no field name ever hints at payment data.
        assert not any(
            re.search(r"card|payment|cvv|credit|account|routing_number", f, re.I)
            for f in field_names
        )
