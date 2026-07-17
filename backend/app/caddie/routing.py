"""Deterministic intent router — the structural crux of specs/caddie-two-tier
-routing-plan.md.

Owner directive (2026-07-17): "if it is EASILY answerable by notes, we can
use a weaker model, but in general the brain should be a more advanced model
... That routing is the crux of what we are trying to build." Extended the
same day: "the caddie component is ALL encompassing ... it should route the
request to different parts of my backend that can handle serving the
request."

`classify_intent` is pure (no I/O, no app imports beyond stdlib) and
deterministic: an ordered set of word-boundary regex checks over the
lowercased transcript. Two consumers call it:

  - The text mouth (`routes/caddie.py::session_voice` / `.../voice/stream`)
    runs it BEFORE the Claude loop — ADVICE never reaches Claude, it routes
    straight to the one brain (`app.caddie.strategy_turn.run_strategy_turn`).
  - The realtime mouth does NOT call this function directly — the speech
    model self-routes to the `get_strategy` tool via the strengthened
    `STRATEGY_TOOL_RULE` (voice_prompts.py) — but the SAME 20-row matrix this
    module encodes is what that prompt contract is held to (see
    tests/test_intent_routing.py and the live routing probes).

Extensibility (proved, not built — plan §1): a future intent is ONE new
`Intent` member + one predicate registered in `_RULES` below + one dispatch
arm in the two consumers. `classify_intent` itself never changes — see
`test_intent_enum_is_extensible_without_dispatch_rewrite`. Reserved names for
future routing classes: `TEE_TIME`, `COURSE_SEARCH`, `NAVIGATION`.
"""

from __future__ import annotations

import re
from enum import Enum
from typing import Callable


class Intent(str, Enum):
    ADVICE = "advice"  # judgment: club choice, how to play, miss/bail, risk-reward, layup
    FACT = "fact"       # numbers/readouts: distances, carries, wind, green, score status
    SCORE = "score"     # scorecard entry: "I made a 5", "put me down for…", "par for Mike"
    OTHER = "other"     # chit-chat, repeats, unclassifiable -> fast path


def _compile(*patterns: str) -> list["re.Pattern[str]"]:
    return [re.compile(p) for p in patterns]


# ── SCORE (checked first — most specific) ───────────────────────────────────

# Pinned discriminator (row 7 of the matrix): "what do I need to shoot par on
# the back nine" reads like a score utterance (shoot/par/need) but is a FACT
# question about a target, not a statement of a strokes-taken score. Checked
# BEFORE the SCORE predicates — a match here skips SCORE entirely and falls
# through to ADVICE/FACT.
_SCORE_EXCLUSION_PATTERN = re.compile(
    r"\bneed to (shoot|make|score)\b|\bwhat (do|would) i need\b"
)

# "par/birdie/bogey ... for <name>" — the multi-player score-entry shape
# ("put me down for a 5, par for Mike", "bogey for me").
_SCORE_FOR_PATTERN = re.compile(
    r"\b(par|birdie|bogey|double(?:\s+bogey)?|eagle|triple)\s+for\s+\w+"
)
# First-person past-tense/imperative score statements.
_SCORE_PERSON_PATTERN = re.compile(
    r"\bi\s+(made|had|got|shot|took)\b|\bput me down\b|\bgive me a\b|\bmark (me|him|her|\w+)\b"
)
# A stroke word or a bare number — required alongside a SCORE_PERSON match
# (a person-pattern alone, e.g. "I took a look", isn't a score).
_SCORE_STROKE_PATTERN = re.compile(
    r"\b(par|birdie|bogey|double(?:\s+bogey)?|eagle|triple|\d{1,2})\b"
)

# Putts guard (eng-lead review fold-in): "I had 3 putts" matches SCORE_PERSON
# ("i had") + SCORE_STROKE (bare "3") but is a PUTTING-STATS statement, not a
# hole score — writing it to record_scores would put the wrong number on the
# card. A bare stroke number co-occurring with "putt(s)" only counts as a
# real hole score when paired with an explicit hole-score verb (made/shot/
# scored); "had"/"got"/"took"/"put me down"/etc alone never do.
_PUTTS_PATTERN = re.compile(r"\bputts?\b")
_HOLE_SCORE_VERB_PATTERN = re.compile(r"\b(made|shot|scored)\b")
# The "<count> putts" phrase itself ("3 putts", "two putts", "a putt"). Used to
# NARROW the guard (delta review 2026-07-17): the guard must suppress only a
# pure putting-stats statement, never a real score stated in the same breath as
# putts ("I had a 5, two putts" is still a 5). We strip the putts phrase and, if
# a DISTINCT hole-score number/word survives outside it, treat it as a score.
_PUTTS_PHRASE_PATTERN = re.compile(
    r"\b(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|a|an|couple|few)"
    r"\s+putts?\b|\bputts?\b"
)


