"""
RoutedTeeTimeProvider — S1 real foreUP availability
(specs/teetime-s1-foreup-plan.md §5).

Composes over `RoutingTeeTimeProvider` (S0) via the `_slots_for_course` hook
extracted in routing.py: when a discovered course matches a known foreUP
capability, real availability (or an honest degraded/empty result) replaces
the plain S0 "book on site / call" route entry. Every other course keeps the
EXACT S0 behavior — the S0 test suite (test_tee_time_routing.py,
test_tee_time_private_filter.py) passes byte-identical.

`_slots_for_course` fallback order (pin exactly, §5c; generalized to any
platform in S4a — specs/teetime-availability-everywhere-plan.md §6):

  1. `not foreup_enabled` or no capability match -> S0 route entry
     (unchanged behavior).
  2. `cap.is_private` -> `[]` (excluded entirely — the capability fact record
     supersedes the name-list private filter).
  3. No adapter registered for `cap.platform` (unknown platform, or that
     engine disabled via `TEETIME_ENGINES`) -> S0 route entry (byte-identical
     — same as "no capability match").
  4. `adapter.slots_for_capability(...)` returns a non-empty list -> those
     real slots (provider=<engine>, route=None, real time).
  5. Returns `[]` (verified empty) -> OMIT the course. We have real data
     saying nothing is open in that window at that party size — a
     "book on site" entry would send the golfer to a page with no times.
  6. Returns `None` (couldn't check: breaker open / rate-limited / timeout /
     4xx-5xx / parse failure) -> degraded S0 route entry, but with
     `booking_url = cap.booking_url` (the engine's own booking page is the
     best real deep-link we have) and `phone = cap.phone or entry.phone`.

`TEETIME_FOREUP_ENABLED=0` is the ORIGINAL S1 kill switch — reverts the
whole surface to exact S0 behavior with one env var (unchanged). S4a adds
`TEETIME_ENGINES` (comma-separated platform allowlist, default = all
registered adapters) as the per-engine generalization of the same idea: an
engine not in the allowlist behaves exactly like "no adapter" (step 3 above).

S4e (specs/teetime-availability-everywhere-plan.md §5, §6) adds rung 3: any
of the above steps that resolves to an S0 route entry with `route == "call"`
(a known phone, no cleaner rung) is checked against the `availability_by_call`
cache — a PRIOR user-initiated ask-mode phone call for this exact
course/date/window/party (POST /api/tee-times/availability-call). This is a
READ ONLY check: nothing here ever places a call, and a miss (or a call that
couldn't confirm anything — voicemail/no_answer/unclear) returns the exact
same honest "call" entry as before. Only kicks in while the foreUP kill
switch is on (`TEETIME_FOREUP_ENABLED=0` still reverts to byte-identical S0,
per the original invariant above).

S4f (specs/teetime-s4f-coverage-flywheel-plan.md §1) adds ONE fire-and-forget
side effect to `_slots_for_course`: every per-course outcome it already
classifies is recorded to `search_telemetry.py` — never raises into this
path, never awaits, never changes a returned slot. See `_record_outcome`
below; the outcome mapping is documented at each call site.
"""

from __future__ import annotations

import logging
import os

from app.services.voice_booking.provider import VoiceCallProvider

from .adapters.chronogolf import ChronogolfProvider
from .adapters.clubprophet import ClubProphetProvider
from .adapters.quick18 import Quick18Provider
from .adapters.teeitup import TeeItUpProvider
from .availability_call_cache import (
    AvailabilityCallCacheStore,
    FileAvailabilityCallCacheStore,
    availability_cache_key,
)
from .base import BookingDetails, BookingResult, TeeTimeProvider, TeeTimeQuery, TeeTimeSlot
from .capability_store import CourseBookingCapability, load_all_capabilities, match_capability
from .foreup import ForeUpProvider
from .routing import CourseFinder, RoutingTeeTimeProvider, build_route_entry
from .search_telemetry import SearchOutcome, SearchTelemetryStore, default_search_telemetry_store

