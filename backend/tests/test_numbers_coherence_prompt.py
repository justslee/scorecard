"""Unit tests for `NUMBERS_COHERENCE_RULE` / `MISS_SIDE_GROUNDING_RULE` and
`format_tee_numbers_line` (specs/caddie-numbers-coherence-plan.md §2.3, §2.4,
§6, §7). Mirrors `test_positioning_prompt.py`'s pattern (DATABASE_URL stub
before import — `app.caddie.voice_prompts` transitively imports
`app.db.models` -> `app.db.engine`, which raises at import time otherwise).

No network, no real database.
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")

from app.caddie.session import RoundSession  # noqa: E402
from app.caddie.types import (  # noqa: E402
    AimPoint,
    CaddiePersonality,
    CaddieRecommendation,
    MissSide,
    TeeShotNumbers,
)
from app.caddie.voice_prompts import (  # noqa: E402
    MISS_SIDE_GROUNDING_RULE,
    NUMBERS_COHERENCE_RULE,
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


def _fixture_numbers(**overrides) -> TeeShotNumbers:
    base = dict(
        hole_number=1, to_green_yards=466, yardage_basis="tee-card",
        plays_like_yards=466, club="driver", club_stored_yards=300,
        drive_carry_yards=266, drive_total_yards=276,
        leave_exact_yards=190, leave_yards=190, leave_plays_like_yards=190,
    )
    base.update(overrides)
    return TeeShotNumbers(**base)


# ── Rule constants: non-empty + carry the challenge-path contract ──────────


def test_numbers_coherence_rule_nonempty_and_on_topic():
    assert NUMBERS_COHERENCE_RULE.strip() != ""
    assert "tee shot" in NUMBERS_COHERENCE_RULE.lower()
    assert "leave" in NUMBERS_COHERENCE_RULE.lower()


def test_numbers_coherence_rule_contains_challenge_path_language():
    """Gate (4) unit assertion — the rule text itself must instruct
    re-deriving and admitting a misspeak, never defending a wrong number."""
    assert "re-derive" in NUMBERS_COHERENCE_RULE.lower()
    assert "misspoke" in NUMBERS_COHERENCE_RULE.lower()
    assert "never invent" in NUMBERS_COHERENCE_RULE.lower()


def test_miss_side_grounding_rule_nonempty_and_on_topic():
    assert MISS_SIDE_GROUNDING_RULE.strip() != ""
    assert "miss side" in MISS_SIDE_GROUNDING_RULE.lower()
    assert "both sides" in MISS_SIDE_GROUNDING_RULE.lower()


# ── Gate (2): both rules present in the realtime prompt ────────────────────


def test_both_rules_present_in_realtime_instructions():
    personality = _personality(realtime_instructions="Speak plainly and keep it short.")
    instructions = build_realtime_instructions(personality)

    assert NUMBERS_COHERENCE_RULE in instructions
    assert MISS_SIDE_GROUNDING_RULE in instructions


def test_both_rules_follow_positioning_shot_rule_in_behavior_block():
    from app.caddie.voice_prompts import POSITIONING_SHOT_RULE

    personality = _personality(realtime_instructions="Speak plainly.")
    instructions = build_realtime_instructions(personality)

    behavior_idx = instructions.index("# Behavior")
    positioning_idx = instructions.index(POSITIONING_SHOT_RULE)
    numbers_idx = instructions.index(NUMBERS_COHERENCE_RULE)
    miss_side_idx = instructions.index(MISS_SIDE_GROUNDING_RULE)
    assert behavior_idx < positioning_idx < numbers_idx < miss_side_idx


def test_routes_caddie_imports_both_new_rules():
    """Text-mouth coverage: the constants must be imported into
    routes/caddie.py and interpolated into BOTH mirrored `stable_text`
    blocks (_build_session_voice_prompt and _build_voice_prompt) — mirrors
    test_routes_caddie_imports_positioning_shot_rule."""
    import inspect

    from app.routes import caddie as caddie_routes

    assert caddie_routes.NUMBERS_COHERENCE_RULE is NUMBERS_COHERENCE_RULE
    assert caddie_routes.MISS_SIDE_GROUNDING_RULE is MISS_SIDE_GROUNDING_RULE
    source = inspect.getsource(caddie_routes)
    assert source.count("{NUMBERS_COHERENCE_RULE}") == 2, (
        "expected NUMBERS_COHERENCE_RULE interpolated into BOTH mirrored "
        "text-mouth stable_text blocks"
    )
    assert source.count("{MISS_SIDE_GROUNDING_RULE}") == 2, (
        "expected MISS_SIDE_GROUNDING_RULE interpolated into BOTH mirrored "
        "text-mouth stable_text blocks"
    )


# ── format_tee_numbers_line: renders the closing equation ───────────────────


def test_format_tee_numbers_line_renders_the_closing_equation():
    n = _fixture_numbers()
    line = format_tee_numbers_line(n)

    assert "466" in line
    assert "276" in line
    assert "190" in line
    assert "AUTHORITATIVE" in line
    assert "466 − 276 = 190" in line


def test_format_tee_numbers_line_labels_competition_legal():
    n = _fixture_numbers(drive_carry_yards=None, drive_total_yards=300, leave_exact_yards=166, leave_yards=165)
    line = format_tee_numbers_line(n)
    assert "competition-legal" in line.lower()
    assert "carries" not in line.lower()  # no environmental carry number to speak


# ── _situation_block: numbers-carrying last_recommendation ─────────────────


def _session_with_numbers_rec(**numbers_overrides) -> RoundSession:
    numbers = _fixture_numbers(**numbers_overrides)
    rec = CaddieRecommendation(
        club="driver", target_yards=466, raw_yards=466,
        aim_point=AimPoint(description="Positioning shot — green's out of reach. middle of the fairway; leaves about 190 in."),
        miss_side=MissSide(preferred="center"),
        shot_kind="positioning", leave_yards=190,
        tee_shot_numbers=numbers,
    )
    return RoundSession(round_id="r1", user_id="u1", current_hole=1, last_recommendation=rec)


def test_situation_block_numbers_rec_contains_formatter_output_not_bare_form():
    session = _session_with_numbers_rec()
    block = _situation_block(session)

    assert format_tee_numbers_line(session.last_recommendation.tee_shot_numbers) in block
    # The old incoherent bare form ("driver to 466y") must be gone for a
    # numbers-carrying recommendation.
    assert "to 466y" not in block


def test_situation_block_reachable_rec_keeps_old_bare_form():
    """Regression guard: a reachable/approach recommendation (tee_shot_numbers
    None) keeps today's bare line byte-identical — only positioning turns get
    the new numbers block."""
    rec = CaddieRecommendation(
        club="7iron", target_yards=150, raw_yards=150,
        aim_point=AimPoint(description="Center of green"),
        miss_side=MissSide(preferred="left"),
    )
    session = RoundSession(round_id="r1", user_id="u1", current_hole=7, last_recommendation=rec)
    block = _situation_block(session)

    assert "Last recommendation: 7iron to 150y, aim: Center of green, miss: left" in block
