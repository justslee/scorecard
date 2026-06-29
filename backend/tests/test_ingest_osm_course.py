"""Unit tests for osm_ingest.py — pure assembly, no DB, no network.

Covers:
- ``_deterministic_uuid``: UUID format, version/variant bits, determinism,
  cross-key uniqueness, and SHA-1 derivation alignment.
- ``assemble_osm_course``: output shape, par/handicap merge from OSM hole
  tags, cross-course rejection (via the embedded spatial join), and edge cases.

Fixtures mirror those in test_course_spatial.py (Black H1 + H2, Red H1) so
the combined I0→I1→I2 pipeline can be exercised end-to-end without any I/O.
"""

from __future__ import annotations

import hashlib
import re

from app.services.osm_ingest import _deterministic_uuid, assemble_osm_course


# ── Fixture builders (self-contained, no test_course_spatial import) ──────────

def _make_hole(
    ref: str,
    course_name: str,
    start_lon: float, start_lat: float,
    end_lon: float, end_lat: float,
    *,
    par: int = 4,
    handicap: int = 9,
) -> dict:
    """GeoJSON LineString hole Feature matching the osm.py output format."""
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
    """Tiny square GeoJSON Polygon Feature centred on (lon, lat)."""
    lo_lon, hi_lon = center_lon - half, center_lon + half
    lo_lat, hi_lat = center_lat - half, center_lat + half
    ring = [
        [lo_lon, lo_lat], [hi_lon, lo_lat],
        [hi_lon, hi_lat], [lo_lon, hi_lat],
        [lo_lon, lo_lat],  # closed
    ]
    return {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": [ring]},
        "properties": {"featureType": feature_type, "osm_id": osm_id},
    }


# ── Shared fixture data ────────────────────────────────────────────────────────
#
# Layout (same spatial relationships as test_course_spatial.py):
#   Black H1: lon=-73.000  lat=40.700→40.702   par=4  handicap=7
#   Black H2: lon=-72.990  lat=40.700→40.702   par=5  handicap=3   (no nearby polygon)
#   Red   H1: lon=-72.970  lat=40.700→40.702   par=3  handicap=1
#
# Polygons:
#   green_bh1  — near Black H1 end   → assigned to Black / H1
#   bunker_bh1 — near Black H1 mid   → assigned to Black / H1
#   green_rh1  — near Red   H1 end   → assigned to Red  / H1 (REJECTED from Black)

_BH1 = _make_hole("1", "Black", -73.000, 40.700, -73.000, 40.702, par=4, handicap=7)
_BH2 = _make_hole("2", "Black", -72.990, 40.700, -72.990, 40.702, par=5, handicap=3)
_RH1 = _make_hole("1", "Red",   -72.970, 40.700, -72.970, 40.702, par=3, handicap=1)

_GREEN_BH1  = _make_polygon("way/green_bh1",  "green",  -73.000, 40.702)
_BUNKER_BH1 = _make_polygon("way/bunker_bh1", "bunker", -73.001, 40.701)
_GREEN_RH1  = _make_polygon("way/green_rh1",  "green",  -72.970, 40.702)

_BASE_GEOMETRY: dict = {
    "holes":    [_BH1, _BH2, _RH1],
    "greens":   [_GREEN_BH1, _GREEN_RH1],
    "fairways": [],
    "tees":     [],
    "bunkers":  [_BUNKER_BH1],
    "water":    [],
}


def _run(target: str = "Black", **overrides) -> dict:
    """Run assemble_osm_course with the shared fixture and sensible defaults."""
    kwargs: dict = dict(
        geometry=_BASE_GEOMETRY,
        course_id="test-uuid-123",
        course_name=f"Bethpage {target}",
        target_course_name=target,
    )
    kwargs.update(overrides)
    return assemble_osm_course(**kwargs)


# ══════════════════════════════════════════════════════════════════════════════
# _deterministic_uuid
# ══════════════════════════════════════════════════════════════════════════════

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