log = logging.getLogger(__name__)

# Platform -> adapter instance. Every adapter implements the same contract as
# `ForeUpProvider.slots_for_capability` (specs/teetime-availability-everywhere
# -plan.md §6). Module-level singletons (own per-host limiter/breaker/cache
# per adapter, as built above) — RoutedTeeTimeProvider takes explicit
# `foreup`/`teeitup`/`chronogolf` instances in its constructor for tests, but
# production code (and any platform this constructor doesn't know about yet)
# reads this registry so adding an engine never requires touching
# `_slots_for_course`.
ADAPTERS: dict[str, TeeTimeProvider] = {
    "foreup": ForeUpProvider(),
    "teeitup": TeeItUpProvider(),
    "chronogolf": ChronogolfProvider(),
    "clubprophet": ClubProphetProvider(),
    "quick18": Quick18Provider(),
}


def _enabled_engines() -> set[str] | None:
    """`TEETIME_ENGINES` allowlist (comma-separated platform names). `None`
    means "no restriction" (every registered adapter is enabled) — the
    default, so adding a new adapter to `ADAPTERS` doesn't require an env
    change to activate it."""
    raw = os.getenv("TEETIME_ENGINES")
    if raw is None:
        return None
    names = {n.strip() for n in raw.split(",") if n.strip()}
    return names


