"""Unit tests for expected-strokes tee/positioning club selection
(specs/caddie-tee-club-expected-strokes-plan.md §6), the P0 fix for the
owner field report: "The caddie is extremely conservative. Tells me to hit
7 iron instead of driver." Replaces the hard corridor-width fit-wall
(`_select_club_fitting_corridor`, retired) with an honest expected-strokes
tradeoff — see `app.caddie.aim_point._select_club_expected_strokes`.

Pure, no DB/network — mirrors `test_corridor_width_selection.py`'s fixture
style directly.
"""

from __future__ import annotations

import json
import math
import pathlib
import re

import pytest

from app.caddie import physics
from app.caddie.aim_point import (
    _PENALTY_COST,
    _select_club_expected_strokes,
    _trouble_probability,
    generate_recommendation,
)
from app.caddie.hazards import (
    corridor_sample_at,
    extract_corridor_profile,
    extract_hole_bend,
    extract_hole_hazards,
)
from app.caddie.strokes_gained import _FAIRWAY_TABLE, _handicap_multiplier, approach_expected_strokes
from app.caddie.types import CorridorSample, HoleIntelligence

FIXTURES_DIR = pathlib.Path(__file__).parent / "fixtures"

_BAG: dict[str, int] = {"driver": 280, "3wood": 240, "5wood": 220, "hybrid": 200, "7iron": 160}
# The plan's canonical water-pinch bag (specs/caddie-tee-club-expected-
# strokes-plan.md §3's worked example — DEFAULT_CLUB_DISTANCES-shaped, driver
# 250) AND a genuinely longer bag (driver 280) — reviewer B2 requires the
# layup to hold for BOTH, not just a short-driver bag tuned to lay up.
_WATER_BAG: dict[str, int] = {
    "driver": 250, "3wood": 230, "5wood": 215, "hybrid": 200,
    "5iron": 180, "6iron": 170, "7iron": 160,
}
_WATER_BAG_LONG: dict[str, int] = {
    "driver": 280, "3wood": 240, "5wood": 220, "hybrid": 200,
    "5iron": 180, "6iron": 165, "7iron": 150,
}


def _hole(hazards=None, corridor=None, yards: int = 400) -> HoleIntelligence:
    return HoleIntelligence(hole_number=3, par=4, yards=yards, hazards=hazards or [], corridor=corridor)


def _uniform_corridor(width: int, lo: int = 60, hi: int = 360, step: int = 10, source: str = "trees") -> list[CorridorSample]:
    half = width / 2.0
    return [
        CorridorSample(
            distance_yards=d,
            left_yards=round(half), right_yards=round(half), width_yards=width,
            left_source=source, right_source=source,
        )
        for d in range(lo, hi + 1, step)
    ]


def _water_pinch_corridor(water_width: int = 28) -> list[CorridorSample]:
    """Wide (70y) trees to 190y, then a tight (`water_width`) water pinch
    from 200y on — the honest layup case (plan §3's worked example, which
    specifies width 28 — pin the SPEC's geometry, never a width tuned to
    whichever bag happens to lay up)."""
    samples = []
    for d in range(60, 200, 10):
        samples.append(CorridorSample(
            distance_yards=d, left_yards=35, right_yards=35, width_yards=70,
            left_source="trees", right_source="trees",
        ))
    half = water_width / 2.0
    for d in range(200, 320, 10):
        samples.append(CorridorSample(
            distance_yards=d, left_yards=half, right_yards=half, width_yards=water_width,
            left_source="water", right_source="water",
        ))
    return samples


def _physics_total(club: str, dist: int) -> int:
    cond, _ = physics.conditions_from_weather(None, 0.0, elevation_delta_ft=0.0, carry_hint_yards=float(dist))
    return round(physics.shot_distance_for_club(club, float(dist), cond).total_yards)


# ── 1. Open/unknown hole -> driver, P≈0 (plan §3, design decision 4) ────────


def test_01_wide_corridor_driver_wins_p_near_zero():
    hole = _hole(corridor=_uniform_corridor(80), yards=400)
    rec = generate_recommendation(hole, 400, _BAG, handicap=15)
    n = rec.tee_shot_numbers
    assert n is not None
    assert n.club == "driver"
    assert n.corridor_trouble_pct is not None
    assert n.corridor_trouble_pct <= 5  # "P≈0" per plan


