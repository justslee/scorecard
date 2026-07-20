"""Offline acceptance suite for the LOCAL-LORE layer, Pinehurst No. 2 hole
1-shaped (specs/caddie-guide-local-lore-plan.md §8D): a tactical guide plus
attributed lore items (high AND sourced-medium confidence) against a hole
with ONE real greenside bunker RIGHT — the whole read/consume path, end to
end, offline.

Includes a fixture drawn from the 2026-07-20 backfill-halt incident: a
sourced-`medium`-confidence false-front item that rule 5 used to throw away
alongside genuinely uncertain lore (see `guide_writer._LORE_CONFIDENCE_KEEP`).

No network, no database.
"""

from __future__ import annotations

import os

import pytest

from app.caddie import strategy as strategy_mod
from app.caddie.guide_writer import validate_lore
from app.caddie.types import Hazard, HoleStrategyGuide, LoreItem

# Pinehurst No. 2 hole 1-shaped geometry: ONE real greenside bunker RIGHT.
_HAZARDS = [Hazard(type="bunker", side="right", line_side="right", carry_yards=390)]

_TACTICAL_GUIDE = HoleStrategyGuide(
    play_line="Favor the left-center of the fairway off the tee.",
    miss_side="Best miss is left, away from the greenside bunker.",
    green_notes="Green sits slightly elevated with a subtle false front.",
)

_TURTLEBACK = LoreItem(
    text="This green is a classic Ross turtleback that sheds anything long.",
    category="green_character",
    source="USGA course notes",
    confidence="high",
)
_OPEN_HISTORY = LoreItem(
    text="The 2024 U.S. Open cut pins on 2-4% slopes, favoring the center below the hole.",
    category="history",
    source="USGA 2024 U.S. Open notes",
    confidence="high",
)
_SHORT_IS_DEAD = LoreItem(
    text="Landing short is dead on this green — anything above the hole runs away.",
    category="green_character",
    source="Golf Digest course guide",
    confidence="high",
)
_BUNKER_LEFT_FLIP = LoreItem(
    text="Stay away from the greenside bunker left of the putting surface.",
    category="feature",
    source="Golf Digest course guide",
    confidence="high",
)
# A real dropped-item shape from the 2026-07-20 halted backfill: a
# false-front claim the writer honestly self-reported as `medium` (single
# course-guide source, not independently verified) rather than inflating it
# to `high`. Sourced -> now survives rule 5.
_SOURCED_MEDIUM_FALSE_FRONT = LoreItem(
    text="Course guides describe a false front here, though accounts differ on how severe it is.",
    category="green_character",
    source="Golf Digest course guide",
    confidence="medium",
)
# A genuinely uncertain claim — sourced, but the writer self-reported `low`.
# Still drops: the fix widens the bar to sourced-medium, not everything.
_LOW_CONFIDENCE = LoreItem(
    text="Some say the green was originally flatter before a 1930s redesign.",
    category="history",
    source="Golf Digest course guide",
    confidence="low",
)
_UNATTRIBUTED = LoreItem(
    text="The green complex has hosted more playoff finishes than any other.",
    category="history",
    source="",
    confidence="high",
)


def test_validate_lore_keeps_all_four_good_items_drops_the_three_bad():
    items = [
        _TURTLEBACK, _OPEN_HISTORY, _SHORT_IS_DEAD, _SOURCED_MEDIUM_FALSE_FRONT,
        _BUNKER_LEFT_FLIP, _LOW_CONFIDENCE, _UNATTRIBUTED,
    ]
    survivors = validate_lore(items, _HAZARDS)

    assert survivors == [_TURTLEBACK, _OPEN_HISTORY, _SHORT_IS_DEAD, _SOURCED_MEDIUM_FALSE_FRONT]


def test_validate_lore_bunker_left_flip_dropped_bunker_is_real_but_right():
    """The real bunker is RIGHT — a lore item claiming it's LEFT is a
    side-flip, dropped by the same `_has_side_flip` machinery as the
    tactical validator."""
    assert validate_lore([_BUNKER_LEFT_FLIP], _HAZARDS) == []


def test_validate_lore_sourced_medium_confidence_survives():
    """2026-07-20 backfill-halt fix: rule 5 no longer discards an honest,
    sourced `medium` self-report — only `high` and sourced `medium` survive."""
    assert validate_lore([_SOURCED_MEDIUM_FALSE_FRONT], _HAZARDS) == [_SOURCED_MEDIUM_FALSE_FRONT]


