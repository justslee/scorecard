"""Unit tests for the tree/woods observation-model gate in
app/caddie/hazards.py (specs/caddie-surface-osm-trees-plan.md §5, T1-T12).

Mirrors test_hazards.py's idioms exactly — due-north base fixtures,
`_point_north_east`/`_rotate`/`_square_polygon`/`_point_feature`/`_fc`,
`_dogleg_hole`, `_hole_at_bearing`/`_hazard_at_bearing`/`_BEARINGS` — copied
here because they are file-local by that file's own convention. All expected
yard/side numbers below are DERIVED from the fixture geometry (either by
hand, from the SAME `_rotate`/`_point_north_east` construction the fixture
itself uses, or — for the near-edge-vs-centroid test — by running the real
`extract_hole_hazards` centroid math against the polygon's own ring centroid
so the "what a centroid implementation would say" comparison number is
computed, not guessed).

Fixture convention (from test_hazards.py): holes run due NORTH (tee at lower
latitude, green at higher latitude) unless swept across `_BEARINGS`, so west
(more negative longitude) = LEFT, east = RIGHT.
"""

import math

import pytest

from app.caddie.hazards import (
    extract_hole_hazards,
    format_hazards_line,
)
from app.caddie.types import Hazard
from app.services.course_spatial import _ring_centroid

# ── Coordinate helpers (copied from test_hazards.py — file-local convention) ──

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
    """See test_hazards.py::_rotate for the derivation. Forward unit vector
    u = (sin(bearing), cos(bearing)) in (east, north); positive lateral ->
    LEFT at every bearing (bearing=0 collapses to north=along, east=-lateral,
    matching this file's due-north fixtures)."""
    theta = math.radians(bearing_deg)
    north = along * math.cos(theta) + lateral * math.sin(theta)
    east = along * math.sin(theta) - lateral * math.cos(theta)
    return north, east


def _hole_at_bearing(bearing_deg: float, green_yards: float = 300.0):
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


def _woods_polygon_at_bearing(vertices: list[tuple[float, float]], bearing_deg: float = 0.0) -> dict:
    """A `"woods"` Polygon whose outer-ring vertices sit at the given
    `(along, lateral)` yard offsets — same `_rotate` convention as
    `_hazard_at_bearing` — for a hole traveling at compass `bearing_deg`. The
    ring is closed by repeating the first vertex (extraction dedupes it, same
    as `_ring_centroid`)."""
    ring = []
    for along, lateral in vertices:
        north, east = _rotate(along, lateral, bearing_deg)
        lon, lat = _point_north_east(_TEE_LON, _TEE_LAT, north, east)
        ring.append([lon, lat])
    ring.append(ring[0])
    return {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [ring]},
        "properties": {"featureType": "woods"},
    }


def _square_polygon(feature_type: str, center_lon: float, center_lat: float, half_deg: float = 0.00005) -> dict:
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


def _point_feature(feature_type: str, lon: float, lat: float) -> dict:
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {"featureType": feature_type},
    }


def _fc(*features: dict) -> dict:
    return {"type": "FeatureCollection", "features": list(features)}


def _base_hole_features(green_yards: float = 300.0):
    green_lon, green_lat = _point_north_east(_TEE_LON, _TEE_LAT, green_yards, 0)
    tee_feat = _square_polygon("tee", _TEE_LON, _TEE_LAT)
    green_feat = _square_polygon("green", green_lon, green_lat)
    return tee_feat, green_feat, green_lon, green_lat


def _dogleg_hole(leg1_yards: float = 270.0, leg1_bearing: float = 45.0,
                 leg2_yards: float = 200.0, leg2_bearing: float = 0.0):
    """Tee at the base point, first leg at `leg1_bearing`, then a dogleg to
    `leg2_bearing` (defaults: 45° then due north — the Bethpage 4 shape,
    dogleg LEFT). Returns (tee_feat, green_feat, hole_way_feature)."""
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


_BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315]


