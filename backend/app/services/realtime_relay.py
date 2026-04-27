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


OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_REALTIME_MODEL = os.getenv("OPENAI_REALTIME_MODEL", "gpt-realtime")
OPENAI_REALTIME_DEFAULT_VOICE = os.getenv("OPENAI_REALTIME_DEFAULT_VOICE", "sage")

_REALTIME_SESSIONS_URL = "https://api.openai.com/v1/realtime/sessions"


# ── Tools the model can call. The frontend dispatches these against FastAPI. ──

DEFAULT_TOOLS: list[dict] = [
    {
        "type": "function",
        "name": "get_recommendation",
        "description": (
            "Get a DECADE-style club + aim recommendation for the current shot. "
            "Always call this before suggesting a club, distance, or aim line."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "hole_number": {"type": "integer", "description": "Hole the player is on (1-18)"},
                "distance_yards": {
                    "type": "integer",
                    "description": "Distance to the pin in yards. Omit if unknown — backend will default to hole yardage.",
                },
            },
            "required": ["hole_number"],
        },
    },
    {
        "type": "function",
        "name": "record_shot",
        "description": (
            "Log a shot to the round history once the player has hit it. "
            "Use this when the player tells you what they hit and the result."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "hole_number": {"type": "integer"},
                "club": {"type": "string", "description": "Club used, e.g. '7iron', 'pw', 'driver'."},
                "distance_yards": {"type": "integer", "description": "Approx carry/total distance hit."},
                "result": {
                    "type": "string",
                    "description": "Where it ended up (fairway | rough | green | bunker | water | ob).",
                },
            },
            "required": ["hole_number", "club", "distance_yards"],
        },
    },
    {
        "type": "function",
        "name": "get_session_status",
        "description": "Return the current round's cached state — useful to check what's already known.",
        "parameters": {
            "type": "object",
            "properties": {},
        },
    },
]


async def mint_ephemeral_session(
    instructions: str,
    voice_id: Optional[str],
    tools: Optional[list[dict]] = None,
) -> dict:
    """Mint a 60s OpenAI Realtime ephemeral session.

    Returns the raw OpenAI response which contains `client_secret` (the value the
    browser uses as the Bearer token when establishing the WebRTC connection).
    """
    if not OPENAI_API_KEY:
        raise HTTPException(500, "OPENAI_API_KEY not configured")

    payload: dict = {
        "model": OPENAI_REALTIME_MODEL,
        "voice": voice_id or OPENAI_REALTIME_DEFAULT_VOICE,
        "instructions": instructions,
        "modalities": ["audio", "text"],
        "tools": tools if tools is not None else DEFAULT_TOOLS,
        "tool_choice": "auto",
        # Server-side VAD enables barge-in and natural turn-taking.
        "turn_detection": {
            "type": "server_vad",
            "threshold": 0.5,
            "prefix_padding_ms": 300,
            "silence_duration_ms": 500,
        },
        "input_audio_transcription": {"model": "whisper-1"},
    }
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
        "OpenAI-Beta": "realtime=v1",
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(_REALTIME_SESSIONS_URL, headers=headers, json=payload)
    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, f"OpenAI Realtime mint failed: {resp.text}")
    return resp.json()
