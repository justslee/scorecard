"""Unit tests for `INPUT_GROUNDING_RULE` (app/caddie/voice_prompts.py) —
caddie-input-grounding-plan.

Owner incident (2026-07-09, "Scars." transcript): on-course ASR garbled the
player's words into invented gibberish ("Scars.", "of God") and the caddie
confidently answered them as if they were real golf questions. The grounding
doctrine already covered FACTS (`HAZARD_/BEND_/PHYSICS_/GREEN_GROUNDING_RULE`,
`OBSERVED_REALITY_RULE`); this rule extends it to INPUT: never answer what you
didn't clearly hear. Shared by BOTH mouths (the realtime prompt here, and the
text mouth's `stable_text` in `app/routes/caddie.py`) so wording never drifts
between them.

No network, no real database — `app.caddie.voice_prompts` transitively
imports `app.db.models` -> `app.db.engine`, which raises at import time when
DATABASE_URL isn't configured, so we stub it first (same pattern as
`tests/test_epistemic_humility_prompt.py`).
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")

from app.caddie.types import CaddiePersonality  # noqa: E402
from app.caddie.voice_prompts import (  # noqa: E402
    INPUT_GROUNDING_RULE,
    OBSERVED_REALITY_RULE,
    build_realtime_instructions,
)


def _personality(**kwargs) -> CaddiePersonality:
    base = dict(
        id="classic",
        name="Classic Caddie",
        description="A steady, no-nonsense caddie.",
        avatar="⛳",
        system_prompt="You are a steady, experienced caddie.",
    )
    base.update(kwargs)
    return CaddiePersonality(**base)


def test_input_grounding_rule_shared_constant_nonempty_and_balanced():
    """Pins the wording contract in both directions: refuse-and-repeat on
    unintelligible input, AND explicitly protect terse-but-clear golf
    questions from over-refusal."""
    assert INPUT_GROUNDING_RULE.strip() != ""
    assert "say again" in INPUT_GROUNDING_RULE
    assert "driver?" in INPUT_GROUNDING_RULE


def test_input_grounding_rule_in_realtime_prompt():
    personality = _personality(realtime_instructions="Speak plainly and keep it short.")
    instructions = build_realtime_instructions(personality)

    assert INPUT_GROUNDING_RULE in instructions


def test_input_grounding_rule_ordering_in_behavior_block():
    """Behavior block order: HAZARD_GROUNDING_RULE < INPUT_GROUNDING_RULE <
    OBSERVED_REALITY_RULE — pins the composition (§3: insertion must land
    immediately BEFORE OBSERVED_REALITY_RULE so the endswith pins in
    tests/test_voice_stream.py stay green)."""
    from app.caddie.hazards import HAZARD_GROUNDING_RULE

    personality = _personality(realtime_instructions="Speak plainly.")
    instructions = build_realtime_instructions(personality)

    behavior_idx = instructions.index("# Behavior")
    hazard_idx = instructions.index(HAZARD_GROUNDING_RULE)
    input_idx = instructions.index(INPUT_GROUNDING_RULE)
    observed_idx = instructions.index(OBSERVED_REALITY_RULE)
    assert behavior_idx < hazard_idx < input_idx < observed_idx


def test_routes_caddie_imports_input_grounding_rule():
    """Text-mouth CI coverage (via existing DB-backed voice tests) depends on
    the constant actually being imported into routes/caddie.py and appended
    to BOTH `stable_text` blocks; this pins the import exists at all (a
    missing import would raise ImportError far away, at request time, not at
    review time)."""
    import inspect

    from app.routes import caddie as caddie_routes

    assert caddie_routes.INPUT_GROUNDING_RULE is INPUT_GROUNDING_RULE
    source = inspect.getsource(caddie_routes)
    assert source.count("{INPUT_GROUNDING_RULE}") == 2, (
        "expected the constant interpolated into BOTH mirrored text-mouth "
        "stable_text blocks (_build_session_voice_prompt and _build_voice_prompt)"
    )
