"""Tests for golfapi_cache — no real DB, no network.

All tests use injectable fakes for the GolfAPI client and the cache/budget
stores.  No subprocess, no httpx, no postgres — deterministic and offline.

Per-course coverage:
  - cache-hit  → client.call_count == 0
  - cache-miss → client.call_count == 1 (one fetch_coordinates call)
  - second call after a miss → 0 (now cached)
  - budget guard: at or beyond the cap, misses do NOT call GolfAPI
  - no-token path: no call, no crash, returns None or cached
  - normalize_golfapi_coordinates: correct poi/location decoding
  - persist round-trip: stored coords are returned on subsequent calls
  - force=True bypasses cache

Discovery coverage:
  - cache-hit area → 0 API calls; miss → 1 fetch_clubs call
  - second call on same area → 0 calls (now cached)
  - one fetch_clubs returns many course IDs (0 further calls to list them)
  - budget guard applies to discovery too
  - no-token: no call, no crash
"""

from __future__ import annotations

import pytest

from app.services.golfapi_cache import (
    CALLS_PER_COURSE,
    CALLS_PER_DISCOVERY,
    CacheStore,
    BudgetStore,
    DiscoveryStore,
    GolfApiClient,
    discover_golfapi_clubs,
    get_course_golf_data,
    normalize_golfapi_coordinates,
)


# ── Fake implementations ───────────────────────────────────────────────────────

class FakeClient(GolfApiClient):
    """Returns fixture data and counts all API invocations."""

    def __init__(
        self,
        coords: list[dict] | None = None,
        clubs: list[dict] | None = None,
    ) -> None:
        self._calls = 0
        self._coords = coords if coords is not None else _FIXTURE_RAW_COORDS
        self._clubs = clubs if clubs is not None else _FIXTURE_CLUBS

    @property
    def call_count(self) -> int:
        return self._calls

    async def fetch_coordinates(self, golfapi_course_id: str) -> list[dict]:
        self._calls += 1
        return self._coords

    async def fetch_clubs(self, query: str) -> list[dict]:
        self._calls += 1
        return self._clubs


class InMemoryCacheStore(CacheStore):
    """Dict-backed coordinate cache — no file I/O."""

    def __init__(self) -> None:
        self._data: dict[str, list[dict]] = {}

    def is_cached(self, our_course_id: str) -> bool:
        return our_course_id in self._data

    def get_cached(self, our_course_id: str) -> list[dict] | None:
        return self._data.get(our_course_id)

    def set_cached(self, our_course_id: str, coords: list[dict]) -> None:
        self._data[our_course_id] = coords


class InMemoryDiscoveryStore(DiscoveryStore):
    """Dict-backed discovery cache — no file I/O."""

    def __init__(self) -> None:
        self._data: dict[str, list[dict]] = {}

    def is_cached(self, area_key: str) -> bool:
        return area_key in self._data

    def get_cached(self, area_key: str) -> list[dict] | None:
        return self._data.get(area_key)

    def set_cached(self, area_key: str, clubs: list[dict]) -> None:
        self._data[area_key] = clubs


class InMemoryBudgetStore(BudgetStore):
    """Counter-backed budget — no file I/O."""

    def __init__(self, initial: int = 0) -> None:
        self._calls = initial

    def current_month_calls(self) -> int:
        return self._calls

    def add_calls(self, n: int) -> int:
        self._calls += n
        return self._calls


# ── GolfAPI raw-coords fixture (poi/location format) ──────────────────────────
# Two holes: H1 has green center + tee; H2 has green + front + back.