def test_02_unknown_corridor_evidence_driver_wins_no_penalty():
    # Only narrow evidence far short of every candidate's landing distance —
    # driver's own landing carries no sample at all.
    corridor = [
        CorridorSample(distance_yards=70, left_yards=5, right_yards=5, width_yards=10,
                        left_source="trees", right_source="trees"),
    ]
    hole = _hole(corridor=corridor, yards=400)
    rec = generate_recommendation(hole, 400, _BAG, handicap=15)
    n = rec.tee_shot_numbers
    assert n is not None
    assert n.club == "driver"


def test_03_corridor_none_byte_identical_to_v1():
    hole = _hole(corridor=None, yards=400)
    rec = generate_recommendation(hole, 400, _BAG, handicap=15)
    n = rec.tee_shot_numbers
    assert n is not None
    assert n.club == "driver"
    assert n.corridor_trouble_pct is None
    assert n.corridor_alt_club is None
    assert not any("beats that trade" in line for line in rec.reasoning)


# ── 2. Tight trees w=40 @467y -> driver (the before-6iron case), E pinned ──
#
# Reproduces plan §1's diagnosed cascade fixture almost exactly: a uniform
# 40y-wide tree corridor on a 467y par-4 used to fall through the old
# ±1.5σ-window hard wall to a mid-iron (driver's 56.25y window > 40,
# rejected; 7iron's 36y window <= 40, accepted — the owner's exact bug).
# The E-model instead picks driver outright.


def test_04_tight_trees_w40_driver_wins_e_ordering_pinned():
    corridor = _uniform_corridor(40)
    fit = _select_club_expected_strokes(
        _BAG, corridor, 467, 15, None, 0.0, 0.0, False, ceiling_total_yards=999,
    )
    assert fit is not None
    assert fit.club == "driver"
    assert fit.alt_club is None  # nothing shorter beat it

    # E strictly increases as the bag gets shorter on this profile — pin the
    # full ordering, not just the winner (verified against a real run of
    # this exact fixture; tolerance covers cross-platform float noise). Cost
    # is handicap-scaled (reviewer B2 fix) by the SAME multiplier
    # approach_expected_strokes already applies to the approach term.
    hcp_mult = _handicap_multiplier(15)
    es: dict[str, float] = {}
    for club, dist in _BAG.items():
        total = _physics_total(club, dist)
        leave = max(0, 467 - total)
        e_ap = approach_expected_strokes(leave, 15)
        sample = corridor_sample_at(corridor, total)
        p_left, p_right = _trouble_probability(sample, club, 15)
        cost = _PENALTY_COST["trees"] * hcp_mult
        es[club] = e_ap + p_left * cost + p_right * cost

    ordered = sorted(es, key=lambda c: es[c])
    assert ordered == ["driver", "3wood", "5wood", "hybrid", "7iron"]
    assert es["driver"] == pytest.approx(4.080, abs=0.01)
    assert fit.e_total == pytest.approx(es["driver"], abs=1e-6)

    # Full generate_recommendation path: driver stays, note states the
    # tree-risk tradeoff with the payload's own numbers.
    hole = _hole(corridor=corridor, yards=467)
    rec = generate_recommendation(hole, 467, _BAG, handicap=15)
    n = rec.tee_shot_numbers
    assert n is not None
    assert n.club == "driver"
    note = next((line for line in rec.reasoning if "beats that trade" in line), None)
    assert note is not None
    assert "Driver" in note
    assert f"{n.corridor_trouble_pct}%" in note
    assert "tree" in note


# ── 3. Water pinch -> honest layup, both clubs' P in the payload ───────────
#
# Width PINNED at the plan's spec value (28), never narrowed to whichever
# width a given bag happens to lay up at (reviewer B1). Checked against BOTH
# the plan's canonical (driver-250) bag AND a genuinely longer (driver-280)
# bag — reviewer B2's fix (handicap-scaled `_PENALTY_COST`) must lay up for
# both, not just a short-driver bag.


