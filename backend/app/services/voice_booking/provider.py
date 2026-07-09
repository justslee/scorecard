"""
VoiceCallProvider — books a tee time by CALLING the pro shop.

Slots behind the same TeeTimeProvider ABC as every other provider:
  search_availability() → [] (a phone call can't enumerate slots)
  book()                → phone lookup → compliance gates → run the dialog
                          against the supplied transport → BookingResult

The ONLY transport that ships today is the simulator; the live Twilio bridge
(telephony.py) is a stub until the owner-gated launch (TCPA attorney + budget).
Every refusal is a BookingResult — book() never raises at a compliance gate or
a disabled transport, so the route layer stays boring.
"""

from __future__ import annotations

from datetime import datetime

from app.services.tee_times.base import (
    BookingDetails,
    BookingResult,
    TeeTimeProvider,
    TeeTimeQuery,
    TeeTimeSlot,
)

from . import telephony
from .compliance import SuppressionList, check_call_allowed
from .outcome import to_booking_result
from .phone_lookup import lookup_course_phone
from .types import VoiceBookingContext


def _window_end(start: str, hours: int = 2) -> str:
    """"07:00" → "09:00" (capped at 23:59) — the acceptance window end."""
    total = min(int(start[:2]) * 60 + int(start[3:5]) + hours * 60, 23 * 60 + 59)
    return f"{total // 60:02d}:{total % 60:02d}"


class VoiceCallProvider(TeeTimeProvider):
    """Phone-only courses: the agent calls; a human staffer takes payment."""

    def __init__(
        self,
        transport=None,                 # object with async run_call(ctx); simulator today
        phone_lookup=lookup_course_phone,
        verified_lines: set[str] | None = None,
        suppression: SuppressionList | None = None,
        now: datetime | None = None,    # injectable clock for the hours gate
    ) -> None:
        self._transport = transport
        self._phone_lookup = phone_lookup
        # Empty allowlist = every number is refused. Safe by default: the
        # owner populates verified pro-shop landlines before any live call.
        self._verified_lines = verified_lines or set()
        self._suppression = suppression or SuppressionList()
        self._now = now

    @property
    def name(self) -> str:
        return "voice_call"

    async def search_availability(self, query: TeeTimeQuery) -> list[TeeTimeSlot]:
        """Not supported — a phone call can't list availability. Never raises."""
        return []

    async def book(self, slot: TeeTimeSlot, details: BookingDetails) -> BookingResult:
        phone = await self._phone_lookup(slot.course_name, slot.city or None)
        ctx = VoiceBookingContext(
            course_id=slot.course_id,
            course_name=slot.course_name,
            phone=phone,
            golfer_name=details.name,
            callback_number=details.phone or "",
            date=slot.date,
            # A slot time becomes a 2-hour acceptance window — the agent may
            # take a nearby alternative. TODO(S3): routing slots carry
            # time="" (unreachable from _get_provider today, no provider
            # feeds this path) — a future caller must pass the window, not "".
            time_window_start=slot.time,
            time_window_end=_window_end(slot.time),
            party_size=details.party_size,
            max_price_usd=slot.price_usd,
        )

        gate = check_call_allowed(
            ctx,
            verified_lines=self._verified_lines,
            suppression=self._suppression,
            now=self._now,
        )
        if not gate.allowed:
            return BookingResult(
                status="needs_human",
                message=f"Can't place an AI call ({gate.reason}) — "
                f"call {slot.course_name} to book.",
                booking_url=slot.booking_url,
            )

        transport = self._transport
        if transport is None:
            try:
                transport = telephony.get_live_transport()
            except (RuntimeError, NotImplementedError) as exc:
                return BookingResult(
                    status="needs_human",
                    message=f"Voice booking unavailable ({exc}) — "
                    f"call {slot.course_name} to book.",
                    booking_url=slot.booking_url,
                )

        _transcript, call_outcome = await transport.run_call(ctx)
        if call_outcome.opt_out_requested and ctx.phone:
            self._suppression.add(ctx.phone)   # permanent do-not-call (opt-out hook)
        return to_booking_result(call_outcome, ctx)
