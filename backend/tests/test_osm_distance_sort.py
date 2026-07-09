"""Tests for sorting OSM course results by distance before truncation.

Regression coverage for the bug where ``search_golf_courses`` /
``search_osm_with_geometry`` truncated Overpass's arbitrary element order
before sorting by distance, silently dropping the closest course whenever it
happened to land past the cap in Overpass's response (e.g. "18 Mile Creek
Golf Course" near Hamburg, NY — the S1 foreUP reference course).

All tests are pure: no network calls, no database. ``app.services.osm.
_post_with_retry`` is monkeypatched with an ``AsyncMock`` returning a fixture
Overpass JSON payload, following the pure/no-network style of
``test_osm_fetch_hardening.py``.
"""
from __future__ import annotations

import math
from unittest.mock import AsyncMock

import pytest

from app.services.osm import _sort_by_distance, search_golf_courses, search_osm_with_geometry

# Origin roughly matching Hamburg, NY (18 Mile Creek Golf Course's real
# neighborhood) — arbitrary but stable for distance-ordering assertions.
_ORIGIN_LAT = 42.7159
_ORIGIN_LNG = -78.8292


def _way_element(id_: int, name: str, lat: float, lng: float) -> dict:
    """A minimal Overpass `way` element shaped like search_golf_courses expects."""
    return {
        "type": "way",
        "id": id_,
        "tags": {"leisure": "golf_course", "name": name},
        "center": {"lat": lat, "lon": lng},
    }


def _offset(lat: float, lng: float, *, meters: float, bearing_deg: float = 0.0) -> tuple[float, float]:
    """Displace (lat, lng) by *meters* along *bearing_deg* (0 = north)."""
    r = 6371000.0
    brg = math.radians(bearing_deg)
    lat1, lng1 = math.radians(lat), math.radians(lng)
    lat2 = math.asin(
        math.sin(lat1) * math.cos(meters / r)
        + math.cos(lat1) * math.sin(meters / r) * math.cos(brg)
    )
    lng2 = lng1 + math.atan2(
        math.sin(brg) * math.sin(meters / r) * math.cos(lat1),
        math.cos(meters / r) - math.sin(lat1) * math.sin(lat2),
    )
    return math.degrees(lat2), math.degrees(lng2)


def _way_geometry_element(id_: int, name: str, lat: float, lng: float) -> dict:
    """A minimal Overpass `way` element with a closed 4-point ring, for the geometry search."""
    p0 = _offset(lat, lng, meters=50, bearing_deg=0)
    p1 = _offset(lat, lng, meters=50, bearing_deg=90)
    p2 = _offset(lat, lng, meters=50, bearing_deg=180)
    p3 = _offset(lat, lng, meters=50, bearing_deg=270)
    geom = [
        {"lat": p0[0], "lon": p0[1]},
        {"lat": p1[0], "lon": p1[1]},
        {"lat": p2[0], "lon": p2[1]},
        {"lat": p3[0], "lon": p3[1]},
    ]
    return {
        "type": "way",
        "id": id_,
        "tags": {"leisure": "golf_course", "name": name},
        "center": {"lat": lat, "lon": lng},
        "geometry": geom,
    }


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


# ── search_golf_courses: the regression ────────────────────────────────────────