class TestDeterministicUUID:
    """UUID format, version/variant bits, determinism, and SHA-1 alignment."""

    def test_valid_uuid_format(self):
        uid = _deterministic_uuid("osm-bethpage-black")
        assert _UUID_RE.match(uid), f"Not a valid UUID: {uid!r}"

    def test_deterministic_same_key(self):
        assert _deterministic_uuid("osm-bethpage-black") == _deterministic_uuid("osm-bethpage-black")

    def test_different_keys_different_uuids(self):
        assert _deterministic_uuid("osm-bethpage-black") != _deterministic_uuid("osm-bethpage-red")

    def test_empty_key_still_returns_uuid(self):
        uid = _deterministic_uuid("")
        assert _UUID_RE.match(uid)

    def test_version_nibble_is_5(self):
        # Third group, first hex digit must be '5' (UUID version 5).
        uid = _deterministic_uuid("any-key")
        assert uid.split("-")[2][0] == "5", f"Version nibble wrong in {uid}"

    def test_variant_bits_rfc4122(self):
        # Fourth group, first byte: top 2 bits must be '10' → 0x80–0xBF.
        uid = _deterministic_uuid("any-key")
        first_byte = int(uid.split("-")[3][:2], 16)
        assert 0x80 <= first_byte <= 0xBF, (
            f"Variant bits wrong: {first_byte:#04x} in {uid}"
        )

    def test_matches_sha1_derivation(self):
        """Cross-check against raw SHA-1 so byte-ordering drift is caught."""
        key = "osm-bethpage-black"
        raw = hashlib.sha1(f"golfapi:{key}".encode()).digest()
        b = bytearray(raw[:16])
        b[6] = (b[6] & 0x0F) | 0x50
        b[8] = (b[8] & 0x3F) | 0x80
        h = b.hex()
        expected = f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"
        assert _deterministic_uuid(key) == expected

    def test_stable_pinned_value_for_bethpage_black(self):
        """Pin the concrete UUID so future refactors can't silently change it.

        If this test fails, a stored row UUID would no longer be derivable
        from the stable key — a data migration would be required.  Never
        change this expectation without also migrating any existing rows.
        """
        uid = _deterministic_uuid("osm-bethpage-black")
        # Regenerate the expected value using the identical algorithm
        # (self-validating; avoids a hard-coded magic string in the test).
        raw = hashlib.sha1(b"golfapi:osm-bethpage-black").digest()
        b = bytearray(raw[:16])
        b[6] = (b[6] & 0x0F) | 0x50
        b[8] = (b[8] & 0x3F) | 0x80
        h = b.hex()
        pinned = f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"
        assert uid == pinned


# ══════════════════════════════════════════════════════════════════════════════
# assemble_osm_course — top-level output shape
# ══════════════════════════════════════════════════════════════════════════════

class TestAssembleOsmCourseShape:
    """Return value must satisfy the upsert_course input schema."""

    def test_returns_dict(self):
        assert isinstance(_run(), dict)

    def test_top_level_required_keys(self):
        result = _run()
        assert {"id", "name", "address", "location", "teeSets", "holes"} <= set(result)

    def test_id_passthrough(self):
        result = _run(course_id="my-uuid-abc")
        assert result["id"] == "my-uuid-abc"

    def test_name_passthrough(self):
        result = _run(course_name="Bethpage Black Test")
        assert result["name"] == "Bethpage Black Test"

    def test_address_passthrough(self):
        result = _run(address="99 Quaker Meeting House Rd")
        assert result["address"] == "99 Quaker Meeting House Rd"

    def test_address_defaults_to_none(self):
        assert _run()["address"] is None

    def test_location_passthrough(self):
        loc = {"lat": 40.7445, "lng": -73.4609}
        assert _run(location=loc)["location"] == loc

    def test_location_defaults_to_none(self):
        assert _run()["location"] is None

    def test_default_tee_sets_count(self):
        # Four defaults: Black / Blue / White / Red
        assert len(_run()["teeSets"]) == 4

    def test_custom_tee_sets(self):
        custom = [{"name": "Championship", "color": "#000000"}]
        assert _run(tee_sets=custom)["teeSets"] == custom

    def test_holes_is_list(self):
        assert isinstance(_run()["holes"], list)

    def test_each_hole_has_required_keys(self):
        for hole in _run()["holes"]:
            assert "number"   in hole
            assert "par"      in hole
            assert "handicap" in hole
            assert "yardages" in hole
            assert "features" in hole

    def test_yardages_empty(self):
        """Yardages are intentionally left empty until card data is merged (I3)."""
        for hole in _run()["holes"]:
            assert hole["yardages"] == {}

    def test_features_is_geojson_feature_collection(self):
        for hole in _run()["holes"]:
            fc = hole["features"]
            assert fc["type"] == "FeatureCollection"
            assert isinstance(fc["features"], list)

    def test_feature_items_are_geojson_features(self):
        for hole in _run()["holes"]:
            for feat in hole["features"]["features"]:
                assert feat["type"] == "Feature"
                assert "properties" in feat
                assert "geometry"   in feat


# ══════════════════════════════════════════════════════════════════════════════
# assemble_osm_course — spatial join + cross-course rejection
# ══════════════════════════════════════════════════════════════════════════════

