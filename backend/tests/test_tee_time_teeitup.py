"""
Tests for TeeItUpProvider (specs/teetime-availability-everywhere-plan.md §3/§6).

The fixtures are REAL live captures of TeeItUp's public v2/tee-times endpoint
(`backend/tests/fixtures/teeitup_golfnyc_times.json` — South Shore Golf
Course, 58 real teetimes; `teeitup_empty.json` — a verified-empty course)
captured live by the eng-lead on 2026-07-10. NEVER hand-edit them. Every
assertion below is DERIVED from the fixture's actual contents at test
runtime (re-implementing the documented normalize/filter rules
independently) — never a hand-typed count or time that could quietly drift.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

from app.services.rate_limit import SlidingWindowLimiter
from app.services.tee_times.adapters.teeitup import (
    MAX_SLOTS_PER_COURSE,
    TEEITUP_HOST,
    TeeItUpProvider,
)
from app.services.tee_times.base import BookingDetails, TeeTimeQuery, TeeTimeSlot
from app.services.tee_times.capability_store import CourseBookingCapability
from app.services.tee_times.fetch_discipline import USER_AGENT, CircuitBreaker

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "teeitup_golfnyc_times.json"
FIXTURE_RAW: list[dict] = json.loads(FIXTURE_PATH.read_text())
FIXTURE_TEETIMES: list[dict] = FIXTURE_RAW[0]["teetimes"]

EMPTY_FIXTURE_PATH = Path(__file__).parent / "fixtures" / "teeitup_empty.json"
EMPTY_FIXTURE_RAW: list[dict] = json.loads(EMPTY_FIXTURE_PATH.read_text())

_ET = ZoneInfo("America/New_York")


def _local(raw_utc: str) -> datetime:
    return datetime.fromisoformat(raw_utc.replace("Z", "+00:00")).astimezone(_ET)


FIXTURE_DATE = _local(FIXTURE_TEETIMES[0]["teetime"]).strftime("%Y-%m-%d")


# ── Sanity gate: the capture is real (mirrors test_tee_time_foreup.py) ─────────

def test_fixture_is_a_real_nonempty_capture():
    assert isinstance(FIXTURE_RAW, list)
    assert len(FIXTURE_RAW) == 1
    assert len(FIXTURE_TEETIMES) > MAX_SLOTS_PER_COURSE, "sanity: must exceed the truncation cap"
    for e in FIXTURE_TEETIMES:
        assert isinstance(e.get("teetime"), str) and e["teetime"].endswith("Z")
        assert "maxPlayers" in e


def test_empty_fixture_is_a_real_verified_empty_capture():
    assert isinstance(EMPTY_FIXTURE_RAW, list)
    assert len(EMPTY_FIXTURE_RAW) == 1
    assert EMPTY_FIXTURE_RAW[0]["teetimes"] == []
    assert "message" in EMPTY_FIXTURE_RAW[0]  # the real "not bookable yet" message


# ── Fixtures / fakes ────────────────────────────────────────────────────────────

def _cap(**overrides) -> CourseBookingCapability:
    defaults = dict(
        platform="teeitup",
        channel="api",
        platform_ids={"alias": "golf-nyc", "facility_id": "4051"},
        booking_url="https://golf-nyc.book.teeitup.com/",
        phone="+17189840101",
        is_private=False,
        verified_at="2026-07-10T13:40:44Z",
        probe_status="verified",
        name="South Shore Golf Course",
        lat=40.549064,
        lng=-74.200271,
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


def _provider(*, transport=None, cache=None, limiter=None, breaker=None) -> TeeItUpProvider:
    return TeeItUpProvider(
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
    for e in FIXTURE_TEETIMES:
        local = _local(e["teetime"])
        if local.strftime("%Y-%m-%d") != FIXTURE_DATE:
            continue
        hhmm_time = local.time().replace(second=0, microsecond=0)
        if not (ws <= hhmm_time <= we):
            continue
        max_players = e.get("maxPlayers")
        if not isinstance(max_players, int) or isinstance(max_players, bool) or max_players < party_size:
            continue
        fee = e["rates"][0].get("greenFeeWalking")
        price = fee / 100.0 if isinstance(fee, (int, float)) and not isinstance(fee, bool) and fee > 0 else None
        out.append({"time": local.strftime("%H:%M"), "players": max_players, "price_usd": price})
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
        assert req.url.host == TEEITUP_HOST
        assert req.url.path == "/v2/tee-times"
        params = dict(req.url.params)
        assert params["date"] == FIXTURE_DATE
        assert params["facilityIds"] == "4051"
        assert "courseIds" not in params        # the plan's original guess — HTTP 400, never send it
        assert "numberOfPlayers" not in params   # same — HTTP 400
        assert req.headers["x-be-alias"] == "golf-nyc"
        assert req.headers["user-agent"] == USER_AGENT
        assert req.headers["accept"] == "application/json"


# ── Parse / normalize ────────────────────────────────────────────────────────────

class TestParseNormalize:
    async def test_emitted_slots_match_fixture_derived_shape(self):
        cap = _cap()
        provider = _provider()
        slots = await provider.slots_for_capability(cap, _query(party_size=1))
        assert slots

        expected = _fixture_qualifying(1)
        assert len(slots) == min(len(expected), MAX_SLOTS_PER_COURSE)

        expected_by_time = {e["time"]: e for e in expected}
        for s in slots:
            assert s.provider == "teeitup"
            assert s.route is None
            assert s.estimated is False
            assert s.date == FIXTURE_DATE
            assert s.booking_url == cap.booking_url
            assert s.phone == cap.phone
            assert s.holes == 18
            assert s.time in expected_by_time
            # players is real maxPlayers, never an echo of party_size.
            assert s.players == expected_by_time[s.time]["players"]
            # price = greenFeeWalking (cents) / 100 — never fed raw cents.
            exp_price = expected_by_time[s.time]["price_usd"]
            if exp_price is not None:
                assert s.price_usd == exp_price
                assert s.price_usd < 100  # sanity: dollars, not cents (would be ~4900)

    async def test_a_known_entry_converts_utc_to_et_correctly(self):
        """Pin ONE ground-truth conversion from the live capture: 14:15Z on
        the fixture date -> 10:15 ET (UTC-4, July/EDT)."""
        first = FIXTURE_TEETIMES[0]
        assert first["teetime"].startswith(FIXTURE_DATE.replace("-", "-")[:4])  # sanity
        local = _local(first["teetime"])
        assert local.strftime("%H:%M") == "10:15"
        assert first["teetime"] == f"{FIXTURE_DATE}T14:15:00.000Z"


# ── Verified empty ───────────────────────────────────────────────────────────────

class TestVerifiedEmpty:
    async def test_teetimes_empty_array_is_verified_empty_not_none(self):
        empty_date = _local(EMPTY_FIXTURE_RAW[0]["dayInfo"]["dawn"]).strftime("%Y-%m-%d")
        cap = _cap(platform_ids={"alias": "essex", "facility_id": "999"})
        provider = _provider(transport=_fixture_transport(payload=EMPTY_FIXTURE_RAW))
        slots = await provider.slots_for_capability(cap, _query(date=empty_date))
        assert slots == []


# ── Window / party / price filters ──────────────────────────────────────────────

class TestWindowFilter:
    async def test_derived_subwindow_returns_exact_fixture_times(self):
        window_start, window_end = "12:00", "15:00"
        expected = _fixture_qualifying(1, window_start=window_start, window_end=window_end)
        assert expected, "sanity: the chosen window must contain fixture times"
        assert len(expected) < len(FIXTURE_TEETIMES), "sanity: window must be a strict subset"

        provider = _provider()
        slots = await provider.slots_for_capability(
            _cap(), _query(time_window_start=window_start, time_window_end=window_end),
        )
        assert [s.time for s in slots] == [e["time"] for e in expected][:MAX_SLOTS_PER_COURSE]

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


class TestPartyFilter:
    async def test_party_size_filter_matches_derived_expectation(self):
        party_size = 4
        expected = _fixture_qualifying(party_size)
        assert expected, "sanity: some entries must pass"
        assert len(expected) < len(FIXTURE_TEETIMES), "sanity: some entries must fail"

        provider = _provider()
        slots = await provider.slots_for_capability(_cap(), _query(party_size=party_size))
        assert [s.time for s in slots] == [e["time"] for e in expected][:MAX_SLOTS_PER_COURSE]
        for s in slots:
            assert s.players >= party_size


class TestMaxPrice:
    async def test_over_budget_dropped_unknown_price_kept(self):
        query_date = "2026-07-10"
        payload = [{
            "dayInfo": {}, "courseId": "x", "totalAvailableTeetimes": 3, "fromCache": False,
            "teetimes": [
                {"teetime": f"{query_date}T13:00:00.000Z", "maxPlayers": 2, "minPlayers": 1,
                 "bookedPlayers": 0, "players": [],
                 "rates": [{"holes": 18, "greenFeeWalking": 10000}]},
                {"teetime": f"{query_date}T14:00:00.000Z", "maxPlayers": 2, "minPlayers": 1,
                 "bookedPlayers": 0, "players": [],
                 "rates": [{"holes": 18, "greenFeeWalking": None}]},
                {"teetime": f"{query_date}T15:00:00.000Z", "maxPlayers": 2, "minPlayers": 1,
                 "bookedPlayers": 0, "players": [],
                 "rates": [{"holes": 18, "greenFeeWalking": 2000}]},
            ],
        }]

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=payload)

        provider = _provider(transport=httpx.MockTransport(handler))
        slots = await provider.slots_for_capability(
            _cap(), _query(date=query_date, party_size=1, max_price_usd=50.0),
        )
        by_price = {s.price_usd for s in slots}
        assert 100.0 not in by_price          # $100 over budget -> dropped
        assert None in by_price or len(slots) == 2  # unknown price kept
        assert 20.0 in by_price                # $20 under budget -> kept


# ── Coercion guards + price honesty (SYNTHETIC, labeled as such) ───────────────

_SYNTHETIC_QUERY_DATE = "2026-07-10"


def _synthetic_payload(entries: list[dict]) -> list[dict]:
    return [{
        "dayInfo": {}, "courseId": "synthetic", "totalAvailableTeetimes": len(entries),
        "fromCache": False, "teetimes": entries,
    }]


class TestBoolBeforeIntGuard:
    async def test_bool_maxplayers_never_treated_as_capacity(self):
        """A hand-built SYNTHETIC payload (labeled as such — never presented
        as the live capture) exercising the bool-before-int trap on
        maxPlayers, mirroring foreup's available_spots quirk coverage."""
        entries = [
            {"teetime": f"{_SYNTHETIC_QUERY_DATE}T14:00:00.000Z", "maxPlayers": False,
             "minPlayers": 1, "bookedPlayers": 0, "players": [],
             "rates": [{"holes": 18, "greenFeeWalking": 4500}]},
            {"teetime": f"{_SYNTHETIC_QUERY_DATE}T15:00:00.000Z", "maxPlayers": True,
             "minPlayers": 1, "bookedPlayers": 0, "players": [],
             "rates": [{"holes": 18, "greenFeeWalking": 4500}]},
            {"teetime": f"{_SYNTHETIC_QUERY_DATE}T16:00:00.000Z", "maxPlayers": 4,
             "minPlayers": 1, "bookedPlayers": 0, "players": [],
             "rates": [{"holes": 18, "greenFeeWalking": 4500}]},
        ]

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=_synthetic_payload(entries))

        provider = _provider(transport=httpx.MockTransport(handler))
        slots = await provider.slots_for_capability(
            _cap(), _query(date=_SYNTHETIC_QUERY_DATE, party_size=1),
        )
        assert slots is not None
        times = {s.time for s in slots}
        # maxPlayers=False/True (bool) -> both dropped, never coerced to 0/1.
        assert "10:00" not in times and "11:00" not in times
        assert "12:00" in times