def test_05_water_pinch_lays_up_note_numbers_match_payload():
    corridor = _water_pinch_corridor(water_width=28)
    hole = _hole(corridor=corridor, yards=440)
    rec = generate_recommendation(hole, 440, _WATER_BAG, handicap=15)

    n = rec.tee_shot_numbers
    assert n is not None
    assert n.club == "5iron"  # genuinely beats driver on expected strokes
    assert n.corridor_trouble_pct is not None
    assert n.corridor_alt_club == "driver"
    assert n.corridor_alt_trouble_pct is not None
    assert n.corridor_alt_leave_yards is not None
    # The layup club's own trouble% is much lower than driver's — the honest
    # tradeoff the swap note narrates.
    assert n.corridor_trouble_pct < n.corridor_alt_trouble_pct
    assert n.corridor_alt_trouble_pct >= 35  # driver is genuinely reckless here

    note = next((line for line in rec.reasoning if "lays back" in line), None)
    assert note is not None
    assert "5 Iron" in note
    assert "Driver" in note
    assert "water" in note  # the pinch location is named from the water evidence

    payload_ints = {
        int(v) for v in (
            n.hole_number, n.to_green_yards, n.plays_like_yards, n.club_stored_yards,
            n.drive_carry_yards, n.drive_total_yards, n.leave_exact_yards, n.leave_yards,
            n.leave_plays_like_yards, n.corridor_trouble_pct, n.corridor_alt_trouble_pct,
            n.corridor_alt_leave_yards, n.corridor_alt_total_yards,
        )
        if v is not None
    }
    # Only 2+ digit tokens are yardages/percentages claimed as numbers — a
    # single digit is a club-name token ("5 Iron"), not a claimed number.
    note_ints = {int(tok) for tok in re.findall(r"\d{2,}", note)}
    assert note_ints <= payload_ints, f"{note_ints - payload_ints} not in payload"


def test_05b_water_pinch_lays_up_for_a_long_driver_bag_too():
    """Reviewer B1's mandated long-bag regression: the SAME width-28 pinch
    must ALSO lay up for a 280y-driver bag, not just a short-driver bag —
    otherwise the flat-cost bug (B2) that kept driver reckless for longer
    bags would still be masked."""
    corridor = _water_pinch_corridor(water_width=28)
    hole = _hole(corridor=corridor, yards=440)
    rec = generate_recommendation(hole, 440, _WATER_BAG_LONG, handicap=15)
    n = rec.tee_shot_numbers
    assert n is not None
    assert n.club != "driver"
    assert n.corridor_alt_club == "driver"
    assert n.corridor_alt_trouble_pct is not None
    assert n.corridor_alt_trouble_pct >= 35  # driver's own risk here is genuinely high


def test_06_water_pinch_competition_legal_same_club_as_physics():
    """competition_legal walks stored numbers — same club chosen as the
    physics walk when weather is None (plan §6's competition-legal gate)."""
    corridor = _water_pinch_corridor(water_width=28)
    hole = _hole(corridor=corridor, yards=440)
    rec_physics = generate_recommendation(hole, 440, _WATER_BAG, handicap=15, competition_legal=False)
    rec_legal = generate_recommendation(hole, 440, _WATER_BAG, handicap=15, competition_legal=True)
    assert rec_physics.club == rec_legal.club == "5iron"


# ── 4. Guardrail: trees alone can never justify a big layback ──────────────


def test_07_guardrail_uniform_tree_widths_never_layback_more_than_40():
    driver_total = _physics_total("driver", _BAG["driver"])
    for width in range(10, 81, 5):
        corridor = _uniform_corridor(width)
        fit = _select_club_expected_strokes(
            _BAG, corridor, 467, 15, None, 0.0, 0.0, False, ceiling_total_yards=999,
        )
        assert fit is not None
        assert fit.total >= driver_total - 40, (
            f"width={width}: chosen total {fit.total} laid back more than 40y "
            f"off driver's {driver_total} on trees alone"
        )


# ── 5. Floor: never lay back more than 100y off the longest survivor ───────


