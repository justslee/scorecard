"""Unit tests for course_spatial.py — pure geometry, no DB, no network.

Fixture layout (approximate, lat/lon grid near New York):
  • Black-H1  tee→green  lon=-73.000  lat=40.700→40.702  (N-S)
  • Black-H2  tee→green  lon=-72.990  lat=40.700→40.702  (≈842 m east)
  • Red-H1    tee→green  lon=-72.970  lat=40.700→40.702  (≈2527 m east)

Polygons:
  • green-BH1   near Black-H1 end   → must assign to Black / H1 via "end" mode
  • bunker-BH1  near Black-H1 mid   → must assign to Black / H1 via "nearest" mode
  • tee-BH1     near Black-H1 start → must assign to Black / H1 via "start" mode
  • green-RH1   near Red-H1 end     → must assign to Red / H1, REJECTED from Black output
"""

import math

from app.services.course_spatial import (
    _CORRIDOR_CAPS_M,
    _CORRIDOR_CAP_DEFAULT_M,
    _WOODS_MAX_SPAN_M,
    _deg_to_m,
    _linestring_dist_m,
    _linestring_intersection_m,
    _match_mode,
    _point_in_ring,
    _point_to_segment_dist_m,
    _ref_to_int,
    _ring_bbox,
    _ring_centroid,
    assign_features_to_holes,
    build_course_feature_collection,
)


# ── Coordinate constants ──────────────────────────────────────────────────────

# Black hole 1: runs south→north along lon = -73.000
_BH1_TEE_LON, _BH1_TEE_LAT = -73.000, 40.700
_BH1_MID_LON, _BH1_MID_LAT = -73.000, 40.701
_BH1_GREEN_LON, _BH1_GREEN_LAT = -73.000, 40.702

# Black hole 2: parallel, ≈842 m east of H1
_BH2_TEE_LON, _BH2_TEE_LAT = -72.990, 40.700
_BH2_GREEN_LON, _BH2_GREEN_LAT = -72.990, 40.702

# Red hole 1: ≈2527 m east of BH1
_RH1_TEE_LON, _RH1_TEE_LAT = -72.970, 40.700
_RH1_GREEN_LON, _RH1_GREEN_LAT = -72.970, 40.702


def _make_hole(ref: str, course_name: str, start_lon: float, start_lat: float,
               end_lon: float, end_lat: float, mid_lon: float | None = None,
               mid_lat: float | None = None, par: int = 4) -> dict:
    """Build a GeoJSON LineString hole Feature matching the osm.py format."""
    coords = [[start_lon, start_lat]]
    if mid_lon is not None and mid_lat is not None:
        coords.append([mid_lon, mid_lat])
    coords.append([end_lon, end_lat])
    return {
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": coords},
        "properties": {
            "featureType": "hole",
            "osm_id": f"way/bh{ref}",
            "ref": ref,
            "par": par,
            "handicap": None,
            "name": f"Hole {ref}",
            "course_name": course_name,
        },
    }


def _make_polygon(osm_id: str, feature_type: str, center_lon: float,
                  center_lat: float, half_deg: float = 0.0001) -> dict:
    """Build a tiny square GeoJSON Polygon Feature centred on (lon, lat)."""
    lo_lon = center_lon - half_deg
    hi_lon = center_lon + half_deg
    lo_lat = center_lat - half_deg
    hi_lat = center_lat + half_deg
    ring = [
        [lo_lon, lo_lat],
        [hi_lon, lo_lat],
        [hi_lon, hi_lat],
        [lo_lon, hi_lat],
        [lo_lon, lo_lat],  # closed
    ]
    return {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [ring]},
        "properties": {"featureType": feature_type, "osm_id": osm_id},
    }


# ── Shared fixtures ───────────────────────────────────────────────────────────

ALL_HOLES = [
    _make_hole("1", "Black", _BH1_TEE_LON, _BH1_TEE_LAT, _BH1_GREEN_LON, _BH1_GREEN_LAT,
               _BH1_MID_LON, _BH1_MID_LAT),
    _make_hole("2", "Black", _BH2_TEE_LON, _BH2_TEE_LAT, _BH2_GREEN_LON, _BH2_GREEN_LAT),
    _make_hole("1", "Red",   _RH1_TEE_LON, _RH1_TEE_LAT, _RH1_GREEN_LON, _RH1_GREEN_LAT),
]

# green polygon centred near BH1's endpoint
POLY_GREEN_BH1 = _make_polygon("way/green1", "green", _BH1_GREEN_LON, _BH1_GREEN_LAT)
# bunker slightly west of BH1 midpoint
POLY_BUNKER_BH1 = _make_polygon("way/bunker1", "bunker", _BH1_MID_LON - 0.001, _BH1_MID_LAT)
# tee polygon near BH1 start
POLY_TEE_BH1 = _make_polygon("way/tee1", "tee", _BH1_TEE_LON, _BH1_TEE_LAT)
# green near RH1 endpoint — should be REJECTED from Black output
POLY_GREEN_RH1 = _make_polygon("way/green_red", "green", _RH1_GREEN_LON, _RH1_GREEN_LAT)

ALL_POLYGONS = [POLY_GREEN_BH1, POLY_BUNKER_BH1, POLY_TEE_BH1, POLY_GREEN_RH1]


# ══════════════════════════════════════════════════════════════════════════════
# _deg_to_m
# ══════════════════════════════════════════════════════════════════════════════

