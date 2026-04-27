"""Persistent caddie memory — what we know about each player across rounds.

`get_top_memories(user_id)` is injected into the system prompt at round start so
the caddie remembers tendencies and preferences from prior rounds.

`summarize_round(session)` runs at /session/end, asks Claude to extract durable
takeaways from the round's conversation + shot history, and writes them to
`caddie_memories`.
"""

import os
from typing import Optional
import anthropic
from sqlalchemy import select

from app.db.engine import async_session
from app.db.models import CaddieMemory, PlayerProfile
from app.caddie.session import RoundSession


_MEMORY_KINDS = {"tendency", "preference", "course_history", "incident"}
_MEMORY_DEFAULT_LIMIT = 8


# ── Read ──


async def get_top_memories(user_id: str, limit: int = _MEMORY_DEFAULT_LIMIT) -> list[CaddieMemory]:
    """Return most recent, highest-weighted memories for a user."""
    async with async_session() as db:
        stmt = (
            select(CaddieMemory)
            .where(CaddieMemory.user_id == user_id)
            .order_by(CaddieMemory.weight.desc(), CaddieMemory.created_at.desc())
            .limit(limit)
        )
        result = await db.execute(stmt)
        return list(result.scalars().all())


async def get_player_profile(user_id: str) -> Optional[PlayerProfile]:
    async with async_session() as db:
        return await db.get(PlayerProfile, user_id)


def render_memories_for_prompt(memories: list[CaddieMemory]) -> str:
    """Format memories as a system-prompt block. Empty string when no memories."""
    if not memories:
        return ""
    bullets = []
    for m in memories:
        bullets.append(f"- ({m.kind}) {m.summary}")
    return "What you know about this player from prior rounds:\n" + "\n".join(bullets)


# ── Write ──


async def add_memory(user_id: str, kind: str, summary: str, weight: float = 1.0,
                     round_id: Optional[str] = None) -> None:
    if kind not in _MEMORY_KINDS:
        raise ValueError(f"Unknown memory kind: {kind}")
    async with async_session() as db:
        db.add(CaddieMemory(
            user_id=user_id,
            kind=kind,
            summary=summary,
            weight=weight,
            round_id=round_id,
        ))
        await db.commit()


# ── Round summarization (post-round LLM pass) ──


_SUMMARIZE_PROMPT = """You are a golf coach reviewing a round you just caddied. Extract 1-3 durable
takeaways about the player from the conversation and shots. Each takeaway should be a single
sentence and fall into one of these categories:
- tendency: a recurring shot pattern (e.g. "tends to miss approach shots short under pressure")
- preference: a stated preference for how they want to be coached (e.g. "prefers terse advice", "wants distance to front of green not center")
- course_history: a concrete fact about how they played a hole at this course (e.g. "made a 4 on Pebble #7 from 110y with PW")
- incident: a notable moment worth remembering (e.g. "hit driver out of bounds on #18 after I suggested 3-wood")

Skip generic praise or filler. Only extract takeaways that would change how you advise this
player on a future round. If nothing rises to that bar, return an empty list.

Respond with JSON only:
{"memories": [{"kind": "tendency|preference|course_history|incident", "summary": "<one sentence>", "weight": 0.5-1.5}]}
"""


async def summarize_round(session: RoundSession) -> list[CaddieMemory]:
    """Generate memory entries from a finished round and persist them."""
    if not session.user_id:
        return []
    if not session.conversation_history and not session.shot_history:
        return []

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        return []

    transcript_lines = []
    for msg in session.conversation_history:
        transcript_lines.append(f"{msg.role.upper()}: {msg.content}")
    transcript = "\n".join(transcript_lines) or "(no conversation logged)"

    shot_lines = []
    for s in session.shot_history:
        shot_lines.append(
            f"Hole {s.hole_number}: {s.club} {s.distance_yards}y → {s.result or '?'}"
        )
    shots_text = "\n".join(shot_lines) or "(no shots logged)"

    user_message = f"""COURSE: {session.course_id or 'unknown'}
HANDICAP: {session.handicap}

CONVERSATION:
{transcript}

SHOTS:
{shots_text}
"""

    client = anthropic.Anthropic(api_key=api_key)
    model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-5-20250929")
    try:
        message = client.messages.create(
            model=model,
            max_tokens=600,
            temperature=0.3,
            system=_SUMMARIZE_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        )
        raw = message.content[0].text
    except Exception:
        return []

    parsed = _parse_memories_json(raw)
    if not parsed:
        return []

    saved: list[CaddieMemory] = []
    async with async_session() as db:
        for entry in parsed:
            kind = entry.get("kind")
            summary = (entry.get("summary") or "").strip()
            weight = float(entry.get("weight") or 1.0)
            if kind not in _MEMORY_KINDS or not summary:
                continue
            mem = CaddieMemory(
                user_id=session.user_id,
                round_id=session.round_id,
                kind=kind,
                summary=summary,
                weight=weight,
            )
            db.add(mem)
            saved.append(mem)
        await db.commit()
        for m in saved:
            await db.refresh(m)
    return saved


def _parse_memories_json(raw: str) -> list[dict]:
    """Parse Claude's JSON output, tolerating fences or stray prose."""
    import json
    import re

    text = raw.strip()
    fence = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    obj_match = re.search(r"\{.*\}", text, re.DOTALL)
    if not obj_match:
        return []
    try:
        obj = json.loads(obj_match.group(0))
    except json.JSONDecodeError:
        return []
    memories = obj.get("memories")
    return memories if isinstance(memories, list) else []
