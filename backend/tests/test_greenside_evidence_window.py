"""Unit tests for the cycle-5 RC-3 greenside-evidence criterion
(specs/caddie-bench-cycle5-plan.md §3). Pure, no DB/network.

The old `compute_miss_side` window (`distance_from_green <= 20`,
lateral-blind) was a knife edge through the densest cluster in the measured
hazard distribution -- eleven greenside bunkers at 20-26y, admitting 2 and
excluding 9. `_greenside_evidence` replaces it with a two-axis criterion
measured off the ten committed bench fixtures: a widened distance band
(38.5y, this commit's re-derived void -- see `aim_point.py`'s comment)
EARNED by a measured lateral offset (<= 24.0y), so tree lines well off the
line never masquerade as greenside trouble.
"""

from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import pytest  # noqa: E402

from app.caddie import aim_point  # noqa: E402
from app.caddie.aim_point import (  # noqa: E402
    GREENSIDE_EVIDENCE_DISTANCE_YDS,
    GREENSIDE_EVIDENCE_MAX_LATERAL_YDS,
    GREENSIDE_EVIDENCE_NEAR_YDS,
    _greenside_evidence,
    compute_miss_side,
)
from app.caddie.types import Hazard, HoleIntelligence  # noqa: E402
from tests.eval.caddie_bench.geometry import (  # noqa: E402
    hole_intel_from_fixture,
    load_hole_fixture,
)
from tests.eval.caddie_bench.schema import HOLES_DIR  # noqa: E402


def _fixture_intel(name: str) -> HoleIntelligence:
    return hole_intel_from_fixture(load_hole_fixture(HOLES_DIR / name))


def _hazard(distance_from_green: float, lateral_yards: float | None, side: str = "right") -> Hazard:
    return Hazard(
        type="bunker", side=side, distance_from_green=distance_from_green,
        lateral_yards=lateral_yards,
    )


# ── Real-fixture RED->GREEN repros ──────────────────────────────────────────


def test_bethpage_black_h5_moves_from_both_open_to_named_side(monkeypatch):
    """BEFORE (old lateral-blind <=20 cut, simulated by collapsing the
    widened band): the tee-anchored center bunker at 20y doesn't count
    toward either the left or right bucket ("center" isn't in
    side_severity), so both sides are empty and `compute_miss_side` falls
    into the both-open "No strong miss side mapped" branch. AFTER: the 21y/
    17.4-lateral right bunker and 23y/10.3-lateral left bunker are both
    admitted by the widened band, and the side with less severe evidence
    wins a real, named call."""
    intel = _fixture_intel("bethpage_black_h5.json")

    monkeypatch.setattr(aim_point, "GREENSIDE_EVIDENCE_DISTANCE_YDS", aim_point.GREENSIDE_EVIDENCE_NEAR_YDS)
    before = compute_miss_side(intel, None, distance_yards=150)  # offset 328 -> approach-framed
    assert before.description == "No strong miss side mapped — middle of the green, two-putt range"
    assert before.avoid == "No mapped trouble tight to the green"

    monkeypatch.undo()
    after = compute_miss_side(intel, None, distance_yards=150)
    assert after.description != "No strong miss side mapped — middle of the green, two-putt range"
    assert "bunker" in after.description.lower() or "bunker" in after.avoid.lower()


def test_bethpage_red_h16_admits_the_judge_cited_33y_bunker(monkeypatch):
    """The judge repeatedly cited a 33y/19.1-lateral bunker (red_h16,
    right side) as evidence the engine's old "no mapped trouble" claim
    visibly contradicted. Pin that it is now admitted and drives the call."""
    intel = _fixture_intel("bethpage_red_h16.json")

    monkeypatch.setattr(aim_point, "GREENSIDE_EVIDENCE_DISTANCE_YDS", aim_point.GREENSIDE_EVIDENCE_NEAR_YDS)
    before = compute_miss_side(intel, None, distance_yards=150)  # offset 350 -> approach-framed
    assert before.description == "No strong miss side mapped — middle of the green, two-putt range"

    monkeypatch.undo()
    after = compute_miss_side(intel, None, distance_yards=150)
    assert after.description != "No strong miss side mapped — middle of the green, two-putt range"
    # The 33y/19.1 right-side bunker is real evidence against the right side.
    assert "bunker" in (after.description + after.avoid).lower()


# ── Boundary pins on `_greenside_evidence` ──────────────────────────────────