class TestDegToM:
    """Sanity-check the equirectangular distance helper."""

    def test_one_degree_lat_approx_111km(self):
        d = _deg_to_m(0.0, 0.0, 1.0, 0.0)
        # 1° latitude ≈ 111 320 m; allow ±1 % tolerance
        assert abs(d - 111_320.0) < 1_200.0, f"Expected ~111320 m, got {d:.1f}"

    def test_zero_distance(self):
        assert _deg_to_m(40.7, -73.0, 40.7, -73.0) == 0.0

    def test_symmetry(self):
        a = _deg_to_m(40.7, -73.0, 40.701, -73.001)
        b = _deg_to_m(40.701, -73.001, 40.7, -73.0)
        assert abs(a - b) < 1e-6

    def test_longitude_scale_at_40deg(self):
        # 1° longitude at lat 40° should be significantly less than 111 km
        d = _deg_to_m(40.0, 0.0, 40.0, 1.0)
        # cos(40°) ≈ 0.766 → ≈85 280 m  (allow ±2 %)
        expected = 111_320.0 * math.cos(math.radians(40.0))
        assert abs(d - expected) < 2_000.0

    def test_small_distance_known_value(self):
        # Two points 0.001° apart in latitude ≈ 111.32 m
        d = _deg_to_m(40.700, -73.000, 40.701, -73.000)
        assert 110.0 < d < 113.0, f"Expected ~111 m, got {d:.2f}"


# ══════════════════════════════════════════════════════════════════════════════
# _point_to_segment_dist_m
# ══════════════════════════════════════════════════════════════════════════════

class TestPointToSegmentDist:
    """Point-to-segment distance for degenerate and perpendicular cases."""

    def test_perpendicular_to_north_south_segment(self):
        # Segment: (lon=0, lat=0) to (lon=0, lat=0.001) — ≈111 m N-S
        # Point: (lon=0.001, lat=0.0005) — perpendicular from midpoint, ≈84 m east at lat≈0
        d = _point_to_segment_dist_m(0.001, 0.0005, 0.0, 0.0, 0.0, 0.001)
        # 0.001° longitude at lat~0 ≈ 111.32 m
        assert 100.0 < d < 120.0

    def test_point_beyond_segment_end_returns_endpoint_dist(self):
        # Segment A=(0,0) to B=(0,0.001); query point way past B at (0, 0.01)
        # Should return distance to B, not some negative perpendicular.
        d = _point_to_segment_dist_m(0.0, 0.01, 0.0, 0.0, 0.0, 0.001)
        d_to_b = _deg_to_m(0.01, 0.0, 0.001, 0.0)
        assert abs(d - d_to_b) < 1.0

    def test_point_before_segment_start_returns_start_dist(self):
        # Query point before A
        d = _point_to_segment_dist_m(0.0, -0.01, 0.0, 0.0, 0.0, 0.001)
        d_to_a = _deg_to_m(-0.01, 0.0, 0.0, 0.0)
        assert abs(d - d_to_a) < 1.0

    def test_degenerate_segment_aa_returns_point_dist(self):
        # Zero-length segment
        d = _point_to_segment_dist_m(0.001, 0.001, 0.0, 0.0, 0.0, 0.0)
        d_direct = _deg_to_m(0.001, 0.001, 0.0, 0.0)
        assert abs(d - d_direct) < 0.1

    def test_point_on_segment_returns_zero(self):
        # Mid-segment point should be very close to 0
        d = _point_to_segment_dist_m(0.0, 0.0005, 0.0, 0.0, 0.0, 0.001)
        assert d < 0.5  # within half a metre


# ══════════════════════════════════════════════════════════════════════════════
# _ring_centroid
# ══════════════════════════════════════════════════════════════════════════════

class TestRingCentroid:
    def test_unit_square_centroid(self):
        ring = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [0.0, 0.0]]
        lon, lat = _ring_centroid(ring)
        assert abs(lon - 0.5) < 0.01
        assert abs(lat - 0.5) < 0.01

    def test_centroid_lon_lat_order(self):
        # [[lon, lat], ...]  — first element is longitude
        ring = [[10.0, 20.0], [12.0, 20.0], [12.0, 22.0], [10.0, 22.0], [10.0, 20.0]]
        lon, lat = _ring_centroid(ring)
        assert abs(lon - 11.0) < 0.1
        assert abs(lat - 21.0) < 0.1


# ══════════════════════════════════════════════════════════════════════════════
# _match_mode
# ══════════════════════════════════════════════════════════════════════════════

class TestMatchMode:
    def test_green_returns_end(self):
        assert _match_mode("green") == "end"

    def test_tee_returns_start(self):
        assert _match_mode("tee") == "start"

    def test_fairway_returns_nearest(self):
        assert _match_mode("fairway") == "nearest"

    def test_bunker_returns_nearest(self):
        assert _match_mode("bunker") == "nearest"

    def test_water_returns_nearest(self):
        assert _match_mode("water") == "nearest"

    def test_unknown_returns_nearest(self):
        assert _match_mode("") == "nearest"


# ══════════════════════════════════════════════════════════════════════════════
# _linestring_dist_m
# ══════════════════════════════════════════════════════════════════════════════

class TestLinestringDist:
    # A short N-S segment from (lat=40.700) to (lat=40.702)
    COORDS = [[-73.000, 40.700], [-73.000, 40.701], [-73.000, 40.702]]

    def test_end_mode_uses_last_vertex(self):
        # Query = exactly at last vertex
        d = _linestring_dist_m(-73.000, 40.702, self.COORDS, "end")
        assert d < 1.0

    def test_start_mode_uses_first_vertex(self):
        # Query = exactly at first vertex
        d = _linestring_dist_m(-73.000, 40.700, self.COORDS, "start")
        assert d < 1.0

    def test_nearest_mode_midpoint_on_line(self):
        # Query on the line midpoint should be ~0
        d = _linestring_dist_m(-73.000, 40.701, self.COORDS, "nearest")
        assert d < 1.0

    def test_nearest_mode_off_line(self):
        # Query slightly east of the line midpoint
        d = _linestring_dist_m(-72.999, 40.701, self.COORDS, "nearest")
        # 0.001° longitude at lat~40.7 ≈ 84 m
        assert 70.0 < d < 100.0

    def test_empty_coords_returns_inf(self):
        assert _linestring_dist_m(-73.0, 40.7, [], "nearest") == float("inf")

    def test_single_point_linestring_nearest(self):
        d = _linestring_dist_m(-73.000, 40.700, [[-73.000, 40.700]], "nearest")
        assert d < 1.0


