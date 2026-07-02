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
from app.caddie.types import CaddiePersonality  # noqa: E402
from app.caddie.voice_prompts import build_realtime_instructions  # noqa: E402
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
