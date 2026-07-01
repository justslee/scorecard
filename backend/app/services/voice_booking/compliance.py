"""
Compliance gates for outbound AI calls — the plan's legal posture as CODE.

Every gate here maps to a line in specs/tee-time-booking-plan.md §Track B:

  1. Business-landline-only: TCPA artificial-voice rules (FCC 24-17) have NO
     business carve-out for cell numbers, and a number alone can't tell cell
     from landline — so we gate to an OWNER-VERIFIED allowlist of pro-shop
     landlines. Everything else is refused before a call is ever placed.
  2. AI disclosure: the FIRST words spoken to a human are always the disclosure
     ("automated AI assistant on behalf of <user>, callback # <x>, may be
     recorded"). dialog.py enforces the ordering; the line is generated here.
  3. No audio storage: treat every call as all-party recording consent —
     announce, transcribe ephemerally, never store audio (STORE_AUDIO stays
     False; the live telephony bridge must honor it).
  4. Calling hours: 8am–9pm in the COURSE's local time zone.
  5. Suppression: a shop that asks not to be called again is permanently
     suppressed. Honored before every dial.

Pure module: `now` is injectable, the allowlist and suppression list are plain
data — no I/O, fully unit-testable. Lawyer review is still required before any
real call (go-live checklist); these gates are the floor, not the sign-off.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, time
from zoneinfo import ZoneInfo

from .types import VoiceBookingContext

# Posture flag: call audio is NEVER stored. The (future) telephony bridge must
# check this and keep transcription ephemeral. Not a config knob — a constant.
STORE_AUDIO = False

# 8am–9pm local (specs/tee-time-booking-plan.md §Track B item 4).
CALLING_HOURS_START = time(8, 0)
CALLING_HOURS_END = time(21, 0)

_DIGITS_RE = re.compile(r"\D+")


def normalize_phone(phone: str | None) -> str | None:
    """Normalize a phone number to +<digits> for comparisons.

    "+1 (415) 555-0100" → "+14155550100"; bare 10-digit US numbers get +1.
    Returns None for anything that doesn't look like a dialable number.
    """
    if not phone:
        return None
    digits = _DIGITS_RE.sub("", phone)
    if len(digits) == 10:                    # bare US number
        digits = "1" + digits
    if not (11 <= len(digits) <= 15):        # E.164 bounds
        return None
    return "+" + digits


def disclosure_line(ctx: VoiceBookingContext) -> str:
    """The mandatory AI-disclosure opener — ALWAYS the agent's first words to a
    human (pre-complies CA AB 2905 + §64.1200(b) identity; see plan §Track B)."""
    return (
        f"Hi — I'm an automated AI assistant calling on behalf of {ctx.golfer_name} "
        f"to book a tee time. You can reach them directly at {ctx.callback_number}. "
        "This call may be recorded."
    )


def within_calling_hours(tz_name: str, now: datetime | None = None) -> bool:
    """True when the local time at `tz_name` is inside the 8am–9pm window.

    Unknown/invalid time zones fail CLOSED (never call when we can't tell)."""
    try:
        zone = ZoneInfo(tz_name)
    except Exception:
        return False
    local = (now or datetime.now(tz=zone)).astimezone(zone)
    return CALLING_HOURS_START <= local.time() < CALLING_HOURS_END


def is_verified_business_line(phone: str | None, verified_lines: set[str]) -> bool:
    """Gate 1: only owner-confirmed pro-shop landlines may be dialed.

    We cannot distinguish a cell from a landline by the number, so this is an
    allowlist, not a heuristic — anything not explicitly verified is refused."""
    normalized = normalize_phone(phone)
    if normalized is None:
        return False
    verified = {n for n in (normalize_phone(v) for v in verified_lines) if n}
    return normalized in verified


class SuppressionList:
    """Permanent do-not-call list (opt-outs). Numbers are stored normalized."""

    def __init__(self, numbers: set[str] | None = None) -> None:
        self._numbers: set[str] = {
            n for n in (normalize_phone(x) for x in (numbers or set())) if n
        }

    def add(self, phone: str) -> None:
        normalized = normalize_phone(phone)
        if normalized:
            self._numbers.add(normalized)

    def is_suppressed(self, phone: str | None) -> bool:
        normalized = normalize_phone(phone)
        return normalized is not None and normalized in self._numbers


@dataclass
class ComplianceCheck:
    allowed: bool
    reason: str | None = None        # human-readable refusal reason when blocked


def check_call_allowed(
    ctx: VoiceBookingContext,
    *,
    verified_lines: set[str],
    suppression: SuppressionList,
    now: datetime | None = None,
) -> ComplianceCheck:
    """Run every pre-dial gate. A single failure blocks the call (fail closed)."""
    if not ctx.phone:
        return ComplianceCheck(False, "no phone number on file for the course")
    if suppression.is_suppressed(ctx.phone):
        return ComplianceCheck(False, "number is on the do-not-call suppression list")
    if not is_verified_business_line(ctx.phone, verified_lines):
        return ComplianceCheck(
            False,
            "number is not an owner-verified business landline "
            "(AI calls are gated to confirmed pro-shop lines)",
        )
    if not ctx.callback_number.strip():
        return ComplianceCheck(
            False, "a callback number is required for the AI disclosure"
        )
    if not within_calling_hours(ctx.course_tz, now):
        return ComplianceCheck(
            False, "outside 8am–9pm local calling hours at the course"
        )
    return ComplianceCheck(True)