_FIXTURE_RAW_COORDS: list[dict] = [
    # Hole 1 — green center (poi=1, location=2), tee (poi=11, location=2)
    {"hole": "1", "poi": "1", "location": "2", "latitude": "40.7450", "longitude": "-73.4513"},
    {"hole": "1", "poi": "11", "location": "2", "latitude": "40.7430", "longitude": "-73.4545"},
    # Hole 2 — green center + front + back
    {"hole": "2", "poi": "1", "location": "2", "latitude": "40.7464", "longitude": "-73.4472"},
    {"hole": "2", "poi": "1", "location": "3", "latitude": "40.7463", "longitude": "-73.4473"},  # front
    {"hole": "2", "poi": "1", "location": "1", "latitude": "40.7465", "longitude": "-73.4471"},  # back
]

# GolfAPI club fixture — one /clubs call returns many course IDs.
_FIXTURE_CLUBS: list[dict] = [
    {
        "clubID": "111",
        "clubName": "Bethpage State Park",
        "courses": [
            {"courseID": "1001", "courseName": "Black"},
            {"courseID": "1002", "courseName": "Red"},
            {"courseID": "1003", "courseName": "Blue"},
            {"courseID": "1004", "courseName": "Yellow"},
            {"courseID": "1005", "courseName": "Green"},
        ],
    },
]

_COURSE_ID = "test-course-uuid-1234"
_GOLFAPI_ID = "9999"
_AREA_KEY = "bethpage-ny"
_AREA_QUERY = "Bethpage"


# ── Helpers ────────────────────────────────────────────────────────────────────

def _new_stores(budget_initial: int = 0):
    return InMemoryCacheStore(), InMemoryBudgetStore(budget_initial)


def _new_discovery_stores(budget_initial: int = 0):
    return InMemoryDiscoveryStore(), InMemoryBudgetStore(budget_initial)


# ── normalize_golfapi_coordinates ─────────────────────────────────────────────

def test_normalize_two_holes() -> None:
    coords = normalize_golfapi_coordinates(_FIXTURE_RAW_COORDS)
    assert len(coords) == 2

    h1 = coords[0]
    assert h1["hole"] == 1
    assert h1["green"] == {"lat": 40.745, "lng": -73.4513}
    assert h1["tee"] == {"lat": 40.743, "lng": -73.4545}
    assert h1["front"] is None
    assert h1["back"] is None

    h2 = coords[1]
    assert h2["hole"] == 2
    assert h2["green"] == {"lat": 40.7464, "lng": -73.4472}
    assert h2["front"] == {"lat": 40.7463, "lng": -73.4473}
    assert h2["back"] == {"lat": 40.7465, "lng": -73.4471}


def test_normalize_empty() -> None:
    assert normalize_golfapi_coordinates([]) == []


def test_normalize_skips_holes_without_green() -> None:
    raw = [
        {"hole": "3", "poi": "11", "location": "2", "latitude": "40.7", "longitude": "-73.4"},
    ]
    assert normalize_golfapi_coordinates(raw) == []


def test_normalize_fallback_green_no_location() -> None:
    raw = [
        {"hole": "5", "poi": "1", "location": "", "latitude": "40.75", "longitude": "-73.45"},
    ]
    result = normalize_golfapi_coordinates(raw)
    assert len(result) == 1
    assert result[0]["green"] == {"lat": 40.75, "lng": -73.45}


# ── get_course_golf_data — per-course ──────────────────────────────────────────

@pytest.mark.asyncio
async def test_cache_hit_zero_calls(monkeypatch) -> None:
    """Cache hit → client is never called (0 fetch_coordinates invocations)."""
    monkeypatch.setenv("GOLF_API_KEY", "tok-test")
    cache, budget = _new_stores()
    fake_coords = [{"hole": 1, "green": {"lat": 40.7, "lng": -73.4}, "tee": None, "front": None, "back": None}]
    cache.set_cached(_COURSE_ID, fake_coords)

    client = FakeClient()
    result = await get_course_golf_data(
        _COURSE_ID, _GOLFAPI_ID,
        client=client, cache_store=cache, budget_store=budget,
    )

    assert client.call_count == 0, "cache-hit must make 0 API calls"
    assert result == fake_coords


