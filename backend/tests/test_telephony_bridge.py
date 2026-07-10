"""
LiveCallTransport / get_live_transport tests — specs/teetime-s3b-twilio-bridge-plan.md §8.

NO live dial EVER: the Twilio client is always a fake/mock that records calls
instead of placing them. Covers TwiML shape (no secrets), dial-safety (only
ctx.phone is ever dialed), the token registry, and the get_live_transport
gating ladder (disabled → missing creds → missing public host → constructed).
"""

from __future__ import annotations

import asyncio

import pytest

from app.services.voice_booking import telephony
from app.services.voice_booking.call_registry import CallTokenRegistry
from app.services.voice_booking.types import CallTurn, VoiceBookingContext


def _ctx(**overrides) -> VoiceBookingContext:
    base = dict(
        course_id="presidio",
        course_name="Presidio Golf Course",
        phone="+1 415-555-0132",
        golfer_name="Justin",
        callback_number="+1 415-555-0199",
        date="2026-07-11",
        time_window_start="07:00",
        time_window_end="10:00",
        party_size=4,
        max_price_usd=100.0,
    )
    base.update(overrides)
    return VoiceBookingContext(**base)


# ─── build_stream_twiml ─────────────────────────────────────────────────────


def test_build_stream_twiml_shape():
    xml = telephony.build_stream_twiml("api.example.com", "tok123")
    assert "<Connect>" in xml
    assert '<Stream url="wss://api.example.com/api/voice-booking/media-stream/tok123"' in xml
    for secret_marker in ("TWILIO_", "AUTH_TOKEN", "sid", "SID"):
        assert secret_marker not in xml


def test_build_stream_twiml_strips_scheme_and_trailing_slash():
    xml = telephony.build_stream_twiml("https://api.example.com/", "tok123")
    assert "wss://api.example.com/api/voice-booking/media-stream/tok123" in xml
    assert "https://" not in xml


# ─── Dial construction / dial-safety ───────────────────────────────────────


class _FakeCall:
    sid = "CA_fake_sid"


class _FakeCallsResource:
    def __init__(self):
        self.create_kwargs: dict | None = None

    def create(self, **kwargs):
        self.create_kwargs = kwargs
        return _FakeCall()

    def __call__(self, sid):
        return self

    def update(self, **kwargs):
        return None


class _FakeTwilioClient:
    def __init__(self):
        self.calls = _FakeCallsResource()


def test_place_call_dials_only_ctx_phone():
    client = _FakeTwilioClient()
    transport = telephony.LiveCallTransport(
        twilio_client_factory=lambda: client,
        public_host="api.example.com",
        from_number="+15005550006",
        registry_=CallTokenRegistry(),
    )
    token, _pending = transport._registry.mint(_ctx())
    twiml = telephony.build_stream_twiml("api.example.com", token)

    sid = transport._place_call("+14155550132", twiml)

    assert sid == "CA_fake_sid"
    assert client.calls.create_kwargs is not None
    assert client.calls.create_kwargs["to"] == "+14155550132"
    assert client.calls.create_kwargs["from_"] == "+15005550006"
    assert token in client.calls.create_kwargs["twiml"]


async def test_run_call_refuses_unnormalizable_phone():
    client = _FakeTwilioClient()

    def _exploding_factory():
        raise AssertionError("twilio client must NEVER be constructed here")

    transport = telephony.LiveCallTransport(
        twilio_client_factory=_exploding_factory,
        public_host="api.example.com",
        from_number="+15005550006",
        registry_=CallTokenRegistry(),
    )
    transcript, outcome = await transport.run_call(_ctx(phone=None))
    assert transcript == []
    assert outcome.result == "unclear"

    transcript2, outcome2 = await transport.run_call(_ctx(phone="garbage"))
    assert transcript2 == []
    assert outcome2.result == "unclear"
    assert client.calls.create_kwargs is None  # never touched


class _CapturingRegistry(CallTokenRegistry):
    """Records the last minted (token, pending) pair for test inspection,
    without popping it the way `consume()` would."""

    def __init__(self):
        super().__init__()
        self.last_token: str | None = None
        self.last_pending = None

    def mint(self, ctx):
        token, pending = super().mint(ctx)
        self.last_token, self.last_pending = token, pending
        return token, pending


