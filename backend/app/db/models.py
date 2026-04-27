"""ORM models matching migration 002_caddie_and_shots.sql.

Models for the existing 001 schema (courses/holes/etc.) are not declared here yet —
they'll be added when those routes migrate off JSON storage in a later PR.
"""

from datetime import datetime, date
from typing import Optional, Any
from sqlalchemy import (
    BigInteger, Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String,
    Text, func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.engine import Base


class CaddieSession(Base):
    __tablename__ = "caddie_sessions"

    round_id: Mapped[str] = mapped_column(Text, primary_key=True)
    user_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True, index=True)
    course_id: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), nullable=True)
    personality_id: Mapped[str] = mapped_column(Text, nullable=False, default="classic")
    current_hole: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    weather: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    weather_fetched_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    hole_intel: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    player_stats: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    last_recommendation: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    shot_history: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    club_distances: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    handicap: Mapped[Optional[float]] = mapped_column(Numeric, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="active")
    realtime_session_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    last_accessed: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    ended_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class CaddieMessage(Base):
    __tablename__ = "caddie_messages"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    round_id: Mapped[str] = mapped_column(
        Text, ForeignKey("caddie_sessions.round_id", ondelete="CASCADE"), nullable=False, index=True
    )
    hole_number: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    tool_calls: Mapped[Optional[list]] = mapped_column(JSONB, nullable=True)
    audio_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    latency_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class PlayerProfile(Base):
    __tablename__ = "player_profiles"

    user_id: Mapped[str] = mapped_column(Text, primary_key=True)
    handicap: Mapped[Optional[float]] = mapped_column(Numeric, nullable=True)
    club_distances: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    miss_direction: Mapped[Optional[str]] = mapped_column(Text, default="balanced")
    miss_short_pct: Mapped[Optional[float]] = mapped_column(Numeric, default=55)
    three_putts_per_round: Mapped[Optional[float]] = mapped_column(Numeric, default=2)
    par5_bogey_rate: Mapped[Optional[float]] = mapped_column(Numeric, default=20)
    personal_sg: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    prefers_terse: Mapped[Optional[bool]] = mapped_column(Boolean, default=False)
    distance_pref: Mapped[Optional[str]] = mapped_column(Text, default="center")
    preferred_personality_id: Mapped[Optional[str]] = mapped_column(Text, default="classic")
    rounds_analyzed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class CaddieMemory(Base):
    __tablename__ = "caddie_memories"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    round_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    weight: Mapped[float] = mapped_column(Numeric, nullable=False, default=1.0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class HolePin(Base):
    __tablename__ = "hole_pins"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, server_default=func.gen_random_uuid())
    course_id: Mapped[str] = mapped_column(Text, nullable=False)
    hole_number: Mapped[int] = mapped_column(Integer, nullable=False)
    pin_date: Mapped[date] = mapped_column(Date, nullable=False)
    pin_lat: Mapped[float] = mapped_column(Numeric, nullable=False)
    pin_lng: Mapped[float] = mapped_column(Numeric, nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False, default="manual")
    marked_by_user_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class ElevationCache(Base):
    __tablename__ = "elevation_cache"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    lat_q: Mapped[int] = mapped_column(Integer, nullable=False)
    lng_q: Mapped[int] = mapped_column(Integer, nullable=False)
    elevation_ft: Mapped[float] = mapped_column(Numeric, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Shot(Base):
    __tablename__ = "shots"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    round_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    user_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True, index=True)
    hole_id: Mapped[Optional[str]] = mapped_column(UUID(as_uuid=False), nullable=True)
    hole_number: Mapped[int] = mapped_column(Integer, nullable=False)
    shot_number: Mapped[int] = mapped_column(Integer, nullable=False)
    start_lat: Mapped[Optional[float]] = mapped_column(Numeric, nullable=True)
    start_lng: Mapped[Optional[float]] = mapped_column(Numeric, nullable=True)
    start_lie: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    end_lat: Mapped[Optional[float]] = mapped_column(Numeric, nullable=True)
    end_lng: Mapped[Optional[float]] = mapped_column(Numeric, nullable=True)
    end_lie: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    distance_yards: Mapped[Optional[float]] = mapped_column(Numeric, nullable=True)
    club: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    intended_target_lat: Mapped[Optional[float]] = mapped_column(Numeric, nullable=True)
    intended_target_lng: Mapped[Optional[float]] = mapped_column(Numeric, nullable=True)
    result: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    strokes_gained: Mapped[Optional[float]] = mapped_column(Numeric, nullable=True)
    wind_speed_mph: Mapped[Optional[float]] = mapped_column(Numeric, nullable=True)
    wind_direction: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    pressure_hpa: Mapped[Optional[float]] = mapped_column(Numeric, nullable=True)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class CaddiePersona(Base):
    __tablename__ = "caddie_personas"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    avatar: Mapped[str] = mapped_column(Text, nullable=False)
    voice_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    voice_pitch: Mapped[Optional[float]] = mapped_column(Numeric, nullable=True, default=1.0)
    voice_rate: Mapped[Optional[float]] = mapped_column(Numeric, nullable=True, default=1.0)
    response_style: Mapped[str] = mapped_column(Text, nullable=False, default="conversational")
    traits: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    system_prompt: Mapped[str] = mapped_column(Text, nullable=False)
    realtime_instructions: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_builtin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_public: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    author_user_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
