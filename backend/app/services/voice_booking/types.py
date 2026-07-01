"""
Shared data models for the voice booking agent.

Pure dataclasses — no I/O, no framework imports. Everything the dialog state
machine, the compliance gates, the simulator, and the (future) live telephony
bridge exchange lives here. See specs/tee-time-voice-agent.md.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

# The terminal result of a call, mapped onto BookingResult in outcome.py.
#   booked         → the shop confirmed the reservation
#   no_availability→ the shop had nothing in the window / under the ceiling
#   voicemail      → we reached voicemail (never leave the booking on a machine)
#   no_answer      → the line never connected to a human or a machine
#   card_required  → the shop insists on a card to hold; the agent never pays
#   unclear        → conversation didn't resolve (safety valve → needs_human)
CallResult = Literal[
    "booked", "no_availability", "voicemail", "no_answer", "card_required", "unclear"
]

Speaker = Literal["agent", "shop"]


@dataclass
class VoiceBookingContext:
    """Everything the agent needs to place ONE booking call."""

    course_id: str
    course_name: str
    phone: str | None                # E.164-ish pro-shop number (None = unknown)
    golfer_name: str                 # who the reservation is for (disclosure names them)
    callback_number: str             # honest callback # spoken in the disclosure
    date: str                        # YYYY-MM-DD
    time_window_start: str           # "HH:MM" 24h — earliest acceptable
    time_window_end: str             # "HH:MM" 24h — latest acceptable
    party_size: int                  # 1–4
    max_price_usd: float | None = None   # per-player ceiling; None = no ceiling
    holes: int = 18
    course_tz: str = "America/Los_Angeles"  # for the 8am–9pm calling-hours gate


@dataclass
class IvrOption:
    digit: str                       # the DTMF key to press ("0"–"9")
    label: str                       # what the menu says the key reaches


@dataclass
class IvrMenu:
    options: list[IvrOption] = field(default_factory=list)


@dataclass
class CallTurn:
    speaker: Speaker
    text: str                        # spoken words, or "[pressed N]" for DTMF


@dataclass
class CallOutcome:
    """Structured result of a completed (or abandoned) call."""

    result: CallResult
    date: str | None = None          # booked date (YYYY-MM-DD)
    time: str | None = None          # booked time ("HH:MM" 24h)
    party_size: int | None = None
    confirmation_number: str | None = None
    cost_usd: float | None = None    # quoted per-player cost, if stated
    detail: str | None = None        # human-readable note (why it didn't book, etc.)
    opt_out_requested: bool = False  # shop asked not to be called → suppression list
