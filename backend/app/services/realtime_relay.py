"""OpenAI Realtime relay — server-side ephemeral key minting.

The full OPENAI_API_KEY never reaches the browser. The browser hits
POST /api/realtime/session, which returns a 60-second client_secret that the
browser uses to open a WebRTC connection directly to OpenAI.

Tools are listed in the session config; tool calls flow back to the browser via
the WebRTC data channel and are dispatched to FastAPI from there.
"""

import os
from typing import Optional
import httpx
from fastapi import HTTPException

from app.caddie.tools import realtime_tools


OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_REALTIME_MODEL = os.getenv("OPENAI_REALTIME_MODEL", "gpt-realtime")
OPENAI_REALTIME_DEFAULT_VOICE = os.getenv("OPENAI_REALTIME_DEFAULT_VOICE", "sage")

# Transcription model for input audio. Supported values (confirmed against the
# GA Realtime session schema, 2025): "gpt-4o-transcribe", "gpt-4o-mini-transcribe",
# "whisper-1". gpt-4o-transcribe hallucinates far less on silence than whisper-1.
OPENAI_REALTIME_TRANSCRIBE_MODEL = os.getenv(
    "OPENAI_REALTIME_TRANSCRIBE_MODEL", "gpt-4o-transcribe"
)

# VAD type: "server_vad" (default, preserves existing numeric thresholds) or
# "semantic_vad" (uses a semantic classifier + eagerness instead of energy thresholds).
# Confirmed from the GA Realtime API reference (AudioInputTurnDetectionSemanticVad).
OPENAI_REALTIME_VAD = os.getenv("OPENAI_REALTIME_VAD", "server_vad")

# GA Realtime ephemeral-token endpoint. The old /v1/realtime/sessions (beta) was
# removed → OpenAI returns "Invalid URL (POST /v1/realtime/sessions)". The GA
# endpoint returns the client secret at top-level "value"; the browser then
# connects WebRTC at /v1/realtime/calls (see frontend realtime.ts).
_REALTIME_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets"


# ── Tools the model can call. The frontend dispatches these against FastAPI. ──
#
# The schemas live in the canonical registry (app/caddie/tools.py) shared with
# the text mouths' tool loop — parity by construction. This module keeps the
# public DEFAULT_TOOLS name so existing imports (routes/realtime.py, tests)
# work unchanged.

DEFAULT_TOOLS: list[dict] = realtime_tools()


def build_session_payload(
    instructions: str,
    voice_id: Optional[str],
    tools: Optional[list[dict]] = None,
    *,
    model: str = OPENAI_REALTIME_MODEL,
    transcribe_model: str = OPENAI_REALTIME_TRANSCRIBE_MODEL,
    vad_type: str = OPENAI_REALTIME_VAD,
    transcription_prompt: Optional[str] = None,
) -> dict:
    """Build the Realtime session object sent to OpenAI at mint time.

    Extracted as a pure, dependency-free helper so it can be unit-tested
    without a real API key or network call.

    Args:
        instructions:     System instructions for the model.
        voice_id:         Output voice; falls back to OPENAI_REALTIME_DEFAULT_VOICE.
        tools:            Tool list; falls back to DEFAULT_TOOLS when None.
        model:            Realtime model ID (e.g. "gpt-realtime").
        transcribe_model: Input transcription model. Confirmed supported values:
                          "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1".
        vad_type:         "server_vad" (default, energy-based) or "semantic_vad"
                          (semantic classifier; uses eagerness instead of thresholds).
        transcription_prompt: Optional free-text vocabulary/context hint for the
                          transcriber (app/caddie/keyterms.py). Omitted when
                          falsy, so the transcription dict stays exactly
                          {"model", "language"} as before this field existed.

    Returns:
        Full payload dict suitable for POST to /v1/realtime/client_secrets.
    """
    # Turn-detection block. server_vad thresholds are kept exactly as they were
    # (do not adjust them here); semantic_vad swaps to eagerness="auto" which is
    # equivalent to "medium" per the API docs.
    if vad_type == "semantic_vad":
        turn_detection: dict = {
            "type": "semantic_vad",
            # "auto" == "medium" eagerness — balanced responsiveness, no numeric
            # energy thresholds needed (semantic VAD uses a language classifier).
            "eagerness": "auto",
        }
    else:
        # Default: server_vad with original thresholds — do not change.
        turn_detection = {
            "type": "server_vad",
            "threshold": 0.5,
            "prefix_padding_ms": 300,
            "silence_duration_ms": 500,
        }

    # GA session object: audio config nests under audio.input / audio.output;
    # transcription + VAD (barge-in / natural turn-taking) under audio.input;
    # voice under audio.output. Full config is set at mint time.
    #
    # noise_reduction field confirmed at audio.input.noise_reduction in the GA
    # Realtime schema (developers.openai.com client_secrets Python SDK reference,
    # 2025). Allowed types: "near_field" (phone / headset) | "far_field" (laptop).
    # "near_field" is correct for a mobile app where the phone is held to the ear.
    transcription: dict = {"model": transcribe_model, "language": "en"}
    # transcription.prompt confirmed at session.audio.input.transcription.prompt
    # in the GA Realtime API reference (AudioTranscription object, 2025): free
    # text for gpt-4o-transcribe (list-of-keywords semantics for whisper-1; not
    # supported for gpt-realtime-whisper). A hint for the transcriber only —
    # never merged into session.instructions. Omitted when falsy so the dict
    # stays exactly {"model", "language"} as before this field existed.
    if transcription_prompt:
        transcription["prompt"] = transcription_prompt

    return {
        "session": {
            "type": "realtime",
            "model": model,
            "instructions": instructions,
            # GA allows only ["audio"] OR ["text"], not both. "audio" still emits
            # the live transcript (output_audio_transcript events) for the UI.
            "output_modalities": ["audio"],
            "audio": {
                "input": {
                    # Server-side noise suppression applied before VAD and the model.
                    # Reduces false-positive VAD triggers from background noise.
                    "noise_reduction": {"type": "near_field"},
                    # language pinned to English: without it the transcriber
                    # auto-detects per utterance and short/ambient audio lands on
                    # the wrong language (owner repro: a reply chip in Korean).
                    # Owner direction 2026-07-06: default English; a per-user
                    # language setting comes later with onboarding.
                    "transcription": transcription,
                    "turn_detection": turn_detection,
                },
                # speed: brisk on-course delivery (owner ask); realtime
                # supports 0.25-1.5, default 1.0.
                "output": {"voice": voice_id or OPENAI_REALTIME_DEFAULT_VOICE, "speed": 1.15},
            },
            "tools": tools if tools is not None else DEFAULT_TOOLS,
            "tool_choice": "auto",
        },
    }


async def mint_ephemeral_session(
    instructions: str,
    voice_id: Optional[str],
    tools: Optional[list[dict]] = None,
    *,
    transcription_prompt: Optional[str] = None,
) -> dict:
    """Mint a 60s OpenAI Realtime ephemeral session.

    Returns the raw OpenAI response which contains `client_secret` (the value the
    browser uses as the Bearer token when establishing the WebRTC connection).
    """
    if not OPENAI_API_KEY:
        raise HTTPException(500, "OPENAI_API_KEY not configured")

    payload = build_session_payload(
        instructions, voice_id, tools, transcription_prompt=transcription_prompt
    )
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(_REALTIME_CLIENT_SECRETS_URL, headers=headers, json=payload)
    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, f"OpenAI Realtime mint failed: {resp.text}")
    return resp.json()
