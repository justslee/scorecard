"""The structural pin — specs/caddie-two-tier-routing-plan.md §3/§11.

Proves the context strip: hazard-side detail, bend, the cached strategy
guide, and green slope are removed from BOTH mouths' baked prompt context
(they now live server-side in the get_strategy brain payload ONLY —
strategy.py). Tee-shot numbers, aim/miss (the engine's own verdict), the
par-sanity note, and everything else stay — a benign chit-chat/fast-path
turn must be byte-unaffected. Transcription-vocab keyterms (a transcriber
bias, never generative context) are explicitly untouched.
"""

from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

from app.caddie.keyterms import build_transcription_prompt  # noqa: E402
from app.caddie.session import RoundSession  # noqa: E402
from app.caddie.types import (  # noqa: E402
    AimPoint,
    CaddiePersonality,
    CaddieRecommendation,
    GreenSlope,
    Hazard,
    HoleBend,
    HoleIntelligence,
    HoleStrategyGuide,
    MissSide,
    TeeShotNumbers,
)
from app.caddie.voice_prompts import build_realtime_instructions, format_par_sanity_note  # noqa: E402
import app.routes.caddie as caddie_routes  # noqa: E402


def _persona() -> CaddiePersonality:
    return CaddiePersonality(
        id="classic", name="Classic Caddie", description="A steady caddie.",
        avatar="⛳", system_prompt="You are a steady, experienced caddie.",
        realtime_instructions="Speak plainly and keep it short.",
    )


def _loaded_hole_intel() -> HoleIntelligence:
    return HoleIntelligence(
        hole_number=7,
        par=4,
        yards=466,
        hazards=[
            Hazard(type="bunker", side="left", line_side="left", carry_yards=245),
            Hazard(type="water", side="right", line_side="right", carry_yards=300),
        ],
        bend=HoleBend(straight=False, direction="left", distance_yards=270, deviation_yards=88),
        green_slope=GreenSlope(description="Back-to-front, breaks right"),
        strategy_guide=HoleStrategyGuide(
            play_line="Favor the left side off the tee.",
            miss_side="Bail out short-right.",
        ),
    )


def _loaded_session(**overrides) -> RoundSession:
    base = dict(
        round_id="r1", user_id="u1", current_hole=7, handicap=12.4,
        hole_intel={7: _loaded_hole_intel()},
        last_recommendation=CaddieRecommendation(
            club="driver",
            target_yards=466,
            raw_yards=466,
            aim_point=AimPoint(description="Center of fairway"),
            miss_side=MissSide(preferred="right"),
            shot_kind="positioning",
            tee_shot_numbers=TeeShotNumbers(
                hole_number=7, to_green_yards=466, plays_like_yards=466,
                club="driver", club_stored_yards=300, drive_carry_yards=260,
                drive_total_yards=276, leave_exact_yards=190, leave_yards=190,
            ),
        ),
    )
    base.update(overrides)
    return RoundSession(**base)


# ── Realtime mouth ───────────────────────────────────────────────────────


def test_realtime_instructions_carry_no_hazard_side_detail():
    text = build_realtime_instructions(_persona(), session=_loaded_session())
    assert "Hole 7 hazards" not in text
    assert "bunker L 245y" not in text
    assert "water R 300y" not in text


def test_realtime_instructions_carry_no_guide_text():
    text = build_realtime_instructions(_persona(), session=_loaded_session())
    assert "Local knowledge:" not in text
    assert "Favor the left side off the tee." not in text


def test_realtime_instructions_carry_no_bend_or_green_slope_lines():
    text = build_realtime_instructions(_persona(), session=_loaded_session())
    assert "doglegs left" not in text
    assert "Hole 7 shape" not in text
    assert "Green slope:" not in text


def test_realtime_instructions_keep_tee_numbers_aim_miss_and_par_sanity():
    """The strip must not touch the engine's own verdict — tee-shot numbers,
    aim/miss, and the par-sanity guard are all kept (NUMBERS_COHERENCE_RULE
    depends on the tee-shot numbers being present)."""
    session = _loaded_session(
        hole_intel={7: HoleIntelligence(hole_number=7, par=3, yards=355)},  # suspect par-3
    )
    text = build_realtime_instructions(_persona(), session=session)
    assert "Last recommendation: driver." in text
    assert "aim: Center of fairway, miss: right" in text
    assert "466" in text  # tee-shot numbers block survives
    assert format_par_sanity_note(3, 355) in text


# ── Text mouth ───────────────────────────────────────────────────────────


async def _fake_personality_visible_always(persona_id, user_id=None):
    return True


async def _fake_load_personality_classic(persona_id, user_id=None):
    return CaddiePersonality(
        id="classic", name="Classic", description="", avatar="🏌️",
        system_prompt="Classic system prompt.",
    )


async def _noop_set_current_hole(round_id, hole_number):
    return None


async def _no_memories(user_id):
    return []


def _patch_session_builder_deps(monkeypatch, session):
    async def _fake_get_owned_session(round_id, user_id):
        return session

    monkeypatch.setattr(caddie_routes, "get_owned_session", _fake_get_owned_session)
    monkeypatch.setattr(caddie_routes, "personality_visible", _fake_personality_visible_always)
    monkeypatch.setattr(caddie_routes, "load_personality", _fake_load_personality_classic)
    monkeypatch.setattr(caddie_routes.sessions, "set_current_hole", _noop_set_current_hole)
    monkeypatch.setattr(caddie_routes.memory_mod, "get_top_memories", _no_memories)


async def test_session_voice_prompt_carries_no_hazard_bend_guide_or_slope_lines(monkeypatch):
    session = _loaded_session()
    _patch_session_builder_deps(monkeypatch, session)

    request = caddie_routes.SessionVoiceRequest(
        round_id="r1", transcript="what club?", personality_id="classic",
        hole_number=7, hole_yards=466, yardage_basis="tee-card",
    )
    system_blocks, _messages, _persona_id = await caddie_routes._build_session_voice_prompt(request, "u1")
    situation_text = system_blocks[1]["text"]

    assert "Hole 7 hazards" not in situation_text
    assert "bunker L 245y" not in situation_text
    assert "doglegs left" not in situation_text
    assert "Local knowledge:" not in situation_text
    assert "Green slope:" not in situation_text
    # Elevation math + last-recommendation + yardage line all survive.
    assert "Last recommendation: driver." in situation_text
    assert "466 yards" in situation_text


# ── Transcription-vocab keyterms — untouched on purpose (§3) ───────────────


def test_transcription_vocab_prompt_still_carries_hazard_terms():
    """`build_transcription_prompt` biases the TRANSCRIBER, never generative
    context — the strip must not touch it."""
    session = _loaded_session()
    prompt = build_transcription_prompt(session)
    assert prompt is not None
    assert "bunker" in prompt
    assert "water hazard" in prompt
