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

import pytest

from app.caddie.hazards import (
    HAZARD_GROUNDING_RULE,
    extract_hole_bend,
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


def _rotate(along: float, lateral: float, bearing_deg: float) -> tuple[float, float]:
    """Map a downrange/lateral (yards) offset into (north, east) yards for a
    hole whose tee->green travel direction is the compass `bearing_deg`
    (0 = due north, 90 = due east, clockwise) — used to sweep the sign-
    convention regression matrix across every compass direction, not just the
    due-north fixtures the rest of this file uses.

    Derived (not copied verbatim from the plan doc) directly against
    hazards.py's own cross-product convention (`lateral_m = ux*hy - uy*hx`,
    positive = LEFT — see extract_hole_hazards) rather than assumed, because
    a plausible-looking rotation formula can silently have its lateral sign
    flipped. Forward unit vector u = (sin(bearing), cos(bearing)) in
    (east, north); the CCW-rotate-by-90 vector p = (-cos(bearing),
    sin(bearing)) satisfies cross(u, p) = +1, so `along*u + lateral*p` gives
    cross(u, offset) == lateral: positive lateral -> positive cross -> LEFT,
    matching the module's documented convention at every bearing (verified
    against the due-north case: bearing=0 collapses to
    (north=along, east=-lateral) — negative east/west = left, exactly the
    existing due-north fixtures below, e.g. test_left_is_positive_cross_convention).
    """
    theta = math.radians(bearing_deg)
    north = along * math.cos(theta) + lateral * math.sin(theta)
    east = along * math.sin(theta) - lateral * math.cos(theta)
    return north, east


def _hole_at_bearing(bearing_deg: float, green_yards: float = 300.0):
    """Tee at (_TEE_LON, _TEE_LAT), green `green_yards` downrange along
    compass `bearing_deg`. Mirrors `_base_hole_features` but for an arbitrary
    travel direction instead of always due north."""
    green_north, green_east = _rotate(green_yards, 0.0, bearing_deg)
    green_lon, green_lat = _point_north_east(_TEE_LON, _TEE_LAT, green_north, green_east)
    tee_feat = _square_polygon("tee", _TEE_LON, _TEE_LAT)
    green_feat = _square_polygon("green", green_lon, green_lat)
    return tee_feat, green_feat


def _hazard_at_bearing(bearing_deg: float, along: float, lateral: float, feature_type: str = "bunker") -> dict:
    """A hazard `along` yards downrange, `lateral` yards left (positive) or
    right (negative) of the tee->green centerline, for a hole traveling at
    compass `bearing_deg`."""
    north, east = _rotate(along, lateral, bearing_deg)
    lon, lat = _point_north_east(_TEE_LON, _TEE_LAT, north, east)
    return _point_feature(feature_type, lon, lat)


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


# ── Bearing-swept regression matrix (hazard-side-flip incident, item 1) ────────
#
# hazards.py itself is verified CORRECT (see module docstring) — the reported
# incident's root cause was a *different*, broken side classifier
# (course_intel._classify_side, deleted in item 2). But this module had no
# regression lock sweeping bearings other than due-north, so a future sign
# regression to the cross-product math here would ship silently. These pin
# the sign convention at all 8 compass directions.


_BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315]


