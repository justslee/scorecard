"""Unit tests for `POSITIONING_SHOT_RULE` (app/caddie/voice_prompts.py) —
specs/caddie-shot-context-reachability-plan.md §6.

Owner incident 2026-07-06: on a ~400y par 4, the caddie said "Aim about 9
yards left of the flag" off the tee — the green was out of reach, so the
flag was irrelevant. Neither caddie mouth told the model to stop giving
pin-relative aim on an unreachable shot. This rule is the fix, shared by
BOTH mouths (the realtime prompt here, and the text mouth's `stable_text` in
`app/routes/caddie.py`) so wording never drifts between them — mirrors
`test_epistemic_humility_prompt.py`.

No network, no real database — `app.caddie.voice_prompts` transitively
imports `app.db.models` -> `app.db.engine`, which raises at import time when
DATABASE_URL isn't configured, so we stub it first (same pattern as
`tests/test_epistemic_humility_prompt.py`).
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")

from app.caddie.types import CaddiePersonality  # noqa: E402
from app.caddie.voice_prompts import (  # noqa: E402
    POSITIONING_SHOT_RULE,
    YARDAGE_GROUNDING_RULE,
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


def test_positioning_shot_rule_shared_constant_nonempty():
    assert POSITIONING_SHOT_RULE.strip() != ""
    assert "positioning" in POSITIONING_SHOT_RULE
    assert "never" in POSITIONING_SHOT_RULE
    assert "leave" in POSITIONING_SHOT_RULE


def test_positioning_shot_rule_in_realtime_prompt():
    personality = _personality(realtime_instructions="Speak plainly and keep it short.")
    instructions = build_realtime_instructions(personality)

    assert POSITIONING_SHOT_RULE in instructions


def test_positioning_shot_rule_follows_yardage_grounding_rule_in_behavior_block():
    """Both rules live in the same '# Behavior' block, appended in order —
    pins the composition so a future edit can't drop or reorder one."""
    personality = _personality(realtime_instructions="Speak plainly.")
    instructions = build_realtime_instructions(personality)

    behavior_idx = instructions.index("# Behavior")
    yardage_idx = instructions.index(YARDAGE_GROUNDING_RULE)
    positioning_idx = instructions.index(POSITIONING_SHOT_RULE)
    assert behavior_idx < yardage_idx < positioning_idx


def test_routes_caddie_imports_positioning_shot_rule():
    """Text-mouth CI coverage (via existing DB-backed voice tests) depends on
    the constant actually being imported into routes/caddie.py and appended
    to BOTH mirrored `stable_text` blocks; this pins the import exists at
    all (a missing import would raise ImportError far away, at request
    time, not at review time) — mirrors
    `test_routes_caddie_imports_observed_reality_rule`."""
    import inspect

    from app.routes import caddie as caddie_routes

    assert caddie_routes.POSITIONING_SHOT_RULE is POSITIONING_SHOT_RULE
    source = inspect.getsource(caddie_routes)
    assert source.count("{POSITIONING_SHOT_RULE}") == 2, (
        "expected the constant interpolated into BOTH mirrored text-mouth "
        "stable_text blocks (_build_session_voice_prompt and _build_voice_prompt)"
    )
