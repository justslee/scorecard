"""OpenAI TTS — spoken caddie replies for the text sheets (specs/voice-tts-sheet-replies).

Mirrors services/deepgram.py's structure (module-level key guard, httpx client,
HTTPException on transport failure). The caddie persona's `voice_id` already
holds OpenAI voice names (ash/sage/verse/fable — see caddie/personalities.py)
and the Realtime orb already speaks in those voices, so this makes the sheet
caddie sound identical to the orb caddie for the same persona.
"""

import logging
import os
from typing import Optional
import httpx
from fastapi import HTTPException


log = logging.getLogger(__name__)

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_TTS_MODEL = os.getenv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts")
_SPEECH_URL = "https://api.openai.com/v1/audio/speech"
# OpenAI's input limit is 4096 chars; sheet replies are 1-3 sentences, so this
# is purely a cost/abuse cap — never expected to bind in normal use.
_MAX_INPUT_CHARS = 4096
_DEFAULT_VOICE = "sage"


async def synthesize_speech(text: str, voice_id: Optional[str]) -> bytes:
    """Synthesize `text` to mp3 bytes via OpenAI TTS.

    Raises HTTPException(500) if OPENAI_API_KEY is not configured, or on any
    OpenAI transport failure (status >= 400). Text is clamped to ~4096 chars
    and empty/whitespace-only input raises a 400 (nothing to say).
    """
    if not OPENAI_API_KEY:
        raise HTTPException(500, "OPENAI_API_KEY not configured")

    clamped = (text or "").strip()[:_MAX_INPUT_CHARS]
    if not clamped:
        raise HTTPException(400, "No text to speak")

    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": OPENAI_TTS_MODEL,
        "voice": voice_id or _DEFAULT_VOICE,
        "input": clamped,
        "response_format": "mp3",
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(_SPEECH_URL, headers=headers, json=payload)

    if resp.status_code >= 400:
        # Log the upstream detail server-side; never mirror the raw OpenAI error
        # body/status to the client (prior secret-echo/str(e)-leak incident).
        log.error("OpenAI TTS upstream error %s: %s", resp.status_code, resp.text)
        raise HTTPException(502, "TTS unavailable")

    return resp.content
