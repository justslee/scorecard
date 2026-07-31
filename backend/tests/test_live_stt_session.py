"""Tests for the Part C live-STT session mint endpoint
(specs/live-transcription-plan.md §4) — the flagged (`LIVE_STT_ENGINE`,
default "deepgram") dictation-engine swap. DB-free, no network — same pattern
as tests/test_transcription_prompt.py: pure payload-shape assertions plus
route functions called directly (monkeypatched dependencies), bypassing
FastAPI's DI so no app/DB bootstrap is needed.
"""

import os

# Silence DATABASE_URL + secrets import checks so app modules import without a
# real DB or API key present.
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://u:p@localhost:5432/x")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

import app.routes.voice as voice_routes  # noqa: E402
from app.caddie.keyterms import golf_baseline_prompt  # noqa: E402
from app.services.realtime_relay import (  # noqa: E402
    LIVE_STT_OPENAI_MODEL,
    build_transcription_session_payload,
)


# ── build_transcription_session_payload — pure payload shape ──────────────


def test_payload_shape_matches_the_plan():
    payload = build_transcription_session_payload(["dave", "pebble beach"])
    session = payload["session"]
    assert session["type"] == "transcription"

    audio_in = session["audio"]["input"]
    assert audio_in["format"] == {"type": "audio/pcm", "rate": 24000}

    transcription = audio_in["transcription"]
    assert transcription["model"] == LIVE_STT_OPENAI_MODEL
    assert transcription["model"] == "gpt-live-transcribe"  # explicit default, per the plan
    assert transcription["languages"] == ["en"]
    assert transcription["delay"] == "low"
    assert transcription["keywords"] == ["dave", "pebble beach"]  # passed through verbatim
    assert transcription["prompt"] == golf_baseline_prompt()

    turn_detection = audio_in["turn_detection"]
    assert turn_detection["type"] == "server_vad"
    # Deliberately mirrors Deepgram's utterance_end_ms=1200
    # (frontend/src/lib/voice/deepgram-live.ts:41) — preserves auto-send
    # timing across the engine swap (§4.4/§10 risk 10).
    assert turn_detection["silence_duration_ms"] == 1200


def test_payload_keywords_empty_list_when_no_keyterms():
    payload = build_transcription_session_payload([])
    assert payload["session"]["audio"]["input"]["transcription"]["keywords"] == []


def test_payload_model_override():
    payload = build_transcription_session_payload([], model="gpt-live-transcribe-preview")
    assert (
        payload["session"]["audio"]["input"]["transcription"]["model"]
        == "gpt-live-transcribe-preview"
    )


def test_payload_no_tools_no_instructions_bare_transcription_session():
    """Unlike build_session_payload() (the conversational caddie session),
    this is audio-in/text-out only — no tools, no system instructions, no
    output voice/modalities."""
    payload = build_transcription_session_payload([])
    session = payload["session"]
    assert "tools" not in session
    assert "instructions" not in session
    assert "output" not in session["audio"]


# ── keyterm sanitation (mirrors /transcribe's clamp) ───────────────────────


def test_sanitize_keyterms_clamps_length_and_count():
    long_term = "x" * 200
    many_terms = [f"term{i}" for i in range(80)]
    out = voice_routes._sanitize_live_stt_keyterms([long_term, *many_terms])
    assert len(out[0]) == 80
    assert len(out) == 50  # capped


def test_sanitize_keyterms_drops_blanks_and_none():
    assert voice_routes._sanitize_live_stt_keyterms(None) == []
    assert voice_routes._sanitize_live_stt_keyterms([]) == []
    assert voice_routes._sanitize_live_stt_keyterms(["  ", "", "dave"]) == ["dave"]


# ── _openai_secret_from_mint — both response shapes ────────────────────────


def test_openai_secret_from_mint_top_level_value():
    assert voice_routes._openai_secret_from_mint({"value": "ek_test", "expires_at": 999}) == "ek_test"


def test_openai_secret_from_mint_nested_client_secret():
    assert (
        voice_routes._openai_secret_from_mint({"client_secret": {"value": "ek_nested"}})
        == "ek_nested"
    )


def test_openai_secret_from_mint_missing_raises_502():
    with pytest.raises(HTTPException) as exc_info:
        voice_routes._openai_secret_from_mint({"unexpected": "shape"})
    assert exc_info.value.status_code == 502


