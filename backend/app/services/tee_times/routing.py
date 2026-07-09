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

Pipeline: discover -> dedupe_by_name -> private filter -> cap at
MAX_COURSES -> sort by (distance, name). The private filter (private_filter.py)
runs BEFORE the cap so a private club never consumes a result slot.

book() never completes a reservation: it returns `needs_human` with the
booking URL (or a call instruction) so the golfer finishes on the course's
own booking page or by phone.

LEGAL POSTURE (see specs/tee-time-booking-plan.md): we never present invented
times/prices as live availability, and we never claim a reservation was made.
"""

from __future__ import annotations

import math
import re
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

# One route-tagged entry per course; keep the list calm and scannable.
MAX_COURSES = 8

# Nearby-search radius when the query has no explicit distance preference.
DEFAULT_RADIUS_MILES = 15.0
_METERS_PER_MILE = 1609.344

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

    async def search_availability(self, query: TeeTimeQuery) -> list[TeeTimeSlot]:
        try:
            courses, origin = await self._find_courses(query)
        except Exception:
            # Contract: never raise — no courses means no slots.
            return []

        courses = exclude_private(courses)

        slots: list[TeeTimeSlot] = []
        for course in courses[:MAX_COURSES]:
            course_id = str(course.get("id") or course.get("osm_id") or "")
            name = (course.get("name") or "").strip()
            center = course.get("center") or {}
            if not course_id or not name:
                continue

            distance = 0.0
            if origin is not None and center.get("lat") is not None:
                distance = round(
                    _haversine_miles(origin[0], origin[1], center["lat"], center["lng"]), 1
                )
                if query.max_distance_miles is not None and distance > query.max_distance_miles:
                    continue

            rating = course.get("rating")
            website = course.get("website")
            slots.append(TeeTimeSlot(
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
            ))

        slots.sort(key=lambda s: (s.distance_miles, s.course_name))
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