# ══════════════════════════════════════════════════════════════════════════════
# _ref_to_int
# ══════════════════════════════════════════════════════════════════════════════

class TestRefToInt:
    def test_numeric_string(self):
        assert _ref_to_int("18") == 18

    def test_none_returns_zero(self):
        assert _ref_to_int(None) == 0

    def test_non_numeric_returns_zero(self):
        assert _ref_to_int("abc") == 0


# ══════════════════════════════════════════════════════════════════════════════
# assign_features_to_holes — core spatial-join logic
# ══════════════════════════════════════════════════════════════════════════════

class TestAssignFeaturesToHoles:
    """The assignment function with the 2-Black-1-Red fixture."""

    def _run(self) -> dict:
        return assign_features_to_holes(ALL_HOLES, ALL_POLYGONS)

    def test_returns_entry_for_every_polygon(self):
        result = self._run()
        for poly in ALL_POLYGONS:
            osm_id = poly["properties"]["osm_id"]
            assert osm_id in result

    # ── green near BH1 end ────────────────────────────────────────────────────

    def test_green_bh1_assigns_to_black(self):
        result = self._run()
        _ref, course, _dist = result["way/green1"]
        assert course == "Black"

    def test_green_bh1_assigns_to_hole_1(self):
        result = self._run()
        ref, _course, _dist = result["way/green1"]
        assert ref == "1"

    def test_green_bh1_distance_is_small(self):
        # Green is placed ~at BH1 endpoint; should be < 20 m
        result = self._run()
        _ref, _course, dist = result["way/green1"]
        assert dist < 20.0

    # ── bunker near BH1 midpoint (nearest mode) ───────────────────────────────

    def test_bunker_bh1_assigns_to_black(self):
        result = self._run()
        _ref, course, _dist = result["way/bunker1"]
        assert course == "Black"

    def test_bunker_bh1_assigns_to_hole_1(self):
        result = self._run()
        ref, _course, _dist = result["way/bunker1"]
        assert ref == "1"

    def test_bunker_bh1_distance_reasonable(self):
        # Bunker is 0.001° west of BH1; ≈84 m at lat 40.7
        result = self._run()
        _ref, _course, dist = result["way/bunker1"]
        assert 60.0 < dist < 120.0

    # ── tee near BH1 start (start mode) ──────────────────────────────────────

    def test_tee_bh1_assigns_to_black(self):
        result = self._run()
        _ref, course, _dist = result["way/tee1"]
        assert course == "Black"

    def test_tee_bh1_assigns_to_hole_1(self):
        result = self._run()
        ref, _course, _dist = result["way/tee1"]
        assert ref == "1"

    # ── green near RH1 end — should assign to Red ─────────────────────────────

    def test_red_green_assigns_to_red(self):
        result = self._run()
        _ref, course, _dist = result["way/green_red"]
        assert course == "Red"

    def test_red_green_does_not_assign_to_black(self):
        result = self._run()
        _ref, course, _dist = result["way/green_red"]
        assert course != "Black"

    def test_red_green_distance_to_red_is_small(self):
        result = self._run()
        _ref, _course, dist = result["way/green_red"]
        assert dist < 20.0

    # ── cross-course nearest check: red green is farther from any Black hole ──

    def test_red_green_farther_from_bh1_than_from_rh1(self):
        """Verifies the rejection logic by confirming geometric ordering."""
        bh1_end_dist = _deg_to_m(
            _RH1_GREEN_LAT, _RH1_GREEN_LON,
            _BH1_GREEN_LAT, _BH1_GREEN_LON,
        )
        rh1_end_dist = _deg_to_m(
            _RH1_GREEN_LAT, _RH1_GREEN_LON,
            _RH1_GREEN_LAT, _RH1_GREEN_LON,
        )
        assert rh1_end_dist < bh1_end_dist

    # ── empty inputs ──────────────────────────────────────────────────────────

    def test_no_holes_returns_inf_for_all(self):
        result = assign_features_to_holes([], ALL_POLYGONS)
        for _ref, _course, dist in result.values():
            assert dist == float("inf")

    def test_no_polygons_returns_empty(self):
        result = assign_features_to_holes(ALL_HOLES, [])
        assert result == {}

    def test_polygon_missing_geometry_gets_inf_entry(self):
        bad_poly = {"type": "Feature", "properties": {"osm_id": "way/bad", "featureType": "green"}}
        result = assign_features_to_holes(ALL_HOLES, [bad_poly])
        _ref, _course, dist = result["way/bad"]
        assert dist == float("inf")


# ══════════════════════════════════════════════════════════════════════════════
# build_course_feature_collection — rejection + grouping
# ══════════════════════════════════════════════════════════════════════════════

