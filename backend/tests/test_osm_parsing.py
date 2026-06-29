"""Unit tests for OSM Overpass JSON → GeoJSON parsing — pure, no network, no DB.

Covers _parse_way_to_polygon, _parse_way_to_linestring, and
_parse_course_geometry_response from app.services.osm.
"""

from app.services.osm import (
    _parse_course_geometry_response,
    _parse_way_to_linestring,
    _parse_way_to_polygon,
)


# ── Fixture: small Overpass JSON response ──────────────────────────────────────
#
# Contains:
#   - Hole 1 on "Black" course (ref=1, par=4, handicap=7, 3-point linestring)
#   - Hole 1 on "Red" course  (ref=1, par=5, handicap=3) — same spatial area
#   - A green polygon (5-point, already closed ring)
#   - A bunker polygon (4-point, open — parser must close it)
#   - A node (non-way) to confirm it is silently skipped
#
_FIXTURE: dict = {
    "elements": [
        {
            "type": "way",
            "id": 100001,
            "tags": {
                "golf": "hole",
                "golf:course:name": "Black",
                "ref": "1",
                "par": "4",
                "handicap": "7",
                "name": "Hole 1",
            },
            "geometry": [
                {"lat": 40.7128, "lon": -73.0060},
                {"lat": 40.7130, "lon": -73.0058},
                {"lat": 40.7132, "lon": -73.0055},
            ],
        },
        {
            "type": "way",
            "id": 100002,
            "tags": {
                "golf": "hole",
                "golf:course:name": "Red",
                "ref": "1",
                "par": "5",
                "handicap": "3",
                "name": "Hole 1 Red",
            },
            "geometry": [
                {"lat": 40.7200, "lon": -73.0100},
                {"lat": 40.7202, "lon": -73.0098},
                {"lat": 40.7204, "lon": -73.0095},
            ],
        },
        # Green: 5-point ring, already closed (first == last)
        {
            "type": "way",
            "id": 200001,
            "tags": {"golf": "green"},
            "geometry": [
                {"lat": 40.7132, "lon": -73.0055},
                {"lat": 40.7133, "lon": -73.0054},
                {"lat": 40.7132, "lon": -73.0053},
                {"lat": 40.7131, "lon": -73.0054},
                {"lat": 40.7132, "lon": -73.0055},
            ],
        },
        # Bunker: 4-point ring, open (parser must close it)
        {
            "type": "way",
            "id": 300001,
            "tags": {"golf": "bunker"},
            "geometry": [
                {"lat": 40.7125, "lon": -73.0058},
                {"lat": 40.7126, "lon": -73.0057},
                {"lat": 40.7125, "lon": -73.0056},
                {"lat": 40.7124, "lon": -73.0057},
            ],
        },
        # Node — must be ignored by the parser (ways only)
        {
            "type": "node",
            "id": 999999,
            "tags": {"golf": "pin"},
            "lat": 40.7132,
            "lon": -73.0055,
        },
    ]
}


# ── _parse_way_to_polygon ─────────────────────────────────────────────────────

class TestParseWayToPolygon:
    """Full ring geometry is produced; degenerate inputs return None."""

    def test_valid_4_point_open_ring_returns_polygon(self):
        geom = [
            {"lat": 0.0, "lon": 0.0},
            {"lat": 0.0, "lon": 1.0},
            {"lat": 1.0, "lon": 1.0},
            {"lat": 1.0, "lon": 0.0},
        ]
        result = _parse_way_to_polygon(geom)
        assert result is not None
        assert result["type"] == "Polygon"

    def test_open_ring_is_closed(self):
        geom = [
            {"lat": 0.0, "lon": 0.0},
            {"lat": 0.0, "lon": 1.0},
            {"lat": 1.0, "lon": 1.0},
            {"lat": 1.0, "lon": 0.0},
        ]
        ring = _parse_way_to_polygon(geom)["coordinates"][0]
        # First == last after auto-close
        assert ring[0] == ring[-1]
        # Total points = 5 (4 unique + closing repeat)
        assert len(ring) == 5

    def test_already_closed_ring_not_doubled(self):
        # 5-point ring where first == last
        geom = [
            {"lat": 0.0, "lon": 0.0},
            {"lat": 0.0, "lon": 1.0},
            {"lat": 1.0, "lon": 1.0},
            {"lat": 1.0, "lon": 0.0},
            {"lat": 0.0, "lon": 0.0},
        ]
        ring = _parse_way_to_polygon(geom)["coordinates"][0]
        assert len(ring) == 5  # no extra point added

    def test_coordinates_are_lon_lat_order(self):
        geom = [
            {"lat": 10.0, "lon": 20.0},
            {"lat": 10.0, "lon": 21.0},
            {"lat": 11.0, "lon": 21.0},
            {"lat": 11.0, "lon": 20.0},
        ]
        ring = _parse_way_to_polygon(geom)["coordinates"][0]
        # GeoJSON = [lon, lat]
        assert ring[0] == [20.0, 10.0]

    def test_fewer_than_4_points_returns_none(self):
        geom = [
            {"lat": 0.0, "lon": 0.0},
            {"lat": 0.0, "lon": 1.0},
            {"lat": 1.0, "lon": 1.0},
        ]
        assert _parse_way_to_polygon(geom) is None

    def test_empty_geom_returns_none(self):
        assert _parse_way_to_polygon([]) is None


