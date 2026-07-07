"""Unit tests for app/caddie/hazards.py — pure geometry + string formatting.

No network, no database. `Hazard` and geometry helpers have zero DB imports so
these run with no env mocking required (unlike test_realtime_tools.py which
needs DATABASE_URL stubbed to import the session/route modules).

Fixture convention: holes run due NORTH (tee at lower latitude, green at
higher latitude), so the tee→green travel direction is (0, 1) in local
(east, north) metres. That makes the left/right convention trivial to reason
about by hand: west (more negative longitude) = LEFT, east = RIGHT.
"""

import math

from app.caddie.hazards import (
    HAZARD_GROUNDING_RULE,
    extract_hole_hazards,
    format_hazards_line,
)
from app.caddie.types import Hazard


# ── Coordinate helpers ────────────────────────────────────────────────────────

_YARDS_TO_M = 0.9144
_LAT_M_PER_DEG = 111_320.0

_TEE_LON, _TEE_LAT = -73.000, 40.700


def _lat_offset_deg(base_lat: float, yards_north: float) -> float:
    return (yards_north * _YARDS_TO_M) / _LAT_M_PER_DEG


def _lon_offset_deg(base_lat: float, yards_east: float) -> float:
    cos_lat = math.cos(math.radians(base_lat))
    return (yards_east * _YARDS_TO_M) / (_LAT_M_PER_DEG * cos_lat)


def _point_north_east(base_lon: float, base_lat: float, yards_north: float, yards_east: float):
    """Return (lon, lat) `yards_north`/`yards_east` from (base_lon, base_lat)."""
    lat = base_lat + _lat_offset_deg(base_lat, yards_north)
    lon = base_lon + _lon_offset_deg(base_lat, yards_east)
    return lon, lat


def _square_polygon(feature_type: str, center_lon: float, center_lat: float, half_deg: float = 0.00005) -> dict:
    """Tiny square Polygon Feature centred on (center_lon, center_lat).

    The arithmetic-mean centroid (_ring_centroid) of a rectangle's four
    corners is exactly its center, so this is a precise fixture for carry/side
    math — no approximation error from the centroid step itself.
    """
    lo_lon, hi_lon = center_lon - half_deg, center_lon + half_deg
    lo_lat, hi_lat = center_lat - half_deg, center_lat + half_deg
    ring = [
        [lo_lon, lo_lat],
        [hi_lon, lo_lat],
        [hi_lon, hi_lat],
        [lo_lon, hi_lat],
        [lo_lon, lo_lat],
    ]
    return {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [ring]},
        "properties": {"featureType": feature_type},
    }


def _rect_polygon(feature_type: str, lon: float, lat_lo: float, lat_hi: float, half_lon_deg: float = 0.00005) -> dict:
    """Rectangle spanning [lat_lo, lat_hi] at longitude `lon` — used for a water
    hazard whose real footprint spans a carry range; its centroid sits at the
    midpoint of that range."""
    lo_lon, hi_lon = lon - half_lon_deg, lon + half_lon_deg
    ring = [
        [lo_lon, lat_lo],
        [hi_lon, lat_lo],
        [hi_lon, lat_hi],
        [lo_lon, lat_hi],
        [lo_lon, lat_lo],
    ]
    return {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [ring]},
        "properties": {"featureType": feature_type},
    }


def _point_feature(feature_type: str, lon: float, lat: float) -> dict:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {"featureType": feature_type},
    }


def _hole_linestring(lon: float, tee_lat: float, green_lat: float) -> dict:
    return {
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": [[lon, tee_lat], [lon, green_lat]]},
        "properties": {"featureType": "hole"},
    }


def _fc(*features: dict) -> dict:
    return {"type": "FeatureCollection", "features": list(features)}


# ── The synthetic hole: tee + green ~300y downrange, bunker left, water right ──


def _base_hole_features(green_yards: float = 300.0):
    green_lon, green_lat = _point_north_east(_TEE_LON, _TEE_LAT, green_yards, 0)
    tee_feat = _square_polygon("tee", _TEE_LON, _TEE_LAT)
    green_feat = _square_polygon("green", green_lon, green_lat)
    return tee_feat, green_feat, green_lon, green_lat


