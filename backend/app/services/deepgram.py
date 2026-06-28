"""Deepgram REST transcription — used for one-shot voice setup + scoring.

For the realtime conversational caddie we use OpenAI Realtime (PR #2). Deepgram
covers the cheaper, structured one-shot path: user holds a button, speaks a
sentence, releases — we POST the audio blob, get a transcript, hand it to
the existing Claude parser pipeline.

For live interim display during score entry we mint short-lived Deepgram tokens
(grant_live_token) so the browser can open a streaming WebSocket directly —
the API key never leaves the server.
"""

import os
from typing import Optional
import httpx
from fastapi import HTTPException


DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")
DEEPGRAM_MODEL = os.getenv("DEEPGRAM_MODEL", "nova-3")
_LISTEN_URL = "https://api.deepgram.com/v1/listen"
_AUTH_GRANT_URL = "https://api.deepgram.com/v1/auth/grant"


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


async def grant_live_token(*, ttl_seconds: int = 60) -> dict:
    """Mint a short-lived Deepgram access token for browser-side WebSocket use.

    The browser cannot set an Authorization header on a WebSocket — instead it
    passes the token via the 'token' subprotocol. We proxy the token grant from
    our server so the API key stays server-side.

    Returns {access_token, expires_in} on success.
    Raises HTTPException on missing key or Deepgram error.
    """
    if not DEEPGRAM_API_KEY:
        raise HTTPException(500, "DEEPGRAM_API_KEY not configured")

    headers = {
        "Authorization": f"Token {DEEPGRAM_API_KEY}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            _AUTH_GRANT_URL,
            headers=headers,
            json={"ttl_seconds": ttl_seconds},
        )

    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, f"Deepgram token grant error: {resp.text}")

    return resp.json()
