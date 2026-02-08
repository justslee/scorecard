"""Round session state manager — in-memory state that persists within a round.

Keeps course intel, weather, conversation history, shot history, and player stats
cached per round so we don't re-fetch on every request.

Sessions auto-expire after 8 hours (no round lasts longer than that).
"""

import time
import threading
from typing import Optional
from pydantic import BaseModel

from app.caddie.types import (
    WeatherConditions,
    HoleIntelligence,
    PlayerStatistics,
    CaddieRecommendation,
)


class ShotRecord(BaseModel):
    """Record of a shot for history tracking within a round."""
    hole_number: int
    club: str
    distance_yards: int
    result: Optional[str] = None  # e.g., "fairway", "green", "bunker"
    timestamp: float = 0.0


class VoiceCaddieMessage(BaseModel):
    """A single message in the voice conversation."""
    role: str  # "user" or "assistant"
    content: str


class RoundSession(BaseModel):
    """State for a single active round."""
    round_id: str
    course_id: Optional[str] = None
    created_at: float = 0.0
    last_accessed: float = 0.0

    # Cached data (fetched once, reused across holes)
    weather: Optional[WeatherConditions] = None
    weather_fetched_at: float = 0.0
    hole_intel: dict[int, HoleIntelligence] = {}  # keyed by hole number
    player_stats: Optional[PlayerStatistics] = None

    # Per-hole state
    current_hole: int = 1
    last_recommendation: Optional[CaddieRecommendation] = None
    shot_history: list[ShotRecord] = []

    # Voice conversation (full history for the round)
    conversation_history: list[VoiceCaddieMessage] = []

    # Club distances (loaded once from profile)
    club_distances: dict[str, int] = {}
    handicap: Optional[float] = None


# Session expiry: 8 hours
SESSION_TTL_SECONDS = 8 * 60 * 60
# Weather refresh interval: 30 minutes
WEATHER_REFRESH_SECONDS = 30 * 60


class SessionManager:
    """Thread-safe in-memory round session store."""

    def __init__(self):
        self._sessions: dict[str, RoundSession] = {}
        self._lock = threading.Lock()

    def get_or_create(self, round_id: str, course_id: Optional[str] = None) -> RoundSession:
        """Get existing session or create a new one."""
        now = time.time()
        with self._lock:
            session = self._sessions.get(round_id)
            if session is None:
                session = RoundSession(
                    round_id=round_id,
                    course_id=course_id,
                    created_at=now,
                    last_accessed=now,
                )
                self._sessions[round_id] = session
            else:
                session.last_accessed = now
            return session

    def get(self, round_id: str) -> Optional[RoundSession]:
        """Get session if it exists and hasn't expired."""
        with self._lock:
            session = self._sessions.get(round_id)
            if session is None:
                return None
            if time.time() - session.last_accessed > SESSION_TTL_SECONDS:
                del self._sessions[round_id]
                return None
            session.last_accessed = time.time()
            return session

    def update(self, session: RoundSession):
        """Update a session in the store."""
        with self._lock:
            session.last_accessed = time.time()
            self._sessions[session.round_id] = session

    def end(self, round_id: str) -> Optional[RoundSession]:
        """End a round session and return it (for final stats)."""
        with self._lock:
            return self._sessions.pop(round_id, None)

    def cleanup_expired(self):
        """Remove expired sessions. Called periodically."""
        now = time.time()
        with self._lock:
            expired = [
                rid for rid, s in self._sessions.items()
                if now - s.last_accessed > SESSION_TTL_SECONDS
            ]
            for rid in expired:
                del self._sessions[rid]

    def active_count(self) -> int:
        """Number of active sessions."""
        with self._lock:
            return len(self._sessions)

    def needs_weather_refresh(self, session: RoundSession) -> bool:
        """Check if weather data should be refreshed."""
        if session.weather is None:
            return True
        return time.time() - session.weather_fetched_at > WEATHER_REFRESH_SECONDS


# Global singleton — lives for the lifetime of the process
sessions = SessionManager()
