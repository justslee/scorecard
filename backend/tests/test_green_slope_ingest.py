"""Unit tests for the green-slope ingest pipeline.

Covers:
- ``_green_slope_grid_points``: returns 9 points, centre matches input.
- ``_compute_slope_from_grid``: known grids → expected direction/grade; edge cases.
- ``sample_course_elevations``: mocked ``fetch_3dep_samples`` → green_slope populated
  in the profile dict.
- ``embed_elevation_in_green_features``: ``green_slope`` embedded into green properties
  when present; absent when None.

No network, no database.  ``fetch_3dep_samples`` is patched at the module level so
tests never touch the USGS API.
"""

from __future__ import annotations

import asyncio
import os
import sys
from typing import Optional
from unittest.mock import AsyncMock, MagicMock, patch

# ── DB stub ───────────────────────────────────────────────────────────────────
# Must run before any import that transitively pulls in app.db.engine.
if not os.getenv("DATABASE_URL"):
    for _m in ("app.db.engine", "app.db.models", "app.db"):
        sys.modules.setdefault(_m, MagicMock())
# ─────────────────────────────────────────────────────────────────────────────

from app.services.elevation import (  # noqa: E402
    _compute_slope_from_grid,
    _green_slope_grid_points,
    compute_hole_elevation_profile,
    sample_course_elevations,
)
from app.services.osm_ingest import (  # noqa: E402
    assemble_osm_course,
    embed_elevation_in_green_features,
)


# ══════════════════════════════════════════════════════════════════════════════
# Fixture builders (shared across test classes)
# ══════════════════════════════════════════════════════════════════════════════

def _make_hole(
    ref: str,
    course_name: str,
    start_lon: float,
    start_lat: float,
    end_lon: float,
    end_lat: float,
    *,
    par: int = 4,
    handicap: int = 9,
) -> dict:
    return {
        "type": "Feature",
        "geometry": {
            "type": "LineString",
            "coordinates": [[start_lon, start_lat], [end_lon, end_lat]],
        },
        "properties": {
            "featureType": "hole",
            "osm_id": f"way/h{ref}_{course_name.lower()}",
            "ref": ref,
            "par": par,
            "handicap": handicap,
            "name": f"Hole {ref}",
            "course_name": course_name,
        },
    }


def _make_polygon(
    osm_id: str,
    feature_type: str,
    center_lon: float,
    center_lat: float,
    half: float = 0.0001,
) -> dict:
    lo_lon, hi_lon = center_lon - half, center_lon + half
    lo_lat, hi_lat = center_lat - half, center_lat + half
    ring = [
        [lo_lon, lo_lat], [hi_lon, lo_lat],
        [hi_lon, hi_lat], [lo_lon, hi_lat],
        [lo_lon, lo_lat],
    ]
    return {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [ring]},
        "properties": {"featureType": feature_type, "osm_id": osm_id},
    }


# Two-hole course layout
_BH1 = _make_hole("1", "Black", -73.000, 40.700, -73.000, 40.702, par=4, handicap=7)
_BH2 = _make_hole("2", "Black", -72.990, 40.700, -72.990, 40.702, par=5, handicap=3)
_GREEN_BH1 = _make_polygon("way/green_bh1", "green", -73.000, 40.702)
_GREEN_BH2 = _make_polygon("way/green_bh2", "green", -72.990, 40.702)

_GEOMETRY = {
    "holes":    [_BH1, _BH2],
    "greens":   [_GREEN_BH1, _GREEN_BH2],
    "fairways": [],
    "tees":     [],
    "bunkers":  [],
    "water":    [],
}

# All holes list for sample_course_elevations
_HOLES = [_BH1, _BH2]


# ══════════════════════════════════════════════════════════════════════════════
# _green_slope_grid_points — pure geometry
# ══════════════════════════════════════════════════════════════════════════════

