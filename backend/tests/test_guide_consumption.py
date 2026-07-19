"""T-G — strategy-guide consumption (specs/caddie-numbers-coherence-plan.md
§4.2, §7; UPDATED by specs/caddie-two-tier-routing-plan.md §3, §5). Originally
pinned that both mouths render `format_guide_line(intel.strategy_guide)`
straight into their baked situation context. The structural context strip
(§3) removes that injection site entirely — the cached guide now reaches
ONLY the get_strategy brain payload (strategy.py::build_strategy_payload),
gated at read time against the engine's own verdict (§5, app.caddie.verdict).
This file now locks the INVERSE: neither mouth's baked prompt context ever
carries guide text again, so a future regression can't silently re-open the
freelancing channel that caused the wrong-side-advice incidents.

No network, no real database — mirrors `test_golden_tier1.py`'s DB-dependency
monkeypatch pattern for the text mouth; `_situation_block` is pure for the
realtime mouth.
"""

from __future__ import annotations

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

from app.caddie.session import RoundSession  # noqa: E402
from app.caddie.types import HoleIntelligence, HoleStrategyGuide  # noqa: E402
from app.caddie.voice_prompts import _situation_block  # noqa: E402
import app.routes.caddie as caddie_routes  # noqa: E402


def _guide() -> HoleStrategyGuide:
    return HoleStrategyGuide(
        play_line="Favor the left-center off the tee.",
        miss_side="Miss short of the bunkers, never long.",
        green_notes="Green runs back-to-front.",
    )


def _session(guide) -> RoundSession:
    return RoundSession(
        round_id="r1", user_id="u1", current_hole=1,
        hole_intel={1: HoleIntelligence(hole_number=1, par=4, yards=400, strategy_guide=guide)},
    )


# ── Realtime mouth: _situation_block ────────────────────────────────────────


def test_realtime_situation_block_never_includes_guide_even_when_cached():
    """UPDATED (§3): the guide is a brain-payload-only ingredient now — was
    `test_realtime_situation_block_includes_guide_when_cached`."""
    from app.caddie.guide_writer import format_guide_line

    session = _session(_guide())
    block = _situation_block(session)
    assert format_guide_line(_guide()) not in block
    assert "Local knowledge" not in block


def test_realtime_situation_block_omits_guide_when_none():
    """Honest omission ([[no-fake-data-fallbacks]]) — no guide cached, no line,
    never a placeholder."""
    session = _session(None)
    block = _situation_block(session)
    assert "Local knowledge" not in block


# ── Text mouth: _build_session_voice_prompt ─────────────────────────────────


async def _fake_personality_visible_always(persona_id, user_id=None):
    return True


async def _fake_load_personality_classic(persona_id, user_id=None):
    from app.caddie.types import CaddiePersonality

    return CaddiePersonality(
        id="classic", name="Classic Caddie", description="A steady caddie.",
        avatar="⛳", system_prompt="You are a steady, experienced caddie.",
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


async def test_text_mouth_context_never_includes_guide_even_when_cached(monkeypatch):
    """UPDATED (§3): ADVICE turns are intercepted server-side before Claude
    ever runs (§5) — the text mouth's baked prompt never needs the guide,
    and never gets it. Was `test_text_mouth_context_includes_guide_when_
    cached`."""
    from app.caddie.guide_writer import format_guide_line

    session = _session(_guide())
    _patch_session_builder_deps(monkeypatch, session)

    request = caddie_routes.SessionVoiceRequest(
        round_id="r1", transcript="What's the play here?", personality_id="classic",
        hole_number=1, hole_yards=400, yardage_basis="card",
    )
    system_blocks, _messages, _persona_id = await caddie_routes._build_session_voice_prompt(request, "u1")
    situation_text = system_blocks[1]["text"]

    assert format_guide_line(_guide()) not in situation_text
    assert "Local knowledge" not in situation_text


async def test_text_mouth_context_omits_guide_when_none(monkeypatch):
    session = _session(None)
    _patch_session_builder_deps(monkeypatch, session)

    request = caddie_routes.SessionVoiceRequest(
        round_id="r1", transcript="What's the play here?", personality_id="classic",
        hole_number=1, hole_yards=400, yardage_basis="card",
    )
    system_blocks, _messages, _persona_id = await caddie_routes._build_session_voice_prompt(request, "u1")
    situation_text = system_blocks[1]["text"]

    assert "Local knowledge" not in situation_text