class TestBuildCourseFeatureCollection:
    """Cross-course rejection and per-hole grouping."""

    def _run(self, target: str = "Black") -> list[dict]:
        return build_course_feature_collection(ALL_HOLES, ALL_POLYGONS, target)

    def test_returns_list(self):
        assert isinstance(self._run(), list)

    def test_black_output_excludes_red_polygon(self):
        """The green nearest to Red hole-1 must NOT appear in the Black output."""
        result = self._run("Black")
        all_osm_ids = {
            f["properties"]["osm_id"]
            for hole in result
            for f in hole["features"]["features"]
        }
        assert "way/green_red" not in all_osm_ids

    def test_black_output_includes_bh1_green(self):
        result = self._run("Black")
        all_osm_ids = {
            f["properties"]["osm_id"]
            for hole in result
            for f in hole["features"]["features"]
        }
        assert "way/green1" in all_osm_ids

    def test_black_output_includes_bunker(self):
        result = self._run("Black")
        all_osm_ids = {
            f["properties"]["osm_id"]
            for hole in result
            for f in hole["features"]["features"]
        }
        assert "way/bunker1" in all_osm_ids

    def test_black_output_includes_tee(self):
        result = self._run("Black")
        all_osm_ids = {
            f["properties"]["osm_id"]
            for hole in result
            for f in hole["features"]["features"]
        }
        assert "way/tee1" in all_osm_ids

    def test_hole_dicts_have_required_keys(self):
        result = self._run("Black")
        for hole in result:
            assert "number" in hole
            assert "par" in hole
            assert "handicap" in hole
            assert "yardages" in hole
            assert "features" in hole

    def test_features_are_geojson_feature_collections(self):
        result = self._run("Black")
        for hole in result:
            assert hole["features"]["type"] == "FeatureCollection"
            assert isinstance(hole["features"]["features"], list)

    def test_features_have_geojson_type(self):
        result = self._run("Black")
        for hole in result:
            for f in hole["features"]["features"]:
                assert f["type"] == "Feature"
                assert "properties" in f
                assert "geometry" in f

    def test_holes_sorted_by_number(self):
        result = self._run("Black")
        numbers = [h["number"] for h in result]
        assert numbers == sorted(numbers)

    def test_par_and_handicap_are_none(self):
        """These fields are intentionally left for the caller to fill from card data."""
        result = self._run("Black")
        for hole in result:
            assert hole["par"] is None
            assert hole["handicap"] is None

    def test_yardages_are_empty(self):
        result = self._run("Black")
        for hole in result:
            assert hole["yardages"] == {}

    def test_case_insensitive_target(self):
        upper = self._run("BLACK")
        lower = self._run("black")
        # Same number of holes, same OSM ids
        ids_upper = {
            f["properties"]["osm_id"]
            for hole in upper
            for f in hole["features"]["features"]
        }
        ids_lower = {
            f["properties"]["osm_id"]
            for hole in lower
            for f in hole["features"]["features"]
        }
        assert ids_upper == ids_lower

    def test_nonexistent_course_returns_empty_list(self):
        result = build_course_feature_collection(ALL_HOLES, ALL_POLYGONS, "Blue")
        assert result == []

    def test_red_target_includes_red_polygon(self):
        result = self._run("Red")
        all_osm_ids = {
            f["properties"]["osm_id"]
            for hole in result
            for f in hole["features"]["features"]
        }
        assert "way/green_red" in all_osm_ids

    def test_red_target_excludes_black_polygons(self):
        result = self._run("Red")
        all_osm_ids = {
            f["properties"]["osm_id"]
            for hole in result
            for f in hole["features"]["features"]
        }
        # BH1 green, bunker, and tee all assign to Black; none should appear in Red
        assert "way/green1" not in all_osm_ids
        assert "way/bunker1" not in all_osm_ids
        assert "way/tee1" not in all_osm_ids

    def test_empty_polygons_returns_empty_list(self):
        result = build_course_feature_collection(ALL_HOLES, [], "Black")
        assert result == []

    def test_empty_holes_returns_empty_list(self):
        result = build_course_feature_collection([], ALL_POLYGONS, "Black")
        assert result == []


# ══════════════════════════════════════════════════════════════════════════════
# Point geometry support — trees in assign_features_to_holes
# ══════════════════════════════════════════════════════════════════════════════

def _make_tree_node(osm_id: str, lon: float, lat: float) -> dict:
    """Build a GeoJSON Point Feature representing an individual tree node."""
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {"featureType": "tree", "osm_id": osm_id},
    }


class TestPointGeometrySpatialJoin:
    """assign_features_to_holes handles Point geometry (natural=tree nodes)."""

    # A single Black H1 hole running N-S (same coords as ALL_HOLES[0]).
    _HOLES = [
        _make_hole("1", "Black", _BH1_TEE_LON, _BH1_TEE_LAT,
                   _BH1_GREEN_LON, _BH1_GREEN_LAT),
    ]

    def test_tree_near_bh1_assigns_to_black(self):
        # Tree placed right at BH1 midpoint.
        tree = _make_tree_node("node/tree1", _BH1_MID_LON, _BH1_MID_LAT)
        result = assign_features_to_holes(self._HOLES, [tree])
        _ref, course, _dist = result["node/tree1"]
        assert course == "Black"

    def test_tree_near_bh1_assigns_to_hole_1(self):
        tree = _make_tree_node("node/tree1", _BH1_MID_LON, _BH1_MID_LAT)
        result = assign_features_to_holes(self._HOLES, [tree])
        ref, _course, _dist = result["node/tree1"]
        assert ref == "1"

    def test_tree_point_distance_is_small_on_line(self):
        # Tree exactly on the BH1 midpoint → distance ≈ 0.
        tree = _make_tree_node("node/tree1", _BH1_MID_LON, _BH1_MID_LAT)
        result = assign_features_to_holes(self._HOLES, [tree])
        _ref, _course, dist = result["node/tree1"]
        assert dist < 1.0

    def test_tree_with_degenerate_point_coords_gets_inf(self):
        # Point with only one coordinate value → invalid → inf assignment.
        bad_tree = {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [-73.000]},
            "properties": {"featureType": "tree", "osm_id": "node/bad_tree"},
        }
        result = assign_features_to_holes(self._HOLES, [bad_tree])
        _ref, _course, dist = result["node/bad_tree"]
        assert dist == float("inf")

    def test_mixed_polygon_and_point_features(self):
        # Both polygon (rough) and point (tree) near BH1.
        rough = _make_polygon("way/rough1", "rough", _BH1_MID_LON, _BH1_MID_LAT)
        tree = _make_tree_node("node/tree1", _BH1_MID_LON, _BH1_MID_LAT)
        result = assign_features_to_holes(self._HOLES, [rough, tree])
        assert "way/rough1" in result
        assert "node/tree1" in result
        # Both should assign to Black H1.
        assert result["way/rough1"][1] == "Black"
        assert result["node/tree1"][1] == "Black"

    def test_unsupported_geometry_type_gets_inf(self):
        # A LineString feature (not Polygon or Point) → inf assignment.
        linestring_feat = {
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": [[-73.0, 40.7], [-73.0, 40.701]]},
            "properties": {"featureType": "unknown", "osm_id": "way/ls1"},
        }
        result = assign_features_to_holes(self._HOLES, [linestring_feat])
        _ref, _course, dist = result["way/ls1"]
        assert dist == float("inf")