class TestGreenSlopeGridPoints:
    """_green_slope_grid_points returns 9 points in the expected order."""

    def test_returns_nine_points(self):
        pts = _green_slope_grid_points(40.7, -73.0)
        assert len(pts) == 9

    def test_centre_point_matches_input(self):
        """Index 4 (C) should be exactly the input lat/lng."""
        lat, lng = 40.702, -73.000
        pts = _green_slope_grid_points(lat, lng)
        c_lat, c_lng = pts[4]
        assert abs(c_lat - lat) < 1e-9
        assert abs(c_lng - lng) < 1e-9

    def test_north_higher_lat_than_south(self):
        """N row points (indices 0,1,2) should have higher lat than S row (6,7,8)."""
        pts = _green_slope_grid_points(40.702, -73.000)
        north_lats = [pts[i][0] for i in (0, 1, 2)]
        south_lats = [pts[i][0] for i in (6, 7, 8)]
        assert all(n > s for n, s in zip(north_lats, south_lats))

    def test_east_higher_lng_than_west(self):
        """E column (indices 2,5,8) should have higher lng than W column (0,3,6)."""
        pts = _green_slope_grid_points(40.702, -73.000)
        east_lngs  = [pts[i][1] for i in (2, 5, 8)]
        west_lngs  = [pts[i][1] for i in (0, 3, 6)]
        assert all(e > w for e, w in zip(east_lngs, west_lngs))

    def test_custom_radius_scales_offsets(self):
        """Larger radius → larger offsets from centre."""
        pts_small = _green_slope_grid_points(40.702, -73.0, r_yards=10.0)
        pts_large = _green_slope_grid_points(40.702, -73.0, r_yards=20.0)
        # NW point (index 0) should be farther from centre for larger radius
        c_lat, c_lng = 40.702, -73.0
        dist_small = abs(pts_small[0][0] - c_lat) + abs(pts_small[0][1] - c_lng)
        dist_large = abs(pts_large[0][0] - c_lat) + abs(pts_large[0][1] - c_lng)
        assert dist_large > dist_small


# ══════════════════════════════════════════════════════════════════════════════
# _compute_slope_from_grid — pure Sobel math
# ══════════════════════════════════════════════════════════════════════════════

def _flat_grid(elev: float = 100.0) -> list[Optional[float]]:
    """Uniform grid — no slope."""
    return [elev] * 9


def _south_sloping_grid(drop_ft: float = 5.0) -> list[Optional[float]]:
    """Grid where the south row is *drop_ft* lower than the north row.

    North row (indices 0,1,2) at 100+drop; south row (6,7,8) at 100.
    Middle row (3,4,5) at 100+drop/2.

    This should produce a downhill direction toward south (~180°).
    """
    high = 100.0 + drop_ft
    mid  = 100.0 + drop_ft / 2
    low  = 100.0
    return [
        high, high, high,   # NW N NE
        mid,  mid,  mid,    # W  C E
        low,  low,  low,    # SW S SE
    ]


def _east_sloping_grid(drop_ft: float = 5.0) -> list[Optional[float]]:
    """Grid where the east column is *drop_ft* lower than the west column.

    West column (0,3,6) at 100+drop; east column (2,5,8) at 100.

    This should produce a downhill direction toward east (~90°).
    """
    high = 100.0 + drop_ft
    mid  = 100.0 + drop_ft / 2
    low  = 100.0
    return [
        high, mid, low,   # NW N NE
        high, mid, low,   # W  C E
        high, mid, low,   # SW S SE
    ]