@pytest.mark.asyncio
async def test_cache_miss_one_fetch_coordinates(monkeypatch) -> None:
    """Cache miss → exactly 1 fetch_coordinates call (1 API call)."""
    monkeypatch.setenv("GOLF_API_KEY", "tok-test")
    cache, budget = _new_stores()
    client = FakeClient()

    result = await get_course_golf_data(
        _COURSE_ID, _GOLFAPI_ID,
        client=client, cache_store=cache, budget_store=budget,
    )

    assert client.call_count == 1, "cache-miss must call fetch_coordinates exactly once"
    assert result is not None
    assert len(result) == 2


@pytest.mark.asyncio
async def test_second_call_after_miss_zero_calls(monkeypatch) -> None:
    """After a miss populates the store, a second call uses 0 API calls."""
    monkeypatch.setenv("GOLF_API_KEY", "tok-test")
    cache, budget = _new_stores()
    client = FakeClient()

    await get_course_golf_data(
        _COURSE_ID, _GOLFAPI_ID,
        client=client, cache_store=cache, budget_store=budget,
    )
    assert client.call_count == 1

    client2 = FakeClient()
    result2 = await get_course_golf_data(
        _COURSE_ID, _GOLFAPI_ID,
        client=client2, cache_store=cache, budget_store=budget,
    )

    assert client2.call_count == 0, "second call must NOT increment call_count"
    assert result2 is not None
    assert len(result2) == 2


@pytest.mark.asyncio
async def test_budget_guard_at_cap_no_call(monkeypatch) -> None:
    """Budget at HARD_STOP_AT (45) blocks the fetch: 45+1 > 45."""
    monkeypatch.setenv("GOLF_API_KEY", "tok-test")
    # HARD_STOP_AT = 45; 45 + CALLS_PER_COURSE (1) = 46 > 45 → blocked
    cache, budget = _new_stores(budget_initial=45)
    client = FakeClient()

    result = await get_course_golf_data(
        _COURSE_ID, _GOLFAPI_ID,
        client=client, cache_store=cache, budget_store=budget,
    )

    assert client.call_count == 0, "budget guard must make 0 API calls"
    assert result is None


@pytest.mark.asyncio
async def test_budget_guard_just_under_cap(monkeypatch) -> None:
    """Budget at 44 allows fetch: 44+1 = 45 = cap, not strictly greater."""
    monkeypatch.setenv("GOLF_API_KEY", "tok-test")
    cache, budget = _new_stores(budget_initial=44)
    client = FakeClient()

    result = await get_course_golf_data(
        _COURSE_ID, _GOLFAPI_ID,
        client=client, cache_store=cache, budget_store=budget,
    )

    assert client.call_count == 1, "44 calls used + 1 needed = 45 = cap, allowed"
    assert result is not None


@pytest.mark.asyncio
async def test_budget_incremented_on_fetch(monkeypatch) -> None:
    """A successful fetch increments the budget by CALLS_PER_COURSE (1)."""
    monkeypatch.setenv("GOLF_API_KEY", "tok-test")
    cache, budget = _new_stores()
    client = FakeClient()

    await get_course_golf_data(
        _COURSE_ID, _GOLFAPI_ID,
        client=client, cache_store=cache, budget_store=budget,
    )

    assert budget.current_month_calls() == CALLS_PER_COURSE


@pytest.mark.asyncio
async def test_no_token_no_call(monkeypatch) -> None:
    """With no GOLF_API_KEY configured, zero API calls are made."""
    monkeypatch.delenv("GOLF_API_KEY", raising=False)
    cache, budget = _new_stores()
    client = FakeClient()

    result = await get_course_golf_data(
        _COURSE_ID, _GOLFAPI_ID,
        client=client, cache_store=cache, budget_store=budget,
    )

    assert client.call_count == 0
    assert result is None