class TestPriceNeverFabricated:
    async def test_zero_and_missing_fees_map_to_none_never_zero(self):
        """SYNTHETIC payload: green fee of 0 cents, and a rate with no fee
        field at all — both must map to price_usd=None, never $0.00."""
        entries = [
            {"teetime": f"{_SYNTHETIC_QUERY_DATE}T14:00:00.000Z", "maxPlayers": 2,
             "minPlayers": 1, "bookedPlayers": 0, "players": [],
             "rates": [{"holes": 18, "greenFeeWalking": 0}]},
            {"teetime": f"{_SYNTHETIC_QUERY_DATE}T15:00:00.000Z", "maxPlayers": 2,
             "minPlayers": 1, "bookedPlayers": 0, "players": [],
             "rates": [{"holes": 9}]},
            {"teetime": f"{_SYNTHETIC_QUERY_DATE}T16:00:00.000Z", "maxPlayers": 2,
             "minPlayers": 1, "bookedPlayers": 0, "players": [],
             "rates": [{"holes": 18, "greenFeeWalking": None, "greenFeeCart": 3000}]},
        ]

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=_synthetic_payload(entries))

        provider = _provider(transport=httpx.MockTransport(handler))
        slots = await provider.slots_for_capability(
            _cap(), _query(date=_SYNTHETIC_QUERY_DATE, party_size=1),
        )
        by_time = {s.time: s for s in slots}
        assert by_time["10:00"].price_usd is None   # 0 cents -> unknown, never $0
        assert by_time["10:00"].holes == 18
        assert by_time["11:00"].price_usd is None   # no fee field at all
        assert by_time["11:00"].holes == 9
        # min-of-present-rates: only greenFeeCart present -> 3000 cents -> $30.
        assert by_time["12:00"].price_usd == 30.0


