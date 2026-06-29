"""
MockTeeTimeProvider — Phase 1 placeholder.

Generates deterministic, realistic availability for a small set of courses.
Clearly labelled provider="mock" so the API response can be labelled "Demo data."

Cache-first: results are cached per query key for the lifetime of the process.
A real provider replaces this with an HTTP call + cache layer (e.g. Redis / in-memory
TTL cache) — the cache key and slot shape stay the same.

This is the seam real providers slot into:
  - Replace MockTeeTimeProvider in tee_times.py with ChronogolfProvider (or GolfNowProvider).
  - The route, schema, and UI require no changes.
"""

from __future__ import annotations

import json
from urllib.parse import quote

from .base import (
    BookingDetails,
    BookingResult,
    TeeTimeProvider,
    TeeTimeQuery,
    TeeTimeSlot,
)


# ─── Course catalogue ──────────────────────────────────────────────────────────

_COURSES = [
    dict(id="presidio",       name="Presidio Golf Course",            city="San Francisco, CA", dist=4.1,  rating=4.3, designer="Robert Trent Jones Jr.", base_price=86,  cart=False, holes=18),
    dict(id="harding",        name="Harding Park",                    city="San Francisco, CA", dist=6.8,  rating=4.5, designer="Willie Watson",           base_price=145, cart=False, holes=18),
    dict(id="lincoln",        name="Lincoln Park Golf Course",         city="San Francisco, CA", dist=5.2,  rating=3.9, designer=None,                      base_price=52,  cart=False, holes=18),
    dict(id="sharp",          name="Sharp Park Golf Course",           city="Pacifica, CA",      dist=12.4, rating=3.6, designer="Alister MacKenzie",       base_price=38,  cart=False, holes=18),
    dict(id="bethpage-black", name="Bethpage State Park — Black",     city="Farmingdale, NY",   dist=31.2, rating=4.8, designer="A.W. Tillinghast",         base_price=95,  cart=False, holes=18),
    dict(id="crystal-springs",name="Crystal Springs Golf Course",     city="San Bruno, CA",     dist=16.7, rating=3.8, designer=None,                      base_price=65,  cart=True,  holes=18),
]


# ─── Helpers ───────────────────────────────────────────────────────────────────

def _to_minutes(hhmm: str) -> int:
    h, m = (int(x) for x in hhmm.split(":"))
    return h * 60 + m


def _from_minutes(mins: int) -> str:
    h = (mins // 60) % 24
    m = mins % 60
    return f"{h:02d}:{m:02d}"


def _seeded_random(seed_str: str):
    """LCG PRNG seeded from a string — deterministic, not cryptographic."""
    h = 0
    for ch in seed_str:
        h = (31 * h + ord(ch)) & 0xFFFF_FFFF
    state = [h]

    def _rand() -> float:
        state[0] = (1_664_525 * state[0] + 1_013_904_223) & 0xFFFF_FFFF
        return state[0] / 0x1_0000_0000

    return _rand


def _cache_key(query: TeeTimeQuery) -> str:
    return json.dumps({
        "date": query.date,
        "start": query.time_window_start,
        "end": query.time_window_end,
        "party": query.party_size,
        "ids": sorted(query.course_ids),
        "area": query.area,
    }, sort_keys=True)


# ─── Provider ──────────────────────────────────────────────────────────────────

_CACHE: dict[str, list[TeeTimeSlot]] = {}


class MockTeeTimeProvider(TeeTimeProvider):
    """Phase 1 mock — generates deterministic availability; never calls the network."""

    @property
    def name(self) -> str:
        return "mock"

    async def search_availability(self, query: TeeTimeQuery) -> list[TeeTimeSlot]:
        key = _cache_key(query)
        if key in _CACHE:
            return _CACHE[key]
        slots = _generate(query)
        _CACHE[key] = slots
        return slots

    async def book(self, slot: TeeTimeSlot, _details: BookingDetails) -> BookingResult:
        suffix = slot.id[-6:].upper()
        return BookingResult(
            status="confirmed",
            confirmation_number=f"MOCK-{suffix}",
            message="Mock booking confirmed. No real reservation was made.",
        )


def _generate(query: TeeTimeQuery) -> list[TeeTimeSlot]:
    rng = _seeded_random(_cache_key(query))
    start_min = _to_minutes(query.time_window_start)
    end_min = _to_minutes(query.time_window_end)
    window = end_min - start_min
    if window <= 0:
        return []

    eligible = [
        c for c in _COURSES
        if (not query.course_ids or c["id"] in query.course_ids)
        and (query.max_distance_miles is None or c["dist"] <= query.max_distance_miles)
    ]

    slots: list[TeeTimeSlot] = []
    for course in eligible:
        count = 2 + int(rng() * 3)
        used: set[int] = set()
        for i in range(count):
            # 8-minute interval slots.
            intervals = max(1, window // 8)
            offset = int(rng() * intervals) * 8
            while offset in used and len(used) < intervals:
                offset = (offset + 8) % (intervals * 8)
            used.add(offset)
            tee_min = start_min + offset
            if tee_min >= end_min:
                continue

            avail = int(rng() * (4 - query.party_size + 1))
            player_slots = min(4, max(query.party_size, query.party_size + avail))

            price_var = 0.85 + rng() * 0.30
            price_usd = round(course["base_price"] * price_var, 2)
            if query.max_price_usd is not None and price_usd > query.max_price_usd:
                continue

            time_str = _from_minutes(tee_min)
            slot_id = f"{course['id']}-{query.date}-{time_str}-{i}"

            slots.append(TeeTimeSlot(
                id=slot_id,
                course_id=course["id"],
                course_name=course["name"],
                city=course["city"],
                date=query.date,
                time=time_str,
                players=player_slots,
                price_usd=price_usd,
                cart_included=course["cart"],
                distance_miles=course["dist"],
                rating=course["rating"],
                designer=course.get("designer"),
                provider="mock",
                holes=course["holes"],  # type: ignore[arg-type]
                booking_url=f"https://www.golfnow.com/tee-times/facility/{quote(course['name'])}/search",
            ))

    # Sort by distance, then time.
    slots.sort(key=lambda s: (s.distance_miles, s.time))
    return slots
