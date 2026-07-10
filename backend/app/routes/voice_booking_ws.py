"""
Twilio media-stream WebSocket route — the public leg of the live voice-booking
bridge (specs/teetime-s3b-twilio-bridge-plan.md §5.4).

⚠️ SECURITY-SENSITIVE, DELIBERATELY NOT owner-gated: Twilio's media WebSocket
cannot present the owner's Clerk JWT — Twilio itself connects here, not the
app. The ONLY guard is the single-use, 256-bit, expiring `call_token` bound to
a call THIS SERVER minted seconds earlier (call_registry.py), embedded in the
TwiML `<Stream>` URL that `LiveCallTransport.run_call` hands to Twilio. Every
refusal path below closes the socket WITHOUT ever relaying a single audio
frame, and without echoing the token or a reason back to the peer. Random /
guessed / replayed / expired tokens are indistinguishable from each other from
the caller's point of view — all get the same 1008 close.
"""

from __future__ import annotations

import logging
import os

from fastapi import APIRouter, WebSocket

from app.services.voice_booking.call_registry import registry
from app.services.voice_booking.media_bridge import (
    OPENAI_REALTIME_MODEL_DEFAULT,
    run_media_bridge,
)
from app.services.voice_booking.types import CallOutcome

log = logging.getLogger(__name__)

router = APIRouter()

# Monkeypatchable in tests, exactly like tee_times._rehearsal_transport_factory.
# None (default) means "use _default_openai_ws()" — production never overrides
# this outside of tests.
_openai_ws_factory = None


def _default_openai_ws():
    """Open the server-side OpenAI Realtime WS. The full OPENAI_API_KEY is
    used ONLY in this server-side Authorization header — it never reaches the
    browser or Twilio, and never appears in any URL."""
    import websockets  # lazy import — offline at module import time

    api_key = os.getenv("OPENAI_API_KEY", "")
    model = os.getenv("OPENAI_REALTIME_MODEL", OPENAI_REALTIME_MODEL_DEFAULT)
    return websockets.connect(
        f"wss://api.openai.com/v1/realtime?model={model}",
        additional_headers={"Authorization": f"Bearer {api_key}"},
    )


@router.websocket("/api/voice-booking/media-stream/{call_token}")
async def media_stream(websocket: WebSocket, call_token: str) -> None:
    # accept() first so a policy close code is actually deliverable to the peer.
    await websocket.accept()

    if os.getenv("VOICE_BOOKING_ENABLED") != "1":
        # Flag off ⇒ inert even if a stale token somehow existed (it can't —
        # minting requires the flag too — but refuse before touching the
        # registry either way, defense in depth).
        await websocket.close(code=1008)
        return

    pending = registry.consume(call_token)
    if pending is None:
        # Unknown / already-consumed / expired — never say which. No frames relayed.
        await websocket.close(code=1008)
        return

    factory = _openai_ws_factory or _default_openai_ws
    try:
        async with factory() as openai_ws:
            await run_media_bridge(websocket, openai_ws, pending)
    except Exception as exc:
        log.warning("voice_booking_ws: bridge failed (%s)", type(exc).__name__)
        if not pending.future.done():
            pending.future.set_result(
                (
                    list(pending.transcript),
                    CallOutcome(result="unclear", detail="media bridge failed"),
                )
            )
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
