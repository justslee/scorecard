"""Unit tests for the positioning-shot (reachability) fix — pure, no DB/network.

specs/caddie-shot-context-reachability-plan.md — owner incident 2026-07-06:
on a ~400y par 4 (blue tees), asked "What club should I hit?", the caddie
said "Driver's the call. Aim about 9 yards left of the flag to stay away
from those right-side trees." The green was never in reach off the tee, so
any pin-relative aim was wrong golf reasoning. When the best club in the bag
can't reach the green (plus a front-edge margin), `generate_recommendation`
must switch to a POSITIONING shot: landing-zone advice (which side of the
fairway, driving-zone hazards only, the approach it leaves) instead of a
flag-relative aim. Reachable shots (par 3, drivable par 4, normal approach)
must stay on today's flag path, byte-identical.
"""

from __future__ import annotations

import re

from app.caddie.aim_point import (
    GREEN_REACH_MARGIN_YDS,
    compute_aim_point,
    generate_recommendation,
    is_green_reachable,
)
from app.caddie.decade_advice import (
    DRIVE_ZONE_LONG_YDS,
    DRIVE_ZONE_SHORT_YDS,
    decade_landing_advice,
    drive_zone_hazards,
)
from app.caddie.types import CaddieRecommendation, Hazard, HoleIntelligence, HoleBend


# ── helpers ───────────────────────────────────────────────────────────────────

_STANDARD_BAG: dict[str, int] = {
    "driver": 250,
    "3wood": 230,
    "7iron": 160,
    "9iron": 140,
    "pw": 130,
    "sw": 100,
}


def _make_hole(
    hazards: list[Hazard] | None = None,
    par: int = 4,
    yards: int | None = 400,
    elevation: float = 0.0,
    green_depth_yards: float | None = None,
    bend: HoleBend | None = None,
) -> HoleIntelligence:
    return HoleIntelligence(
        hole_number=1,
        par=par,
        yards=yards,
        elevation_change_ft=elevation,
        hazards=hazards or [],
        green_depth_yards=green_depth_yards,
        bend=bend,
    )


def _human_strings(rec: CaddieRecommendation) -> list[str]:
    """Every human-facing string on a recommendation — the surface the
    positioning fix must keep pin/flag-free."""
    return [
        rec.aim_point.description,
        *rec.reasoning,
        rec.miss_side.description,
        rec.miss_side.avoid,
    ]


_FLAG_PIN_RE = re.compile(r"\b(flag|pin)\b", re.I)


def _assert_no_flag_or_pin(rec: CaddieRecommendation) -> None:
    """Word-boundary scan — "positioning" must not trip it; deliberately
    excludes internal keys like `pin_traffic_light` (never scanned here,
    only human-facing strings are)."""
    for s in _human_strings(rec):
        assert not _FLAG_PIN_RE.search(s), f"flag/pin leaked into: {s!r}"


# ── T1 ──────────────────────────────────────────────────────────────────────


def test_400y_tee_shot_is_positioning_with_leave():
    hole = _make_hole(yards=400)
    rec = generate_recommendation(hole, 400, _STANDARD_BAG, handicap=15)

    assert rec.shot_kind == "positioning"
    # specs/caddie-numbers-coherence-plan.md §2.2: the leave now speaks the
    # RAW-closing frame (to_green_yards - the physics-solved drive total),
    # not the plays-like-minus-stored-bag-number frame — was 150 before this
    # redefinition; 140 is the exact physics-consistent close for a 250y
    # stored driver in still air (drive_total ≈259, 400-259=141 → round-5).
    assert rec.leave_yards == 140
    _assert_no_flag_or_pin(rec)

    joined = " ".join(_human_strings(rec))
    assert "140" in joined
    assert "fairway" in rec.aim_point.description.lower()


# ── T2 ──────────────────────────────────────────────────────────────────────


def test_positioning_with_drive_zone_trees_favors_safe_side():
    hazard = Hazard(
        type="trees", side="right", line_side="right",
        carry_yards=250, distance_from_green=150, penalty_severity="moderate",
    )
    hole = _make_hole(hazards=[hazard], yards=400)
    rec = generate_recommendation(hole, 400, _STANDARD_BAG, handicap=15)

    _assert_no_flag_or_pin(rec)
    joined = " ".join(_human_strings(rec)).lower()
    assert "left" in joined
    assert "trees" in joined
    assert "right" in rec.miss_side.avoid.lower()


