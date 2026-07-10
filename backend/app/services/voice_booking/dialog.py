"""
The booking conversation state machine: goal → opener → slot negotiation →
confirm → outcome.

BookingDialog is turn-based and PURE: feed it what the shop said, it returns
the agent's next action (say / press a DTMF digit / wait on hold / hang up)
and records the transcript. The simulator drives it today; the live telephony
bridge will drive it the same way (speech-to-text in, text-to-speech out).

Hard rules encoded here (see compliance.py + specs/tee-time-voice-agent.md):
  - The FIRST words spoken to a human are ALWAYS the AI disclosure.
  - The agent NEVER provides payment. If a card is requested it offers to hold
    under the golfer's name + callback; if the shop insists, it ends politely
    and the outcome is card_required (→ needs_human).
  - Alternatives are accepted only inside the requested window and under the
    price ceiling; otherwise it asks once more, then ends honestly.
  - An opt-out request ("take us off your list") ends the call immediately and
    flags the number for the suppression list.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from . import compliance, ivr
from .types import CallOutcome, CallTurn, SpokenSlot, VoiceBookingContext

# Safety valves: a call that hasn't resolved by then ends as `unclear`.
MAX_TURNS = 20
MAX_ASK_ATTEMPTS = 2


@dataclass
class AgentAction:
    kind: Literal["say", "dtmf", "wait", "hangup"]
    text: str | None = None          # for "say"
    digit: str | None = None         # for "dtmf"


# ─── Shop-utterance detectors (deterministic heuristics) ──────────────────────

_VOICEMAIL_PHRASES = (
    "leave a message", "voicemail", "after the tone", "after the beep",
    "not available to take your call", "mailbox", "leave your name and number",
)
_HOLD_PHRASES = (
    "please hold", "hold on", "one moment", "just a moment", "just a sec",
    "be right with you", "bear with me", "hang on",
)
_NO_AVAILABILITY_PHRASES = (
    "fully booked", "booked up", "booked solid", "no availability",
    "nothing available", "sold out", "don't have anything", "no times",
    "nothing open", "all booked",
)
_CARD_PHRASES = (
    "credit card", "card number", "card on file", "card to hold", "debit card",
)
_CONFIRMED_PHRASES = (
    "you're all set", "you are all set", "all set", "you're booked",
    "you are booked", "booked you", "got you down", "confirmation",
    "put you down",
)
_OPT_OUT_PHRASES = (
    "don't call", "do not call", "take us off", "remove this number",
    "stop calling",
)
# mode="availability" only: the shop signals it has read out everything it
# has (distinct from _NO_AVAILABILITY_PHRASES, which means "nothing at all").
_NO_MORE_PHRASES = (
    "that's everything", "that's all we have", "that's all i have",
    "nothing else", "that's it for", "that's the only one", "that's all",
)

_TIME_RE = re.compile(
    r"\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?|\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)",
    re.IGNORECASE,
)
_PRICE_RE = re.compile(r"\$\s*(\d+(?:\.\d{1,2})?)")
_CONFIRMATION_RE = re.compile(
    r"confirmation(?:\s+number)?(?:\s+is)?[:\s#]*([A-Za-z0-9][A-Za-z0-9-]{2,})",
    re.IGNORECASE,
)


def _contains(text: str, phrases: tuple[str, ...]) -> bool:
    lowered = text.lower()
    return any(p in lowered for p in phrases)


def _fmt_12h(hhmm: str) -> str:
    """"07:40" → "7:40 AM" — how the agent speaks times."""
    hour, minute = int(hhmm[:2]), int(hhmm[3:5])
    suffix = "AM" if hour < 12 else "PM"
    display = hour % 12 or 12
    return f"{display}:{minute:02d} {suffix}"


def parse_offered_time(text: str, window_start: str, window_end: str) -> str | None:
    """Extract a spoken tee time as "HH:MM" 24h.

    Ambiguous times without AM/PM ("I have 7:40") are resolved toward the
    requested window: prefer the reading that lands inside it."""
    m = _TIME_RE.search(text)
    if not m:
        return None
    if m.group(1) is not None:
        hour, minute, meridiem = int(m.group(1)), int(m.group(2)), m.group(3)
    else:
        hour, minute, meridiem = int(m.group(4)), 0, m.group(5)
    if hour > 23 or minute > 59:
        return None
    if meridiem:
        low = meridiem.lower().replace(".", "")
        if low == "pm" and hour < 12:
            hour += 12
        elif low == "am" and hour == 12:
            hour = 0
        return f"{hour:02d}:{minute:02d}"
    # No meridiem: pick the reading inside the window, if any.
    as_is = f"{hour:02d}:{minute:02d}"
    if window_start <= as_is <= window_end:
        return as_is
    if hour < 12:
        shifted = f"{hour + 12:02d}:{minute:02d}"
        if window_start <= shifted <= window_end:
            return shifted
    return as_is


def parse_price(text: str) -> float | None:
    m = _PRICE_RE.search(text)
    return float(m.group(1)) if m else None


def parse_confirmation_number(text: str) -> str | None:
    m = _CONFIRMATION_RE.search(text)
    return m.group(1) if m else None


# ─── The state machine ─────────────────────────────────────────────────────────

class BookingDialog:
    """One outbound booking call. Feed shop utterances in, get agent actions out."""

    def __init__(self, ctx: VoiceBookingContext) -> None:
        self.ctx = ctx
        self.state: Literal["connecting", "negotiating", "confirming", "ended"] = (
            "connecting"
        )
        self.transcript: list[CallTurn] = []
        self.outcome: CallOutcome | None = None
        self.opt_out_requested = False
        self._offered_time: str | None = None
        self._offered_price: float | None = None
        self._ask_attempts = 0
        self._card_pushbacks = 0
        self._turns = 0
        # mode="availability" only: every time offered so far, in order.
        self._slots_spoken: list[SpokenSlot] = []

    @property
    def done(self) -> bool:
        return self.state == "ended"

    # ── Public API ────────────────────────────────────────────────────────────

    def respond(self, shop_text: str) -> AgentAction:
        """Process one shop utterance and return the agent's next action."""
        if self.done:
            return AgentAction(kind="hangup")
        self.transcript.append(CallTurn(speaker="shop", text=shop_text))

        self._turns += 1
        if self._turns > MAX_TURNS:
            return self._end("unclear", "call ran too long without resolving")

        # Universal handlers — any state.
        if _contains(shop_text, _VOICEMAIL_PHRASES):
            # Never negotiate with a machine; the golfer gets a needs_human.
            return self._end("voicemail", "reached voicemail", hangup=True)
        if _contains(shop_text, _OPT_OUT_PHRASES):
            self.opt_out_requested = True
            action = self._end(
                "unclear", "shop asked not to be called again",
                farewell="Understood — we won't call this number again. Sorry to bother you.",
            )
            assert self.outcome is not None
            self.outcome.opt_out_requested = True
            return action
        if _contains(shop_text, _HOLD_PHRASES) and self.state != "confirming":
            return AgentAction(kind="wait")

        if self.state == "connecting":
            return self._handle_connecting(shop_text)
        if self.state == "negotiating":
            return self._handle_negotiating(shop_text)
        return self._handle_confirming(shop_text)

    def abort(self, reason: str = "call dropped") -> CallOutcome:
        """Transport-level failure (line went dead, timeout)."""
        if not self.done:
            self.state = "ended"
            self.outcome = CallOutcome(result="unclear", detail=reason)
        assert self.outcome is not None
        return self.outcome

    def finish(self) -> CallOutcome:
        """Final outcome; `unclear` if the call somehow ended without one."""
        if self.outcome is None:
            self.outcome = CallOutcome(result="unclear", detail="call ended unresolved")
            self.state = "ended"
        return self.outcome

    # ── State handlers ────────────────────────────────────────────────────────

    def _handle_connecting(self, shop_text: str) -> AgentAction:
        menu = ivr.detect_menu(shop_text)
        if menu is not None:
            digit = ivr.choose_option(menu, goal="pro_shop")
            if digit is not None:
                self.transcript.append(
                    CallTurn(speaker="agent", text=f"[pressed {digit}]")
                )
                return AgentAction(kind="dtmf", digit=digit)
            # No matching option: stay silent — most IVRs route to a human.
            return AgentAction(kind="wait")

        # A human answered. Disclosure FIRST (compliance), then the ask.
        self.state = "negotiating"
        ctx = self.ctx
        ask = (
            f" Do you have any tee times at {ctx.course_name} on {ctx.date}, "
            f"anytime between {_fmt_12h(ctx.time_window_start)} and "
            f"{_fmt_12h(ctx.time_window_end)}, for a party of {ctx.party_size}?"
            if ctx.mode == "availability"
            else
            f" Could I book a tee time at {ctx.course_name} on {ctx.date}, "
            f"anytime between {_fmt_12h(ctx.time_window_start)} and "
            f"{_fmt_12h(ctx.time_window_end)}, for a party of {ctx.party_size}?"
        )
        opener = compliance.disclosure_line(ctx) + ask
        return self._say(opener)

    def _handle_negotiating(self, shop_text: str) -> AgentAction:
        if self.ctx.mode == "availability":
            return self._handle_negotiating_availability(shop_text)
        ctx = self.ctx
        if _contains(shop_text, _NO_AVAILABILITY_PHRASES):
            return self._end(
                "no_availability", "no availability in the requested window",
                farewell="Understood — thanks for checking. Have a good one!",
            )

        offered = parse_offered_time(
            shop_text, ctx.time_window_start, ctx.time_window_end
        )
        price = parse_price(shop_text)

        if offered is not None:
            in_window = ctx.time_window_start <= offered <= ctx.time_window_end
            over_ceiling = (
                ctx.max_price_usd is not None
                and price is not None
                and price > ctx.max_price_usd
            )
            if in_window and not over_ceiling:
                self._offered_time = offered
                self._offered_price = price
                self.state = "confirming"
                return self._say(
                    f"{_fmt_12h(offered)} works great. Please book it for "
                    f"{ctx.party_size} under the name {ctx.golfer_name}."
                )
            if over_ceiling:
                return self._ask_again(
                    f"That's above their budget of ${ctx.max_price_usd:.0f} per player — "
                    f"anything under that between {_fmt_12h(ctx.time_window_start)} "
                    f"and {_fmt_12h(ctx.time_window_end)}?",
                    fail_detail="nothing under the price ceiling",
                )
            return self._ask_again(
                f"They need something between {_fmt_12h(ctx.time_window_start)} and "
                f"{_fmt_12h(ctx.time_window_end)} — anything in that window?",
                fail_detail="no offered time inside the requested window",
            )

        # No time in the utterance (e.g. "for how many?" / "what name?") —
        # restate the essentials once or twice, then end honestly.
        return self._ask_again(
            f"It's for {ctx.golfer_name}, {ctx.party_size} players, on {ctx.date}, "
            f"between {_fmt_12h(ctx.time_window_start)} and "
            f"{_fmt_12h(ctx.time_window_end)}.",
            fail_detail="conversation did not converge on a time",
            fail_result="unclear",
        )

    def _handle_negotiating_availability(self, shop_text: str) -> AgentAction:
        """mode="availability": collect EVERY offered time in the window —
        never confirm/hold one. Ends on an explicit "that's everything"
        signal, an explicit "nothing at all" signal, or after
        MAX_ASK_ATTEMPTS unproductive prompts (the same bounded-retry shape
        as book mode's `_ask_again`)."""
        ctx = self.ctx

        if _contains(shop_text, _NO_MORE_PHRASES) or (
            _contains(shop_text, _NO_AVAILABILITY_PHRASES) and self._slots_spoken
        ):
            return self._end_availability(
                farewell="Great, thank you so much for checking!"
            )
        if _contains(shop_text, _NO_AVAILABILITY_PHRASES):
            return self._end(
                "no_availability", "no availability in the requested window",
                farewell="Understood — thanks for checking. Have a good one!",
            )

        offered = parse_offered_time(
            shop_text, ctx.time_window_start, ctx.time_window_end
        )
        price = parse_price(shop_text)

        if offered is not None and ctx.time_window_start <= offered <= ctx.time_window_end:
            self._slots_spoken.append(SpokenSlot(time=offered, price_usd=price))
            self._ask_attempts = 0   # a real answer resets the bounded-retry count
            priced = f" for ${price:.0f}" if price is not None else ""
            return self._say(
                f"Got it — {_fmt_12h(offered)}{priced}. "
                "Do you have anything else in that window?"
            )

        self._ask_attempts += 1
        if self._ask_attempts > MAX_ASK_ATTEMPTS:
            return self._end_availability(
                farewell="Alright — thanks so much for checking!"
            )
        return self._say(
            f"Just to confirm, I'm looking for anything between "
            f"{_fmt_12h(ctx.time_window_start)} and {_fmt_12h(ctx.time_window_end)} "
            f"on {ctx.date}, for {ctx.party_size} players."
        )

    def _end_availability(self, farewell: str | None = None) -> AgentAction:
        self.state = "ended"
        self.outcome = CallOutcome(
            result="availability",
            date=self.ctx.date,
            party_size=self.ctx.party_size,
            slots_spoken=list(self._slots_spoken),
            detail=(
                f"{len(self._slots_spoken)} time(s) offered" if self._slots_spoken
                else "no times offered"
            ),
        )
        if farewell is None:
            return AgentAction(kind="hangup")
        return self._say(farewell)

    def _handle_confirming(self, shop_text: str) -> AgentAction:
        ctx = self.ctx
        if _contains(shop_text, _CARD_PHRASES):
            # The agent NEVER provides payment (epic plan §Track B).
            self._card_pushbacks += 1
            if self._card_pushbacks == 1:
                return self._say(
                    f"I'm not able to provide payment over the phone — "
                    f"{ctx.golfer_name} will handle that directly. Could you hold "
                    f"the time under their name? Their number is {ctx.callback_number}."
                )
            return self._end(
                "card_required", "course requires a card to hold the time",
                farewell=(
                    f"No problem — {ctx.golfer_name} will call back to finish the "
                    "booking. Thanks for your help!"
                ),
            )

        if _contains(shop_text, _CONFIRMED_PHRASES):
            confirmation = parse_confirmation_number(shop_text)
            price = self._offered_price or parse_price(shop_text)
            self.outcome = CallOutcome(
                result="booked",
                date=ctx.date,
                time=self._offered_time,
                party_size=ctx.party_size,
                confirmation_number=confirmation,
                cost_usd=price,
            )
            readback = (
                f"Perfect — that's {ctx.party_size} players at "
                f"{_fmt_12h(self._offered_time or ctx.time_window_start)} on {ctx.date}"
            )
            if confirmation:
                readback += f", confirmation number {confirmation}"
            readback += ". Thank you so much!"
            self.state = "ended"
            return self._say(readback)

        if _contains(shop_text, _NO_AVAILABILITY_PHRASES):
            return self._end(
                "no_availability", "the time fell through at booking",
                farewell="Understood — thanks anyway. Have a good one!",
            )

        # Shop asked something else ("spell the name?") — restate, bounded.
        return self._ask_again(
            f"The name is {ctx.golfer_name}, party of {ctx.party_size}, and their "
            f"callback number is {ctx.callback_number}.",
            fail_detail="confirmation never arrived",
            fail_result="unclear",
        )

    # ── Internals ─────────────────────────────────────────────────────────────

    def _say(self, text: str) -> AgentAction:
        self.transcript.append(CallTurn(speaker="agent", text=text))
        return AgentAction(kind="say", text=text)

    def _ask_again(
        self,
        text: str,
        *,
        fail_detail: str,
        fail_result: str = "no_availability",
    ) -> AgentAction:
        self._ask_attempts += 1
        if self._ask_attempts > MAX_ASK_ATTEMPTS:
            return self._end(
                fail_result,  # type: ignore[arg-type]
                fail_detail,
                farewell="Alright — thanks for your time. Have a good one!",
            )
        return self._say(text)

    def _end(
        self,
        result: str,
        detail: str,
        *,
        farewell: str | None = None,
        hangup: bool = False,
    ) -> AgentAction:
        self.state = "ended"
        self.outcome = CallOutcome(result=result, detail=detail)  # type: ignore[arg-type]
        if hangup or farewell is None:
            return AgentAction(kind="hangup")
        return self._say(farewell)
