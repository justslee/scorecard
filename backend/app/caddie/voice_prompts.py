"""Shared spoken-style prompt builder for the conversational caddie.

Used by:
- OpenAI Realtime session.update / session creation (full instructions)
- Claude session voice fallback (system prompt)

Composes: personality character + persistent memory + current situation + behavior rules.
"""

from typing import Optional

from app.caddie.types import CaddiePersonality
from app.caddie.session import RoundSession
from app.caddie.club_selection import CLUB_DISPLAY_NAMES
from app.db.models import CaddieMemory


_BASE_BEHAVIOR = """You are caddying live for this golfer. You can hear them and they can hear you.
Default to brief, spoken-style answers — 1 to 3 sentences. Avoid markdown, lists, or headings.
You may interrupt yourself to acknowledge the player if they cut in.
You have tools available — use them to fetch real numbers (recommendations, distances) before
giving strategic advice. Don't make up yardages or club distances.
Stay in character at all times. Reference prior shots and prior rounds when it sharpens the advice.
"""


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

    parts.append("# Behavior\n" + _BASE_BEHAVIOR.strip())

    return "\n\n".join(parts)


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
    return "\n".join(lines)


def _strip_persona_from_system(system_prompt: str) -> str:
    """Cheap fallback: take the first paragraph of a Claude-style system prompt
    when no realtime_instructions are defined."""
    head = system_prompt.strip().split("\n\nStyle guidelines:", 1)[0]
    return head.strip()
