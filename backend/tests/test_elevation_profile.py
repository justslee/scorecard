"""Unit tests for I4 elevation — pure profile math + osm_ingest integration.

No network, no database.  Tests exercise:
- ``compute_hole_elevation_profile`` (pure function)
- ``assemble_osm_course`` with ``hole_elevations`` attached (additive path)
- Backward-compat: ``assemble_osm_course`` without ``hole_elevations`` is
  unchanged (no ``"elevation"`` key in hole dicts).

The 3DEP HTTP sampler (``fetch_3dep_samples``) and the cached EPQS batch
(``fetch_elevation_batch``) are both network/DB bound; they are exercised in
CI against the live API and are not called here.

Import note
-----------
``elevation.py`` transitively imports ``app.db.engine``, which raises
``RuntimeError`` at module level when ``DATABASE_URL`` is not configured.
We stub the entire ``app.db`` namespace in ``sys.modules`` before importing
any app code so the pure function can be tested without a live Postgres.
The stubs are only installed when ``DATABASE_URL`` is absent (i.e. local
unit-test runs); in CI the real engine is available.
"""

from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock

# ── DB stub ───────────────────────────────────────────────────────────────────
# Must run BEFORE any import that transitively pulls in app.db.engine.
# app/db/__init__.py re-exports from app.db.engine, so we stub all three.
if not os.getenv("DATABASE_URL"):
    for _m in ("app.db.engine", "app.db.models", "app.db"):
        sys.modules.setdefault(_m, MagicMock())
# ─────────────────────────────────────────────────────────────────────────────

from app.services.elevation import compute_hole_elevation_profile  # noqa: E402
from app.services.osm_ingest import assemble_osm_course  # noqa: E402


# ══════════════════════════════════════════════════════════════════════════════
# compute_hole_elevation_profile — pure math
# ══════════════════════════════════════════════════════════════════════════════


class TestComputeHoleElevationProfile:
    """Pure function: no I/O required, fixture elevations only."""

    def test_returns_dict(self):
        result = compute_hole_elevation_profile(100.0, 120.0)
        assert isinstance(result, dict)

    def test_required_keys(self):
        result = compute_hole_elevation_profile(100.0, 120.0)
        assert "tee_elevation_ft"   in result
        assert "green_elevation_ft" in result
        assert "net_change_ft"      in result
        assert "green_slope"        in result

    def test_uphill_positive_net_change(self):
        """Green higher than tee → positive net_change (uphill approach)."""
        result = compute_hole_elevation_profile(50.0, 80.0)
        assert result["net_change_ft"] == 30.0

    def test_downhill_negative_net_change(self):
        """Green lower than tee → negative net_change (downhill approach)."""
        result = compute_hole_elevation_profile(150.0, 120.0)
        assert result["net_change_ft"] == -30.0

    def test_flat_zero_net_change(self):
        result = compute_hole_elevation_profile(75.0, 75.0)
        assert result["net_change_ft"] == 0.0

    def test_tee_elevation_rounded(self):
        result = compute_hole_elevation_profile(100.123, 120.0)
        assert result["tee_elevation_ft"] == 100.1

    def test_green_elevation_rounded(self):
        result = compute_hole_elevation_profile(100.0, 120.456)
        assert result["green_elevation_ft"] == 120.5

    def test_net_change_rounded(self):
        # 120.456 - 100.123 = 20.333 → 20.3
        result = compute_hole_elevation_profile(100.123, 120.456)
        assert result["net_change_ft"] == 20.3

    def test_green_slope_none_by_default(self):
        result = compute_hole_elevation_profile(100.0, 110.0)
        assert result["green_slope"] is None

    def test_green_slope_passthrough(self):
        slope = {
            "direction": 180.0,
            "severity": "mild",
            "percent_grade": 1.5,
            "description": "Green slopes mildly toward the south",
            "center_elevation_ft": 110.0,
        }
        result = compute_hole_elevation_profile(100.0, 110.0, green_slope=slope)
        assert result["green_slope"] is slope  # exact same object, not a copy

    def test_large_elevation_change_bethpage_h3(self):
        """Hole 3 at Bethpage Black drops into a ravine — large downhill."""
        # Approximate fixture values (tee ~200 ft, green ~170 ft).
        result = compute_hole_elevation_profile(200.0, 170.0)
        assert result["net_change_ft"] == -30.0
        assert result["tee_elevation_ft"] == 200.0
        assert result["green_elevation_ft"] == 170.0

    def test_fractional_ft_precision(self):
        """Boundary: values that round to exactly X.0 should stay as floats."""
        result = compute_hole_elevation_profile(100.05, 110.05)
        # net = 10.0 — must be a float, not int
        assert isinstance(result["net_change_ft"], float)
        assert result["net_change_ft"] == 10.0

    def test_negative_elevations_below_sea_level(self):
        """Edge case: course below sea level (Death Valley scenario)."""
        result = compute_hole_elevation_profile(-10.0, -5.0)
        assert result["net_change_ft"] == 5.0
        assert result["tee_elevation_ft"] == -10.0

    def test_zero_elevations(self):
        result = compute_hole_elevation_profile(0.0, 0.0)
        assert result["net_change_ft"] == 0.0
        assert result["tee_elevation_ft"] == 0.0
        assert result["green_elevation_ft"] == 0.0


