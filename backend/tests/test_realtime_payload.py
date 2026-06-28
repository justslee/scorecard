"""Tests for build_session_payload — the pure helper that constructs the Realtime
mint payload.  No network calls are made; nothing is minted against the real API.

Field-name and value choices are documented in realtime_relay.py with citations
to the OpenAI GA Realtime API reference (developers.openai.com, 2025).
"""

import os

# Silence DATABASE_URL + secrets import checks so the service module can import
# without a real DB or API key present.
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://u:p@localhost:5432/x")
os.environ.setdefault("LOOPER_SECRETS_DISABLED", "1")

from app.services.realtime_relay import build_session_payload  # noqa: E402


def test_noise_reduction_present():
    """audio.input.noise_reduction must be present with type 'near_field'.

    Field confirmed at audio.input.noise_reduction in the GA schema (not top-level).
    Allowed types: 'near_field' | 'far_field'. 'near_field' is correct for mobile.
    """
    payload = build_session_payload("sys", None)
    nr = payload["session"]["audio"]["input"]["noise_reduction"]
    assert nr == {"type": "near_field"}, f"unexpected noise_reduction value: {nr}"


def test_transcription_model_default():
    """Default transcription model is gpt-4o-transcribe.

    Confirmed supported by the GA Realtime session schema alongside whisper-1 and
    gpt-4o-mini-transcribe. gpt-4o-transcribe hallucinates far less on silence.
    """
    payload = build_session_payload("sys", None)
    model = payload["session"]["audio"]["input"]["transcription"]["model"]
    assert model == "gpt-4o-transcribe"


def test_transcription_model_override():
    """build_session_payload respects the transcribe_model kwarg."""
    payload = build_session_payload("sys", None, transcribe_model="whisper-1")
    model = payload["session"]["audio"]["input"]["transcription"]["model"]
    assert model == "whisper-1"


def test_output_modalities_is_audio_only():
    """output_modalities must be exactly ['audio'] — GA rejects ['audio', 'text']."""
    payload = build_session_payload("sys", None)
    assert payload["session"]["output_modalities"] == ["audio"]


def test_turn_detection_default_is_server_vad():
    """Default vad_type produces server_vad with original thresholds unchanged."""
    payload = build_session_payload("sys", None)
    td = payload["session"]["audio"]["input"]["turn_detection"]
    assert td["type"] == "server_vad"
    assert td["threshold"] == 0.5
    assert td["prefix_padding_ms"] == 300
    assert td["silence_duration_ms"] == 500


def test_turn_detection_semantic_vad():
    """vad_type='semantic_vad' produces eagerness instead of numeric VAD thresholds.

    semantic_vad and its eagerness parameter confirmed in the GA Realtime API
    reference (AudioInputTurnDetectionSemanticVad, 2025). eagerness 'auto' == 'medium'.
    """
    payload = build_session_payload("sys", None, vad_type="semantic_vad")
    td = payload["session"]["audio"]["input"]["turn_detection"]
    assert td["type"] == "semantic_vad"
    assert td.get("eagerness") == "auto"
    # server_vad numeric thresholds must NOT bleed into the semantic_vad block
    assert "threshold" not in td
    assert "silence_duration_ms" not in td
    assert "prefix_padding_ms" not in td


def test_voice_fallback():
    """voice_id=None falls back to the default voice constant."""
    from app.services.realtime_relay import OPENAI_REALTIME_DEFAULT_VOICE

    payload = build_session_payload("sys", None)
    voice = payload["session"]["audio"]["output"]["voice"]
    assert voice == OPENAI_REALTIME_DEFAULT_VOICE


def test_voice_override():
    """Explicit voice_id is passed through to audio.output.voice."""
    payload = build_session_payload("sys", "alloy")
    assert payload["session"]["audio"]["output"]["voice"] == "alloy"


def test_custom_tools_replace_defaults():
    """Providing tools replaces DEFAULT_TOOLS in the payload."""
    custom = [{"type": "function", "name": "my_tool", "parameters": {}}]
    payload = build_session_payload("sys", None, custom)
    assert payload["session"]["tools"] == custom


def test_default_tools_used_when_none():
    """tools=None results in DEFAULT_TOOLS being embedded in the payload."""
    from app.services.realtime_relay import DEFAULT_TOOLS

    payload = build_session_payload("sys", None)
    assert payload["session"]["tools"] == DEFAULT_TOOLS