# ── T1-T12 ───────────────────────────────────────────────────────────────────


class TestTreeHazards:
    def test_tree_point_cluster_becomes_tree_line_range(self):
        """T1: 4 `"tree"` Points at along 220/240/260/300y, lateral -25..-35y
        (east = right) -> exactly two `trees` hazards (min carry 220, max
        carry 300, both line_side=='right'), and the formatted line renders
        the along-path range."""
        tee_feat, green_feat, _, _ = _base_hole_features()
        trees = [
            _hazard_at_bearing(0, along=220, lateral=-25, feature_type="tree"),
            _hazard_at_bearing(0, along=240, lateral=-28, feature_type="tree"),
            _hazard_at_bearing(0, along=260, lateral=-30, feature_type="tree"),
            _hazard_at_bearing(0, along=300, lateral=-35, feature_type="tree"),
        ]
        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, *trees))
        tree_hazards = [h for h in hazards if h.type == "trees"]
        assert len(tree_hazards) == 2
        assert {h.line_side for h in tree_hazards} == {"right"}
        assert sorted(h.carry_yards for h in tree_hazards) == [220, 300]

        line = format_hazards_line(9, hazards)
        assert line == "Hole 9 hazards: trees R 220-300y"

    def test_two_isolated_trees_never_speak(self):
        """T2: same hole, only 2 tree Points right + 1 bunker left ->
        hazards contain the bunker and NO `trees` entry (the coverage guard
        is per-type: bunker still speaks with a single observation)."""
        tee_feat, green_feat, _, _ = _base_hole_features()
        trees = [
            _hazard_at_bearing(0, along=220, lateral=-25, feature_type="tree"),
            _hazard_at_bearing(0, along=240, lateral=-28, feature_type="tree"),
        ]
        bunker = _hazard_at_bearing(0, along=150, lateral=20, feature_type="bunker")

        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, *trees, bunker))
        assert [h.type for h in hazards] == ["bunker"]

    def test_no_tree_data_is_silent(self):
        """T3: bunker/water-only FC -> no `trees` entries; the formatted line
        contains no 'trees' token (honest omission)."""
        tee_feat, green_feat, _, _ = _base_hole_features()
        bunker = _hazard_at_bearing(0, along=245, lateral=25)
        water = _hazard_at_bearing(0, along=200, lateral=-15, feature_type="water")

        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, bunker, water))
        assert all(h.type != "trees" for h in hazards)
        assert "trees" not in format_hazards_line(1, hazards)

    def test_woods_near_edge_not_centroid(self):
        """T4 (decision-1 tooth): a diagonal woods Polygon whose near edge
        (3 vertices, along 150-170y, lateral -20..-25y) faces the played
        line, and whose bulk runs away to a far corner (along ~400y, lateral
        -100..-115y) OUTSIDE the 70y window. The emitted carry must track the
        near edge (~150, +-5), and must NOT land near what a centroid-based
        implementation would say — computed here by running the REAL
        extraction against the polygon's own ring centroid (as if it were a
        single-point hazard), so the comparison number is derived from the
        fixture, not guessed."""
        tee_feat, green_feat, _, _ = _base_hole_features()
        verts = [(150, -20), (160, -22), (170, -25), (400, -100), (410, -110), (395, -115)]
        woods = _woods_polygon_at_bearing(verts)

        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, woods))
        tree_hazards = [h for h in hazards if h.type == "trees"]
        assert len(tree_hazards) == 1, "far vertices exceed the 70y window and never qualify their own group"
        assert abs(tree_hazards[0].carry_yards - 150) <= 5
        assert tree_hazards[0].line_side == "right"

        # What a centroid-based implementation would have said: run the
        # SAME extraction against a single point placed at the ring's own
        # arithmetic-mean centroid.
        clon, clat = _ring_centroid(woods["geometry"]["coordinates"][0])
        centroid_as_hazard = extract_hole_hazards(
            _fc(tee_feat, green_feat, _point_feature("bunker", clon, clat))
        )
        centroid_carry = centroid_as_hazard[0].carry_yards
        assert centroid_carry - tree_hazards[0].carry_yards > 50, (
            "fixture precondition: centroid and near-edge answers must diverge materially"
        )
        assert not any(abs(h.carry_yards - centroid_carry) <= 25 for h in tree_hazards)

    def test_behind_tee_observations_dropped(self):
        """T5: a woods ring with 3 vertices behind the tee (negative along)
        and 3 forward -> the range starts at the first FORWARD observation
        (50), never a clamped 0 from the behind-tee vertices."""
        tee_feat, green_feat, _, _ = _base_hole_features()
        verts = [(-50, -20), (-30, -25), (-10, -22), (50, -25), (70, -28), (90, -30)]
        woods = _woods_polygon_at_bearing(verts)

        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, woods))
        tree_hazards = [h for h in hazards if h.type == "trees"]
        assert len(tree_hazards) == 2
        assert sorted(h.carry_yards for h in tree_hazards) == [50, 90]
        assert all(h.carry_yards != 0 for h in tree_hazards)

    @pytest.mark.parametrize("bearing", _BEARINGS)
    def test_tree_side_at_all_eight_bearings(self, bearing):
        """T6: a right-side tree cluster (3 points) stays 'right' with a
        stable carry at every compass heading — trees inherit the shared
        frame, same as bunkers (test_hazards.py::TestBearingSweptRegression)."""
        tee_feat, green_feat = _hole_at_bearing(bearing)
        trees = [
            _hazard_at_bearing(bearing, along=a, lateral=-25, feature_type="tree")
            for a in (235, 245, 255)
        ]
        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, *trees))
        tree_hazards = [h for h in hazards if h.type == "trees"]
        assert len(tree_hazards) == 1
        assert tree_hazards[0].line_side == "right"
        assert abs(tree_hazards[0].carry_yards - 245) <= 10

    def test_dogleg_tree_line_uses_played_line(self):
        """T7: `_dogleg_hole()` fixture, a tree cluster (3 points) 30y LEFT
        of the first leg around along 190-210y -> WITH the hole way:
        line_side=='left', carry near 190-200; WITHOUT it (chord fallback)
        the side mirrors to 'right' — same exposure as the bunker dogleg
        test (test_hazards.py::TestPolylineClassification)."""
        tee_feat, green_feat, hole_way = _dogleg_hole()
        trees = [
            _hazard_at_bearing(45, along=a, lateral=30, feature_type="tree")
            for a in (190, 200, 210)
        ]

        with_way = extract_hole_hazards(_fc(tee_feat, green_feat, hole_way, *trees))
        tree_hazards = [h for h in with_way if h.type == "trees"]
        assert len(tree_hazards) == 1
        assert tree_hazards[0].line_side == "left"
        assert abs(tree_hazards[0].carry_yards - 200) <= 15

        chord_only = extract_hole_hazards(_fc(tee_feat, green_feat, *trees))
        chord_tree_hazards = [h for h in chord_only if h.type == "trees"]
        assert len(chord_tree_hazards) == 1
        assert chord_tree_hazards[0].line_side == "right"

    def test_trees_never_evict_bunker_water(self):
        """T8: 5 bunkers (cap=5) + a qualifying tree cluster -> the same 5
        bunkers survive with and without the trees in the FC; the trees
        entry is appended, not competing for the cap slots."""
        tee_feat, green_feat, _, _ = _base_hole_features()
        bunkers = [
            _hazard_at_bearing(0, along=50 + i * 10, lateral=25, feature_type="bunker")
            for i in range(5)
        ]
        trees = [
            _hazard_at_bearing(0, along=a, lateral=-25, feature_type="tree")
            for a in (150, 160, 170)
        ]

        without_trees = extract_hole_hazards(_fc(tee_feat, green_feat, *bunkers), cap=5)
        with_trees = extract_hole_hazards(_fc(tee_feat, green_feat, *bunkers, *trees), cap=5)

        without_pairs = [(h.type, h.carry_yards) for h in without_trees]
        with_bunkers_only = [(h.type, h.carry_yards) for h in with_trees if h.type == "bunker"]
        assert without_pairs == with_bunkers_only
        assert len(without_pairs) == 5

        tree_hazards = [h for h in with_trees if h.type == "trees"]
        assert len(tree_hazards) == 1
        assert tree_hazards[0].line_side == "right"

    def test_format_orders_trees_last_and_water_never_dropped(self):
        """T9: bunker x3 + water x2 + trees x2 = 7 distinct (type, side)
        groups; `_FORMAT_GROUP_CAP` (6) drops exactly one — since type order
        sorts bunker/water before trees, the dropped group must be a trees
        group, and both water groups must survive."""
        hazards = [
            Hazard(type="bunker", side="left", carry_yards=100, line_side="left"),
            Hazard(type="bunker", side="right", carry_yards=110, line_side="right"),
            Hazard(type="bunker", side="center", carry_yards=120, line_side="center"),
            Hazard(type="water", side="left", carry_yards=130, line_side="left"),
            Hazard(type="water", side="right", carry_yards=140, line_side="right"),
            Hazard(type="trees", side="left", carry_yards=150, line_side="left"),
            Hazard(type="trees", side="right", carry_yards=160, line_side="right"),
        ]
        line = format_hazards_line(9, hazards)
        assert line.count("y") == 6
        assert "130y" in line and "140y" in line, "water groups must never be dropped in favor of trees"
        assert line.count("trees") == 1
        assert "160y" not in line, "the last-sorted (highest-carry) trees group is the one dropped"

    def test_crossing_woods_center_band(self):
        """T10: a woods ring with >=3 vertices within the 10y deadband,
        spanning along 180-220y -> `trees C 180-220y` (the honest
        forced-carry band for a stand crossing the hole)."""
        tee_feat, green_feat, _, _ = _base_hole_features()
        verts = [(180, 5), (200, -3), (220, 2), (220, 5), (180, -2)]
        woods = _woods_polygon_at_bearing(verts)

        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, woods))
        tree_hazards = [h for h in hazards if h.type == "trees"]
        assert len(tree_hazards) == 2
        assert all(h.line_side == "center" for h in tree_hazards)
        assert sorted(h.carry_yards for h in tree_hazards) == [180, 220]
        assert format_hazards_line(3, hazards) == "Hole 3 hazards: trees C 180-220y"

    def test_far_lateral_trees_ignored(self):
        """T11: 4 tree Points at lateral -90y (outside the 70y window) ->
        no trees entries."""
        tee_feat, green_feat, _, _ = _base_hole_features()
        trees = [
            _hazard_at_bearing(0, along=a, lateral=-90, feature_type="tree")
            for a in (220, 240, 260, 280)
        ]
        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, *trees))
        assert all(h.type != "trees" for h in hazards)

    def test_woods_polygon_and_points_merge_per_side(self):
        """T12: a woods Polygon (3 near-edge vertices) + 2 tree Points on the
        SAME side -> one merged range spanning all 5 observations — output
        independent of the OSM feature mix."""
        tee_feat, green_feat, _, _ = _base_hole_features()
        woods = _woods_polygon_at_bearing([(200, -20), (210, -22), (220, -25)])
        points = [
            _hazard_at_bearing(0, along=a, lateral=-lat, feature_type="tree")
            for a, lat in ((240, 28), (260, 30))
        ]

        hazards = extract_hole_hazards(_fc(tee_feat, green_feat, woods, *points))
        tree_hazards = [h for h in hazards if h.type == "trees"]
        assert len(tree_hazards) == 2
        assert all(h.line_side == "right" for h in tree_hazards)
        assert sorted(h.carry_yards for h in tree_hazards) == [200, 260]
        assert format_hazards_line(6, hazards) == "Hole 6 hazards: trees R 200-260y"
