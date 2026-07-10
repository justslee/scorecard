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


# How many non-`start` frames (e.g. a stray "connected") we'll tolerate
# before giving up on a peer that never sends a valid `start` — bounds how
# long an unauthenticated socket can be held open pre-token-validation.
_MAX_PRE_START_FRAMES = 10


@router.websocket("/api/voice-booking/media-stream")
async def media_stream(websocket: WebSocket) -> None:
    # accept() first so a policy close code is actually deliverable to the peer.
    await websocket.accept()

    if os.getenv("VOICE_BOOKING_ENABLED") != "1":
        # Flag off ⇒ inert even if a stale token somehow existed (it can't —
        # minting requires the flag too — but refuse before touching the
        # registry either way, defense in depth).
        await websocket.close(code=1008)
        return

    # The call_token now travels in the TwiML <Stream><Parameter> — Twilio
    # delivers it inside the `start` event's `customParameters`, NOT in the
    # URL (keeps it out of uvicorn/Twilio access logs). Read frames until we
    # see `start`; relay NO audio before the token is validated.
    #
    # TODO(production hardening, out of scope for this inert slice): also
    # validate Twilio's `X-Twilio-Signature` header on this route.
    start_msg: dict | None = None
    for _ in range(_MAX_PRE_START_FRAMES):
        try:
            msg = await websocket.receive_json()
        except Exception:
            await websocket.close(code=1008)
            return
        event = msg.get("event")
        if event == "start":
            start_msg = msg
            break
        if event in ("stop", "disconnect"):
            await websocket.close(code=1008)
            return
        # "connected" or anything else pre-start — keep waiting, bounded.

    if start_msg is None:
        # Never got a valid `start` within the bound — refuse.
        await websocket.close(code=1008)
        return

    call_token = (start_msg.get("start") or {}).get("customParameters", {}).get("call_token")
    if not call_token:
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
            await run_media_bridge(websocket, openai_ws, pending, initial_start=start_msg)
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
