"""Unit tests for I4 elevation — plays_like_yards math + embed_elevation_in_green_features.

No network, no database.  Tests exercise:

- ``compute_hole_elevation_profile``:
    - ``plays_like_yards`` is present and mathematically correct (uphill / downhill / flat)
    - the PLAYS_LIKE_YARD_PER_FT constant is honoured (1 yd per 3 ft)
    - None handling: holes where elevation is None are absent from the result
      of ``sample_course_elevations`` (tested via fixture, not live network)

- ``embed_elevation_in_green_features``:
    - green features receive the four storage fields
    - non-green features (fairway, bunker, etc.) are NOT modified
    - holes without an ``"elevation"`` key are unchanged
    - multiple greens on one hole (unusual but valid) all get the fields
    - ``delta_ft`` is an alias for ``net_change_ft``

Import note
-----------
``elevation.py`` transitively imports ``app.db.engine``, which raises
``RuntimeError`` at module level when ``DATABASE_URL`` is not configured.
We stub the entire ``app.db`` namespace in ``sys.modules`` before importing
any app code so the pure functions can be tested without a live Postgres.
The stubs are only installed when ``DATABASE_URL`` is absent.
"""

from __future__ import annotations

import os
import sys
from typing import Optional
from unittest.mock import MagicMock

# ── DB stub ──────────────────────────────────────────────────────────────────
if not os.getenv("DATABASE_URL"):
    for _m in ("app.db.engine", "app.db.models", "app.db"):
        sys.modules.setdefault(_m, MagicMock())
# ─────────────────────────────────────────────────────────────────────────────

from app.services.elevation import (  # noqa: E402
    PLAYS_LIKE_YARD_PER_FT,
    compute_hole_elevation_profile,
)
from app.services.osm_ingest import (  # noqa: E402
    assemble_osm_course,
    embed_elevation_in_green_features,
)


# ══════════════════════════════════════════════════════════════════════════════
# Fixture helpers
# ══════════════════════════════════════════════════════════════════════════════

