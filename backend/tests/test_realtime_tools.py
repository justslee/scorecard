"""Tests for the in-round Realtime mint — tool surface v1 + persona voice.

Follows the test_realtime_payload.py pattern: no network, no DB. The route
handler is exercised directly with its collaborators monkeypatched, so we can
assert the exact payload the mint would send (round-scoped instructions,
persona voice_id, full tool list) without a real OpenAI key or Postgres.
"""

import os

# Silence DATABASE_URL + secrets import checks so app modules import without a
# real DB or API key present.
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://u:p@localhost:5432/x")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import pytest  # noqa: E402

from app.caddie.session import RoundSession  # noqa: E402
from app.caddie.types import (  # noqa: E402
    CaddiePersonality,
    Hazard,
    HoleIntelligence,
    HoleStrategyGuide,
)
from app.caddie.hazards import HAZARD_GROUNDING_RULE  # noqa: E402
from app.caddie.voice_prompts import build_realtime_instructions, _situation_block  # noqa: E402
from app.services.realtime_relay import DEFAULT_TOOLS, build_session_payload  # noqa: E402
import app.routes.realtime as realtime_routes  # noqa: E402


EXPECTED_TOOL_NAMES = {
    "get_recommendation",
    "record_shot",
    "get_session_status",
    "get_conditions",
    "get_player_profile",
    "get_carries",
}


# ── Tool surface v1 ──────────────────────────────────────────────────────────


def test_default_tools_expose_the_v1_surface():
    """The P2 tool surface: recommendation, shot log, status, conditions,
    player profile, and the carries stub (real in P3)."""
    names = {t["name"] for t in DEFAULT_TOOLS}
    assert names == EXPECTED_TOOL_NAMES


def test_all_tools_are_well_formed_functions():
    for tool in DEFAULT_TOOLS:
        assert tool["type"] == "function"
        assert tool["name"]
        assert isinstance(tool["parameters"], dict)
        assert tool["parameters"].get("type") == "object"


def test_get_carries_requires_hole_number():
    carries = next(t for t in DEFAULT_TOOLS if t["name"] == "get_carries")
    assert carries["parameters"]["required"] == ["hole_number"]


def test_mint_payload_embeds_the_full_tool_surface():
    payload = build_session_payload("sys", None)
    assert {t["name"] for t in payload["session"]["tools"]} == EXPECTED_TOOL_NAMES


# ── Instructions: never fabricate numbers ────────────────────────────────────


def _persona(**overrides) -> CaddiePersonality:
    base = dict(
        id="strategist",
        name="The Strategist",
        description="Data-driven",
        avatar="📊",
        system_prompt="You are a data-driven caddie.",
        realtime_instructions="Speak in odds and numbers. Terse.",
        voice_id="ash",
    )
    base.update(overrides)
    return CaddiePersonality(**base)


def test_instructions_forbid_untooled_numbers():
    """The one-brain rule: the mouth may not state numbers a tool didn't return."""
    text = " ".join(build_realtime_instructions(_persona()).split())
    assert "Never state a yardage, club distance, or carry you did not get from a tool" in text


def test_instructions_include_persona_and_situation():
    session = RoundSession(round_id="r1", user_id="u1", current_hole=7, handicap=12.4)
    text = build_realtime_instructions(_persona(), session=session)
    assert "Speak in odds and numbers." in text  # persona realtime_instructions
    assert "Current hole: #7" in text  # live session situation block
    assert "Handicap: 12.4" in text


# ── Hazard grounding: never invent a bunker/water feature ────────────────────


def test_instructions_include_hazard_grounding_rule():
    """Owner escalation 2026-07-06 fix: the shared rule reaches the Realtime
    instructions verbatim (no wording drift from a duplicated string)."""
    text = build_realtime_instructions(_persona())
    assert HAZARD_GROUNDING_RULE in text


def test_situation_block_includes_the_exact_compact_hazards_line():
    """Seeded hole_intel hazards render via the shared format_hazards_line —
    the model sees the compact line, not a hand-rolled string."""
    session = RoundSession(
        round_id="r1",
        user_id="u1",
        current_hole=4,
        hole_intel={
            4: HoleIntelligence(
                hole_number=4,
                par=4,
                yards=400,
                hazards=[
                    Hazard(type="bunker", side="left", carry_yards=245, line_side="left"),
                    Hazard(type="water", side="right", carry_yards=190, line_side="right"),
                    Hazard(type="water", side="right", carry_yards=230, line_side="right"),
                ],
            )
        },
    )
    text = build_realtime_instructions(_persona(), session=session)
    assert "Hole 4 hazards: bunker L 245y, water R 190-230y" in text


def test_situation_block_no_hazard_hole_has_directive_but_no_fabricated_feature():
    """A hole with no hazard data still gets the grounding directive in the
    full instructions, but the situation block itself must not mention any
    specific hazard feature (checked in isolation — the directive text alone
    legitimately mentions 'bunker'/'water' as illustrative examples)."""
    session = RoundSession(
        round_id="r1",
        user_id="u1",
        current_hole=5,
        hole_intel={5: HoleIntelligence(hole_number=5, par=4, yards=410, hazards=[])},
    )
    full_text = build_realtime_instructions(_persona(), session=session)
    assert HAZARD_GROUNDING_RULE in full_text

    block = _situation_block(session)
    assert "hazards:" not in block.lower()
    assert "bunker" not in block.lower()
    assert "water" not in block.lower()


