"""Class A fix — bend-cap `corner_trees` filter gets an UPPER bound
(specs/caddie-yardage-selector-p0-plan.md §3.5, Lead 2).

All-courses read-only audit (166 par-4/5 holes, 12 mapped courses, prod DB,
2026-07-18 — see specs/caddie-tee-selector-audit-before.md) convicted the
mechanism: `aim_point.py`'s bend-cap gate filtered corner-guarding trees with
`h.carry_yards >= bend.distance_yards - CORNER_TREE_LOOKBACK_YDS` and NO
upper bound — so a tree hazard 60-280y PAST the mapped corner (typically
clustered near the green) silently counted as "guarding" the dogleg, capping
the drive to a jarring short iron on holes where nothing actually threatens
a fly-through at the corner itself. Critically, `deviation_yards` did NOT
separate the bogus holes from the legit ones (both classes had real,
substantial doglegs) — only the tree's ALONG-PATH position relative to the
corner did. The fix adds `CORNER_TREE_FORWARD_YDS` (40y) as an upper bound.

Two real prod-geometry fixtures (captured read-only) pin the convicted
holes: Pine Valley 9 (nearest qualifying tree was +280y past the corner —
the most extreme case) and Pebble Beach hole 3 (+85y). A synthetic unit test
pins the boundary itself.
"""

from __future__ import annotations

import json
from pathlib import Path

from app.caddie import aim_point
from app.caddie.aim_point import generate_recommendation
from app.caddie.hazards import extract_corridor_profile, extract_hole_bend, extract_hole_hazards
from app.caddie.types import Hazard, HoleBend, HoleIntelligence

FIXTURES_DIR = Path(__file__).parent / "fixtures"

_SUB_HYBRID_CLUBS = frozenset({
    "4iron", "5iron", "6iron", "7iron", "8iron", "9iron", "pw", "gw", "sw", "lw",
})

# The owner's real bag (no hybrid/5wood — specs/caddie-yardage-selector-p0-
# plan.md §3.2), matching the audit script's OWNER_CLUB_DISTANCES exactly.
_OWNER_BAG: dict[str, int] = {
    "driver": 300, "3wood": 270, "4iron": 230, "5iron": 215, "6iron": 195,
    "7iron": 180, "8iron": 170, "9iron": 155, "pw": 140, "gw": 127, "sw": 115, "lw": 90,
}


def _hole_intel_from_geometry_fixture(path: Path, hole_number: int, yards: int) -> HoleIntelligence:
    blob = json.loads(path.read_text())
    fc = blob["features"]
    hazards = extract_hole_hazards(fc)
    bend = extract_hole_bend(fc)
    corridor = extract_corridor_profile(fc)
    return HoleIntelligence(
        hole_number=hole_number, par=blob["par"], yards=yards, effective_yards=yards,
        hazards=hazards, bend=bend, corridor=corridor,
    )


# ── Fixture 1: Pine Valley hole 9 (nearest qualifying tree was +280y past
#    the corner — the most extreme bogus conviction in the audit) ─────────


def test_pine_valley_hole9_after_fix_uncapped():
    hole = _hole_intel_from_geometry_fixture(
        FIXTURES_DIR / "pine_valley_hole9_geometry.json", hole_number=9, yards=554,
    )
    assert hole.bend is not None and not hole.bend.straight  # sanity: a real, mapped dogleg

    rec = generate_recommendation(
        hole=hole, distance_yards=554, club_distances=_OWNER_BAG,
        handicap=3.0, weather=None, shot_bearing=0.0,
    )
    assert rec.club not in _SUB_HYBRID_CLUBS, (
        f"AFTER the CORNER_TREE_FORWARD_YDS fix, Pine Valley 9 must stay "
        f"uncapped (no tree actually guards the corner) — got {rec.club!r}"
    )
    assert rec.club == "driver"


def test_pine_valley_hole9_before_fix_repro_via_monkeypatch(monkeypatch):
    """Reproduces the PRE-FIX bug directly: with no forward bound (the old
    behavior), the same real geometry caps the drive to a sub-hybrid club."""
    hole = _hole_intel_from_geometry_fixture(
        FIXTURES_DIR / "pine_valley_hole9_geometry.json", hole_number=9, yards=554,
    )
    monkeypatch.setattr(aim_point, "CORNER_TREE_FORWARD_YDS", 10_000)  # effectively unbounded (pre-fix)
    rec = generate_recommendation(
        hole=hole, distance_yards=554, club_distances=_OWNER_BAG,
        handicap=3.0, weather=None, shot_bearing=0.0,
    )
    assert rec.club in _SUB_HYBRID_CLUBS, (
        f"pre-fix (unbounded corner_trees filter) must reproduce the bogus "
        f"sub-hybrid cap on Pine Valley 9 — got {rec.club!r}"
    )