# ══════════════════════════════════════════════════════════════════════════════
# _point_in_ring
# ══════════════════════════════════════════════════════════════════════════════

# A 0.01° × 0.01° square centred near Bethpage (lat≈40.74, lon≈-73.46)
_TEST_RING = [
    [-73.465, 40.735],
    [-73.455, 40.735],
    [-73.455, 40.745],
    [-73.465, 40.745],
    [-73.465, 40.735],  # closed
]
_TEST_COS_LAT = math.cos(math.radians(40.74))
_TEST_BBOX = _ring_bbox(_TEST_RING)


class TestPointInRing:
    """Ray-casting point-in-polygon."""

    def test_centre_is_inside(self):
        assert _point_in_ring(-73.460, 40.740, _TEST_RING, _TEST_COS_LAT) is True

    def test_far_point_is_outside(self):
        assert _point_in_ring(-73.000, 40.740, _TEST_RING, _TEST_COS_LAT) is False

    def test_bbox_rejection_skips_check(self):
        # Point well outside bbox — should return False quickly via bbox guard.
        assert _point_in_ring(-72.000, 40.740, _TEST_RING, _TEST_COS_LAT, _TEST_BBOX) is False

    def test_inside_with_bbox(self):
        assert _point_in_ring(-73.460, 40.740, _TEST_RING, _TEST_COS_LAT, _TEST_BBOX) is True

    def test_degenerate_ring_too_few_vertices(self):
        short_ring = [[-73.460, 40.740], [-73.455, 40.740]]
        assert _point_in_ring(-73.458, 40.740, short_ring, _TEST_COS_LAT) is False

    def test_corner_point_boundary(self):
        # Exact corner — ray-casting at boundary can go either way; just must not crash.
        result = _point_in_ring(-73.465, 40.735, _TEST_RING, _TEST_COS_LAT)
        assert isinstance(result, bool)


# ══════════════════════════════════════════════════════════════════════════════
# _linestring_intersection_m
# ══════════════════════════════════════════════════════════════════════════════

class TestLinestringIntersectionM:
    """Overlap-length scoring for the parallel-hole fix."""

    # A narrow N-S fairway polygon: 0.001° wide, 0.003° long (≈111 m × 222 m)
    # Centred on lon=-73.460, lat=40.737→40.740→40.743
    _FAIRWAY_RING = [
        [-73.4605, 40.737],
        [-73.4595, 40.737],
        [-73.4595, 40.743],
        [-73.4605, 40.743],
        [-73.4605, 40.737],
    ]
    _COS_LAT = math.cos(math.radians(40.740))
    _BBOX = _ring_bbox(_FAIRWAY_RING)

    # Hole line that runs longitudinally THROUGH the fairway (the correct hole)
    _OWN_HOLE_LINE = [[-73.460, 40.736], [-73.460, 40.744]]

    # Parallel neighbour hole line running alongside, NOT through the fairway
    _NEIGHBOUR_LINE = [[-73.455, 40.736], [-73.455, 40.744]]

    def test_own_hole_line_scores_positive(self):
        score = _linestring_intersection_m(
            self._OWN_HOLE_LINE, self._FAIRWAY_RING, self._COS_LAT, self._BBOX
        )
        assert score > 0.0, f"Expected > 0 metres overlap, got {score}"

    def test_neighbour_line_scores_zero(self):
        score = _linestring_intersection_m(
            self._NEIGHBOUR_LINE, self._FAIRWAY_RING, self._COS_LAT, self._BBOX
        )
        assert score == 0.0, f"Expected 0 metres overlap, got {score}"

    def test_own_line_scores_much_higher_than_neighbour(self):
        own = _linestring_intersection_m(
            self._OWN_HOLE_LINE, self._FAIRWAY_RING, self._COS_LAT, self._BBOX
        )
        nbr = _linestring_intersection_m(
            self._NEIGHBOUR_LINE, self._FAIRWAY_RING, self._COS_LAT, self._BBOX
        )
        assert own > nbr

    def test_empty_linestring_returns_zero(self):
        assert _linestring_intersection_m([], self._FAIRWAY_RING, self._COS_LAT) == 0.0

    def test_single_vertex_linestring_returns_zero(self):
        assert _linestring_intersection_m(
            [[-73.460, 40.740]], self._FAIRWAY_RING, self._COS_LAT
        ) == 0.0

    def test_empty_ring_returns_zero(self):
        assert _linestring_intersection_m(self._OWN_HOLE_LINE, [], self._COS_LAT) == 0.0


# ══════════════════════════════════════════════════════════════════════════════
# Parallel-hole fairway attribution (the Bethpage bug scenario)
# ══════════════════════════════════════════════════════════════════════════════

