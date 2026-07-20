"""Tests for POST /api/voice/speak and the openai_tts service
(specs/voice-tts-sheet-replies) — no network, no DB.

Covers:
  - persona -> voice_id resolution passes the right voice to the OpenAI call
  - input length clamp (service level)
  - missing OPENAI_API_KEY -> 500 (service level)
  - response media_type == audio/mpeg (route level)
"""

import os

os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://stub:stub@localhost/stub")

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.caddie.types import CaddiePersonality
from app.services import openai_tts
from app.services.clerk_auth import current_user_id
from app.routes import voice as voice_routes


# ── openai_tts.synthesize_speech (service level) ──────────────────────────


@pytest.mark.asyncio
async def test_missing_api_key_raises_500(monkeypatch):
    monkeypatch.setattr(openai_tts, "OPENAI_API_KEY", None)
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc_info:
        await openai_tts.synthesize_speech("Easy 7-iron here.", "sage")
    assert exc_info.value.status_code == 500


@pytest.mark.asyncio
async def test_clamps_long_input(monkeypatch):
    monkeypatch.setattr(openai_tts, "OPENAI_API_KEY", "test-key")

    captured: dict = {}

    class _FakeResponse:
        status_code = 200
        content = b"fake-mp3-bytes"
        text = ""

    class _FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, headers=None, json=None):
            captured["url"] = url
            captured["json"] = json
            return _FakeResponse()

    monkeypatch.setattr(openai_tts.httpx, "AsyncClient", _FakeAsyncClient)

    long_text = "a" * 10_000
    audio = await openai_tts.synthesize_speech(long_text, "verse")

    assert audio == b"fake-mp3-bytes"
    assert len(captured["json"]["input"]) == openai_tts._MAX_INPUT_CHARS
    assert captured["json"]["voice"] == "verse"


@pytest.mark.asyncio
async def test_falls_back_to_default_voice_when_none(monkeypatch):
    monkeypatch.setattr(openai_tts, "OPENAI_API_KEY", "test-key")

    captured: dict = {}

    class _FakeResponse:
        status_code = 200
        content = b"bytes"
        text = ""

    class _FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, headers=None, json=None):
            captured["json"] = json
            return _FakeResponse()

    monkeypatch.setattr(openai_tts.httpx, "AsyncClient", _FakeAsyncClient)

    await openai_tts.synthesize_speech("Hello", None)
    assert captured["json"]["voice"] == "sage"


@pytest.mark.asyncio
async def test_upstream_error_raises_http_exception(monkeypatch):
    monkeypatch.setattr(openai_tts, "OPENAI_API_KEY", "test-key")

    class _FakeResponse:
        status_code = 401
        content = b""
        text = "invalid api key"

    class _FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, headers=None, json=None):
            return _FakeResponse()

    monkeypatch.setattr(openai_tts.httpx, "AsyncClient", _FakeAsyncClient)

    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc_info:
        await openai_tts.synthesize_speech("Hello", "sage")
    # Upstream errors are mapped to a generic 502 and the raw OpenAI body is
    # NEVER mirrored to the client (prior secret-echo/str(e)-leak incident).
    assert exc_info.value.status_code == 502
    assert "invalid api key" not in str(exc_info.value.detail)


# ── POST /api/voice/speak (route level) ────────────────────────────────────


def _make_client() -> TestClient:
    app = FastAPI()
    app.include_router(voice_routes.router)
    app.dependency_overrides[current_user_id] = lambda: "test-user"
    return TestClient(app)


def test_speak_resolves_persona_voice_id_and_returns_audio_mpeg(monkeypatch):
    captured: dict = {}

    async def _fake_load_personality(personality_id: str, user_id=None) -> CaddiePersonality:
        captured["personality_id"] = personality_id
        return CaddiePersonality(
            id=personality_id,
            name="The Hype Man",
            description="",
            avatar="🔥",
            system_prompt="",
            voice_id="verse",
        )

    async def _fake_synthesize_speech(text: str, voice_id):
        captured["text"] = text
        captured["voice_id"] = voice_id
        return b"mp3-bytes"

    monkeypatch.setattr(voice_routes, "load_personality", _fake_load_personality)
    monkeypatch.setattr(voice_routes, "synthesize_speech", _fake_synthesize_speech)

    client = _make_client()
    res = client.post("/api/voice/speak", json={"text": "Nice drive.", "personality_id": "hype"})

    assert res.status_code == 200
    assert res.headers["content-type"] == "audio/mpeg"
    assert res.content == b"mp3-bytes"
    assert captured["personality_id"] == "hype"
    assert captured["voice_id"] == "verse"
    assert captured["text"] == "Nice drive."


def test_speak_defaults_to_classic_personality(monkeypatch):
    captured: dict = {}

    async def _fake_load_personality(personality_id: str, user_id=None) -> CaddiePersonality:
        captured["personality_id"] = personality_id
        return CaddiePersonality(
            id="classic", name="The Classic Caddie", description="", avatar="🏌️",
            system_prompt="", voice_id="sage",
        )

    async def _fake_synthesize_speech(text: str, voice_id):
        return b"mp3-bytes"

    monkeypatch.setattr(voice_routes, "load_personality", _fake_load_personality)
    monkeypatch.setattr(voice_routes, "synthesize_speech", _fake_synthesize_speech)

    client = _make_client()
    res = client.post("/api/voice/speak", json={"text": "Good distance here."})

    assert res.status_code == 200
    assert captured["personality_id"] == "classic"