class TestExtractHoleHazards:
    def test_bunker_left_and_water_right_no_phantom_third(self):
        tee_feat, green_feat, _, _ = _base_hole_features()

        # Bunker: single point, 245y downrange, 20y left (west) of centerline.
        b_lon, b_lat = _point_north_east(_TEE_LON, _TEE_LAT, 245, -20)
        bunker = _point_feature("bunker", b_lon, b_lat)

        # Water: a real polygon footprint spanning carry 190y-230y, 15y right
        # (east) of centerline — centroid lands at the midpoint, carry ~210y.
        w_lon, _ = _point_north_east(_TEE_LON, _TEE_LAT, 0, 15)
        _, w_lat_lo = _point_north_east(_TEE_LON, _TEE_LAT, 190, 0)
        _, w_lat_hi = _point_north_east(_TEE_LON, _TEE_LAT, 230, 0)
        water = _rect_polygon("water", w_lon, w_lat_lo, w_lat_hi)

        fc = _fc(tee_feat, green_feat, bunker, water)
        hazards = extract_hole_hazards(fc)

        assert len(hazards) == 2, "no phantom third hazard"
        by_type = {h.type: h for h in hazards}
        assert set(by_type) == {"bunker", "water"}

        b = by_type["bunker"]
        assert b.line_side == "left"
        assert b.side == "left"
        assert abs(b.carry_yards - 245) <= 5

        w = by_type["water"]
        assert w.line_side == "right"
        assert w.side == "right"
        assert abs(w.carry_yards - 210) <= 5

        # Nearest-first ordering.
        assert hazards[0].type == "water"
        assert hazards[1].type == "bunker"

    def test_left_is_positive_cross_convention(self):
        """Pins the sign convention: LEFT of tee→green travel = positive cross."""
        tee_feat, green_feat, _, _ = _base_hole_features()
        left_lon, left_lat = _point_north_east(_TEE_LON, _TEE_LAT, 100, -30)
        bunker = _point_feature("bunker", left_lon, left_lat)

        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, bunker))
        assert len(hazards) == 1
        assert hazards[0].line_side == "left"

    def test_hazard_on_the_line_is_center(self):
        tee_feat, green_feat, _, _ = _base_hole_features()
        on_line_lon, on_line_lat = _point_north_east(_TEE_LON, _TEE_LAT, 150, 0)
        bunker = _point_feature("bunker", on_line_lon, on_line_lat)

        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, bunker))
        assert len(hazards) == 1
        assert hazards[0].line_side == "center"

    def test_lateral_deadband_collapses_near_line_to_center(self):
        """Within the 10y deadband (not exactly 0) still collapses to center."""
        tee_feat, green_feat, _, _ = _base_hole_features()
        near_lon, near_lat = _point_north_east(_TEE_LON, _TEE_LAT, 150, 6)
        bunker = _point_feature("bunker", near_lon, near_lat)

        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, bunker))
        assert hazards[0].line_side == "center"

    def test_par3_short_line_valid(self):
        tee_feat, green_feat, _, _ = _base_hole_features(green_yards=150.0)
        b_lon, b_lat = _point_north_east(_TEE_LON, _TEE_LAT, 130, 18)
        bunker = _point_feature("bunker", b_lon, b_lat)

        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, bunker))
        assert len(hazards) == 1
        assert hazards[0].line_side == "right"
        assert abs(hazards[0].carry_yards - 130) <= 5

    def test_hazard_beyond_green_keeps_true_tee_carry(self):
        """A hazard past the green must report its true tee-relative carry, not
        get clamped down to hole length."""
        tee_feat, green_feat, _, _ = _base_hole_features(green_yards=300.0)
        b_lon, b_lat = _point_north_east(_TEE_LON, _TEE_LAT, 350, -18)
        bunker = _point_feature("bunker", b_lon, b_lat)

        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, bunker))
        assert len(hazards) == 1
        assert hazards[0].carry_yards >= 345

    def test_no_bunker_or_water_returns_empty(self):
        tee_feat, green_feat, _, _ = _base_hole_features()
        fairway = _square_polygon("fairway", _TEE_LON, _TEE_LAT + 0.001)
        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, fairway))
        assert hazards == []

    def test_missing_tee_and_green_returns_empty(self):
        """No tee/green polygons, no hole linestring, no fallback args → []."""
        b_lon, b_lat = _point_north_east(_TEE_LON, _TEE_LAT, 100, -20)
        bunker = _point_feature("bunker", b_lon, b_lat)
        hazards = extract_hole_hazards(_fc(bunker))
        assert hazards == []

    def test_missing_only_tee_returns_empty(self):
        """Green present, but no tee anywhere → never guess a bearing."""
        _, green_feat, _, _ = _base_hole_features()
        b_lon, b_lat = _point_north_east(_TEE_LON, _TEE_LAT, 100, -20)
        bunker = _point_feature("bunker", b_lon, b_lat)
        hazards = extract_hole_hazards(_fc(green_feat, bunker))
        assert hazards == []

    def test_falls_back_to_hole_linestring_when_no_tee_green_polygons(self):
        green_lon, green_lat = _point_north_east(_TEE_LON, _TEE_LAT, 300, 0)
        hole_ls = _hole_linestring(_TEE_LON, _TEE_LAT, green_lat)
        b_lon, b_lat = _point_north_east(_TEE_LON, _TEE_LAT, 200, -20)
        bunker = _point_feature("bunker", b_lon, b_lat)

        hazards = extract_hole_hazards(_fc(hole_ls, bunker))
        assert len(hazards) == 1
        assert hazards[0].line_side == "left"
        assert abs(hazards[0].carry_yards - 200) <= 5

    def test_falls_back_to_tee_green_args_as_last_resort(self):
        """No tee/green polygons AND no hole linestring — use the tee=/green= kwargs."""
        b_lon, b_lat = _point_north_east(_TEE_LON, _TEE_LAT, 100, -20)
        bunker = _point_feature("bunker", b_lon, b_lat)
        green_lon, green_lat = _point_north_east(_TEE_LON, _TEE_LAT, 300, 0)

        hazards = extract_hole_hazards(
            _fc(bunker),
            tee={"lat": _TEE_LAT, "lng": _TEE_LON},
            green={"lat": green_lat, "lng": green_lon},
        )
        assert len(hazards) == 1
        assert hazards[0].line_side == "left"

    def test_carry_yards_rounded_to_5(self):
        tee_feat, green_feat, _, _ = _base_hole_features()
        b_lon, b_lat = _point_north_east(_TEE_LON, _TEE_LAT, 187, -20)
        bunker = _point_feature("bunker", b_lon, b_lat)

        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, bunker))
        assert len(hazards) == 1
        assert hazards[0].carry_yards % 5 == 0

    def test_same_side_bunkers_merge_into_a_range_via_format(self):
        """Clustered same-side hazards from extraction feed a single formatted range."""
        tee_feat, green_feat, _, _ = _base_hole_features()
        b1_lon, b1_lat = _point_north_east(_TEE_LON, _TEE_LAT, 230, -20)
        b2_lon, b2_lat = _point_north_east(_TEE_LON, _TEE_LAT, 260, -25)
        bunker1 = _point_feature("bunker", b1_lon, b1_lat)
        bunker2 = _point_feature("bunker", b2_lon, b2_lat)

        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, bunker1, bunker2))
        assert len(hazards) == 2
        line = format_hazards_line(9, hazards)
        assert line == "Hole 9 hazards: bunker L 230-260y"

    def test_empty_features_returns_empty(self):
        assert extract_hole_hazards(_fc()) == []

    def test_none_features_returns_empty(self):
        assert extract_hole_hazards(None) == []

    def test_cap_limits_hazard_count(self):
        tee_feat, green_feat, _, _ = _base_hole_features()
        features = [tee_feat, green_feat]
        for i in range(8):
            lon, lat = _point_north_east(_TEE_LON, _TEE_LAT, 50 + i * 10, -20)
            features.append(_point_feature("bunker", lon, lat))
        hazards = extract_hole_hazards(_fc(*features), cap=5)
        assert len(hazards) == 5


