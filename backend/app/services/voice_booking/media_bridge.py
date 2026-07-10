"""
The Twilio Media Streams ↔ OpenAI Realtime bridge — the OpenAI Realtime model
IS the conversational agent on the live-call path (the deterministic
BookingDialog heuristics are NOT duplicated here; its rules are encoded once
as session instructions below, and its terminal contract — CallOutcome /
CallTurn / outcome.to_booking_result — is reused unchanged).

Wire protocols (confirmed against the Twilio outbound-calls blog, Twilio Media
Streams docs, and this repo's own GA Realtime usage in realtime_relay.py /
frontend/src/lib/voice/realtime.ts — see specs/teetime-s3b-twilio-bridge-plan.md §4):
  - Twilio → us:  {"event": "connected"|"start"|"media"|"stop"|...}
  - us → Twilio:  {"event": "media", "streamSid": ..., "media": {"payload": ...}}
  - OpenAI GA event names ONLY — `audio/pcmu` (not the removed beta
    `g711_ulaw`), `response.output_audio.delta` (not `response.audio.delta`).

NO audio is ever written to disk/DB (compliance.STORE_AUDIO stays False);
transcription is ephemeral text only. Nothing here logs a payload or a secret
— only event TYPES, at debug level.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Protocol

from . import compliance
from .call_registry import PendingCall
from .types import CallOutcome, CallResult, CallTurn, VoiceBookingContext

log = logging.getLogger(__name__)

OPENAI_REALTIME_MODEL_DEFAULT = "gpt-realtime"
OPENAI_REALTIME_TRANSCRIBE_MODEL_DEFAULT = "gpt-4o-transcribe"
OPENAI_REALTIME_DEFAULT_VOICE_DEFAULT = "sage"

_VALID_RESULTS: tuple[CallResult, ...] = (
    "booked",
    "no_availability",
    "voicemail",
    "no_answer",
    "card_required",
    "unclear",
)


# ─── Tool schema (GA Realtime flat shape — matches app/caddie/tools.py) ───────

RECORD_BOOKING_OUTCOME_TOOL: dict[str, Any] = {
    "type": "function",
    "name": "record_booking_outcome",
    "description": (
        "Record the final, structured outcome of this booking call. Call this "
        "EXACTLY ONCE, right before you say goodbye and hang up. Never invent "
        "values you weren't told — leave a field out if the shop didn't say it."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "result": {
                "type": "string",
                "enum": list(_VALID_RESULTS),
                "description": "The terminal result of the call.",
            },
            "date": {"type": "string", "description": "Booked date, YYYY-MM-DD."},
            "time": {"type": "string", "description": "Booked time, HH:MM 24h."},
            "party_size": {"type": "integer"},
            "confirmation_number": {"type": "string"},
            "cost_usd": {"type": "number", "description": "Quoted per-player cost."},
            "detail": {"type": "string", "description": "Short human-readable note."},
            "opt_out_requested": {
                "type": "boolean",
                "description": "True if the shop asked never to be called again.",
            },
        },
        "required": ["result"],
    },
}


# ─── Instructions + session config ─────────────────────────────────────────

def build_realtime_call_instructions(ctx: VoiceBookingContext) -> str:
    """The system instructions for the live call — encodes BookingDialog's
    rules as prose (single source: dialog.py's module docstring) since the
    Realtime model, not BookingDialog, drives this conversation."""
    disclosure = compliance.disclosure_line(ctx)
    price_line = (
        f" Stay at or under ${ctx.max_price_usd:.0f} per player."
        if ctx.max_price_usd is not None
        else ""
    )
    return (
        "You are placing ONE outbound phone call to a golf course pro shop to "
        "book a tee time. Follow these rules exactly:\n\n"
        f"1. Your very FIRST words to whoever answers must be EXACTLY this "
        f'disclosure sentence, verbatim, never paraphrased: "{disclosure}"\n\n'
        f"2. After the disclosure, ask to book a tee time at {ctx.course_name} "
        f"on {ctx.date}, sometime between {ctx.time_window_start} and "
        f"{ctx.time_window_end}, for a party of {ctx.party_size}.{price_line}\n\n"
        "3. NEVER provide payment or any card number over the phone. If a card "
        f"is required to hold the time, offer to hold it under the name "
        f"{ctx.golfer_name} with callback number {ctx.callback_number}. If the "
        "shop insists on a card, end the call politely and record the outcome "
        'as "card_required".\n\n'
        "4. Only accept a time that is inside the requested window and at or "
        "under the price ceiling (if any). If the first offer doesn't fit, ask "
        "once for an alternative; if nothing works, end the call honestly and "
        'record "no_availability".\n\n'
        "5. If you reach voicemail or an answering machine, hang up immediately "
        'and record "voicemail" — never leave the booking request on a machine. '
        'If the shop asks not to be called again, apologize, end the call, and '
        "set opt_out_requested to true.\n\n"
        "6. Before hanging up, ALWAYS call the record_booking_outcome tool "
        "exactly once with the structured result. Keep the call short, be "
        "polite and honest, and never invent information the shop didn't give you."
    )


def build_call_session_update(
    ctx: VoiceBookingContext,
    *,
    model: str = OPENAI_REALTIME_MODEL_DEFAULT,
    transcribe_model: str = OPENAI_REALTIME_TRANSCRIBE_MODEL_DEFAULT,
    voice: str = OPENAI_REALTIME_DEFAULT_VOICE_DEFAULT,
) -> dict[str, Any]:
    """Pure function — the full session.update payload sent to OpenAI FIRST,
    before any audio is forwarded. μ-law both directions (phone audio; both
    Twilio and OpenAI pass it through untranscoded)."""
    return {
        "type": "session.update",
        "session": {
            "type": "realtime",
            "model": model,
            "instructions": build_realtime_call_instructions(ctx),
            "output_modalities": ["audio"],
            "audio": {
                "input": {
                    "format": {"type": "audio/pcmu"},
                    "transcription": {"model": transcribe_model, "language": "en"},
                    "turn_detection": {"type": "server_vad"},
                },
                "output": {
                    "format": {"type": "audio/pcmu"},
                    "voice": voice,
                },
            },
            "tools": [RECORD_BOOKING_OUTCOME_TOOL],
            "tool_choice": "auto",
        },
    }


def outcome_from_tool_args(args: dict[str, Any]) -> CallOutcome:
    """Defensive mapping from the model's tool-call arguments to a CallOutcome.
    Unknown `result` values coerce to "unclear"; extraneous keys are dropped;
    numeric/bool fields are coerced; never raises on malformed input."""
    result = args.get("result")
    if result not in _VALID_RESULTS:
        result = "unclear"

    def _str(key: str) -> str | None:
        val = args.get(key)
        return str(val) if val is not None else None

    party_size = args.get("party_size")
    try:
        party_size = int(party_size) if party_size is not None else None
    except (TypeError, ValueError):
        party_size = None

    cost_usd = args.get("cost_usd")
    try:
        cost_usd = float(cost_usd) if cost_usd is not None else None
    except (TypeError, ValueError):
        cost_usd = None

    return CallOutcome(
        result=result,  # type: ignore[arg-type]
        date=_str("date"),
        time=_str("time"),
        party_size=party_size,
        confirmation_number=_str("confirmation_number"),
        cost_usd=cost_usd,
        detail=_str("detail"),
        opt_out_requested=bool(args.get("opt_out_requested", False)),
    )


# ─── Duck-typed socket protocols (tests pass fakes; real sockets satisfy these) ──

class TwilioWSLike(Protocol):
    async def receive_json(self) -> dict[str, Any]: ...
    async def send_json(self, data: dict[str, Any]) -> None: ...


class OpenAIWSLike(Protocol):
    async def send(self, data: str) -> None: ...
    async def recv(self) -> str: ...


# ─── The bridge loop ────────────────────────────────────────────────────────

async def _forward_twilio_to_openai(
    twilio_ws: TwilioWSLike, openai_ws: OpenAIWSLike, pending: PendingCall, state: dict[str, Any]
) -> None:
    """Consume Twilio events until `stop`/disconnect; forward `media` frames to
    OpenAI untranscoded. Captures streamSid on `start` and — synchronously,
    BEFORE the loop continues to any `media` event — sends the forced,
    disclosure-first greeting (greets-first ordering is guaranteed by doing
    this inline rather than racing a second task)."""
    from starlette.websockets import WebSocketDisconnect

    while True:
        try:
            msg = await twilio_ws.receive_json()
        except WebSocketDisconnect:
            return
        except Exception:
            return

        event = msg.get("event")
        if event == "connected":
            continue
        if event == "start":
            state["stream_sid"] = msg.get("start", {}).get("streamSid")
            await _send_forced_greeting(openai_ws, pending.ctx)
            continue
        if event == "media":
            payload = msg.get("media", {}).get("payload")
            if payload is not None:
                await openai_ws.send(
                    json.dumps({"type": "input_audio_buffer.append", "audio": payload})
                )
            continue
        if event == "stop":
            return
        # "mark" / "dtmf" / anything else — ignore.


async def _send_forced_greeting(openai_ws: OpenAIWSLike, ctx: VoiceBookingContext) -> None:
    """Sent once, immediately after Twilio `start`, BEFORE any caller audio is
    forwarded — makes the model "go first" with the mandatory disclosure."""
    disclosure = compliance.disclosure_line(ctx)
    await openai_ws.send(
        json.dumps(
            {
                "type": "conversation.item.create",
                "item": {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": (
                                "The call has just connected. Speak first. Your "
                                f'first words must be exactly: "{disclosure}" — '
                                "then ask about the tee time."
                            ),
                        }
                    ],
                },
            }
        )
    )
    await openai_ws.send(json.dumps({"type": "response.create"}))


async def _forward_openai_to_twilio(
    twilio_ws: TwilioWSLike,
    openai_ws: OpenAIWSLike,
    pending: PendingCall,
    state: dict[str, Any],
) -> None:
    """Consume OpenAI Realtime server events: forward audio deltas to Twilio,
    accumulate the text transcript, and resolve `state["outcome"]` when the
    model calls record_booking_outcome."""
    while True:
        try:
            raw = await openai_ws.recv()
        except Exception:
            return
        try:
            evt = json.loads(raw)
        except (TypeError, ValueError):
            continue

        evt_type = evt.get("type")
        log.debug("voice_booking: openai event type=%s", evt_type)

        if evt_type == "response.output_audio.delta":
            stream_sid = state.get("stream_sid")
            delta = evt.get("delta")
            if stream_sid and delta:
                await twilio_ws.send_json(
                    {"event": "media", "streamSid": stream_sid, "media": {"payload": delta}}
                )
        elif evt_type == "response.output_audio_transcript.done":
            text = evt.get("transcript") or ""
            if text:
                pending.transcript.append(CallTurn(speaker="agent", text=text))
        elif evt_type == "conversation.item.input_audio_transcription.completed":
            text = evt.get("transcript") or ""
            if text:
                pending.transcript.append(CallTurn(speaker="shop", text=text))
        elif evt_type == "response.function_call_arguments.done":
            if evt.get("name") == "record_booking_outcome":
                try:
                    args = json.loads(evt.get("arguments") or "{}")
                except (TypeError, ValueError):
                    args = {}
                state["outcome"] = outcome_from_tool_args(args)
                call_id = evt.get("call_id")
                await openai_ws.send(
                    json.dumps(
                        {
                            "type": "conversation.item.create",
                            "item": {
                                "type": "function_call_output",
                                "call_id": call_id,
                                "output": json.dumps({"ok": True}),
                            },
                        }
                    )
                )
                await openai_ws.send(json.dumps({"type": "response.create"}))
        elif evt_type == "input_audio_buffer.speech_started":
            # Optional barge-in: flush whatever we already queued to Twilio.
            stream_sid = state.get("stream_sid")
            if stream_sid:
                try:
                    await twilio_ws.send_json({"event": "clear", "streamSid": stream_sid})
                except Exception:
                    pass


async def run_media_bridge(
    twilio_ws: TwilioWSLike, openai_ws: OpenAIWSLike, pending: PendingCall
) -> None:
    """The full bridge for ONE call. Resolves `pending.future` exactly once,
    guarded on `.done()` (the run_call timeout and this bridge can race)."""
    assert compliance.STORE_AUDIO is False  # posture check — never storing audio

    state: dict[str, Any] = {"stream_sid": None, "outcome": None}

    # Session config goes to OpenAI FIRST — before the forwarding loops start.
    await openai_ws.send(json.dumps(build_call_session_update(pending.ctx)))

    tasks = [
        asyncio.ensure_future(
            _forward_twilio_to_openai(twilio_ws, openai_ws, pending, state)
        ),
        asyncio.ensure_future(
            _forward_openai_to_twilio(twilio_ws, openai_ws, pending, state)
        ),
    ]
    try:
        # Either side ending (Twilio "stop"/disconnect, or the OpenAI socket
        # closing) ends the call — don't wait on the other side forever.
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in tasks:
            if not t.done():
                t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

        outcome = state.get("outcome") or CallOutcome(
            result="unclear", detail="call ended without a recorded outcome"
        )
        if not pending.future.done():
            pending.future.set_result((list(pending.transcript), outcome))
        try:
            await openai_ws.close()  # type: ignore[attr-defined]
        except Exception:
            pass
