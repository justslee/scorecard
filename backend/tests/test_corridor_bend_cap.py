"""Regression tests for corridor v1 — the bend-aware club cap
(specs/caddie-numbers-coherence-plan.md §4.1, §7).

Owner incident (2026-07-12, Bethpage RED 3, black tees): the caddie said
"you're gonna need your driver here" on a dogleg with a mapped corner @226y
and trees tight both sides — driver's drive flies clean through the corner
into the trees. `hole.bend` was already known (the app's own map draws the
corner) but nothing consulted it for CLUB selection, only for a P2 color
line. This is v1: bend-cap ONLY (the full corridor-WIDTH club selection is
specs/caddie-numbers-coherence-plan.md §4.4, a fully-specified follow-up —
not built here).

Pure, no DB/network — mirrors `test_positioning_shot.py`'s fixture style.
"""

from __future__ import annotations

from app.caddie.aim_point import generate_recommendation
from app.caddie.types import Hazard, HoleBend, HoleIntelligence

# Red-3 shape: driver-280 bag, corner @226y, trees tight both sides past it.
_BAG: dict[str, int] = {"driver": 280, "3wood": 240, "5wood": 220, "hybrid": 200, "7iron": 160}
_BEND = HoleBend(straight=False, direction="left", distance_yards=226, deviation_yards=88)


def _hazards_both_sides(carry: int = 230) -> list[Hazard]:
    return [
        Hazard(type="trees", side="left", line_side="left", carry_yards=carry, penalty_severity="moderate"),
        Hazard(type="trees", side="right", line_side="right", carry_yards=carry, penalty_severity="moderate"),
    ]


def _hole(bend, hazards) -> HoleIntelligence:
    return HoleIntelligence(hole_number=3, par=4, yards=400, hazards=hazards, bend=bend)


def test_corridor_caps_club_short_of_the_corner():
    hole = _hole(_BEND, _hazards_both_sides())
    rec = generate_recommendation(hole, 400, _BAG, handicap=15)

    n = rec.tee_shot_numbers
    assert n is not None
    assert n.club != "driver"
    assert n.drive_total_yards <= 221  # bend.distance_yards(226) - 5

    joined = " ".join(rec.reasoning).lower()
    assert "corner" in joined
    assert "trees" in joined

    # The capped club's numbers still close exactly — gate (1) unaffected.
    assert n.to_green_yards - n.drive_total_yards == n.leave_exact_yards


def test_no_bend_data_no_cap():
    """Unmapped centerline (bend=None) — honest degradation, driver stays the
    call. No fabricated corridor claim."""
    hole = _hole(None, _hazards_both_sides())
    rec = generate_recommendation(hole, 400, _BAG, handicap=15)

    assert rec.tee_shot_numbers is not None
    assert rec.tee_shot_numbers.club == "driver"
    joined = " ".join(rec.reasoning).lower()
    assert "corner" not in joined


def test_corner_without_trees_no_cap():
    """A mapped corner with no tree evidence guarding it doesn't cap the
    club — normal cut-the-corner doglegs (no tree wall) keep today's
    behavior; only tree-evidenced corners cap. The generic bend color line
    ("that corner is your landing zone") may still fire — that's pre-existing,
    honest, non-fabricated color, not the corridor-cap claim this test guards."""
    hole = _hole(_BEND, [])
    rec = generate_recommendation(hole, 400, _BAG, handicap=15)

    assert rec.tee_shot_numbers is not None
    assert rec.tee_shot_numbers.club == "driver"
    joined = " ".join(rec.reasoning).lower()
    assert "runs through the corner" not in joined
    assert "keeps you short of it" not in joined


def test_straight_hole_no_cap():
    """A measured-straight hole (bend.straight=True) never caps — the cap is
    gated on `not bend.straight` explicitly."""
    straight = HoleBend(straight=True, direction=None, distance_yards=None, deviation_yards=3)
    hole = _hole(straight, _hazards_both_sides())
    rec = generate_recommendation(hole, 400, _BAG, handicap=15)

    assert rec.tee_shot_numbers is not None
    assert rec.tee_shot_numbers.club == "driver"


def test_corner_too_close_no_cap():
    """A corner mapped inside CORNER_MIN_DISTANCE_YDS (120) never caps — the
    whole 'which club reaches it' question is moot that close to the tee."""
    close_bend = HoleBend(straight=False, direction="left", distance_yards=90, deviation_yards=40)
    hole = _hole(close_bend, _hazards_both_sides(carry=90))
    rec = generate_recommendation(hole, 400, _BAG, handicap=15)

    assert rec.tee_shot_numbers is not None
    assert rec.tee_shot_numbers.club == "driver"


def test_drive_landing_short_of_corner_no_cap():
    """A shorter-hitting bag whose driver already lands short of the corner
    (no overshoot) never caps — the cap only fires on a real fly-through."""
    short_bag = {"driver": 190, "7iron": 160}
    hole = _hole(_BEND, _hazards_both_sides())
    rec = generate_recommendation(hole, 400, short_bag, handicap=15)

    assert rec.tee_shot_numbers is not None
    assert rec.tee_shot_numbers.club == "driver"