class TestComputeSlopeFromGrid:
    """_compute_slope_from_grid pure-math correctness."""

    # ── Flat grid ─────────────────────────────────────────────────────────────

    def test_flat_grid_returns_flat_severity(self):
        result = _compute_slope_from_grid(_flat_grid())
        assert result is not None
        assert result["severity"] == "flat"

    def test_flat_grid_percent_grade_near_zero(self):
        result = _compute_slope_from_grid(_flat_grid())
        assert result["percent_grade"] < 0.01

    def test_flat_grid_direction_is_zero(self):
        result = _compute_slope_from_grid(_flat_grid())
        assert result["direction"] == 0.0

    def test_flat_grid_description(self):
        result = _compute_slope_from_grid(_flat_grid())
        assert result["description"] == "Relatively flat green"

    # ── South-sloping grid ────────────────────────────────────────────────────

    def test_south_sloping_direction_near_180(self):
        """A grid that drops south should give direction ≈ 180°."""
        result = _compute_slope_from_grid(_south_sloping_grid())
        assert result is not None
        # Allow ±45° tolerance (SE–SW sector)
        d = result["direction"]
        assert 135.0 <= d <= 225.0, f"Expected ~180°, got {d}"

    def test_south_sloping_has_nonzero_grade(self):
        result = _compute_slope_from_grid(_south_sloping_grid())
        assert result["percent_grade"] > 0.0

    def test_south_sloping_not_flat(self):
        result = _compute_slope_from_grid(_south_sloping_grid(drop_ft=10.0))
        assert result["severity"] != "flat"

    # ── East-sloping grid ─────────────────────────────────────────────────────

    def test_east_sloping_direction_near_90(self):
        """A grid that drops east should give direction ≈ 90°."""
        result = _compute_slope_from_grid(_east_sloping_grid())
        assert result is not None
        d = result["direction"]
        # Allow ±45° tolerance (NE–SE sector)
        assert 45.0 <= d <= 135.0, f"Expected ~90°, got {d}"

    # ── Severity classification ────────────────────────────────────────────────

    def test_large_drop_severe_severity(self):
        """Large elevation gradient → severe."""
        # A very steep east-sloping grid
        result = _compute_slope_from_grid(_east_sloping_grid(drop_ft=100.0))
        assert result is not None
        assert result["severity"] == "severe"

    def test_tiny_drop(self):
        """Very small elevation drop should be flat or mild, definitely not severe."""
        result = _compute_slope_from_grid(_east_sloping_grid(drop_ft=0.1))
        assert result is not None
        assert result["severity"] in ("flat", "mild")

    # ── None handling ─────────────────────────────────────────────────────────

    def test_fewer_than_5_valid_returns_none(self):
        grid: list[Optional[float]] = [None] * 4 + [100.0] * 5
        # 5 valid — should succeed
        result = _compute_slope_from_grid(grid)
        assert result is not None

    def test_only_4_valid_returns_none(self):
        grid: list[Optional[float]] = [None] * 5 + [100.0] * 4
        result = _compute_slope_from_grid(grid)
        assert result is None

    def test_all_none_returns_none(self):
        result = _compute_slope_from_grid([None] * 9)
        assert result is None

    # ── Output keys ──────────────────────────────────────────────────────────

    def test_output_keys_present(self):
        result = _compute_slope_from_grid(_south_sloping_grid())
        assert result is not None
        for key in ("direction", "severity", "percent_grade", "description",
                    "center_elevation_ft"):
            assert key in result, f"Missing key {key!r}"

    def test_center_elevation_ft_matches_grid_index_4(self):
        grid = _flat_grid(elev=123.4)
        result = _compute_slope_from_grid(grid)
        assert result is not None
        assert result["center_elevation_ft"] == 123.4


# ══════════════════════════════════════════════════════════════════════════════
# sample_course_elevations — mocked fetch_3dep_samples
# ══════════════════════════════════════════════════════════════════════════════

def _run(coro):
    """Run a coroutine to completion via a fresh event loop.

    ``asyncio.get_event_loop()`` is fragile from sync test code: once ANY
    earlier test in the process has called ``asyncio.run()`` (which always
    unsets the current-thread loop on exit, by design), a bare
    ``get_event_loop()`` call raises ``RuntimeError: There is no current
    event loop`` instead of vivifying a new one — order-dependent and not
    reproducible in isolation. ``asyncio.run()`` owns its own loop lifecycle
    end-to-end, so it's safe regardless of what ran before it. Matches the
    idiom already used for this same function in
    ``test_hole_elevation_ingest.py``.
    """
    return asyncio.run(coro)


