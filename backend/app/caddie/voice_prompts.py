"""Shared spoken-style prompt builder for the conversational caddie.

Used by:
- OpenAI Realtime session.update / session creation (full instructions)
- Claude session voice fallback (system prompt)

Composes: personality character + persistent memory + current situation + behavior rules.
"""

from typing import Optional

from app.caddie.types import CaddiePersonality, TeeShotNumbers
from app.caddie.session import RoundSession
from app.caddie.club_selection import CLUB_DISPLAY_NAMES
from app.caddie.green_geometry import GREEN_GROUNDING_RULE
from app.caddie.hazards import BEND_GROUNDING_RULE, HAZARD_GROUNDING_RULE, format_bend_line, format_hazards_line
from app.caddie.guide_writer import format_guide_line
from app.caddie.physics import PHYSICS_GROUNDING_RULE
from app.db.models import CaddieMemory


_BASE_BEHAVIOR = """You are caddying live for this golfer. You can hear them and they can hear you.
Default to brief, spoken-style answers — 1 to 3 sentences. Your words are heard, not read:
never use markdown, asterisks, lists, headings, or emoji. One clear call beats a pep talk.
When the hole data shows an uphill/downhill change, factor it into the club call and say it
briefly ("plays more like 195 with the climb"). Any "Local knowledge" line is written for
golfers in general — filter it through THIS player's real club distances before repeating it:
never mention a hazard they can't reach on the shot at hand; focus on what's in play at THEIR
landing zone.
You may interrupt yourself to acknowledge the player if they cut in.
You have tools available — use them to fetch real numbers (recommendations, distances) before
giving strategic advice. Never state a yardage, club distance, or carry you did not get from a
tool. If a tool reports data as unavailable, say so plainly — never invent a number to fill in.
Stay in character at all times. Reference prior shots and prior rounds when it sharpens the advice.
"""

# Epistemic-humility rule (hazard-side-flip incident, 2026-07-06): the caddie
# "gaslit" the owner by insisting a mirrored/stale side reading was correct
# over what he could see standing on the tee. Shared by BOTH mouths — the
# realtime prompt (appended below) and the text mouth's stable_text
# (routes/caddie.py) — so wording never drifts between them.
OBSERVED_REALITY_RULE = (
    "The player can see the hole and you cannot. When they contradict the data "
    "on something they can directly observe — which side a hazard is on, what's "
    "visible, where the pin looks — defer to their eyes, plainly and without "
    "argument (\"You're looking at it — trust your eyes; my map may have it "
    "mirrored\"). Correct the read, don't defend it. Stay blunt about GOLF — club, "
    "strategy, commitment — but never insist the player is wrong about something "
    "in front of them."
)

# Input-grounding rule (Scars-transcript incident, 2026-07-09): on-course ASR
# invents words ("Scars.", "of God") and the caddie gamely answered them. The
# grounding doctrine extends from FACTS to INPUT: never answer what you didn't
# clearly hear. Shared by BOTH mouths — build_realtime_instructions below and
# the two stable_text blocks in routes/caddie.py — so wording never drifts.
# Realtime caveat: the speech-to-speech model hears raw AUDIO; this rule is a
# strong nudge, not a hard gate (the hard gate is the queued cascaded-STT spike).
INPUT_GROUNDING_RULE = (
    "Your ears follow the same rule as your facts: never answer a question you "
    "did not clearly hear. On-course audio garbles — if the player's words come "
    "through as gibberish, an off-topic non-sequitur, or a fragment with no "
    "plausible golf meaning, do NOT invent a golf answer for it. Ask them to "
    "repeat, briefly and once (\"Didn't catch that — say again?\"), then move on. "
    "This applies ONLY to unintelligible or clearly non-golf noise. Terse golf "
    "questions are normal out here — \"driver?\", \"what club\", \"how far\", "
    "\"read?\", \"wind?\" are real, clear questions: answer them directly and "
    "never ask the player to repeat something you understood."
)

