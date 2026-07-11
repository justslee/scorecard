"""Tests for GET /api/courses/in-bounds (course-selection B1) — the DB-free
unit slice: cell-key/enumeration purity, bbox validation, cold/warm-cell OSM
fill behavior, positive-only caching, the budget invariant (no paid API is
EVER reachable from this path), degraded-not-empty honesty, pin cap, zoomIn,
fanout cap, and cross-source dedupe.

Follows TestNearbyCourses' conventions (test_course_search.py): the handler
coroutine is called directly, `course_search`-module names are monkeypatched,
and `_db_courses_in_bounds` is monkeypatched so no DATABASE_URL is needed.
"""

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.routes import course_search
from app.services import course_finder


class FakeCacheStore:
    """In-memory stand-in for SearchCacheStore — mirrors
    test_course_search.py's FakeCacheStore (no disk I/O, no TTL)."""

    def __init__(self):
        self.data: dict[str, list[dict]] = {}
        self.set_calls: list[tuple[str, list[dict]]] = []

    def get(self, key):
        return self.data.get(key)

    def set(self, key, results):
        self.data[key] = results
        self.set_calls.append((key, results))


def _never_called(name):
    async def _fn(*args, **kwargs):
        raise AssertionError(f"{name} should not have been called")
    return _fn


async def _empty_db(*args, **kwargs):
    return []


@pytest.fixture(autouse=True)
def _fake_in_bounds_cache(monkeypatch):
    cache = FakeCacheStore()
    monkeypatch.setattr(course_search, "_in_bounds_cache", cache)
    return cache


@pytest.fixture(autouse=True)
def _stub_db(monkeypatch):
    """Default: DB leg returns nothing. Individual tests override via a
    fresh monkeypatch when they need DB pins."""
    monkeypatch.setattr(course_search, "_db_courses_in_bounds", _empty_db)


# A small bbox well under the zoomIn threshold, aligned to cover EXACTLY 2
# 0.05° cells (1 lat x 2 lng) — comfortably under IN_BOUNDS_MAX_COLD_CELLS so
# most tests below aren't incidentally exercising the fanout cap (T10 owns
# that, with its own larger bbox).
SW_LAT, SW_LNG, NE_LAT, NE_LNG = 40.70, -73.50, 40.74, -73.41


# ─────────────────────────────────────────────────────────────────────────────
# T1 — cell-key / enumeration purity
# ─────────────────────────────────────────────────────────────────────────────

def test_cell_key_format():
    assert course_search._in_bounds_cell_key(814, -1470) == "inbounds:v1:814:-1470"


def test_cells_for_bbox_covers_exactly_the_intersecting_cells():
    cells = course_search._cells_for_bbox(40.70, -73.50, 40.80, -73.40)
    # math.floor(v / 0.05) for each edge — computed directly (not assumed
    # exact) since float division lands just below some integer boundaries
    # (e.g. 40.80 / 0.05 == 815.9999999999999, floor 815, not 816).
    import math
    ilat_min, ilat_max = math.floor(40.70 / 0.05), math.floor(40.80 / 0.05)
    ilng_min, ilng_max = math.floor(-73.50 / 0.05), math.floor(-73.40 / 0.05)
    expected = {
        (ilat, ilng)
        for ilat in range(ilat_min, ilat_max + 1)
        for ilng in range(ilng_min, ilng_max + 1)
    }
    assert set(cells) == expected


def test_cells_for_bbox_is_center_out_ordered():
    cells = course_search._cells_for_bbox(40.70, -73.50, 40.80, -73.40)
    c_lat = (40.70 + 40.80) / 2
    c_lng = (-73.50 + -73.40) / 2

    def _dist(cell):
        ilat, ilng = cell
        cell_lat = (ilat + 0.5) * course_search.IN_BOUNDS_CELL_DEG
        cell_lng = (ilng + 0.5) * course_search.IN_BOUNDS_CELL_DEG
        return (cell_lat - c_lat) ** 2 + (cell_lng - c_lng) ** 2

    dists = [_dist(c) for c in cells]
    assert dists == sorted(dists)


def test_overlapping_bboxes_share_cell_keys():
    a = set(course_search._cells_for_bbox(40.70, -73.50, 40.80, -73.40))
    b = set(course_search._cells_for_bbox(40.75, -73.45, 40.85, -73.35))
    assert a & b, "overlapping viewports must share at least one cell"


