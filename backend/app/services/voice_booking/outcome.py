"""
CallOutcome → BookingResult mapping.

The voice agent's terminal states collapse onto the STABLE BookingResult
status set (confirmed | pending | failed | needs_human | not_supported) that
the routes and UI already understand — never invent a new status.

  booked          → confirmed  (with confirmation number + honest message)
  no_availability → failed     (the shop said no; nothing was booked)
  voicemail       → needs_human (never leave a booking on a machine)
  no_answer       → needs_human
  card_required   → needs_human (the agent never provides payment)
  unclear         → needs_human (safety valve: a human finishes the job)
"""

from __future__ import annotations

from app.services.tee_times.base import BookingResult

from .types import CallOutcome, VoiceBookingContext

# Every CallResult that means "the golfer should call the shop themselves".
_NEEDS_HUMAN_MESSAGES: dict[str, str] = {
    "voicemail": "Reached the pro shop's voicemail — nothing was booked.",
    "no_answer": "The pro shop didn't answer — nothing was booked.",
    "card_required": (
        "The course requires a card to hold the time and the assistant never "
        "provides payment — nothing was booked."
    ),
    "unclear": "The call didn't resolve — nothing was booked.",
}


def to_booking_result(outcome: CallOutcome, ctx: VoiceBookingContext) -> BookingResult:
    """Map a finished call onto the stable BookingResult contract."""
    if outcome.result == "booked":
        when = f"{outcome.date or ctx.date} at {outcome.time or '?'}"
        message = (
            f"Booked by phone: {ctx.course_name}, {when}, "
            f"party of {outcome.party_size or ctx.party_size}."
        )
        if outcome.cost_usd is not None:
            message += f" Quoted ${outcome.cost_usd:.2f} per player."
        return BookingResult(
            status="confirmed",
            confirmation_number=outcome.confirmation_number,
            message=message,
        )

    if outcome.result == "no_availability":
        detail = outcome.detail or "no availability in the requested window"
        return BookingResult(
            status="failed",
            message=f"{ctx.course_name} had {detail} — nothing was booked.",
        )

    # voicemail / no_answer / card_required / unclear → a human finishes it.
    base = _NEEDS_HUMAN_MESSAGES.get(
        outcome.result, "The call didn't resolve — nothing was booked."
    )
    return BookingResult(
        status="needs_human",
        message=f"{base} Call {ctx.course_name}"
        + (f" at {ctx.phone}" if ctx.phone else "")
        + " to book.",
    )