def test_validate_lore_low_confidence_dropped_even_when_sourced():
    """The fix widens the bar to sourced-medium, not everything — a sourced
    but genuinely uncertain (`low`) item still drops."""
    assert validate_lore([_LOW_CONFIDENCE], _HAZARDS) == []


def test_validate_lore_unattributed_dropped():
    assert validate_lore([_UNATTRIBUTED], _HAZARDS) == []


# ── Ground truth contains the attributed label + the three survivors ───────


def test_ground_truth_contains_labeled_lore_with_false_front_turtleback_below_hole():
    guide = _TACTICAL_GUIDE.model_copy(
        update={"local_lore": [_TURTLEBACK, _OPEN_HISTORY, _SHORT_IS_DEAD]}
    )
    payload = {
        "recommendation": {
            "club": "driver", "target_yards": 400, "raw_yards": 400,
            "aim_point": {"description": "left-center"},
            "miss_side": {"preferred": "left"},
        },
        "conditions": {"hazards_line": "bunker R 390y"},
        "carries": {}, "bend": {}, "green_read": {},
        "player": {"handicap": None, "club_distances": {}},
        "local_knowledge": "Local knowledge: " + _TACTICAL_GUIDE.play_line,
        "local_lore": [item.model_dump() for item in guide.local_lore],
    }
    block = strategy_mod.format_strategy_ground_truth(payload)

    assert "RESEARCHED LOCAL KNOWLEDGE (attributed, non-geometric" in block
    assert "turtleback" in block
    assert "runs away" in block  # false-front / above-the-hole phrasing survives
    assert "2-4% slopes" in block
    assert "(per USGA course notes)" in block
    assert "(per USGA 2024 U.S. Open notes)" in block
    assert "(per Golf Digest course guide)" in block

    # No engine number smuggled in via lore: within the RESEARCHED LOCAL
    # KNOWLEDGE section itself, "390" (the real bunker carry, which DOES
    # appear elsewhere in the block via the hazards line) never appears —
    # every lore item stayed number-free per the hard safety rule.
    lore_section = block[block.index("RESEARCHED LOCAL KNOWLEDGE"):]
    assert "390" not in lore_section


# ── Synthesized reply weaving lore + engine numbers: validator behavior ────


def test_synth_reply_weaving_lore_and_engine_numbers_passes_validator():
    """A reply that weaves the turtleback/history lore in as attributed
    color while keeping every number bound to the real engine hazard (the
    390y right bunker) passes the SAME fail-closed validator every strategy
    reply goes through."""
    reply = (
        "Take driver and favor the left-center; the bunker sits right at 390, so "
        "give it a wide look. The book says this green is a classic turtleback that "
        "sheds anything long, so landing short of the flag beats going long."
    )
    hazards_dicts = [{"type": "bunker", "line_side": "right", "carry_yards": 390}]
    result = strategy_mod.validate_strategy_text(reply, hazards_dicts)
    assert result is not None


def test_synth_reply_converting_lore_into_ungrounded_hazard_bound_number_rejected():
    """A reply that takes the (numberless) lore color and fabricates a
    hazard-bound yardage claim the engine never grounded — the exact
    smuggling shape the hard safety rule exists to prevent downstream of the
    writer — still gets caught by `validate_strategy_text`'s existing
    side/carry-aware hazard check."""
    reply = (
        "Take driver and favor the left-center; the bunker sits right at 240, so "
        "give it a wide look. Landing short is dead on this green."
    )
    hazards_dicts = [{"type": "bunker", "line_side": "right", "carry_yards": 390}]
    result = strategy_mod.validate_strategy_text(reply, hazards_dicts)
    assert result is None


# ── Live tail: real research shape smoke (skipped without a live key) ──────


@pytest.mark.asyncio
@pytest.mark.skipif(not os.getenv("ANTHROPIC_API_KEY"), reason="requires a live ANTHROPIC_API_KEY")
async def test_live_research_hole_lore_shape_smoke():
    from app.caddie.guide_writer import research_hole_lore

    result = await research_hole_lore(
        "Pinehurst No. 2", 1, 4, 400, None, None, list(_HAZARDS),
    )
    assert result.model
    assert result.generated_at
    survivors = validate_lore(result.items, _HAZARDS)
    # No assertion on survivor COUNT (live research is non-deterministic) —
    # this is a shape smoke test only: the call completes, stamps
    # provenance, and every survivor still passes the deterministic gate.
    for item in survivors:
        assert item.confidence in ("high", "medium")
        assert item.source
