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

from .selection import CourseSelector


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
    # Backend-internal (never set by a route param directly): resolved by the
    # route from course_ids (selection.resolve_selectors) before the provider
    # is called. Providers must treat None as "derive id-only selectors from
    # course_ids" (specs/teetime-course-ids-wiring-plan.md §3.4).
    course_selectors: list[CourseSelector] | None = None


@dataclass
class TeeTimeSlot:
    id: str                          # "courseId-date-time-index"
    course_id: str
    course_name: str
    city: str
    date: str                        # YYYY-MM-DD
    time: str                        # "HH:MM", or "" when no real time is known (routing)
    players: int                     # available slots (1–4)
    price_usd: float | None          # None = unknown (routing) — NEVER fabricated
    cart_included: bool
    distance_miles: float
    rating: float                    # 0–5 (0 = unknown)
    provider: str                    # "mock" | "routing" | "foreup" | "golfnow" | "chronogolf"
    holes: Literal[9, 18]
    designer: str | None = None
    booking_url: str | None = None   # deep-link for Routing / Phase 1
    # DEPRECATED (S0): no provider sets this True anymore — the "estimated
    # window" design was replaced by honest `time=""` + `route`. Kept (default
    # False) to avoid touching booking-rehydration/ICS/mock-test surfaces this
    # slice; scheduled for deletion in the S1 cleanup.
    estimated: bool = False
    # How this entry gets booked: "book_on_site" (course website known — deep-
    # link handoff), "call" (no website — phone the pro shop), or None (the
    # provider knows real availability — mock and foreup today, more live
    # inventory providers in later slices).
    route: Literal["book_on_site", "call"] | None = None
    # The pro shop's phone number (Places nationalPhoneNumber / OSM phone tag),
    # when known — powers a real `tel:` link on `route == "call"` entries.
    # None when unknown; the UI must never render a tappable-looking button
    # without a real number behind it.
    phone: str | None = None
    # S4e (specs/teetime-availability-everywhere-plan.md §6): "live" is every
    # slot today (default, unchanged). "pending" is reserved for a rung-2b
    # in-flight scrape ("checking live availability…") — `time=""`, no price,
    # explicitly a STATE, never a slot. Additive/default-compatible.
    status: Literal["live", "pending"] = "live"
    # Provenance for a phone-confirmed slot (provider == "voice_call"): which
    # channel verified this and when, so the UI can label "confirmed by phone
    # at 2:14 PM". None for every other provider.
    checked_via: str | None = None
    checked_at: str | None = None   # ISO-8601 UTC of the call/probe


@dataclass
class BookingDetails:
    name: str
    party_size: int
    email: str | None = None
    phone: str | None = None
    # The golfer's REQUESTED search window (honest data echoed from the query,
    # never a fabricated time). Used by the voice-call booking path when the
    # routed slot itself carries no time (`slot.time == ""`, the S0 default) —
    # the agent asks the pro shop for "anything between start and end".
    time_window_start: str | None = None   # "HH:MM" 24h
    time_window_end: str | None = None


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