# ─────────────────────────────────────────────────────────────────────────────
# T2 — validation -> 400
# ─────────────────────────────────────────────────────────────────────────────

class TestValidation:
    async def test_inverted_lat(self):
        with pytest.raises(HTTPException) as exc:
            await course_search.in_bounds_courses(swLat=41.0, swLng=-73.5, neLat=40.0, neLng=-73.4)
        assert exc.value.status_code == 400

    async def test_inverted_lng_including_antimeridian(self):
        with pytest.raises(HTTPException) as exc:
            await course_search.in_bounds_courses(swLat=40.0, swLng=179.0, neLat=41.0, neLng=-179.0)
        assert exc.value.status_code == 400

    async def test_out_of_range_lat(self):
        with pytest.raises(HTTPException) as exc:
            await course_search.in_bounds_courses(swLat=-95.0, swLng=-73.5, neLat=40.0, neLng=-73.4)
        assert exc.value.status_code == 400

    async def test_out_of_range_lng(self):
        with pytest.raises(HTTPException) as exc:
            await course_search.in_bounds_courses(swLat=40.0, swLng=-73.5, neLat=41.0, neLng=200.0)
        assert exc.value.status_code == 400

    async def test_non_finite(self):
        with pytest.raises(HTTPException) as exc:
            await course_search.in_bounds_courses(
                swLat=float("nan"), swLng=-73.5, neLat=41.0, neLng=-73.4,
            )
        assert exc.value.status_code == 400

        with pytest.raises(HTTPException) as exc:
            await course_search.in_bounds_courses(
                swLat=40.0, swLng=-73.5, neLat=float("inf"), neLng=-73.4,
            )
        assert exc.value.status_code == 400


# ─────────────────────────────────────────────────────────────────────────────
# T3 — cold cell
# ─────────────────────────────────────────────────────────────────────────────

async def test_cold_cell_calls_osm_once_per_cell_and_writes_through(monkeypatch):
    calls = []

    async def fake_search_golf_courses(**kwargs):
        calls.append(kwargs)
        return [{"osm_id": "way/1", "name": "Cold Course", "source": "osm",
                  "center": {"lat": 40.75, "lng": -73.45}}]

    monkeypatch.setattr(course_search, "search_golf_courses", fake_search_golf_courses)

    write_through_calls = []

    async def fake_write_through(rows):
        write_through_calls.append(rows)

    monkeypatch.setattr(course_search, "_write_through_courses", fake_write_through)

    bg = BackgroundTasks()
    result = await course_search.in_bounds_courses(
        swLat=SW_LAT, swLng=SW_LNG, neLat=NE_LAT, neLng=NE_LNG, background_tasks=bg,
    )

    n_cells = len(course_search._cells_for_bbox(SW_LAT, SW_LNG, NE_LAT, NE_LNG))
    assert 0 < n_cells <= course_search.IN_BOUNDS_MAX_COLD_CELLS  # sanity: under the fanout cap
    assert len(calls) == n_cells
    for kwargs in calls:
        assert kwargs["radius_m"] == 4000
        assert kwargs["interactive"] is True
        assert "lat" in kwargs and "lng" in kwargs

    expected_id = course_finder.deterministic_course_id("osm-way/1")
    assert any(c["id"] == expected_id for c in result["courses"])
    assert result["degraded"] is False
    assert result["zoomIn"] is False

    cache = course_search._in_bounds_cache
    assert len(cache.set_calls) == n_cells

    await bg()
    assert len(write_through_calls) == 1
    assert write_through_calls[0][0]["name"] == "Cold Course"


# ─────────────────────────────────────────────────────────────────────────────
# T4 — warm cell
# ─────────────────────────────────────────────────────────────────────────────

async def test_warm_cells_make_zero_osm_calls(monkeypatch):
    cache = course_search._in_bounds_cache
    cached_hit = {"id": "warm-1", "name": "Warm Course", "source": "osm",
                  "center": {"lat": 40.75, "lng": -73.45}}
    for ilat, ilng in course_search._cells_for_bbox(SW_LAT, SW_LNG, NE_LAT, NE_LNG):
        cache.data[course_search._in_bounds_cell_key(ilat, ilng)] = [cached_hit]

    monkeypatch.setattr(course_search, "search_golf_courses", _never_called("search_golf_courses"))

    write_through_calls = []

    async def fake_write_through(rows):
        write_through_calls.append(rows)

    monkeypatch.setattr(course_search, "_write_through_courses", fake_write_through)

    bg = BackgroundTasks()
    result = await course_search.in_bounds_courses(
        swLat=SW_LAT, swLng=SW_LNG, neLat=NE_LAT, neLng=NE_LNG, background_tasks=bg,
    )

    assert any(c["name"] == "Warm Course" for c in result["courses"])
    assert cache.set_calls == []  # not re-cached
    await bg()
    assert write_through_calls == []  # cached hits are not re-written


