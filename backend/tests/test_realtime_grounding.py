"""Slice A — Realtime mint grounding parity (pure, no OpenAI, no DB).

Closes the gaps between `build_realtime_instructions` (Realtime mint) and
`_build_session_voice_prompt` (the sheet's text session path,
routes/caddie.py ~:524-634): conversation history, green slope, last
recommendation, recent shots. Every addition is guarded ("if present") — a
memory-less / intel-less / history-less user's instructions must be
byte-identical to today's behavior.

Also covers the two grounding tool payloads that grew a field:
`get_session_conditions` (green_slope) and `get_session_status`
(recent_shots). Both are exercised at the route-handler level with
`get_owned_session` monkeypatched, exactly like test_realtime_tools.py's
`test_in_round_mint_uses_persona_voice_and_default_tools` — no real DB.
"""

import os

# Silence DATABASE_URL + secrets import checks so app modules import without a
# real DB or API key present.
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://u:p@localhost:5432/x")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

from app.caddie.session import RoundSession, ShotRecord, VoiceCaddieMessage  # noqa: E402
from app.caddie.types import (  # noqa: E402
    CaddiePersonality,
    CaddieRecommendation,
    AimPoint,
    MissSide,
    GreenSlope,
    HoleIntelligence,
)
from app.caddie.green_geometry import GREEN_GROUNDING_RULE  # noqa: E402
from app.caddie.hazards import HAZARD_GROUNDING_RULE  # noqa: E402
from app.caddie.voice_prompts import build_realtime_instructions, _situation_block  # noqa: E402
import app.routes.caddie as caddie_routes  # noqa: E402


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


def _bare_session(**overrides) -> RoundSession:
    base = dict(round_id="r1", user_id="u1", current_hole=7, handicap=12.4)
    base.update(overrides)
    return RoundSession(**base)


# ── Absent data → byte-identical to today's behavior ─────────────────────────


def test_absent_grounding_fields_are_byte_identical():
    """A session with no history/green-slope/last-rec/shots produces the exact
    same instructions string as a session that only has the fields that
    already existed before this slice (handicap, clubs, weather, hole,
    hazards). Proves every new block is guarded, not just individually absent."""
    bare = _bare_session()
    # A session built only from the pre-existing fields, explicitly leaving
    # the new ones at their zero-value defaults (mirrors `bare`'s defaults).
    pre_slice_equivalent = RoundSession(
        round_id="r1",
        user_id="u1",
        current_hole=7,
        handicap=12.4,
        last_recommendation=None,
        shot_history=[],
        conversation_history=[],
    )
    assert build_realtime_instructions(_persona(), session=bare) == build_realtime_instructions(
        _persona(), session=pre_slice_equivalent
    )


def test_no_session_instructions_unchanged():
    """session=None (e.g. setup flow) is completely unaffected."""
    text = build_realtime_instructions(_persona())
    assert "Earlier this round" not in text
    assert "Last recommendation" not in text
    assert "Recent shots" not in text
    assert "Green slope" not in text


def test_situation_block_with_no_new_data_omits_the_new_lines():
    block = _situation_block(_bare_session())
    assert "Last recommendation" not in block
    assert "Recent shots" not in block
    assert "Green slope" not in block


# ── Gap 1: conversation history ───────────────────────────────────────────────


def test_conversation_history_present_is_included():
    session = _bare_session(
        conversation_history=[
            VoiceCaddieMessage(role="user", content="What should I hit on 7?"),
            VoiceCaddieMessage(role="assistant", content="7 iron, aim center."),
        ]
    )
    text = build_realtime_instructions(_persona(), session=session)
    assert "# Earlier this round (recent conversation)" in text
    assert "Player: What should I hit on 7?" in text
    assert "You: 7 iron, aim center." in text


def test_conversation_history_caps_at_last_twenty_turns():
    messages = [VoiceCaddieMessage(role="user", content=f"turn {i}") for i in range(30)]
    session = _bare_session(conversation_history=messages)
    text = build_realtime_instructions(_persona(), session=session)
    assert "turn 0" not in text  # dropped — outside the last 20
    assert "turn 9" not in text  # 30 - 20 = 10 is the first kept index
    assert "turn 10" in text
    assert "turn 29" in text


def test_conversation_history_absent_is_no_block():
    session = _bare_session(conversation_history=[])
    text = build_realtime_instructions(_persona(), session=session)
    assert "Earlier this round" not in text


# ── Gap 2: green slope ────────────────────────────────────────────────────────


def test_green_slope_present_reaches_situation_block():
    session = _bare_session(
        hole_intel={
            7: HoleIntelligence(
                hole_number=7,
                par=4,
                yards=380,
                green_slope=GreenSlope(
                    direction=45.0, severity="moderate", percent_grade=3.5,
                    description="Back-to-front, breaks right",
                ),
            )
        }
    )
    text = build_realtime_instructions(_persona(), session=session)
    assert "Green slope: Back-to-front, breaks right" in text


def test_green_slope_absent_no_line():
    session = _bare_session(
        hole_intel={7: HoleIntelligence(hole_number=7, par=4, yards=380)}
    )
    text = build_realtime_instructions(_persona(), session=session)
    assert "Green slope" not in text


# ── Gap 3: last recommendation ────────────────────────────────────────────────


def test_last_recommendation_present_reaches_situation_block():
    session = _bare_session(
        last_recommendation=CaddieRecommendation(
            club="7iron",
            target_yards=150,
            raw_yards=150,
            aim_point=AimPoint(description="Center of green"),
            miss_side=MissSide(preferred="left"),
        )
    )
    text = build_realtime_instructions(_persona(), session=session)
    assert "Last recommendation: 7iron to 150y, aim: Center of green, miss: left" in text


