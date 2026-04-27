"""Deepgram REST transcription — used for one-shot voice setup + scoring.

For the realtime conversational caddie we use OpenAI Realtime (PR #2). Deepgram
covers the cheaper, structured one-shot path: user holds a button, speaks a
sentence, releases — we POST the audio blob, get a transcript, hand it to
the existing Claude parser pipeline.
"""

import os
from typing import Optional
import httpx
from fastapi import HTTPException


DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")
DEEPGRAM_MODEL = os.getenv("DEEPGRAM_MODEL", "nova-3")
_LISTEN_URL = "https://api.deepgram.com/v1/listen"


async def transcribe_audio(
    audio_bytes: bytes,
    content_type: str,
    *,
    language: str = "en-US",
    keywords: Optional[list[str]] = None,
) -> dict:
    """Send audio bytes to Deepgram Nova-3 and return {transcript, confidence, duration}.

    Raises HTTPException on auth/transport failure or empty results.
    """
    if not DEEPGRAM_API_KEY:
        raise HTTPException(500, "DEEPGRAM_API_KEY not configured")

    params: dict[str, str | list[str]] = {
        "model": DEEPGRAM_MODEL,
        "smart_format": "true",
        "punctuate": "true",
        "language": language,
    }
    if keywords:
        params["keywords"] = keywords

    headers = {
        "Authorization": f"Token {DEEPGRAM_API_KEY}",
        "Content-Type": content_type or "audio/webm",
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(_LISTEN_URL, params=params, headers=headers, content=audio_bytes)

    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, f"Deepgram error: {resp.text}")

    body = resp.json()
    try:
        alt = body["results"]["channels"][0]["alternatives"][0]
    except (KeyError, IndexError):
        raise HTTPException(502, f"Deepgram returned no alternatives: {body}")

    return {
        "transcript": (alt.get("transcript") or "").strip(),
        "confidence": float(alt.get("confidence") or 0.0),
        "duration": float(body.get("metadata", {}).get("duration") or 0.0),
        "model": DEEPGRAM_MODEL,
    }
