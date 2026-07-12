"""Unit tests for corridor-width-aware club selection
(specs/corridor-width-club-selection-plan.md §4.4/§6, §9-B).

Pure, no DB/network — mirrors `test_corridor_bend_cap.py`'s fixture style
directly (same `_BAG`/`_BEND`/hazards-both-sides shapes for the regression
guard in test 5).
"""

from __future__ import annotations

import re

from app.caddie import aim_point
from app.caddie.aim_point import CorridorFit, generate_recommendation
from app.caddie.types import CorridorSample, Hazard, HoleBend, HoleIntelligence

_BAG: dict[str, int] = {"driver": 280, "3wood": 240, "5wood": 220, "hybrid": 200, "7iron": 160}
_BEND = HoleBend(straight=False, direction="left", distance_yards=226, deviation_yards=88)


def _hazards_both_sides(carry: int = 230) -> list[Hazard]:
    return [
        Hazard(type="trees", side="left", line_side="left", carry_yards=carry, penalty_severity="moderate"),
        Hazard(type="trees", side="right", line_side="right", carry_yards=carry, penalty_severity="moderate"),
    ]


def _hole(bend=None, hazards=None, corridor=None, yards: int = 400) -> HoleIntelligence:
    return HoleIntelligence(
        hole_number=3, par=4, yards=yards, hazards=hazards or [], bend=bend, corridor=corridor,
    )


def _uniform_corridor(width: int, lo: int = 60, hi: int = 360, step: int = 10) -> list[CorridorSample]:
    half = width / 2.0
    return [
        CorridorSample(
            distance_yards=d,
            left_yards=round(half), right_yards=round(half), width_yards=width,
            left_source="trees", right_source="trees",
        )
        for d in range(lo, hi + 1, step)
    ]


# ── 1. Straight WIDE hole: driver's window fits -> driver stays ─────────────


def test_01_straight_wide_hole_driver_fits():
    corridor = _uniform_corridor(80)  # driver window 56.25 <= 80 across the whole range
    hole = _hole(corridor=corridor)
    rec = generate_recommendation(hole, 400, _BAG, handicap=15)

    n = rec.tee_shot_numbers
    assert n is not None
    assert n.club == "driver"
    assert n.corridor_width_yards == 80
    assert n.corridor_club_window_yards == 56
    # Numbers still close exactly.
    assert n.to_green_yards - n.drive_total_yards == n.leave_exact_yards


# ── 2. Pinching hole (Red-3-like): both caps compose, take-the-shorter ──────
#
# NOTE (plan deviation, minimal + faithful): the plan's literal §9-B-2 numbers
# ("~30y at 270+ and ~55y at <=220") can't actually exercise the WIDTH
# mechanism against v1's own `_BAG`/`_BEND` — the bend-cap's ceiling (221)
# structurally excludes every candidate whose OWN total lands past the
# corner, so the "270+" pinch is never consulted by the walk, and "~55y at
# <=220" is wide enough that the bend-capped club (hybrid, landing ~217)
# fits immediately without a further cut — leaving v1's OWN note active
# (whose numbers include `bend.distance_yards`, not a TeeShotNumbers field,
# which would make the numbers-only-from-payload assertion this test exists
# to pin false by construction). To exercise the real regression this test
# guards (both caps compose; the WIDTH note's numbers are 1:1 with the
# payload), the profile below pinches TIGHT right at the bend-capped club's
# own landing distance (~217) and stays wide at a shorter club's landing
# (~165) — forcing width to shorten hybrid -> 7iron, same "take-the-shorter"
# composition, same both-caps-respected invariant.
def test_02_pinching_hole_both_caps_compose_and_note_numbers_are_payload_only():
    hole = _hole(bend=_BEND, hazards=_hazards_both_sides(), corridor=[
        CorridorSample(
            distance_yards=220, left_yards=15, right_yards=15, width_yards=30,
            left_source="trees", right_source="trees",
        ),
        CorridorSample(
            distance_yards=160, left_yards=25, right_yards=25, width_yards=50,
            left_source="trees", right_source="trees",
        ),
    ])
    rec = generate_recommendation(hole, 400, _BAG, handicap=15)

    n = rec.tee_shot_numbers
    assert n is not None
    # Both caps respected: the bend cap alone already forces <=221; width
    # shortens further, to 7iron.
    assert n.drive_total_yards <= 221
    assert n.club == "7iron"
    assert n.to_green_yards - n.drive_total_yards == n.leave_exact_yards

    corridor_note = next(
        (line for line in rec.reasoning if "pinches the corridor" in line), None,
    )
    assert corridor_note is not None

    payload_ints = {
        int(v) for v in (
            n.hole_number, n.to_green_yards, n.plays_like_yards, n.club_stored_yards,
            n.drive_carry_yards, n.drive_total_yards, n.leave_exact_yards, n.leave_yards,
            n.leave_plays_like_yards, n.corridor_pinch_width_yards,
            n.corridor_pinch_distance_yards, n.corridor_capped_from_window_yards,
            n.corridor_club_window_yards, n.corridor_width_yards,
        )
        if v is not None
    }
    # Only 2+ digit tokens are yardages — a single digit is a club-name token
    # ("7 Iron"), not a claimed number (every real yardage in this fixture is
    # >= 10).
    note_ints = {int(tok) for tok in re.findall(r"\d{2,}", corridor_note)}
    assert note_ints <= payload_ints, f"{note_ints - payload_ints} not in payload"