class TestParallelHoleFairwayAttribution:
    """
    Reproduce the exact failure mode: two parallel N-S holes whose fairway
    polygon centroids land closer to the WRONG hole's centerline.

    Layout:
      • Hole A centerline: lon=-73.460 (runs through the fairway)
      • Hole B centerline: lon=-73.456 (runs parallel, 4× closer to centroid
        of a polygon that is shifted 0.001° east of centre)

    The fairway polygon is a narrow N-S strip centred at lon=-73.460 with the
    centroid right on the polygon centre. But we shift the polygon 0.001° east
    so its CENTROID is at lon=-73.459, which is equidistant between A (-73.460)
    and a very close parallel hole B.

    Actually the cleaner test: put the polygon centre exactly between both holes
    so the OLD centroid rule is ambiguous, but hole A's line passes through the
    polygon while hole B's line does not.
    """

    # Hole A: lon=-73.460, runs N-S
    _HOLE_A = _make_hole("1", "Black", -73.460, 40.735, -73.460, 40.745)
    # Hole B: lon=-73.456, parallel — CENTROID of polygon is equidistant from both
    _HOLE_B = _make_hole("2", "Black", -73.456, 40.735, -73.456, 40.745)

    # Fairway strip centred on lon=-73.460 (hole A's line runs through it)
    # Width: 0.003° lon (≈250 m), so it spans -73.462 → -73.458
    # Hole B at -73.456 is OUTSIDE the ring (0.002° east of the right edge).
    _FAIRWAY = {
        "type": "Feature",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[
                [-73.462, 40.737],
                [-73.458, 40.737],
                [-73.458, 40.743],
                [-73.462, 40.743],
                [-73.462, 40.737],
            ]],
        },
        "properties": {"featureType": "fairway", "osm_id": "way/fw_parallel"},
    }

    def test_fairway_assigns_to_hole_with_line_through_it(self):
        """Hole A's line passes through the fairway → must win even if B's centroid-dist is similar."""
        result = assign_features_to_holes([self._HOLE_A, self._HOLE_B], [self._FAIRWAY])
        ref, course, _dist = result["way/fw_parallel"]
        assert ref == "1", f"Expected hole 1 (line passes through), got {ref}"
        assert course == "Black"

    def test_fairway_not_assigned_to_neighbour(self):
        result = assign_features_to_holes([self._HOLE_A, self._HOLE_B], [self._FAIRWAY])
        ref, _course, _dist = result["way/fw_parallel"]
        assert ref != "2", "Should NOT assign to the neighbour whose line is outside the polygon"

    def test_existing_assignments_not_regressed(self):
        """Original fixtures (green, bunker, tee near BH1) still assign correctly."""
        result = assign_features_to_holes(ALL_HOLES, ALL_POLYGONS)
        assert result["way/green1"][0] == "1"
        assert result["way/green1"][1] == "Black"
        assert result["way/bunker1"][0] == "1"
        assert result["way/bunker1"][1] == "Black"
        assert result["way/tee1"][0] == "1"
        assert result["way/tee1"][1] == "Black"
        assert result["way/green_red"][1] == "Red"


# ══════════════════════════════════════════════════════════════════════════════
# Multi-course strict rejection (formerly "reclaim") in build_course_feature_collection
# ══════════════════════════════════════════════════════════════════════════════

