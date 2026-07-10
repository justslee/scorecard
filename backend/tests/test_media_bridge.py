"""
run_media_bridge tests — specs/teetime-s3b-twilio-bridge-plan.md §8.

Fakes stand in for the Twilio WebSocket (FastAPI-shaped: receive_json/send_json)
and the OpenAI Realtime WS (websockets-shaped: send(str)/recv()). NEVER a real
socket, NEVER real network — pure asyncio orchestration tests.
"""

from __future__ import annotations

import asyncio
import json

from app.services.voice_booking import compliance
from app.services.voice_booking.call_registry import PendingCall
from app.services.voice_booking.media_bridge import (
    build_call_session_update,
    build_realtime_call_instructions,
    outcome_from_tool_args,
    run_media_bridge,
)
from app.services.voice_booking.types import VoiceBookingContext


def _ctx(**overrides) -> VoiceBookingContext:
    base = dict(
        course_id="presidio",
        course_name="Presidio Golf Course",
        phone="+14155550132",
        golfer_name="Justin",
        callback_number="+14155550199",
        date="2026-07-11",
        time_window_start="07:00",
        time_window_end="10:00",
        party_size=4,
        max_price_usd=100.0,
    )
    base.update(overrides)
    return VoiceBookingContext(**base)


def _pending(ctx: VoiceBookingContext | None = None) -> PendingCall:
    loop = asyncio.get_event_loop()
    return PendingCall(ctx=ctx or _ctx(), future=loop.create_future(), expires_at=1e18)


class FakeTwilioWS:
    """Records outbound `send_json` calls; yields scripted `receive_json` events."""

    def __init__(self, script: list[dict]):
        self._script = list(script)
        self.sent: list[dict] = []

    async def receive_json(self) -> dict:
        if not self._script:
            raise RuntimeError("twilio script exhausted")
        return self._script.pop(0)

    async def send_json(self, data: dict) -> None:
        self.sent.append(data)


class FakeOpenAIWS:
    """Records outbound `send` calls (parsed JSON); yields scripted `recv` events."""

    def __init__(self, script: list[dict]):
        self._script = list(script)
        self.sent: list[dict] = []
        self.closed = False

    async def send(self, data: str) -> None:
        self.sent.append(json.loads(data))

    async def recv(self) -> str:
        if not self._script:
            raise RuntimeError("openai script exhausted")
        return json.dumps(self._script.pop(0))

    async def close(self) -> None:
        self.closed = True


# ─── session.update ─────────────────────────────────────────────────────────


async def test_session_update_sets_ulaw_in_and_out():
    ctx = _ctx()
    payload = build_call_session_update(ctx)
    assert payload["type"] == "session.update"
    session = payload["session"]
    assert session["audio"]["input"]["format"]["type"] == "audio/pcmu"
    assert session["audio"]["output"]["format"]["type"] == "audio/pcmu"
    assert session["instructions"]
    assert any(t["name"] == "record_booking_outcome" for t in session["tools"])


async def test_greeting_forced_before_any_media():
    ctx = _ctx()
    pending = _pending(ctx)
    twilio_ws = FakeTwilioWS(
        [
            {"event": "connected"},
            {"event": "start", "start": {"streamSid": "MZ123"}},
            {"event": "media", "media": {"payload": "AAAA"}},
            {"event": "stop"},
        ]
    )
    openai_ws = FakeOpenAIWS([])  # no server events needed for this assertion

    await run_media_bridge(twilio_ws, openai_ws, pending)

    types_sent = [m.get("type") for m in openai_ws.sent]
    # session.update first, then the forced-greeting pair BEFORE the media append.
    assert types_sent[0] == "session.update"
    create_idx = types_sent.index("conversation.item.create")
    response_idx = types_sent.index("response.create")
    append_idx = types_sent.index("input_audio_buffer.append")
    assert create_idx < append_idx
    assert response_idx < append_idx
    assert create_idx < response_idx


async def test_disclosure_first_content():
    ctx = _ctx()
    pending = _pending(ctx)
    twilio_ws = FakeTwilioWS(
        [
            {"event": "start", "start": {"streamSid": "MZ123"}},
            {"event": "stop"},
        ]
    )
    openai_ws = FakeOpenAIWS([])

    await run_media_bridge(twilio_ws, openai_ws, pending)

    greeting_item = next(
        m for m in openai_ws.sent if m.get("type") == "conversation.item.create"
    )
    text = greeting_item["item"]["content"][0]["text"]
    assert compliance.disclosure_line(ctx) in text

    instructions = build_realtime_call_instructions(ctx)
    assert compliance.disclosure_line(ctx) in instructions
    assert "never provide payment" in instructions.lower() or "never provide" in instructions.lower()
    assert ctx.time_window_start in instructions
    assert ctx.time_window_end in instructions


# ─── Audio forwarding ───────────────────────────────────────────────────────