# ── 3. Unknown width never rejects — driver stays ────────────────────────────


def test_03_unknown_width_at_drivers_landing_never_rejects():
    # No sample anywhere near driver's landing (~283); narrow evidence only
    # at much shorter distances the walk never reaches (driver is accepted
    # first, on unknown width).
    corridor = [
        CorridorSample(distance_yards=150, left_yards=5, right_yards=5, width_yards=10,
                        left_source="trees", right_source="trees"),
        CorridorSample(distance_yards=160, left_yards=5, right_yards=5, width_yards=10,
                        left_source="trees", right_source="trees"),
    ]
    hole = _hole(corridor=corridor)
    rec = generate_recommendation(hole, 400, _BAG, handicap=15)

    n = rec.tee_shot_numbers
    assert n is not None
    assert n.club == "driver"
    assert n.corridor_width_yards is None  # unknown at driver's own landing


# ── 4. No club fits anywhere -> club unchanged, no fabricated cap ───────────


def test_04_no_club_fits_keeps_current_club_no_note():
    # Narrow (5y) width blanketing the whole range every candidate could land
    # in — nothing fits, so the walk returns None and the caller keeps
    # today's club.
    corridor = _uniform_corridor(5)
    hole = _hole(corridor=corridor)
    rec = generate_recommendation(hole, 400, _BAG, handicap=15)

    n = rec.tee_shot_numbers
    assert n is not None
    assert n.club == "driver"  # unchanged — no bend cap, no width cap fired
    assert n.corridor_pinch_width_yards is None
    assert n.corridor_width_yards is None
    assert not any("pinches the corridor" in line for line in rec.reasoning)


# ── 5. Regression guard: corridor=None -> byte-identical v1 ─────────────────


def test_05_corridor_none_is_byte_identical_to_v1():
    hole = _hole(bend=_BEND, hazards=_hazards_both_sides(), corridor=None)
    rec = generate_recommendation(hole, 400, _BAG, handicap=15)

    n = rec.tee_shot_numbers
    assert n is not None
    assert n.club != "driver"
    assert n.drive_total_yards <= 221  # bend.distance_yards(226) - 5

    joined = " ".join(rec.reasoning).lower()
    assert "corner" in joined
    assert "trees" in joined
    assert n.to_green_yards - n.drive_total_yards == n.leave_exact_yards
    assert rec.leave_yards == n.leave_yards

    # Every new corridor_* field stays None — the block never ran.
    assert n.corridor_pinch_width_yards is None
    assert n.corridor_pinch_distance_yards is None
    assert n.corridor_capped_from_club is None
    assert n.corridor_capped_from_window_yards is None
    assert n.corridor_club_window_yards is None
    assert n.corridor_width_yards is None


