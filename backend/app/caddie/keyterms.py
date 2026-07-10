"""Golf vocabulary/context biasing for the LIVE-mode Realtime input transcript.

Mirror of frontend/src/lib/voice/keyterms.ts GOLF_KEYTERMS — if you edit either
list, edit both; tests/test_transcription_prompt.py pins the expected terms.

Builds the free-text `prompt` OpenAI's gpt-4o-transcribe accepts at
session.audio.input.transcription.prompt (see the citation in
app/services/realtime_relay.py). This is a HINT for the transcription model,
never a system prompt — labeled keyword lists, no imperatives, and it is
composed entirely from closed-set constants so no user free text (unknown
club keys / hazard types) can enter it.
"""

from typing import TYPE_CHECKING, Optional

from app.caddie.club_selection import CLUB_DISPLAY_NAMES

if TYPE_CHECKING:
    from app.caddie.session import RoundSession


# Exact mirror of frontend/src/lib/voice/keyterms.ts GOLF_KEYTERMS, same order.
GOLF_KEYTERMS: tuple[str, ...] = (
    "birdie",
    "bogey",
    "double bogey",
    "eagle",
    "albatross",
    "mulligan",
    "gimme",
    "up and down",
    "fairway",
    "tee box",
    "pitching wedge",
    "sand wedge",
    "lob wedge",
    "gap wedge",
    "hybrid",
    "3-wood",
    "5-wood",
    "driver",
    "putter",
    "yardage",
    "dogleg",
    "carry",
    "layup",
    "pin high",
)

# Closed map from Hazard.type (water | bunker | ob | trees | slope) to spoken
# words. "slope" is deliberately omitted — it isn't a spoken hazard term.
# Unknown types are dropped (closed set — injection safety).
_HAZARD_TERMS: dict[str, str] = {
    "water": "water hazard",
    "bunker": "bunker",
    "ob": "out of bounds",
    "trees": "trees",
}

# Self-imposed cap — the API documents no length limit for gpt-4o-transcribe's
# free-text prompt; the guide's guidance is "short keyword lists". Asserted by
# test, not truncated at runtime.
MAX_TRANSCRIPTION_PROMPT_CHARS = 600


def golf_baseline_prompt() -> str:
    """The vocabulary-only sentence, used standalone (setup route) and as the
    tail of the in-round prompt."""
    return "Golf vocabulary: " + ", ".join(GOLF_KEYTERMS) + "."


def build_transcription_prompt(session: Optional["RoundSession"]) -> Optional[str]:
    """Compose the transcription.prompt for an in-round Realtime mint.

    session is None -> None (prompt omitted; payload stays byte-identical to
    the pre-change {model, language} dict).

    Otherwise, most-specific-first, deduped case-insensitively, blanks dropped:
      1. The player's own clubs (names only, never yardages) — keys not in
         CLUB_DISPLAY_NAMES are DROPPED (closed vocabulary; deliberately does
         NOT fall back to the raw key, unlike _situation_block's .get(k, k)).
      2. This hole's hazards, mapped through _HAZARD_TERMS.
      3. The golf vocabulary baseline.

    Only club_distances keys and hole_intel[current_hole].hazards[].type are
    read — no handicap, yardages, memories, conversation history, or other
    players reach the prompt.
    """
    if session is None:
        return None

    parts: list[str] = []

    club_names = [
        CLUB_DISPLAY_NAMES[k]
        for k in session.club_distances
        if session.club_distances.get(k) and k in CLUB_DISPLAY_NAMES
    ]
    if club_names:
        parts.append("Player's clubs: " + ", ".join(club_names) + ".")

    intel = session.hole_intel.get(session.current_hole)
    if intel is not None and intel.hazards:
        hazard_terms = [
            _HAZARD_TERMS[h.type] for h in intel.hazards if h.type in _HAZARD_TERMS
        ]
        if hazard_terms:
            parts.append("This hole: " + ", ".join(hazard_terms) + ".")

    parts.append(golf_baseline_prompt())

    return _dedupe(parts)


def _dedupe(parts: list[str]) -> str:
    """Join parts with a space, deduping case-insensitively and dropping blanks."""
    seen: set[str] = set()
    out: list[str] = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        key = p.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return " ".join(out)
