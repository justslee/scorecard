"""Pydantic models for the Scorecard API."""

from datetime import date
from pydantic import BaseModel, Field
from typing import Any, Optional


# ============ GolferProfile ============
# Matches types.ts GolferProfile exactly (camelCase).
# The backend table uses snake_case columns; the ORM↔Pydantic mapping lives in
# routes/profile.py (_orm_to_pydantic).


class GolferProfile(BaseModel):
    """Full golfer profile — served by GET /api/profile/golfer."""

    id: str
    # Display name (maps to golfer_profiles.name).
    name: Optional[str] = None
    # Handicap index (maps to golfer_profiles.handicap_index).
    handicap: Optional[float] = None
    # Free-text home course name (maps to golfer_profiles.home_course).
    homeCourse: Optional[str] = None
    # Bag distances keyed by club name (maps to golfer_profiles.bag_clubs JSONB).
    clubDistances: dict[str, Any] = {}


class GolferProfileCreate(BaseModel):
    """Body for POST /api/profile/golfer (create)."""

    name: Optional[str] = None
    handicap: Optional[float] = None
    homeCourse: Optional[str] = None
    clubDistances: dict[str, Any] = {}


class GolferProfileUpdate(BaseModel):
    """Body for PUT /api/profile/golfer (upsert)."""

    name: Optional[str] = None
    handicap: Optional[float] = None
    homeCourse: Optional[str] = None
    clubDistances: Optional[dict[str, Any]] = None


# ============ Players ============
class SavedPlayer(BaseModel):
    id: str
    name: str
    nickname: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    handicap: Optional[float] = None
    avatarUrl: Optional[str] = None
    clerkUserId: Optional[str] = None
    roundsPlayed: int = 0
    createdAt: str
    updatedAt: str


class PlayerCreate(BaseModel):
    name: str
    nickname: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    handicap: Optional[float] = None


class PlayerUpdate(BaseModel):
    name: Optional[str] = None
    nickname: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    handicap: Optional[float] = None


# ============ Scores ============
class Score(BaseModel):
    playerId: str
    holeNumber: int
    strokes: Optional[int] = None


# ============ Holes ============
class HoleInfo(BaseModel):
    number: int
    par: int
    yards: Optional[int] = None
    handicap: Optional[int] = None


# ============ Player in Round ============
class Player(BaseModel):
    id: str
    name: str
    handicap: Optional[float] = None
    groupId: Optional[str] = None


# ============ Player Group ============
class PlayerGroup(BaseModel):
    id: str
    name: str
    teeTime: Optional[str] = None
    startingHole: Optional[int] = None
    playerIds: list[str]


# ============ Game ============
class Game(BaseModel):
    id: str
    # Which round this game belongs to (None for tournament-scoped games).
    # Mirrors types.ts Game.roundId so team-game data is not silently dropped.
    roundId: Optional[str] = None
    format: str
    name: str
    playerIds: list[str]
    # Teams for team formats (Best Ball, Team Nassau, Scramble, etc.)
    # Stored as a list of {id, name, playerIds} dicts, matching types.ts GameTeam[].
    teams: Optional[list] = None
    settings: Optional[dict] = None


# ============ Rounds ============
class Round(BaseModel):
    id: str
    courseId: str
    courseName: str
    # Course anchor (centre + mapped-course id) captured at creation so the round
    # screen can render the satellite map directly. None on legacy rounds.
    courseLat: Optional[float] = None
    courseLng: Optional[float] = None
    mappedCourseId: Optional[str] = None
    teeId: Optional[str] = None
    teeName: Optional[str] = None
    date: str
    players: list[Player]
    # Which player in `players` represents the owner. May be None for legacy
    # rounds; clients should fall back to the first player when absent.
    ownerPlayerId: Optional[str] = None
    scores: list[Score]
    holes: list[HoleInfo]
    games: list[Game] = []
    groups: Optional[list[PlayerGroup]] = None
    status: str = "active"  # active | completed
    tournamentId: Optional[str] = None
    createdAt: str
    updatedAt: str


class RoundCreate(BaseModel):
    courseId: str
    courseName: str
    courseLat: Optional[float] = None
    courseLng: Optional[float] = None
    mappedCourseId: Optional[str] = None
    teeId: Optional[str] = None
    teeName: Optional[str] = None
    players: list[Player]
    # Which player is the owner. If omitted, the backend defaults to the first
    # player so behaviour is unchanged until clients send it explicitly.
    ownerPlayerId: Optional[str] = None
    holes: list[HoleInfo]
    games: list[Game] = []
    groups: Optional[list[PlayerGroup]] = None
    tournamentId: Optional[str] = None


class RoundUpdate(BaseModel):
    scores: Optional[list[Score]] = None
    games: Optional[list[Game]] = None
    groups: Optional[list[PlayerGroup]] = None
    status: Optional[str] = None


# ============ Tournaments ============
class Tournament(BaseModel):
    id: str
    name: str
    numRounds: Optional[int] = None
    roundIds: list[str] = []
    playerIds: list[str] = []
    playerNamesById: Optional[dict[str, str]] = None
    games: list[Game] = []
    createdAt: str
    updatedAt: str


class TournamentCreate(BaseModel):
    name: str
    numRounds: Optional[int] = None
    playerIds: list[str] = []


class TournamentUpdate(BaseModel):
    name: Optional[str] = None
    numRounds: Optional[int] = None
    roundIds: Optional[list[str]] = None
    playerIds: Optional[list[str]] = None
    games: Optional[list[Game]] = None


# ============ Courses ============
class TeeOption(BaseModel):
    id: str
    name: str
    holes: list[HoleInfo]


class Course(BaseModel):
    id: str
    name: str
    holes: list[HoleInfo]
    tees: Optional[list[TeeOption]] = None
    location: Optional[str] = None


class CourseCreate(BaseModel):
    name: str
    holes: list[HoleInfo]
    tees: Optional[list[TeeOption]] = None
    location: Optional[str] = None


# ============ Course Reviews ============

class CourseReview(BaseModel):
    """Response contract (camelCase) — mirrors types.ts CourseReview."""

    id: str
    ownerId: str
    courseKey: str
    courseName: Optional[str] = None
    roundId: Optional[str] = None
    rating: int
    body: Optional[str] = None
    playedAt: Optional[str] = None   # ISO date string (date.isoformat())
    createdAt: str                   # ISO datetime string


class CourseReviewCreate(BaseModel):
    """Request body for POST /api/courses/{course_key}/reviews."""

    rating: int = Field(ge=1, le=5)
    body: Optional[str] = Field(default=None, max_length=2000)
    roundId: Optional[str] = None
    courseName: Optional[str] = None
    # Optional ISO date; FastAPI coerces the string to date and 422s on bad format.
    playedAt: Optional[date] = None


# ============ Game Settlement ============

class SettlementTransfer(BaseModel):
    """A single minimized transfer that settles debt between two players.
    Mirrors frontend SettlementTransfer in lib/settlement.ts."""

    fromPlayerId: str
    toPlayerId: str
    amount: float  # always positive


class SettlementFinalize(BaseModel):
    """Request body for POST /api/rounds/{round_id}/settlement.

    Accepts the client-computed minimized ledger and persists it as a
    synthetic 'settlement' game record on the round (no DB migration needed).
    """

    transfers: list[SettlementTransfer]
    finalizedAt: str  # ISO datetime string (client-provided, mirrors FinalizedSettlement)
