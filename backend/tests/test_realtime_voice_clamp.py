"""Echo-back honesty for the Realtime voice clamp
(specs/caddie-orb-persona-consistency-plan.md §2.2).

`clamp_realtime_voice` fixes what gets MINTED (build_session_payload); this
file pins the companion fix — what the route RESPONSE reports back to the
client. After the clamp, a DB persona carrying an invalid voice_id (e.g. the
prod 'fable' rows on professor / course-historian) would otherwise make the
server REPORT `voice_id="fable"` in `StartRealtimeSessionResponse` while
actually minting the clamped default — a silent lie about which voice the
golfer is about to hear. No DB, no HTTP — pure route-function calls with
monkeypatched collaborators, same pattern as test_transcription_prompt.py's
route-threading tests.
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://u:p@localhost:5432/x")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

from app.services.realtime_relay import OPENAI_REALTIME_DEFAULT_VOICE  # noqa: E402
import app.routes.realtime as realtime_routes  # noqa: E402


def _fake_personality_with_voice(voice_id: str):
    async def fake_load_personality(pid):
        from app.caddie.types import CaddiePersonality

        return CaddiePersonality(
            id=pid,
            name="Professor",
            description="",
            avatar="",
            system_prompt="sys",
            realtime_instructions="",
            voice_id=voice_id,
        )

    return fake_load_personality


async def _fake_mint(instructions, voice_id, tools=None, *, transcription_prompt=None):
    return {"value": "ek_x", "expires_at": 1, "id": "rs_1", "model": "gpt-realtime"}


async def test_setup_session_echo_voice_id_clamped_for_invalid_db_voice(monkeypatch):
    """RED before the clamp: response.voice_id == 'fable'. GREEN after: the
    response describes the voice actually minted, not the raw DB value."""
    monkeypatch.setattr(
        realtime_routes, "load_personality", _fake_personality_with_voice("fable")
    )
    monkeypatch.setattr(realtime_routes, "mint_ephemeral_session", _fake_mint)

    response = await realtime_routes.start_setup_session(
        realtime_routes.SetupSessionRequest(personality_id="professor"),
        user_id="u1",
    )

    assert response.voice_id == OPENAI_REALTIME_DEFAULT_VOICE


async def test_setup_session_echo_voice_id_passes_through_when_valid(monkeypatch):
    """Companion regression pin: a valid voice_id is echoed back unchanged."""
    monkeypatch.setattr(
        realtime_routes, "load_personality", _fake_personality_with_voice("marin")
    )
    monkeypatch.setattr(realtime_routes, "mint_ephemeral_session", _fake_mint)

    response = await realtime_routes.start_setup_session(
        realtime_routes.SetupSessionRequest(personality_id="strategist"),
        user_id="u1",
    )

    assert response.voice_id == "marin"