# ── 6. Reachable-branch guard: corridor present but shot is reachable ───────


def test_06_reachable_branch_untouched_by_corridor():
    corridor = _uniform_corridor(5)  # would reject everything on the positioning path
    hole = _hole(corridor=corridor, yards=150)
    rec = generate_recommendation(hole, 150, _BAG, handicap=15)

    assert rec.shot_kind == "approach"
    assert rec.tee_shot_numbers is None
    assert rec.leave_yards is None


# ── 7. Coherence-contract guard: a rounding-tie fit (rejected_club is None)
#      must NOT swap the club or leave a stale corridor_note ─────────────────
#
# `_select_club_fitting_corridor`'s ceiling-skip (aim_point.py, the `total >
# ceiling_total_yards: continue` branch) never records a rejection — so a
# sub-yard rounding tie on the current club's own recomputed total can make
# the walk skip past it and land on a SHORTER club with `rejected_club is
# None`. That's not a genuine width decision (nothing was actually
# width-rejected), so the caller must keep the current (post-bend-cap) club
# untouched — swapping here with no width reason would leave a stale v1
# bend-cap `corridor_note` naming the OLD club/leave while the club silently
# changed underneath it. Reproducing the exact physics tie isn't reliable
# (fable review: could not construct one from a realistic bag), so this pins
# the guard directly at the integration seam via a monkeypatched
# `_select_club_fitting_corridor` return — the cleanest deterministic seam.
def test_07_rounding_tie_fit_does_not_swap_club_or_stale_the_note(monkeypatch):
    # Bend + hazards -> v1 bend-cap fires first and sets its own corridor_note
    # naming the bend-capped club (same fixture shape as test_05).
    hole = _hole(bend=_BEND, hazards=_hazards_both_sides(), corridor=_uniform_corridor(80))

    # Fabricate a `CorridorFit` that looks exactly like the rounding-tie bug:
    # a DIFFERENT (shorter) club than whatever the bend-cap already chose,
    # but `rejected_club is None` -> the walk never actually rejected
    # anything on width, it just ceiling-skipped past the real club.
    fake_fit = CorridorFit(
        club="7iron",
        dist=160,
        chosen_sample=CorridorSample(
            distance_yards=160, left_yards=25, right_yards=25, width_yards=50,
            left_source="trees", right_source="trees",
        ),
        rejected_club=None,
        rejected_total=None,
        rejected_sample=None,
    )
    monkeypatch.setattr(
        aim_point, "_select_club_fitting_corridor", lambda *args, **kwargs: fake_fit
    )

    rec = generate_recommendation(hole, 400, _BAG, handicap=15)
    n = rec.tee_shot_numbers
    assert n is not None

    # The bend-cap's own club choice survives untouched — the rounding-tie
    # fit (club="7iron") must NOT have been applied.
    assert n.club != "7iron"
    assert n.club == "hybrid"  # same bend-capped club as test_05's fixture

    # No width corridor_note was emitted (nothing was width-rejected).
    assert not any("pinches the corridor" in line for line in rec.reasoning)
    # The grounding-only path is also guarded: `fit.chosen_sample` belongs to
    # the un-applied "7iron", not the kept club, so it must not leak in.
    assert n.corridor_width_yards is None

    # Any corridor_note that IS present (the v1 bend-cap note) must name the
    # club actually recommended, never the un-applied rounding-tie candidate
    # — this is the exact "stale note" failure mode the guard prevents.
    corridor_note = next(
        (line for line in rec.reasoning if "runs through the corner" in line), None,
    )
    assert corridor_note is not None
    assert "Hybrid" in corridor_note
    assert "7 Iron" not in corridor_note


# The positive path — a genuine width rejection (`rejected_club` set) still
# swaps the club and emits the width note — is already covered by
# `test_02_pinching_hole_both_caps_compose_and_note_numbers_are_payload_only`
# above; not duplicated here.
