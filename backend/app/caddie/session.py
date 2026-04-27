"""Round session state — Postgres-backed.

Each round has a row in `caddie_sessions` plus per-turn rows in `caddie_messages`.
The public API mirrors the previous in-memory implementation so route handlers
stay simple: load → mutate → `await sessions.update(session)`.
"""

import json
import time
from datetime import datetime, timezone
from typing import Optional
from pydantic import BaseModel
from sqlalchemy import select, delete, text, update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.caddie.types import (
    WeatherConditions,
    HoleIntelligence,
    PlayerStatistics,
    CaddieRecommendation,
)
from app.db.engine import async_session
from app.db.models import CaddieSession as CaddieSessionRow, CaddieMessage as CaddieMessageRow


# ── Pydantic shape used by route handlers ──


class ShotRecord(BaseModel):
    hole_number: int
    club: str
    distance_yards: int
    result: Optional[str] = None
    timestamp: float = 0.0


class VoiceCaddieMessage(BaseModel):
    role: str  # "user" | "assistant" | "tool"
    content: str


class RoundSession(BaseModel):
    round_id: str
    user_id: Optional[str] = None
    course_id: Optional[str] = None
    personality_id: str = "classic"
    created_at: float = 0.0
    last_accessed: float = 0.0

    weather: Optional[WeatherConditions] = None
    weather_fetched_at: float = 0.0
    hole_intel: dict[int, HoleIntelligence] = {}
    player_stats: Optional[PlayerStatistics] = None

    current_hole: int = 1
    last_recommendation: Optional[CaddieRecommendation] = None
    shot_history: list[ShotRecord] = []

    conversation_history: list[VoiceCaddieMessage] = []

    club_distances: dict[str, int] = {}
    handicap: Optional[float] = None

    realtime_session_id: Optional[str] = None
    status: str = "active"


SESSION_TTL_SECONDS = 8 * 60 * 60
WEATHER_REFRESH_SECONDS = 30 * 60


# ── Row ↔ Pydantic conversion ──


def _row_to_session(row: CaddieSessionRow, messages: list[CaddieMessageRow]) -> RoundSession:
    hole_intel: dict[int, HoleIntelligence] = {}
    for k, v in (row.hole_intel or {}).items():
        try:
            hole_intel[int(k)] = HoleIntelligence.model_validate(v)
        except Exception:
            continue

    return RoundSession(
        round_id=row.round_id,
        user_id=row.user_id,
        course_id=row.course_id,
        personality_id=row.personality_id,
        created_at=row.created_at.timestamp() if row.created_at else 0.0,
        last_accessed=row.last_accessed.timestamp() if row.last_accessed else 0.0,
        weather=WeatherConditions.model_validate(row.weather) if row.weather else None,
        weather_fetched_at=row.weather_fetched_at.timestamp() if row.weather_fetched_at else 0.0,
        hole_intel=hole_intel,
        player_stats=PlayerStatistics.model_validate(row.player_stats) if row.player_stats else None,
        current_hole=row.current_hole,
        last_recommendation=(
            CaddieRecommendation.model_validate(row.last_recommendation)
            if row.last_recommendation else None
        ),
        shot_history=[ShotRecord.model_validate(s) for s in (row.shot_history or [])],
        conversation_history=[
            VoiceCaddieMessage(role=m.role, content=m.content) for m in messages
        ],
        club_distances={k: int(v) for k, v in (row.club_distances or {}).items()},
        handicap=float(row.handicap) if row.handicap is not None else None,
        realtime_session_id=row.realtime_session_id,
        status=row.status,
    )


def _session_to_row_kwargs(session: RoundSession) -> dict:
    return dict(
        user_id=session.user_id,
        course_id=session.course_id,
        personality_id=session.personality_id,
        current_hole=session.current_hole,
        weather=session.weather.model_dump() if session.weather else None,
        weather_fetched_at=(
            datetime.fromtimestamp(session.weather_fetched_at, tz=timezone.utc)
            if session.weather_fetched_at else None
        ),
        hole_intel={str(k): v.model_dump() for k, v in session.hole_intel.items()},
        player_stats=session.player_stats.model_dump() if session.player_stats else None,
        last_recommendation=(
            session.last_recommendation.model_dump() if session.last_recommendation else None
        ),
        shot_history=[s.model_dump() for s in session.shot_history],
        club_distances=session.club_distances,
        handicap=session.handicap,
        status=session.status,
        realtime_session_id=session.realtime_session_id,
        last_accessed=datetime.now(tz=timezone.utc),
    )


# ── Session manager ──