# Yardage-agreement rule (specs/caddie-yardage-gps-selected-tee-plan.md §2.4;
# owner incident 2026-07-11, Bethpage Black hole 3, GPS active: the caddie
# insisted on a stale 178y mock number — "on the card, trust that" — and
# argued when the owner corrected it to 231, the Black tees he was actually
# playing). Shared by BOTH mouths — build_realtime_instructions below and the
# two stable_text blocks in routes/caddie.py — so wording never drifts.
YARDAGE_GROUNDING_RULE = (
    "The yardage in CURRENT SITUATION (GPS-to-green, or the golfer's selected "
    "tee) is ground truth for THIS turn — the same rule as OBSERVED REALITY "
    "above, applied to distance. If the player states a different yardage "
    "than that — a rangefinder reading, a tee sign, or simply a correction — "
    "ADOPT their number immediately and use it for the rest of this answer. "
    "NEVER defend a stored number against the golfer's own reality, and "
    "NEVER argue or double down. Only call a number \"on the card\" when it "
    "genuinely came from THIS player's own tee card — never as a generic "
    "hedge for a number you're unsure of."
)

# Positioning-shot rule (owner incident 2026-07-06, ~400y par 4: "Aim about
# 9 yards left of the flag" off the tee — the green was out of reach, so the
# flag was irrelevant). Shared by BOTH mouths so wording never drifts.
POSITIONING_SHOT_RULE = (
    "When the recommendation marks a shot as a positioning shot (shot_kind "
    "'positioning', or its aim says the green is out of reach), the flag does "
    "not exist for that swing: never give a pin-relative aim ('X yards left of "
    "the flag', 'take dead aim at the pin') and never reason from the pin "
    "position. Talk landing zone instead — which side of the fairway to favor, "
    "what's in play at the shot's own distance, and the approach it leaves "
    "(speak the engine's leave number; if none is provided, do not invent "
    "one). Pin-relative aim returns only on a shot the engine marks reachable."
)

# Numbers-coherence rule (owner incident 2026-07, Bethpage Black hole 1,
# 466y par 4: the caddie said "leaves about 125" beside a 300y driver and a
# 466y hole — three numbers from three sources that don't close — then
# invented wind physics to defend them. Shared by BOTH mouths (build_realtime
# _instructions below and the two stable_text blocks in routes/caddie.py) so
# wording never drifts.
NUMBERS_COHERENCE_RULE = (
    "For a tee shot or positioning shot there is ONE set of true numbers: the "
    "recommendation's tee-shot numbers block (hole yardage, plays-like, the "
    "club's expected carry and total in today's conditions, and the leave). "
    "Speak those numbers verbatim and no others — never quote a driver "
    "distance, hole yardage, or leave that is not in that block, and never "
    "derive your own. The leave you say MUST be the block's leave: hole "
    "yardage minus the drive's expected total, the same numbers, closing "
    "exactly. If the player challenges the arithmetic, re-derive it out loud "
    "from the block and correct yourself ('466, driver totals about 276 "
    "today, so 190 left — I misspoke earlier'). Admitting a wrong number and "
    "restating the right one ALWAYS beats explaining the wrong one — never "
    "invent wind, roll, or 'effective yards' to make mismatched numbers work. "
    "And keep the direction of physics honest: a hole playing longer leaves "
    "MORE after the drive, never less."
)

# Miss-side grounding rule (owner incidents: Bethpage Black 1 — "left is the
# better miss" on a hole with trees BOTH sides; Bethpage Red 3 — "that bunker
# right" fabricated in a driving zone whose real hazard was trees). Shared by
# BOTH mouths so wording never drifts.
MISS_SIDE_GROUNDING_RULE = (
    "Never declare a better miss side the hazard data doesn't support. The "
    "miss side you speak must be the recommendation's miss side, backed by "
    "the hazards listed for THIS shot's landing distance — never your own "
    "read of the hole. If the data shows trouble on both sides, say exactly "
    "that ('trees both sides — no good miss, commit to the fairway'); never "
    "pick a side to sound decisive. If one side has no mapped data, do not "
    "call it safe — data absence is not safety. When you name a hazard on a "
    "tee shot, it must be one whose distance puts it in play for THAT swing: "
    "never relocate a greenside bunker into the driving zone, and never name "
    "a hazard type the data doesn't list."
)