class TestSearchGolfCoursesDistanceSort:
    """The nearest course must survive the 15-cap regardless of Overpass order."""

    @pytest.mark.asyncio
    async def test_nearest_course_survives_cap_when_last_in_elements(self, monkeypatch):
        # 16 farther courses first, the nearest ("18 Mile Creek"-style, ~1mi
        # away) placed LAST — this is exactly the shape that dropped it before
        # the fix (results[:15] took the first 15 arbitrary elements).
        far_elements = [
            _way_element(i, f"Far Course {i}", *_offset(_ORIGIN_LAT, _ORIGIN_LNG, meters=8000 + i * 100))
            for i in range(16)
        ]
        nearest_lat, nearest_lng = _offset(_ORIGIN_LAT, _ORIGIN_LNG, meters=1600)  # ~1 mi
        nearest = _way_element(999, "18 Mile Creek Golf Course", nearest_lat, nearest_lng)
        elements = far_elements + [nearest]

        mock_post = AsyncMock(return_value={"elements": elements})
        monkeypatch.setattr("app.services.osm._post_with_retry", mock_post)

        result = await search_golf_courses(lat=_ORIGIN_LAT, lng=_ORIGIN_LNG, radius_m=24140)

        assert len(result) == 15
        names = [r["name"] for r in result]
        assert "18 Mile Creek Golf Course" in names, "nearest course was dropped by the cap"
        assert names[0] == "18 Mile Creek Golf Course", "nearest course should sort first"

        # Ascending by haversine distance from the origin.
        dists = [
            _haversine_m(_ORIGIN_LAT, _ORIGIN_LNG, r["center"]["lat"], r["center"]["lng"])
            for r in result
        ]
        assert dists == sorted(dists)

    @pytest.mark.asyncio
    async def test_name_only_preserves_element_order(self, monkeypatch):
        # No lat/lng — sort is skipped entirely; order must be byte-identical
        # to Overpass's element order.
        elements = [
            _way_element(1, "Pebble Beach Golf Links", 36.5725, -121.9486),
            _way_element(2, "Zzz Golf Club", 40.0, -100.0),
            _way_element(3, "Aaa Country Club", 10.0, 10.0),
        ]
        mock_post = AsyncMock(return_value={"elements": elements})
        monkeypatch.setattr("app.services.osm._post_with_retry", mock_post)

        result = await search_golf_courses(name="pebble")

        names = [r["name"] for r in result]
        assert names == ["Pebble Beach Golf Links", "Zzz Golf Club", "Aaa Country Club"]

    @pytest.mark.asyncio
    async def test_tie_distance_breaks_by_name(self, monkeypatch):
        # Two courses at identical distance from the origin (same bearing
        # offset in opposite quadrants isn't equal distance, so place them at
        # literally the same center) — sorted by name.
        lat, lng = _offset(_ORIGIN_LAT, _ORIGIN_LNG, meters=5000)
        elements = [
            _way_element(1, "Zulu Golf Club", lat, lng),
            _way_element(2, "Alpha Golf Club", lat, lng),
        ]
        mock_post = AsyncMock(return_value={"elements": elements})
        monkeypatch.setattr("app.services.osm._post_with_retry", mock_post)

        result = await search_golf_courses(lat=_ORIGIN_LAT, lng=_ORIGIN_LNG, radius_m=10000)

        assert [r["name"] for r in result] == ["Alpha Golf Club", "Zulu Golf Club"]


# ── search_osm_with_geometry: the regression ───────────────────────────────────

class TestSearchOsmWithGeometryDistanceSort:
    """Same truncate-before-sort bug, bigger radius (50km default) — higher stakes."""

    @pytest.mark.asyncio
    async def test_nearest_survives_25_cap_when_last_in_elements(self, monkeypatch):
        far_elements = [
            _way_geometry_element(
                i, f"Far Course {i}", *_offset(_ORIGIN_LAT, _ORIGIN_LNG, meters=20000 + i * 200)
            )
            for i in range(26)
        ]
        nearest_lat, nearest_lng = _offset(_ORIGIN_LAT, _ORIGIN_LNG, meters=1600)
        nearest = _way_geometry_element(999, "18 Mile Creek Golf Course", nearest_lat, nearest_lng)
        elements = far_elements + [nearest]

        mock_post = AsyncMock(return_value={"elements": elements})
        monkeypatch.setattr("app.services.osm._post_with_retry", mock_post)

        result = await search_osm_with_geometry(lat=_ORIGIN_LAT, lng=_ORIGIN_LNG, radius_m=50000)

        assert len(result) == 25
        names = [r["name"] for r in result]
        assert "18 Mile Creek Golf Course" in names
        assert names[0] == "18 Mile Creek Golf Course"

        dists = [
            _haversine_m(_ORIGIN_LAT, _ORIGIN_LNG, r["center"]["lat"], r["center"]["lng"])
            for r in result
        ]
        assert dists == sorted(dists)


# ── _sort_by_distance: direct unit tests (pure helper) ─────────────────────────

class TestSortByDistanceHelper:
    def test_ascending_by_distance(self):
        results = [
            {"name": "Far", "center": {"lat": 42.8, "lng": -78.9}},
            {"name": "Near", "center": {"lat": 42.716, "lng": -78.830}},
        ]
        out = _sort_by_distance(results, _ORIGIN_LAT, _ORIGIN_LNG)
        assert [r["name"] for r in out] == ["Near", "Far"]

    def test_none_center_coords_sort_last(self):
        results = [
            {"name": "No lat", "center": {"lat": None, "lng": -78.9}},
            {"name": "Has coords", "center": {"lat": 42.8, "lng": -78.9}},
            {"name": "No lng", "center": {"lat": 42.8, "lng": None}},
            {"name": "Missing center", "center": {}},
        ]
        out = _sort_by_distance(results, _ORIGIN_LAT, _ORIGIN_LNG)
        assert out[0]["name"] == "Has coords"
        # The three with no usable coords sort last, in name order (tie-break).
        assert {r["name"] for r in out[1:]} == {"No lat", "No lng", "Missing center"}

    def test_empty_list(self):
        assert _sort_by_distance([], _ORIGIN_LAT, _ORIGIN_LNG) == []
