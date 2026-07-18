"""Unit tests for corridor-aware tee-club selection
(specs/corridor-width-club-selection-plan.md §4.4/§6, §9-B —
specs/caddie-tee-club-expected-strokes-plan.md P0 follow-up).

DELIBERATE REWRITE (2026-07-18): `_select_club_fitting_corridor`, the hard
±1.5σ fit-window wall this file used to pin, is RETIRED — it was diagnosed
as the owner's "extremely conservative, 7-iron instead of driver" field
report's exact mechanism (a wide dispersion cone rejected driver outright on
an ordinary tree-lined corridor, with no expected-strokes tradeoff). It is
replaced by `_select_club_expected_strokes`
(specs/caddie-tee-club-expected-strokes-plan.md), which picks the
strict-min-expected-strokes club instead of the longest club that "fits" a
hard window. Per that plan's §6 gate:
  - Tests 3, 5, 6, 7 below pin CONTRACTS the new model still honors
    unchanged (unknown-never-rejects, corridor=None byte-identity, the
    reachable branch is untouched, and the coherence guard against a
    rounding-tie club swap) — carried over, only the call-site/type names
    updated for the new function.
  - Tests 1, 2, 4 are RE-PINNED to the new model's own (verified) outcomes,
    each with a comment explaining WHY the expected value changed — never a
    silently loosened assertion.

Pure, no DB/network — mirrors `test_corridor_bend_cap.py`'s fixture style
directly (same `_BAG`/`_BEND`/hazards-both-sides shapes for the regression
guard in test 5).
"""

from __future__ import annotations

import re

from app.caddie import aim_point
from app.caddie.aim_point import ExpectedStrokesFit, generate_recommendation
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


# ── 1. Straight WIDE hole: driver wins outright — RE-PINNED ─────────────────
#
# OLD (hard-wall) assertion: driver's ±1.5σ window (56.25y) fits inside an
# 80y-wide corridor, so it "fits" and is accepted — same conclusion, but for
# the wrong reason (a binary fit test, not a tradeoff). NEW (E-model)
# assertion: driver wins because at width=80 the per-side tree probability
# is tiny (~1.5% each) — nowhere near enough to buy a shorter club anything
# (verified against a real run of this exact fixture). The conclusion is the
# same; what's now PINNED is that it's actually genuinely optimal, not just
# "not rejected."


def test_01_straight_wide_hole_driver_wins_on_expected_strokes():
    corridor = _uniform_corridor(80)  # driver's tree risk here is negligible
    hole = _hole(corridor=corridor)
    rec = generate_recommendation(hole, 400, _BAG, handicap=15)

    n = rec.tee_shot_numbers
    assert n is not None
    assert n.club == "driver"
    assert n.corridor_trouble_pct is not None
    assert n.corridor_trouble_pct <= 5  # negligible risk at this width
    assert n.corridor_alt_club is None  # nothing shorter was even competitive
    # Numbers still close exactly.
    assert n.to_green_yards - n.drive_total_yards == n.leave_exact_yards


# ── 2. Pinching hole (Red-3-like): bend-cap composes, E-model does NOT
#      cut further — RE-PINNED ────────────────────────────────────────────
#
# OLD (hard-wall) assertion: after the bend-cap forces the ceiling to <=221,
# a further NARROW pinch at hybrid's own landing (~217, width 30) exceeded
# hybrid's hard ±1.5σ window (45y) and was hard-rejected, cascading down to
# 7-iron. NEW (E-model) assertion: hybrid's own tree risk at that same pinch
# is real but nowhere near enough (per the plan §3.5 guardrail — trees alone
# can't buy more than ~1 club of layback) to beat hybrid's own expected
# strokes with a further layback into an even shorter, still-leaves-more
# club. Both caps still compose (the bend-cap's ceiling is still respected);
# the width evidence now GROUNDS the kept club's own risk number instead of
# cutting it further (verified against a real run of this exact fixture).


def test_02_pinching_hole_bend_cap_composes_width_grounds_not_cuts():
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
    # The bend cap is still respected — the E-model can only cut FURTHER
    # (take-the-shorter composition), never relax it.
    assert n.drive_total_yards <= 221
    assert n.club == "hybrid"
    assert n.to_green_yards - n.drive_total_yards == n.leave_exact_yards

    # No genuine width-driven swap happened this time — the v1 bend-cap's
    # OWN note (naming the corner) survives untouched, exactly as it did
    # before hole.corridor existed at all.
    assert any("runs through the corner" in line for line in rec.reasoning)
    assert not any("lays back" in line for line in rec.reasoning)