# ── UTC -> ET conversion + local-date rollover filtering ───────────────────────

class TestDateRollover:
    async def test_entries_rolling_into_or_out_of_the_query_date_are_filtered(self):
        """A UTC teetime near midnight can land on a DIFFERENT ET calendar
        date than the raw UTC date string suggests — filtering must use the
        LOCAL date, not the UTC date substring."""
        query_date = "2026-07-10"
        entries = [
            # 2026-07-10 03:30 UTC -> 2026-07-09 23:30 ET — rolls BACK a day,
            # must be excluded from a 2026-07-10 query.
            {"teetime": "2026-07-10T03:30:00.000Z", "maxPlayers": 2, "minPlayers": 1,
             "bookedPlayers": 0, "players": [], "rates": [{"holes": 18, "greenFeeWalking": 4000}]},
            # 2026-07-11 03:00 UTC -> 2026-07-10 23:00 ET — rolls FORWARD into
            # the query date even though its UTC date string says 07-11.
            {"teetime": "2026-07-11T03:00:00.000Z", "maxPlayers": 2, "minPlayers": 1,
             "bookedPlayers": 0, "players": [], "rates": [{"holes": 18, "greenFeeWalking": 4000}]},
            # A normal midday entry squarely inside 2026-07-10 ET.
            {"teetime": "2026-07-10T16:00:00.000Z", "maxPlayers": 2, "minPlayers": 1,
             "bookedPlayers": 0, "players": [], "rates": [{"holes": 18, "greenFeeWalking": 4000}]},
        ]

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=_synthetic_payload(entries))

        provider = _provider(transport=httpx.MockTransport(handler))
        slots = await provider.slots_for_capability(
            _cap(), _query(date=query_date, party_size=1),
        )
        assert slots is not None
        times = {s.time for s in slots}
        assert times == {"23:00", "12:00"}   # 07-10T03:30Z excluded, the other two kept


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

    async def test_http_400_returns_none(self):
        """The real failure mode when a wrong param (courseIds/numberOfPlayers)
        slips in — never crashes, just degrades."""
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(400, text="bad request")
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

    async def test_empty_array_response_returns_none_not_verified_empty(self):
        """A fully empty top-level array (no records at all) is a schema-
        drift signal for a known facility, not a confirmed empty day — must
        degrade (None), never silently claim verified-empty."""
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=[])
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

    async def test_search_availability_error_legs_return_empty_never_raise(self):
        def handler(request: httpx.Request):
            raise httpx.ConnectError("boom", request=request)
        cap = _cap()
        provider = TeeItUpProvider(
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

    async def test_search_availability_skips_non_teeitup_capabilities(self):
        foreup_cap = CourseBookingCapability(
            platform="foreup", name="Some ForeUp Course", lat=40.5, lng=-74.2,
            platform_ids={"booking_id": "1", "schedule_id": "1"},
        )
        calls: list[httpx.Request] = []
        provider = TeeItUpProvider(
            capabilities=lambda: (foreup_cap,),
            cache=FakeCacheStore(),
            transport=_fixture_transport(calls=calls),
            limiter=SlidingWindowLimiter(rpm=1000, window_s=60),
            breaker=CircuitBreaker(),
        )
        slots = await provider.search_availability(_query(area="40.5,-74.2"))
        assert slots == []
        assert calls == []  # never even tries a non-teeitup capability


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
            return httpx.Response(200, json=EMPTY_FIXTURE_RAW)

        empty_date = _local(EMPTY_FIXTURE_RAW[0]["dayInfo"]["dawn"]).strftime("%Y-%m-%d")
        cache = FakeCacheStore()
        provider = _provider(transport=httpx.MockTransport(handler), cache=cache)
        cap = _cap(platform_ids={"alias": "essex", "facility_id": "999"})
        assert await provider.slots_for_capability(cap, _query(date=empty_date)) == []
        assert await provider.slots_for_capability(cap, _query(date=empty_date)) == []
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
        limiter.check(TEEITUP_HOST)  # consume the one slot in the window
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
            id="teeitup-golf-nyc-4051-2026-07-11-07:10-0",
            course_id="teeitup-golf-nyc-4051",
            course_name="South Shore Golf Course",
            city="",
            date="2026-07-11",
            time="07:10",
            players=2,
            price_usd=49.0,
            cart_included=False,
            distance_miles=0.0,
            rating=0.0,
            provider="teeitup",
            holes=18,
            booking_url="https://golf-nyc.book.teeitup.com/",
            route=None,
        )
        result = await provider.book(slot, BookingDetails(name="Owner", party_size=2))
        assert result.status == "needs_human"
        assert result.confirmation_number is None
        assert result.booking_url == slot.booking_url
        assert "7:10 AM" in (result.message or "")
        assert "South Shore Golf Course" in (result.message or "")

    async def test_name_property(self):
        assert _provider().name == "teeitup"