class TestAssembleOsmCourseSpatial:
    """Cross-course rejection and per-hole grouping via the embedded spatial join."""

    def _osm_ids(self, target: str) -> set[str]:
        result = _run(target=target)
        return {
            f["properties"]["osm_id"]
            for h in result["holes"]
            for f in h["features"]["features"]
        }

    def test_black_excludes_red_polygon(self):
        assert "way/green_rh1" not in self._osm_ids("Black")

    def test_black_includes_bh1_green(self):
        assert "way/green_bh1" in self._osm_ids("Black")

    def test_black_includes_bh1_bunker(self):
        assert "way/bunker_bh1" in self._osm_ids("Black")

    def test_red_includes_red_polygon(self):
        assert "way/green_rh1" in self._osm_ids("Red")

    def test_red_excludes_black_polygons(self):
        ids = self._osm_ids("Red")
        assert "way/green_bh1"  not in ids
        assert "way/bunker_bh1" not in ids

    def test_holes_sorted_ascending(self):
        result = _run()
        nums = [h["number"] for h in result["holes"]]
        assert nums == sorted(nums)

    def test_nonexistent_target_returns_empty_holes(self):
        result = _run(target="Blue")
        assert result["holes"] == []

    def test_case_insensitive_target(self):
        upper = _run(target="BLACK")
        lower = _run(target="black")
        ids_upper = {
            f["properties"]["osm_id"]
            for h in upper["holes"]
            for f in h["features"]["features"]
        }
        ids_lower = {
            f["properties"]["osm_id"]
            for h in lower["holes"]
            for f in h["features"]["features"]
        }
        assert ids_upper == ids_lower


# ══════════════════════════════════════════════════════════════════════════════
# assemble_osm_course — par / handicap merge from OSM hole tags
# ══════════════════════════════════════════════════════════════════════════════

class TestAssembleOsmCoursePar:
    """Par and handicap values from OSM hole LineStrings must land in the output."""

    def _hole(self, number: int) -> dict:
        for h in _run()["holes"]:
            if h["number"] == number:
                return h
        raise KeyError(f"Hole {number} not in output")

    def test_hole1_par_merged_from_osm(self):
        assert self._hole(1)["par"] == 4  # _BH1.par = 4

    def test_hole1_handicap_merged_from_osm(self):
        assert self._hole(1)["handicap"] == 7  # _BH1.handicap = 7

    def test_hole_with_no_polygon_not_in_output(self):
        """BH2 has no nearby polygon → spatial join emits nothing → not in holes."""
        nums = [h["number"] for h in _run()["holes"]]
        assert 2 not in nums

    def test_par_is_int_or_none(self):
        for h in _run()["holes"]:
            assert h["par"] is None or isinstance(h["par"], int)

    def test_handicap_is_int_or_none(self):
        for h in _run()["holes"]:
            assert h["handicap"] is None or isinstance(h["handicap"], int)


# ══════════════════════════════════════════════════════════════════════════════
# assemble_osm_course — edge cases
# ══════════════════════════════════════════════════════════════════════════════

class TestAssembleOsmCourseEdgeCases:

    def test_empty_geometry_returns_empty_holes(self):
        result = assemble_osm_course(
            geometry={"holes": [], "greens": [], "fairways": [],
                       "tees": [], "bunkers": [], "water": []},
            course_id="x",
            course_name="Empty",
            target_course_name="Black",
        )
        assert result["holes"] == []

    def test_geometry_missing_polygon_keys_handled(self):
        # Only 'holes' key present — missing polygon lists default to [].
        result = assemble_osm_course(
            geometry={"holes": [_BH1]},
            course_id="x",
            course_name="Test",
            target_course_name="Black",
        )
        # No polygons → no features → no hole dicts emitted.
        assert result["holes"] == []

    def test_geometry_missing_holes_key_handled(self):
        # Only polygon keys present — 'holes' list defaults to [].
        result = assemble_osm_course(
            geometry={"greens": [_GREEN_BH1]},
            course_id="x",
            course_name="Test",
            target_course_name="Black",
        )
        assert result["holes"] == []

    def test_single_hole_single_polygon(self):
        geo = {
            "holes":    [_BH1],
            "greens":   [_GREEN_BH1],
            "fairways": [], "tees": [], "bunkers": [], "water": [],
        }
        result = assemble_osm_course(
            geometry=geo,
            course_id="x",
            course_name="Solo",
            target_course_name="Black",
        )
        assert len(result["holes"]) == 1
        assert result["holes"][0]["number"] == 1
        assert result["holes"][0]["par"] == 4

    def test_tee_sets_none_gives_four_defaults(self):
        result = assemble_osm_course(
            geometry=_BASE_GEOMETRY,
            course_id="x",
            course_name="T",
            target_course_name="Black",
            tee_sets=None,
        )
        assert len(result["teeSets"]) == 4

    def test_tee_sets_empty_list_passthrough(self):
        result = assemble_osm_course(
            geometry=_BASE_GEOMETRY,
            course_id="x",
            course_name="T",
            target_course_name="Black",
            tee_sets=[],
        )
        assert result["teeSets"] == []
