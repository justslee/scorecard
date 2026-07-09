"""
RoutedTeeTimeProvider — S1 real foreUP availability
(specs/teetime-s1-foreup-plan.md §5).

Composes over `RoutingTeeTimeProvider` (S0) via the `_slots_for_course` hook
extracted in routing.py: when a discovered course matches a known foreUP
capability, real availability (or an honest degraded/empty result) replaces
the plain S0 "book on site / call" route entry. Every other course keeps the
EXACT S0 behavior — the S0 test suite (test_tee_time_routing.py,
test_tee_time_private_filter.py) passes byte-identical.

`_slots_for_course` fallback order (pin exactly, §5c):

  1. `not foreup_enabled` or no capability match -> S0 route entry
     (unchanged behavior).
  2. `cap.is_private` -> `[]` (excluded entirely — the capability fact record
     supersedes the name-list private filter).
  3. `slots_for_capability(...)` returns a non-empty list -> those real
     slots (provider="foreup", route=None, real time).
  4. Returns `[]` (verified empty) -> OMIT the course. We have real data
     saying nothing is open in that window at that party size — a
     "book on site" entry would send the golfer to a page with no times.
  5. Returns `None` (couldn't check: breaker open / rate-limited / timeout /
     4xx-5xx / parse failure) -> degraded S0 route entry, but with
     `booking_url = cap.booking_url` (the foreUP page is the best real
     deep-link we have) and `phone = cap.phone or entry.phone`.

`TEETIME_FOREUP_ENABLED=0` is the kill switch — reverts the whole surface to
exact S0 behavior with one env var.
"""

from __future__ import annotations

import logging
import os

from .base import BookingDetails, BookingResult, TeeTimeQuery, TeeTimeSlot
from .capability_store import CourseBookingCapability, load_capabilities, match_capability
from .foreup import ForeUpProvider
from .routing import CourseFinder, RoutingTeeTimeProvider, build_route_entry

log = logging.getLogger(__name__)


class RoutedTeeTimeProvider(RoutingTeeTimeProvider):
    """S0 routing, upgraded to real foreUP availability where a booking
    capability is known. New route-cache namespace (`name == "router"`) — old
    "routing"-keyed 15-min search-cache entries simply become unreachable."""

    def __init__(
        self,
        find_courses: CourseFinder | None = None,
        *,
        foreup: ForeUpProvider | None = None,
        capabilities=None,
        foreup_enabled: bool | None = None,
    ) -> None:
        super().__init__(find_courses)
        self._foreup = foreup or ForeUpProvider()
        self._capabilities = capabilities or load_capabilities
        self._foreup_enabled = (
            foreup_enabled
            if foreup_enabled is not None
            else os.getenv("TEETIME_FOREUP_ENABLED", "1") != "0"
        )

    @property
    def name(self) -> str:
        return "router"

    async def _slots_for_course(
        self, course: dict, query: TeeTimeQuery, distance: float
    ) -> list[TeeTimeSlot]:
        if not self._foreup_enabled:
            return await super()._slots_for_course(course, query, distance)

        try:
            caps: tuple[CourseBookingCapability, ...] = self._capabilities()
            cap = match_capability(course, caps)
        except Exception:
            log.warning("router_provider: capability lookup failed — falling back to S0", exc_info=True)
            cap = None

        if cap is None:
            return await super()._slots_for_course(course, query, distance)

        if cap.is_private:
            return []  # capability fact record supersedes the name-list filter

        try:
            real_slots = await self._foreup.slots_for_capability(
                cap, query, distance_miles=distance, course=course,
            )
        except Exception:
            log.warning("router_provider: slots_for_capability raised — degrading", exc_info=True)
            real_slots = None

        if real_slots:
            return real_slots

        if real_slots == []:
            # Verified empty — omit the course rather than imply availability.
            return []

        # real_slots is None — couldn't check. Degrade to the S0 route entry,
        # but point it at the best real deep-link/phone we have.
        entry = build_route_entry(course, query, distance)
        if entry is None:
            return []
        entry.booking_url = cap.booking_url
        entry.phone = cap.phone or entry.phone
        entry.route = "book_on_site"
        return [entry]

    async def book(self, slot: TeeTimeSlot, details: BookingDetails) -> BookingResult:
        if slot.provider == "foreup":
            return await self._foreup.book(slot, details)
        return await super().book(slot, details)
