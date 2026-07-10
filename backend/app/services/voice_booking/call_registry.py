"""
Single-use, expiring call-token registry — the ONLY guard on the public
Twilio media-stream WebSocket route (see routes/voice_booking_ws.py).

`LiveCallTransport.run_call` mints a token right before it asks Twilio to
dial; the token is embedded in the TwiML `<Stream>` URL Twilio then connects
back to. `voice_booking_ws.py` consumes (pops) it — unknown, already-consumed,
or expired tokens all return None, so a random guess or a replay can never
reach the bridge.

Single-worker assumption: the in-process dict assumes the same process that
minted the token also receives Twilio's WS connection back. uvicorn's default
(and the current EC2 deploy) is a single worker, which is fine for the
owner-gated rehearsal call. A multi-worker deploy would need a shared store
(e.g. Redis) — out of scope for this slice, noted here for the future.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field
from typing import Callable

from .types import CallOutcome, CallTurn, VoiceBookingContext

# How long the WS has to connect after a token is minted, before it expires
# and the pending call times out honestly (see LiveCallTransport.run_call).
_DEFAULT_CONNECT_TTL_SECONDS = 120.0


@dataclass
class PendingCall:
    """One in-flight outbound call, keyed by its token in the registry."""

    ctx: VoiceBookingContext
    future: "asyncio.Future[tuple[list[CallTurn], CallOutcome]]"
    expires_at: float
    # Live accumulator the bridge appends to as the call proceeds — read back
    # as a PARTIAL transcript if the call times out before the bridge resolves.
    transcript: list[CallTurn] = field(default_factory=list)


class CallTokenRegistry:
    """Mint/consume single-use, unguessable (256-bit) call tokens."""

    def __init__(
        self,
        connect_ttl_seconds: float = _DEFAULT_CONNECT_TTL_SECONDS,
        now: Callable[[], float] = time.monotonic,
    ) -> None:
        self._connect_ttl_seconds = connect_ttl_seconds
        self._now = now
        self._pending: dict[str, PendingCall] = {}

    def _purge_expired(self) -> None:
        deadline = self._now()
        expired = [tok for tok, p in self._pending.items() if p.expires_at <= deadline]
        for tok in expired:
            self._pending.pop(tok, None)

    def mint(self, ctx: VoiceBookingContext) -> tuple[str, PendingCall]:
        """Create a new single-use token bound to `ctx`. Never network I/O."""
        self._purge_expired()
        token = secrets.token_urlsafe(32)  # 256 bits — unguessable
        loop = asyncio.get_event_loop()
        pending = PendingCall(
            ctx=ctx,
            future=loop.create_future(),
            expires_at=self._now() + self._connect_ttl_seconds,
        )
        self._pending[token] = pending
        return token, pending

    def consume(self, token: str) -> PendingCall | None:
        """Pop + return the pending call for `token` — single-use by construction.

        Returns None for an unknown, already-consumed, or expired token. Never
        raises, never echoes anything about WHY a token was refused."""
        self._purge_expired()
        return self._pending.pop(token, None)

    def discard(self, token: str) -> None:
        """Drop a pending call without resolving it (dial failure / timeout
        cleanup) — idempotent, safe to call on an already-consumed token."""
        self._pending.pop(token, None)


# Module-level singleton shared by telephony.py (mint) and voice_booking_ws.py
# (consume). Tests construct their own CallTokenRegistry() instances so they
# never share state with production or with each other.
registry = CallTokenRegistry()