class TestSampleCourseElevationsGreenSlope:
    """sample_course_elevations populates green_slope when fetch_3dep_samples returns data."""

    def _make_mock_3dep(
        self,
        tee_green_elevs: list[Optional[float]],
        slope_elevs: list[Optional[float]],
    ):
        """Return a side-effect list so the first call returns tee/green, the second slope."""
        calls = [tee_green_elevs, slope_elevs]
        idx = [0]

        async def mock_fetch(points):
            result = calls[idx[0]]
            idx[0] += 1
            return result

        return mock_fetch

    def test_green_slope_populated_when_3dep_returns_grid(self):
        """green_slope is a dict (not None) when the Sobel grid batch returns data."""
        # 2 holes → 4 points for tee/green batch
        tee_green = [95.0, 110.0,  # H1 tee, green
                     105.0, 90.0]   # H2 tee, green

        # 2 holes × 9 points = 18 slope-grid points (all valid)
        slope_grid = _south_sloping_grid(drop_ft=5.0) + _east_sloping_grid(drop_ft=5.0)

        mock = self._make_mock_3dep(tee_green, slope_grid)

        with patch(
            "app.services.elevation.fetch_3dep_samples",
            side_effect=mock,
        ):
            result = _run(sample_course_elevations(_HOLES, "Black"))

        assert 1 in result, "H1 should be in result"
        assert 2 in result, "H2 should be in result"
        assert result[1]["green_slope"] is not None, "H1 green_slope should be populated"
        assert result[2]["green_slope"] is not None, "H2 green_slope should be populated"

    def test_green_slope_has_expected_keys(self):
        tee_green = [95.0, 110.0, 105.0, 90.0]
        slope_grid = _flat_grid() + _flat_grid()

        mock = self._make_mock_3dep(tee_green, slope_grid)

        with patch(
            "app.services.elevation.fetch_3dep_samples",
            side_effect=mock,
        ):
            result = _run(sample_course_elevations(_HOLES, "Black"))

        gs = result[1]["green_slope"]
        assert gs is not None
        for key in ("direction", "severity", "percent_grade", "description"):
            assert key in gs, f"Missing key {key!r} in green_slope"

    def test_green_slope_none_when_slope_batch_returns_all_none(self):
        """If USGS returns None for all slope-grid points, green_slope is None."""
        tee_green = [95.0, 110.0, 105.0, 90.0]
        slope_grid = [None] * 18  # all missing → < 5 valid per hole

        mock = self._make_mock_3dep(tee_green, slope_grid)

        with patch(
            "app.services.elevation.fetch_3dep_samples",
            side_effect=mock,
        ):
            result = _run(sample_course_elevations(_HOLES, "Black"))

        assert result[1]["green_slope"] is None
        assert result[2]["green_slope"] is None

    def test_tee_green_none_skips_hole(self):
        """Holes where tee or green elevation is None are excluded from result."""
        # H1 tee missing
        tee_green = [None, 110.0, 105.0, 90.0]
        slope_grid = _flat_grid() + _flat_grid()

        mock = self._make_mock_3dep(tee_green, slope_grid)

        with patch(
            "app.services.elevation.fetch_3dep_samples",
            side_effect=mock,
        ):
            result = _run(sample_course_elevations(_HOLES, "Black"))

        assert 1 not in result, "H1 should be absent (tee elev None)"
        assert 2 in result, "H2 should still be present"

    def test_profile_includes_plays_like_yards(self):
        """Profiles from sample_course_elevations must include plays_like_yards."""
        tee_green = [95.0, 110.0, 105.0, 90.0]
        slope_grid = _flat_grid() + _flat_grid()

        mock = self._make_mock_3dep(tee_green, slope_grid)

        with patch(
            "app.services.elevation.fetch_3dep_samples",
            side_effect=mock,
        ):
            result = _run(sample_course_elevations(_HOLES, "Black"))

        assert "plays_like_yards" in result[1]
        assert result[1]["plays_like_yards"] == round(15.0 / 3.0, 1)  # +15 ft uphill

    def test_south_sloping_direction_near_180(self):
        """A south-draining green grid should produce direction ≈ 180°."""
        tee_green = [95.0, 110.0]
        slope_grid = _south_sloping_grid(drop_ft=5.0)

        # Only H1 — use single-hole fixture
        h1_only = [_BH1]
        mock = self._make_mock_3dep(tee_green, slope_grid)

        with patch(
            "app.services.elevation.fetch_3dep_samples",
            side_effect=mock,
        ):
            result = _run(sample_course_elevations(h1_only, "Black"))

        gs = result[1]["green_slope"]
        assert gs is not None
        d = gs["direction"]
        assert 135.0 <= d <= 225.0, f"Expected ~180°, got {d}"

    def test_empty_holes_returns_empty(self):
        with patch(
            "app.services.elevation.fetch_3dep_samples",
            new_callable=AsyncMock,
            return_value=[],
        ):
            result = _run(sample_course_elevations([], "Black"))
        assert result == {}

    def test_wrong_course_name_returns_empty(self):
        """Holes belonging to 'Black' don't appear when 'Red' is requested."""
        tee_green = [95.0, 110.0, 105.0, 90.0]
        slope_grid = _flat_grid() + _flat_grid()
        mock = self._make_mock_3dep(tee_green, slope_grid)

        with patch(
            "app.services.elevation.fetch_3dep_samples",
            side_effect=mock,
        ):
            result = _run(sample_course_elevations(_HOLES, "Red"))

        assert result == {}


