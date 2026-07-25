"""Green anchor selection: nearest-the-hole-path's-last-vertex, not first-by-
file-order (specs/caddie-green-anchor-nearest-centerline-end-plan.md).

`hazards._derive_tee_green` used to pick the FIRST `featureType == "green"`
feature by FILE ORDER. On multi-green holes — greens of different courses
crowding the clubhouse (9s/18s), or a real double green — that silently
anchored every carry/bend/corridor/plays-like/club number to a NEIGHBOURING
hole's green. Bethpage Black 18 (the owner's home course) reads "508y to
green" on a 411y hole, live, before this fix.

Two halves, mirroring `test_corner_tree_forward_bound.py`'s shape:
  I.  Real prod-geometry repro, via the REAL ingestion path
      (`_parse_course_geometry_response` + `assemble_osm_course`) over the
      committed `bethpage_overpass.json` — the exact harness
      `test_bethpage_validation.py` uses, reused here. Black 18 (the live
      defect, 2 greens), Black 9 (correct today only by luck, 2 greens),
      Green 18 (THREE greens — the case a two-way comparison would fail).
  II. Synthetic boundary units (`TestGreenSelection`) — adversarial file
      order, arg-as-selector, order-independent fallback, the D3 tee/green
      ordering coupling, single-green byte-identity, and the honest-failure
      caplog warning.
"""

from __future__ import annotations

import json
import logging
import math
import pathlib

import pytest

from app.caddie.hazards import (
    _GREEN_ANCHOR_WARN_YARDS,
    _derive_tee_green,
    _feature_point,
    _hole_polyline,
    _point_dist_sq_m,
    _select_green_nearest_path_end,
    _xy_m,
    _YARDS_PER_METER,
    extract_hole_hazards,
)
from app.services.osm import _parse_course_geometry_response
from app.services.osm_ingest import _deterministic_uuid, assemble_osm_course
from tests.test_hazards import _TEE_LAT, _TEE_LON, _fc, _point_north_east, _square_polygon

FIXTURE_PATH = pathlib.Path(__file__).parent / "fixtures" / "bethpage_overpass.json"


# ══════════════════════════════════════════════════════════════════════════
# I. Real prod-geometry repro (the actual ingestion path, committed fixture)
# ══════════════════════════════════════════════════════════════════════════


@pytest.fixture(scope="module")
def raw_data() -> dict:
    assert FIXTURE_PATH.exists(), f"Fixture missing: {FIXTURE_PATH}"
    return json.loads(FIXTURE_PATH.read_text())


@pytest.fixture(scope="module")
def geometry(raw_data: dict) -> dict:
    """All 5 Bethpage courses (90 holes) — the spatial join needs every
    course present so cross-course rejection/mis-join can happen at all."""
    return _parse_course_geometry_response(raw_data, course_name_filter=None)


def _assemble(geometry: dict, course_name: str) -> dict:
    course_id = _deterministic_uuid(f"osm-bethpage-{course_name.lower()}")
    return assemble_osm_course(
        geometry=geometry,
        course_id=course_id,
        course_name=f"Bethpage {course_name}",
        target_course_name=course_name,
        address="99 Quaker Meeting House Rd, Farmingdale, NY 11735",
        location={"lat": 40.7445, "lng": -73.4609},
    )


def _hole(assembled: dict, number: int) -> dict:
    return next(h for h in assembled["holes"] if h["number"] == number)


def _green_features(feature_list: list[dict]) -> list[dict]:
    return [f for f in feature_list if (f.get("properties") or {}).get("featureType") == "green"]


def _offset_from_path_end_yards(path: list[tuple[float, float]], pt: tuple[float, float]) -> float:
    anchor = path[-1]
    return math.sqrt(_point_dist_sq_m(anchor[1], anchor, pt)) * _YARDS_PER_METER


def _tee_green_yards(feature_list: list[dict]) -> float:
    tee_pt, green_pt = _derive_tee_green(feature_list, None, None)
    assert tee_pt is not None and green_pt is not None
    gx, gy = _xy_m(tee_pt[1], tee_pt[0], green_pt[1], green_pt[0])
    return math.hypot(gx, gy) * _YARDS_PER_METER


