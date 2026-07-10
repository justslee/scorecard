"""
Caller voice selection — which OpenAI Realtime preset voice the AI pro-shop
caller speaks in.

Context (specs/voice-clone-caller-plan.md §2B/§3): a cloned voice of the
owner's own voice is NOT possible on the OpenAI Realtime live-call path (no
custom voices on Realtime — see the plan). What we CAN do cheaply is pick the
most natural-sounding PRESET voice and let the owner choose among a calm
subset. This module is the single source of truth for that selection — pure,
no I/O, no framework imports (mirrors compliance.py's shape).

`cedar` is the new default (was the hardcoded "sage"): the gpt-realtime voice
catalogue is alloy/ash/ballad/coral/echo/sage/shimmer/verse/marin/cedar; OpenAI
purpose-built marin and cedar for gpt-realtime with superior prosody and
natural pauses/fillers that reduce the synthetic feel. cedar is described as
"natural and conversational" (marin is "professional and clear") — the best
non-robotic choice for an outbound pro-shop call over 8 kHz phone audio.
"""

from __future__ import annotations

import os

# Every real OpenAI Realtime preset voice, as of the gpt-realtime catalogue.
# NEVER pass an arbitrary string to the API — always validate against this set
# first (is_valid_voice / resolve_caller_voice below).
ALLOWED_CALLER_VOICES: frozenset[str] = frozenset(
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

# The natural, non-robotic default — see module docstring for the rationale.
DEFAULT_CALLER_VOICE = "cedar"

# The picker's ordered, calm-natural subset (not the full catalogue — some
# preset voices skew more synthetic/character-y and aren't offered here).
# Each entry is served verbatim by the GET /api/tee-times/caller-voice
# "options" list for the frontend picker.
PICKER_VOICES: list[dict[str, str]] = [
    {"voice": "cedar", "label": "Cedar — natural, conversational (recommended)"},
    {"voice": "marin", "label": "Marin — professional, clear"},
    {"voice": "ash", "label": "Ash — warm, easygoing"},
    {"voice": "ballad", "label": "Ballad — calm, measured"},
    {"voice": "verse", "label": "Verse — friendly, upbeat"},
    {"voice": "sage", "label": "Sage — even, matter-of-fact"},
]


def is_valid_voice(v: str | None) -> bool:
    """True only for a real, allowlisted Realtime voice name."""
    return v is not None and v in ALLOWED_CALLER_VOICES


def resolve_caller_voice(owner_pref: str | None) -> str:
    """Single source of truth for which voice a call uses.

    Precedence: the owner's saved preference (if set AND valid) → the
    OPENAI_REALTIME_DEFAULT_VOICE env var (if valid) → DEFAULT_CALLER_VOICE.
    Never returns anything outside ALLOWED_CALLER_VOICES — an invalid owner
    pref or env value is silently skipped rather than passed to the API.
    """
    if is_valid_voice(owner_pref):
        return owner_pref  # type: ignore[return-value]
    env_voice = os.getenv("OPENAI_REALTIME_DEFAULT_VOICE")
    if is_valid_voice(env_voice):
        return env_voice  # type: ignore[return-value]
    return DEFAULT_CALLER_VOICE