# ── T3 ──────────────────────────────────────────────────────────────────────


def test_green_side_hazard_not_in_positioning_advice():
    # distance_from_green=5 (greenside), carry_yards=395 — outside the
    # driving zone for a 250y drive (window is [200, 280]).
    hazard = Hazard(
        type="water", side="front", line_side="center",
        carry_yards=395, distance_from_green=5.0, penalty_severity="death",
    )
    hole = _make_hole(hazards=[hazard], yards=400)
    rec = generate_recommendation(hole, 400, _STANDARD_BAG, handicap=15)

    assert rec.shot_kind == "positioning"
    joined = " ".join(_human_strings(rec)).lower()
    assert "water" not in joined


# ── T4 (regression guard) ────────────────────────────────────────────────────


def test_par3_flag_path_unchanged():
    hole = _make_hole(par=3, yards=165, hazards=[])
    rec = generate_recommendation(hole, 165, _STANDARD_BAG, handicap=15)

    assert rec.shot_kind == "approach"
    assert rec.leave_yards is None
    assert rec.aim_point.description == compute_aim_point(hole, None).description
    assert "flag" in rec.aim_point.description.lower()


# ── T5 ────────────────────────────────────────────────────────────────────


def test_short_approach_unchanged():
    hazard = Hazard(type="water", side="right", line_side="right", penalty_severity="severe", distance_from_green=5.0)
    hole = _make_hole(hazards=[hazard], yards=400)
    rec = generate_recommendation(hole, 150, _STANDARD_BAG, handicap=15)

    assert rec.shot_kind == "approach"
    assert any("yellow" in r.lower() and "pin" in r.lower() for r in rec.reasoning)


# ── T6 ────────────────────────────────────────────────────────────────────


def test_drivable_par4_reachable_flag_ok():
    bag = dict(_STANDARD_BAG)
    bag["driver"] = 290
    hole = _make_hole(par=4, yards=280, hazards=[])
    rec = generate_recommendation(hole, 280, bag, handicap=15)

    assert rec.shot_kind == "approach"


# ── T7 ────────────────────────────────────────────────────────────────────


def test_reach_margin_boundary():
    assert GREEN_REACH_MARGIN_YDS == 15

    bag = {"driver": 250}
    hole_265 = _make_hole(yards=265)
    rec_265 = generate_recommendation(hole_265, 265, bag, handicap=15)
    assert rec_265.shot_kind == "approach"

    hole_270 = _make_hole(yards=270)
    rec_270 = generate_recommendation(hole_270, 270, bag, handicap=15)
    assert rec_270.shot_kind == "positioning"


# ── T8 ────────────────────────────────────────────────────────────────────


def test_green_depth_overrides_margin():
    bag = {"driver": 250}
    hole_with_depth = _make_hole(yards=268, green_depth_yards=40.0)
    rec_with_depth = generate_recommendation(hole_with_depth, 268, bag, handicap=15)
    assert rec_with_depth.shot_kind == "approach"

    hole_no_depth = _make_hole(yards=268)
    rec_no_depth = generate_recommendation(hole_no_depth, 268, bag, handicap=15)
    assert rec_no_depth.shot_kind == "positioning"


# ── T9 ────────────────────────────────────────────────────────────────────


def test_par5_layup_positioning_then_go_zone():
    bag = {"driver": 230, "3wood": 210, "7iron": 160}
    hole = _make_hole(par=5, yards=520)

    rec_layup = generate_recommendation(hole, 270, bag, handicap=15)
    assert rec_layup.shot_kind == "positioning"
    # specs/caddie-numbers-coherence-plan.md §2.2 leave-frame redefinition
    # (see test_400y_tee_shot_is_positioning_with_leave) — was 40 before;
    # 30 is the physics-consistent raw close for a 230y stored driver.
    assert rec_layup.leave_yards == 30
    _assert_no_flag_or_pin(rec_layup)

    rec_go = generate_recommendation(hole, 240, bag, handicap=15)
    assert rec_go.shot_kind == "approach"


# ── T10 ───────────────────────────────────────────────────────────────────