class TestBearingSweptRegression:
    @pytest.mark.parametrize("bearing", _BEARINGS)
    def test_left_bunker_is_left_at_all_eight_bearings(self, bearing):
        tee_feat, green_feat = _hole_at_bearing(bearing)
        bunker = _hazard_at_bearing(bearing, along=245, lateral=25)

        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, bunker))
        assert len(hazards) == 1
        assert hazards[0].line_side == "left"
        assert abs(hazards[0].carry_yards - 245) <= 5

    @pytest.mark.parametrize("bearing", _BEARINGS)
    def test_right_bunker_is_right_at_all_eight_bearings(self, bearing):
        tee_feat, green_feat = _hole_at_bearing(bearing)
        bunker = _hazard_at_bearing(bearing, along=245, lateral=-25)

        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, bunker))
        assert len(hazards) == 1
        assert hazards[0].line_side == "right"
        assert abs(hazards[0].carry_yards - 245) <= 5

    def test_bethpage_hole4_north_hole_west_bunker_is_left(self):
        """Named regression for the reported owner-facing incident: a
        north-pointing hole (bearing 0) with its bunker complex physically
        WEST of the centerline (negative east = left, per this file's own
        due-north convention) must report line_side == "left" — never
        "right" — at carry ~265y off the tee."""
        tee_feat, green_feat = _hole_at_bearing(0, green_yards=430)
        bunker = _hazard_at_bearing(0, along=265, lateral=25)

        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, bunker))
        assert len(hazards) == 1
        assert hazards[0].line_side == "left"
        assert abs(hazards[0].carry_yards - 265) <= 5

    @pytest.mark.parametrize("bearing", _BEARINGS)
    def test_center_within_deadband_at_all_bearings(self, bearing):
        tee_feat, green_feat = _hole_at_bearing(bearing)
        bunker = _hazard_at_bearing(bearing, along=150, lateral=6)  # within 10y deadband

        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, bunker))
        assert len(hazards) == 1
        assert hazards[0].line_side == "center"


# ── Played-polyline classification (dogleg side-flip fix, 2026-07-08) ─────────
#
# The chord (tee→green straight line) mirrors sides on doglegs: Bethpage
# Black 4's landing bunker sits 32y LEFT of the played first leg but right of
# the chord, and the chord math emitted the owner-facing incident string
# ("bunker R 265-485y" — see test_bethpage_validation for the real-fixture
# lock). When the FeatureCollection carries the golf=hole way (featureType
# "hole" LineString), side/carry classify against the PLAYED line instead.


def _dogleg_hole(leg1_yards: float = 270.0, leg1_bearing: float = 45.0,
                 leg2_yards: float = 200.0, leg2_bearing: float = 0.0):
    """Tee at the base point, first leg at `leg1_bearing`, then a dogleg to
    `leg2_bearing` (defaults: 45° then due north = a dogleg LEFT, the Bethpage
    4 shape). Returns (tee_feat, green_feat, hole_way_feature)."""
    n1, e1 = _rotate(leg1_yards, 0.0, leg1_bearing)
    v1_lon, v1_lat = _point_north_east(_TEE_LON, _TEE_LAT, n1, e1)
    dn2, de2 = _rotate(leg2_yards, 0.0, leg2_bearing)
    green_lon, green_lat = _point_north_east(v1_lon, v1_lat, dn2, de2)

    tee_feat = _square_polygon("tee", _TEE_LON, _TEE_LAT)
    green_feat = _square_polygon("green", green_lon, green_lat)
    hole_way = {
        "type": "Feature",
        "properties": {"featureType": "hole"},
        "geometry": {
            "type": "LineString",
            "coordinates": [
                [_TEE_LON, _TEE_LAT],
                [v1_lon, v1_lat],
                [green_lon, green_lat],
            ],
        },
    }
    return tee_feat, green_feat, hole_way