# ── Strategy guide: both-mouth injection (caddie-hole-strategy-guides Slice 1) ──


def test_situation_block_includes_the_guide_line_when_present():
    """A seeded strategy_guide reaches the realtime situation block via the
    shared format_guide_line renderer, labeled as reference data."""
    session = RoundSession(
        round_id="r1",
        user_id="u1",
        current_hole=7,
        hole_intel={
            7: HoleIntelligence(
                hole_number=7,
                par=4,
                yards=410,
                strategy_guide=HoleStrategyGuide(
                    play_line="Favor the left side off the tee.",
                    miss_side="Bail out short-right.",
                ),
            )
        },
    )
    block = _situation_block(session)
    assert "Local knowledge: Favor the left side off the tee." in block
    text = build_realtime_instructions(_persona(), session=session)
    assert "Local knowledge: Favor the left side off the tee." in text


def test_situation_block_omits_the_guide_line_when_absent():
    """No guide (the Slice 1 default — no writer runs yet) -> the line is
    simply omitted, never a placeholder ([[no-fake-data-fallbacks]])."""
    session = RoundSession(
        round_id="r1",
        user_id="u1",
        current_hole=7,
        hole_intel={7: HoleIntelligence(hole_number=7, par=4, yards=410, strategy_guide=None)},
    )
    block = _situation_block(session)
    assert "Local knowledge:" not in block


# ── Route handler: round-scoped mint uses persona voice + tools ──────────────


async def test_in_round_mint_uses_persona_voice_and_default_tools(monkeypatch):
    """POST /realtime/session (handler-level): verifies ownership is consulted,
    instructions are built from persona + live session, the persona's voice_id
    reaches the mint, and the response carries the full tool surface."""
    captured: dict = {}
    session = RoundSession(round_id="round-77", user_id="user-1", current_hole=12)

    async def fake_get_owned_session(round_id, user_id):
        captured["ownership_check"] = (round_id, user_id)
        return session

    async def fake_load_personality(pid):
        captured["personality_id"] = pid
        return _persona()

    async def fake_get_top_memories(user_id):
        return []

    async def fake_mint(instructions, voice_id, tools=None):
        captured["mint"] = {"instructions": instructions, "voice_id": voice_id, "tools": tools}
        return {"value": "ek_test", "expires_at": 999, "id": "rs_test", "model": "gpt-realtime"}

    async def fake_set_realtime_session_id(round_id, rsid, personality_id=None):
        captured["stored"] = (round_id, rsid, personality_id)

    monkeypatch.setattr(realtime_routes, "get_owned_session", fake_get_owned_session)
    monkeypatch.setattr(realtime_routes, "load_personality", fake_load_personality)
    monkeypatch.setattr(realtime_routes.memory_mod, "get_top_memories", fake_get_top_memories)
    monkeypatch.setattr(realtime_routes, "mint_ephemeral_session", fake_mint)
    monkeypatch.setattr(
        realtime_routes.sessions, "set_realtime_session_id", fake_set_realtime_session_id
    )

    resp = await realtime_routes.start_realtime_session(
        realtime_routes.StartRealtimeSessionRequest(
            round_id="round-77", personality_id="strategist"
        ),
        user_id="user-1",
    )

    assert captured["ownership_check"] == ("round-77", "user-1")
    assert captured["personality_id"] == "strategist"
    # Persona voice reaches the mint; response reports it.
    assert captured["mint"]["voice_id"] == "ash"
    assert resp.voice_id == "ash"
    # Instructions are round-scoped (live session situation) + persona-derived.
    assert "Current hole: #12" in captured["mint"]["instructions"]
    assert "Speak in odds and numbers." in captured["mint"]["instructions"]
    # Full v1 tool surface is minted and echoed to the client for dispatch.
    assert {t["name"] for t in captured["mint"]["tools"]} == EXPECTED_TOOL_NAMES
    assert {t["name"] for t in resp.tools} == EXPECTED_TOOL_NAMES
    assert resp.client_secret == "ek_test"
    # The realtime session id is stored on the round's caddie session.
    assert captured["stored"] == ("round-77", "rs_test", "strategist")


async def test_in_round_mint_rejects_non_owner(monkeypatch):
    """Ownership failure propagates — no mint happens for someone else's round."""
    from fastapi import HTTPException

    async def deny(round_id, user_id):
        raise HTTPException(404, "Round not found")

    async def fail_mint(*a, **k):  # pragma: no cover — must not be reached
        raise AssertionError("mint must not be called when ownership fails")

    monkeypatch.setattr(realtime_routes, "get_owned_session", deny)
    monkeypatch.setattr(realtime_routes, "mint_ephemeral_session", fail_mint)

    with pytest.raises(HTTPException) as ei:
        await realtime_routes.start_realtime_session(
            realtime_routes.StartRealtimeSessionRequest(round_id="not-mine"),
            user_id="intruder",
        )
    assert ei.value.status_code == 404