@pytest.fixture(scope="module")
def black(geometry: dict) -> dict:
    return _assemble(geometry, "Black")


@pytest.fixture(scope="module")
def green_course(geometry: dict) -> dict:
    return _assemble(geometry, "Green")


class TestBlack18LiveDefect:
    """The convicting case: Black 18 carries a neighbouring hole's green
    (the clubhouse-adjacent 9/18 crowding the plan's §0 table describes).
    Card yardage is 411y."""

    def test_hole_carries_at_least_two_green_features(self, black: dict):
        hole18 = _hole(black, 18)
        greens = _green_features(hole18["features"]["features"])
        assert len(greens) >= 2, "repro precondition: hole 18 must carry >=2 green features"

    def test_selected_green_is_within_15y_of_the_path_end(self, black: dict):
        hole18 = _hole(black, 18)
        feature_list = hole18["features"]["features"]
        path = _hole_polyline(feature_list)
        assert path is not None
        _, green_pt = _derive_tee_green(feature_list, None, None)
        assert green_pt is not None
        assert _offset_from_path_end_yards(path, green_pt) <= 15.0

    def test_tee_to_green_yardage_matches_the_card(self, black: dict):
        """Card is 411y; measured-correct straight-line is ~412.1y."""
        hole18 = _hole(black, 18)
        yards = _tee_green_yards(hole18["features"]["features"])
        assert 405 <= yards <= 420, f"expected ~412y (card 411), got {yards:.1f}y"

    def test_before_repro_first_by_file_order_still_wrong(self, black: dict):
        """Before-repro pin (the monkeypatch-analogue — the old rule is
        data-driven, not a constant): the first-by-file-order green on the
        SAME assembled features yields >480y — proving the duplicate is
        still present in the fixture and file order alone would still be
        wrong, i.e. this isn't a fixture that happened to get fixed upstream."""
        hole18 = _hole(black, 18)
        feature_list = hole18["features"]["features"]
        tee_pt, _ = _derive_tee_green(feature_list, None, None)
        assert tee_pt is not None
        old_first_green = _feature_point(_green_features(feature_list)[0])
        assert old_first_green is not None
        gx, gy = _xy_m(tee_pt[1], tee_pt[0], old_first_green[1], old_first_green[0])
        old_yards = math.hypot(gx, gy) * _YARDS_PER_METER
        assert old_yards > 480, f"expected the old first-found green to read >480y, got {old_yards:.1f}y"


class TestBlack9CorrectOnlyByLuck:
    """Black 9 carries the same duplicate-green shape as 18 but happens to
    be correct under first-by-file-order today — pin the GEOMETRIC property,
    not the file order, since a re-ingest can flip which green sorts first."""

    def test_hole_carries_at_least_two_green_features(self, black: dict):
        hole9 = _hole(black, 9)
        greens = _green_features(hole9["features"]["features"])
        assert len(greens) >= 2

    def test_selected_green_within_15y_and_the_other_candidate_over_50y_off(self, black: dict):
        hole9 = _hole(black, 9)
        feature_list = hole9["features"]["features"]
        path = _hole_polyline(feature_list)
        assert path is not None
        greens = _green_features(feature_list)
        candidates = [pt for f in greens if (pt := _feature_point(f)) is not None]
        assert len(candidates) >= 2

        selected = _select_green_nearest_path_end(candidates, path)
        assert selected is not None
        assert _offset_from_path_end_yards(path, selected) <= 15.0

        others = [c for c in candidates if c != selected]
        assert others, "discrimination requires a second candidate to compare against"
        assert all(_offset_from_path_end_yards(path, c) > 50.0 for c in others)

    def test_discrimination_holds_in_both_file_orders(self, black: dict):
        """Real discrimination, not file-order luck: reversing the stored
        green order must select the SAME geometric point."""
        hole9 = _hole(black, 9)
        feature_list = hole9["features"]["features"]
        path = _hole_polyline(feature_list)
        greens = _green_features(feature_list)
        candidates = [pt for f in greens if (pt := _feature_point(f)) is not None]

        forward = _select_green_nearest_path_end(candidates, path)
        reversed_pick = _select_green_nearest_path_end(list(reversed(candidates)), path)
        assert forward == reversed_pick


