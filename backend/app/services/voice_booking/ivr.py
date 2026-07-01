"""
IVR menu detection + navigation heuristics.

Parses automated phone-tree prompts ("For the grill, press 1. For the pro shop,
press 2.") into an IvrMenu and picks the DTMF digit most likely to reach a
human who books tee times. Pure text heuristics — DTMF-ready for the live
telephony bridge, exercised today by the simulator.
"""

from __future__ import annotations

import re

from .types import IvrMenu, IvrOption

# "press 2 for the pro shop" / "press 2 to reach the pro shop"
_PRESS_FOR_RE = re.compile(
    r"press\s+(\d)\s+(?:for|to\s+reach)\s+(?:the\s+)?([^.,;]+)", re.IGNORECASE
)
# "for the pro shop, press 2" / "to reach the pro shop press 2"
_FOR_PRESS_RE = re.compile(
    r"(?:for|to\s+reach)\s+(?:the\s+)?([^.,;]+?),?\s+press\s+(\d)", re.IGNORECASE
)
# "say 'pro shop'" — speech menus; we surface them, choose_option prefers digits.
_SAY_RE = re.compile(r"say\s+['\"]?([a-z][a-z ]{2,30}?)['\"]?(?:[.,;]|$)", re.IGNORECASE)

# What the booking agent is trying to reach, best first. "front desk" and
# "operator" are fallbacks — a human who can transfer beats a dead end.
_GOAL_SYNONYMS: dict[str, list[str]] = {
    "pro_shop": [
        "pro shop", "golf shop", "tee time", "tee times", "reservations",
        "golf reservations", "bookings", "front desk", "operator", "receptionist",
    ],
}


def detect_menu(text: str) -> IvrMenu | None:
    """Return the IvrMenu described by `text`, or None when it isn't an IVR."""
    options: list[IvrOption] = []
    seen: set[str] = set()
    for digit, label in _PRESS_FOR_RE.findall(text):
        if digit not in seen:
            seen.add(digit)
            options.append(IvrOption(digit=digit, label=label.strip().lower()))
    for label, digit in _FOR_PRESS_RE.findall(text):
        if digit not in seen:
            seen.add(digit)
            options.append(IvrOption(digit=digit, label=label.strip().lower()))
    if options:
        return IvrMenu(options=options)
    # Speech-only menu ("say 'pro shop'") — no digits, but still a menu.
    say_labels = [m.strip().lower() for m in _SAY_RE.findall(text)]
    if say_labels and any(
        syn in label for label in say_labels for syn in _GOAL_SYNONYMS["pro_shop"]
    ):
        return IvrMenu(options=[])
    return None


def choose_option(menu: IvrMenu, goal: str = "pro_shop") -> str | None:
    """Pick the DTMF digit for `goal`, best synonym first. None = no match
    (caller should wait — many IVRs route to a human on silence/0)."""
    synonyms = _GOAL_SYNONYMS.get(goal, [])
    for syn in synonyms:
        for opt in menu.options:
            if syn in opt.label:
                return opt.digit
    return None