class RoutedTeeTimeProvider(RoutingTeeTimeProvider):
    """S0 routing, upgraded to real foreUP availability where a booking
    capability is known. New route-cache namespace (`name == "router"`) — old
    "routing"-keyed 15-min search-cache entries simply become unreachable."""

    def __init__(
        self,
        find_courses: CourseFinder | None = None,
        *,
        foreup: ForeUpProvider | None = None,
        teeitup: TeeItUpProvider | None = None,
        chronogolf: ChronogolfProvider | None = None,
        clubprophet: ClubProphetProvider | None = None,
        adapters: dict[str, TeeTimeProvider] | None = None,
        capabilities=None,
        foreup_enabled: bool | None = None,
        engines_enabled: set[str] | None = None,
        voice: TeeTimeProvider | None = None,
        voice_enabled: bool | None = None,
        availability_cache: AvailabilityCallCacheStore | None = None,
        telemetry: SearchTelemetryStore | None = None,
    ) -> None:
        super().__init__(find_courses)
        self._foreup = foreup or ForeUpProvider()
        self._teeitup = teeitup or TeeItUpProvider()
        self._chronogolf = chronogolf or ChronogolfProvider()
        self._clubprophet = clubprophet or ClubProphetProvider()
        # Platform -> adapter, seeded from the module registry (so any future
        # adapter added to ADAPTERS is picked up automatically) then
        # overridden with THIS instance's own foreup/teeitup/chronogolf
        # (constructor-injectable, e.g. FakeForeUp in tests) and any explicit
        # `adapters` override.
        self._adapters: dict[str, TeeTimeProvider] = {
            **ADAPTERS,
            "foreup": self._foreup,
            "teeitup": self._teeitup,
            "chronogolf": self._chronogolf,
            "clubprophet": self._clubprophet,
            **(adapters or {}),
        }
        self._capabilities = capabilities or load_all_capabilities
        self._foreup_enabled = (
            foreup_enabled
            if foreup_enabled is not None
            else os.getenv("TEETIME_FOREUP_ENABLED", "1") != "0"
        )
        # TEETIME_ENGINES allowlist (S4a generalization of the same idea, one
        # level finer-grained): `None` = no restriction, every adapter in
        # `self._adapters` is enabled.
        self._engines_enabled = (
            engines_enabled if engines_enabled is not None else _enabled_engines()
        )
        # AI phone-call booking route (S3). Empty allowlist by default →
        # VoiceCallProvider refuses every number (needs_human) until an owner-
        # verified pro-shop landline is loaded. TODO(S3b): load owner-verified
        # lines from VOICE_BOOKING_VERIFIED_LINES (comma-separated) once a real
        # line is verified + attorney sign-off.
        self._voice = voice or VoiceCallProvider()
        self._voice_enabled = (
            voice_enabled
            if voice_enabled is not None
            else os.getenv("VOICE_BOOKING_ENABLED") == "1"
        )
        # S4e rung-3 (read-only cache of prior user-initiated availability-ask
        # calls). Defaults to the file-backed store shared with the trigger
        # endpoint (routes/tee_times.py) — injectable for tests.
        self._availability_cache = availability_cache or FileAvailabilityCallCacheStore()
        # S4f coverage flywheel (fire-and-forget per-course outcome
        # telemetry). Defaults to the MODULE-LEVEL singleton — not a fresh
        # per-instance store — because `routes/tee_times.py:_get_provider()`
        # constructs a new `RoutedTeeTimeProvider()` per request; a
        # per-instance store would defeat in-memory dedup/debounce.
        self._telemetry = telemetry or default_search_telemetry_store()

    @property
    def name(self) -> str:
        return "router"

    async def _slots_for_course(
        self, course: dict, query: TeeTimeQuery, distance: float
    ) -> list[TeeTimeSlot]:
        if not self._foreup_enabled:
            # Kill switch reverts to byte-identical S0 — no telemetry (S4f
            # plan §1a): recording a disabled system would poison the metric.
            return await super()._slots_for_course(course, query, distance)

        capability_lookup_failed = False
        try:
            caps: tuple[CourseBookingCapability, ...] = self._capabilities()
            cap = match_capability(course, caps)
        except Exception:
            log.warning("router_provider: capability lookup failed — falling back to S0", exc_info=True)
            cap = None
            capability_lookup_failed = True

        if cap is None:
            if not capability_lookup_failed:
                # A genuine "no known capability" fact — this IS the S4f
                # probe-feed queue. (An internal lookup failure above is NOT
                # a coverage fact, so it records nothing.)
                self._record_outcome(course, "no_capability")
            return await self._with_availability_cache(
                course, query, await super()._slots_for_course(course, query, distance)
            )

        if cap.is_private:
            self._record_outcome(course, "private", platform=cap.platform)
            return []  # capability fact record supersedes the name-list filter

        adapter = self._adapters.get(cap.platform)
        if adapter is None or (
            self._engines_enabled is not None and cap.platform not in self._engines_enabled
        ):
            # No adapter for this platform, or the engine is disabled via
            # TEETIME_ENGINES — behave exactly like "no capability match".
            # Reported separately from no_capability: probing can't help here.
            self._record_outcome(course, "no_adapter", platform=cap.platform)
            return await self._with_availability_cache(
                course, query, await super()._slots_for_course(course, query, distance)
            )

        try:
            real_slots = await adapter.slots_for_capability(
                cap, query, distance_miles=distance, course=course,
            )
        except Exception:
            log.warning("router_provider: slots_for_capability raised — degrading", exc_info=True)
            real_slots = None

        if real_slots:
            self._record_outcome(course, "real_availability", platform=cap.platform)
            return real_slots

        if real_slots == []:
            # Verified empty — omit the course rather than imply availability.
            self._record_outcome(course, "verified_empty", platform=cap.platform)
            return []

        # real_slots is None — couldn't check. Degrade to the S0 route entry,
        # but point it at the best real deep-link/phone we have.
        self._record_outcome(course, "couldnt_check", platform=cap.platform)
        entry = build_route_entry(course, query, distance)
        if entry is None:
            return []
        entry.booking_url = cap.booking_url
        entry.phone = cap.phone or entry.phone
        entry.route = "book_on_site"
        return [entry]

    def _record_outcome(
        self, course: dict, outcome: SearchOutcome, platform: str | None = None
    ) -> None:
        """Fire-and-forget (S4f plan §1b): NEVER raises, never awaits, never
        alters the result. The store's own `_save` already swallows failures
        — this is belt-and-suspenders."""
        try:
            self._telemetry.record(course, outcome, platform=platform)
        except Exception:
            log.debug("search_telemetry: record failed (ignored)", exc_info=True)

    async def _with_availability_cache(
        self, course: dict, query: TeeTimeQuery, entries: list[TeeTimeSlot]
    ) -> list[TeeTimeSlot]:
        """S4e rung-3 (plan §6): an S0 `route == "call"` entry (known phone,
        no reachable clean engine) is checked against the `availability_by_call`
        cache — a prior user-initiated ask-mode call for this EXACT
        course/date/window/party. Read-only: this NEVER places a call.

          - no cache hit, or the call couldn't confirm anything (voicemail /
            no_answer / unclear / an "availability" outcome with zero times
            spoken) -> the entry is returned UNCHANGED (today's honest "call"
            CTA — the frontend's retry/poll affordance still applies).
          - outcome == "no_availability" -> verified empty for this exact
            window -> omit the course, same as a live-API verified empty.
          - outcome == "availability" with spoken times -> real TeeTimeSlots,
            provider="voice_call", route="call" RETAINED (so booking can still
            hand off / re-confirm by phone), status="live",
            checked_via="voice_call", checked_at=<called_at> so the UI can
            label "confirmed by phone at 2:14 PM".

        Entries that are NOT a call route (book_on_site, or no phone) pass
        through unchanged — there's nothing for rung 3 to add."""
        if len(entries) != 1:
            return entries
        entry = entries[0]
        if entry.route != "call" or not entry.phone:
            return entries

        key = availability_cache_key(
            entry.course_id, query.date, query.time_window_start,
            query.time_window_end, query.party_size,
        )
        try:
            record = self._availability_cache.get(key)
        except Exception:
            log.warning("router_provider: availability_call_cache read failed", exc_info=True)
            return entries
        if record is None:
            return entries

        if record.outcome == "no_availability":
            return []  # verified empty for this window — don't imply availability

        if record.outcome == "availability" and record.slots_spoken:
            return [
                TeeTimeSlot(
                    id=f"{entry.course_id}-{query.date}-call-{i}",
                    course_id=entry.course_id,
                    course_name=entry.course_name,
                    city=entry.city,
                    date=query.date,
                    time=spoken.time,
                    players=query.party_size,
                    price_usd=spoken.price_usd,
                    cart_included=False,
                    distance_miles=entry.distance_miles,
                    rating=entry.rating,
                    designer=entry.designer,
                    provider="voice_call",
                    holes=entry.holes,
                    booking_url=entry.booking_url,
                    route="call",
                    phone=entry.phone,
                    status="live",
                    checked_via="voice_call",
                    checked_at=record.called_at,
                )
                for i, spoken in enumerate(record.slots_spoken)
            ]

        # voicemail / no_answer / unclear / not_enabled, or "availability"
        # with zero slots spoken — couldn't confirm anything specific. Honest
        # empty via the unchanged call CTA (route=="call" + phone + retry).
        return entries

    async def book(self, slot: TeeTimeSlot, details: BookingDetails) -> BookingResult:
        # A real-inventory slot (provider == a platform key, e.g. "foreup" /
        # "teeitup") always books through its own adapter.
        adapter = self._adapters.get(slot.provider)
        if adapter is not None:
            return await adapter.book(slot, details)
        # S3: a phone-only course (route=="call" + a known number) books via
        # the AI caller. Gated on VOICE_BOOKING_ENABLED so, when disabled (the
        # default), this path is inert and book() stays byte-identical to S0's
        # honest handoff — and never grows the S0 path a network side-effect.
        if self._voice_enabled and slot.route == "call" and slot.phone:
            return await self._voice.book(slot, details)
        return await super().book(slot, details)
