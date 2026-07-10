"""
Live telephony transport — the Twilio ↔ OpenAI Realtime bridge.

Real outbound calls are still owner-gated: `get_live_transport()` refuses to
construct a `LiveCallTransport` unless VOICE_BOOKING_ENABLED=1, full Twilio
credentials are present, AND a public wss host is configured for Twilio's
media stream to connect back to. The bridge itself (session config, agent
instructions, audio/tool forwarding) lives in media_bridge.py; the public
WebSocket route it connects to is routes/voice_booking_ws.py.

See specs/teetime-s3b-twilio-bridge-plan.md for the full design + the security
invariants this module must never regress:
  - dials ONLY `normalize_phone(ctx.phone)` — never a request value, never None
  - Twilio TwiML carries a host + single-use token only, NEVER credentials
  - construction (get_live_transport) performs ZERO network I/O — the only
    dial happens inside `LiveCallTransport.run_call`
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Callable
from xml.sax.saxutils import quoteattr

from .call_registry import CallTokenRegistry, registry as _default_registry
from .compliance import normalize_phone
from .types import CallOutcome, CallTurn, VoiceBookingContext

log = logging.getLogger(__name__)

_TWILIO_ENV_VARS = ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER")


def build_stream_twiml(public_host: str, call_token: str) -> str:
    """Build the TwiML Twilio plays into the call: bidirectional media stream
    back to our WS route, carrying ONLY the host + single-use token — never a
    secret. `<Connect><Stream>` (not `<Start>`) — bidirectional audio.

    The call token is carried as a `<Parameter>` inside `<Stream>`, NOT in the
    wss URL — Twilio delivers it in the `start` event's `customParameters`
    once the stream connects. This keeps the token out of the wss URL, so it
    never lands in uvicorn/Twilio access logs."""
    host = public_host.strip()
    for prefix in ("https://", "http://", "wss://", "ws://"):
        if host.startswith(prefix):
            host = host[len(prefix) :]
    host = host.rstrip("/")
    url = f"wss://{host}/api/voice-booking/media-stream"
    token_value = quoteattr(call_token)  # returns its own quote characters
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<Response><Connect><Stream "
        f'url="{url}">'
        f'<Parameter name="call_token" value={token_value}/>'
        "</Stream></Connect></Response>"
    )


class LiveCallTransport:
    """Places a real Twilio outbound call and bridges it to an OpenAI Realtime
    session. Same transport interface as SimulatedCallTransport:
    `async run_call(ctx) -> tuple[list[CallTurn], CallOutcome]`."""

    def __init__(
        self,
        *,
        twilio_client_factory: Callable[[], object],
        public_host: str,
        from_number: str,
        registry_: CallTokenRegistry = _default_registry,
        call_timeout_seconds: float = 300.0,
    ) -> None:
        self._twilio_client_factory = twilio_client_factory
        self._public_host = public_host
        self._from_number = from_number
        self._registry = registry_
        self._call_timeout_seconds = call_timeout_seconds

    def _place_call(self, to_number: str, twiml: str) -> str:
        """Sync Twilio REST call — run via asyncio.to_thread. Returns call SID."""
        client = self._twilio_client_factory()
        call = client.calls.create(to=to_number, from_=self._from_number, twiml=twiml)
        return call.sid

    async def run_call(
        self, ctx: VoiceBookingContext
    ) -> tuple[list[CallTurn], CallOutcome]:
        # Dial-safety: the ONLY phone number this transport ever dials is
        # ctx.phone, normalized. No request object is anywhere near this class.
        to_number = normalize_phone(ctx.phone)
        if to_number is None:
            return (
                [],
                CallOutcome(result="unclear", detail="no dialable number — refusing to dial"),
            )

        token, pending = self._registry.mint(ctx)
        twiml = build_stream_twiml(self._public_host, token)

        try:
            call_sid = await asyncio.to_thread(self._place_call, to_number, twiml)
        except Exception as exc:
            # Never log the exception message wholesale (could carry account
            # details in a Twilio error string) — log the type only.
            log.warning("voice_booking: outbound call failed (%s)", type(exc).__name__)
            self._registry.discard(token)
            return (
                [],
                CallOutcome(result="no_answer", detail="outbound call could not be placed"),
            )

        try:
            transcript, outcome = await asyncio.wait_for(
                pending.future, self._call_timeout_seconds
            )
        except asyncio.TimeoutError:
            await self._discard_and_hangup(token, call_sid)
            return (
                list(pending.transcript),
                CallOutcome(result="unclear", detail="call timed out"),
            )
        except asyncio.CancelledError:
            # The task running run_call was itself cancelled (e.g. server
            # shutdown) — clean up the same way as a timeout, but NEVER
            # swallow the cancellation: re-raise so it propagates normally.
            await self._discard_and_hangup(token, call_sid)
            raise

        return transcript, outcome

    async def _discard_and_hangup(self, token: str, call_sid: str) -> None:
        """Shared cleanup for both the timeout and cancellation paths: discard
        the single-use token and best-effort hang up the live call."""
        self._registry.discard(token)
        try:
            client = self._twilio_client_factory()
            await asyncio.to_thread(
                lambda: client.calls(call_sid).update(status="completed")
            )
        except Exception:
            pass  # best-effort hangup — swallow errors


def get_live_transport() -> LiveCallTransport:
    """Return the live call transport, or raise a calm RuntimeError.

    Gating ladder (checked in order):
      1. VOICE_BOOKING_ENABLED != "1"        → RuntimeError("voice booking disabled")
      2. missing any TWILIO_* credential      → RuntimeError("... missing credentials: …")
      3. missing VOICE_BOOKING_PUBLIC_HOST    → RuntimeError("... missing VOICE_BOOKING_PUBLIC_HOST …")
      4. else                                 → construct + return LiveCallTransport
                                                 (construction is network-free —
                                                 the only dial is inside run_call)
    """
    if os.getenv("VOICE_BOOKING_ENABLED") != "1":
        raise RuntimeError("voice booking disabled")
    missing = [v for v in _TWILIO_ENV_VARS if not os.getenv(v)]
    if missing:
        raise RuntimeError(
            f"voice booking disabled — missing credentials: {', '.join(missing)}"
        )
    public_host = os.getenv("VOICE_BOOKING_PUBLIC_HOST")
    if not public_host:
        raise RuntimeError(
            "voice booking disabled — missing VOICE_BOOKING_PUBLIC_HOST (public "
            "TLS host Twilio connects to for the media stream)"
        )

    account_sid = os.getenv("TWILIO_ACCOUNT_SID")
    auth_token = os.getenv("TWILIO_AUTH_TOKEN")
    from_number = os.getenv("TWILIO_FROM_NUMBER")

    def _twilio_client_factory():
        from twilio.rest import Client  # lazy import — offline, no network

        return Client(account_sid, auth_token)

    return LiveCallTransport(
        twilio_client_factory=_twilio_client_factory,
        public_host=public_host,
        from_number=from_number or "",
    )
