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
    # Token travels in a <Parameter>, NOT in the wss URL (keeps it out of
    # uvicorn/Twilio access logs).
    assert '<Stream url="wss://api.example.com/api/voice-booking/media-stream"' in xml
    assert "/media-stream/tok123" not in xml  # never in the URL path
    assert '<Parameter name="call_token" value="tok123"/>' in xml
    for secret_marker in ("TWILIO_", "AUTH_TOKEN", "sid", "SID"):
        assert secret_marker not in xml


def test_build_stream_twiml_strips_scheme_and_trailing_slash():
    xml = telephony.build_stream_twiml("https://api.example.com/", "tok123")
    assert 'url="wss://api.example.com/api/voice-booking/media-stream"' in xml
    assert "https://" not in xml


def test_build_stream_twiml_escapes_token_value():
    # Defense in depth: even though tokens are secrets.token_urlsafe output
    # (never XML-special chars), the Parameter value must still be properly
    # escaped/quoted.
    xml = telephony.build_stream_twiml("api.example.com", 'tok"<&>\'')
    assert '<Parameter name="call_token" value=' in xml
    assert "<&>" not in xml  # raw special chars must not appear unescaped
    assert "&amp;" in xml or "&#38;" in xml


# ─── Dial construction / dial-safety ───────────────────────────────────────


class _FakeCall:
    sid = "CA_fake_sid"


class _FakeCallsResource:
    def __init__(self):
        self.create_kwargs: dict | None = None
        self.update_kwargs: dict | None = None
        self.last_update_sid: str | None = None

    def create(self, **kwargs):
        self.create_kwargs = kwargs
        return _FakeCall()

    def __call__(self, sid):
        self.last_update_sid = sid
        return self

    def update(self, **kwargs):
        self.update_kwargs = kwargs
        return None


class _FakeTwilioClient:
    def __init__(self):
        self.calls = _FakeCallsResource()


async def test_place_call_dials_only_ctx_phone():
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


async def test_run_call_cancellation_reraises_and_cleans_up():
    # A cancelled run_call task (e.g. server shutdown while awaiting the
    # pending future) must NOT swallow CancelledError — it must re-raise,
    # after still discarding the token and attempting the hangup.
    client = _FakeTwilioClient()
    registry_ = _CapturingRegistry()
    transport = telephony.LiveCallTransport(
        twilio_client_factory=lambda: client,
        public_host="api.example.com",
        from_number="+15005550006",
        registry_=registry_,
        call_timeout_seconds=5.0,  # long — we cancel before this fires
    )

    task = asyncio.ensure_future(transport.run_call(_ctx()))
    await asyncio.sleep(0.01)
    assert client.calls.create_kwargs is not None
    assert registry_.last_pending is not None

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    # Cleanup still ran: token discarded (single-use consume now fails) and
    # a best-effort hangup was attempted against the call SID.
    assert registry_.consume(registry_.last_token) is None
    assert client.calls.update_kwargs == {"status": "completed"}
    assert client.calls.last_update_sid == "CA_fake_sid"


# ─── CallTokenRegistry ──────────────────────────────────────────────────────


class TestCallTokenRegistry:
    async def test_token_valid_once(self):
        reg = CallTokenRegistry()
        token, pending = reg.mint(_ctx())
        assert reg.consume(token) is pending
        assert reg.consume(token) is None

    async def test_expired_token_refused(self):
        clock = {"t": 0.0}
        reg = CallTokenRegistry(connect_ttl_seconds=10.0, now=lambda: clock["t"])
        token, _pending = reg.mint(_ctx())
        clock["t"] = 10.1
        assert reg.consume(token) is None

    async def test_random_token_refused(self):
        reg = CallTokenRegistry()
        reg.mint(_ctx())
        assert reg.consume("totally-made-up-token") is None

    async def test_token_bound_to_ctx(self):
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
        for var in (
            "TWILIO_ACCOUNT_SID",
            "TWILIO_AUTH_TOKEN",
            "TWILIO_FROM_NUMBER",
            "TWILIO_CLIENT_ID",
            "TWILIO_CLIENT_KEY",
        ):
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


# ─── Twilio credential-name aliases (owner used TWILIO_CLIENT_ID/KEY) ─────────


def _clear_twilio_env(monkeypatch):
    for var in (
        "TWILIO_ACCOUNT_SID",
        "TWILIO_AUTH_TOKEN",
        "TWILIO_FROM_NUMBER",
        "TWILIO_CLIENT_ID",
        "TWILIO_CLIENT_KEY",
    ):
        monkeypatch.delenv(var, raising=False)


def _capture_client_creds(monkeypatch):
    """Monkeypatch twilio.rest.Client so invoking the lazy factory records the
    (account_sid, auth_token) it is constructed with — no network, no real
    Client. Returns a dict that the factory populates when called."""
    import twilio.rest

    captured: dict = {}

    def _fake_client(account_sid, auth_token, *args, **kwargs):
        captured["account_sid"] = account_sid
        captured["auth_token"] = auth_token
        return object()

    monkeypatch.setattr(twilio.rest, "Client", _fake_client)
    return captured


