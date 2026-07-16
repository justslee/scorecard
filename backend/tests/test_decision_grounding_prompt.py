"""Unit tests for `DECISION_GROUNDING_RULE` (specs/caddie-advice-stability
-tee-shot-plan.md §3.2, §3.6) — the fix for the 2026-07-15 consistency
baseline defect: on `followup-3wood-after-driver` asked 5x, grounded facts
held but the club RECOMMENDATION flipped (3/5 lay-up with 3-wood, 2/5 stick
with driver). Mirrors `test_numbers_coherence_prompt.py`'s pattern
(DATABASE_URL stub before import — `app.caddie.voice_prompts` transitively
imports `app.db.models` -> `app.db.engine`, which raises at import time
otherwise).

No network, no real database.
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

from app.caddie.types import CaddiePersonality  # noqa: E402
from app.caddie.voice_prompts import (  # noqa: E402
    DECISION_GROUNDING_RULE,
    MISS_SIDE_GROUNDING_RULE,
    build_realtime_instructions,
    format_tee_numbers_line,
    _situation_block,
)


def _personality(**kwargs) -> CaddiePersonality:
    base = dict(
        id="classic", name="Classic Caddie", description="A steady, no-nonsense caddie.",
        avatar="⛳", system_prompt="You are a steady, experienced caddie.",
    )
    base.update(kwargs)
    return CaddiePersonality(**base)


# ── Rule constant: non-empty + carries the contract phrases ────────────────


def test_decision_grounding_rule_nonempty_and_on_topic():
    assert DECISION_GROUNDING_RULE.strip() != ""
    assert "club" in DECISION_GROUNDING_RULE.lower()


def test_decision_grounding_rule_contains_contract_phrases():
    """Gate assertion — the rule text itself must instruct explaining (not
    re-deciding) the engine's call, and refuse to flip on preference alone."""
    assert "explain it, don't re-decide it" in DECISION_GROUNDING_RULE
    assert "never flip the call just to agree" in DECISION_GROUNDING_RULE
    assert "new information" in DECISION_GROUNDING_RULE
    assert "same question on the same facts" in DECISION_GROUNDING_RULE


# ── Gate (2): present in the realtime prompt, ordered after MISS_SIDE ──────


def test_decision_grounding_rule_present_in_realtime_instructions():
    personality = _personality(realtime_instructions="Speak plainly and keep it short.")
    instructions = build_realtime_instructions(personality)

    assert DECISION_GROUNDING_RULE in instructions


def test_decision_grounding_rule_follows_miss_side_rule_in_behavior_block():
    personality = _personality(realtime_instructions="Speak plainly.")
    instructions = build_realtime_instructions(personality)

    behavior_idx = instructions.index("# Behavior")
    miss_side_idx = instructions.index(MISS_SIDE_GROUNDING_RULE)
    decision_idx = instructions.index(DECISION_GROUNDING_RULE)
    assert behavior_idx < miss_side_idx < decision_idx


# ── Gate (3): text-mouth coverage — both mirrored stable_text blocks ───────


def test_routes_caddie_imports_and_interpolates_decision_grounding_rule():
    """Mirrors test_routes_caddie_imports_both_new_rules — the constant must
    be imported into routes/caddie.py and interpolated into BOTH mirrored
    `stable_text` blocks (_build_session_voice_prompt and _build_voice_prompt)."""
    import inspect

    from app.routes import caddie as caddie_routes

    assert caddie_routes.DECISION_GROUNDING_RULE is DECISION_GROUNDING_RULE
    source = inspect.getsource(caddie_routes)
    assert source.count("{DECISION_GROUNDING_RULE}") == 2, (
        "expected DECISION_GROUNDING_RULE interpolated into BOTH mirrored "
        "text-mouth stable_text blocks"
    )


# ── Gate (4): engine-decision-is-echoed contract ────────────────────────────


def test_engine_recommendation_is_echoed_for_followup_3wood_after_driver():
    """The eval-fidelity seed (plan §3.4) must actually give the anchor rule
    something to bite on: the REAL engine's recommendation for the
    470y/driver-250/3wood-235 scenario is `driver`, and it must render into
    `_situation_block`'s `Last recommendation:` line exactly as production's
    `recommend_payload` -> `_situation_block` path would."""
    from tests.eval.checks import build_round_session
    from tests.eval.schema import GOLDEN_SET_PATH, load_golden_set

    scenarios = {s.id: s for s in load_golden_set(GOLDEN_SET_PATH)}
    scenario = scenarios["followup-3wood-after-driver"]
    assert scenario.situation.seed_recommendation is True

    session = build_round_session(scenario)

    assert session.last_recommendation is not None
    assert session.last_recommendation.club == "driver"
    assert session.last_recommendation.tee_shot_numbers is not None

    block = _situation_block(session)
    assert "Last recommendation: driver" in block
    assert format_tee_numbers_line(session.last_recommendation.tee_shot_numbers) in block
