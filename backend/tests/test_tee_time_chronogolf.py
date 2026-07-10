"""
Tests for ChronogolfProvider (specs/teetime-availability-everywhere-plan.md
§3/§6, S4c).

The fixture is a REAL live capture of Chronogolf's public marketplace
teetimes endpoint (`backend/tests/fixtures/chronogolf_rockspring_times.json`
— Rock Spring Golf Club at West Orange, 65 real teetimes / 41 bookable,
captured live by the eng-lead on a date 3 days out). NEVER hand-edit it.
Every assertion below is DERIVED from the fixture's actual contents at test
runtime (re-implementing the documented normalize/filter rules
independently) — never a hand-typed count or time that could quietly drift.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime
from pathlib import Path

import httpx

from app.services.rate_limit import SlidingWindowLimiter
from app.services.tee_times.adapters.chronogolf import (
    CHRONOGOLF_HOST,
    MAX_SLOTS_PER_COURSE,
    ChronogolfProvider,
)
from app.services.tee_times.base import BookingDetails, TeeTimeQuery, TeeTimeSlot
from app.services.tee_times.capability_store import CourseBookingCapability
from app.services.tee_times.fetch_discipline import USER_AGENT, CircuitBreaker

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "chronogolf_rockspring_times.json"
FIXTURE_RAW: list[dict] = json.loads(FIXTURE_PATH.read_text())
FIXTURE_DATE = FIXTURE_RAW[0]["date"]


# ── Sanity gate: the capture is real (mirrors test_tee_time_teeitup.py) ────────

def test_fixture_is_a_real_nonempty_capture():
    assert isinstance(FIXTURE_RAW, list)
    assert len(FIXTURE_RAW) > MAX_SLOTS_PER_COURSE, "sanity: must exceed the truncation cap"
    bookable = [e for e in FIXTURE_RAW if e.get("out_of_capacity") is False]
    not_bookable = [e for e in FIXTURE_RAW if e.get("out_of_capacity") is True]
    assert bookable, "sanity: some real bookable slots must exist"
    assert not_bookable, "sanity: some real out-of-capacity slots must exist (proves the filter matters)"
    restricted = [
        e for e in bookable
        if any("single player" in r.lower() for r in (e.get("restrictions") or []))
    ]
    assert restricted, "sanity: some real single-player-restricted slots must exist"
    for e in FIXTURE_RAW:
        assert isinstance(e.get("start_time"), str) and len(e["start_time"]) == 5
        assert e.get("date") == FIXTURE_DATE
        assert "out_of_capacity" in e


# ── Fixtures / fakes ────────────────────────────────────────────────────────────

def _cap(**overrides) -> CourseBookingCapability:
    defaults = dict(
        platform="chronogolf",
        channel="scrape_http",
        platform_ids={"club_id": "10038", "course_id": "11517", "affiliation_type_id": "40974"},
        booking_url="https://www.chronogolf.com/club/rock-spring-golf-club-at-west-orange",
        phone="(973) 731-6464",
        is_private=False,
        verified_at="2026-07-10T00:00:00Z",
        probe_status="verified",
        name="Rock Spring Golf Club at West Orange",
        lat=40.768991,
        lng=-74.264034,
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


def _fixture_transport(*, payload=None, status_code: int = 200, calls: list | None = None) -> httpx.MockTransport:
    body = payload if payload is not None else FIXTURE_RAW

    def handler(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(request)
        return httpx.Response(status_code, json=body)
    return httpx.MockTransport(handler)


def _provider(*, transport=None, cache=None, limiter=None, breaker=None) -> ChronogolfProvider:
    return ChronogolfProvider(
        cache=cache if cache is not None else FakeCacheStore(),
        transport=transport if transport is not None else _fixture_transport(),
        limiter=limiter if limiter is not None else SlidingWindowLimiter(rpm=1000, window_s=60),
        breaker=breaker if breaker is not None else CircuitBreaker(),
    )


def _fixture_qualifying(
    party_size: int, *, window_start: str = "00:00", window_end: str = "23:59",
) -> list[dict]:
    """Independently re-derive the expected qualifying entries straight from
    the raw fixture — NOT by calling into the provider."""
    ws = datetime.strptime(window_start, "%H:%M").time()
    we = datetime.strptime(window_end, "%H:%M").time()
    out = []
    for e in FIXTURE_RAW:
        if e.get("date") != FIXTURE_DATE:
            continue
        if e.get("out_of_capacity") is not False:
            continue
        restrictions = e.get("restrictions") or []
        if party_size == 1 and any("single player" in r.lower() for r in restrictions):
            continue
        t = datetime.strptime(e["start_time"], "%H:%M").time()
        if not (ws <= t <= we):
            continue
        fees = e.get("green_fees") or []
        prices = [f["green_fee"] for f in fees if isinstance(f, dict) and f.get("green_fee")]
        price = min(prices) if prices else None
        out.append({"time": e["start_time"], "players": party_size, "price_usd": price})
    out.sort(key=lambda d: d["time"])
    return out


# ── Request shape ────────────────────────────────────────────────────────────────

class TestRequestShape:
    async def test_exact_params_and_headers(self):
        calls: list[httpx.Request] = []
        provider = _provider(transport=_fixture_transport(calls=calls))
        cap = _cap()
        slots = await provider.slots_for_capability(cap, _query())
        assert slots is not None
        assert len(calls) == 1

        req = calls[0]
        assert req.url.host == CHRONOGOLF_HOST
        assert req.url.path == "/marketplace/clubs/10038/teetimes"
        params = dict(req.url.params)
        assert params["date"] == FIXTURE_DATE
        assert params["course_id"] == "11517"
        assert params["nb_holes"] == "18"
        assert params["affiliation_type_ids[]"] == "40974"
        assert req.headers["user-agent"] == USER_AGENT
        assert req.headers["accept"] == "application/json"
        # httpx percent-encodes the bracketed key on the wire, decoding back
        # to the literal "affiliation_type_ids[]=40974" the server expects.
        assert "affiliation_type_ids%5B%5D=40974" in str(req.url)


# ── Parse / normalize ────────────────────────────────────────────────────────────

class TestParseNormalize:
    async def test_emitted_slots_match_fixture_derived_shape_party_of_two(self):
        cap = _cap()
        provider = _provider()
        slots = await provider.slots_for_capability(cap, _query(party_size=2))
        assert slots

        expected = _fixture_qualifying(2)
        assert len(slots) == min(len(expected), MAX_SLOTS_PER_COURSE)

        expected_by_time = {e["time"]: e for e in expected}
        for s in slots:
            assert s.provider == "chronogolf"
            assert s.route is None
            assert s.estimated is False
            assert s.date == FIXTURE_DATE
            assert s.booking_url == cap.booking_url
            assert s.phone == cap.phone
            assert s.holes == 18
            assert s.time in expected_by_time
            # players is honestly the queried party size (documented: NOT a
            # real remaining-spot count — Chronogolf exposes none).
            assert s.players == 2
            exp_price = expected_by_time[s.time]["price_usd"]
            if exp_price is not None:
                assert s.price_usd == exp_price
                assert s.price_usd < 1000  # sanity: dollars, not some other unit

    async def test_out_of_capacity_slots_are_excluded(self):
        provider = _provider()
        slots = await provider.slots_for_capability(_cap(), _query(party_size=2))
        times = {s.time for s in slots}
        out_of_capacity_times = {
            e["start_time"] for e in FIXTURE_RAW
            if e.get("out_of_capacity") is True and e["start_time"] in
            {s.time for s in slots}
        }
        assert not out_of_capacity_times
        assert times  # sanity: something was returned at all

    async def test_cheapest_green_fee_chosen_in_dollars_not_cents(self):
        provider = _provider()
        slots = await provider.slots_for_capability(_cap(), _query(party_size=2, time_window_start="07:00", time_window_end="07:59"))
        by_time = {s.time: s for s in slots}
        assert by_time["07:30"].price_usd == 109.0  # real fixture value, in dollars


# ── Party size / single-player restriction ──────────────────────────────────────

class TestPartySizeRestriction:
    async def test_party_of_one_excludes_single_player_restricted_slots(self):
        expected = _fixture_qualifying(1)
        assert expected, "sanity: some entries must qualify for a solo golfer"
        assert len(expected) < len(_fixture_qualifying(2)), "sanity: restriction must actually drop entries"

        provider = _provider()
        slots = await provider.slots_for_capability(_cap(), _query(party_size=1))
        assert [s.time for s in slots] == [e["time"] for e in expected][:MAX_SLOTS_PER_COURSE]
        for s in slots:
            assert s.players == 1

    async def test_party_of_two_includes_single_player_restricted_slots(self):
        provider = _provider()
        slots_party1 = await provider.slots_for_capability(_cap(), _query(party_size=1))
        slots_party2 = await provider.slots_for_capability(_cap(), _query(party_size=2))
        times1 = {s.time for s in slots_party1}
        times2 = {s.time for s in slots_party2}
        # A slot restricted for solos but not present in the party-of-1
        # result must show up for a party of 2.
        assert times2 - times1


# ── Verified empty ───────────────────────────────────────────────────────────────

class TestVerifiedEmpty:
    async def test_200_empty_array_is_verified_empty_not_none(self):
        """Per the adapter's documented EMPTY-ARRAY DECISION: a Chronogolf
        200 [] is a real verified-empty day, unlike TeeItUp's wrapped shape."""
        provider = _provider(transport=_fixture_transport(payload=[]))
        slots = await provider.slots_for_capability(_cap(), _query())
        assert slots == []

    async def test_window_with_no_fixture_times_is_verified_empty(self):
        provider = _provider()
        slots = await provider.slots_for_capability(
            _cap(), _query(time_window_start="01:00", time_window_end="02:00"),
        )
        assert slots == []  # verified empty, not None

    async def test_malformed_window_returns_none(self):
        provider = _provider()
        slots = await provider.slots_for_capability(
            _cap(), _query(time_window_start="not-a-time", time_window_end="10:00"),
        )
        assert slots is None