# ── Fixture 2: Pebble Beach hole 3 (nearest qualifying tree was +85y past
#    the corner) ─────────────────────────────────────────────────────────


def test_pebble_beach_hole3_after_fix_uncapped():
    hole = _hole_intel_from_geometry_fixture(
        FIXTURES_DIR / "pebble_beach_hole3_geometry.json", hole_number=3, yards=381,
    )
    assert hole.bend is not None and not hole.bend.straight

    rec = generate_recommendation(
        hole=hole, distance_yards=381, club_distances=_OWNER_BAG,
        handicap=3.0, weather=None, shot_bearing=0.0,
    )
    assert rec.club not in _SUB_HYBRID_CLUBS, (
        f"AFTER the fix, Pebble Beach hole 3 must stay uncapped — got {rec.club!r}"
    )


def test_pebble_beach_hole3_before_fix_repro_via_monkeypatch(monkeypatch):
    hole = _hole_intel_from_geometry_fixture(
        FIXTURES_DIR / "pebble_beach_hole3_geometry.json", hole_number=3, yards=381,
    )
    monkeypatch.setattr(aim_point, "CORNER_TREE_FORWARD_YDS", 10_000)
    rec = generate_recommendation(
        hole=hole, distance_yards=381, club_distances=_OWNER_BAG,
        handicap=3.0, weather=None, shot_bearing=0.0,
    )
    assert rec.club in _SUB_HYBRID_CLUBS, (
        f"pre-fix must reproduce the bogus cap on Pebble Beach hole 3 — got {rec.club!r}"
    )


# ── Synthetic unit test on the exact boundary of the new constant ─────────

_BAG: dict[str, int] = {"driver": 280, "3wood": 240, "5wood": 220, "hybrid": 200, "7iron": 160}
_BEND = HoleBend(straight=False, direction="left", distance_yards=226, deviation_yards=88)


def _hole_with_corner_tree(carry_yards: int) -> HoleIntelligence:
    hazard = Hazard(
        type="trees", side="left", line_side="left",
        carry_yards=carry_yards, penalty_severity="moderate",
    )
    return HoleIntelligence(hole_number=3, par=4, yards=400, hazards=[hazard], bend=_BEND)


def test_corner_tree_just_inside_forward_bound_still_caps():
    """A tree at bend.distance_yards + CORNER_TREE_FORWARD_YDS (exactly at
    the new boundary) still qualifies — the fix must not be off-by-one."""
    hole = _hole_with_corner_tree(_BEND.distance_yards + aim_point.CORNER_TREE_FORWARD_YDS)
    rec = generate_recommendation(hole, 400, _BAG, handicap=15)
    assert rec.tee_shot_numbers.club != "driver"
    assert any("runs through the corner" in line for line in rec.reasoning)


def test_corner_tree_just_outside_forward_bound_no_longer_caps():
    """A tree ONE yard past the new boundary must NOT qualify — this is the
    exact case the fix closes (previously unbounded, so this always capped
    before the fix)."""
    hole = _hole_with_corner_tree(_BEND.distance_yards + aim_point.CORNER_TREE_FORWARD_YDS + 1)
    rec = generate_recommendation(hole, 400, _BAG, handicap=15)
    assert rec.tee_shot_numbers.club == "driver"
    assert not any("runs through the corner" in line for line in rec.reasoning)


def test_corner_tree_far_past_forward_bound_pre_fix_would_have_capped(monkeypatch):
    """Direct mechanism proof: the SAME far-downstream tree (300y past a
    226y corner — Pine Valley 9's actual shape) caps pre-fix (unbounded) and
    does not cap post-fix (bounded)."""
    hole = _hole_with_corner_tree(_BEND.distance_yards + 300)

    rec_after = generate_recommendation(hole, 400, _BAG, handicap=15)
    assert rec_after.tee_shot_numbers.club == "driver"

    monkeypatch.setattr(aim_point, "CORNER_TREE_FORWARD_YDS", 10_000)
    rec_before = generate_recommendation(hole, 400, _BAG, handicap=15)
    assert rec_before.tee_shot_numbers.club != "driver"