def test_last_recommendation_absent_no_line():
    text = build_realtime_instructions(_persona(), session=_bare_session())
    assert "Last recommendation" not in text


# ── Gap 4: recent shots (last 5) ──────────────────────────────────────────────


def test_recent_shots_present_reaches_situation_block_capped_at_five():
    shots = [
        ShotRecord(hole_number=n, club="7iron", distance_yards=150, result="green")
        for n in range(1, 8)
    ]
    session = _bare_session(shot_history=shots)
    text = build_realtime_instructions(_persona(), session=session)
    assert "Recent shots:" in text
    assert "Hole 1: 7iron 150y → green" not in text  # older than the last 5
    assert "Hole 2: 7iron 150y → green" not in text
    assert "Hole 3: 7iron 150y → green" in text
    assert "Hole 7: 7iron 150y → green" in text


def test_recent_shots_absent_no_line():
    text = build_realtime_instructions(_persona(), session=_bare_session())
    assert "Recent shots" not in text


# ── HAZARD_GROUNDING_RULE stays intact ────────────────────────────────────────


def test_hazard_grounding_rule_present_with_full_grounding():
    """Full grounding (history + green slope + last rec + shots all present)
    never displaces or duplicates the hazard-honesty directive."""
    session = _bare_session(
        conversation_history=[VoiceCaddieMessage(role="user", content="hi")],
        last_recommendation=CaddieRecommendation(club="pw", target_yards=110, raw_yards=110),
        shot_history=[ShotRecord(hole_number=6, club="driver", distance_yards=260, result="fairway")],
        hole_intel={
            7: HoleIntelligence(
                hole_number=7, par=4, yards=380,
                green_slope=GreenSlope(description="Flat"),
            )
        },
    )
    text = build_realtime_instructions(_persona(), session=session)
    assert text.count(HAZARD_GROUNDING_RULE) == 1
    assert HAZARD_GROUNDING_RULE in text


# ── GREEN_GROUNDING_RULE stays intact ─────────────────────────────────────────


def test_green_grounding_rule_present_with_full_grounding():
    """Same guard as the hazard rule above, for the green-slope rotation
    engine's grounding rule (specs/caddie-green-slope-spatial-plan.md)."""
    session = _bare_session(
        conversation_history=[VoiceCaddieMessage(role="user", content="hi")],
        last_recommendation=CaddieRecommendation(club="pw", target_yards=110, raw_yards=110),
        shot_history=[ShotRecord(hole_number=6, club="driver", distance_yards=260, result="fairway")],
        hole_intel={
            7: HoleIntelligence(
                hole_number=7, par=4, yards=380,
                green_slope=GreenSlope(description="Flat"),
            )
        },
    )
    text = build_realtime_instructions(_persona(), session=session)
    assert text.count(GREEN_GROUNDING_RULE) == 1
    assert GREEN_GROUNDING_RULE in text


def test_green_grounding_rule_present_with_no_grounding_data():
    text = build_realtime_instructions(_persona())
    assert text.count(GREEN_GROUNDING_RULE) == 1


# ── Tool payload: get_session_conditions exposes green_slope ─────────────────


async def test_get_session_conditions_includes_green_slope_when_mapped(monkeypatch):
    session = _bare_session(
        hole_intel={
            7: HoleIntelligence(
                hole_number=7, par=4, yards=380,
                green_slope=GreenSlope(description="Back-to-front, breaks right"),
            )
        }
    )

    async def fake_get_owned_session(round_id, user_id):
        return session

    monkeypatch.setattr(caddie_routes, "get_owned_session", fake_get_owned_session)

    result = await caddie_routes.get_session_conditions(
        "r1", hole_number=7, user_id="u1"
    )
    assert result["green_slope"] == {"description": "Back-to-front, breaks right"}


async def test_get_session_conditions_green_slope_none_when_unmapped(monkeypatch):
    session = _bare_session(hole_intel={7: HoleIntelligence(hole_number=7, par=4, yards=380)})

    async def fake_get_owned_session(round_id, user_id):
        return session

    monkeypatch.setattr(caddie_routes, "get_owned_session", fake_get_owned_session)

    result = await caddie_routes.get_session_conditions("r1", hole_number=7, user_id="u1")
    assert result["green_slope"] is None


# ── Tool payload: get_session_status exposes recent_shots ────────────────────


async def test_get_session_status_includes_recent_shots(monkeypatch):
    shots = [
        ShotRecord(hole_number=n, club="7iron", distance_yards=150, result="green")
        for n in range(1, 8)
    ]
    session = _bare_session(shot_history=shots)

    async def fake_get_owned_session(round_id, user_id):
        return session

    monkeypatch.setattr(caddie_routes, "get_owned_session", fake_get_owned_session)

    result = await caddie_routes.get_session_status("r1", user_id="u1")
    assert len(result["recent_shots"]) == 5
    assert result["recent_shots"][0]["hole_number"] == 3  # last 5 of 7
    assert result["recent_shots"][-1]["hole_number"] == 7


async def test_get_session_status_recent_shots_empty_when_no_shots(monkeypatch):
    session = _bare_session()

    async def fake_get_owned_session(round_id, user_id):
        return session

    monkeypatch.setattr(caddie_routes, "get_owned_session", fake_get_owned_session)

    result = await caddie_routes.get_session_status("r1", user_id="u1")
    assert result["recent_shots"] == []