@pytest.mark.asyncio
async def test_no_token_returns_cached_data(monkeypatch) -> None:
    """With no token, cached data is still served."""
    monkeypatch.delenv("GOLF_API_KEY", raising=False)
    cache, budget = _new_stores()
    cached = [{"hole": 1, "green": {"lat": 1.0, "lng": 2.0}, "tee": None, "front": None, "back": None}]
    cache.set_cached(_COURSE_ID, cached)
    client = FakeClient()

    result = await get_course_golf_data(
        _COURSE_ID, _GOLFAPI_ID,
        client=client, cache_store=cache, budget_store=budget,
    )

    assert client.call_count == 0
    assert result == cached


@pytest.mark.asyncio
async def test_no_golfapi_id_no_call(monkeypatch) -> None:
    """When golfapi_course_id is empty, no API call is made."""
    monkeypatch.setenv("GOLF_API_KEY", "tok-test")
    cache, budget = _new_stores()
    client = FakeClient()

    result = await get_course_golf_data(
        _COURSE_ID, "",
        client=client, cache_store=cache, budget_store=budget,
    )

    assert client.call_count == 0
    assert result is None


@pytest.mark.asyncio
async def test_persist_round_trip(monkeypatch) -> None:
    """Stored coords are faithfully returned by subsequent cache hits."""
    monkeypatch.setenv("GOLF_API_KEY", "tok-test")
    cache, budget = _new_stores()
    client = FakeClient()

    first = await get_course_golf_data(
        _COURSE_ID, _GOLFAPI_ID,
        client=client, cache_store=cache, budget_store=budget,
    )
    assert first is not None and len(first) == 2

    client2 = FakeClient()
    second = await get_course_golf_data(
        _COURSE_ID, _GOLFAPI_ID,
        client=client2, cache_store=cache, budget_store=budget,
    )

    assert client2.call_count == 0, "round-trip must not re-call the API"
    assert second == first


@pytest.mark.asyncio
async def test_force_bypasses_cache(monkeypatch) -> None:
    """force=True re-fetches even when cache is populated."""
    monkeypatch.setenv("GOLF_API_KEY", "tok-test")
    cache, budget = _new_stores()
    cache.set_cached(_COURSE_ID, [])  # stale empty cache

    client = FakeClient()
    result = await get_course_golf_data(
        _COURSE_ID, _GOLFAPI_ID,
        force=True,
        client=client, cache_store=cache, budget_store=budget,
    )

    assert client.call_count == 1
    assert result is not None and len(result) == 2


@pytest.mark.asyncio
async def test_per_course_costs_one_call(monkeypatch) -> None:
    """Per-course fetch costs exactly 1 API call (fetch_coordinates only).

    No additional /courses/{id} detail call should be made — budget efficiency.
    """
    monkeypatch.setenv("GOLF_API_KEY", "tok-test")
    cache, budget = _new_stores()
    client = FakeClient()

    await get_course_golf_data(
        _COURSE_ID, _GOLFAPI_ID,
        client=client, cache_store=cache, budget_store=budget,
    )

    # Exactly 1 call consumed (coordinates endpoint only)
    assert client.call_count == 1, "per-course must cost exactly 1 API call"
    assert budget.current_month_calls() == 1


# ── discover_golfapi_clubs — area discovery ────────────────────────────────────

@pytest.mark.asyncio
async def test_discovery_cache_hit_zero_calls(monkeypatch) -> None:
    """Area cache hit → 0 API calls."""
    monkeypatch.setenv("GOLF_API_KEY", "tok-test")
    disc_store, budget = _new_discovery_stores()
    disc_store.set_cached(_AREA_KEY, _FIXTURE_CLUBS)

    client = FakeClient()
    result = await discover_golfapi_clubs(
        _AREA_KEY, _AREA_QUERY,
        client=client, discovery_store=disc_store, budget_store=budget,
    )

    assert client.call_count == 0, "discovery cache-hit must make 0 API calls"
    assert result == _FIXTURE_CLUBS