# ─────────────────────────────────────────────────────────────────────────────
# T5 — positive-only cache
# ─────────────────────────────────────────────────────────────────────────────

async def test_empty_osm_cell_is_not_cached_and_not_degraded(monkeypatch):
    async def fake_search_golf_courses(**kwargs):
        return []

    monkeypatch.setattr(course_search, "search_golf_courses", fake_search_golf_courses)

    result = await course_search.in_bounds_courses(
        swLat=SW_LAT, swLng=SW_LNG, neLat=NE_LAT, neLng=NE_LNG,
    )

    assert result["courses"] == []
    assert result["degraded"] is False
    assert course_search._in_bounds_cache.set_calls == []


# ─────────────────────────────────────────────────────────────────────────────
# T6 — budget invariant: NO paid API is EVER reachable from this path
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _budget_guard(monkeypatch):
    async def _boom(*args, **kwargs):
        raise AssertionError("budget violation: paid/external-search leg called from /in-bounds")

    monkeypatch.setattr(course_search, "_search_google_places", _boom)
    monkeypatch.setattr(course_search, "_search_golfapi", _boom)
    monkeypatch.setattr(course_search.golfapi_cache, "discover_golfapi_clubs", _boom)
    monkeypatch.setattr(course_finder, "search_google_places", _boom)
    monkeypatch.setattr(course_search, "_search_mapbox", _boom)


async def test_budget_invariant_cold_and_warm_requests_never_touch_paid_apis(monkeypatch):
    async def fake_search_golf_courses(**kwargs):
        return [{"osm_id": "way/9", "name": "Budget Course", "source": "osm",
                  "center": {"lat": 40.75, "lng": -73.45}}]

    monkeypatch.setattr(course_search, "search_golf_courses", fake_search_golf_courses)

    cold_result = await course_search.in_bounds_courses(
        swLat=SW_LAT, swLng=SW_LNG, neLat=NE_LAT, neLng=NE_LNG,
    )
    assert cold_result["courses"]  # succeeded

    # Second identical request is now fully warm.
    monkeypatch.setattr(course_search, "search_golf_courses", _never_called("search_golf_courses"))
    warm_result = await course_search.in_bounds_courses(
        swLat=SW_LAT, swLng=SW_LNG, neLat=NE_LAT, neLng=NE_LNG,
    )
    assert warm_result["courses"]  # succeeded, zero violations raised


# ─────────────────────────────────────────────────────────────────────────────
# T7 — degraded, not empty
# ─────────────────────────────────────────────────────────────────────────────

async def test_osm_raise_returns_db_pins_degraded_true(monkeypatch):
    async def fake_db(*args, **kwargs):
        return [
            {"id": "db-1", "name": "DB Course One", "address": None,
             "center": {"lat": 40.75, "lng": -73.45}, "source": "local"},
            {"id": "db-2", "name": "DB Course Two", "address": None,
             "center": {"lat": 40.76, "lng": -73.46}, "source": "local"},
        ]

    monkeypatch.setattr(course_search, "_db_courses_in_bounds", fake_db)

    async def fake_search_golf_courses(**kwargs):
        raise TimeoutError("overpass timed out")

    monkeypatch.setattr(course_search, "search_golf_courses", fake_search_golf_courses)

    result = await course_search.in_bounds_courses(
        swLat=SW_LAT, swLng=SW_LNG, neLat=NE_LAT, neLng=NE_LNG,
    )

    assert len(result["courses"]) == 2
    assert {c["id"] for c in result["courses"]} == {"db-1", "db-2"}
    assert result["degraded"] is True
    assert course_search._in_bounds_cache.set_calls == []


# ─────────────────────────────────────────────────────────────────────────────
# T8 — pin cap
# ─────────────────────────────────────────────────────────────────────────────