# ── 3. Unknown width never rejects — driver stays (CARRIED OVER) ────────────


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
    assert n.corridor_trouble_pct is None  # unknown at driver's own landing -> no penalty, no claim


# ── 4. Blanket-narrow corridor: driver STILL wins on expected strokes —
#      RE-PINNED ───────────────────────────────────────────────────────────
#
# OLD (hard-wall) assertion: a uniform 5y-wide corridor blanketing every
# candidate's landing distance meant NOTHING "fit" (every window > 5y), so
# the walk returned `None` and the caller kept today's (pre-corridor) club —
# a "no club helps, don't fabricate a cap" fallback, with no note. NEW
# (E-model) assertion: there is no such fallback — the model ALWAYS produces
# a genuine strict-min-E answer, and here driver wins for real: the
# guardrail (plan §3.5 — trees alone can't buy a meaningful layback) holds
# even at this pathologically narrow width, so driver's own high tree-risk
# number now SURFACES in the payload/note instead of the walk silently
# giving up (verified against a real run of this exact fixture: driver's own
# combined trouble is genuinely high here, and the note says so honestly —
# this is the caddie narrating real risk with real numbers, not hedging).


def test_04_blanket_narrow_corridor_driver_still_wins_note_states_the_risk():
    corridor = _uniform_corridor(5)
    hole = _hole(corridor=corridor)
    rec = generate_recommendation(hole, 400, _BAG, handicap=15)

    n = rec.tee_shot_numbers
    assert n is not None
    assert n.club == "driver"  # unchanged — but now for a GROUNDED reason
    assert n.corridor_alt_club is None  # no shorter club actually beat it
    assert n.corridor_trouble_pct is not None
    assert n.corridor_trouble_pct > 50  # a pathologically narrow corridor IS genuinely risky
    note = next((line for line in rec.reasoning if "beats that trade" in line), None)
    assert note is not None
    assert f"{n.corridor_trouble_pct}%" in note


# ── 5. Regression guard: corridor=None -> byte-identical v1 (CARRIED OVER,
#      new corridor_* fields added to the None-check) ──────────────────────


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

    # Every retired pinch-shaped field stays None — the block never ran.
    assert n.corridor_pinch_width_yards is None
    assert n.corridor_pinch_distance_yards is None
    assert n.corridor_capped_from_club is None
    assert n.corridor_capped_from_window_yards is None
    assert n.corridor_club_window_yards is None
    assert n.corridor_width_yards is None
    # Every NEW expected-strokes field also stays None.
    assert n.corridor_trouble_pct is None
    assert n.corridor_alt_club is None
    assert n.corridor_alt_trouble_pct is None
    assert n.corridor_alt_leave_yards is None
    assert n.corridor_alt_total_yards is None


# ── 6. Reachable-branch guard: corridor present but shot is reachable
#      (CARRIED OVER) ───────────────────────────────────────────────────────


def test_06_reachable_branch_untouched_by_corridor():
    corridor = _uniform_corridor(5)  # would drive risk sky-high on the positioning path
    hole = _hole(corridor=corridor, yards=150)
    rec = generate_recommendation(hole, 150, _BAG, handicap=15)

    assert rec.shot_kind == "approach"
    assert rec.tee_shot_numbers is None
    assert rec.leave_yards is None