# Text-mouth tool instruction (caddie-tool-loop-parity): the classic text
# caddie now carries the same six tools the Realtime orb has (canonical
# registry in app/caddie/tools.py). Appended to BOTH text builders'
# stable_text (routes/caddie.py) — one constant so wording never drifts.
TOOL_USE_RULE = (
    "You have tools to fetch live numbers (recommendation, conditions, carries, "
    "player profile) and to log shots. Prefer a tool over guessing when the "
    "CURRENT SITUATION lacks the number; never state a yardage or carry that "
    "came from neither a tool nor the CURRENT SITUATION. If a tool reports data "
    "unavailable, say so plainly."
)


def build_realtime_instructions(
    personality: CaddiePersonality,
    session: Optional[RoundSession] = None,
    memories: Optional[list[CaddieMemory]] = None,
) -> str:
    """Compose the full instructions string for an OpenAI Realtime session."""
    persona_block = (
        personality.realtime_instructions
        or _strip_persona_from_system(personality.system_prompt)
    )

    parts = [f"# Personality: {personality.name}", persona_block.strip()]

    memory_block = _memories_block(memories)
    if memory_block:
        parts.append("# Player memory (from prior rounds)\n" + memory_block)

    situation_block = _situation_block(session)
    if situation_block:
        parts.append("# Current situation\n" + situation_block)

    history_block = _conversation_history_block(session)
    if history_block:
        parts.append("# Earlier this round (recent conversation)\n" + history_block)

    parts.append(
        "# Behavior\n" + _BASE_BEHAVIOR.strip() + "\n" + HAZARD_GROUNDING_RULE
        + "\n" + BEND_GROUNDING_RULE
        + "\n" + PHYSICS_GROUNDING_RULE
        + "\n" + GREEN_GROUNDING_RULE
        + "\n" + INPUT_GROUNDING_RULE
        + "\n" + OBSERVED_REALITY_RULE
        + "\n" + YARDAGE_GROUNDING_RULE
        + "\n" + POSITIONING_SHOT_RULE
        + "\n" + NUMBERS_COHERENCE_RULE
        + "\n" + MISS_SIDE_GROUNDING_RULE
    )

    return "\n\n".join(parts)


# Data-independent par-vs-yardage sanity guard (owner incident: Bethpage RED
# 3 shown "PAR 3 · 355 YDS" — no real par 3 plays 280+ yards from any normal
# tee; the longest famous ones stay comfortably under that). Shared by BOTH
# mouths — `_format_yardage_line` (routes/caddie.py) and `_situation_block`
# below — so a suspect stored par is flagged the same way everywhere.
PAR_SANITY_MIN_YARDS_FOR_PAR3: int = 280


def format_par_sanity_note(par: Optional[int], yards: Optional[int]) -> str:
    """Honest empty (`""`) unless the stored par/yardage combination is
    physically implausible — never fabricates a par, just flags one that
    can't be trusted."""
    if par == 3 and yards is not None and yards > PAR_SANITY_MIN_YARDS_FOR_PAR3:
        return (
            f"— the card says par 3 but at {yards} yards this is a two-shot "
            "hole; treat the par as suspect and never lean on it"
        )
    return ""


def format_tee_numbers_line(n: TeeShotNumbers) -> str:
    """The ONE spoken/written rendering of a `TeeShotNumbers` block — every
    frame labeled, closing exactly (specs/caddie-numbers-coherence-plan.md
    §2.3). Both mouths call this; neither restates the wording itself, so a
    future edit can't drift them apart."""
    club_display = CLUB_DISPLAY_NAMES.get(n.club, n.club)

    basis_labels = {"gps": "GPS", "tee-card": "tee-card", "tee-geom": "tee", "card": "card"}
    basis_clause = f" ({basis_labels[n.yardage_basis]} yardage)" if n.yardage_basis in basis_labels else ""

    if n.drive_carry_yards is not None:
        drive_clause = (
            f"{club_display} — {n.club_stored_yards} stored, carries {n.drive_carry_yards} "
            f"and totals {n.drive_total_yards} in these conditions"
        )
    else:
        # competition_legal: no environmental physics anywhere in the block.
        drive_clause = f"{club_display} — {n.club_stored_yards} stored (competition-legal, no adjustments)"

    plays_like_clause = (
        f"plays like {n.plays_like_yards} today"
        if n.plays_like_yards != n.to_green_yards
        else f"plays like {n.plays_like_yards}"
    )

    leave_clause = f"leaves about {n.leave_yards} in"
    if n.leave_plays_like_yards is not None and n.leave_plays_like_yards != n.leave_yards:
        leave_clause += f" (plays like ~{n.leave_plays_like_yards})"

    return (
        f"Tee-shot numbers for hole {n.hole_number} (AUTHORITATIVE — they close: "
        f"{n.to_green_yards} − {n.drive_total_yards} = {n.leave_exact_yards}): "
        f"{n.to_green_yards} to the green{basis_clause}; {plays_like_clause}; "
        f"{drive_clause}; {leave_clause}. Speak ONLY these numbers for this tee shot."
    )