@pytest.mark.asyncio
async def test_discovery_miss_one_call(monkeypatch) -> None:
    """Area cache miss → exactly 1 fetch_clubs call."""
    monkeypatch.setenv("GOLF_API_KEY", "tok-test")
    disc_store, budget = _new_discovery_stores()
    client = FakeClient()

    result = await discover_golfapi_clubs(
        _AREA_KEY, _AREA_QUERY,
        client=client, discovery_store=disc_store, budget_store=budget,
    )

    assert client.call_count == 1, "discovery miss must call fetch_clubs exactly once"
    assert result is not None
    # One /clubs call returned 5 course IDs (verify no further per-course calls made)
    total_course_ids = sum(len(c.get("courses", [])) for c in (result or []))
    assert total_course_ids == 5


@pytest.mark.asyncio
async def test_discovery_second_call_zero_calls(monkeypatch) -> None:
    """After a discovery miss, the second call for same area uses 0 API calls."""
    monkeypatch.setenv("GOLF_API_KEY", "tok-test")
    disc_store, budget = _new_discovery_stores()
    client = FakeClient()

    await discover_golfapi_clubs(
        _AREA_KEY, _AREA_QUERY,
        client=client, discovery_store=disc_store, budget_store=budget,
    )
    assert client.call_count == 1

    client2 = FakeClient()
    result2 = await discover_golfapi_clubs(
        _AREA_KEY, _AREA_QUERY,
        client=client2, discovery_store=disc_store, budget_store=budget,
    )

    assert client2.call_count == 0, "cached area must make 0 further calls"
    assert result2 is not None


@pytest.mark.asyncio
async def test_discovery_yields_many_course_ids_in_one_call(monkeypatch) -> None:
    """One /clubs call returns many course IDs — no further listing calls needed."""
    monkeypatch.setenv("GOLF_API_KEY", "tok-test")
    disc_store, budget = _new_discovery_stores()
    client = FakeClient()

    result = await discover_golfapi_clubs(
        _AREA_KEY, _AREA_QUERY,
        client=client, discovery_store=disc_store, budget_store=budget,
    )

    # Single call_count=1 yielded 5 course IDs — demonstrates batch efficiency
    assert client.call_count == 1
    assert result is not None
    course_ids = [c["courseID"] for club in result for c in club.get("courses", [])]
    assert len(course_ids) == 5
    assert set(course_ids) == {"1001", "1002", "1003", "1004", "1005"}


@pytest.mark.asyncio
async def test_discovery_budget_guard(monkeypatch) -> None:
    """Budget at HARD_STOP_AT blocks discovery: 45+1 > 45."""
    monkeypatch.setenv("GOLF_API_KEY", "tok-test")
    disc_store, budget = _new_discovery_stores(budget_initial=45)
    client = FakeClient()

    result = await discover_golfapi_clubs(
        _AREA_KEY, _AREA_QUERY,
        client=client, discovery_store=disc_store, budget_store=budget,
    )

    assert client.call_count == 0
    assert result is None


@pytest.mark.asyncio
async def test_discovery_budget_incremented(monkeypatch) -> None:
    """Successful discovery increments budget by CALLS_PER_DISCOVERY (1)."""
    monkeypatch.setenv("GOLF_API_KEY", "tok-test")
    disc_store, budget = _new_discovery_stores()
    client = FakeClient()

    await discover_golfapi_clubs(
        _AREA_KEY, _AREA_QUERY,
        client=client, discovery_store=disc_store, budget_store=budget,
    )

    assert budget.current_month_calls() == CALLS_PER_DISCOVERY


@pytest.mark.asyncio
async def test_discovery_no_token_no_call(monkeypatch) -> None:
    """With no GOLF_API_KEY, discovery makes 0 calls and returns None."""
    monkeypatch.delenv("GOLF_API_KEY", raising=False)
    disc_store, budget = _new_discovery_stores()
    client = FakeClient()

    result = await discover_golfapi_clubs(
        _AREA_KEY, _AREA_QUERY,
        client=client, discovery_store=disc_store, budget_store=budget,
    )

    assert client.call_count == 0
    assert result is None