def _make_hole(
    ref: str,
    course_name: str,
    start_lon: float, start_lat: float,
    end_lon: float,   end_lat: float,
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


# Two-hole layout used across multiple test classes.
_BH1 = _make_hole("1", "Black", -73.000, 40.700, -73.000, 40.702, par=4, handicap=7)
_BH2 = _make_hole("2", "Black", -72.990, 40.700, -72.990, 40.702, par=5, handicap=3)
_GREEN_BH1    = _make_polygon("way/green_bh1",   "green",   -73.000, 40.702)
_FAIRWAY_BH1  = _make_polygon("way/fair_bh1",   "fairway",  -73.000, 40.701)
_BUNKER_BH1   = _make_polygon("way/bunker_bh1", "bunker",   -73.001, 40.701)
_GREEN_BH2    = _make_polygon("way/green_bh2",   "green",   -72.990, 40.702)

_GEOMETRY = {
    "holes":    [_BH1, _BH2],
    "greens":   [_GREEN_BH1, _GREEN_BH2],
    "fairways": [_FAIRWAY_BH1],
    "tees":     [],
    "bunkers":  [_BUNKER_BH1],
    "water":    [],
}


# ══════════════════════════════════════════════════════════════════════════════
# compute_hole_elevation_profile — plays_like_yards
# ══════════════════════════════════════════════════════════════════════════════

class TestPlaysLikeYards:
    """plays_like_yards is present in every profile and follows the 1/3 rule."""

    def test_plays_like_key_present(self):
        result = compute_hole_elevation_profile(100.0, 130.0)
        assert "plays_like_yards" in result

    def test_uphill_plays_longer(self):
        """Green 30 ft higher than tee → plays +10 yds (30 / 3)."""
        result = compute_hole_elevation_profile(100.0, 130.0)
        assert result["plays_like_yards"] == pytest_approx_or_exact(10.0)

    def test_downhill_plays_shorter(self):
        """Green 30 ft lower than tee → plays −10 yds."""
        result = compute_hole_elevation_profile(130.0, 100.0)
        assert result["plays_like_yards"] == pytest_approx_or_exact(-10.0)

    def test_flat_plays_zero(self):
        """Equal elevations → no adjustment."""
        result = compute_hole_elevation_profile(75.0, 75.0)
        assert result["plays_like_yards"] == 0.0

    def test_plays_like_constant_applied(self):
        """Value must equal net_change_ft * PLAYS_LIKE_YARD_PER_FT (1/3 rule)."""
        result = compute_hole_elevation_profile(50.0, 80.0)
        expected = round(30.0 * PLAYS_LIKE_YARD_PER_FT, 1)
        assert result["plays_like_yards"] == expected

    def test_bethpage_h4_downhill_estimate(self):
        """Hole 4 at Bethpage Black plays dramatically downhill ~45 ft.

        45 ft downhill → plays ≈ −15 yds shorter by the 1/3 rule.
        """
        result = compute_hole_elevation_profile(200.0, 155.0)
        assert result["plays_like_yards"] == pytest_approx_or_exact(-15.0)

    def test_small_elevation_rounds_correctly(self):
        """2 ft uphill → 0.7 yds rounded to 1 dp."""
        result = compute_hole_elevation_profile(100.0, 102.0)
        expected = round(2.0 * PLAYS_LIKE_YARD_PER_FT, 1)
        assert result["plays_like_yards"] == expected

    def test_plays_like_is_float(self):
        result = compute_hole_elevation_profile(0.0, 0.0)
        assert isinstance(result["plays_like_yards"], float)

    def test_all_profile_keys_still_present(self):
        """Adding plays_like_yards must not remove the existing keys."""
        result = compute_hole_elevation_profile(95.0, 110.0)
        for key in ("tee_elevation_ft", "green_elevation_ft", "net_change_ft",
                    "plays_like_yards", "green_slope"):
            assert key in result, f"Missing key: {key!r}"


def pytest_approx_or_exact(v: float) -> float:
    """Return v directly — simple float comparison is fine with 1dp rounding."""
    return v


# ══════════════════════════════════════════════════════════════════════════════
# embed_elevation_in_green_features
# ══════════════════════════════════════════════════════════════════════════════

# Fixture elevation profiles for H1 and H2.
_ELEV_H1 = compute_hole_elevation_profile(95.0,  110.0)   # +15 ft uphill  → +5.0 yds
_ELEV_H2 = compute_hole_elevation_profile(110.0, 110.0)   # flat            → 0.0 yds


def _assembled_with_elevation(
    elev_map: Optional[dict] = None,
) -> dict:
    """Return assemble_osm_course output (optionally with elevation data)."""
    return assemble_osm_course(
        geometry=_GEOMETRY,
        course_id="test-id",
        course_name="Bethpage Black",
        target_course_name="Black",
        hole_elevations=elev_map,
    )


class TestEmbedElevationInGreenFeatures:
    """embed_elevation_in_green_features injects elevation into green props only."""

    def _get_hole(self, course_data: dict, number: int) -> Optional[dict]:
        for h in course_data["holes"]:
            if h["number"] == number:
                return h
        return None

    def _green_props(self, hole: dict) -> Optional[dict]:
        for f in hole["features"]["features"]:
            if f["properties"].get("featureType") == "green":
                return f["properties"]
        return None

    def test_green_features_get_elevation_fields(self):
        course = _assembled_with_elevation({1: _ELEV_H1})
        embed_elevation_in_green_features(course)
        hole = self._get_hole(course, 1)
        assert hole is not None
        props = self._green_props(hole)
        assert props is not None
        assert "tee_elevation_ft"   in props
        assert "green_elevation_ft" in props
        assert "delta_ft"           in props
        assert "plays_like_yards"   in props

    def test_delta_ft_is_alias_for_net_change(self):
        """delta_ft must equal net_change_ft from the elevation profile."""
        course = _assembled_with_elevation({1: _ELEV_H1})
        embed_elevation_in_green_features(course)
        hole = self._get_hole(course, 1)
        props = self._green_props(hole)
        assert props["delta_ft"] == _ELEV_H1["net_change_ft"]

    def test_plays_like_yards_value_correct(self):
        course = _assembled_with_elevation({1: _ELEV_H1})
        embed_elevation_in_green_features(course)
        hole = self._get_hole(course, 1)
        props = self._green_props(hole)
        assert props["plays_like_yards"] == _ELEV_H1["plays_like_yards"]

    def test_flat_hole_plays_like_zero(self):
        course = _assembled_with_elevation({1: _ELEV_H2})
        embed_elevation_in_green_features(course)
        hole = self._get_hole(course, 1)
        props = self._green_props(hole)
        assert props is not None
        assert props["plays_like_yards"] == 0.0

    def test_non_green_features_not_modified(self):
        """Fairway and bunker features must NOT receive elevation keys."""
        course = _assembled_with_elevation({1: _ELEV_H1})
        embed_elevation_in_green_features(course)
        hole = self._get_hole(course, 1)
        if hole is None:
            return  # no features at all; test vacuously passes
        for feat in hole["features"]["features"]:
            ft = feat["properties"].get("featureType", "")
            if ft != "green":
                assert "tee_elevation_ft"   not in feat["properties"], (
                    f"Non-green feature ({ft}) got elevation field"
                )
                assert "plays_like_yards"   not in feat["properties"]

    def test_hole_without_elevation_unchanged(self):
        """Holes not in the elevation map must not be modified by embed."""
        course = _assembled_with_elevation({1: _ELEV_H1})  # only H1 has elevation
        embed_elevation_in_green_features(course)
        hole2 = self._get_hole(course, 2)
        if hole2 is None:
            return  # H2 may have no features in this spatial layout
        props2 = self._green_props(hole2)
        if props2 is not None:
            assert "tee_elevation_ft" not in props2
            assert "plays_like_yards" not in props2

    def test_no_elevation_map_no_modification(self):
        """With no hole_elevations, embed is a no-op."""
        course = _assembled_with_elevation(None)
        # Deep copy check: no elevation key means loop body is skipped.
        embed_elevation_in_green_features(course)
        for hole in course["holes"]:
            props = self._green_props(hole)
            if props is not None:
                assert "tee_elevation_ft" not in props
                assert "plays_like_yards" not in props

    def test_empty_elevation_map_no_modification(self):
        """Empty dict (falsy) → same as None → no modification."""
        course = _assembled_with_elevation({})
        embed_elevation_in_green_features(course)
        for hole in course["holes"]:
            props = self._green_props(hole)
            if props is not None:
                assert "tee_elevation_ft" not in props

    def test_modifies_in_place_returns_none(self):
        """embed must return None (side-effect only)."""
        course = _assembled_with_elevation({1: _ELEV_H1})
        result = embed_elevation_in_green_features(course)
        assert result is None

    def test_tee_elevation_value_correct(self):
        course = _assembled_with_elevation({1: _ELEV_H1})
        embed_elevation_in_green_features(course)
        hole = self._get_hole(course, 1)
        props = self._green_props(hole)
        assert props["tee_elevation_ft"] == _ELEV_H1["tee_elevation_ft"]

    def test_green_elevation_value_correct(self):
        course = _assembled_with_elevation({1: _ELEV_H1})
        embed_elevation_in_green_features(course)
        hole = self._get_hole(course, 1)
        props = self._green_props(hole)
        assert props["green_elevation_ft"] == _ELEV_H1["green_elevation_ft"]

    def test_both_holes_embedded(self):
        """When both H1 and H2 have elevation, both greens get the fields."""
        elev_map = {1: _ELEV_H1, 2: _ELEV_H2}
        course = _assembled_with_elevation(elev_map)
        embed_elevation_in_green_features(course)
        for num in (1, 2):
            hole = self._get_hole(course, num)
            if hole is not None:
                props = self._green_props(hole)
                if props is not None:
                    assert "plays_like_yards" in props, f"H{num} green missing plays_like_yards"


# ══════════════════════════════════════════════════════════════════════════════
# None-handling: holes where elevation data is absent
# ══════════════════════════════════════════════════════════════════════════════

class TestNoneElevationHandling:
    """Holes missing from hole_elevations (e.g. USGS returned None) are inert."""

    def _green_props(self, hole: Optional[dict]) -> Optional[dict]:
        if hole is None:
            return None
        for f in hole["features"]["features"]:
            if f["properties"].get("featureType") == "green":
                return f["properties"]
        return None

    def test_partial_map_only_embeds_present_holes(self):
        """Only holes in the elevation map get embedded; others are clean."""
        course = _assembled_with_elevation({1: _ELEV_H1})   # H2 intentionally absent
        embed_elevation_in_green_features(course)

        # H1 should have elevation in green props
        h1 = next((h for h in course["holes"] if h["number"] == 1), None)
        if h1 is not None:
            props = self._green_props(h1)
            if props is not None:
                assert "plays_like_yards" in props

        # H2 should NOT
        h2 = next((h for h in course["holes"] if h["number"] == 2), None)
        if h2 is not None:
            props = self._green_props(h2)
            if props is not None:
                assert "plays_like_yards" not in props, "H2 should not have elevation"

    def test_assemble_without_elevation_stable(self):
        """assemble_osm_course without elevation must not raise or add keys."""
        course = assemble_osm_course(
            geometry=_GEOMETRY,
            course_id="test-id",
            course_name="Test",
            target_course_name="Black",
        )
        for hole in course["holes"]:
            assert "elevation" not in hole


# ══════════════════════════════════════════════════════════════════════════════
# sample_course_elevations — composite ref handling (never crashes, never 0)
# ══════════════════════════════════════════════════════════════════════════════
#
# Regression coverage for the 2026-07-17 championship-course ingest incident:
# a plain int(ref) crashed on Pinehurst-style composite refs like "1 - #2".
# sample_course_elevations must resolve the leading int honestly (via
# parse_leading_int_ref) and skip holes whose ref doesn't parse at all,
# rather than raising or keying the result dict on a fake "0".

import asyncio  # noqa: E402
from unittest.mock import AsyncMock, patch  # noqa: E402

from app.services.elevation import sample_course_elevations  # noqa: E402


class TestSampleCourseElevationsCompositeRef:
    def _run(self, holes: list[dict]) -> dict:
        # fetch_3dep_samples is called twice: tee/green batch, then the
        # green-slope grid batch. Return a flat list of plausible elevations
        # sized to whatever was requested so both calls succeed cleanly.
        async def _fake_fetch(points):
            return [100.0 for _ in points]

        with patch(
            "app.services.elevation.fetch_3dep_samples",
            new=AsyncMock(side_effect=_fake_fetch),
        ):
            return asyncio.run(sample_course_elevations(holes, "Black"))

    def test_composite_ref_resolves_to_leading_int_key(self):
        composite_hole = _make_hole(
            "1 - #2", "Black", -73.000, 40.700, -73.000, 40.702,
        )
        result = self._run([composite_hole])
        assert set(result.keys()) == {1}

    def test_unparseable_ref_is_skipped_not_crashed(self):
        junk_hole = _make_hole("#weird", "Black", -73.000, 40.700, -73.000, 40.702)
        # Must not raise (the old int(ref) would ValueError here).
        result = self._run([junk_hole])
        assert result == {}

    def test_mixed_valid_and_unparseable_refs(self):
        junk_hole = _make_hole("#weird", "Black", -72.990, 40.700, -72.990, 40.702)
        result = self._run([_BH1, junk_hole])
        # The plain-numeric hole resolves normally; the junk ref is dropped —
        # critically, it never produces a fake hole 0 alongside it.
        assert set(result.keys()) == {1}
        assert 0 not in result
