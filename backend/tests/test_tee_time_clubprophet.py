"""
Tests for ClubProphetProvider (specs/teetime-headless-scraper-plan.md §6/H1).

The fixtures are REAL live captures of a CPS course's public `onlineresweb`
TeeTimes endpoint, captured end-to-end by the eng-lead on 2026-07-10 against
Harbor Links Golf Course (`harborlinksgc.cps.golf`, Port Washington NY):
  - `clubprophet_harborlinks_times.json` — 69 real bookable slots on a date
    ~6 days out (greens fees $27–$71);
  - `clubprophet_harborlinks_empty.json` — the real `NO_TEETIMES` message
    response (a verified-empty day).
NEVER hand-edit them. Every assertion below is DERIVED from the fixture's
actual contents at test runtime (re-implementing the documented
normalize/filter rules independently) — never a hand-typed count or time that
could quietly drift.

The CPS fetch is a THREE-call dance (short-lived token POST -> register-txn
POST -> TeeTimes GET); the MockTransport below routes by URL path and returns
canned token/register responses plus the fixture for the availability GET, so
NO live network is ever touched in CI.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime
from pathlib import Path

import httpx

from app.services.rate_limit import SlidingWindowLimiter
from app.services.tee_times.adapters.clubprophet import (
    MAX_SLOTS_PER_COURSE,
    SHORT_LIVED_CLIENT_ID,
    ClubProphetProvider,
)
from app.services.tee_times.base import BookingDetails, TeeTimeQuery, TeeTimeSlot
from app.services.tee_times.capability_store import CourseBookingCapability
from app.services.tee_times.fetch_discipline import USER_AGENT, CircuitBreaker

_FIX_DIR = Path(__file__).parent / "fixtures"
FIXTURE_FULL: dict = json.loads((_FIX_DIR / "clubprophet_harborlinks_times.json").read_text())
FIXTURE_CONTENT: list[dict] = FIXTURE_FULL["content"]
FIXTURE_DATE = FIXTURE_CONTENT[0]["startTime"][:10]
EMPTY_FULL: dict = json.loads((_FIX_DIR / "clubprophet_harborlinks_empty.json").read_text())

_AUTHORITY = "https://harborlinksgc.cps.golf/identityapi"
_ONLINE_API = "https://harborlinksgc.cps.golf/onlineres/onlineapi/api/v1/onlinereservation"
_ONLINE_HOST = "harborlinksgc.cps.golf"


# ── Sanity gate: the capture is real ───────────────────────────────────────────

def test_fixture_is_a_real_nonempty_capture():
    assert FIXTURE_FULL.get("isSuccess") is True
    assert isinstance(FIXTURE_CONTENT, list)
    assert len(FIXTURE_CONTENT) > MAX_SLOTS_PER_COURSE, "sanity: must exceed the truncation cap"
    for e in FIXTURE_CONTENT:
        assert isinstance(e.get("startTime"), str) and e["startTime"][:10] == FIXTURE_DATE
        assert isinstance(e.get("maxPlayer"), int) and not isinstance(e.get("maxPlayer"), bool)
        assert isinstance(e.get("shItemPrices"), list)
    priced = [e for e in FIXTURE_CONTENT if any(
        isinstance(p, dict) and isinstance(p.get("displayPrice"), (int, float)) and p["displayPrice"] > 0
        for p in e.get("shItemPrices", [])
    )]
    assert priced, "sanity: some real priced slots must exist"


def test_empty_fixture_is_a_real_no_teetimes_message():
    assert EMPTY_FULL.get("isSuccess") is True
    assert isinstance(EMPTY_FULL.get("content"), dict)
    assert EMPTY_FULL["content"].get("messageKey") == "NO_TEETIMES"


# ── Fixtures / fakes ────────────────────────────────────────────────────────────

def _cap(**overrides) -> CourseBookingCapability:
    defaults = dict(
        platform="clubprophet",
        channel="scrape_http",
        platform_ids={
            "host": _ONLINE_HOST,
            "authority_base_url": _AUTHORITY,
            "online_api": _ONLINE_API,
            "course_id": "1",
        },
        booking_url="https://harborlinksgc.cps.golf/onlineresweb/",
        phone="(516) 767-4816",
        is_private=False,
        verified_at="2026-07-10T21:00:00Z",
        probe_status="verified",
        name="Harbor Links Golf Course",
        lat=40.8267871,
        lng=-73.6711179,
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


class _Recorder:
    """Records requests by leg so tests can count TeeTimes GETs precisely."""

    def __init__(self) -> None:
        self.token: list[httpx.Request] = []
        self.register: list[httpx.Request] = []
        self.times: list[httpx.Request] = []


def _transport(
    *,
    times_payload=None,
    times_status: int = 200,
    token_status: int = 200,
    register_status: int = 200,
    recorder: _Recorder | None = None,
) -> httpx.MockTransport:
    body = times_payload if times_payload is not None else FIXTURE_FULL

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/myconnect/token/short"):
            if recorder is not None:
                recorder.token.append(request)
            return httpx.Response(token_status, json={"access_token": "faketoken", "expires_in": 600})
        if path.endswith("/RegisterTransactionId"):
            if recorder is not None:
                recorder.register.append(request)
            return httpx.Response(register_status, json=True)
        if path.endswith("/TeeTimes"):
            if recorder is not None:
                recorder.times.append(request)
            if isinstance(body, (dict, list)):
                return httpx.Response(times_status, json=body)
            return httpx.Response(times_status, text=str(body))
        return httpx.Response(404, text="unexpected path")

    return httpx.MockTransport(handler)


def _provider(*, transport=None, cache=None, limiter=None, breaker=None) -> ClubProphetProvider:
    return ClubProphetProvider(
        cache=cache if cache is not None else FakeCacheStore(),
        transport=transport if transport is not None else _transport(),
        limiter=limiter if limiter is not None else SlidingWindowLimiter(rpm=1000, window_s=60),
        breaker=breaker if breaker is not None else CircuitBreaker(),
    )


def _cheapest(e: dict):
    prices = []
    for p in e.get("shItemPrices", []):
        if not isinstance(p, dict):
            continue
        v = p.get("displayPrice")
        if not (isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0):
            v = p.get("price")
        if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
            prices.append(float(v))
    return min(prices) if prices else None


def _fixture_qualifying(
    party_size: int, *, window_start: str = "00:00", window_end: str = "23:59",
) -> list[dict]:
    """Independently re-derive the expected qualifying entries straight from
    the raw fixture — NOT by calling into the provider."""
    ws = datetime.strptime(window_start, "%H:%M").time()
    we = datetime.strptime(window_end, "%H:%M").time()
    out = []
    for e in FIXTURE_CONTENT:
        if e["startTime"][:10] != FIXTURE_DATE:
            continue
        mn, mx = e.get("minPlayer"), e.get("maxPlayer")
        if not isinstance(mx, int) or isinstance(mx, bool):
            continue
        lo = mn if isinstance(mn, int) and not isinstance(mn, bool) else 1
        if not (lo <= party_size <= mx):
            continue
        t = datetime.strptime(e["startTime"][11:16], "%H:%M").time()
        if not (ws <= t <= we):
            continue
        out.append({"time": e["startTime"][11:16], "players": mx, "price_usd": _cheapest(e)})
    out.sort(key=lambda d: d["time"])
    return out


# ── Request shape (the full 3-call dance) ──────────────────────────────────────

class TestRequestShape:
    async def test_three_call_dance_exact_shapes(self):
        rec = _Recorder()
        provider = _provider(transport=_transport(recorder=rec))
        slots = await provider.slots_for_capability(_cap(), _query())
        assert slots is not None
        assert len(rec.token) == 1 and len(rec.register) == 1 and len(rec.times) == 1

        # Step 1 — token: public client_id, no secret/login, honest UA.
        tok = rec.token[0]
        assert tok.method == "POST"
        assert tok.url.path == "/identityapi/myconnect/token/short"
        body = tok.content.decode()
        assert f"client_id={SHORT_LIVED_CLIENT_ID}" in body
        assert "client_secret" not in body and "password" not in body
        assert tok.headers["user-agent"] == USER_AGENT

        # Step 2 — register transaction id, componentid header required.
        reg = rec.register[0]
        assert reg.method == "POST"
        assert reg.url.path.endswith("/RegisterTransactionId")
        reg_body = json.loads(reg.content.decode())
        assert "transactionId" in reg_body and reg_body["transactionId"]
        assert reg.headers["x-componentid"] == "1"

        # Step 3 — availability GET.
        req = rec.times[0]
        assert req.method == "GET"
        assert req.url.host == _ONLINE_HOST
        assert req.url.path.endswith("/TeeTimes")
        params = dict(req.url.params)
        assert params["searchDate"] == FIXTURE_DATE
        assert params["courseIds"] == "1"
        assert params["numberOfPlayer"] == "1"
        assert params["teeOffTimeMin"] == "0"
        assert params["teeOffTimeMax"] == "24"
        assert params["holes"] == "18"
        assert params["transactionId"] == reg_body["transactionId"]  # same id registered
        assert req.headers["authorization"] == "Bearer faketoken"
        assert req.headers["x-componentid"] == "1"


# ── Parse / normalize ────────────────────────────────────────────────────────────

class TestParseNormalize:
    async def test_emitted_slots_match_fixture_derived_shape(self):
        cap = _cap()
        slots = await _provider().slots_for_capability(cap, _query(party_size=2))
        assert slots
        expected = _fixture_qualifying(2)
        assert len(slots) == min(len(expected), MAX_SLOTS_PER_COURSE)

        expected_by_time = {e["time"]: e for e in expected}
        for s in slots:
            assert s.provider == "clubprophet"
            assert s.route is None
            assert s.estimated is False
            assert s.date == FIXTURE_DATE
            assert s.booking_url == cap.booking_url
            assert s.phone == cap.phone
            assert s.holes == 18
            assert s.time in expected_by_time
            # players is the real maxPlayer ceiling (open-spots), not fabricated.
            assert s.players == expected_by_time[s.time]["players"]
            exp_price = expected_by_time[s.time]["price_usd"]
            if exp_price is not None:
                assert s.price_usd == exp_price
                assert s.price_usd < 1000  # sanity: dollars, not cents

    async def test_prices_are_dollars_not_cents(self):
        slots = await _provider().slots_for_capability(_cap(), _query(party_size=1))
        priced = [s for s in slots if s.price_usd is not None]
        assert priced, "sanity: fixture has priced slots"
        assert all(10.0 <= s.price_usd <= 500.0 for s in priced)


# ── Party-size / open-spots filter ──────────────────────────────────────────────

class TestPartySizeFilter:
    async def test_party_larger_than_maxplayer_is_excluded(self):
        # A synthetic slot with maxPlayer=2 must not appear for a party of 3.
        payload = {
            "transactionId": "t", "isSuccess": True,
            "content": [
                {"startTime": f"{FIXTURE_DATE}T07:00:00", "holes": 18,
                 "minPlayer": 1, "maxPlayer": 2,
                 "shItemPrices": [{"shItemCode": "GreenFee18", "displayPrice": 40.0}]},
                {"startTime": f"{FIXTURE_DATE}T08:00:00", "holes": 18,
                 "minPlayer": 1, "maxPlayer": 4,
                 "shItemPrices": [{"shItemCode": "GreenFee18", "displayPrice": 40.0}]},
            ],
        }
        provider = _provider(transport=_transport(times_payload=payload))
        slots = await provider.slots_for_capability(_cap(), _query(party_size=3))
        assert {s.time for s in slots} == {"08:00"}  # 07:00 (max 2) dropped


# ── Verified empty ───────────────────────────────────────────────────────────────

class TestVerifiedEmpty:
    async def test_no_teetimes_message_is_verified_empty_not_none(self):
        provider = _provider(transport=_transport(times_payload=EMPTY_FULL))
        assert await provider.slots_for_capability(_cap(), _query()) == []

    async def test_empty_content_array_is_verified_empty(self):
        payload = {"transactionId": "t", "isSuccess": True, "content": []}
        provider = _provider(transport=_transport(times_payload=payload))
        assert await provider.slots_for_capability(_cap(), _query()) == []

    async def test_window_with_no_fixture_times_is_verified_empty(self):
        provider = _provider()
        slots = await provider.slots_for_capability(
            _cap(), _query(time_window_start="01:00", time_window_end="02:00"),
        )
        assert slots == []

    async def test_malformed_window_returns_none(self):
        provider = _provider()
        slots = await provider.slots_for_capability(
            _cap(), _query(time_window_start="not-a-time", time_window_end="10:00"),
        )
        assert slots is None

    async def test_unexpected_message_key_is_couldnt_check_not_empty(self):
        payload = {"transactionId": "t", "isSuccess": False,
                   "content": {"messageKey": "SOME_ERROR", "messageDetail": "boom"}}
        provider = _provider(transport=_transport(times_payload=payload))
        assert await provider.slots_for_capability(_cap(), _query()) is None

    async def test_missing_content_key_is_couldnt_check(self):
        provider = _provider(transport=_transport(times_payload={"transactionId": "t", "isSuccess": True}))
        assert await provider.slots_for_capability(_cap(), _query()) is None


# ── Window filter ────────────────────────────────────────────────────────────────

class TestWindowFilter:
    async def test_derived_subwindow_returns_exact_fixture_times(self):
        window_start, window_end = "08:00", "11:00"
        expected = _fixture_qualifying(1, window_start=window_start, window_end=window_end)
        assert expected, "sanity: the chosen window must contain fixture times"
        assert len(expected) < len(_fixture_qualifying(1)), "sanity: window must be a strict subset"

        provider = _provider()
        slots = await provider.slots_for_capability(
            _cap(), _query(party_size=1, time_window_start=window_start, time_window_end=window_end),
        )
        assert [s.time for s in slots] == [e["time"] for e in expected][:MAX_SLOTS_PER_COURSE]


class TestMaxPrice:
    async def test_over_budget_dropped_unknown_price_kept(self):
        provider = _provider()
        slots = await provider.slots_for_capability(_cap(), _query(party_size=1, max_price_usd=40.0))
        assert slots is not None
        for s in slots:
            assert s.price_usd is None or s.price_usd <= 40.0


# ── Price honesty (SYNTHETIC, labeled as such) ──────────────────────────────────

class TestPriceNeverFabricated:
    async def test_zero_and_missing_fees_map_to_none_never_zero(self):
        """SYNTHETIC payload: a fee of 0, a missing shItemPrices, and a null
        displayPrice must all map to price_usd=None, never $0.00."""
        payload = {"transactionId": "t", "isSuccess": True, "content": [
            {"startTime": f"{FIXTURE_DATE}T07:00:00", "holes": 18, "minPlayer": 1, "maxPlayer": 4,
             "shItemPrices": [{"displayPrice": 0, "price": 0}]},
            {"startTime": f"{FIXTURE_DATE}T08:00:00", "holes": 18, "minPlayer": 1, "maxPlayer": 4},
            {"startTime": f"{FIXTURE_DATE}T09:00:00", "holes": 18, "minPlayer": 1, "maxPlayer": 4,
             "shItemPrices": [{"displayPrice": None, "price": 55.0}]},
        ]}
        provider = _provider(transport=_transport(times_payload=payload))
        slots = await provider.slots_for_capability(_cap(), _query(party_size=1))
        by_time = {s.time: s for s in slots}
        assert by_time["07:00"].price_usd is None    # 0 -> unknown, never $0
        assert by_time["08:00"].price_usd is None     # no shItemPrices at all
        assert by_time["09:00"].price_usd == 55.0     # falls back to `price` when displayPrice null


# ── Truncation ────────────────────────────────────────────────────────────────────

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


# ── SSRF guard ─────────────────────────────────────────────────────────────────

class TestSsrfGuard:
    async def test_non_cps_host_refused_without_any_network_call(self):
        rec = _Recorder()
        provider = _provider(transport=_transport(recorder=rec))
        cap = _cap(platform_ids={
            "host": "evil.example.com",
            "authority_base_url": "https://evil.example.com/identityapi",
            "online_api": "https://evil.example.com/onlineres/onlineapi/api/v1/onlinereservation",
            "course_id": "1",
        })
        assert await provider.slots_for_capability(cap, _query()) is None
        assert rec.token == [] and rec.register == [] and rec.times == []

    async def test_http_scheme_refused(self):
        rec = _Recorder()
        provider = _provider(transport=_transport(recorder=rec))
        cap = _cap(platform_ids={
            "host": "harborlinksgc.cps.golf",
            "authority_base_url": "http://harborlinksgc.cps.golf/identityapi",
            "online_api": "https://harborlinksgc.cps.golf/onlineres/onlineapi/api/v1/onlinereservation",
            "course_id": "1",
        })
        assert await provider.slots_for_capability(cap, _query()) is None
        assert rec.token == []


# ── Error legs — never raise ────────────────────────────────────────────────────

class TestErrorLegs:
    async def test_token_non_200_returns_none_no_search(self):
        rec = _Recorder()
        provider = _provider(transport=_transport(token_status=403, recorder=rec))
        assert await provider.slots_for_capability(_cap(), _query()) is None
        assert rec.register == [] and rec.times == []  # short-circuits before search

    async def test_register_non_200_returns_none_no_search(self):
        rec = _Recorder()
        provider = _provider(transport=_transport(register_status=500, recorder=rec))
        assert await provider.slots_for_capability(_cap(), _query()) is None
        assert len(rec.token) == 1 and rec.times == []

    async def test_times_500_returns_none(self):
        provider = _provider(transport=_transport(times_status=500))
        assert await provider.slots_for_capability(_cap(), _query()) is None

    async def test_times_non_json_returns_none(self):
        provider = _provider(transport=_transport(times_payload="<html>not json</html>"))
        assert await provider.slots_for_capability(_cap(), _query()) is None

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

    async def test_malformed_date_returns_none_without_network(self):
        rec = _Recorder()
        provider = _provider(transport=_transport(recorder=rec))
        assert await provider.slots_for_capability(_cap(), _query(date="not-a-date")) is None
        assert rec.token == []

    async def test_missing_platform_ids_returns_none_without_network(self):
        rec = _Recorder()
        provider = _provider(transport=_transport(recorder=rec))
        assert await provider.slots_for_capability(_cap(platform_ids={}), _query()) is None
        assert rec.token == []

    async def test_partial_platform_ids_returns_none_without_network(self):
        rec = _Recorder()
        provider = _provider(transport=_transport(recorder=rec))
        cap = _cap(platform_ids={"host": _ONLINE_HOST, "online_api": _ONLINE_API})  # no course_id/authority
        assert await provider.slots_for_capability(cap, _query()) is None
        assert rec.token == []

    async def test_search_availability_error_legs_return_empty_never_raise(self):
        def handler(request: httpx.Request):
            raise httpx.ConnectError("boom", request=request)
        cap = _cap()
        provider = ClubProphetProvider(
            capabilities=lambda: (cap,),
            cache=FakeCacheStore(),
            transport=httpx.MockTransport(handler),
            limiter=SlidingWindowLimiter(rpm=1000, window_s=60),
            breaker=CircuitBreaker(),
        )
        slots = await provider.search_availability(_query(area=f"{cap.lat},{cap.lng}"))
        assert slots == []

    async def test_search_availability_no_origin_returns_empty(self):
        assert await _provider().search_availability(_query(area=None)) == []

    async def test_search_availability_skips_non_clubprophet_caps(self):
        other = CourseBookingCapability(
            platform="teeitup", name="Some TeeItUp Course", lat=40.5, lng=-74.2,
            platform_ids={"alias": "x", "facility_id": "1"},
        )
        rec = _Recorder()
        provider = ClubProphetProvider(
            capabilities=lambda: (other,),
            cache=FakeCacheStore(),
            transport=_transport(recorder=rec),
            limiter=SlidingWindowLimiter(rpm=1000, window_s=60),
            breaker=CircuitBreaker(),
        )
        assert await provider.search_availability(_query(area="40.5,-74.2")) == []
        assert rec.token == []


# ── Cache ────────────────────────────────────────────────────────────────────────

class TestCache:
    async def test_second_call_within_ttl_makes_zero_http(self):
        rec = _Recorder()
        cache = FakeCacheStore()
        provider = _provider(transport=_transport(recorder=rec), cache=cache)
        await provider.slots_for_capability(_cap(), _query())
        assert len(rec.times) == 1
        await provider.slots_for_capability(_cap(), _query())
        assert len(rec.times) == 1  # served from cache — no second dance

    async def test_refetch_after_ttl_expiry(self):
        rec = _Recorder()
        clock = {"t": 0.0}
        cache = FakeCacheStore(now_fn=lambda: clock["t"], ttl_seconds=480.0)
        provider = _provider(transport=_transport(recorder=rec), cache=cache)
        await provider.slots_for_capability(_cap(), _query())
        assert len(rec.times) == 1
        clock["t"] += 480.0
        await provider.slots_for_capability(_cap(), _query())
        assert len(rec.times) == 2

    async def test_verified_empty_day_is_a_valid_cache_hit(self):
        rec = _Recorder()
        cache = FakeCacheStore()
        provider = _provider(transport=_transport(times_payload=EMPTY_FULL, recorder=rec), cache=cache)
        cap = _cap()
        assert await provider.slots_for_capability(cap, _query()) == []
        assert await provider.slots_for_capability(cap, _query()) == []
        assert len(rec.times) == 1  # no re-poll storm on an empty day

    async def test_party_size_scopes_the_cache_separately(self):
        rec = _Recorder()
        cache = FakeCacheStore()
        provider = _provider(transport=_transport(recorder=rec), cache=cache)
        await provider.slots_for_capability(_cap(), _query(party_size=1))
        assert len(rec.times) == 1
        await provider.slots_for_capability(_cap(), _query(party_size=2))
        assert len(rec.times) == 2  # different party size -> separate fetch


# ── Single-flight ────────────────────────────────────────────────────────────────

class TestSingleFlight:
    async def test_five_concurrent_calls_make_exactly_one_dance(self):
        rec = _Recorder()
        provider = _provider(transport=_transport(recorder=rec), cache=FakeCacheStore())
        results = await asyncio.gather(*[
            provider.slots_for_capability(_cap(), _query()) for _ in range(5)
        ])
        assert len(rec.times) == 1
        assert all(r is not None for r in results)


# ── Rate limiter ───────────────────────────────────────────────────────────────────

class TestRateLimiter:
    async def test_limiter_at_cap_returns_none_zero_http_no_breaker_failure(self):
        rec = _Recorder()
        limiter = SlidingWindowLimiter(rpm=1, window_s=60)
        limiter.check(_ONLINE_HOST)  # consume the one slot in the window
        breaker = CircuitBreaker()
        provider = _provider(transport=_transport(recorder=rec), limiter=limiter, breaker=breaker)
        assert await provider.slots_for_capability(_cap(), _query()) is None
        assert rec.token == []
        assert breaker.allow() is True  # self-throttling never counts as a breaker failure


# ── Circuit breaker ────────────────────────────────────────────────────────────────

class TestCircuitBreaker:
    async def test_three_failures_open_then_fourth_makes_no_http(self):
        rec = _Recorder()
        breaker = CircuitBreaker()
        limiter = SlidingWindowLimiter(rpm=1000, window_s=60)
        provider = _provider(transport=_transport(times_status=500, recorder=rec),
                             breaker=breaker, limiter=limiter)
        for _ in range(3):
            assert await provider.slots_for_capability(_cap(), _query()) is None
        assert len(rec.times) == 3
        assert await provider.slots_for_capability(_cap(), _query()) is None
        assert len(rec.times) == 3  # breaker open — zero additional HTTP


# ── book() ─────────────────────────────────────────────────────────────────────────

class TestBook:
    async def test_book_returns_needs_human_with_time_and_course(self):
        slot = TeeTimeSlot(
            id="clubprophet-harborlinksgc.cps.golf-1-2026-07-16-07:30-0",
            course_id="clubprophet-harborlinksgc.cps.golf-1",
            course_name="Harbor Links Golf Course",
            city="", date="2026-07-16", time="07:30", players=4, price_usd=71.0,
            cart_included=False, distance_miles=0.0, rating=0.0, provider="clubprophet",
            holes=18, booking_url="https://harborlinksgc.cps.golf/onlineresweb/", route=None,
        )
        result = await _provider().book(slot, BookingDetails(name="Owner", party_size=2))
        assert result.status == "needs_human"
        assert result.confirmation_number is None
        assert result.booking_url == slot.booking_url
        assert "7:30 AM" in (result.message or "")
        assert "Harbor Links Golf Course" in (result.message or "")

    async def test_name_property(self):
        assert _provider().name == "clubprophet"