class TestPolylineClassification:
    def test_dogleg_outside_corner_bunker_is_left_of_played_line(self):
        """The incident geometry, synthetically: bunker 30y LEFT of the first
        leg at 200y along the played line (squarely mid-leg-1, so the nearest
        segment is unambiguous). The chord puts it RIGHT (asserted below as
        the documented failure mode); the polyline must say LEFT with the
        along-path carry."""
        tee_feat, green_feat, hole_way = _dogleg_hole()
        bunker = _hazard_at_bearing(45, along=200, lateral=30)

        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, hole_way, bunker))
        assert len(hazards) == 1
        assert hazards[0].line_side == "left"
        assert abs(hazards[0].carry_yards - 200) <= 5

        # Same features WITHOUT the hole way -> chord fallback mirrors the
        # side. This pins WHY the polyline path exists; if the chord ever
        # starts agreeing here, the fixture no longer exercises the dogleg.
        chord_hazards = extract_hole_hazards(_fc(tee_feat, green_feat, bunker))
        assert chord_hazards[0].line_side == "right"

    def test_polyline_carry_is_cumulative_along_path(self):
        """A hazard on the second leg reports the distance the ball travels
        ALONG the played line (leg1 + partial leg2), not the straight-line
        distance from the tee (which is ~30y shorter on this dogleg)."""
        tee_feat, green_feat, hole_way = _dogleg_hole()
        # 150y up leg 2 (due north) from the corner: path carry = 270 + 150.
        n1, e1 = _rotate(270, 0.0, 45)
        v1_lon, v1_lat = _point_north_east(_TEE_LON, _TEE_LAT, n1, e1)
        b_lon, b_lat = _point_north_east(v1_lon, v1_lat, 150, 0)
        bunker = _point_feature("bunker", b_lon, b_lat)

        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, hole_way, bunker))
        assert len(hazards) == 1
        assert abs(hazards[0].carry_yards - 420) <= 5

    def test_explicit_polyline_arg_overrides_chord(self):
        """Callers with a played line from another source can pass it via
        `polyline=` (GeoJSON [[lon, lat], ...]) even when the
        FeatureCollection has no hole LineString of its own."""
        tee_feat, green_feat, hole_way = _dogleg_hole()
        bunker = _hazard_at_bearing(45, along=200, lateral=30)

        hazards = extract_hole_hazards(
            _fc(tee_feat, green_feat, bunker),
            polyline=hole_way["geometry"]["coordinates"],
        )
        assert len(hazards) == 1
        assert hazards[0].line_side == "left"
        assert abs(hazards[0].carry_yards - 200) <= 5

    def test_degenerate_polyline_falls_back_to_chord(self):
        """A polyline with no non-degenerate segment (all identical points)
        must not blow up or zero out — the chord math takes over."""
        tee_feat, green_feat, _, _ = _base_hole_features()
        b_lon, b_lat = _point_north_east(_TEE_LON, _TEE_LAT, 200, -20)
        bunker = _point_feature("bunker", b_lon, b_lat)

        hazards = extract_hole_hazards(
            _fc(tee_feat, green_feat, bunker),
            polyline=[[_TEE_LON, _TEE_LAT], [_TEE_LON, _TEE_LAT]],
        )
        assert len(hazards) == 1
        assert hazards[0].line_side == "left"
        assert abs(hazards[0].carry_yards - 200) <= 5

    def test_straight_polyline_matches_chord_results(self):
        """On a straight hole the two frames must agree — polyline
        classification is a strict generalization, not a behavior change for
        non-dogleg holes."""
        tee_feat, green_feat, _, _ = _base_hole_features()
        green_lon, green_lat = _point_north_east(_TEE_LON, _TEE_LAT, 300, 0)
        hole_way = {
            "type": "Feature",
            "properties": {"featureType": "hole"},
            "geometry": {
                "type": "LineString",
                "coordinates": [[_TEE_LON, _TEE_LAT], [green_lon, green_lat]],
            },
        }
        b_lon, b_lat = _point_north_east(_TEE_LON, _TEE_LAT, 245, -20)
        bunker = _point_feature("bunker", b_lon, b_lat)

        with_way = extract_hole_hazards(_fc(tee_feat, green_feat, hole_way, bunker))
        chord_only = extract_hole_hazards(_fc(tee_feat, green_feat, bunker))
        assert [(h.line_side, h.carry_yards) for h in with_way] == [
            (h.line_side, h.carry_yards) for h in chord_only
        ]


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

    def test_groups_capped_at_six(self):
        hazards = [
            Hazard(type="bunker", side="left", carry_yards=100, line_side="left"),
            Hazard(type="bunker", side="right", carry_yards=110, line_side="right"),
            Hazard(type="bunker", side="center", carry_yards=120, line_side="center"),
            Hazard(type="water", side="left", carry_yards=130, line_side="left"),
            Hazard(type="water", side="right", carry_yards=140, line_side="right"),
            Hazard(type="water", side="center", carry_yards=150, line_side="center"),
            Hazard(type="trees", side="left", carry_yards=160, line_side="left"),
        ]
        line = format_hazards_line(6, hazards)
        # 7 distinct (type, side) groups exist; the line caps at 6 groups —
        # type order sorts first (bunker, water, trees), so the last-sorted
        # group (the only trees group, min carry 160) is the one dropped.
        assert line.count("y") == 6
        assert "160y" not in line


