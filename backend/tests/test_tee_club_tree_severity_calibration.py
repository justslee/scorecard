"""Calibration tests for backlog `caddie-tee-club-tree-severity-calibration`
(fable-review non-blocker follow-up to `caddie-tee-club-expected-strokes`).

Observation this pins the fix for: even after the handicap-scaled
`_PENALTY_COST` (reviewer B2), a 30-handicap player on a genuinely tight
(~20y) tree chute was STILL recommended driver — the Gaussian model put
~72% of their drives in the trees, and the E-math still preferred it because
this bag's next-shortest club barely drops that probability while costing a
lot of approach distance. Verified numerically (see `_TROUBLE_CEILING_BY_HANDICAP`'s
own note in `aim_point.py`) that a flat/handicap-scaled cost bump alone can't
flip this without an unrealistic (>10x) severity constant — the fix is an
absolute trouble-probability ceiling that tightens with handicap, a NO-OP at
or below handicap 15 so every already-shipped hcp-15 fixture stays untouched.

Matrix: hcp 0/15/30 x chute-20y/corridor-40y/open-80y, on the EXACT bag/hole
shape from the P0 plan's own fixtures (specs/caddie-tee-club-expected-
strokes-plan.md — `driver 280/3wood 240/5wood 220/hybrid 200/7iron 160`,
467y par-4) so this pins the real reported scenario, not a synthetic stand-in.

Pure, no DB/network — mirrors `test_tee_club_expected_strokes.py`'s fixture
style directly.
"""

from __future__ import annotations

import pytest

from app.caddie import physics
from app.caddie.aim_point import (
    _select_club_expected_strokes,
    _trouble_ceiling,
    generate_recommendation,
)
from app.caddie.types import CorridorSample, HoleIntelligence


def _physics_total(club: str, dist: int) -> int:
    cond, _ = physics.conditions_from_weather(None, 0.0, elevation_delta_ft=0.0, carry_hint_yards=float(dist))
    return round(physics.shot_distance_for_club(club, float(dist), cond).total_yards)

_BAG: dict[str, int] = {"driver": 280, "3wood": 240, "5wood": 220, "hybrid": 200, "7iron": 160}
_HOLE_YARDS = 467


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


def _hole(width: int) -> HoleIntelligence:
    return HoleIntelligence(
        hole_number=3, par=4, yards=_HOLE_YARDS, hazards=[], corridor=_uniform_corridor(width),
    )


# ── 1. Scratch (hcp 0) keeps driver everywhere the math favors it ──────────


@pytest.mark.parametrize("width", [20, 40, 80])
def test_scratch_keeps_driver_on_every_width(width: int):
    rec = generate_recommendation(_hole(width), _HOLE_YARDS, _BAG, handicap=0)
    n = rec.tee_shot_numbers
    assert n is not None
    assert n.club == "driver"
    assert n.corridor_alt_club is None  # no swap — nothing beat it


# ── 2. hcp 15 (the shipped baseline) is UNCHANGED by this calibration ──────
#
# hcp 15 was never the reported problem and every existing suite pins its
# behavior at hcp 15 — this just extends coverage to width=20, a corridor
# not previously exercised, confirming the ceiling (a no-op at/below 15)
# doesn't touch it either.


@pytest.mark.parametrize("width", [20, 40, 80])
def test_hcp15_baseline_keeps_driver_unaffected_by_the_ceiling(width: int):
    rec = generate_recommendation(_hole(width), _HOLE_YARDS, _BAG, handicap=15)
    n = rec.tee_shot_numbers
    assert n is not None
    assert n.club == "driver"
    assert n.corridor_alt_club is None


# ── 3. hcp 30: the reported over-aggression case — chute-20y lays back,
#      wider corridors and open holes stay driver (no over-caution) ────────


def test_hcp30_chute20_lays_back_off_driver():
    rec = generate_recommendation(_hole(20), _HOLE_YARDS, _BAG, handicap=30)
    n = rec.tee_shot_numbers
    assert n is not None
    assert n.club != "driver"  # the reported bug: driver at ~72% tree risk
    assert n.corridor_alt_club == "driver"  # driver was considered and lost
    assert n.corridor_alt_trouble_pct is not None
    assert n.corridor_alt_trouble_pct >= 65  # driver's own risk here is genuinely high
    # The chosen (laid-back) club must itself be meaningfully safer, not a
    # rounding-noise swap.
    assert n.corridor_trouble_pct is not None
    assert n.corridor_trouble_pct < n.corridor_alt_trouble_pct

    note = next((line for line in rec.reasoning if "lays back" in line), None)
    assert note is not None
    assert "Driver" in note
    assert "tree" in note


def test_hcp30_corridor40_stays_driver_not_over_cautious():
    rec = generate_recommendation(_hole(40), _HOLE_YARDS, _BAG, handicap=30)
    n = rec.tee_shot_numbers
    assert n is not None
    assert n.club == "driver"  # 40y+ survives even at hcp 30 — not over-corrected
    assert n.corridor_alt_club is None


def test_hcp30_open80_stays_driver():
    rec = generate_recommendation(_hole(80), _HOLE_YARDS, _BAG, handicap=30)
    n = rec.tee_shot_numbers
    assert n is not None
    assert n.club == "driver"
    assert n.corridor_alt_club is None


# ── 4. The laid-back pick still respects the existing floor/guardrail ──────


def test_hcp30_chute20_layback_respects_the_100y_floor():
    fit = _select_club_expected_strokes(
        _BAG, _uniform_corridor(20), _HOLE_YARDS, 30, None, 0.0, 0.0, False, ceiling_total_yards=999,
    )
    assert fit is not None
    driver_total = _physics_total("driver", _BAG["driver"])
    assert fit.total >= driver_total - 100


# ── 5. `_trouble_ceiling` itself: no-op at/below 15, tightens above it ─────


def test_trouble_ceiling_no_op_at_or_below_15():
    assert _trouble_ceiling(0) == pytest.approx(1.00)
    assert _trouble_ceiling(15) == pytest.approx(0.95)
    # 0.95 exceeds even the pathological blanket-narrow-corridor P (0.9151)
    # pinned by test_corridor_width_selection.py::test_04 at hcp 15.
    assert _trouble_ceiling(15) > 0.9151


def test_trouble_ceiling_strictly_tightens_above_15():
    values = [_trouble_ceiling(h) for h in (15, 20, 25, 30, 36)]
    assert values == sorted(values, reverse=True)
    assert values[-1] < values[0]


def test_trouble_ceiling_clamped_outside_0_36():
    assert _trouble_ceiling(-5) == _trouble_ceiling(0)
    assert _trouble_ceiling(50) == _trouble_ceiling(36)