# ══════════════════════════════════════════════════════════════════════════════
# Shared fixture helpers (mirrors test_ingest_osm_course.py layout)
# ══════════════════════════════════════════════════════════════════════════════


def _make_hole(
    ref: str,
    course_name: str,
    start_lon: float, start_lat: float,
    end_lon: float, end_lat: float,
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


# Two-hole layout for the elevation attachment tests:
#   Black H1: -73.000  lon, 40.700→40.702 lat, par=4, handicap=7
#   Black H2: -72.990  lon, 40.700→40.702 lat, par=5, handicap=3
_BH1 = _make_hole("1", "Black", -73.000, 40.700, -73.000, 40.702, par=4, handicap=7)
_BH2 = _make_hole("2", "Black", -72.990, 40.700, -72.990, 40.702, par=5, handicap=3)
_GREEN_BH1 = _make_polygon("way/green_bh1", "green",  -73.000, 40.702)
_GREEN_BH2 = _make_polygon("way/green_bh2", "green",  -72.990, 40.702)

_GEOMETRY = {
    "holes":    [_BH1, _BH2],
    "greens":   [_GREEN_BH1, _GREEN_BH2],
    "fairways": [],
    "tees":     [],
    "bunkers":  [],
    "water":    [],
}

# Fixture elevation profiles for H1 and H2.
_ELEV_H1 = compute_hole_elevation_profile(95.0, 110.0)   # +15 ft uphill
_ELEV_H2 = compute_hole_elevation_profile(110.0, 85.0)   # −25 ft downhill

_ELEV_MAP = {1: _ELEV_H1, 2: _ELEV_H2}


def _assemble(**overrides) -> dict:
    kwargs: dict = dict(
        geometry=_GEOMETRY,
        course_id="test-id",
        course_name="Bethpage Black",
        target_course_name="Black",
    )
    kwargs.update(overrides)
    return assemble_osm_course(**kwargs)


# ══════════════════════════════════════════════════════════════════════════════
# assemble_osm_course — backward compat (no hole_elevations)
# ══════════════════════════════════════════════════════════════════════════════


class TestAssembleNoElevation:
    """Without hole_elevations, the output is identical to the I2/I3 shape."""

    def test_no_elevation_key_in_holes(self):
        result = _assemble()
        for hole in result["holes"]:
            assert "elevation" not in hole, (
                f"Hole {hole['number']} unexpectedly has 'elevation' key"
            )

    def test_explicit_none_no_elevation_key(self):
        result = _assemble(hole_elevations=None)
        for hole in result["holes"]:
            assert "elevation" not in hole

    def test_holes_still_have_required_keys(self):
        for hole in _assemble()["holes"]:
            assert "number"   in hole
            assert "par"      in hole
            assert "handicap" in hole
            assert "yardages" in hole
            assert "features" in hole


# ══════════════════════════════════════════════════════════════════════════════
# assemble_osm_course — with hole_elevations (I4 attachment)
# ══════════════════════════════════════════════════════════════════════════════


class TestAssembleWithElevation:
    """When hole_elevations is supplied, each matching hole gets an elevation key."""

    def _holes_by_number(self) -> dict[int, dict]:
        result = _assemble(hole_elevations=_ELEV_MAP)
        return {h["number"]: h for h in result["holes"]}

    def test_elevation_key_present_on_h1(self):
        holes = self._holes_by_number()
        assert "elevation" in holes[1]

    def test_elevation_key_present_on_h2(self):
        holes = self._holes_by_number()
        assert "elevation" in holes[2]

    def test_h1_net_change_uphill(self):
        holes = self._holes_by_number()
        assert holes[1]["elevation"]["net_change_ft"] == 15.0

    def test_h2_net_change_downhill(self):
        holes = self._holes_by_number()
        assert holes[2]["elevation"]["net_change_ft"] == -25.0

    def test_h1_tee_elevation(self):
        holes = self._holes_by_number()
        assert holes[1]["elevation"]["tee_elevation_ft"] == 95.0

    def test_h2_green_elevation(self):
        holes = self._holes_by_number()
        assert holes[2]["elevation"]["green_elevation_ft"] == 85.0

    def test_elevation_profile_keys(self):
        holes = self._holes_by_number()
        for n, hole in holes.items():
            elev = hole["elevation"]
            assert "tee_elevation_ft"   in elev, f"H{n} missing tee_elevation_ft"
            assert "green_elevation_ft" in elev, f"H{n} missing green_elevation_ft"
            assert "net_change_ft"      in elev, f"H{n} missing net_change_ft"
            assert "green_slope"        in elev, f"H{n} missing green_slope"

    def test_elevation_green_slope_is_none_for_fixtures(self):
        """Fixture profiles have no green slope (None) — must pass through."""
        holes = self._holes_by_number()
        for hole in holes.values():
            assert hole["elevation"]["green_slope"] is None

    def test_other_hole_keys_unchanged(self):
        """Elevation attachment must not disturb par/handicap/yardages/features."""
        holes = self._holes_by_number()
        assert holes[1]["par"] == 4
        assert holes[1]["handicap"] == 7
        assert holes[1]["yardages"] == {}
        fc = holes[1]["features"]
        assert fc["type"] == "FeatureCollection"

    def test_partial_elevation_map_only_attaches_to_matched_holes(self):
        """Only holes present in hole_elevations get the elevation key."""
        partial = {1: _ELEV_H1}  # only hole 1
        result = _assemble(hole_elevations=partial)
        holes = {h["number"]: h for h in result["holes"]}
        assert "elevation" in holes[1]
        assert "elevation" not in holes[2], "H2 should not have elevation key"

    def test_empty_elevation_map_no_keys_attached(self):
        """An empty dict is falsy; no elevation keys should appear."""
        result = _assemble(hole_elevations={})
        for hole in result["holes"]:
            assert "elevation" not in hole

    def test_elevation_with_green_slope(self):
        """When a profile includes a green_slope dict, it is preserved."""
        slope = {
            "direction": 270.0,
            "severity": "moderate",
            "percent_grade": 3.5,
            "description": "Green slopes moderately toward the west",
            "center_elevation_ft": 110.0,
        }
        profile_with_slope = compute_hole_elevation_profile(95.0, 110.0, green_slope=slope)
        result = _assemble(hole_elevations={1: profile_with_slope})
        holes = {h["number"]: h for h in result["holes"]}
        assert holes[1]["elevation"]["green_slope"] == slope