def _memories_block(memories: Optional[list[CaddieMemory]]) -> str:
    if not memories:
        return ""
    lines = []
    for m in memories:
        lines.append(f"- ({m.kind}) {m.summary}")
    return "\n".join(lines)


def _situation_block(session: Optional[RoundSession]) -> str:
    if session is None:
        return ""
    lines: list[str] = []
    if session.handicap is not None:
        lines.append(f"Handicap: {session.handicap}")
    if session.club_distances:
        clubs = ", ".join(
            f"{CLUB_DISPLAY_NAMES.get(k, k)}: {v}y"
            for k, v in sorted(session.club_distances.items(), key=lambda x: x[1], reverse=True)
            if v
        )
        if clubs:
            lines.append(f"Player clubs: {clubs}")
    if session.weather:
        w = session.weather
        lines.append(
            f"Weather: {w.temperature_f:.0f}°F, wind {w.wind_speed_mph:.0f}mph from {w.wind_direction}°"
        )
    lines.append(f"Current hole: #{session.current_hole}")
    intel = session.hole_intel.get(session.current_hole)
    if intel:
        par_sanity_note = format_par_sanity_note(intel.par, intel.yards)
        if par_sanity_note:
            lines.append(f"Hole {session.current_hole}, par {intel.par} {par_sanity_note}")
        if intel.hazards:
            hazards_line = format_hazards_line(session.current_hole, intel.hazards)
            if hazards_line:
                lines.append(hazards_line)
        bend_line = format_bend_line(session.current_hole, intel.bend)
        if bend_line:
            lines.append(bend_line)
        guide_line = format_guide_line(intel.strategy_guide)
        if guide_line:
            lines.append(guide_line)
        if intel.green_slope:
            lines.append(f"Green slope: {intel.green_slope.description}")
    if session.last_recommendation:
        rec = session.last_recommendation
        if rec.tee_shot_numbers is not None:
            # Positioning/tee shot with the one-solve numbers block — replaces
            # the old bare "to {target_yards}y" line, whose three unconnected
            # frames (leave / bag driver / physics total) were the root of
            # the "125" incident (specs/caddie-numbers-coherence-plan.md §2.3).
            lines.append(
                f"Last recommendation: {rec.club}. {format_tee_numbers_line(rec.tee_shot_numbers)} "
                f"aim: {rec.aim_point.description}, miss: {rec.miss_side.preferred}"
            )
        else:
            lines.append(
                f"Last recommendation: {rec.club} to {rec.target_yards}y, "
                f"aim: {rec.aim_point.description}, miss: {rec.miss_side.preferred}"
            )
    recent_shots = session.shot_history[-5:]
    if recent_shots:
        shots_str = "; ".join(
            f"Hole {s.hole_number}: {s.club} {s.distance_yards}y → {s.result or '?'}"
            for s in recent_shots
        )
        lines.append(f"Recent shots: {shots_str}")
    return "\n".join(lines)


def _conversation_history_block(session: Optional[RoundSession]) -> str:
    """Compact recent-history block for a fresh Realtime mint (last ~20 turns).

    Mirrors _build_session_voice_prompt's `messages` hydration (routes/caddie.py)
    so a new Realtime session isn't a stranger to what's already been discussed
    this round — the biggest grounding gap vs the text session path.
    """
    if session is None or not session.conversation_history:
        return ""
    lines = []
    for msg in session.conversation_history[-20:]:
        speaker = "Player" if msg.role == "user" else "You"
        lines.append(f"{speaker}: {msg.content}")
    return "\n".join(lines)


def _strip_persona_from_system(system_prompt: str) -> str:
    """Cheap fallback: take the first paragraph of a Claude-style system prompt
    when no realtime_instructions are defined."""
    head = system_prompt.strip().split("\n\nStyle guidelines:", 1)[0]
    return head.strip()
