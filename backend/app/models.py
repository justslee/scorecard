"""Pydantic models for the Scorecard API."""

from pydantic import BaseModel
from typing import Optional
from datetime import datetime


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
    format: str
    name: str
    playerIds: list[str]
    settings: Optional[dict] = None


# ============ Rounds ============
class Round(BaseModel):
    id: str
    courseId: str
    courseName: str
    teeId: Optional[str] = None
    teeName: Optional[str] = None
    date: str
    players: list[Player]
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
    teeId: Optional[str] = None
    teeName: Optional[str] = None
    players: list[Player]
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