# ── HAZARD_GROUNDING_RULE ─────────────────────────────────────────────────────


def test_grounding_rule_forbids_inventing_hazards():
    assert "do not invent one" in HAZARD_GROUNDING_RULE
    assert "bunker at 260 on the left" in HAZARD_GROUNDING_RULE


# ── extract_hole_bend ──────────────────────────────────────────────────────
#
# Correctness crux (module docstring, "bend / turn-cross" paragraph): the
# spoken direction is the TURN cross (tee→bend x bend→green), NOT the sign of
# the bend vertex's CHORD deviation. `_dogleg_hole()`'s default shape (leg1
# 45°, leg2 due north — the Bethpage-4 dogleg-LEFT shape) is the pinned
# example: the corner sits RIGHT of the tee→green chord, but the true turn is
# LEFT. Tests 2/3 below lock that; a deviation-sign implementation reports
# "right" and goes RED on both.


class TestExtractHoleBend:
    def test_01_right_dogleg_direction_and_distance(self):
        """tee→(0,250yN)→green(180yE,250yN): a clean 90° right turn at the
        corner. RED if: threshold logic is inverted (reports straight), or
        distance is measured to the wrong vertex (e.g. straight-line to the
        green instead of the along-path corner)."""
        tee_feat, green_feat, hole_way = _dogleg_hole(
            leg1_yards=250.0, leg1_bearing=0.0, leg2_yards=180.0, leg2_bearing=90.0,
        )
        bend = extract_hole_bend(_fc(tee_feat, green_feat, hole_way))
        assert bend is not None
        assert bend.straight is False
        assert bend.direction == "right"
        assert abs(bend.distance_yards - 250) <= 5

    def test_02_left_dogleg_direction_and_distance(self):
        """The Bethpage-4 shape (`_dogleg_hole()` defaults: leg1 45°, leg2
        due north). RED under a deviation-sign implementation, which reports
        "right" here (see test_03's explicit mirror-trap pin)."""
        tee_feat, green_feat, hole_way = _dogleg_hole()
        bend = extract_hole_bend(_fc(tee_feat, green_feat, hole_way))
        assert bend is not None
        assert bend.straight is False
        assert bend.direction == "left"
        assert abs(bend.distance_yards - 270) <= 5

    def test_03_mirror_trap_chord_deviation_disagrees_with_reported_direction(self):
        """The same Bethpage-4 fixture as test_02: the bend vertex's CHORD
        deviation is negative (right-of-chord) while the reported direction
        is "left" — this documents WHY direction is the turn cross, not the
        deviation sign, and makes a naive (deviation-sign) implementation
        fail with a self-explaining assertion rather than a bare mismatch."""
        tee_feat, green_feat, hole_way = _dogleg_hole()
        bend = extract_hole_bend(_fc(tee_feat, green_feat, hole_way))
        assert bend is not None and bend.direction == "left"

        # Recompute the corner vertex's chord deviation inline (independent
        # of extract_hole_bend's internals) to prove the mirror.
        tee_lon, tee_lat = _TEE_LON, _TEE_LAT
        n1, e1 = _rotate(270.0, 0.0, 45.0)
        v_lon, v_lat = _point_north_east(tee_lon, tee_lat, n1, e1)
        dn2, de2 = _rotate(200.0, 0.0, 0.0)
        green_lon, green_lat = _point_north_east(v_lon, v_lat, dn2, de2)

        def _xy(lon, lat):
            cos_lat = math.cos(math.radians((tee_lat + lat) / 2.0))
            x = (lon - tee_lon) * _LAT_M_PER_DEG * cos_lat
            y = (lat - tee_lat) * _LAT_M_PER_DEG
            return x, y

        gx, gy = _xy(green_lon, green_lat)
        vx, vy = _xy(v_lon, v_lat)
        length = math.hypot(gx, gy)
        ux, uy = gx / length, gy / length
        dev_m = ux * vy - uy * vx
        assert dev_m < 0, "corner must sit RIGHT of the tee->green chord (the incident geometry)"

    def test_04_straight_hole_two_vertex_and_jittery_many_vertex(self):
        """A bare 2-vertex way and a many-vertex way with <=8y lateral jitter
        both measure straight. RED if the implementation invents a bend or
        drops the threshold."""
        green_lon, green_lat = _point_north_east(_TEE_LON, _TEE_LAT, 300, 0)
        tee_feat = _square_polygon("tee", _TEE_LON, _TEE_LAT)
        green_feat = _square_polygon("green", green_lon, green_lat)

        two_vertex_way = _hole_linestring(_TEE_LON, _TEE_LAT, green_lat)
        bend = extract_hole_bend(_fc(tee_feat, green_feat, two_vertex_way))
        assert bend is not None
        assert bend.straight is True
        assert bend.direction is None

        coords = [[_TEE_LON, _TEE_LAT]]
        for i, north in enumerate((50, 100, 150, 200, 250)):
            lateral = 6 if i % 2 == 0 else -6
            lon, lat = _point_north_east(_TEE_LON, _TEE_LAT, north, lateral)
            coords.append([lon, lat])
        coords.append([green_lon, green_lat])
        jittery_way = {
            "type": "Feature", "properties": {"featureType": "hole"},
            "geometry": {"type": "LineString", "coordinates": coords},
        }
        bend = extract_hole_bend(_fc(tee_feat, green_feat, jittery_way))
        assert bend is not None
        assert bend.straight is True
        assert bend.direction is None

    def test_05_threshold_boundary_12y_straight_18y_bend(self):
        """A single interior vertex just below/above the pinned 15y
        threshold. RED on any threshold drift."""
        green_lon, green_lat = _point_north_east(_TEE_LON, _TEE_LAT, 300, 0)
        tee_feat = _square_polygon("tee", _TEE_LON, _TEE_LAT)
        green_feat = _square_polygon("green", green_lon, green_lat)

        for deviation_yards, expect_straight in ((12, True), (18, False)):
            v_lon, v_lat = _point_north_east(_TEE_LON, _TEE_LAT, 150, -deviation_yards)
            hole_way = {
                "type": "Feature", "properties": {"featureType": "hole"},
                "geometry": {"type": "LineString", "coordinates": [
                    [_TEE_LON, _TEE_LAT], [v_lon, v_lat], [green_lon, green_lat],
                ]},
            }
            bend = extract_hole_bend(_fc(tee_feat, green_feat, hole_way))
            assert bend is not None
            assert bend.straight is expect_straight, (
                f"deviation {deviation_yards}y: expected straight={expect_straight}, got {bend}"
            )

    @pytest.mark.parametrize("offset", _BEARINGS)
    def test_06_bearing_invariance_right_dogleg(self, offset):
        """The right-dogleg shape (test_01) rotated to all 8 compass
        headings must report direction=="right" and the same distance at
        every bearing. RED on any east/north sign slip."""
        tee_feat, green_feat, hole_way = _dogleg_hole(
            leg1_bearing=offset, leg2_bearing=(offset + 90) % 360,
        )
        bend = extract_hole_bend(_fc(tee_feat, green_feat, hole_way))
        assert bend is not None
        assert bend.direction == "right"
        assert abs(bend.distance_yards - 270) <= 5

    def test_07_no_polyline_returns_none_never_straight(self):
        """Tee/green polygons only, no hole LineString — the chord fallback
        has no interior vertices, so this must be an honest unknown. RED if
        the implementation fabricates a "straight" or a bend from the chord."""
        tee_feat, green_feat, _ = _dogleg_hole()
        assert extract_hole_bend(_fc(tee_feat, green_feat)) is None

    def test_08_tee_anchor_subtraction(self):
        """The way's digitized start sits 30y BEHIND the derived tee (a
        back-tee routing artifact); the bend vertex is at a TRUE 250y from
        the tee. RED if tee_along_m isn't subtracted (would report 280)."""
        way_start_lon, way_start_lat = _point_north_east(_TEE_LON, _TEE_LAT, -30, 0)
        bend_lon, bend_lat = _point_north_east(_TEE_LON, _TEE_LAT, 250, -30)
        green_lon, green_lat = _point_north_east(_TEE_LON, _TEE_LAT, 450, 0)
        tee_feat = _square_polygon("tee", _TEE_LON, _TEE_LAT)
        green_feat = _square_polygon("green", green_lon, green_lat)
        hole_way = {
            "type": "Feature", "properties": {"featureType": "hole"},
            "geometry": {"type": "LineString", "coordinates": [
                [way_start_lon, way_start_lat], [bend_lon, bend_lat], [green_lon, green_lat],
            ]},
        }
        bend = extract_hole_bend(_fc(tee_feat, green_feat, hole_way))
        assert bend is not None
        assert bend.straight is False
        assert abs(bend.distance_yards - 250) <= 5
        assert abs(bend.distance_yards - 280) > 15  # NOT the un-anchored number

    def test_09_double_dogleg_primary_selection_and_cumulative_distance(self):
        """An S-shape: bend A (dev +40y, ~215y cumulative along-path) is the
        primary (max |dev| beats bend B's 25y); bend B (dev -25y, opposite
        sign, over threshold) sets double_dogleg. A's OWN reported distance
        is cumulative (tee->waypoint->A, ~215y) — not the straight-line
        tee->A distance (~204y, which rounds to a materially different
        204/205 value). RED on a straight-line-to-vertex implementation,
        which would report ~205 instead of ~215."""
        # Chord runs due north (green due north of tee, on-centerline).
        # Path: tee(0,0) -> waypoint(0,150; ON the chord, dev=0) ->
        # A(-40,200; dev=+40, the primary) -> B(25,320; dev=-25) -> green(0,450).
        points_east_north = [(0, 0), (0, 150), (-40, 200), (25, 320), (0, 450)]
        coords = [
            list(_point_north_east(_TEE_LON, _TEE_LAT, north, east))
            for east, north in points_east_north
        ]
        tee_feat = _square_polygon("tee", *coords[0])
        green_feat = _square_polygon("green", *coords[-1])
        hole_way = {
            "type": "Feature", "properties": {"featureType": "hole"},
            "geometry": {"type": "LineString", "coordinates": coords},
        }
        bend = extract_hole_bend(_fc(tee_feat, green_feat, hole_way))
        assert bend is not None
        assert bend.straight is False
        assert abs(bend.deviation_yards - 40) <= 3, "primary must be bend A (dev +40), not B (dev -25)"
        assert bend.double_dogleg is True
        assert abs(bend.distance_yards - 215) <= 10, f"expected the CUMULATIVE distance (~215y), got {bend.distance_yards}"
        straight_line_to_a = math.hypot(-40 * 0.9144, 200 * 0.9144) / 0.9144
        assert abs(bend.distance_yards - straight_line_to_a) > 5, (
            "distance must diverge from a straight-line-to-vertex calculation "
            f"(straight-line ~{straight_line_to_a:.0f}y, got {bend.distance_yards}y)"
        )

    def test_10_degenerate_polyline_and_behind_tee_kink(self):
        """An all-identical-vertex polyline is degenerate -> None. A large
        kink (60y deviation) located entirely BEHIND the tee must not be
        reported as the bend — with no other candidate, the honest answer is
        measured-straight, never the excluded kink's numbers."""
        tee_feat, green_feat, _ = _dogleg_hole()
        degenerate_way = {
            "type": "Feature", "properties": {"featureType": "hole"},
            "geometry": {"type": "LineString", "coordinates": [
                [_TEE_LON, _TEE_LAT], [_TEE_LON, _TEE_LAT],
            ]},
        }
        assert extract_hole_bend(_fc(tee_feat, green_feat, degenerate_way)) is None

        points_east_north = [(0, -60), (60, -20), (0, 50), (0, 400)]
        coords = [
            list(_point_north_east(_TEE_LON, _TEE_LAT, north, east))
            for east, north in points_east_north
        ]
        tee_feat = _square_polygon("tee", _TEE_LON, _TEE_LAT)
        green_feat = _square_polygon("green", *coords[-1])
        hole_way = {
            "type": "Feature", "properties": {"featureType": "hole"},
            "geometry": {"type": "LineString", "coordinates": coords},
        }
        bend = extract_hole_bend(_fc(tee_feat, green_feat, hole_way))
        assert bend is not None
        assert bend.straight is True, f"a behind-tee kink must never be reported as the bend, got {bend}"
