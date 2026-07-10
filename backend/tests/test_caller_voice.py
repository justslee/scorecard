"""
caller_voice.py tests — the AI pro-shop caller's preset-voice selection.

Pure module, no I/O beyond os.getenv — covers the allowlist, is_valid_voice,
and the resolve_caller_voice precedence (owner-pref → env → default).
specs/voice-clone-caller-plan.md §2B/§3.
"""

from __future__ import annotations

from app.services.voice_booking.caller_voice import (
    ALLOWED_CALLER_VOICES,
    DEFAULT_CALLER_VOICE,
    PICKER_VOICES,
    is_valid_voice,
    resolve_caller_voice,
)


def test_default_caller_voice_is_cedar():
    assert DEFAULT_CALLER_VOICE == "cedar"


def test_allowed_caller_voices_matches_the_realtime_catalogue():
    assert ALLOWED_CALLER_VOICES == frozenset(
        {
            "alloy",
            "ash",
            "ballad",
            "cedar",
            "coral",
            "echo",
            "marin",
            "sage",
            "shimmer",
            "verse",
        }
    )


def test_picker_voices_are_all_allowlisted_and_cedar_is_first():
    assert len(PICKER_VOICES) == 6
    voices = [v["voice"] for v in PICKER_VOICES]
    assert voices[0] == "cedar"
    for v in voices:
        assert v in ALLOWED_CALLER_VOICES
        assert is_valid_voice(v)


def test_is_valid_voice():
    assert is_valid_voice("cedar") is True
    assert is_valid_voice("marin") is True
    assert is_valid_voice("nova") is False        # not a real Realtime voice
    assert is_valid_voice("") is False
    assert is_valid_voice(None) is False


class TestResolveCallerVoicePrecedence:
    def test_valid_owner_pref_wins(self, monkeypatch):
        monkeypatch.setenv("OPENAI_REALTIME_DEFAULT_VOICE", "ash")
        assert resolve_caller_voice("marin") == "marin"

    def test_invalid_owner_pref_falls_to_env(self, monkeypatch):
        monkeypatch.setenv("OPENAI_REALTIME_DEFAULT_VOICE", "ash")
        assert resolve_caller_voice("not-a-real-voice") == "ash"

    def test_no_owner_pref_uses_valid_env(self, monkeypatch):
        monkeypatch.setenv("OPENAI_REALTIME_DEFAULT_VOICE", "verse")
        assert resolve_caller_voice(None) == "verse"

    def test_invalid_env_falls_to_default(self, monkeypatch):
        monkeypatch.setenv("OPENAI_REALTIME_DEFAULT_VOICE", "not-a-real-voice")
        assert resolve_caller_voice(None) == DEFAULT_CALLER_VOICE
        assert resolve_caller_voice("also-not-real") == DEFAULT_CALLER_VOICE

    def test_nothing_set_falls_to_default(self, monkeypatch):
        monkeypatch.delenv("OPENAI_REALTIME_DEFAULT_VOICE", raising=False)
        assert resolve_caller_voice(None) == DEFAULT_CALLER_VOICE