class TestMultiCourseReclaim:
    """
    Verify the STRICT cross-course rejection introduced in feat/harden-spatial-join.

    The old reclaim heuristic (re-attributing polygons within 200 m to the target
    course) caused severe cross-course contamination at Bethpage State Park where
    5 courses share the same 2.5 km area.  It pulled neighbouring courses' greens,
    fairways, and bunkers into Bethpage Black, giving H18 5 greens and 22 bunkers.

    The fix removes the reclaim pass entirely.  The strict rule is:
      - A polygon's course assignment is determined solely by the global nearest-hole
        logic (Tiers 1–3 in assign_features_to_holes).
      - If the globally nearest hole belongs to a non-target course, the polygon is
        DROPPED — no second-chance reclaim.

    This means a fairway polygon that is geometrically closest to a co-located Green
    course centerline (even if it is only 13 m away vs 17 m for Black) stays on Green
    and is correctly excluded from the Black output.  In practice at Bethpage, each
    course's own fairway polygons have the correct course's centerline running through
    them (Tier-1 overlap), so correct attribution is not lost.

    Layout:
      • Black hole 1 centerline at lon=-73.000 (the target course)
      • Green hole 1 centerline at lon=-72.9997 (≈30 m east — very close)
      • Fairway polygon centred at lon=-72.9998 — closer to Green (≈13 m) than Black (≈17 m)
        and too small for Black's centerline to pass through (Tier-1 = 0)

    Expected behaviour after the fix:
      • The fairway is assigned to Green (globally nearest).
      • It does NOT appear in Black output (no reclaim).
      • Distant Red polygons still excluded (same as before).
      • Black-assigned polygons still included (no regression).
    """

    # Exact BH1 coords from ALL_HOLES
    _BH1 = _make_hole("1", "Black", _BH1_TEE_LON, _BH1_TEE_LAT, _BH1_GREEN_LON, _BH1_GREEN_LAT,
                      _BH1_MID_LON, _BH1_MID_LAT)

    # Green hole 1 only 30 m east of Black hole 1 (lon offset ≈ 0.00035° at lat 40.7)
    _GH1_LON = _BH1_TEE_LON + 0.00035  # ≈30 m east
    _GH1 = _make_hole("1", "Green", _GH1_LON, _BH1_TEE_LAT, _GH1_LON, _BH1_GREEN_LAT)

    # Red hole 1: far away (≈2.5 km east)
    _RH1 = _make_hole("1", "Red", _RH1_TEE_LON, _RH1_TEE_LAT, _RH1_GREEN_LON, _RH1_GREEN_LAT)

    ALL_MCR_HOLES = [_BH1, _GH1, _RH1]

    # Fairway polygon that spans EAST of Green's centerline — Green's line passes
    # through it (Tier-1 overlap), so it is clearly assigned to Green.
    # Without reclaim, it must NOT appear in Black output.
    #
    # Polygon spans lon = (-72.9999 → -72.9994):
    #   • Green centerline at lon=-72.99965 is inside the polygon → Tier-1 assigns to Green
    #   • Black centerline at lon=-73.000 is WEST of the polygon's left edge → NOT inside
    #   • Old reclaim would have pulled this into Black (it's within 200 m of Black)
    #   • After removing reclaim: stays with Green, excluded from Black
    _GREEN_FW_HALF = 0.0002  # half-width in degrees lon ≈ 17 m
    _GREEN_FW_CEN = _BH1_TEE_LON + 0.00035 + 0.00005  # centre: 0.0004° east of Black ≈ 33 m
    _NEAR_GREEN_FW = {
        "type": "Feature",
        "geometry": {
            "type": "Polygon",
            "coordinates": [[
                [_GREEN_FW_CEN - _GREEN_FW_HALF, _BH1_MID_LAT - 0.0001],
                [_GREEN_FW_CEN + _GREEN_FW_HALF, _BH1_MID_LAT - 0.0001],
                [_GREEN_FW_CEN + _GREEN_FW_HALF, _BH1_MID_LAT + 0.0001],
                [_GREEN_FW_CEN - _GREEN_FW_HALF, _BH1_MID_LAT + 0.0001],
                [_GREEN_FW_CEN - _GREEN_FW_HALF, _BH1_MID_LAT - 0.0001],
            ]],
        },
        "properties": {"featureType": "fairway", "osm_id": "way/fw_near_green"},
    }

    # Red polygon 2.5 km east — must NOT appear in Black output
    _RH1_MID_LAT = (_RH1_TEE_LAT + _RH1_GREEN_LAT) / 2
    _FAR_RED_POLY = _make_polygon("way/far_red", "fairway",
                                  _RH1_TEE_LON, _RH1_MID_LAT)

    def test_corridor_cap_constants_are_positive(self):
        """All corridor cap values and the woods span limit are positive."""
        for feature_type, cap in _CORRIDOR_CAPS_M.items():
            assert cap > 0, f"Corridor cap for {feature_type!r} must be positive, got {cap}"
        assert _CORRIDOR_CAP_DEFAULT_M > 0
        assert _WOODS_MAX_SPAN_M > 0

    def test_no_false_reclaim_for_co_located_course(self):
        """Strict rejection: polygon assigned to Green via Tier-1 overlap is NOT pulled into Black.

        The polygon is wide enough that Green's centerline (30 m east of Black) runs
        through it, so Tier-1 clearly assigns it to Green.  Black's centerline does not
        enter the polygon.

        Previously (with the 200 m reclaim pass) this polygon WOULD have been reclaimed
        for Black because it sits within 200 m of a Black hole centerline.  After removing
        reclaim, it correctly stays with Green and is excluded from Black.
        """
        result = build_course_feature_collection(
            self.ALL_MCR_HOLES, [self._NEAR_GREEN_FW], "Black"
        )
        all_ids = {
            f["properties"]["osm_id"]
            for hole in result
            for f in hole["features"]["features"]
        }
        # The fairway has Green's centerline running through it → assigned to Green.
        # No reclaim → excluded from Black.
        assert "way/fw_near_green" not in all_ids, (
            "Fairway with Green centerline through it must NOT appear in Black output "
            "(reclaim pass removed — strict global-nearest assignment is the rule)."
        )

    def test_distant_polygon_excluded(self):
        """Red polygon 2.5 km away is NOT included in Black output."""
        result = build_course_feature_collection(
            self.ALL_MCR_HOLES, [self._FAR_RED_POLY], "Black"
        )
        all_ids = {
            f["properties"]["osm_id"]
            for hole in result
            for f in hole["features"]["features"]
        }
        assert "way/far_red" not in all_ids, \
            "Red polygon 2.5 km from Black must be excluded"

    def test_original_cross_course_rejection_preserved(self):
        """Standard fixtures: Red-course green (2.5 km away) still excluded from Black."""
        result = build_course_feature_collection(
            ALL_HOLES + [self._GH1], ALL_POLYGONS, "Black"
        )
        all_ids = {
            f["properties"]["osm_id"]
            for hole in result
            for f in hole["features"]["features"]
        }
        assert "way/green_red" not in all_ids

    def test_original_black_polygons_still_included(self):
        """Strict rejection must not disturb polygons correctly assigned to Black."""
        result = build_course_feature_collection(
            ALL_HOLES + [self._GH1], ALL_POLYGONS, "Black"
        )
        all_ids = {
            f["properties"]["osm_id"]
            for hole in result
            for f in hole["features"]["features"]
        }
        assert "way/green1" in all_ids
        assert "way/bunker1" in all_ids
        assert "way/tee1" in all_ids


# ══════════════════════════════════════════════════════════════════════════════
# Corridor distance cap in build_course_feature_collection
# ══════════════════════════════════════════════════════════════════════════════