# ── 7. Coherence-contract guard: a rounding-tie fit (`alt_club is None`)
#      must NOT swap the club or leave a stale corridor_note (CARRIED OVER,
#      updated to the new function/type names) ─────────────────────────────
#
# `_select_club_expected_strokes`'s ceiling-skip (aim_point.py, the `total >
# ceiling_total_yards: continue` branch) can make the walk's own "longest
# ceiling-surviving candidate" land on a DIFFERENT club than the pre-existing
# (bend-cap-chosen) `club` on a sub-yard physics rounding boundary alone —
# the exact failure mode `_select_club_fitting_corridor`'s original test_07
# pinned, still possible in the new selector's walk order. That's not a
# genuine trade-off decision (`fit.alt_club is None` — nothing was actually
# out-traded), so the caller must keep the current (post-bend-cap) club
# untouched — swapping here with no real reason would leave a stale v1
# bend-cap `corridor_note` naming the OLD club/leave while the club silently
# changed. Reproducing the exact physics tie isn't reliable (fable review,
# original test: "could not construct one from a realistic bag"), so this
# pins the guard directly at the integration seam via a monkeypatched
# `_select_club_expected_strokes` return — the cleanest deterministic seam.
def test_07_rounding_tie_fit_does_not_swap_club_or_stale_the_note(monkeypatch):
    # Bend + hazards -> v1 bend-cap fires first and sets its own corridor_note
    # naming the bend-capped club (same fixture shape as test_05).
    hole = _hole(bend=_BEND, hazards=_hazards_both_sides(), corridor=_uniform_corridor(80))

    # Fabricate an `ExpectedStrokesFit` that looks exactly like the
    # rounding-tie bug: a DIFFERENT (shorter) club than whatever the
    # bend-cap already chose, but `alt_club is None` -> the walk never
    # actually out-traded anything, it just ceiling-skipped past the real
    # club and happened to land here as the (spurious) "longest survivor".
    fake_fit = ExpectedStrokesFit(
        club="7iron", dist=160, total=165,
        sample=CorridorSample(
            distance_yards=160, left_yards=25, right_yards=25, width_yards=50,
            left_source="trees", right_source="trees",
        ),
        p_left=0.05, p_right=0.05, e_total=4.5, leave=235,
        alt_club=None, alt_total=None, alt_sample=None,
        alt_p_left=None, alt_p_right=None, alt_e_total=None, alt_leave=None,
    )
    monkeypatch.setattr(
        aim_point, "_select_club_expected_strokes", lambda *args, **kwargs: fake_fit
    )

    rec = generate_recommendation(hole, 400, _BAG, handicap=15)
    n = rec.tee_shot_numbers
    assert n is not None

    # The bend-cap's own club choice survives untouched — the rounding-tie
    # fit (club="7iron") must NOT have been applied.
    assert n.club != "7iron"
    assert n.club == "hybrid"  # same bend-capped club as test_05's fixture

    # No expected-strokes swap note was emitted (nothing was genuinely traded).
    assert not any("lays back" in line for line in rec.reasoning)
    # The grounding-only path is also guarded: `fit.sample`/`fit.club`
    # belong to the un-applied "7iron", not the kept club, so they must not
    # leak in.
    assert n.corridor_trouble_pct is None
    assert n.corridor_alt_club is None

    # Any corridor_note that IS present (the v1 bend-cap note) must name the
    # club actually recommended, never the un-applied rounding-tie candidate
    # — this is the exact "stale note" failure mode the guard prevents.
    corridor_note = next(
        (line for line in rec.reasoning if "runs through the corner" in line), None,
    )
    assert corridor_note is not None
    assert "Hybrid" in corridor_note
    assert "7 Iron" not in corridor_note


# The positive path — a genuine trade-off swap (`alt_club` set) still swaps
# the club and emits the tradeoff note — is covered by
# `tests/test_tee_club_expected_strokes.py`'s water-pinch test; not
# duplicated here.


def test_08_swap_note_numbers_are_payload_only():
    """Sibling of the old test 2's payload-grounding assertion, re-targeted
    at a corridor that DOES produce a genuine E-model swap (unlike the
    bend-cap-only pinch above, which no longer cuts further)."""
    corridor = [
        CorridorSample(distance_yards=d, left_yards=10, right_yards=10, width_yards=20,
                        left_source="water", right_source="water")
        for d in range(200, 361, 10)
    ] + [
        CorridorSample(distance_yards=d, left_yards=35, right_yards=35, width_yards=70,
                        left_source="trees", right_source="trees")
        for d in range(60, 200, 10)
    ]
    bag = {"driver": 280, "3wood": 240, "5wood": 220, "hybrid": 200, "5iron": 180, "6iron": 165, "7iron": 150}
    hole = _hole(corridor=corridor, yards=440)
    rec = generate_recommendation(hole, 440, bag, handicap=15)

    n = rec.tee_shot_numbers
    assert n is not None
    assert n.club != "driver"
    assert n.corridor_alt_club == "driver"

    corridor_note = next((line for line in rec.reasoning if "lays back" in line), None)
    assert corridor_note is not None

    payload_ints = {
        int(v) for v in (
            n.hole_number, n.to_green_yards, n.plays_like_yards, n.club_stored_yards,
            n.drive_carry_yards, n.drive_total_yards, n.leave_exact_yards, n.leave_yards,
            n.leave_plays_like_yards, n.corridor_trouble_pct, n.corridor_alt_trouble_pct,
            n.corridor_alt_leave_yards, n.corridor_alt_total_yards,
        )
        if v is not None
    }
    note_ints = {int(tok) for tok in re.findall(r"\d{2,}", corridor_note)}
    assert note_ints <= payload_ints, f"{note_ints - payload_ints} not in payload"