class TestTwilioCredentialAliases:
    def test_alias_only_builds_with_resolved_creds(self, monkeypatch):
        # Owner's real setup: only the CLIENT_ID/CLIENT_KEY aliases are set.
        _clear_twilio_env(monkeypatch)
        monkeypatch.setenv("VOICE_BOOKING_ENABLED", "1")
        monkeypatch.setenv("TWILIO_CLIENT_ID", "AC-alias-sid")
        monkeypatch.setenv("TWILIO_CLIENT_KEY", "alias-tok")
        monkeypatch.setenv("TWILIO_FROM_NUMBER", "+15005550006")
        monkeypatch.setenv("VOICE_BOOKING_PUBLIC_HOST", "api.example.com")

        transport = telephony.get_live_transport()
        assert isinstance(transport, telephony.LiveCallTransport)

        captured = _capture_client_creds(monkeypatch)
        transport._twilio_client_factory()
        assert captured["account_sid"] == "AC-alias-sid"
        assert captured["auth_token"] == "alias-tok"
        assert transport._from_number == "+15005550006"

    def test_standard_names_still_work(self, monkeypatch):
        _clear_twilio_env(monkeypatch)
        monkeypatch.setenv("VOICE_BOOKING_ENABLED", "1")
        monkeypatch.setenv("TWILIO_ACCOUNT_SID", "AC-std-sid")
        monkeypatch.setenv("TWILIO_AUTH_TOKEN", "std-tok")
        monkeypatch.setenv("TWILIO_FROM_NUMBER", "+15005550006")
        monkeypatch.setenv("VOICE_BOOKING_PUBLIC_HOST", "api.example.com")

        transport = telephony.get_live_transport()
        captured = _capture_client_creds(monkeypatch)
        transport._twilio_client_factory()
        assert captured["account_sid"] == "AC-std-sid"
        assert captured["auth_token"] == "std-tok"

    def test_standard_name_wins_over_alias(self, monkeypatch):
        _clear_twilio_env(monkeypatch)
        monkeypatch.setenv("VOICE_BOOKING_ENABLED", "1")
        monkeypatch.setenv("TWILIO_ACCOUNT_SID", "AC-std-sid")
        monkeypatch.setenv("TWILIO_CLIENT_ID", "AC-alias-sid")
        monkeypatch.setenv("TWILIO_AUTH_TOKEN", "std-tok")
        monkeypatch.setenv("TWILIO_CLIENT_KEY", "alias-tok")
        monkeypatch.setenv("TWILIO_FROM_NUMBER", "+15005550006")
        monkeypatch.setenv("VOICE_BOOKING_PUBLIC_HOST", "api.example.com")

        transport = telephony.get_live_transport()
        captured = _capture_client_creds(monkeypatch)
        transport._twilio_client_factory()
        # Standard name wins when both are set.
        assert captured["account_sid"] == "AC-std-sid"
        assert captured["auth_token"] == "std-tok"

    def test_partial_sid_only_still_refused(self, monkeypatch):
        # SID present (via alias) but NO token under either name → refuse.
        _clear_twilio_env(monkeypatch)
        monkeypatch.setenv("VOICE_BOOKING_ENABLED", "1")
        monkeypatch.setenv("TWILIO_CLIENT_ID", "AC-alias-sid")
        monkeypatch.setenv("TWILIO_FROM_NUMBER", "+15005550006")
        monkeypatch.setenv("VOICE_BOOKING_PUBLIC_HOST", "api.example.com")
        with pytest.raises(RuntimeError, match="missing credentials") as exc:
            telephony.get_live_transport()
        # The message names the missing token and BOTH accepted names for it.
        assert "TWILIO_AUTH_TOKEN" in str(exc.value)
        assert "TWILIO_CLIENT_KEY" in str(exc.value)

    def test_missing_message_names_both_accepted_names(self, monkeypatch):
        _clear_twilio_env(monkeypatch)
        monkeypatch.setenv("VOICE_BOOKING_ENABLED", "1")
        with pytest.raises(RuntimeError) as exc:
            telephony.get_live_transport()
        msg = str(exc.value)
        for name in (
            "TWILIO_ACCOUNT_SID",
            "TWILIO_CLIENT_ID",
            "TWILIO_AUTH_TOKEN",
            "TWILIO_CLIENT_KEY",
            "TWILIO_FROM_NUMBER",
        ):
            assert name in msg

    def test_non_ac_prefix_warns_without_leaking_secret(self, monkeypatch, caplog):
        import logging

        _clear_twilio_env(monkeypatch)
        monkeypatch.setenv("VOICE_BOOKING_ENABLED", "1")
        # An API Key SID (SK…) mistakenly supplied as the account SID.
        secret_sid = "SK-super-secret-sid-value"
        secret_tok = "super-secret-auth-token"
        monkeypatch.setenv("TWILIO_CLIENT_ID", secret_sid)
        monkeypatch.setenv("TWILIO_CLIENT_KEY", secret_tok)
        monkeypatch.setenv("TWILIO_FROM_NUMBER", "+15005550006")
        monkeypatch.setenv("VOICE_BOOKING_PUBLIC_HOST", "api.example.com")

        with caplog.at_level(logging.WARNING):
            telephony.get_live_transport()

        warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert any("AC-prefixed" in r.getMessage() for r in warnings)
        # The WARN must never leak the credential value or any part of it.
        full_log = " ".join(r.getMessage() for r in caplog.records)
        assert secret_sid not in full_log
        assert secret_tok not in full_log
        assert "SK-super" not in full_log

    def test_ac_prefix_does_not_warn(self, monkeypatch, caplog):
        import logging

        _clear_twilio_env(monkeypatch)
        monkeypatch.setenv("VOICE_BOOKING_ENABLED", "1")
        monkeypatch.setenv("TWILIO_ACCOUNT_SID", "AC-good-sid")
        monkeypatch.setenv("TWILIO_AUTH_TOKEN", "tok")
        monkeypatch.setenv("TWILIO_FROM_NUMBER", "+15005550006")
        monkeypatch.setenv("VOICE_BOOKING_PUBLIC_HOST", "api.example.com")

        with caplog.at_level(logging.WARNING):
            telephony.get_live_transport()
        assert not any(
            "AC-prefixed" in r.getMessage() for r in caplog.records
        )