def test_elevation_flips_reachability():
    bag = {"driver": 250}
    hole_flat = _make_hole(yards=262, elevation=0.0)
    rec_flat = generate_recommendation(hole_flat, 262, bag, handicap=15)
    assert rec_flat.shot_kind == "approach"

    hole_uphill = _make_hole(yards=262, elevation=60.0)
    rec_uphill = generate_recommendation(hole_uphill, 262, bag, handicap=15)
    assert rec_uphill.shot_kind == "positioning"


# ── T11 ───────────────────────────────────────────────────────────────────


def test_no_geometry_honest_generic():
    hole = _make_hole(hazards=[], yards=400, bend=None)
    rec = generate_recommendation(hole, 400, {"driver": 250}, handicap=15)

    assert rec.shot_kind == "positioning"
    joined = " ".join(_human_strings(rec)).lower()
    for forbidden in ("bunker", "water", "trees", "dogleg", "bend"):
        assert forbidden not in joined
    # specs/caddie-numbers-coherence-plan.md §2.2 leave-frame redefinition —
    # same 400y/driver-250 shape as test_400y_tee_shot_is_positioning_with_leave.
    assert "140" in joined
    assert "fairway" in joined


# ── T12 ───────────────────────────────────────────────────────────────────


def test_positioning_no_decade_pin_advice():
    hazard = Hazard(
        type="trees", side="right", line_side="right",
        carry_yards=250, distance_from_green=150, penalty_severity="moderate",
    )
    hole = _make_hole(hazards=[hazard], yards=400)
    rec = generate_recommendation(hole, 400, {"driver": 250}, handicap=15)

    joined = " ".join(_human_strings(rec)).lower()
    assert "of the flag" not in joined
    assert "percentages favor aiming" not in joined


# ── T13-T15: decade_landing_advice unit tests ────────────────────────────────


def test_decade_landing_advice_favors_side_away_from_hazard():
    hazard = Hazard(type="water", side="left", line_side="left", carry_yards=240, penalty_severity="death")
    advice = decade_landing_advice([hazard], expected_advance_yds=250, leave_yds=150)

    assert advice is not None
    assert "right" in advice
    assert "water" in advice.lower()
    assert not _FLAG_PIN_RE.search(advice)


def test_decade_landing_advice_hazard_outside_window_is_none():
    # advance=250 -> window is [200, 280]; carry_yards=150 is outside it.
    hazard = Hazard(type="water", side="left", line_side="left", carry_yards=150, penalty_severity="death")
    advice = decade_landing_advice([hazard], expected_advance_yds=250, leave_yds=150)
    assert advice is None


def test_decade_landing_advice_degenerate_carry_yards_is_none():
    hazard = Hazard(type="water", side="left", line_side="left", carry_yards=0, penalty_severity="death")
    advice = decade_landing_advice([hazard], expected_advance_yds=250, leave_yds=150)
    assert advice is None


def test_drive_zone_hazards_window_boundaries_pinned():
    assert DRIVE_ZONE_SHORT_YDS == 50.0
    assert DRIVE_ZONE_LONG_YDS == 30.0

    on_short_boundary = Hazard(type="water", side="left", line_side="left", carry_yards=200, penalty_severity="death")
    on_long_boundary = Hazard(type="water", side="left", line_side="left", carry_yards=280, penalty_severity="death")
    just_short_of_window = Hazard(type="water", side="left", line_side="left", carry_yards=199, penalty_severity="death")
    just_past_window = Hazard(type="water", side="left", line_side="left", carry_yards=281, penalty_severity="death")

    assert drive_zone_hazards([on_short_boundary], 250) == [on_short_boundary]
    assert drive_zone_hazards([on_long_boundary], 250) == [on_long_boundary]
    assert drive_zone_hazards([just_short_of_window], 250) == []
    assert drive_zone_hazards([just_past_window], 250) == []


# ── is_green_reachable — direct unit coverage ────────────────────────────────


class TestIsGreenReachable:
    def test_default_margin_used_without_green_depth(self):
        assert is_green_reachable(265, {"driver": 250}) is True
        assert is_green_reachable(266, {"driver": 250}) is False

    def test_green_depth_overrides_default_margin(self):
        assert is_green_reachable(268, {"driver": 250}, green_depth_yards=40.0) is True
        assert is_green_reachable(268, {"driver": 250}) is False

    def test_empty_bag_uses_default_club_distances(self):
        # DEFAULT_CLUB_DISTANCES driver = 250, same fallback select_club uses.
        assert is_green_reachable(265, {}) is True
        assert is_green_reachable(266, {}) is False