class TestGreen18ThreeGreens:
    """Bethpage Green 18 carries THREE green polygons (§0) — the pin a
    two-way comparison would fail, since `min()` over all candidates is
    required, not a pairwise choice."""

    def test_hole_carries_three_green_features(self, green_course: dict):
        hole18 = _hole(green_course, 18)
        greens = _green_features(hole18["features"]["features"])
        assert len(greens) == 3, f"expected exactly 3 green candidates, got {len(greens)}"

    def test_selected_is_within_15y_the_other_two_are_over_50y_off(self, green_course: dict):
        hole18 = _hole(green_course, 18)
        feature_list = hole18["features"]["features"]
        path = _hole_polyline(feature_list)
        assert path is not None
        greens = _green_features(feature_list)
        candidates = [pt for f in greens if (pt := _feature_point(f)) is not None]
        assert len(candidates) == 3

        selected = _select_green_nearest_path_end(candidates, path)
        assert selected is not None
        assert _offset_from_path_end_yards(path, selected) <= 15.0

        others = [c for c in candidates if c != selected]
        assert len(others) == 2
        assert all(_offset_from_path_end_yards(path, c) > 50.0 for c in others)

    def test_tee_to_green_yardage_matches_the_card(self, green_course: dict):
        """Card centerline measured ~400.5y (§0); measured-correct ~384.7y."""
        hole18 = _hole(green_course, 18)
        yards = _tee_green_yards(hole18["features"]["features"])
        assert 375 <= yards <= 395, f"expected ~385y, got {yards:.1f}y"


# ══════════════════════════════════════════════════════════════════════════
# II. Synthetic boundary units — mirrors TestTeeSelection (test_hazards.py)
# ══════════════════════════════════════════════════════════════════════════
#
# Hole runs due north, tee at (_TEE_LON, _TEE_LAT). Hole polyline's last
# vertex sits at 400y-north/0y-east. "Correct" green = at/near that vertex;
# "decoy" green (a neighbour's) sits far off it laterally.


def _green_at(north: float, east: float) -> dict:
    lon, lat = _point_north_east(_TEE_LON, _TEE_LAT, north, east)
    return _square_polygon("green", lon, lat)


def _tee_at(north: float, east: float) -> dict:
    lon, lat = _point_north_east(_TEE_LON, _TEE_LAT, north, east)
    return _square_polygon("tee", lon, lat)


def _hole_way(end_north: float = 400.0, end_east: float = 0.0) -> dict:
    start_lon, start_lat = _point_north_east(_TEE_LON, _TEE_LAT, 0, 0)
    end_lon, end_lat = _point_north_east(_TEE_LON, _TEE_LAT, end_north, end_east)
    return {
        "type": "Feature",
        "properties": {"featureType": "hole"},
        "geometry": {"type": "LineString", "coordinates": [[start_lon, start_lat], [end_lon, end_lat]]},
    }


