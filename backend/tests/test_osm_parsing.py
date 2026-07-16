"""Unit tests for OSM Overpass JSON → GeoJSON parsing — pure, no network, no DB.

Covers _parse_way_to_polygon, _parse_way_to_linestring, and
_parse_course_geometry_response from app.services.osm.
"""

import pytest

from app.services.osm import (
    _parse_course_geometry_response,
    _parse_relation_to_multipolygon,
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
        # API extended to include terrain feature types: rough, woods, trees.
        result = _parse_course_geometry_response(_FIXTURE)
        assert set(result.keys()) == {
            "holes", "greens", "fairways", "tees", "bunkers", "water",
            "rough", "woods", "trees",
        }

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


# ── Terrain features: rough, woods, trees ─────────────────────────────────────
#
# Extended fixture adding:
#   - A golf=rough polygon (4-point open ring)
#   - A natural=wood polygon (5-point closed ring)
#   - A landuse=forest polygon
#   - A natural=scrub polygon
#   - A natural=tree_row CLOSED polygon (4+ pts, closed → parsed as Polygon)
#   - A natural=tree_row OPEN way (3 pts only → skipped by _parse_way_to_polygon)
#   - A natural=tree node → Point feature in "trees"
#   - A golf=pin node (NOT a tree) → still ignored
#
_TERRAIN_FIXTURE: dict = {
    "elements": [
        # golf=rough way (4-point open ring)
        {
            "type": "way",
            "id": 400001,
            "tags": {"golf": "rough"},
            "geometry": [
                {"lat": 40.7120, "lon": -73.0060},
                {"lat": 40.7121, "lon": -73.0055},
                {"lat": 40.7119, "lon": -73.0050},
                {"lat": 40.7118, "lon": -73.0055},
            ],
        },
        # natural=wood polygon (5-point closed ring)
        {
            "type": "way",
            "id": 400002,
            "tags": {"natural": "wood"},
            "geometry": [
                {"lat": 40.7130, "lon": -73.0070},
                {"lat": 40.7131, "lon": -73.0065},
                {"lat": 40.7129, "lon": -73.0060},
                {"lat": 40.7128, "lon": -73.0065},
                {"lat": 40.7130, "lon": -73.0070},
            ],
        },
        # landuse=forest polygon
        {
            "type": "way",
            "id": 400003,
            "tags": {"landuse": "forest"},
            "geometry": [
                {"lat": 40.7140, "lon": -73.0080},
                {"lat": 40.7141, "lon": -73.0075},
                {"lat": 40.7139, "lon": -73.0070},
                {"lat": 40.7138, "lon": -73.0075},
            ],
        },
        # natural=scrub polygon
        {
            "type": "way",
            "id": 400004,
            "tags": {"natural": "scrub"},
            "geometry": [
                {"lat": 40.7150, "lon": -73.0090},
                {"lat": 40.7151, "lon": -73.0085},
                {"lat": 40.7149, "lon": -73.0080},
                {"lat": 40.7148, "lon": -73.0085},
            ],
        },
        # natural=tree_row, CLOSED ring (≥4 pts, first==last) → woods Polygon
        {
            "type": "way",
            "id": 400005,
            "tags": {"natural": "tree_row"},
            "geometry": [
                {"lat": 40.7160, "lon": -73.0100},
                {"lat": 40.7161, "lon": -73.0095},
                {"lat": 40.7159, "lon": -73.0090},
                {"lat": 40.7158, "lon": -73.0095},
                {"lat": 40.7160, "lon": -73.0100},
            ],
        },
        # natural=tree_row, OPEN with only 3 points → skipped (degenerate polygon)
        {
            "type": "way",
            "id": 400006,
            "tags": {"natural": "tree_row"},
            "geometry": [
                {"lat": 40.7170, "lon": -73.0100},
                {"lat": 40.7171, "lon": -73.0095},
                {"lat": 40.7169, "lon": -73.0090},
            ],
        },
        # natural=tree node → tree Point feature
        {
            "type": "node",
            "id": 500001,
            "tags": {"natural": "tree"},
            "lat": 40.7125,
            "lon": -73.0058,
        },
        # golf=pin node → still ignored (not a natural=tree)
        {
            "type": "node",
            "id": 500002,
            "tags": {"golf": "pin"},
            "lat": 40.7132,
            "lon": -73.0055,
        },
    ]
}


class TestTerrainFeatures:
    """Rough, woods, and tree parsing — the new terrain coverage types."""

    def test_rough_polygon_classified_correctly(self):
        result = _parse_course_geometry_response(_TERRAIN_FIXTURE)
        assert len(result["rough"]) == 1
        assert result["rough"][0]["properties"]["featureType"] == "rough"

    def test_rough_geometry_is_polygon(self):
        result = _parse_course_geometry_response(_TERRAIN_FIXTURE)
        assert result["rough"][0]["geometry"]["type"] == "Polygon"

    def test_rough_osm_id_is_way(self):
        result = _parse_course_geometry_response(_TERRAIN_FIXTURE)
        assert result["rough"][0]["properties"]["osm_id"] == "way/400001"

    def test_natural_wood_goes_to_woods(self):
        result = _parse_course_geometry_response(_TERRAIN_FIXTURE)
        wood_ids = {f["properties"]["osm_id"] for f in result["woods"]}
        assert "way/400002" in wood_ids

    def test_landuse_forest_goes_to_woods(self):
        result = _parse_course_geometry_response(_TERRAIN_FIXTURE)
        wood_ids = {f["properties"]["osm_id"] for f in result["woods"]}
        assert "way/400003" in wood_ids

    def test_natural_scrub_goes_to_woods(self):
        result = _parse_course_geometry_response(_TERRAIN_FIXTURE)
        wood_ids = {f["properties"]["osm_id"] for f in result["woods"]}
        assert "way/400004" in wood_ids

    def test_tree_row_closed_ring_goes_to_woods(self):
        result = _parse_course_geometry_response(_TERRAIN_FIXTURE)
        wood_ids = {f["properties"]["osm_id"] for f in result["woods"]}
        assert "way/400005" in wood_ids

    def test_tree_row_open_linestring_is_skipped(self):
        # Open tree_row with only 3 points cannot form a valid polygon → skipped.
        result = _parse_course_geometry_response(_TERRAIN_FIXTURE)
        wood_ids = {f["properties"]["osm_id"] for f in result["woods"]}
        assert "way/400006" not in wood_ids

    def test_woods_total_count(self):
        # wood + forest + scrub + closed tree_row = 4
        result = _parse_course_geometry_response(_TERRAIN_FIXTURE)
        assert len(result["woods"]) == 4

    def test_woods_feature_type_tag(self):
        result = _parse_course_geometry_response(_TERRAIN_FIXTURE)
        for feat in result["woods"]:
            assert feat["properties"]["featureType"] == "woods"

    def test_woods_geometry_are_polygons(self):
        result = _parse_course_geometry_response(_TERRAIN_FIXTURE)
        for feat in result["woods"]:
            assert feat["geometry"]["type"] == "Polygon"

    def test_tree_node_classified_as_tree(self):
        result = _parse_course_geometry_response(_TERRAIN_FIXTURE)
        assert len(result["trees"]) == 1

    def test_tree_geometry_is_point(self):
        result = _parse_course_geometry_response(_TERRAIN_FIXTURE)
        assert result["trees"][0]["geometry"]["type"] == "Point"

    def test_tree_osm_id_is_node(self):
        result = _parse_course_geometry_response(_TERRAIN_FIXTURE)
        assert result["trees"][0]["properties"]["osm_id"] == "node/500001"

    def test_tree_feature_type_tag(self):
        result = _parse_course_geometry_response(_TERRAIN_FIXTURE)
        assert result["trees"][0]["properties"]["featureType"] == "tree"

    def test_tree_point_coordinates_are_lon_lat(self):
        result = _parse_course_geometry_response(_TERRAIN_FIXTURE)
        coords = result["trees"][0]["geometry"]["coordinates"]
        # GeoJSON = [lon, lat]; our node has lat=40.7125, lon=-73.0058
        assert coords[0] == pytest.approx(-73.0058, abs=1e-6)
        assert coords[1] == pytest.approx(40.7125, abs=1e-6)

    def test_golf_pin_node_is_not_a_tree(self):
        result = _parse_course_geometry_response(_TERRAIN_FIXTURE)
        tree_ids = {f["properties"]["osm_id"] for f in result["trees"]}
        assert "node/500002" not in tree_ids

    def test_terrain_buckets_empty_in_base_fixture(self):
        # Base fixture has no rough/woods/trees → all three buckets empty.
        result = _parse_course_geometry_response(_FIXTURE)
        assert result["rough"] == []
        assert result["woods"] == []
        assert result["trees"] == []

    def test_course_name_filter_does_not_affect_terrain(self):
        # Terrain features are not filtered by course name.
        combined = {
            "elements": _FIXTURE["elements"] + _TERRAIN_FIXTURE["elements"]
        }
        result = _parse_course_geometry_response(combined, course_name_filter="Black")
        assert len(result["rough"]) == 1
        assert len(result["woods"]) == 4
        assert len(result["trees"]) == 1
        # But only the Black hole should appear.
        assert len(result["holes"]) == 1


# ── Bunker relations + natural=sand (v1.1.9 field-test fix, Item 2) ───────────
#
# Overpass response shape for the two new query clauses
# (relation["golf"="bunker"], way/relation["natural"="sand"]):
#   - A golf=bunker MULTIPOLYGON relation with an outer ring (waste complex)
#     and an inner ring (grass island) — mirrors the real Bethpage Red-9
#     relation confirmed live via an Overpass probe (id 19545022): outer +
#     inner way members, tags golf=bunker, type=multipolygon.
#   - A natural=sand WAY (waste bunker mapped as a simple polygon, no relation).
#   - A natural=sand RELATION (waste complex mapped as a multipolygon, no
#     golf=bunker tag at all — OSM sometimes tags waste areas this way).
#   - A relation with no usable outer-ring geometry -> must be skipped.
#   - A relation that is neither golf=bunker nor natural=sand (the query
#     never requests other relation types, but the parser must still ignore
#     one defensively rather than mis-classify it).
_BUNKER_RELATION_FIXTURE: dict = {
    "elements": [
        {
            "type": "relation",
            "id": 700001,
            "tags": {"golf": "bunker", "type": "multipolygon"},
            "members": [
                {
                    "type": "way",
                    "ref": 700101,
                    "role": "outer",
                    "geometry": [
                        {"lat": 40.75, "lon": -73.50},
                        {"lat": 40.75, "lon": -73.499},
                        {"lat": 40.751, "lon": -73.499},
                        {"lat": 40.751, "lon": -73.50},
                    ],
                },
                {
                    "type": "way",
                    "ref": 700102,
                    "role": "inner",
                    "geometry": [
                        {"lat": 40.7503, "lon": -73.4996},
                        {"lat": 40.7503, "lon": -73.4994},
                        {"lat": 40.7505, "lon": -73.4994},
                        {"lat": 40.7505, "lon": -73.4996},
                    ],
                },
            ],
        },
        {
            "type": "way",
            "id": 700002,
            "tags": {"natural": "sand"},
            "geometry": [
                {"lat": 40.76, "lon": -73.51},
                {"lat": 40.76, "lon": -73.509},
                {"lat": 40.761, "lon": -73.509},
                {"lat": 40.761, "lon": -73.51},
            ],
        },
        {
            "type": "relation",
            "id": 700003,
            "tags": {"natural": "sand", "type": "multipolygon"},
            "members": [
                {
                    "type": "way",
                    "ref": 700301,
                    "role": "outer",
                    "geometry": [
                        {"lat": 40.77, "lon": -73.52},
                        {"lat": 40.77, "lon": -73.519},
                        {"lat": 40.771, "lon": -73.519},
                        {"lat": 40.771, "lon": -73.52},
                    ],
                },
            ],
        },
        {
            "type": "relation",
            "id": 700004,
            "tags": {"golf": "bunker", "type": "multipolygon"},
            "members": [
                {"type": "way", "ref": 700401, "role": "outer"},  # no "geometry" key
            ],
        },
        {
            "type": "relation",
            "id": 700005,
            "tags": {"leisure": "golf_course", "type": "multipolygon"},
            "members": [
                {
                    "type": "way",
                    "ref": 700501,
                    "role": "outer",
                    "geometry": [
                        {"lat": 40.78, "lon": -73.53},
                        {"lat": 40.78, "lon": -73.529},
                        {"lat": 40.781, "lon": -73.529},
                        {"lat": 40.781, "lon": -73.53},
                    ],
                },
            ],
        },
    ]
}


class TestBunkerRelationsAndSand:
    """golf=bunker relations + natural=sand ways/relations -> bunkers bucket
    (specs/map-fieldtest-v119-plan.md Item 2 — the ingest query previously
    only asked for way["golf"="bunker"], missing a waste complex mapped as a
    multipolygon relation or natural=sand — confirmed live via an Overpass
    probe against Bethpage Red-9's bbox)."""

    def test_bunker_relation_yields_one_feature(self):
        result = _parse_course_geometry_response(_BUNKER_RELATION_FIXTURE)
        rel_features = [f for f in result["bunkers"] if f["properties"]["osm_id"] == "relation/700001"]
        assert len(rel_features) == 1

    def test_bunker_relation_geometry_is_multipolygon(self):
        result = _parse_course_geometry_response(_BUNKER_RELATION_FIXTURE)
        feat = next(f for f in result["bunkers"] if f["properties"]["osm_id"] == "relation/700001")
        assert feat["geometry"]["type"] == "MultiPolygon"

    def test_bunker_relation_feature_type_is_bunker(self):
        result = _parse_course_geometry_response(_BUNKER_RELATION_FIXTURE)
        feat = next(f for f in result["bunkers"] if f["properties"]["osm_id"] == "relation/700001")
        assert feat["properties"]["featureType"] == "bunker"

    def test_bunker_relation_multipolygon_has_only_the_outer_ring(self):
        # Inner ring (the grass island) is intentionally dropped — same
        # outer-only convention as _parse_boundary_geometry.
        result = _parse_course_geometry_response(_BUNKER_RELATION_FIXTURE)
        feat = next(f for f in result["bunkers"] if f["properties"]["osm_id"] == "relation/700001")
        assert len(feat["geometry"]["coordinates"]) == 1  # one member polygon (outer only)

    def test_natural_sand_way_lands_in_bunkers_bucket(self):
        result = _parse_course_geometry_response(_BUNKER_RELATION_FIXTURE)
        feat = next(f for f in result["bunkers"] if f["properties"]["osm_id"] == "way/700002")
        assert feat["properties"]["featureType"] == "bunker"
        assert feat["geometry"]["type"] == "Polygon"

    def test_natural_sand_relation_lands_in_bunkers_bucket_as_multipolygon(self):
        result = _parse_course_geometry_response(_BUNKER_RELATION_FIXTURE)
        feat = next(f for f in result["bunkers"] if f["properties"]["osm_id"] == "relation/700003")
        assert feat["properties"]["featureType"] == "bunker"
        assert feat["geometry"]["type"] == "MultiPolygon"

    def test_relation_with_no_outer_geometry_is_skipped(self):
        result = _parse_course_geometry_response(_BUNKER_RELATION_FIXTURE)
        ids = {f["properties"]["osm_id"] for f in result["bunkers"]}
        assert "relation/700004" not in ids

    def test_unrelated_relation_type_is_ignored(self):
        result = _parse_course_geometry_response(_BUNKER_RELATION_FIXTURE)
        all_ids = {
            f["properties"]["osm_id"]
            for bucket in result.values()
            for f in bucket
        }
        assert "relation/700005" not in all_ids

    def test_total_bunker_count(self):
        # 1 valid golf=bunker relation + 1 natural=sand way + 1 natural=sand
        # relation = 3 (the no-geometry relation and the unrelated relation
        # are both skipped).
        result = _parse_course_geometry_response(_BUNKER_RELATION_FIXTURE)
        assert len(result["bunkers"]) == 3


# ── _parse_relation_to_multipolygon (pure helper) ──────────────────────────────

class TestParseRelationToMultipolygon:
    def test_outer_only_relation_returns_multipolygon(self):
        el = _BUNKER_RELATION_FIXTURE["elements"][0]
        result = _parse_relation_to_multipolygon(el)
        assert result is not None
        assert result["type"] == "MultiPolygon"
        assert len(result["coordinates"]) == 1  # inner ring dropped

    def test_relation_with_no_outer_members_returns_none(self):
        el = {"type": "relation", "id": 1, "members": [{"role": "inner", "geometry": []}]}
        assert _parse_relation_to_multipolygon(el) is None

    def test_relation_with_degenerate_outer_ring_returns_none(self):
        el = {
            "type": "relation",
            "id": 2,
            "members": [
                {"role": "outer", "geometry": [{"lat": 0, "lon": 0}, {"lat": 0, "lon": 1}]},
            ],
        }
        assert _parse_relation_to_multipolygon(el) is None

    def test_multiple_outer_members_produce_multiple_polygons(self):
        el = {
            "type": "relation",
            "id": 3,
            "members": [
                {
                    "role": "outer",
                    "geometry": [
                        {"lat": 0, "lon": 0}, {"lat": 0, "lon": 1},
                        {"lat": 1, "lon": 1}, {"lat": 1, "lon": 0},
                    ],
                },
                {
                    "role": "outer",
                    "geometry": [
                        {"lat": 10, "lon": 10}, {"lat": 10, "lon": 11},
                        {"lat": 11, "lon": 11}, {"lat": 11, "lon": 10},
                    ],
                },
            ],
        }
        result = _parse_relation_to_multipolygon(el)
        assert len(result["coordinates"]) == 2