# ── _parse_way_to_linestring ──────────────────────────────────────────────────

class TestParseWayToLinestring:
    """LineString from a sequence of points; degenerate inputs return None."""

    def test_valid_linestring(self):
        geom = [
            {"lat": 40.7128, "lon": -73.0060},
            {"lat": 40.7130, "lon": -73.0058},
            {"lat": 40.7132, "lon": -73.0055},
        ]
        result = _parse_way_to_linestring(geom)
        assert result is not None
        assert result["type"] == "LineString"
        assert len(result["coordinates"]) == 3

    def test_coordinates_are_lon_lat_order(self):
        geom = [
            {"lat": 10.0, "lon": 20.0},
            {"lat": 11.0, "lon": 21.0},
        ]
        coords = _parse_way_to_linestring(geom)["coordinates"]
        assert coords[0] == [20.0, 10.0]
        assert coords[1] == [21.0, 11.0]

    def test_single_point_returns_none(self):
        assert _parse_way_to_linestring([{"lat": 0.0, "lon": 0.0}]) is None

    def test_empty_geom_returns_none(self):
        assert _parse_way_to_linestring([]) is None


# ── _parse_course_geometry_response ──────────────────────────────────────────

class TestParseCourseGeometryResponse:
    """Overpass JSON → categorized GeoJSON Feature lists."""

    # ── result keys ───────────────────────────────────────────────────────────

    def test_returns_all_expected_keys(self):
        result = _parse_course_geometry_response(_FIXTURE)
        assert set(result.keys()) == {"holes", "greens", "fairways", "tees", "bunkers", "water"}

    # ── no-filter behaviour ───────────────────────────────────────────────────

    def test_no_filter_includes_all_holes(self):
        result = _parse_course_geometry_response(_FIXTURE)
        assert len(result["holes"]) == 2

    def test_no_filter_greens_count(self):
        result = _parse_course_geometry_response(_FIXTURE)
        assert len(result["greens"]) == 1

    def test_no_filter_bunkers_count(self):
        result = _parse_course_geometry_response(_FIXTURE)
        assert len(result["bunkers"]) == 1

    def test_node_is_ignored(self):
        # The fixture has one node (golf=pin); it must not appear anywhere.
        result = _parse_course_geometry_response(_FIXTURE)
        all_features = (
            result["holes"] + result["greens"] + result["fairways"]
            + result["tees"] + result["bunkers"] + result["water"]
        )
        assert all(f["properties"]["osm_id"].startswith("way/") for f in all_features)

    # ── course-name filter ────────────────────────────────────────────────────

    def test_filter_black_returns_only_black_hole(self):
        result = _parse_course_geometry_response(_FIXTURE, course_name_filter="Black")
        assert len(result["holes"]) == 1
        assert result["holes"][0]["properties"]["ref"] == "1"
        assert result["holes"][0]["properties"]["par"] == 4

    def test_filter_red_returns_only_red_hole(self):
        result = _parse_course_geometry_response(_FIXTURE, course_name_filter="Red")
        assert len(result["holes"]) == 1
        assert result["holes"][0]["properties"]["par"] == 5

    def test_filter_is_case_insensitive(self):
        upper = _parse_course_geometry_response(_FIXTURE, course_name_filter="BLACK")
        lower = _parse_course_geometry_response(_FIXTURE, course_name_filter="black")
        assert len(upper["holes"]) == len(lower["holes"]) == 1

    def test_filter_nonexistent_course_yields_no_holes(self):
        result = _parse_course_geometry_response(_FIXTURE, course_name_filter="Blue")
        assert result["holes"] == []

    def test_filter_does_not_affect_polygon_features(self):
        # Greens and bunkers are not filtered by course name.
        result = _parse_course_geometry_response(_FIXTURE, course_name_filter="Black")
        assert len(result["greens"]) == 1
        assert len(result["bunkers"]) == 1

    # ── hole properties ───────────────────────────────────────────────────────

    def test_hole_par_parsed_as_int(self):
        result = _parse_course_geometry_response(_FIXTURE, course_name_filter="Black")
        hole = result["holes"][0]
        assert hole["properties"]["par"] == 4
        assert isinstance(hole["properties"]["par"], int)

    def test_hole_handicap_parsed_as_int(self):
        result = _parse_course_geometry_response(_FIXTURE, course_name_filter="Black")
        hole = result["holes"][0]
        assert hole["properties"]["handicap"] == 7
        assert isinstance(hole["properties"]["handicap"], int)

    def test_hole_ref_is_string(self):
        result = _parse_course_geometry_response(_FIXTURE, course_name_filter="Black")
        hole = result["holes"][0]
        assert hole["properties"]["ref"] == "1"

    def test_hole_name_present(self):
        result = _parse_course_geometry_response(_FIXTURE, course_name_filter="Black")
        hole = result["holes"][0]
        assert hole["properties"]["name"] == "Hole 1"

    def test_hole_feature_type_tag(self):
        result = _parse_course_geometry_response(_FIXTURE, course_name_filter="Black")
        assert result["holes"][0]["properties"]["featureType"] == "hole"

    def test_hole_osm_id_format(self):
        result = _parse_course_geometry_response(_FIXTURE, course_name_filter="Black")
        assert result["holes"][0]["properties"]["osm_id"] == "way/100001"

    # ── hole geometry ─────────────────────────────────────────────────────────

    def test_hole_geometry_is_linestring(self):
        result = _parse_course_geometry_response(_FIXTURE, course_name_filter="Black")
        assert result["holes"][0]["geometry"]["type"] == "LineString"

    def test_hole_linestring_coordinate_count(self):
        result = _parse_course_geometry_response(_FIXTURE, course_name_filter="Black")
        coords = result["holes"][0]["geometry"]["coordinates"]
        assert len(coords) == 3

    # ── polygon geometry ──────────────────────────────────────────────────────

    def test_green_geometry_is_polygon(self):
        result = _parse_course_geometry_response(_FIXTURE)
        assert result["greens"][0]["geometry"]["type"] == "Polygon"

    def test_green_ring_is_closed(self):
        result = _parse_course_geometry_response(_FIXTURE)
        ring = result["greens"][0]["geometry"]["coordinates"][0]
        assert ring[0] == ring[-1]

    def test_bunker_open_ring_is_auto_closed(self):
        # Fixture bunker has 4 open points; after parsing ring must be 5 points, closed.
        result = _parse_course_geometry_response(_FIXTURE)
        ring = result["bunkers"][0]["geometry"]["coordinates"][0]
        assert ring[0] == ring[-1]
        assert len(ring) == 5

    def test_polygon_feature_type_tag(self):
        result = _parse_course_geometry_response(_FIXTURE)
        assert result["greens"][0]["properties"]["featureType"] == "green"
        assert result["bunkers"][0]["properties"]["featureType"] == "bunker"

    # ── GeoJSON Feature wrapper ───────────────────────────────────────────────

    def test_all_features_have_type_feature(self):
        result = _parse_course_geometry_response(_FIXTURE)
        for key in ("holes", "greens", "bunkers"):
            for feat in result[key]:
                assert feat["type"] == "Feature"

    def test_all_features_have_geometry_and_properties(self):
        result = _parse_course_geometry_response(_FIXTURE)
        for key in ("holes", "greens", "bunkers"):
            for feat in result[key]:
                assert "geometry" in feat
                assert "properties" in feat