async def test_twilio_media_forwarded_to_input_audio_buffer():
    ctx = _ctx()
    pending = _pending(ctx)
    twilio_ws = FakeTwilioWS(
        [
            {"event": "start", "start": {"streamSid": "MZ123"}},
            {"event": "media", "media": {"payload": "AAAA"}},
            {"event": "stop"},
        ]
    )
    openai_ws = FakeOpenAIWS([])

    await run_media_bridge(twilio_ws, openai_ws, pending)

    appended = [m for m in openai_ws.sent if m.get("type") == "input_audio_buffer.append"]
    assert len(appended) == 1
    assert appended[0]["audio"] == "AAAA"


async def test_openai_audio_delta_forwarded_with_streamsid():
    ctx = _ctx()
    pending = _pending(ctx)
    twilio_ws = FakeTwilioWS(
        [
            {"event": "start", "start": {"streamSid": "MZ999"}},
            {"event": "stop"},
        ]
    )
    openai_ws = FakeOpenAIWS(
        [
            {"type": "response.output_audio.delta", "delta": "QUJD"},
        ]
    )

    await run_media_bridge(twilio_ws, openai_ws, pending)

    media_sent = [m for m in twilio_ws.sent if m.get("event") == "media"]
    assert len(media_sent) == 1
    assert media_sent[0]["streamSid"] == "MZ999"
    assert media_sent[0]["media"]["payload"] == "QUJD"


# ─── Transcript accumulation ────────────────────────────────────────────────


async def test_transcript_accumulation_both_speakers():
    ctx = _ctx()
    pending = _pending(ctx)
    twilio_ws = FakeTwilioWS(
        [
            {"event": "start", "start": {"streamSid": "MZ1"}},
            {"event": "stop"},
        ]
    )
    openai_ws = FakeOpenAIWS(
        [
            {"type": "response.output_audio_transcript.done", "transcript": "Hi there"},
            {
                "type": "conversation.item.input_audio_transcription.completed",
                "transcript": "Pro shop, how can I help?",
            },
        ]
    )

    await run_media_bridge(twilio_ws, openai_ws, pending)

    assert [(t.speaker, t.text) for t in pending.transcript] == [
        ("agent", "Hi there"),
        ("shop", "Pro shop, how can I help?"),
    ]


# ─── Tool call → outcome ────────────────────────────────────────────────────


async def test_tool_call_resolves_outcome():
    ctx = _ctx()
    pending = _pending(ctx)
    twilio_ws = FakeTwilioWS(
        [
            {"event": "start", "start": {"streamSid": "MZ1"}},
            {"event": "stop"},
        ]
    )
    args = json.dumps(
        {
            "result": "booked",
            "date": "2026-07-11",
            "time": "07:40",
            "party_size": 4,
            "confirmation_number": "PG7402",
            "cost_usd": 86.0,
        }
    )
    openai_ws = FakeOpenAIWS(
        [
            {
                "type": "response.function_call_arguments.done",
                "name": "record_booking_outcome",
                "call_id": "call_1",
                "arguments": args,
            },
        ]
    )

    await run_media_bridge(twilio_ws, openai_ws, pending)

    assert pending.future.done()
    _transcript, outcome = pending.future.result()
    assert outcome.result == "booked"
    assert outcome.confirmation_number == "PG7402"
    assert outcome.cost_usd == 86.0
    # The bridge sends the tool's function_call_output + a follow-up response.create.
    fn_outputs = [
        m for m in openai_ws.sent
        if m.get("type") == "conversation.item.create"
        and m.get("item", {}).get("type") == "function_call_output"
    ]
    assert len(fn_outputs) == 1
    assert fn_outputs[0]["item"]["call_id"] == "call_1"


def test_outcome_from_tool_args_unknown_result_is_unclear():
    outcome = outcome_from_tool_args({"result": "not_a_real_result"})
    assert outcome.result == "unclear"


def test_outcome_from_tool_args_opt_out_roundtrips():
    outcome = outcome_from_tool_args({"result": "unclear", "opt_out_requested": True})
    assert outcome.opt_out_requested is True


def test_outcome_from_tool_args_missing_optionals_are_none():
    outcome = outcome_from_tool_args({"result": "no_availability"})
    assert outcome.date is None
    assert outcome.time is None
    assert outcome.party_size is None
    assert outcome.confirmation_number is None
    assert outcome.cost_usd is None


async def test_no_tool_call_falls_back_to_unclear():
    ctx = _ctx()
    pending = _pending(ctx)
    twilio_ws = FakeTwilioWS(
        [
            {"event": "start", "start": {"streamSid": "MZ1"}},
            {"event": "stop"},
        ]
    )
    openai_ws = FakeOpenAIWS([])

    await run_media_bridge(twilio_ws, openai_ws, pending)

    assert pending.future.done()
    _transcript, outcome = pending.future.result()
    assert outcome.result == "unclear"


async def test_bridge_never_stores_audio_and_closes_openai_ws():
    ctx = _ctx()
    pending = _pending(ctx)
    twilio_ws = FakeTwilioWS([{"event": "start", "start": {"streamSid": "MZ1"}}, {"event": "stop"}])
    openai_ws = FakeOpenAIWS([])
    await run_media_bridge(twilio_ws, openai_ws, pending)
    assert compliance.STORE_AUDIO is False
    assert openai_ws.closed is True
