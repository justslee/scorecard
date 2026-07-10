"""
/api/voice-booking/media-stream/{call_token} route tests —
specs/teetime-s3b-twilio-bridge-plan.md §8.

Uses FastAPI TestClient.websocket_connect against a minimal app carrying
ONLY voice_booking_ws.router (mirrors the real mount: no owner-auth
dependency — the token IS the guard). Never touches real Twilio or OpenAI —
`_openai_ws_factory` is monkeypatched to an in-memory fake, or to an
"exploding" factory that asserts if it's ever called on a refusal path.
"""

from __future__ import annotations

import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routes import voice_booking_ws as ws_route_mod
from app.services.voice_booking.call_registry import registry as call_registry
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


def _exploding_factory():
    raise AssertionError("openai ws factory must NOT be called on this path")


class FakeOpenAIWS:
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


class _FakeOpenAIWSCtx:
    def __init__(self, ws: FakeOpenAIWS):
        self._ws = ws

    async def __aenter__(self) -> FakeOpenAIWS:
        return self._ws

    async def __aexit__(self, *exc) -> bool:
        return False


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(ws_route_mod.router)
    return app


def test_bad_token_refused(monkeypatch):
    monkeypatch.setenv("VOICE_BOOKING_ENABLED", "1")
    monkeypatch.setattr(ws_route_mod, "_openai_ws_factory", _exploding_factory)
    client = TestClient(_app())
    with client.websocket_connect(
        "/api/voice-booking/media-stream/totally-random-guessed-token"
    ) as session:
        msg = session.receive()
        assert msg["type"] == "websocket.close"
        assert msg["code"] == 1008


def test_flag_off_refused(monkeypatch):
    monkeypatch.delenv("VOICE_BOOKING_ENABLED", raising=False)
    monkeypatch.setattr(ws_route_mod, "_openai_ws_factory", _exploding_factory)
    token, pending = call_registry.mint(_ctx())
    client = TestClient(_app())
    with client.websocket_connect(f"/api/voice-booking/media-stream/{token}") as session:
        msg = session.receive()
        assert msg["type"] == "websocket.close"
        assert msg["code"] == 1008
    # Flag-off refuses BEFORE touching the registry — the token is untouched.
    assert call_registry.consume(token) is pending


def test_token_single_use_via_route(monkeypatch):
    monkeypatch.setenv("VOICE_BOOKING_ENABLED", "1")
    token, pending = call_registry.mint(_ctx())
    fake_openai_ws = FakeOpenAIWS([])
    monkeypatch.setattr(
        ws_route_mod, "_openai_ws_factory", lambda: _FakeOpenAIWSCtx(fake_openai_ws)
    )
    client = TestClient(_app())

    with client.websocket_connect(f"/api/voice-booking/media-stream/{token}") as session:
        session.send_json({"event": "connected"})
        session.send_json({"event": "start", "start": {"streamSid": "MZ1"}})
        session.send_json({"event": "stop"})

    assert pending.future.done()

    # Same token again — already consumed → refused, no bridge entered.
    monkeypatch.setattr(ws_route_mod, "_openai_ws_factory", _exploding_factory)
    with client.websocket_connect(f"/api/voice-booking/media-stream/{token}") as session2:
        msg = session2.receive()
        assert msg["type"] == "websocket.close"
        assert msg["code"] == 1008