# ── get_live_session — flag routing ────────────────────────────────────────


async def test_default_engine_is_deepgram(monkeypatch):
    """LIVE_STT_ENGINE unset -> "deepgram" -> byte-equivalent to the legacy
    /live-token path; mint_transcription_session (OpenAI) is never called."""
    monkeypatch.delenv("LIVE_STT_ENGINE", raising=False)
    mint_called = {"count": 0}

    async def fake_grant_live_token():
        return {"access_token": "dg_token", "expires_in": 60}

    async def fake_mint_transcription_session(keyterms):
        mint_called["count"] += 1
        return {"value": "ek_should_not_be_called"}

    monkeypatch.setattr(voice_routes, "grant_live_token", fake_grant_live_token)
    monkeypatch.setattr(
        voice_routes, "mint_transcription_session", fake_mint_transcription_session
    )

    resp = await voice_routes.get_live_session(
        voice_routes.LiveSttSessionRequest(), user_id="user-1"
    )

    assert resp.engine == "deepgram"
    assert resp.access_token == "dg_token"
    assert resp.expires_in == 60
    assert resp.model is None
    assert mint_called["count"] == 0


async def test_explicit_deepgram_engine_matches_default(monkeypatch):
    monkeypatch.setenv("LIVE_STT_ENGINE", "deepgram")

    async def fake_grant_live_token():
        return {"access_token": "dg_token_2", "expires_in": 60}

    monkeypatch.setattr(voice_routes, "grant_live_token", fake_grant_live_token)

    resp = await voice_routes.get_live_session(
        voice_routes.LiveSttSessionRequest(), user_id="user-1"
    )
    assert resp.engine == "deepgram"
    assert resp.access_token == "dg_token_2"


async def test_openai_engine_mints_transcription_session_and_never_calls_deepgram(monkeypatch):
    monkeypatch.setenv("LIVE_STT_ENGINE", "openai")
    deepgram_called = {"count": 0}
    captured: dict = {}

    async def fake_grant_live_token():
        deepgram_called["count"] += 1
        return {"access_token": "should_not_be_used", "expires_in": 60}

    async def fake_mint_transcription_session(keyterms):
        captured["keyterms"] = keyterms
        return {"value": "ek_openai_test", "expires_at": 999}

    monkeypatch.setattr(voice_routes, "grant_live_token", fake_grant_live_token)
    monkeypatch.setattr(
        voice_routes, "mint_transcription_session", fake_mint_transcription_session
    )

    resp = await voice_routes.get_live_session(
        voice_routes.LiveSttSessionRequest(keyterms=["dave", "pebble beach"]),
        user_id="user-1",
    )

    assert resp.engine == "openai"
    assert resp.access_token == "ek_openai_test"
    assert resp.expires_in == 60
    assert resp.model == LIVE_STT_OPENAI_MODEL
    assert deepgram_called["count"] == 0
    # Keyterms threaded through, sanitized.
    assert captured["keyterms"] == ["dave", "pebble beach"]


async def test_openai_engine_sanitizes_keyterms_before_minting(monkeypatch):
    monkeypatch.setenv("LIVE_STT_ENGINE", "openai")
    captured: dict = {}

    async def fake_mint_transcription_session(keyterms):
        captured["keyterms"] = keyterms
        return {"value": "ek_test", "expires_at": 999}

    monkeypatch.setattr(
        voice_routes, "mint_transcription_session", fake_mint_transcription_session
    )

    long_term = "y" * 200
    many_terms = [f"t{i}" for i in range(80)]
    await voice_routes.get_live_session(
        voice_routes.LiveSttSessionRequest(keyterms=[long_term, *many_terms]),
        user_id="user-1",
    )

    assert len(captured["keyterms"][0]) == 80
    assert len(captured["keyterms"]) == 50


async def test_no_keyterms_body_defaults_to_empty_list(monkeypatch):
    monkeypatch.setenv("LIVE_STT_ENGINE", "openai")
    captured: dict = {}

    async def fake_mint_transcription_session(keyterms):
        captured["keyterms"] = keyterms
        return {"value": "ek_test", "expires_at": 999}

    monkeypatch.setattr(
        voice_routes, "mint_transcription_session", fake_mint_transcription_session
    )

    await voice_routes.get_live_session(voice_routes.LiveSttSessionRequest(), user_id="user-1")
    assert captured["keyterms"] == []