async def test_pin_cap_truncates_to_40(monkeypatch):
    db_rows = [
        {"id": f"db-{i}", "name": f"DB Course {i}", "address": None,
         "center": {"lat": 40.75, "lng": -73.45}, "source": "local"}
        for i in range(60)
    ]

    async def fake_db(*args, **kwargs):
        return db_rows

    monkeypatch.setattr(course_search, "_db_courses_in_bounds", fake_db)

    async def fake_search_golf_courses(**kwargs):
        return []

    monkeypatch.setattr(course_search, "search_golf_courses", fake_search_golf_courses)

    result = await course_search.in_bounds_courses(
        swLat=SW_LAT, swLng=SW_LNG, neLat=NE_LAT, neLng=NE_LNG,
    )
    assert len(result["courses"]) == 40


# ─────────────────────────────────────────────────────────────────────────────
# T9 — zoomIn
# ─────────────────────────────────────────────────────────────────────────────

async def test_zoom_in_skips_every_leg(monkeypatch):
    monkeypatch.setattr(course_search, "_db_courses_in_bounds", _never_called("_db_courses_in_bounds"))
    monkeypatch.setattr(course_search, "search_golf_courses", _never_called("search_golf_courses"))

    result = await course_search.in_bounds_courses(
        swLat=40.0, swLng=-74.0, neLat=41.0, neLng=-73.0,
    )
    assert result == {"courses": [], "degraded": False, "zoomIn": True}


# ─────────────────────────────────────────────────────────────────────────────
# T10 — fanout cap
# ─────────────────────────────────────────────────────────────────────────────

async def test_fanout_cap_calls_only_closest_four_cold_cells(monkeypatch):
    # A larger bbox (~0.2° x 0.15°, well under the zoomIn threshold) that
    # covers well more than 4 cells.
    sw_lat, sw_lng, ne_lat, ne_lng = 40.60, -73.60, 40.80, -73.45
    all_cells = course_search._cells_for_bbox(sw_lat, sw_lng, ne_lat, ne_lng)
    assert len(all_cells) > course_search.IN_BOUNDS_MAX_COLD_CELLS

    calls = []

    async def fake_search_golf_courses(**kwargs):
        calls.append((kwargs["lat"], kwargs["lng"]))
        return []

    monkeypatch.setattr(course_search, "search_golf_courses", fake_search_golf_courses)

    result = await course_search.in_bounds_courses(
        swLat=sw_lat, swLng=sw_lng, neLat=ne_lat, neLng=ne_lng,
    )

    assert len(calls) == course_search.IN_BOUNDS_MAX_COLD_CELLS
    assert result["degraded"] is False

    expected_cells = all_cells[: course_search.IN_BOUNDS_MAX_COLD_CELLS]
    expected_centers = {
        ((ilat + 0.5) * course_search.IN_BOUNDS_CELL_DEG, (ilng + 0.5) * course_search.IN_BOUNDS_CELL_DEG)
        for ilat, ilng in expected_cells
    }
    assert set(calls) == expected_centers


# ─────────────────────────────────────────────────────────────────────────────
# T11 — dedupe across DB + OSM
# ─────────────────────────────────────────────────────────────────────────────

async def test_dedupe_prefers_db_row_on_name_tie(monkeypatch):
    async def fake_db(*args, **kwargs):
        return [{"id": "db-bethpage", "name": "Bethpage Black", "address": None,
                  "center": {"lat": 40.75, "lng": -73.45}, "source": "local"}]

    monkeypatch.setattr(course_search, "_db_courses_in_bounds", fake_db)

    cache = course_search._in_bounds_cache
    warm_hit = {"id": "osm-bethpage", "name": "  bethpage black ", "source": "osm",
                "center": {"lat": 40.75, "lng": -73.45}}
    for ilat, ilng in course_search._cells_for_bbox(SW_LAT, SW_LNG, NE_LAT, NE_LNG):
        cache.data[course_search._in_bounds_cell_key(ilat, ilng)] = [warm_hit]

    monkeypatch.setattr(course_search, "search_golf_courses", _never_called("search_golf_courses"))

    result = await course_search.in_bounds_courses(
        swLat=SW_LAT, swLng=SW_LNG, neLat=NE_LAT, neLng=NE_LNG,
    )

    bethpage_pins = [c for c in result["courses"] if "bethpage" in (c["name"] or "").lower()]
    assert len(bethpage_pins) == 1
    assert bethpage_pins[0]["source"] == "local"
    assert bethpage_pins[0]["id"] == "db-bethpage"
