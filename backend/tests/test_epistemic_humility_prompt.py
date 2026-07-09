"""Unit tests for `OBSERVED_REALITY_RULE` (app/caddie/voice_prompts.py) —
item 4 of the hazard-side-flip fix.

Owner escalation (2026-07-06): the caddie insisted a mirrored/stale hazard
side was correct over what the owner could see standing on the tee — it
"gaslit" him. Neither caddie prompt told the model to defer to the player's
direct observation. This rule is the fix, shared by BOTH mouths (the
realtime prompt here, and the text mouth's `stable_text` in
`app/routes/caddie.py`) so wording never drifts between them.

No network, no real database — `app.caddie.voice_prompts` transitively
imports `app.db.models` -> `app.db.engine`, which raises at import time when
DATABASE_URL isn't configured, so we stub it first (same pattern as
`tests/test_course_intel_resilience.py`).
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")

from app.caddie.types import CaddiePersonality  # noqa: E402
from app.caddie.voice_prompts import (  # noqa: E402
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


def test_observed_reality_rule_shared_constant_nonempty():
    assert OBSERVED_REALITY_RULE.strip() != ""
    assert "trust your eyes" in OBSERVED_REALITY_RULE
    assert "mirrored" in OBSERVED_REALITY_RULE


def test_observed_reality_rule_in_realtime_prompt():
    personality = _personality(realtime_instructions="Speak plainly and keep it short.")
    instructions = build_realtime_instructions(personality)

    assert OBSERVED_REALITY_RULE in instructions
    assert "my map may have it mirrored" in instructions


def test_observed_reality_rule_follows_hazard_grounding_rule_in_behavior_block():
    """Both grounding rules live in the same '# Behavior' block, appended
    together — pins the composition so a future edit can't drop one."""
    from app.caddie.hazards import HAZARD_GROUNDING_RULE

    personality = _personality(realtime_instructions="Speak plainly.")
    instructions = build_realtime_instructions(personality)

    behavior_idx = instructions.index("# Behavior")
    grounding_idx = instructions.index(HAZARD_GROUNDING_RULE)
    observed_idx = instructions.index(OBSERVED_REALITY_RULE)
    assert behavior_idx < grounding_idx < observed_idx


def test_routes_caddie_imports_observed_reality_rule():
    """Text-mouth CI coverage (via existing DB-backed voice tests) depends on
    the constant actually being imported into routes/caddie.py and appended
    to `stable_text`; this pins the import exists at all (a missing import
    would raise ImportError far away, at request time, not at review time)."""
    import inspect

    from app.routes import caddie as caddie_routes

    assert caddie_routes.OBSERVED_REALITY_RULE is OBSERVED_REALITY_RULE
    source = inspect.getsource(caddie_routes)
    assert source.count("{OBSERVED_REALITY_RULE}") == 2, (
        "expected the constant interpolated into BOTH mirrored text-mouth "
        "stable_text blocks (_build_session_voice_prompt and _build_voice_prompt)"
    )