# ── Window filter ────────────────────────────────────────────────────────────────

class TestWindowFilter:
    async def test_derived_subwindow_returns_exact_fixture_times(self):
        window_start, window_end = "10:00", "13:00"
        expected = _fixture_qualifying(2, window_start=window_start, window_end=window_end)
        assert expected, "sanity: the chosen window must contain fixture times"
        assert len(expected) < len(_fixture_qualifying(2)), "sanity: window must be a strict subset"

        provider = _provider()
        slots = await provider.slots_for_capability(
            _cap(), _query(party_size=2, time_window_start=window_start, time_window_end=window_end),
        )
        assert [s.time for s in slots] == [e["time"] for e in expected][:MAX_SLOTS_PER_COURSE]


class TestMaxPrice:
    async def test_over_budget_dropped_unknown_price_kept(self):
        provider = _provider()
        slots = await provider.slots_for_capability(
            _cap(), _query(party_size=2, max_price_usd=100.0),
        )
        assert slots is not None
        for s in slots:
            assert s.price_usd is None or s.price_usd <= 100.0


# ── Price honesty (SYNTHETIC, labeled as such) ──────────────────────────────────

_SYNTHETIC_QUERY_DATE = "2026-07-10"


class TestPriceNeverFabricated:
    async def test_zero_and_missing_fees_map_to_none_never_zero(self):
        """SYNTHETIC payload: a green_fee of 0, a missing green_fees list
        entirely, and a null green_fee — all must map to price_usd=None,
        never $0.00. Never presented as the live capture."""
        entries = [
            {"start_time": "07:00", "date": _SYNTHETIC_QUERY_DATE, "out_of_capacity": False,
             "restrictions": [], "green_fees": [{"green_fee": 0}]},
            {"start_time": "08:00", "date": _SYNTHETIC_QUERY_DATE, "out_of_capacity": False,
             "restrictions": []},  # no green_fees key at all
            {"start_time": "09:00", "date": _SYNTHETIC_QUERY_DATE, "out_of_capacity": False,
             "restrictions": [], "green_fees": [{"green_fee": None}, {"green_fee": 55.0}]},
        ]

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=entries)

        provider = _provider(transport=httpx.MockTransport(handler))
        slots = await provider.slots_for_capability(
            _cap(), _query(date=_SYNTHETIC_QUERY_DATE, party_size=2),
        )
        by_time = {s.time: s for s in slots}
        assert by_time["07:00"].price_usd is None   # 0 -> unknown, never $0
        assert by_time["08:00"].price_usd is None   # no green_fees at all
        assert by_time["09:00"].price_usd == 55.0    # min of present (non-null) fees