# ── format_hazards_line ───────────────────────────────────────────────────────


class TestFormatHazardsLine:
    def test_empty_list_returns_empty_string(self):
        assert format_hazards_line(4, []) == ""

    def test_single_hazard_per_group(self):
        hazards = [Hazard(type="bunker", side="left", carry_yards=245, line_side="left")]
        assert format_hazards_line(4, hazards) == "Hole 4 hazards: bunker L 245y"

    def test_exact_spec_example_line(self):
        hazards = [
            Hazard(type="bunker", side="left", carry_yards=245, line_side="left"),
            Hazard(type="water", side="right", carry_yards=190, line_side="right"),
            Hazard(type="water", side="right", carry_yards=230, line_side="right"),
        ]
        line = format_hazards_line(4, hazards)
        assert line == "Hole 4 hazards: bunker L 245y, water R 190-230y"

    def test_bunker_sorts_before_water_even_if_farther(self):
        hazards = [
            Hazard(type="water", side="right", carry_yards=100, line_side="right"),
            Hazard(type="bunker", side="left", carry_yards=300, line_side="left"),
        ]
        line = format_hazards_line(5, hazards)
        assert line == "Hole 5 hazards: bunker L 300y, water R 100y"

    def test_groups_capped_at_five(self):
        hazards = [
            Hazard(type="bunker", side="left", carry_yards=100, line_side="left"),
            Hazard(type="bunker", side="right", carry_yards=110, line_side="right"),
            Hazard(type="bunker", side="center", carry_yards=120, line_side="center"),
            Hazard(type="water", side="left", carry_yards=130, line_side="left"),
            Hazard(type="water", side="right", carry_yards=140, line_side="right"),
            Hazard(type="water", side="center", carry_yards=150, line_side="center"),
        ]
        line = format_hazards_line(6, hazards)
        # 6 distinct (type, side) groups exist; the line caps at 5 groups —
        # the last-sorted one (water/center, min carry 150) is dropped.
        assert line.count("y") == 5
        assert "150y" not in line


# ── HAZARD_GROUNDING_RULE ─────────────────────────────────────────────────────


def test_grounding_rule_forbids_inventing_hazards():
    assert "do not invent one" in HAZARD_GROUNDING_RULE
    assert "bunker at 260 on the left" in HAZARD_GROUNDING_RULE
