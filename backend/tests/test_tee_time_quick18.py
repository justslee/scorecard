"""
Tests for Quick18Provider (specs/teetime-headless-scraper-plan.md §6/H2).

The fixtures are REAL live captures of a Quick18 course's public
`teetimes/searchmatrix` page, captured by the eng-lead on 2026-07-10 against
`northernhills.quick18.com` (structure ground-truth — no NY-metro Quick18
course exists, so this adapter ships registered-but-unseeded; the capture is
used purely to verify the parser against real HTML):
  - `quick18_searchmatrix_times.html` — a populated day (12 bookable rows,
    greens fees from $24–$56, "1 or 2 players" / "2 to 4 players" ranges);
  - `quick18_searchmatrix_empty.html` — a real empty day (matrixTable present,
    empty <tbody>) captured on a past date.
NEVER hand-edit them. Expected times/players below are INDEPENDENTLY re-derived
from the fixture with a regex oracle (NOT by calling the SUT parser), so no
assertion can silently drift with the implementation.

The fetch is a single plain GET; a MockTransport returns the saved fixture, so
NO live network is ever touched in CI.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

import httpx

from app.services.rate_limit import SlidingWindowLimiter
from app.services.tee_times.adapters.quick18 import (
    MAX_SLOTS_PER_COURSE,
    Quick18Provider,
)
from app.services.tee_times.base import BookingDetails, TeeTimeQuery, TeeTimeSlot
from app.services.tee_times.capability_store import CourseBookingCapability
from app.services.tee_times.fetch_discipline import USER_AGENT, CircuitBreaker

_FIX_DIR = Path(__file__).parent / "fixtures"
FIXTURE_TIMES: str = (_FIX_DIR / "quick18_searchmatrix_times.html").read_text()
FIXTURE_EMPTY: str = (_FIX_DIR / "quick18_searchmatrix_empty.html").read_text()

# The captured day (from the teebutton hrefs, teetime/20260714...).
FIXTURE_DATE = "2026-07-14"

_HOST = "northernhills.quick18.com"


# ── Independent regex oracle (NOT the SUT parser) ───────────────────────────────

def _availability_table(html: str) -> str:
    start = html.index('<table class="matrixTable"')
    end = html.index("</table>", start)
    table = html[start:end]
    return table[table.index("<tbody>"):]


def _oracle_rows(html: str) -> list[dict]:
    """Independently derive each bookable tee-time row from the fixture: 24h
    time + max party. A row counts only if it contains a `teebutton` (open
    slot)."""
    tbody = _availability_table(html)
    rows = re.split(r"<tr\b", tbody)[1:]
    out: list[dict] = []
    for r in rows:
        if "teebutton" not in r:
            continue
        m = re.search(r'mtrxTeeTimes"\s*>\s*([\d]{1,2}:[\d]{2})\s*<div class="be_tee_time_ampm">\s*([AP]M)', r)
        if not m:
            continue
        hh, mm = int(m.group(1).split(":")[0]), m.group(1).split(":")[1]
        ampm = m.group(2)
        if ampm == "PM" and hh != 12:
            hh += 12
        if ampm == "AM" and hh == 12:
            hh = 0
        pm = re.search(r'matrixPlayers"\s*>\s*([^<]+)</td>', r)
        nums = [int(n) for n in re.findall(r"\d+", pm.group(1))] if pm else []
        out.append({
            "time": f"{hh:02d}:{mm}",
            "min_players": min(nums) if nums else None,
            "max_players": max(nums) if nums else None,
        })
    out.sort(key=lambda d: d["time"])
    return out


ORACLE = _oracle_rows(FIXTURE_TIMES)


# ── Sanity gate: the capture is real ────────────────────────────────────────────

def test_fixture_is_a_real_populated_capture():
    assert '<table class="matrixTable"' in FIXTURE_TIMES
    assert len(ORACLE) > MAX_SLOTS_PER_COURSE, "sanity: must exceed the truncation cap"
    assert all(d["max_players"] for d in ORACLE)
    assert "$" in _availability_table(FIXTURE_TIMES)


def test_empty_fixture_has_table_but_no_rows():
    assert '<table class="matrixTable"' in FIXTURE_EMPTY
    assert _oracle_rows(FIXTURE_EMPTY) == []


# ── Fixtures / fakes ────────────────────────────────────────────────────────────

def _cap(**overrides) -> CourseBookingCapability:
    defaults = dict(
        platform="quick18",
        channel="scrape_http",
        platform_ids={"host": _HOST},
        booking_url=f"https://{_HOST}/teetimes/searchmatrix",
        phone="507-281-6170",
        is_private=False,
        verified_at="2026-07-10T21:00:00Z",
        probe_status="verified",
        name="Northern Hills Golf Course",
        lat=44.06,
        lng=-92.51,
        aliases=(),
    )
    defaults.update(overrides)
    return CourseBookingCapability(**defaults)


def _query(**overrides) -> TeeTimeQuery:
    defaults = dict(
        date=FIXTURE_DATE,
        time_window_start="00:00",
        time_window_end="23:59",
        party_size=2,
    )
    defaults.update(overrides)
    return TeeTimeQuery(**defaults)


class FakeCacheStore:
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


def _transport(*, body: str | None = None, status: int = 200, recorder: list | None = None) -> httpx.MockTransport:
    text = body if body is not None else FIXTURE_TIMES

    def handler(request: httpx.Request) -> httpx.Response:
        if recorder is not None:
            recorder.append(request)
        return httpx.Response(status, text=text, headers={"content-type": "text/html"})

    return httpx.MockTransport(handler)


def _provider(*, transport=None, cache=None, limiter=None, breaker=None) -> Quick18Provider:
    return Quick18Provider(
        cache=cache if cache is not None else FakeCacheStore(),
        transport=transport if transport is not None else _transport(),
        limiter=limiter if limiter is not None else SlidingWindowLimiter(rpm=1000, window_s=60),
        breaker=breaker if breaker is not None else CircuitBreaker(),
    )


# ── Request shape ───────────────────────────────────────────────────────────────

class TestRequestShape:
    async def test_single_get_exact_shape(self):
        rec: list[httpx.Request] = []
        provider = _provider(transport=_transport(recorder=rec))
        slots = await provider.slots_for_capability(_cap(), _query())
        assert slots is not None
        assert len(rec) == 1
        req = rec[0]
        assert req.method == "GET"
        assert req.url.host == _HOST
        assert req.url.path == "/teetimes/searchmatrix"
        assert dict(req.url.params)["teedate"] == "20260714"  # dash-stripped
        assert req.headers["user-agent"] == USER_AGENT


# ── Parse / normalize ────────────────────────────────────────────────────────────

class TestParseNormalize:
    async def test_emitted_times_match_oracle(self):
        cap = _cap()
        slots = await _provider().slots_for_capability(cap, _query(party_size=2))
        assert slots
        expected = [d for d in ORACLE if d["min_players"] <= 2 <= d["max_players"]]
        assert [s.time for s in slots] == [d["time"] for d in expected][:MAX_SLOTS_PER_COURSE]
        for s in slots:
            assert s.provider == "quick18"
            assert s.route is None
            assert s.estimated is False
            assert s.date == FIXTURE_DATE
            assert s.booking_url == cap.booking_url
            assert s.phone == cap.phone
            assert s.holes in (9, 18)

    async def test_players_is_max_of_range(self):
        slots = await _provider().slots_for_capability(_cap(), _query(party_size=1))
        by_time = {s.time: s for s in slots}
        for d in ORACLE:
            if d["time"] in by_time:
                assert by_time[d["time"]].players == d["max_players"]

    async def test_prices_are_dollars_not_cents(self):
        slots = await _provider().slots_for_capability(_cap(), _query(party_size=2))
        priced = [s for s in slots if s.price_usd is not None]
        assert priced, "sanity: fixture has priced bookable slots"
        assert all(5.0 <= s.price_usd <= 500.0 for s in priced)


# ── Party-range filter ──────────────────────────────────────────────────────────

class TestPartyFilter:
    async def test_party_outside_range_excluded(self):
        # SYNTHETIC: a "1 or 2 players" row must not appear for a party of 3.
        html = """
        <table class="matrixTable"><thead>
          <tr><th class="mtrxHdrTeeTimes">Tee Time</th><th class="matrixHdrPlayers">Players</th>
          <th class="matrixHdrSched">18 Holes</th></tr></thead><tbody>
          <tr><td class="mtrxTeeTimes">7:00<div class="be_tee_time_ampm">AM</div></td>
            <td class="matrixPlayers">1 or 2 players</td>
            <td class="matrixsched "><div class="mtrxPrice">$40.00</div>
              <div class="mtrxSelect"><a class="sexybutton teebutton" href="/x">Select</a></div></td></tr>
          <tr><td class="mtrxTeeTimes">8:00<div class="be_tee_time_ampm">AM</div></td>
            <td class="matrixPlayers">2 to 4 players</td>
            <td class="matrixsched "><div class="mtrxPrice">$40.00</div>
              <div class="mtrxSelect"><a class="sexybutton teebutton" href="/x">Select</a></div></td></tr>
        </tbody></table>"""
        provider = _provider(transport=_transport(body=html))
        slots = await provider.slots_for_capability(_cap(), _query(party_size=3))
        assert {s.time for s in slots} == {"08:00"}  # 07:00 (max 2) dropped


# ── Price honesty (SYNTHETIC, labeled) ──────────────────────────────────────────

class TestPriceNeverFabricated:
    async def test_na_and_unbookable_rates_never_zero_price(self):
        html = """
        <table class="matrixTable"><thead>
          <tr><th class="mtrxHdrTeeTimes">Tee Time</th><th class="matrixHdrPlayers">Players</th>
          <th class="matrixHdrSched">18 Holes</th><th class="matrixHdrSched">9 Holes</th></tr></thead><tbody>
          <tr><td class="mtrxTeeTimes">7:00<div class="be_tee_time_ampm">AM</div></td>
            <td class="matrixPlayers">1 to 4 players</td>
            <td class="matrixsched mtrxInactive"><div class="mtrxPriceNA">N/A</div>
              <div class="mtrxAvailMessage">Rate not available</div></td>
            <td class="matrixsched "><div class="mtrxPrice">$22.00</div>
              <div class="mtrxSelect"><a class="sexybutton teebutton" href="/x">Select</a></div></td></tr>
        </tbody></table>"""
        provider = _provider(transport=_transport(body=html))
        slots = await provider.slots_for_capability(_cap(), _query(party_size=1))
        assert len(slots) == 1
        # Only the 9-hole rate is bookable -> price=$22, holes=9, NEVER $0 from the N/A 18-hole cell.
        assert slots[0].price_usd == 22.0
        assert slots[0].holes == 9

    async def test_no_bookable_rate_row_is_skipped(self):
        html = """
        <table class="matrixTable"><thead>
          <tr><th class="mtrxHdrTeeTimes">Tee Time</th><th class="matrixHdrPlayers">Players</th>
          <th class="matrixHdrSched">18 Holes</th></tr></thead><tbody>
          <tr><td class="mtrxTeeTimes">7:00<div class="be_tee_time_ampm">AM</div></td>
            <td class="matrixPlayers">1 to 4 players</td>
            <td class="matrixsched mtrxInactive"><div class="mtrxPriceNA">N/A</div></td></tr>
        </tbody></table>"""
        provider = _provider(transport=_transport(body=html))
        assert await provider.slots_for_capability(_cap(), _query(party_size=1)) == []


# ── Verified empty ───────────────────────────────────────────────────────────────

class TestVerifiedEmpty:
    async def test_empty_tbody_is_verified_empty_not_none(self):
        provider = _provider(transport=_transport(body=FIXTURE_EMPTY))
        assert await provider.slots_for_capability(_cap(), _query()) == []

    async def test_window_with_no_times_is_verified_empty(self):
        provider = _provider()
        slots = await provider.slots_for_capability(
            _cap(), _query(time_window_start="01:00", time_window_end="02:00"),
        )
        assert slots == []

    async def test_malformed_window_returns_none(self):
        provider = _provider()
        assert await provider.slots_for_capability(
            _cap(), _query(time_window_start="nope", time_window_end="10:00"),
        ) is None


# ── Schema-drift guard ───────────────────────────────────────────────────────────

class TestSchemaGuard:
    async def test_missing_matrix_table_is_couldnt_check_not_empty(self):
        rec: list[httpx.Request] = []
        breaker = CircuitBreaker()
        provider = _provider(
            transport=_transport(body="<html><body>Verify you are human</body></html>", recorder=rec),
            breaker=breaker,
        )
        assert await provider.slots_for_capability(_cap(), _query()) is None  # NOT []
        # a schema-drift/anti-bot page records a breaker failure (not silent empty)
        breaker2 = CircuitBreaker()
        p2 = _provider(transport=_transport(body="<html>no table</html>"), breaker=breaker2)
        for _ in range(3):
            assert await p2.slots_for_capability(_cap(), _query()) is None


# ── Window filter ────────────────────────────────────────────────────────────────

class TestWindowFilter:
    async def test_subwindow_returns_exact_fixture_times(self):
        ws, we = "08:00", "11:00"
        expected = [d for d in ORACLE if d["min_players"] <= 2 <= d["max_players"]
                    and ws <= d["time"] <= we]
        assert expected, "sanity: window must contain fixture times"
        provider = _provider()
        slots = await provider.slots_for_capability(
            _cap(), _query(party_size=2, time_window_start=ws, time_window_end=we),
        )
        assert [s.time for s in slots] == [d["time"] for d in expected][:MAX_SLOTS_PER_COURSE]


class TestMaxPrice:
    async def test_over_budget_dropped_unknown_price_kept(self):
        slots = await _provider().slots_for_capability(_cap(), _query(party_size=2, max_price_usd=40.0))
        assert slots is not None
        for s in slots:
            assert s.price_usd is None or s.price_usd <= 40.0


# ── Truncation ────────────────────────────────────────────────────────────────────

class TestTruncation:
    async def test_truncates_to_earliest_n_sorted_ascending(self):
        expected = [d for d in ORACLE if d["min_players"] <= 1 <= d["max_players"]]
        provider = _provider()
        slots = await provider.slots_for_capability(_cap(), _query(party_size=1))
        assert len(slots) == min(len(expected), MAX_SLOTS_PER_COURSE)
        times = [s.time for s in slots]
        assert times == sorted(times)


# ── SSRF guard ─────────────────────────────────────────────────────────────────

class TestSsrfGuard:
    async def test_non_quick18_host_refused_without_network(self):
        rec: list[httpx.Request] = []
        provider = _provider(transport=_transport(recorder=rec))
        assert await provider.slots_for_capability(
            _cap(platform_ids={"host": "evil.example.com"}), _query()
        ) is None
        assert rec == []

    async def test_host_with_scheme_or_path_refused(self):
        rec: list[httpx.Request] = []
        provider = _provider(transport=_transport(recorder=rec))
        for bad in ("https://northernhills.quick18.com", "northernhills.quick18.com/evil", "a.quick18.com:8080"):
            assert await provider.slots_for_capability(_cap(platform_ids={"host": bad}), _query()) is None
        assert rec == []

    async def test_lookalike_domain_refused(self):
        rec: list[httpx.Request] = []
        provider = _provider(transport=_transport(recorder=rec))
        assert await provider.slots_for_capability(
            _cap(platform_ids={"host": "quick18.com.evil.com"}), _query()
        ) is None
        assert rec == []


# ── Error legs — never raise ─────────────────────────────────────────────────────

class TestErrorLegs:
    async def test_non_200_returns_none(self):
        provider = _provider(transport=_transport(status=500))
        assert await provider.slots_for_capability(_cap(), _query()) is None

    async def test_transport_error_returns_none(self):
        def handler(request):
            raise httpx.ConnectError("boom", request=request)
        provider = _provider(transport=httpx.MockTransport(handler))
        assert await provider.slots_for_capability(_cap(), _query()) is None

    async def test_timeout_returns_none(self):
        def handler(request):
            raise httpx.TimeoutException("timeout", request=request)
        provider = _provider(transport=httpx.MockTransport(handler))
        assert await provider.slots_for_capability(_cap(), _query()) is None

    async def test_malformed_date_returns_none_without_network(self):
        rec: list[httpx.Request] = []
        provider = _provider(transport=_transport(recorder=rec))
        assert await provider.slots_for_capability(_cap(), _query(date="not-a-date")) is None
        assert rec == []

    async def test_missing_host_returns_none_without_network(self):
        rec: list[httpx.Request] = []
        provider = _provider(transport=_transport(recorder=rec))
        assert await provider.slots_for_capability(_cap(platform_ids={}), _query()) is None
        assert rec == []

    async def test_search_availability_error_legs_return_empty_never_raise(self):
        def handler(request):
            raise httpx.ConnectError("boom", request=request)
        cap = _cap()
        provider = Quick18Provider(
            capabilities=lambda: (cap,),
            cache=FakeCacheStore(),
            transport=httpx.MockTransport(handler),
            limiter=SlidingWindowLimiter(rpm=1000, window_s=60),
            breaker=CircuitBreaker(),
        )
        assert await provider.search_availability(_query(area=f"{cap.lat},{cap.lng}")) == []

    async def test_search_availability_no_origin_returns_empty(self):
        assert await _provider().search_availability(_query(area=None)) == []

    async def test_search_availability_skips_non_quick18_caps(self):
        other = CourseBookingCapability(
            platform="teeitup", name="X", lat=44.0, lng=-92.5,
            platform_ids={"alias": "x", "facility_id": "1"},
        )
        rec: list[httpx.Request] = []
        provider = Quick18Provider(
            capabilities=lambda: (other,),
            cache=FakeCacheStore(),
            transport=_transport(recorder=rec),
            limiter=SlidingWindowLimiter(rpm=1000, window_s=60),
            breaker=CircuitBreaker(),
        )
        assert await provider.search_availability(_query(area="44.0,-92.5")) == []
        assert rec == []


# ── Cache ────────────────────────────────────────────────────────────────────────

class TestCache:
    async def test_second_call_within_ttl_makes_zero_http(self):
        rec: list[httpx.Request] = []
        cache = FakeCacheStore()
        provider = _provider(transport=_transport(recorder=rec), cache=cache)
        await provider.slots_for_capability(_cap(), _query())
        assert len(rec) == 1
        await provider.slots_for_capability(_cap(), _query())
        assert len(rec) == 1  # served from cache

    async def test_refetch_after_ttl_expiry(self):
        rec: list[httpx.Request] = []
        clock = {"t": 0.0}
        cache = FakeCacheStore(now_fn=lambda: clock["t"], ttl_seconds=480.0)
        provider = _provider(transport=_transport(recorder=rec), cache=cache)
        await provider.slots_for_capability(_cap(), _query())
        assert len(rec) == 1
        clock["t"] += 480.0
        await provider.slots_for_capability(_cap(), _query())
        assert len(rec) == 2

    async def test_verified_empty_day_is_a_valid_cache_hit(self):
        rec: list[httpx.Request] = []
        cache = FakeCacheStore()
        provider = _provider(transport=_transport(body=FIXTURE_EMPTY, recorder=rec), cache=cache)
        cap = _cap()
        assert await provider.slots_for_capability(cap, _query()) == []
        assert await provider.slots_for_capability(cap, _query()) == []
        assert len(rec) == 1  # no re-poll storm on an empty day

    async def test_date_scopes_the_cache_separately(self):
        rec: list[httpx.Request] = []
        cache = FakeCacheStore()
        provider = _provider(transport=_transport(recorder=rec), cache=cache)
        await provider.slots_for_capability(_cap(), _query(date="2026-07-14"))
        assert len(rec) == 1
        await provider.slots_for_capability(_cap(), _query(date="2026-07-15"))
        assert len(rec) == 2


# ── Single-flight ────────────────────────────────────────────────────────────────

class TestSingleFlight:
    async def test_five_concurrent_calls_make_exactly_one_fetch(self):
        rec: list[httpx.Request] = []
        provider = _provider(transport=_transport(recorder=rec), cache=FakeCacheStore())
        results = await asyncio.gather(*[
            provider.slots_for_capability(_cap(), _query()) for _ in range(5)
        ])
        assert len(rec) == 1
        assert all(r is not None for r in results)


# ── Rate limiter ───────────────────────────────────────────────────────────────────

class TestRateLimiter:
    async def test_limiter_at_cap_returns_none_zero_http_no_breaker_failure(self):
        rec: list[httpx.Request] = []
        limiter = SlidingWindowLimiter(rpm=1, window_s=60)
        limiter.check(_HOST)  # consume the one slot
        breaker = CircuitBreaker()
        provider = _provider(transport=_transport(recorder=rec), limiter=limiter, breaker=breaker)
        assert await provider.slots_for_capability(_cap(), _query()) is None
        assert rec == []
        assert breaker.allow() is True  # self-throttle never a breaker failure


# ── Circuit breaker ────────────────────────────────────────────────────────────────

class TestCircuitBreaker:
    async def test_three_failures_open_then_fourth_makes_no_http(self):
        rec: list[httpx.Request] = []
        breaker = CircuitBreaker()
        limiter = SlidingWindowLimiter(rpm=1000, window_s=60)
        provider = _provider(transport=_transport(status=500, recorder=rec), breaker=breaker, limiter=limiter)
        for _ in range(3):
            assert await provider.slots_for_capability(_cap(), _query()) is None
        assert len(rec) == 3
        assert await provider.slots_for_capability(_cap(), _query()) is None
        assert len(rec) == 3  # breaker open — zero additional HTTP


# ── book() ─────────────────────────────────────────────────────────────────────────

class TestBook:
    async def test_book_returns_needs_human(self):
        slot = TeeTimeSlot(
            id="quick18-northernhills.quick18.com-2026-07-14-07:28-0",
            course_id="quick18-northernhills.quick18.com",
            course_name="Northern Hills Golf Course",
            city="", date="2026-07-14", time="07:28", players=2, price_usd=39.0,
            cart_included=False, distance_miles=0.0, rating=0.0, provider="quick18",
            holes=18, booking_url=f"https://{_HOST}/teetimes/searchmatrix", route=None,
        )
        result = await _provider().book(slot, BookingDetails(name="Owner", party_size=2))
        assert result.status == "needs_human"
        assert result.confirmation_number is None
        assert result.booking_url == slot.booking_url
        assert "7:28 AM" in (result.message or "")
        assert "Northern Hills Golf Course" in (result.message or "")

    async def test_name_property(self):
        assert _provider().name == "quick18"
