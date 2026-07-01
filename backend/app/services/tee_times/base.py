"""
TeeTimeProvider abstract base class.

Every provider (Mock, Chronogolf, GolfNow …) subclasses this.
The route layer only ever calls through this interface, so swapping
providers requires no route changes.

Seam for real providers (Phase 2+):
  1. Subclass TeeTimeProvider in a new module (e.g. chronogolf.py).
  2. Implement search_availability() and book() using the provider's REST API.
  3. In tee_times.py, instantiate the real provider when credentials are set
     (os.getenv("CHRONOGOLF_API_KEY")), else fall back to MockTeeTimeProvider.
  4. Zero changes to the route contract required.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Literal


# ─── Shared data models ────────────────────────────────────────────────────────

@dataclass
class TeeTimeQuery:
    date: str                        # YYYY-MM-DD
    time_window_start: str           # "HH:MM" 24h
    time_window_end: str             # "HH:MM" 24h
    party_size: int                  # 1–4
    area: str | None = None          # free-text city / region
    course_ids: list[str] = field(default_factory=list)
    max_distance_miles: float | None = None
    max_price_usd: float | None = None


@dataclass
class TeeTimeSlot:
    id: str                          # "courseId-date-time-index"
    course_id: str
    course_name: str
    city: str
    date: str                        # YYYY-MM-DD
    time: str                        # "HH:MM"
    players: int                     # available slots (1–4)
    price_usd: float | None          # None = unknown (affiliate) — NEVER fabricated
    cart_included: bool
    distance_miles: float
    rating: float                    # 0–5 (0 = unknown)
    provider: str                    # "mock" | "affiliate" | "golfnow" | "chronogolf"
    holes: Literal[9, 18]
    designer: str | None = None
    booking_url: str | None = None   # deep-link for Affiliate / Phase 1
    # True when `time` is the requested window start, NOT verified live
    # availability (AffiliateLinkProvider). Legal posture: estimated slots are
    # suggestions to book on the course's own site — never presented as live.
    estimated: bool = False


@dataclass
class BookingDetails:
    name: str
    party_size: int
    email: str | None = None
    phone: str | None = None


@dataclass
class BookingResult:
    status: Literal["confirmed", "pending", "failed", "needs_human", "not_supported"]
    confirmation_number: str | None = None
    message: str | None = None
    booking_url: str | None = None


# ─── Abstract interface ────────────────────────────────────────────────────────

class TeeTimeProvider(ABC):
    """All providers must implement these two methods."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Stable identifier (used in TeeTimeSlot.provider and logging)."""

    @abstractmethod
    async def search_availability(self, query: TeeTimeQuery) -> list[TeeTimeSlot]:
        """
        Return available slots matching the query.
        MUST return an empty list (never raise) when no slots are found.
        """

    @abstractmethod
    async def book(self, slot: TeeTimeSlot, details: BookingDetails) -> BookingResult:
        """
        Attempt to book the slot.
        Phase 1 providers return not_supported + a booking_url.
        Phase 2+ providers complete the booking natively.
        """