# ══════════════════════════════════════════════════════════════════════════════
# embed_elevation_in_green_features — green_slope embedded into properties
# ══════════════════════════════════════════════════════════════════════════════

_SLOPE_DICT = {
    "direction":     180.0,
    "severity":      "mild",
    "percent_grade": 1.8,
    "description":   "Green slopes mildly toward the south",
    "center_elevation_ft": 110.0,
}

_ELEV_WITH_SLOPE = compute_hole_elevation_profile(95.0, 110.0, green_slope=_SLOPE_DICT)
_ELEV_NO_SLOPE   = compute_hole_elevation_profile(95.0, 110.0, green_slope=None)


def _assembled(elev_map: dict | None = None) -> dict:
    return assemble_osm_course(
        geometry=_GEOMETRY,
        course_id="test-id",
        course_name="Bethpage Black",
        target_course_name="Black",
        hole_elevations=elev_map,
    )


def _green_props(course_data: dict, hole_number: int) -> Optional[dict]:
    for hole in course_data["holes"]:
        if hole["number"] != hole_number:
            continue
        for f in hole["features"]["features"]:
            if f["properties"].get("featureType") == "green":
                return f["properties"]
    return None


class TestEmbedGreenSlope:
    """embed_elevation_in_green_features stores green_slope in green feature props."""

    def test_green_slope_embedded_when_present(self):
        course = _assembled({1: _ELEV_WITH_SLOPE})
        embed_elevation_in_green_features(course)
        props = _green_props(course, 1)
        assert props is not None
        assert "green_slope" in props
        assert props["green_slope"] == _SLOPE_DICT

    def test_green_slope_absent_when_none(self):
        """When green_slope is None in the profile, no 'green_slope' key in props."""
        course = _assembled({1: _ELEV_NO_SLOPE})
        embed_elevation_in_green_features(course)
        props = _green_props(course, 1)
        assert props is not None
        # plays_like_yards IS there (elevation is present)
        assert "plays_like_yards" in props
        # but green_slope is NOT
        assert "green_slope" not in props

    def test_standard_elevation_fields_still_present_with_slope(self):
        """Other elevation fields must not be displaced by green_slope."""
        course = _assembled({1: _ELEV_WITH_SLOPE})
        embed_elevation_in_green_features(course)
        props = _green_props(course, 1)
        assert props is not None
        for field in ("tee_elevation_ft", "green_elevation_ft", "delta_ft",
                      "plays_like_yards"):
            assert field in props, f"Missing {field!r}"

    def test_non_green_features_not_modified(self):
        """Fairway / bunker / etc. must not receive green_slope."""
        course = _assembled({1: _ELEV_WITH_SLOPE})
        embed_elevation_in_green_features(course)
        for hole in course["holes"]:
            if hole["number"] != 1:
                continue
            for feat in hole["features"]["features"]:
                ft = feat["properties"].get("featureType", "")
                if ft != "green":
                    assert "green_slope" not in feat["properties"], (
                        f"Non-green feature ({ft}) received green_slope"
                    )

    def test_hole_without_elevation_unchanged(self):
        """H2 has no elevation → its green props must not have green_slope."""
        course = _assembled({1: _ELEV_WITH_SLOPE})  # only H1
        embed_elevation_in_green_features(course)
        props2 = _green_props(course, 2)
        if props2 is not None:
            assert "green_slope" not in props2
            assert "plays_like_yards" not in props2

    def test_green_slope_severity_value_round_trips(self):
        course = _assembled({1: _ELEV_WITH_SLOPE})
        embed_elevation_in_green_features(course)
        props = _green_props(course, 1)
        assert props["green_slope"]["severity"] == "mild"

    def test_green_slope_direction_value_round_trips(self):
        course = _assembled({1: _ELEV_WITH_SLOPE})
        embed_elevation_in_green_features(course)
        props = _green_props(course, 1)
        assert props["green_slope"]["direction"] == 180.0

    def test_green_slope_percent_grade_value_round_trips(self):
        course = _assembled({1: _ELEV_WITH_SLOPE})
        embed_elevation_in_green_features(course)
        props = _green_props(course, 1)
        assert props["green_slope"]["percent_grade"] == 1.8