class SessionManager:
    """Postgres-backed round session store. All methods are async."""

    async def get_or_create(
        self,
        round_id: str,
        course_id: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> RoundSession:
        from fastapi import HTTPException
        async with async_session() as db:
            row = await db.get(CaddieSessionRow, round_id)
            if row is None:
                row = CaddieSessionRow(round_id=round_id, course_id=course_id, user_id=user_id)
                db.add(row)
                await db.commit()
                await db.refresh(row)
                return _row_to_session(row, messages=[])

            # If the row is already owned by someone else, refuse — even on /session/start.
            # 404 (not 403) so attackers can't enumerate which round_ids exist.
            if row.user_id and user_id and row.user_id != user_id:
                raise HTTPException(404, "Round not found")

            if user_id and not row.user_id:
                row.user_id = user_id
            if course_id and not row.course_id:
                row.course_id = course_id
            row.last_accessed = datetime.now(tz=timezone.utc)
            await db.commit()
            await db.refresh(row)
            messages = await self._load_messages(db, round_id)
            return _row_to_session(row, messages)

    async def get(self, round_id: str) -> Optional[RoundSession]:
        """Pure read. Does NOT bump `last_accessed` — TTL refresh now happens
        only on the targeted write helpers below, so polling endpoints don't
        thrash the row.
        """
        async with async_session() as db:
            row = await db.get(CaddieSessionRow, round_id)
            if row is None:
                return None
            if row.last_accessed and (
                datetime.now(tz=timezone.utc) - row.last_accessed
            ).total_seconds() > SESSION_TTL_SECONDS:
                await db.delete(row)
                await db.commit()
                return None
            messages = await self._load_messages(db, round_id)
            return _row_to_session(row, messages)

    async def update(self, session: RoundSession) -> None:
        """Persist whole-row state. Used only by /session/start where the row
        is freshly hydrated from `player_profiles` and there's no contention.
        Hot paths (shot append, recommendation set, weather/intel set, current
        hole bump) MUST use the targeted helpers below to avoid lost-update
        races between concurrent route handlers.
        """
        async with async_session() as db:
            stmt = (
                sql_update(CaddieSessionRow)
                .where(CaddieSessionRow.round_id == session.round_id)
                .values(**_session_to_row_kwargs(session))
            )
            await db.execute(stmt)
            await db.commit()

    # ── Targeted column updates (lost-update-safe; bump TTL atomically) ──

    async def append_shot(self, round_id: str, shot: ShotRecord) -> None:
        """Atomically append to shot_history via JSONB || on the server side.
        Concurrent appends from /session/shot and /session/recommend can
        no longer drop each other's writes."""
        payload = [shot.model_dump()]
        async with async_session() as db:
            await db.execute(
                text("""
                    update public.caddie_sessions
                    set shot_history = coalesce(shot_history, '[]'::jsonb) || cast(:payload as jsonb),
                        last_accessed = now()
                    where round_id = :rid
                """),
                {"rid": round_id, "payload": json.dumps(payload)},
            )
            await db.commit()

    async def set_recommendation(
        self, round_id: str, recommendation: CaddieRecommendation, current_hole: int,
    ) -> None:
        async with async_session() as db:
            await db.execute(
                text("""
                    update public.caddie_sessions
                    set last_recommendation = cast(:rec as jsonb),
                        current_hole = :hn,
                        last_accessed = now()
                    where round_id = :rid
                """),
                {"rid": round_id, "rec": json.dumps(recommendation.model_dump()), "hn": current_hole},
            )
            await db.commit()

    async def set_current_hole(self, round_id: str, current_hole: int) -> None:
        async with async_session() as db:
            await db.execute(
                text("""
                    update public.caddie_sessions
                    set current_hole = :hn, last_accessed = now()
                    where round_id = :rid
                """),
                {"rid": round_id, "hn": current_hole},
            )
            await db.commit()

    async def set_weather(self, round_id: str, weather: WeatherConditions) -> None:
        async with async_session() as db:
            await db.execute(
                text("""
                    update public.caddie_sessions
                    set weather = cast(:weather as jsonb),
                        weather_fetched_at = now(),
                        last_accessed = now()
                    where round_id = :rid
                """),
                {"rid": round_id, "weather": json.dumps(weather.model_dump())},
            )
            await db.commit()

    async def set_hole_intel(
        self, round_id: str, hole_intel: dict[int, "HoleIntelligence"], weather: Optional[WeatherConditions] = None,
    ) -> None:
        intel_payload = json.dumps({str(k): v.model_dump() for k, v in hole_intel.items()})
        params = {"rid": round_id, "intel": intel_payload}
        if weather is not None:
            params["weather"] = json.dumps(weather.model_dump())
            sql = """
                update public.caddie_sessions
                set hole_intel = cast(:intel as jsonb),
                    weather = cast(:weather as jsonb),
                    weather_fetched_at = now(),
                    last_accessed = now()
                where round_id = :rid
            """
        else:
            sql = """
                update public.caddie_sessions
                set hole_intel = cast(:intel as jsonb),
                    last_accessed = now()
                where round_id = :rid
            """
        async with async_session() as db:
            await db.execute(text(sql), params)
            await db.commit()

    async def set_realtime_session_id(
        self, round_id: str, realtime_session_id: str, personality_id: Optional[str] = None,
    ) -> None:
        sql = """
            update public.caddie_sessions
            set realtime_session_id = :rsid,
                personality_id = coalesce(:pid, personality_id),
                last_accessed = now()
            where round_id = :rid
        """
        async with async_session() as db:
            await db.execute(text(sql), {"rid": round_id, "rsid": realtime_session_id, "pid": personality_id})
            await db.commit()

    # ── Conversation messages (already append-only, kept atomic) ──

    async def append_message(
        self,
        round_id: str,
        role: str,
        content: str,
        hole_number: Optional[int] = None,
        tool_calls: Optional[list] = None,
        latency_ms: Optional[int] = None,
    ) -> None:
        async with async_session() as db:
            db.add(CaddieMessageRow(
                round_id=round_id,
                role=role,
                content=content,
                hole_number=hole_number,
                tool_calls=tool_calls,
                latency_ms=latency_ms,
            ))
            await db.commit()

    async def append_message_pair(
        self,
        round_id: str,
        user_content: str,
        assistant_content: str,
        hole_number: Optional[int] = None,
    ) -> None:
        """Atomic dual append for the /session/voice turn — either both rows
        commit or neither. Prevents the orphaned-user-message wedge described
        in the post-PR review."""
        async with async_session() as db:
            db.add(CaddieMessageRow(
                round_id=round_id,
                role="user",
                content=user_content,
                hole_number=hole_number,
            ))
            db.add(CaddieMessageRow(
                round_id=round_id,
                role="assistant",
                content=assistant_content,
                hole_number=hole_number,
            ))
            await db.commit()

    async def end(self, round_id: str) -> Optional[RoundSession]:
        """Mark session ended and return its final state."""
        async with async_session() as db:
            row = await db.get(CaddieSessionRow, round_id)
            if row is None:
                return None
            row.status = "ended"
            row.ended_at = datetime.now(tz=timezone.utc)
            await db.commit()
            await db.refresh(row)
            messages = await self._load_messages(db, round_id)
            return _row_to_session(row, messages)

    async def cleanup_expired(self) -> int:
        cutoff = datetime.fromtimestamp(time.time() - SESSION_TTL_SECONDS, tz=timezone.utc)
        async with async_session() as db:
            stmt = delete(CaddieSessionRow).where(
                CaddieSessionRow.status == "active",
                CaddieSessionRow.last_accessed < cutoff,
            )
            result = await db.execute(stmt)
            await db.commit()
            return result.rowcount or 0

    async def active_count(self) -> int:
        async with async_session() as db:
            stmt = select(CaddieSessionRow).where(CaddieSessionRow.status == "active")
            result = await db.execute(stmt)
            return len(result.scalars().all())

    def needs_weather_refresh(self, session: RoundSession) -> bool:
        if session.weather is None:
            return True
        return time.time() - session.weather_fetched_at > WEATHER_REFRESH_SECONDS

    async def _load_messages(self, db: AsyncSession, round_id: str) -> list[CaddieMessageRow]:
        stmt = (
            select(CaddieMessageRow)
            .where(CaddieMessageRow.round_id == round_id)
            .order_by(CaddieMessageRow.created_at)
        )
        result = await db.execute(stmt)
        return list(result.scalars().all())


sessions = SessionManager()


async def get_owned_session(round_id: str, user_id: Optional[str]) -> RoundSession:
    """Load a session and assert the caller owns it. Raises 404 otherwise.

    Used by every session-keyed route to enforce per-user authorization. The
    only entry that creates a new session is /session/start, which stamps
    user_id from the verified Clerk JWT — so any later access against a
    round_id whose stored user_id doesn't match is rejected as 'not found'
    (404 rather than 403 to avoid round_id enumeration leaks).
    """
    from fastapi import HTTPException
    session = await sessions.get(round_id)
    if session is None or session.user_id != user_id or not user_id:
        raise HTTPException(404, "Round not found")
    return session