class TestGreenSelection:
    def test_adversarial_file_order_decoy_first_still_picks_correct(self):
        """Decoy (250y off the polyline end) stored BEFORE the correct
        green (on the end) in file order — old first-found logic would pick
        the decoy; nearest-end must pick the correct one regardless."""
        decoy = _green_at(400, 250)
        correct = _green_at(400, 0)
        fc = _fc(decoy, correct, _hole_way())
        _, green_pt = _derive_tee_green(fc["features"], None, None)
        correct_lon, correct_lat = _point_north_east(_TEE_LON, _TEE_LAT, 400, 0)
        assert green_pt == (correct_lon, correct_lat)

    def test_reversed_file_order_same_pick(self):
        """Same fixture, reversed feature order — order independence."""
        decoy = _green_at(400, 250)
        correct = _green_at(400, 0)
        fc = _fc(correct, decoy, _hole_way())
        _, green_pt = _derive_tee_green(fc["features"], None, None)
        correct_lon, correct_lat = _point_north_east(_TEE_LON, _TEE_LAT, 400, 0)
        assert green_pt == (correct_lon, correct_lat)

    def test_d1_priority_2_arg_as_selector_when_no_polyline(self):
        """No hole LineString at all -> a VALID `green=` arg selects the
        NEAREST stored green candidate (D1 priority 2), exact mirror of the
        tee-arg rule."""
        near = _green_at(300, 0)
        far = _green_at(300, 200)
        fc = _fc(far, near)  # far stored first, to prove it's not file order
        arg_lon, arg_lat = _point_north_east(_TEE_LON, _TEE_LAT, 300, 5)  # close to `near`
        _, green_pt = _derive_tee_green(
            fc["features"], None, {"lat": arg_lat, "lng": arg_lon},
        )
        near_lon, near_lat = _point_north_east(_TEE_LON, _TEE_LAT, 300, 0)
        assert green_pt == (near_lon, near_lat)

    def test_d1_priority_3_no_polyline_no_arg_first_stored_unchanged(self):
        """No polyline, no valid arg, multiple greens -> first stored green
        (today's pre-fix behavior, unchanged) — the ONE remaining
        order-dependent branch, deliberately."""
        first = _green_at(300, 0)
        second = _green_at(300, 100)
        fc = _fc(first, second)
        _, green_pt = _derive_tee_green(fc["features"], None, None)
        first_lon, first_lat = _point_north_east(_TEE_LON, _TEE_LAT, 300, 0)
        assert green_pt == (first_lon, first_lat)

        # Reversing file order flips the pick too — confirms it's genuinely
        # order-DEPENDENT here (the honest fallback), unlike the path-anchored
        # cases above.
        fc_rev = _fc(second, first)
        _, green_pt_rev = _derive_tee_green(fc_rev["features"], None, None)
        second_lon, second_lat = _point_north_east(_TEE_LON, _TEE_LAT, 300, 100)
        assert green_pt_rev == (second_lon, second_lat)

    def test_d3_no_arg_multi_tee_back_tee_measured_against_correct_green(self):
        """The regression surface D3 calls out: a changed green pick
        re-ranks the farthest-from-green tee. Two greens (decoy far off the
        polyline end, correct on it) and two tees positioned so the
        farthest-from-DECOY tee and the farthest-from-CORRECT tee are
        DIFFERENT tees — pins that the no-arg back-tee selection reads the
        green AFTER correction, not the stale first-found green."""
        decoy = _green_at(400, 250)
        correct = _green_at(400, 0)
        tee_a = _tee_at(0, 50)   # farthest from the decoy green
        tee_b = _tee_at(0, 250)  # farthest from the correct green
        fc = _fc(decoy, correct, tee_a, tee_b, _hole_way())

        tee_pt, green_pt = _derive_tee_green(fc["features"], None, None)

        correct_lon, correct_lat = _point_north_east(_TEE_LON, _TEE_LAT, 400, 0)
        tee_b_lon, tee_b_lat = _point_north_east(_TEE_LON, _TEE_LAT, 0, 250)
        tee_a_lon, tee_a_lat = _point_north_east(_TEE_LON, _TEE_LAT, 0, 50)

        assert green_pt == (correct_lon, correct_lat)
        assert tee_pt == (tee_b_lon, tee_b_lat), (
            "back-tee pick must be measured against the CORRECTED green — "
            f"got {tee_pt}, expected tee_b {(tee_b_lon, tee_b_lat)} "
            f"(the stale-green pick would have chosen tee_a {(tee_a_lon, tee_a_lat)})"
        )

    def test_single_green_byte_identity(self):
        """A single stored green feature -> unchanged (byte-identical to the
        pre-fix single-green path) regardless of polyline presence."""
        only = _green_at(300, 0)
        only_lon, only_lat = _point_north_east(_TEE_LON, _TEE_LAT, 300, 0)

        fc_no_path = _fc(only)
        _, green_pt_no_path = _derive_tee_green(fc_no_path["features"], None, None)
        assert green_pt_no_path == (only_lon, only_lat)

        fc_with_path = _fc(only, _hole_way(end_north=300, end_east=0))
        _, green_pt_with_path = _derive_tee_green(fc_with_path["features"], None, None)
        assert green_pt_with_path == (only_lon, only_lat)

    def test_carry_numbers_shift_with_the_corrected_green(self):
        """Coherence check at the `extract_hole_hazards` level (not just the
        private selector): a bunker's carry_yards must be measured against
        the CORRECTED green's tee-anchored frame, not the stale one — mirrors
        `test_hazards.py::TestTeeSelection.test_polyline_and_bend_coherence_
        with_tee_selection`'s pattern for the green side."""
        decoy = _green_at(400, 250)
        correct = _green_at(400, 0)
        b_lon, b_lat = _point_north_east(_TEE_LON, _TEE_LAT, 245, -20)
        bunker = _square_polygon("bunker", b_lon, b_lat)
        fc = _fc(decoy, correct, bunker, _hole_way())
        hazards = extract_hole_hazards(fc)
        assert len(hazards) == 1
        assert abs(hazards[0].carry_yards - 245) <= 5
        assert hazards[0].line_side == "left"