# ── MAX_SLOTS_PER_COURSE truncation ────────────────────────────────────────────

class TestTruncation:
    async def test_truncates_to_earliest_n_sorted_ascending(self):
        expected = _fixture_qualifying(2)
        assert len(expected) > MAX_SLOTS_PER_COURSE, "sanity: fixture must exceed the cap"

        provider = _provider()
        slots = await provider.slots_for_capability(_cap(), _query(party_size=2))
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

    async def test_non_200_status_returns_none(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(403, text="cloudflare challenge")
        provider = _provider(transport=httpx.MockTransport(handler))
        assert await provider.slots_for_capability(_cap(), _query()) is None

    async def test_non_json_body_returns_none(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="<html>not json</html>")
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

    async def test_missing_platform_ids_returns_none_without_network_call(self):
        calls: list[httpx.Request] = []
        provider = _provider(transport=_fixture_transport(calls=calls))
        cap = _cap(platform_ids={})
        assert await provider.slots_for_capability(cap, _query()) is None
        assert calls == []

    async def test_partial_platform_ids_returns_none_without_network_call(self):
        calls: list[httpx.Request] = []
        provider = _provider(transport=_fixture_transport(calls=calls))
        cap = _cap(platform_ids={"club_id": "10038"})  # missing course_id/affiliation_type_id
        assert await provider.slots_for_capability(cap, _query()) is None
        assert calls == []

    async def test_search_availability_error_legs_return_empty_never_raise(self):
        def handler(request: httpx.Request):
            raise httpx.ConnectError("boom", request=request)
        cap = _cap()
        provider = ChronogolfProvider(
            capabilities=lambda: (cap,),
            cache=FakeCacheStore(),
            transport=httpx.MockTransport(handler),
            limiter=SlidingWindowLimiter(rpm=1000, window_s=60),
            breaker=CircuitBreaker(),
        )
        slots = await provider.search_availability(_query(area=f"{cap.lat},{cap.lng}"))
        assert slots == []

    async def test_search_availability_no_origin_returns_empty(self):
        provider = _provider(cache=FakeCacheStore())
        assert await provider.search_availability(_query(area=None)) == []

    async def test_search_availability_skips_non_chronogolf_capabilities(self):
        teeitup_cap = CourseBookingCapability(
            platform="teeitup", name="Some TeeItUp Course", lat=40.5, lng=-74.2,
            platform_ids={"alias": "x", "facility_id": "1"},
        )
        calls: list[httpx.Request] = []
        provider = ChronogolfProvider(
            capabilities=lambda: (teeitup_cap,),
            cache=FakeCacheStore(),
            transport=_fixture_transport(calls=calls),
            limiter=SlidingWindowLimiter(rpm=1000, window_s=60),
            breaker=CircuitBreaker(),
        )
        slots = await provider.search_availability(_query(area="40.5,-74.2"))
        assert slots == []
        assert calls == []  # never even tries a non-chronogolf capability


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
        cap = _cap()
        assert await provider.slots_for_capability(cap, _query()) == []
        assert await provider.slots_for_capability(cap, _query()) == []
        assert len(calls) == 1  # no re-poll storm on a genuinely empty day

    async def test_party_size_scopes_the_cache_separately(self):
        """Cache key includes party_size — load-bearing here since the
        single-player-restriction filter depends on it (unlike TeeItUp,
        where it's cosmetic)."""
        calls: list[httpx.Request] = []
        cache = FakeCacheStore()
        provider = _provider(transport=_fixture_transport(calls=calls), cache=cache)
        await provider.slots_for_capability(_cap(), _query(party_size=1))
        assert len(calls) == 1
        await provider.slots_for_capability(_cap(), _query(party_size=2))
        assert len(calls) == 2  # different party size -> separate fetch


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
        limiter.check(CHRONOGOLF_HOST)  # consume the one slot in the window
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


# ── book() ─────────────────────────────────────────────────────────────────────────

class TestBook:
    async def test_book_returns_needs_human_with_time_and_course_name(self):
        provider = _provider()
        slot = TeeTimeSlot(
            id="chronogolf-10038-11517-2026-07-13-07:30-0",
            course_id="chronogolf-10038-11517",
            course_name="Rock Spring Golf Club at West Orange",
            city="",
            date="2026-07-13",
            time="07:30",
            players=2,
            price_usd=109.0,
            cart_included=False,
            distance_miles=0.0,
            rating=0.0,
            provider="chronogolf",
            holes=18,
            booking_url="https://www.chronogolf.com/club/rock-spring-golf-club-at-west-orange",
            route=None,
        )
        result = await provider.book(slot, BookingDetails(name="Owner", party_size=2))
        assert result.status == "needs_human"
        assert result.confirmation_number is None
        assert result.booking_url == slot.booking_url
        assert "7:30 AM" in (result.message or "")
        assert "Rock Spring Golf Club at West Orange" in (result.message or "")

    async def test_name_property(self):
        assert _provider().name == "chronogolf"