def test_08_floor_excludes_candidates_more_than_100y_short():
    # Water blankets every landing distance from 150y to 360y — every club
    # from PW up through driver that lands in that band is unsafe; only the
    # short wedges (landing < 150) are genuinely safe. Without the floor the
    # E-model would want to lay all the way back to a 9-iron; the floor
    # refuses and driver (the only candidate the floor + ceiling leave
    # standing with real evidence) stays.
    bag = {
        "driver": 280, "3wood": 240, "5wood": 220, "hybrid": 200, "5iron": 180,
        "6iron": 165, "7iron": 150, "8iron": 140, "9iron": 130, "pw": 115,
    }
    half = 3.0
    corridor = [
        CorridorSample(distance_yards=d, left_yards=half, right_yards=half, width_yards=6,
                        left_source="water", right_source="water")
        for d in range(150, 361, 10)
    ]
    driver_total = _physics_total("driver", bag["driver"])
    fit = _select_club_expected_strokes(
        bag, corridor, 440, 15, None, 0.0, 0.0, False, ceiling_total_yards=999,
    )
    assert fit is not None
    assert fit.total >= driver_total - 100
    assert fit.club == "driver"  # the "safe" 9-iron the floor exists to forbid


# ── 6. approach_expected_strokes: monotone + continuous at the 260y seam ───


def test_09_approach_expected_strokes_strictly_increasing():
    prev = None
    for leave in range(30, 500):
        value = approach_expected_strokes(float(leave), 15)
        if prev is not None:
            assert value > prev, f"not strictly increasing at leave={leave}"
        prev = value


def test_10_approach_expected_strokes_continuous_at_260():
    head_distance, head_strokes = _FAIRWAY_TABLE[0]
    assert head_distance == 260
    at_seam = approach_expected_strokes(260.0, 15)
    just_past = approach_expected_strokes(260.0001, 15)
    just_before = approach_expected_strokes(259.9999, 15)
    assert at_seam == pytest.approx(just_past, abs=1e-3)
    assert at_seam == pytest.approx(just_before, abs=1e-3)


def test_11_approach_expected_strokes_matches_expected_strokes_within_table():
    from app.caddie.strokes_gained import expected_strokes
    for leave in (30, 100, 180, 220, 260):
        assert approach_expected_strokes(float(leave), 15) == pytest.approx(
            expected_strokes(float(leave), "fairway", 15)
        )


# ── 7. Real fixtures: bethpage_red_trees.json (plan §2's before-table) ─────


def _build_fc(hole: dict) -> dict:
    """Same reconstruction recipe as test_red1_acceptance.py::_build_fc."""
    features: list[dict] = []
    for tee_geom in hole["tees"]:
        features.append({"type": "Feature", "properties": {"featureType": "tee"}, "geometry": tee_geom})
    features.append({"type": "Feature", "properties": {"featureType": "green"}, "geometry": hole["green_geom"]})
    features.append({
        "type": "Feature",
        "properties": {"featureType": "hole"},
        "geometry": {"type": "LineString", "coordinates": hole["hole_line"]},
    })
    for tf in hole["tree_features"]:
        features.append({"type": "Feature", "properties": {"featureType": tf["ft"]}, "geometry": tf["geom"]})
    return {"type": "FeatureCollection", "features": features}


@pytest.fixture(scope="module")
def red_trees_fixture() -> dict:
    return json.loads((FIXTURES_DIR / "bethpage_red_trees.json").read_text())


def _hole_intel_from_fixture(fixture: dict, num: str, par: int, yards: int) -> HoleIntelligence:
    fc = _build_fc(fixture[num])
    hazards = extract_hole_hazards(fc)
    corridor = extract_corridor_profile(fc)
    bend = extract_hole_bend(fc)
    return HoleIntelligence(hole_number=int(num), par=par, yards=yards, hazards=hazards, corridor=corridor, bend=bend)


def test_12_red1_driver_stays_unknown_width_never_rejects(red_trees_fixture):
    hole = _hole_intel_from_fixture(red_trees_fixture, "1", par=4, yards=467)
    rec = generate_recommendation(hole, 467, {}, handicap=15)  # DEFAULT_CLUB_DISTANCES
    assert rec.club == "driver"
    assert rec.tee_shot_numbers is not None
    assert rec.tee_shot_numbers.leave_yards == 210


