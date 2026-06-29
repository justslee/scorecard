"""ORM models matching the applied migrations.

Caddie schema (supabase/migrations 001–004, baseline revision 001_baseline):
  CaddieSession, CaddieMessage, PlayerProfile, CaddieMemory, HolePin,
  ElevationCache, Shot, CaddiePersona.

Core scoring schema (Alembic revision 002_core_scoring / 005_core_scoring):
  Player, GolferProfile, Tournament, Round, PlayerGroup, RoundPlayer,
  Score, Game, CourseReview.
"""

from datetime import datetime, date
from typing import Optional
from sqlalchemy import (
    BigInteger, Boolean, Date, DateTime, ForeignKey, Integer, Numeric, Text, func,
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


# ─────────────────────────────────────────────────────────────────────────────
# Core scoring domain — Alembic revision 002_core_scoring (005_core_scoring)
# These tables replace backend/data/*.json. Routes migrated in later PRs.
# ─────────────────────────────────────────────────────────────────────────────


class Player(Base):
    """Saved golfer roster. Distinct from caddie PlayerProfile (AI stats)."""

    __tablename__ = "players"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, server_default=func.gen_random_uuid()
    )
    owner_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True, index=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    nickname: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    email: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    phone: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    handicap: Mapped[Optional[float]] = mapped_column(Numeric, nullable=True)
    avatar_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    clerk_user_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    rounds_played: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class GolferProfile(Base):
    """User-facing identity: handicap history, bag, strokes-gained summary.

    Distinct from caddie PlayerProfile. May cross-reference later (decision E3).
    One row per Clerk user_id.

    Columns added in migration 007_golfer_profile_fields:
      name        — display name (maps to GolferProfile.name in types.ts)
      home_course — free-text home course name (maps to GolferProfile.homeCourse)
    """

    __tablename__ = "golfer_profiles"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, server_default=func.gen_random_uuid()
    )
    user_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True, index=True)
    owner_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True, index=True)
    # Added by migration 007 — maps to types.ts GolferProfile.name
    name: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    handicap_index: Mapped[Optional[float]] = mapped_column(Numeric, nullable=True)
    scoring_average: Mapped[Optional[float]] = mapped_column(Numeric, nullable=True)
    bag_clubs: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    # Added by migration 007 — maps to types.ts GolferProfile.homeCourse (free text)
    home_course: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Kept for future caddie cross-reference; not served in the API shape.
    home_course_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    play_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    handicap_history: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    strokes_gained: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Tournament(Base):
    """A scoring tournament grouping multiple rounds."""

    __tablename__ = "tournaments"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, server_default=func.gen_random_uuid()
    )
    owner_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True, index=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    num_rounds: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # round_ids kept as JSONB list for ordering flexibility; round rows also
    # carry tournament_id FK for the canonical join.
    round_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    player_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Round(Base):
    """A scoring round. `holes` is a JSONB snapshot of par/handicap/yards
    for this round; structural course data lives in the course-mapping tables."""

    __tablename__ = "rounds"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, server_default=func.gen_random_uuid()
    )
    owner_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True, index=True)
    # Which player in this round represents the owner (the signed-in user).
    # Nullable: legacy rows fall back to the first round_player in the API.
    owner_player_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    course_id: Mapped[str] = mapped_column(Text, nullable=False)
    course_name: Mapped[str] = mapped_column(Text, nullable=False)
    tee_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    tee_name: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    date: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="active")
    tournament_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("tournaments.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    holes: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class PlayerGroup(Base):
    """A tee-time group within a round (e.g. "Group A, 8:00am, hole 1")."""

    __tablename__ = "player_groups"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, server_default=func.gen_random_uuid()
    )
    round_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("rounds.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    tee_time: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    starting_hole: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    player_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class RoundPlayer(Base):
    """Normalized: one row per (round, player). group_id is optional."""

    __tablename__ = "round_players"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, server_default=func.gen_random_uuid()
    )
    round_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("rounds.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    player_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    group_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("player_groups.id", ondelete="SET NULL"),
        nullable=True,
    )
    handicap: Mapped[Optional[float]] = mapped_column(Numeric, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Score(Base):
    """Normalized: one row per (round, player, hole). Unique constraint supports
    upsert semantics — one score per player per hole per round."""

    __tablename__ = "scores"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, server_default=func.gen_random_uuid()
    )
    round_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("rounds.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    player_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    hole_number: Mapped[int] = mapped_column(Integer, nullable=False)
    strokes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class ScoringCourse(Base):
    """Scoring-course picker entries — replaces backend/data/courses.json.

    Distinct from the PostGIS-backed ``courses``/``tee_sets``/``holes`` tables
    used by the caddie/mapped-course system (migration 001 baseline).
    Unifying the two is a deliberate FUTURE refactor; see follow-up note in
    specs/real-data-wiring-plan.md.
    """

    __tablename__ = "scoring_courses"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, server_default=func.gen_random_uuid()
    )
    owner_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True, index=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    location: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # JSONB list of HoleInfo: [{number, par, yards?, handicap?}]
    holes: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    # JSONB list of TeeOption: [{id, name, holes:[HoleInfo]}] — nullable
    tees: Mapped[Optional[list]] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Game(Base):
    """A scoring game (Nassau, skins, stroke-play, etc.) scoped to a round or
    tournament. Managed via round/tournament endpoints — no standalone /api/games.
    player_ids, teams, settings stored as JSONB for per-format flexibility.
    """

    __tablename__ = "games"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, server_default=func.gen_random_uuid()
    )
    round_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("rounds.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    tournament_id: Mapped[Optional[str]] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("tournaments.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    format: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    player_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    teams: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    settings: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class CourseReview(Base):
    """Owner-scoped course review (B2). Keyed on a string course_key (GolfAPI id
    when known, else name:<slug>) to sidestep course-identity unification (B5)."""

    __tablename__ = "course_reviews"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, server_default=func.gen_random_uuid()
    )
    owner_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    course_key: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    course_name: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    round_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    rating: Mapped[int] = mapped_column(Integer, nullable=False)
    body: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    played_at: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
