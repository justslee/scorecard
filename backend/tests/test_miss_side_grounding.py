"""Regression tests for `compute_positioning_miss_side`'s honest degradation
(specs/caddie-numbers-coherence-plan.md §3, §7).

Owner incidents:
  - Bethpage Black hole 1 — trees mapped on BOTH sides of the drive zone,
    equal severity. A bare `<=` tie-break spoke a confident "favor the left
    side off the tee" when there was no good miss.
  - Bethpage Red 3 — "that bunker right" fabricated in a driving zone whose
    real (and only in-window) hazard was trees.

Pure, no DB/network — mirrors `test_positioning_shot.py`'s fixture style.
"""

from __future__ import annotations

from app.caddie.aim_point import compute_positioning_aim, compute_positioning_miss_side, generate_recommendation
from app.caddie.types import Hazard, HoleIntelligence


def _tree(side: str, carry: int = 250, severity: str = "moderate") -> Hazard:
    return Hazard(type="trees", side=side, line_side=side, carry_yards=carry, penalty_severity=severity)


def _water(side: str, carry: int = 250, severity: str = "death") -> Hazard:
    return Hazard(type="water", side=side, line_side=side, carry_yards=carry, penalty_severity=severity)


# ── Gate (3): trees-both-sides → center, never a one-sided "favor" ──────────


def test_trees_both_sides_equal_severity_is_center_no_good_miss():
    zone = [_tree("left", carry=250), _tree("right", carry=250)]
    miss = compute_positioning_miss_side(zone)

    assert miss.preferred == "center"
    assert "both sides" in miss.description.lower()
    assert "favor the left" not in miss.description.lower()
    assert "favor the right" not in miss.description.lower()


def test_trees_left_only_never_says_left_is_the_miss():
    """One side clean, one side has mapped trouble — a clear winner, and the
    caddie must NEVER call the trouble side (left) the preferred miss."""
    zone = [_tree("left", carry=250)]
    miss = compute_positioning_miss_side(zone)

    assert miss.preferred == "right"
    assert "left" not in miss.preferred
    assert "left" in miss.avoid.lower()


def test_no_drive_zone_hazards_stays_todays_generic():
    """Gate (3) regression guard: an empty zone keeps the honest generic —
    untouched by the both-sides fix."""
    miss = compute_positioning_miss_side([])
    assert miss.preferred == "short"
    assert "no mapped trouble" in miss.description.lower()


# ── Tie with different hazard TYPES (still a tie by severity score) ─────────


def test_tie_with_different_types_names_both():
    """Water (death) left vs trees (moderate) right is NOT a tie — the
    higher-severity side (water, death) is worse, so the caddie favors the
    lower-risk side (right) and still names both sides' real trouble."""
    zone = [_water("left", severity="death"), _tree("right", severity="moderate")]
    miss = compute_positioning_miss_side(zone)

    assert miss.preferred == "right"
    assert "left" in miss.avoid.lower()
    assert "water" in miss.avoid.lower()


def test_true_severity_tie_different_types_is_still_center():
    """Both sides carry the SAME severity score (moderate), different hazard
    types — still an honest both-sides degradation, not a coin-flip 'favor'."""
    zone = [_tree("left", severity="moderate"), _water("right", severity="moderate")]
    miss = compute_positioning_miss_side(zone)

    assert miss.preferred == "center"
    assert "trees" in miss.description.lower()
    assert "water" in miss.description.lower()


# ── Clear winner that ALSO has mapped trouble names its own risk ────────────


def test_clear_winner_with_own_trouble_is_named_not_hidden():
    """Right is worse (severe), but left ALSO has mapped trees (mild) — the
    preferred side's own risk must be named, never a clean 'favor left'."""
    zone = [
        Hazard(type="trees", side="left", line_side="left", carry_yards=250, penalty_severity="mild"),
        Hazard(type="water", side="right", line_side="right", carry_yards=250, penalty_severity="severe"),
    ]
    miss = compute_positioning_miss_side(zone)

    assert miss.preferred == "left"
    assert "worse" in miss.description.lower()
    assert "trees" in miss.description.lower()  # the preferred side's own risk is named
    assert "in play too" in miss.description.lower()


# ── Aim/miss coherence: a center verdict never gets a lateral aim clause ────


def test_center_preference_coherence_with_aim():
    """`compute_positioning_aim` with no landing_advice (the caller's job —
    generate_recommendation nulls it out when miss.preferred == 'center') is
    always the plain 'middle of the fairway' clause — aim and miss can never
    point different ways."""
    aim = compute_positioning_aim(150, landing_advice=None)
    assert "middle of the fairway" in aim.description.lower()


def test_generate_recommendation_bethpage1_shape_aim_and_miss_agree():
    """End-to-end (specs/caddie-numbers-coherence-plan.md §1.4/§3.1): a
    faithful Bethpage-1 shape — trees mapped on BOTH sides of the driving
    zone — must never produce the incident's contradiction (aim says one
    thing, miss says another). `miss.preferred == 'center'` forces the aim's
    side clause to 'middle of the fairway', never a lateral favor."""
    hazards = [
        Hazard(type="trees", side="left", line_side="left", carry_yards=280, penalty_severity="moderate"),
        Hazard(type="trees", side="right", line_side="right", carry_yards=280, penalty_severity="moderate"),
    ]
    hole = HoleIntelligence(hole_number=1, par=4, yards=466, hazards=hazards)
    rec = generate_recommendation(hole, 466, {"driver": 300}, handicap=15)

    assert rec.miss_side.preferred == "center"
    assert "both sides" in rec.miss_side.description.lower()
    assert "middle of the fairway" in rec.aim_point.description.lower()
    assert "favor the left" not in rec.aim_point.description.lower()
    assert "favor the right" not in rec.aim_point.description.lower()
