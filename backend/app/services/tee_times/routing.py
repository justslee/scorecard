"""
RoutingTeeTimeProvider — S0 "kill fake data" (specs/teetime-s0-plan.md).

Finds REAL nearby golf courses (via the shared course-finder service: OSM
nearby search, Google Places text search, Mapbox geocoding fallback) and
emits ONE route-tagged entry per discovered PUBLIC course per requested
window:

  - `time = ""` — NO fabricated time. This slice never invents a tee time;
    a later slice (real inventory / foreUP) fills in verified times.
  - `price_usd=None` — we NEVER fabricate a price.
  - `booking_url` = the course website (Google Places websiteUri) when known.
  - `route` = "book_on_site" when a website is known, else "call" — tells the
    UI whether the golfer deep-links out or has to phone the pro shop.
  - `phone` = the pro shop's number (Places nationalPhoneNumber / OSM phone
    tag) when known — powers a real `tel:` link for `route == "call"` entries.

Pipeline: discover -> selector-centered discovery -> dedupe_by_name ->
private filter -> cap at MAX_COURSES -> sort by (distance, name). The
private filter (private_filter.py) runs BEFORE the cap so a private club
never consumes a result slot.

Selector-centered discovery (specs/course-selection-ux-plan.md §A2.4): when
the golfer explicitly selected/named a course whose resolved center sits
OUTSIDE the GPS-radius discovery set, one extra `_find_courses` call is run
centered on that selector and the result is ADDITIVELY MERGED in — fixes
the "Marine Park from Pittsburgh" bug, where `course_ids` used to only
FILTER a GPS-radius set that never contained the named course. Distance
stays honest: always measured from the golfer's real GPS origin, never the
selector's own search center. Invariant: a pure "near me" search (no
`course_ids`/selectors) is unaffected BYTE-FOR-BYTE — the widening is a
strict no-op unless a selector center sits outside both the GPS radius and
the already-discovered set.

book() never completes a reservation: it returns `needs_human` with the
booking URL (or a call instruction) so the golfer finishes on the course's
own booking page or by phone.

LEGAL POSTURE (see specs/tee-time-booking-plan.md): we never present invented
times/prices as live availability, and we never claim a reservation was made.
"""

from __future__ import annotations

import logging
import math
import re
from dataclasses import replace
from typing import Awaitable, Callable

from app.services import course_finder
from app.services.osm import search_golf_courses

from .base import (
    BookingDetails,
    BookingResult,
    TeeTimeProvider,
    TeeTimeQuery,
    TeeTimeSlot,
)
from .private_filter import exclude_private
from .selection import CourseSelector, matches_selection

log = logging.getLogger(__name__)

# One route-tagged entry per course; keep the list calm and scannable.
MAX_COURSES = 8

# Nearby-search radius when the query has no explicit distance preference.
DEFAULT_RADIUS_MILES = 15.0
_METERS_PER_MILE = 1609.344

# Selector-centered discovery radius (miles) — `_radius_meters` below clamps
# a 5_000 m floor, so 3.1 mi (~4_989 m) yields the same ~5 km "around" radius
# `osm.py search_golf_courses` uses. Deliberately tight: this is a targeted
# "is the named course actually near this point" probe, not a wide sweep.
SELECTOR_DISCOVERY_RADIUS_MILES = 3.1

# A course finder returns (courses, origin): normalized course dicts
# ({id, name, address?, center{lat,lng}, website?, phone?, rating?}) plus the
# search origin (lat, lng) when known — used for honest distance computation.
CourseFinder = Callable[[TeeTimeQuery], Awaitable[tuple[list[dict], tuple[float, float] | None]]]

_LATLNG_RE = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$")


def _parse_latlng(area: str | None) -> tuple[float, float] | None:
    """Parse an `area` of the form "37.79,-122.46" into (lat, lng)."""
    if not area:
        return None
    m = _LATLNG_RE.match(area)
    if not m:
        return None
    lat, lng = float(m.group(1)), float(m.group(2))
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None
    return lat, lng


