"""Verdict-level guide agreement — the read-time gate (§5) and the shared
favor-side extractor the output validator's pin (§6) also uses (specs/
caddie-two-tier-routing-plan.md).

`app.caddie.guide_writer.validate_guide` checks a strategy guide's hazard
NAMING/side/carry grounding at WRITE time; it never checks whether the
guide's strategic FAVOR agrees with the engine's own live verdict. This is
the Red-1 poison class: a guide can correctly name "trees left" (passes
`validate_guide` cleanly) and still advise favoring/aiming LEFT — straight
into the hazard it just named — when the live engine's own recommendation
says the real miss is right, or that there's no good miss at all (center).

Pure, no I/O — shared by `strategy.py::build_strategy_payload` (drops a
disagreeing guide before it ever reaches the brain payload) and `strategy.py
::validate_strategy_text`'s verdict pin (rejects a spoken narrative that
disagrees with the engine, even if the model repeated a poisoned guide
verbatim).
"""

from __future__ import annotations

import re
from typing import Optional

from app.caddie.types import HoleStrategyGuide

# Opposition guard (mirrors guide_writer._SIDE_OPPOSITION_PATTERN's idea): a
# side word introduced by "away from"/"avoid"/"clear of" claims the OPPOSITE
# lateral — "away from the left" is a claim about favoring/missing RIGHT, not
# a claim that the guide favors left.
_OPPOSITION_PATTERNS = [
    re.compile(r"\baway from\s+(?:the\s+)?(left|right)\b"),
    re.compile(r"\bavoid(?:ing)?\s+(?:the\s+)?(left|right)\b"),
    re.compile(r"\bclear of\s+(?:the\s+)?(left|right)\b"),
]

# Direct favor/aim claims: "favor the left", "aim (up the) left", "hug the
# right", "up the left side", "left side is the play", "start it left".
_FAVOR_PATTERNS = [
    re.compile(r"\bfavor(?:ing)?\s+the\s+(left|right)\b"),
    re.compile(r"\baim\s+(?:up the\s+)?(left|right)\b"),
    re.compile(r"\bhug\s+the\s+(left|right)\b"),
    re.compile(r"\bup the\s+(left|right)\s+side\b"),
    re.compile(r"\b(left|right)\s+side is the play\b"),
    re.compile(r"\bstart it\s+(left|right)\b"),
]

# Direct miss claims: "best miss is left", "miss left", "bail (out) left",
# "left is the better/safe miss".
_MISS_PATTERNS = [
    re.compile(r"\bbest miss is\s+(left|right)\b"),
    re.compile(r"\bmiss\s+(left|right)\b"),
    re.compile(r"\bbail(?: out)?\s+(left|right)\b"),
    re.compile(r"\b(left|right)\s+is the (?:better|safe) miss\b"),
]

_DIRECT_PATTERNS = _FAVOR_PATTERNS + _MISS_PATTERNS


def extract_favor_side(text: str) -> Optional[str]:
    """'left' | 'right' | 'conflict' | None — None means no lateral
    favor/miss claim was found. 'conflict' means both laterals were claimed
    (a self-contradicting or genuinely ambiguous text) — fail-closed callers
    treat that the same as an outright disagreement."""
    lowered = (text or "").lower()
    claims: set[str] = set()

    for pattern in _OPPOSITION_PATTERNS:
        for m in pattern.finditer(lowered):
            side = m.group(1)
            claims.add("right" if side == "left" else "left")

    for pattern in _DIRECT_PATTERNS:
        for m in pattern.finditer(lowered):
            claims.add(m.group(1))

    if not claims:
        return None
    if len(claims) > 1:
        return "conflict"
    return next(iter(claims))


def guide_agrees_with_verdict(guide: HoleStrategyGuide, rec: dict) -> bool:
    """True iff the guide's favor/miss claim (scanned over `play_line` +
    `miss_side` — the strategy-bearing fields; `green_notes`/
    `common_mistakes` carry no tee-shot favor and false-reject risk is
    highest there) does not contradict the engine's OWN live verdict.

    `rec` is `recommend_payload`'s dict shape. Engine side =
    `rec['miss_side']['preferred']`:
      - 'left'/'right': no claim -> True; same side -> True; opposite or
        'conflict' -> False (fail-closed on ambiguity — this is the Red-1
        class when the engine says the OTHER lateral).
      - 'center' (no good miss, both sides — the Red-1 incident's own
        engine shape): ANY lateral favor claim -> False; no claim -> True.
      - 'short'/'long' (a green-frame verdict): a lateral guide claim is a
        DIFFERENT frame, not comparable -> True (validate_guide already
        grounded the hazard naming/side itself).
      - `rec` carries an 'error' (no live recommendation to check against)
        -> False, fail-closed: there is no verdict to agree with, so the
        prior notes are not included this turn.
    """
    if not rec or rec.get("error"):
        return False

    miss_side = (rec.get("miss_side") or {}).get("preferred")
    scan_text = f"{guide.play_line} {guide.miss_side}"
    favor = extract_favor_side(scan_text)

    if miss_side in ("left", "right"):
        if favor is None:
            return True
        if favor == "conflict":
            return False
        return favor == miss_side

    if miss_side == "center":
        return favor is None

    # short/long/unknown frame — not comparable to a lateral claim.
    return True