def _is_score(text: str) -> bool:
    if _SCORE_EXCLUSION_PATTERN.search(text):
        return False
    if _SCORE_FOR_PATTERN.search(text):
        return True
    if _SCORE_PERSON_PATTERN.search(text) and _SCORE_STROKE_PATTERN.search(text):
        if _PUTTS_PATTERN.search(text) and not _HOLE_SCORE_VERB_PATTERN.search(text):
            # Putting-stats statement — suppress UNLESS a distinct hole-score
            # number/word survives after removing the "<count> putts" phrase
            # ("I had a 5, two putts" keeps the 5; "I had 3 putts" does not).
            remainder = _PUTTS_PHRASE_PATTERN.sub(" ", text)
            if not _SCORE_STROKE_PATTERN.search(remainder):
                return False
        return True
    return False


# ── ADVICE (checked second — fail-toward-advice) ────────────────────────────

# Club-vs-club phrasing ("driver or 3-wood here?") — two club mentions joined
# by "or" anywhere in the sentence.
_CLUB_WORD = r"(?:driver|(?:\d\s*-?\s*)?wood|hybrid|(?:\d\s*-?\s*)?iron|wedge|pw|gw|sw|lw)"
_CLUB_VS_CLUB_PATTERN = re.compile(rf"\b{_CLUB_WORD}\b[^.?!]*\bor\b[^.?!]*\b{_CLUB_WORD}\b")

# A single club name + "here" ("driver here?", "3-wood here") — an implicit
# club-choice question, no "should"/"or" needed.
_CLUB_HERE_PATTERN = re.compile(rf"\b{_CLUB_WORD}\b\s+here\b")

_ADVICE_PATTERNS = _compile(
    r"\bwhat should i (hit|play|do)\b",
    r"\b(which|what) club\b",
    r"\bhow (do|should) i play\b",
    # Broadened (eng-lead review fold-in) to allow one adjective between "the"
    # and "play" — "what's the smart play" reads exactly like "what's the
    # play" (row 15 of the matrix) but the original contiguous pattern missed it.
    r"\bwhat'?s the (?:\w+ )?play\b",
    r"\bwalk me through\b",
    r"\bwhere('?s| is| should)? (the |my )?(miss|bail|bailout)\b",
    r"\bwhich side (do|should) i (bail|miss)\b",
    r"\bshould i (go for|take on|lay ?up|challenge)\b",
    r"\bcan i (take on|carry the corner|get there|go for)\b",
    r"\blay ?up\b",
    r"\brisk\b",
    r"\baim\b",
    r"\bfavor\b",
    # Terse on-course forms (eng-lead review fold-in) — common short asks
    # that were falling through to OTHER/Claude instead of the brain.
    r"\bgo for it\b",
    r"\bsend it\b",
    r"\bleft or right\b",
    r"\bbite off\b",
)
_ADVICE_PATTERNS.append(_CLUB_VS_CLUB_PATTERN)
_ADVICE_PATTERNS.append(_CLUB_HERE_PATTERN)


def _is_advice(text: str) -> bool:
    return any(p.search(text) for p in _ADVICE_PATTERNS)


# ── FACT (checked third) ─────────────────────────────────────────────────

_FACT_PATTERNS = _compile(
    r"\bhow (far|deep)\b",
    r"\bdistance\b",
    r"\b(what'?s|what is|how'?s|how is)\s+the\s+(carry|number|wind|front|back|middle)\b",
    r"\bplays?\s+like\b",
    r"\bgreen (depth|read|break)\b",
    r"\bwhat do i need to shoot\b",
    r"\bwhere do i stand\b",
    r"\bwhat'?s my score\b|\bwhat is my score\b",
)


def _is_fact(text: str) -> bool:
    return any(p.search(text) for p in _FACT_PATTERNS)


# ── The seam — an ordered (value, predicate) list, not a chain of `if`s ─────
#
# `classify_intent` below just walks this list and returns the first
# predicate's value that matches — it never special-cases `Intent` members.
# Registering a new routing class is exactly: define a predicate, append
# `(NewIntent.X, predicate)` here, add one dispatch arm in each consumer.
# `test_intent_enum_is_extensible_without_dispatch_rewrite` proves this by
# monkeypatching a new rule onto this list and calling `classify_intent`
# unmodified.
_RULES: list[tuple[Intent, Callable[[str], bool]]] = [
    (Intent.SCORE, _is_score),
    (Intent.ADVICE, _is_advice),
    (Intent.FACT, _is_fact),
]


def classify_intent(transcript: str) -> Intent:
    """Deterministic, ordered classification of a caddie transcript.

    SCORE is checked first (most specific), then ADVICE (fail-toward-advice:
    a judgment-class ask mixed with fact words still routes to the brain —
    the safe, slow failure mode), then FACT, else OTHER (fast path — chit-
    chat, repeats, anything unclassifiable)."""
    text = (transcript or "").lower()
    for intent, predicate in _RULES:
        if predicate(text):
            return intent
    return Intent.OTHER