class TestHonestFailureAndWarning:
    def test_no_green_features_at_all_hazards_cascade_unchanged(self):
        """Zero green candidates -> unchanged cascade (polyline last vertex
        -> raw green arg -> None); `extract_hole_hazards` still returns []
        when NOTHING resolves a green (no polyline, no arg)."""
        b_lon, b_lat = _point_north_east(_TEE_LON, _TEE_LAT, 100, -20)
        bunker = _square_polygon("bunker", b_lon, b_lat)
        fc = _fc(bunker)
        assert extract_hole_hazards(fc) == []

    def test_selected_green_over_30y_off_emits_one_key_free_warning(self, caplog):
        """Two candidates, both off the path end — the NEAREST (45y) is
        still selected (D4: selection never rejects) and a single key-free
        WARNING is logged; the farther candidate (300y) plays no role in the
        message beyond the candidate count."""
        near_but_off = _green_at(400, 45)
        far = _green_at(400, 300)
        fc = _fc(near_but_off, far, _hole_way())

        with caplog.at_level(logging.WARNING, logger="looper.hazards"):
            _, green_pt = _derive_tee_green(fc["features"], None, None)

        near_lon, near_lat = _point_north_east(_TEE_LON, _TEE_LAT, 400, 45)
        assert green_pt == (near_lon, near_lat), "must still select the nearest candidate, never reject"

        warnings = [r for r in caplog.records if r.name == "looper.hazards" and r.levelno == logging.WARNING]
        assert len(warnings) == 1, f"expected exactly one warning, got {len(warnings)}: {[r.message for r in warnings]}"
        msg = warnings[0].getMessage()
        assert "45.0" in msg or "45." in msg
        assert "2" in msg  # candidate count
        # Key-free: no lat/lon values leak into the log line.
        assert str(near_lon) not in msg
        assert str(near_lat) not in msg

    def test_offset_under_warn_threshold_emits_no_warning(self, caplog):
        """Sanity boundary: a green well within `_GREEN_ANCHOR_WARN_YARDS`
        of the path end emits nothing."""
        correct = _green_at(400, 5)  # ~5y off, comfortably under 30y
        decoy = _green_at(400, 250)
        fc = _fc(decoy, correct, _hole_way())

        with caplog.at_level(logging.WARNING, logger="looper.hazards"):
            _, green_pt = _derive_tee_green(fc["features"], None, None)

        correct_lon, correct_lat = _point_north_east(_TEE_LON, _TEE_LAT, 400, 5)
        assert green_pt == (correct_lon, correct_lat)
        warnings = [r for r in caplog.records if r.name == "looper.hazards"]
        assert warnings == []


def test_warn_threshold_constant_matches_the_plan_derivation():
    """Pin the constant itself (D4 derivation: ~6x the worst real offset,
    ~2.8x under the smallest observed bug magnitude)."""
    assert _GREEN_ANCHOR_WARN_YARDS == 30.0
