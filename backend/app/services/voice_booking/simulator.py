"""
Scripted pro-shop-on-the-phone simulator.

Deterministic personas answer the phone and drive BookingDialog end-to-end
with NO telephony — this is how the agent's logic is validated (and demoed to
the owner via POST /api/tee-times/book-by-call/simulate) without placing a
single real call. Same dialog + IVR + outcome code the live bridge will use.

Personas (mode="book"):
  friendly        — pleasant booker, offers a time in-window, confirms with a number
  busy_hold       — puts the agent on hold first, then books
  voicemail       — machine answers → hang up → needs_human
  ivr_first       — phone tree first ("press 2 for the pro shop"), then books
  no_availability — fully booked → failed, nothing invented
  card_required   — insists on a card to hold → agent declines → needs_human
  no_answer       — nobody picks up → needs_human

Availability-ASK personas (mode="availability", S4e):
  lists_three_times  — reads off three times across turns, then signals done
  no_availability_ask — fully booked → outcome "no_availability", zero slots
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

from app.services.tee_times.base import BookingResult

from .dialog import BookingDialog
from .outcome import to_booking_result
from .types import CallOutcome, CallTurn, VoiceBookingContext

# Hard stop for the drive loop — dialog has its own MAX_TURNS safety valve too.
MAX_SIM_TURNS = 24


@dataclass
class _ScriptedPersona:
    """A pro shop with a fixed script: one opening line, then replies in order.

    `opening_line=None` models a call that is never answered; running out of
    scripted replies models the line going dead (dialog → unclear)."""

    opening_line: str | None
    script: list[str] = field(default_factory=list)
    _step: int = 0

    def opening(self) -> str | None:
        return self.opening_line

    def reply(self, _action) -> str | None:
        if self._step >= len(self.script):
            return None
        line = self.script[self._step]
        self._step += 1
        return line


def _friendly() -> _ScriptedPersona:
    return _ScriptedPersona(
        opening_line="Good morning, Presidio golf shop, this is Danny speaking.",
        script=[
            "Sure thing — I can do 7:40 for the four of you, it's $86 per player.",
            "You're all set — confirmation number is PG7402. See you then!",
        ],
    )


def _busy_hold() -> _ScriptedPersona:
    return _ScriptedPersona(
        opening_line="Golf shop — can you hold one moment please?",
        script=[
            "Thanks for waiting — what can I do for you?",
            "Let me look… best I've got is 8:10, $92 for each player.",
            "Done — you're booked. Confirmation number is BH8102.",
        ],
    )


def _voicemail() -> _ScriptedPersona:
    return _ScriptedPersona(
        opening_line=(
            "You've reached the golf shop. We're out on the course — "
            "please leave a message after the tone."
        ),
    )


def _ivr_first() -> _ScriptedPersona:
    return _ScriptedPersona(
        opening_line=(
            "Thank you for calling Presidio Golf Course. For the grill, press 1. "
            "For the pro shop, press 2. For events and weddings, press 3."
        ),
        script=[
            "Pro shop, this is Sam.",
            "I can do 7:50 — that'll be $84 a player.",
            "Great, you're booked. Confirmation number is IV7501.",
        ],
    )


def _no_availability() -> _ScriptedPersona:
    return _ScriptedPersona(
        opening_line="Pro shop, this is Alex.",
        script=[
            "Sorry — we're fully booked that morning, nothing available in that window.",
        ],
    )


def _card_required() -> _ScriptedPersona:
    return _ScriptedPersona(
        opening_line="Golf shop, this is Morgan.",
        script=[
            "I've got 8:20 open, $90 each.",
            "Sure — I'll just need a credit card number to hold that.",
            "Sorry, we can't hold tee times without a card number — course policy.",
        ],
    )


def _no_answer() -> _ScriptedPersona:
    return _ScriptedPersona(opening_line=None)


PERSONAS = {
    "friendly": _friendly,
    "busy_hold": _busy_hold,
    "voicemail": _voicemail,
    "ivr_first": _ivr_first,
    "no_availability": _no_availability,
    "card_required": _card_required,
    "no_answer": _no_answer,
}
PERSONA_NAMES = tuple(PERSONAS.keys())


# ─── Availability-ASK personas (S4e, mode="availability") ──────────────────
# Kept in a SEPARATE registry from the book-mode PERSONAS above: mixing them
# would let an ask-mode script accidentally run through book-mode's dialog
# state machine (or vice versa) via the shared `/book-by-call/simulate`
# endpoint's persona validation. `SimulatedCallTransport` looks each persona
# name up in whichever registry has it (mode-agnostic at the transport layer;
# the DIALOG still branches on `ctx.mode`, which is what actually matters).

def _lists_three_times() -> _ScriptedPersona:
    return _ScriptedPersona(
        opening_line="Good morning, pro shop, this is Jamie.",
        script=[
            "We've got 7:20 open, that's $75 a player.",
            "Also 8:40, same price.",
            "And 9:15 if you want it too.",
            "That's everything we have in that window.",
        ],
    )


def _no_availability_ask() -> _ScriptedPersona:
    return _ScriptedPersona(
        opening_line="Pro shop, this is Casey.",
        script=[
            "Sorry, we're fully booked that day, nothing available in that window.",
        ],
    )


AVAILABILITY_PERSONAS = {
    "lists_three_times": _lists_three_times,
    "no_availability_ask": _no_availability_ask,
}
AVAILABILITY_PERSONA_NAMES = tuple(AVAILABILITY_PERSONAS.keys())


def default_context() -> VoiceBookingContext:
    """A fictional but realistic booking ask (555 numbers are reserved)."""
    return VoiceBookingContext(
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


def availability_context(**overrides) -> VoiceBookingContext:
    """`default_context()` with `mode="availability"` — the fictional
    availability-ASK context used by AVAILABILITY_PERSONAS."""
    return replace(default_context(), mode="availability", **overrides)


@dataclass
class SimulationResult:
    persona: str
    transcript: list[CallTurn]
    outcome: CallOutcome
    booking_result: BookingResult


def _run_persona(
    persona_name: str,
    factory,
    registry_names: tuple[str, ...],
    context: VoiceBookingContext,
) -> SimulationResult:
    """Shared drive loop: feed the persona's opening + scripted replies into a
    fresh BookingDialog(context) until it resolves. `context.mode` decides
    which state-machine branch the dialog runs — the drive loop itself is
    identical for book and availability modes."""
    if factory is None:
        raise ValueError(
            f"unknown persona '{persona_name}' — expected one of {registry_names}"
        )
    persona = factory()
    dialog = BookingDialog(context)

    incoming = persona.opening()
    if incoming is None:
        outcome = CallOutcome(result="no_answer", detail="call was never answered")
        return SimulationResult(
            persona=persona_name,
            transcript=[],
            outcome=outcome,
            booking_result=to_booking_result(outcome, context),
        )

    for _ in range(MAX_SIM_TURNS):
        action = dialog.respond(incoming)
        if dialog.done or action.kind == "hangup":
            break
        nxt = persona.reply(action)
        if nxt is None:
            dialog.abort("line went dead")
            break
        incoming = nxt

    outcome = dialog.finish()
    return SimulationResult(
        persona=persona_name,
        transcript=dialog.transcript,
        outcome=outcome,
        booking_result=to_booking_result(outcome, context),
    )


def run_simulation(
    persona_name: str, ctx: VoiceBookingContext | None = None
) -> SimulationResult:
    """Drive one full simulated BOOK-mode call and return its transcript +
    outcomes. Untouched behavior (S4e is additive)."""
    return _run_persona(
        persona_name, PERSONAS.get(persona_name), PERSONA_NAMES, ctx or default_context()
    )


def run_availability_simulation(
    persona_name: str, ctx: VoiceBookingContext | None = None
) -> SimulationResult:
    """Drive one full simulated AVAILABILITY-ASK call (mode="availability",
    S4e) against `AVAILABILITY_PERSONAS` and return its transcript + outcomes."""
    return _run_persona(
        persona_name,
        AVAILABILITY_PERSONAS.get(persona_name),
        AVAILABILITY_PERSONA_NAMES,
        ctx or availability_context(),
    )


class SimulatedCallTransport:
    """The ONLY call transport that ships today — VoiceCallProvider.book()
    and the S4e availability-call trigger both run the dialog against it. The
    live Twilio transport (telephony.py) is a stub until the owner-gated
    launch.

    `persona` is looked up in whichever registry has it (PERSONAS for
    book-mode names, AVAILABILITY_PERSONAS for ask-mode names) — the
    constructor accepts either, and `run_call` dispatches on `ctx.mode` so a
    caller building this transport doesn't need to know which registry its
    persona lives in."""

    def __init__(self, persona: str = "friendly") -> None:
        if persona not in PERSONAS and persona not in AVAILABILITY_PERSONAS:
            raise ValueError(
                f"unknown persona '{persona}' — expected one of "
                f"{PERSONA_NAMES + AVAILABILITY_PERSONA_NAMES}"
            )
        self.persona = persona

    async def run_call(
        self, ctx: VoiceBookingContext
    ) -> tuple[list[CallTurn], CallOutcome]:
        sim = (
            run_availability_simulation(self.persona, ctx)
            if ctx.mode == "availability"
            else run_simulation(self.persona, ctx)
        )
        return sim.transcript, sim.outcome