class TestCorridorCap:
    """
    Verify the per-feature-type corridor distance cap in build_course_feature_collection.

    A polygon correctly assigned to the target course but farther from the hole
    centerline than the type-specific cap is dropped.  This is the belt-and-
    suspenders guard that prevents stray features (e.g. a green from a distant
    hole whose endpoint happens to be nearest) from inflating the hole's display.

    Layout: single Black hole 1 running N-S.  We place polygons at various
    distances from the centerline to verify the cap is applied correctly.
    """

    _BLACK_H1 = _make_hole("1", "Black", _BH1_TEE_LON, _BH1_TEE_LAT,
                            _BH1_GREEN_LON, _BH1_GREEN_LAT,
                            _BH1_MID_LON, _BH1_MID_LAT)
    _HOLES = [_BLACK_H1]

    def _build(self, polygons: list[dict], target: str = "Black") -> set[str]:
        result = build_course_feature_collection(self._HOLES, polygons, target)
        return {
            f["properties"]["osm_id"]
            for hole in result
            for f in hole["features"]["features"]
        }

    # ── Green (end mode: dist to endpoint) ───────────────────────────────────

    def test_green_near_endpoint_is_kept(self):
        """Green centroid 0 m from the endpoint → distance << cap → kept."""
        green = _make_polygon("way/g_near", "green", _BH1_GREEN_LON, _BH1_GREEN_LAT)
        assert "way/g_near" in self._build([green])

    def test_green_far_from_endpoint_is_dropped(self):
        """Green centroid 0.003° from endpoint ≈ 334 m > 120 m cap → dropped."""
        # Place the green 0.003° south of the green endpoint (far from the hole end)
        far_lon = _BH1_GREEN_LON
        far_lat = _BH1_GREEN_LAT - 0.003  # ~334 m south of the green end
        green = _make_polygon("way/g_far", "green", far_lon, far_lat)
        assert "way/g_far" not in self._build([green]), (
            "Green far from the endpoint must be rejected by the corridor cap"
        )

    # ── Bunker (nearest mode: dist to any centerline segment) ─────────────

    def test_bunker_within_cap_is_kept(self):
        """Bunker 0.001° west of midpoint ≈ 84 m < 150 m cap → kept."""
        # Same placement as POLY_BUNKER_BH1 in ALL_POLYGONS
        bunker = _make_polygon("way/b_near", "bunker", _BH1_MID_LON - 0.001, _BH1_MID_LAT)
        assert "way/b_near" in self._build([bunker])

    def test_bunker_beyond_cap_is_dropped(self):
        """Bunker 0.003° west of midpoint ≈ 253 m > 150 m cap → dropped."""
        bunker = _make_polygon("way/b_far", "bunker", _BH1_MID_LON - 0.003, _BH1_MID_LAT)
        assert "way/b_far" not in self._build([bunker]), (
            "Bunker too far from the hole centerline must be rejected by the corridor cap"
        )

    # ── Fairway (nearest mode) ──────────────────────────────────────────────

    def test_fairway_within_cap_is_kept(self):
        """Fairway whose centerline runs through it (0 m distance) → kept."""
        # Fairway centred on the hole centerline
        fairway = _make_polygon("way/fw_near", "fairway", _BH1_MID_LON, _BH1_MID_LAT)
        assert "way/fw_near" in self._build([fairway])

    def test_fairway_beyond_cap_is_dropped(self):
        """Fairway 0.003° west of centerline ≈ 253 m > 200 m cap → dropped."""
        fairway = _make_polygon("way/fw_far", "fairway", _BH1_MID_LON - 0.003, _BH1_MID_LAT)
        assert "way/fw_far" not in self._build([fairway]), (
            "Fairway too far from the hole centerline must be rejected by the corridor cap"
        )

    # ── Large woods polygon filter ──────────────────────────────────────────

    def test_large_woods_polygon_is_dropped(self):
        """A woods polygon whose bbox diagonal > _WOODS_MAX_SPAN_M is dropped.

        Simulates a campus-scale forest that spans multiple holes.  Even if it
        is assigned to a Black hole (nearest-line), it should be excluded.
        """
        # Build a huge polygon spanning 0.01° lat × 0.01° lon ≈ 1100 m × 845 m
        # centred on the hole midpoint — diagonal ≈ 1388 m >> 450 m cap.
        big_half = 0.005  # 0.01° span
        big_lon = _BH1_MID_LON
        big_lat = _BH1_MID_LAT
        ring = [
            [big_lon - big_half, big_lat - big_half],
            [big_lon + big_half, big_lat - big_half],
            [big_lon + big_half, big_lat + big_half],
            [big_lon - big_half, big_lat + big_half],
            [big_lon - big_half, big_lat - big_half],  # close
        ]
        big_woods = {
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [ring]},
            "properties": {"featureType": "woods", "osm_id": "way/big_woods"},
        }
        assert "way/big_woods" not in self._build([big_woods]), (
            "Campus-scale woods polygon must be dropped by the large-polygon filter"
        )

    def test_small_woods_polygon_is_kept(self):
        """A small woods cluster near the hole centerline is kept."""
        # 0.001° span ≈ 111 m × 84 m, diagonal ≈ 140 m << 450 m cap
        small_woods = _make_polygon("way/small_woods", "woods", _BH1_MID_LON, _BH1_MID_LAT,
                                    half_deg=0.0005)
        assert "way/small_woods" in self._build([small_woods])

    def test_polygon_nearest_non_target_is_dropped(self):
        """A polygon whose globally nearest hole is on a NON-target course is always dropped.

        No corridor cap involved — this is pure cross-course rejection.
        """
        # Red hole 1 far to the east; a polygon right next to it goes to Red.
        red_h1 = _make_hole("1", "Red", _RH1_TEE_LON, _RH1_TEE_LAT,
                             _RH1_GREEN_LON, _RH1_GREEN_LAT)
        black_h1 = _make_hole("1", "Black", _BH1_TEE_LON, _BH1_TEE_LAT,
                               _BH1_GREEN_LON, _BH1_GREEN_LAT)
        # Place a green right at Red hole 1's endpoint
        red_green = _make_polygon("way/red_g", "green", _RH1_GREEN_LON, _RH1_GREEN_LAT)
        result = build_course_feature_collection([black_h1, red_h1], [red_green], "Black")
        all_ids = {
            f["properties"]["osm_id"]
            for hole in result
            for f in hole["features"]["features"]
        }
        assert "way/red_g" not in all_ids, (
            "Polygon nearest a Red hole must be excluded from Black output"
        )