async def test_run_call_timeout_returns_partial_transcript_unclear():
    client = _FakeTwilioClient()
    registry_ = _CapturingRegistry()
    transport = telephony.LiveCallTransport(
        twilio_client_factory=lambda: client,
        public_host="api.example.com",
        from_number="+15005550006",
        registry_=registry_,
        call_timeout_seconds=0.05,
    )

    # Drive run_call in a task so we can peek at the minted pending call and
    # pre-append a transcript turn before the timeout fires. The future is
    # never resolved — this simulates the WS never connecting/resolving.
    task = asyncio.ensure_future(transport.run_call(_ctx()))
    await asyncio.sleep(0.01)
    assert client.calls.create_kwargs is not None
    assert registry_.last_pending is not None
    registry_.last_pending.transcript.append(CallTurn(speaker="shop", text="hello?"))

    transcript, outcome = await task
    assert outcome.result == "unclear"
    assert outcome.detail == "call timed out"
    assert transcript == [CallTurn(speaker="shop", text="hello?")]
    # Token was discarded on timeout — a second consume must fail.
    assert registry_.consume(registry_.last_token) is None


# ─── CallTokenRegistry ──────────────────────────────────────────────────────


class TestCallTokenRegistry:
    def test_token_valid_once(self):
        reg = CallTokenRegistry()
        token, pending = reg.mint(_ctx())
        assert reg.consume(token) is pending
        assert reg.consume(token) is None

    def test_expired_token_refused(self):
        clock = {"t": 0.0}
        reg = CallTokenRegistry(connect_ttl_seconds=10.0, now=lambda: clock["t"])
        token, _pending = reg.mint(_ctx())
        clock["t"] = 10.1
        assert reg.consume(token) is None

    def test_random_token_refused(self):
        reg = CallTokenRegistry()
        reg.mint(_ctx())
        assert reg.consume("totally-made-up-token") is None

    def test_token_bound_to_ctx(self):
        reg = CallTokenRegistry()
        ctx = _ctx(course_name="Bound Course")
        token, _pending = reg.mint(ctx)
        pending = reg.consume(token)
        assert pending is not None
        assert pending.ctx.course_name == "Bound Course"


# ─── get_live_transport gating ──────────────────────────────────────────────


class TestGetLiveTransportGating:
    def test_disabled_by_default(self, monkeypatch):
        monkeypatch.delenv("VOICE_BOOKING_ENABLED", raising=False)
        with pytest.raises(RuntimeError, match="voice booking disabled"):
            telephony.get_live_transport()

    def test_missing_twilio_creds(self, monkeypatch):
        monkeypatch.setenv("VOICE_BOOKING_ENABLED", "1")
        for var in ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"):
            monkeypatch.delenv(var, raising=False)
        with pytest.raises(RuntimeError, match="missing credentials"):
            telephony.get_live_transport()

    def test_missing_public_host_named(self, monkeypatch):
        monkeypatch.setenv("VOICE_BOOKING_ENABLED", "1")
        monkeypatch.setenv("TWILIO_ACCOUNT_SID", "AC-test")
        monkeypatch.setenv("TWILIO_AUTH_TOKEN", "tok-test")
        monkeypatch.setenv("TWILIO_FROM_NUMBER", "+15005550006")
        monkeypatch.delenv("VOICE_BOOKING_PUBLIC_HOST", raising=False)
        with pytest.raises(RuntimeError, match="VOICE_BOOKING_PUBLIC_HOST"):
            telephony.get_live_transport()

    def test_fully_configured_returns_live_transport(self, monkeypatch):
        monkeypatch.setenv("VOICE_BOOKING_ENABLED", "1")
        monkeypatch.setenv("TWILIO_ACCOUNT_SID", "AC-test")
        monkeypatch.setenv("TWILIO_AUTH_TOKEN", "tok-test")
        monkeypatch.setenv("TWILIO_FROM_NUMBER", "+15005550006")
        monkeypatch.setenv("VOICE_BOOKING_PUBLIC_HOST", "api.example.com")
        transport = telephony.get_live_transport()
        assert isinstance(transport, telephony.LiveCallTransport)
        # Construction is network-free: the twilio client factory is a lazy
        # closure, never invoked here, and run_call is never called.