def _haversine_miles(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in miles."""
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = rlat2 - rlat1
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(a))


def _radius_meters(max_distance_miles: float | None) -> int:
    miles = max_distance_miles if max_distance_miles else DEFAULT_RADIUS_MILES
    return int(max(5_000, min(50_000, miles * _METERS_PER_MILE)))


def _selectors_for_query(query: TeeTimeQuery) -> list[CourseSelector]:
    """The same course_ids -> selector fallback the selection filter has
    always used, built ONCE so selector-centered discovery and the filter
    itself see the identical list (never recomputed twice, never drift)."""
    if not query.course_ids:
        return []
    return query.course_selectors or [CourseSelector(id=i) for i in query.course_ids]


def build_route_entry(course: dict, query: TeeTimeQuery, distance: float) -> TeeTimeSlot | None:
    """Build the S0 route-tagged entry for one discovered course. Returns
    `None` for a course missing an id or a name (skip it). Extracted
    (specs/teetime-s1-foreup-plan.md §5a) so `RoutedTeeTimeProvider` can reuse
    the exact same "no fabricated time" entry as its degraded fallback —
    behavior here is byte-identical to the original inline S0 loop body.
    """
    course_id = str(course.get("id") or course.get("osm_id") or "")
    name = (course.get("name") or "").strip()
    if not course_id or not name:
        return None

    rating = course.get("rating")
    website = course.get("website")
    return TeeTimeSlot(
        id=f"{course_id}-{query.date}-route",
        course_id=course_id,
        course_name=name,
        city=course.get("address") or "",
        date=query.date,
        time="",                     # NO fabricated time — S1 fills real times.
        players=query.party_size,    # echo of the request, never claimed capacity
        price_usd=None,               # unknown — never fabricated
        cart_included=False,
        distance_miles=distance,
        rating=float(rating) if rating is not None else 0.0,
        designer=None,
        provider="routing",
        holes=18,
        booking_url=website,
        estimated=False,
        route="book_on_site" if website else "call",
        phone=course.get("phone"),
    )


async def _default_find_courses(
    query: TeeTimeQuery,
) -> tuple[list[dict], tuple[float, float] | None]:
    """Find real courses for the query's area.

    - "lat,lng" area → OSM nearby search around that point.
    - place-name area → Google Places text search ("golf courses near <area>"),
      falling back to Mapbox geocode → OSM nearby.
    - no area → no courses (the route returns an empty result set).
    """
    origin = _parse_latlng(query.area)
    if origin is not None:
        lat, lng = origin
        courses = await search_golf_courses(
            lat=lat, lng=lng, radius_m=_radius_meters(query.max_distance_miles)
        )
        return course_finder.dedupe_by_name(courses), origin

    if query.area:
        places = await course_finder.search_google_places(f"golf courses near {query.area}")
        if places:
            top = places[0]["center"]
            return course_finder.dedupe_by_name(places), (top["lat"], top["lng"])
        geocoded = await course_finder.search_mapbox(query.area)
        if geocoded:
            center = geocoded[0]["center"]
            courses = await search_golf_courses(
                lat=center["lat"], lng=center["lng"],
                radius_m=_radius_meters(query.max_distance_miles),
            )
            return course_finder.dedupe_by_name(courses), (center["lat"], center["lng"])

    return [], None


class RoutingTeeTimeProvider(TeeTimeProvider):
    """Real courses, no fabricated time, booking routed to the site or a call."""

    def __init__(self, find_courses: CourseFinder | None = None) -> None:
        # Injectable for tests; defaults to the real course-finder chain.
        self._find_courses = find_courses or _default_find_courses

    @property
    def name(self) -> str:
        return "routing"

    async def _slots_for_course(
        self, course: dict, query: TeeTimeQuery, distance: float
    ) -> list[TeeTimeSlot]:
        """Hook (specs/teetime-s1-foreup-plan.md §5a): S0's per-course entry.
        `RoutedTeeTimeProvider` overrides this to check a foreUP capability
        first, falling back to this exact behavior when none is known."""
        entry = build_route_entry(course, query, distance)
        return [entry] if entry else []

    async def _discover_selector_courses(
        self,
        query: TeeTimeQuery,
        courses: list[dict],
        origin: tuple[float, float] | None,
        selectors: list[CourseSelector],
    ) -> list[dict]:
        """Additive-merge selector-centered discovery. For each selector
        with a resolved center, run one extra `_find_courses` call centered
        on it UNLESS the center is already covered — inside the GPS radius,
        or already matched by a discovered course. Returns `courses`
        unchanged (same list, no dedupe pass) when nothing was added, so a
        pure "near me" search (empty `selectors`) never even calls this."""
        radius_miles = query.max_distance_miles or DEFAULT_RADIUS_MILES
        extra: list[dict] = []
        for sel in selectors:
            if sel.lat is None or sel.lng is None:
                continue
            if origin is not None and _haversine_miles(origin[0], origin[1], sel.lat, sel.lng) <= radius_miles:
                continue  # already inside the GPS-radius discovery set
            if any(matches_selection(c, [sel]) for c in courses):
                continue  # already discovered (e.g. named-area search covers it)

            sub_query = replace(
                query,
                area=f"{sel.lat},{sel.lng}",
                max_distance_miles=SELECTOR_DISCOVERY_RADIUS_MILES,
                course_ids=[],
                course_selectors=None,
            )
            try:
                sel_courses, _sub_origin = await self._find_courses(sub_query)
            except Exception:
                continue  # never raise — skip this selector, keep going
            # Discard the sub-query's own origin: distance stays honest,
            # always measured from the golfer's real GPS `origin` above.
            extra.extend(sel_courses)

        if not extra:
            return courses
        return course_finder.dedupe_by_name([*courses, *extra])

    async def search_availability(self, query: TeeTimeQuery) -> list[TeeTimeSlot]:
        try:
            courses, origin = await self._find_courses(query)
        except Exception:
            # Contract: never raise — no courses means no slots.
            return []

        selectors = _selectors_for_query(query)
        if selectors:
            courses = await self._discover_selector_courses(query, courses, origin, selectors)

        courses = exclude_private(courses)

        if query.course_ids:
            filtered = [c for c in courses if matches_selection(c, selectors)]
            if courses and not filtered:
                log.info(
                    "tee_time_selection: %d selected ids matched 0 of %d discovered courses",
                    len(query.course_ids), len(courses),
                )
            courses = filtered

        slots: list[TeeTimeSlot] = []
        for course in courses[:MAX_COURSES]:
            course_id = str(course.get("id") or course.get("osm_id") or "")
            name = (course.get("name") or "").strip()
            center = course.get("center") or {}
            if not course_id or not name:
                continue

            # A course the golfer explicitly selected/named must never be
            # dropped by the distance prune — the whole point of selector-
            # centered discovery is finding it even when it's far away.
            is_selected = bool(selectors) and matches_selection(course, selectors)

            distance = 0.0
            if origin is not None and center.get("lat") is not None:
                distance = round(
                    _haversine_miles(origin[0], origin[1], center["lat"], center["lng"]), 1
                )
                if (
                    not is_selected
                    and query.max_distance_miles is not None
                    and distance > query.max_distance_miles
                ):
                    continue

            slots.extend(await self._slots_for_course(course, query, distance))

        slots.sort(key=lambda s: (s.distance_miles, s.course_name, s.time))
        return slots

    async def book(self, slot: TeeTimeSlot, _details: BookingDetails) -> BookingResult:
        """Never books on the golfer's behalf — hand off to the site or a call."""
        if slot.booking_url:
            message = (
                f"Finish booking on {slot.course_name}'s site — "
                "we found the course, they take the reservation."
            )
        else:
            message = (
                f"Call or visit {slot.course_name} to book — "
                "no online booking link is available."
            )
        return BookingResult(
            status="needs_human",
            confirmation_number=None,
            message=message,
            booking_url=slot.booking_url,
        )