def test_13_red6_5iron_via_bend_cap_unchanged(red_trees_fixture):
    """The v1 bend-cap composes UNCHANGED with the new E-model — Red 6 has no
    corridor-width profile (`extract_corridor_profile` returns None here per
    plan §2), so this new block never runs; the bend-cap alone still lands
    5-iron/leave-100, exactly as before this fix."""
    hole = _hole_intel_from_fixture(red_trees_fixture, "6", par=4, yards=287)
    assert hole.corridor is None  # sanity: the E-model block is skipped
    rec = generate_recommendation(hole, 287, {}, handicap=15)
    assert rec.club == "5iron"
    assert rec.tee_shot_numbers is not None
    assert rec.tee_shot_numbers.leave_yards == 100
    assert any("runs through the corner" in line for line in rec.reasoning)


# ── 8. Assemble Red from bethpage_overpass.json: all 14 par-4/5s -> driver ──
#
# The committed Overpass fixture predates tree/woods fetching
# (`extract_corridor_profile` returns None on every hole), so this is a
# corridor-None byte-identity regression guard, not a width-mechanism test
# (plan §2's honest limitation).

_LAT_M_PER_DEG = 111_320.0
_M_PER_YARD = 0.9144


def _linestring_yards(coords: list) -> float | None:
    if len(coords) < 2:
        return None
    lon1, lat1 = coords[0]
    lon2, lat2 = coords[-1]
    mid_lat_rad = math.radians((lat1 + lat2) / 2.0)
    dx_m = (lon2 - lon1) * _LAT_M_PER_DEG * math.cos(mid_lat_rad)
    dy_m = (lat2 - lat1) * _LAT_M_PER_DEG
    return math.hypot(dx_m, dy_m) / _M_PER_YARD


def test_14_assemble_red_all_par4_par5_holes_driver():
    from app.services.osm import _parse_course_geometry_response
    from app.services.osm_ingest import _deterministic_uuid, assemble_osm_course

    raw = json.loads((FIXTURES_DIR / "bethpage_overpass.json").read_text())
    geometry = _parse_course_geometry_response(raw, course_name_filter=None)
    course_id = _deterministic_uuid("osm-bethpage-red")
    assembled = assemble_osm_course(
        geometry=geometry, course_id=course_id, course_name="Bethpage Red",
        target_course_name="Red", address="99 Quaker Meeting House Rd",
        location={"lat": 40.7445, "lng": -73.4609},
    )
    bag = {"driver": 280, "3wood": 240, "5wood": 220, "hybrid": 200, "6iron": 165, "8iron": 140, "pw": 120}

    checked = 0
    for h in assembled["holes"]:
        if h["par"] == 3:
            continue
        fc = h["features"]
        corridor = extract_corridor_profile(fc)
        assert corridor is None  # the fixture-gap this test documents
        hole_feat = next(
            (f for f in fc["features"] if (f.get("properties") or {}).get("featureType") == "hole"), None,
        )
        coords = (hole_feat.get("geometry") or {}).get("coordinates") if hole_feat else None
        if not coords:
            continue
        yards = round(_linestring_yards(coords))
        hazards = extract_hole_hazards(fc)
        bend = extract_hole_bend(fc)
        hole = HoleIntelligence(hole_number=h["number"], par=h["par"], yards=yards, hazards=hazards, corridor=corridor, bend=bend)
        rec = generate_recommendation(hole, yards, bag, handicap=15)
        assert rec.club == "driver", f"hole {h['number']}: expected driver, got {rec.club}"
        checked += 1

    assert checked == 14


# ── 9. Par-3s never enter the positioning/corridor path ─────────────────────


def test_15_reachable_par3_never_gets_tee_shot_numbers():
    corridor = _uniform_corridor(5)  # would reject everything if it ran
    hole = _hole(corridor=corridor, yards=230)
    rec = generate_recommendation(hole, 230, {"driver": 250}, handicap=15)
    assert rec.shot_kind == "approach"
    assert rec.tee_shot_numbers is None
    assert rec.leave_yards is None