def test_greenside_constants_are_pinned_to_the_measured_voids():
    """Literal pin so a future silent nudge can't slip past (cycle-5 reviewer
    nit 1). The parametrized boundary cases below are expressed RELATIVE to the
    constants, so on their own they would still pass if someone moved 38.5 to
    41.0. These values are not taste -- each sits inside a void MEASURED over
    all 78 hazards in the ten committed fixtures (see `aim_point.py`'s comment):
    the lateral<=24-qualified distance sequence is ..., 33, 35 | void | 42, ...
    so 38.5 is that void's midpoint (margins 3.5/3.5); the jointly-restricted
    lateral void is 22.5 -> 29.9, so 24.0 sits mid-plateau (margins 1.5/5.9).
    Changing either number is a MEASUREMENT decision, not a tuning knob --
    re-derive the table first, then update this pin deliberately. The standing
    scar is `CORNER_MIN_DEVIATION_FRACTION` at 0.30, a threshold picked by feel
    through a populated continuum (see backlog.json).
    """
    assert (
        GREENSIDE_EVIDENCE_NEAR_YDS,
        GREENSIDE_EVIDENCE_DISTANCE_YDS,
        GREENSIDE_EVIDENCE_MAX_LATERAL_YDS,
    ) == (20.0, 38.5, 24.0)


@pytest.mark.parametrize(
    "distance,lateral,expected",
    [
        (GREENSIDE_EVIDENCE_DISTANCE_YDS, GREENSIDE_EVIDENCE_MAX_LATERAL_YDS, True),
        (GREENSIDE_EVIDENCE_DISTANCE_YDS, GREENSIDE_EVIDENCE_MAX_LATERAL_YDS + 0.1, False),
        (GREENSIDE_EVIDENCE_DISTANCE_YDS + 0.5, GREENSIDE_EVIDENCE_MAX_LATERAL_YDS, False),
        (34.0, 33.8, False),  # tree-line shape (pebble_h3) -- lateral axis does the work
        (33.0, 19.1, True),  # the judge-cited red_h16 bunker
        (GREENSIDE_EVIDENCE_NEAR_YDS, None, True),  # near band, lateral-blind
        (30.0, None, False),  # widened band must be EARNED by a measured lateral
    ],
)
def test_greenside_evidence_boundary_pins(distance, lateral, expected):
    h = _hazard(distance, lateral)
    assert _greenside_evidence(h) is expected


# ── Retention pin: the honest-degrade branch survives for the truly-empty case ──


def test_truly_empty_greenside_case_keeps_the_honest_degrade_strings():
    """Hazards all beyond the criterion (both axes) -> the cycle-3
    honest-degrade branch fires verbatim, unchanged by this cycle."""
    hole = HoleIntelligence(
        hole_number=1, par=4, yards=400,
        hazards=[
            _hazard(60.0, 13.7, side="left"),  # beyond GREENSIDE_EVIDENCE_DISTANCE_YDS
            _hazard(90.0, 5.0, side="right"),  # beyond GREENSIDE_EVIDENCE_DISTANCE_YDS
        ],
    )
    miss = compute_miss_side(hole, None, distance_yards=150)  # offset 250 -> approach-framed
    assert miss.description == "No strong miss side mapped — middle of the green, two-putt range"
    assert miss.avoid == "No mapped trouble tight to the green"


# ── Parity pins: lateral_yards=None is byte-identical, tee-framed AND approach-framed ──


def _hand_built_hole_lateral_none() -> HoleIntelligence:
    """One hazard inside the near band (distance 15, lateral-blind, counted
    under BOTH old and new code) and one hazard inside the NEW widened
    distance band but with `lateral_yards=None` (distance 30 -- the old cut
    also excluded it since 30 > 20, and the new code excludes it too since
    unknown lateral never earns the widened band: proves the entire
    hand-built/legacy-cache tee-parity population is untouched)."""
    return HoleIntelligence(
        hole_number=1, par=4, yards=400,
        hazards=[
            Hazard(type="bunker", side="right", distance_from_green=15.0, lateral_yards=None, penalty_severity="severe"),
            Hazard(type="water", side="left", distance_from_green=30.0, lateral_yards=None, penalty_severity="death"),
        ],
    )


def test_hand_built_lateral_none_hole_is_byte_identical_tee_framed():
    hole = _hand_built_hole_lateral_none()
    miss = compute_miss_side(hole, None)  # no distance_yards -> tee-framed
    assert miss.preferred == "left"
    assert miss.description == "Miss left — safe side, easy recovery"
    assert miss.avoid == "Don't miss right — bunker"


def test_hand_built_lateral_none_hole_is_byte_identical_approach_framed():
    hole = _hand_built_hole_lateral_none()
    miss = compute_miss_side(hole, None, distance_yards=150)  # offset 250 -> approach-framed
    assert miss.preferred == "left"
    assert miss.description == "Bunker guards the right — miss left"
    assert miss.avoid == "Don't miss right — bunker"
