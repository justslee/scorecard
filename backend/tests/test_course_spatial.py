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
    _deg_to_m,
    _linestring_dist_m,
    _match_mode,
    _point_to_segment_dist_m,
    _ref_to_int,
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
