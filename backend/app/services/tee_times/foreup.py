"""
ForeUpProvider — S1 real foreUP availability (specs/teetime-s1-foreup-plan.md).

Read-only availability display against foreUP's own public, unauthenticated
`times` endpoint — the same call the course's public booking page makes. We
identify honestly (`User-Agent: Looper/1.0 (golf tee-time availability)`), poll at
low frequency (≤10 req/min per host, 8-minute cache, one poll per
course/date/party), never log in, never solve CAPTCHAs, never book or charge, and
back off via a circuit breaker on any 4xx/bot signal. Risk is LOW but not zero
(browse-wrap ToS); a foreUP vendor-API application is filed in parallel
(specs/teetime-real-booking-plan.md, "Legal posture").

Field mapping note: the live capture (backend/tests/fixtures/foreup_18mile_times.json,
captured via scripts/validate_foreup_courses.py --capture-fixture) confirmed the
green-fee key is `green_fee` (numeric, or JSON `false` when unset) — see §3d.

Fetch path (inside `slots_for_capability`): availability cache (8 min,
key=booking_id/schedule_id/date/players) → single-flight → per-host rate
limiter → circuit breaker → httpx GET → parse JSON array → normalize the full
day (date + party filtered) → cache → per-call window/price filter + sort +
truncate. Never raises — every external call sits under a catch-all that
returns `None` ("couldn't check").

The shared politeness stack (circuit breaker, single-flight, honest UA,
timeout, `false`-instead-of-null coercion guards) now lives in
`fetch_discipline.py` (specs/teetime-availability-everywhere-plan.md §3) —
this module imports it rather than defining it; every foreUP behavior below
is byte-identical to before that extraction.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import Callable

import httpx

from app.services.rate_limit import SlidingWindowLimiter

from .base import (
    BookingDetails,
    BookingResult,
    TeeTimeProvider,
    TeeTimeQuery,
    TeeTimeSlot,
)
from .capability_store import CourseBookingCapability, load_capabilities
from .fetch_discipline import (
    AVAILABILITY_CACHE_TTL_S,
    REQUEST_TIMEOUT_S,
    USER_AGENT,
    CircuitBreaker,
    SingleFlight,
    _as_int,
    _as_price,
    _format_time12h,
)
from .routing import _haversine_miles, _parse_latlng
from .search_cache import FileSearchCacheStore, SearchCacheStore

log = logging.getLogger(__name__)

# ─── Module constants (pinned literals — see plan §3b) ─────────────────────────

FOREUP_HOST = "foreupsoftware.com"
TIMES_URL = "https://foreupsoftware.com/index.php/api/booking/times"
FOREUP_CACHE_TTL_S = AVAILABILITY_CACHE_TTL_S   # 8 min — inside the required 5-10 min band
FOREUP_RPM = 10                   # per-host, 60s window
MAX_SLOTS_PER_COURSE = 6          # earliest N inside the window — calm, scannable

_DATA_DIR = Path(__file__).parent.parent.parent.parent / "data"


# ─── Request builder (shared by ForeUpProvider + validate_foreup_courses.py) ──

def build_times_request(
    schedule_id: str, date_mmddyyyy: str, players: int
) -> tuple[str, dict[str, str], dict[str, str]]:
    """Return (url, params, headers) for the foreUP times GET — the exact
    request shape (§3c), used identically by ForeUpProvider and the
    validation/capture script so the fixture and live calls never drift."""
    params = {
        "time": "all",
        "date": date_mmddyyyy,
        "holes": "all",
        "players": str(players),
        "booking_class": "false",
        "schedule_id": schedule_id,
        "specials_only": "0",
        "api_key": "no_limits",
    }
    headers = {"api-key": "no_limits", "User-Agent": USER_AGENT}
    return TIMES_URL, params, headers


# `_as_int` / `_as_price` / `_format_time12h` now live in fetch_discipline.py
# (imported above) — behavior is byte-identical, just one import hop away.

# ─── Parse + normalize (§3d) ───────────────────────────────────────────────────

def _normalize_day(raw: list, *, query_date: str, party_size: int) -> list[dict]:
    """Parse the raw foreUP JSON array into cache-safe day dicts
    (`{"time": "HH:MM", "players": n, "price_usd": x|None, "holes": 9|18}`),
    date- and party-filtered so the cached entry is scoped to exactly the
    (date, players) the request was for. Never raises — malformed entries are
    skipped, not fatal.
    """
    out: list[dict] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue

        time_field = entry.get("time")
        if not isinstance(time_field, str) or " " not in time_field:
            continue
        date_part, _, time_part = time_field.partition(" ")
        if date_part != query_date:
            continue
        try:
            parsed = datetime.strptime(time_part, "%H:%M")
        except ValueError:
            continue
        hhmm = parsed.strftime("%H:%M")

        players = _as_int(entry.get("available_spots"))
        if players is None or players < party_size:
            continue

        price = _as_price(entry.get("green_fee"))

        holes_raw = entry.get("teesheet_holes")
        holes = holes_raw if holes_raw in (9, 18) else 18

        out.append({"time": hhmm, "players": players, "price_usd": price, "holes": holes})
    return out


def _emit_slots(
    day_slots: list[dict],
    cap: CourseBookingCapability,
    query: TeeTimeQuery,
    *,
    distance_miles: float,
    course: dict | None,
) -> list[TeeTimeSlot] | None:
    """Apply the post-cache filters (§3e: window, party, price) + sort +
    truncate, and build the TeeTimeSlot list. Returns `None` on a malformed
    window (never raises); `[]` is a valid "verified empty" result."""
    try:
        window_start = datetime.strptime(query.time_window_start, "%H:%M").time()
        window_end = datetime.strptime(query.time_window_end, "%H:%M").time()
    except (ValueError, TypeError):
        return None

    filtered: list[dict] = []
    for d in day_slots:
        try:
            t = datetime.strptime(d["time"], "%H:%M").time()
        except (ValueError, TypeError):
            continue
        if not (window_start <= t <= window_end):
            continue
        if d["players"] < query.party_size:
            continue
        if (
            query.max_price_usd is not None
            and d["price_usd"] is not None
            and d["price_usd"] > query.max_price_usd
        ):
            continue
        filtered.append(d)

    filtered.sort(key=lambda d: d["time"])
    filtered = filtered[:MAX_SLOTS_PER_COURSE]

    course_id = f"foreup-{cap.foreup_booking_id}"
    city = (course or {}).get("address") or ""
    rating = (course or {}).get("rating")

    slots: list[TeeTimeSlot] = []
    for i, d in enumerate(filtered):
        slots.append(TeeTimeSlot(
            id=f"{course_id}-{query.date}-{d['time']}-{i}",
            course_id=course_id,
            course_name=cap.name,
            city=city,
            date=query.date,
            time=d["time"],
            players=d["players"],
            price_usd=d["price_usd"],
            cart_included=False,
            distance_miles=distance_miles,
            rating=float(rating) if rating is not None else 0.0,
            designer=None,
            provider="foreup",
            holes=d["holes"],  # type: ignore[arg-type]
            booking_url=cap.booking_url,
            estimated=False,
            route=None,   # foreUP knows real availability — the documented
                          # meaning of route=None in base.py.
            phone=cap.phone,
        ))
    return slots


def _cache_key(cap: CourseBookingCapability, query: TeeTimeQuery) -> str:
    """Deterministic cache key (mirrors query_cache_key style). Window is
    deliberately NOT in the key — we cache the normalized FULL DAY and
    window-filter on read, which is what makes "one poll per course/date"
    true across different windows. `players` IS in the key — it's a request
    param of the verified endpoint shape (never deviate from the probed
    shape)."""
    return json.dumps({
        "v": 1,
        "booking_id": cap.foreup_booking_id,
        "schedule_id": cap.schedule_id,
        "date": query.date,
        "players": query.party_size,
    }, sort_keys=True)


# `CircuitBreaker` now lives in fetch_discipline.py (imported above) — same
# class, same behavior, byte-identical. Re-exported here so existing callers
# (tests, validate_foreup_courses.py) that import it from `foreup` keep working.

# ─── Module singletons (single host — one limiter, one breaker) ───────────────

_limiter = SlidingWindowLimiter(rpm=FOREUP_RPM, window_s=60.0)
_breaker = CircuitBreaker()


# ─── Provider ──────────────────────────────────────────────────────────────────

class ForeUpProvider(TeeTimeProvider):
    """Real foreUP tee-time availability for courses with a known booking
    capability (backend/data/foreup_ny_seed.json + foreup_validated.json)."""

    def __init__(
        self,
        capabilities: Callable[[], tuple[CourseBookingCapability, ...]] = load_capabilities,
        cache: SearchCacheStore | None = None,
        limiter: SlidingWindowLimiter | None = None,
        breaker: CircuitBreaker | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._capabilities = capabilities
        self._cache = cache or FileSearchCacheStore(
            path=_DATA_DIR / "foreup_availability_cache.json",
            ttl_seconds=FOREUP_CACHE_TTL_S,
        )
        self._limiter = limiter or _limiter
        self._breaker = breaker or _breaker
        self._transport = transport
        self._clock = clock
        self._singleflight = SingleFlight()

    @property
    def name(self) -> str:
        return "foreup"

    # ── Router-facing entry point ───────────────────────────────────────────

    async def slots_for_capability(
        self,
        cap: CourseBookingCapability,
        query: TeeTimeQuery,
        *,
        distance_miles: float = 0.0,
        course: dict | None = None,
    ) -> list[TeeTimeSlot] | None:
        """`None` = couldn't check (breaker open / rate-limited / HTTP or
        parse failure). `[]` = verified: nothing available. Never raises."""
        try:
            query_dt = datetime.strptime(query.date, "%Y-%m-%d")
        except (ValueError, TypeError):
            return None
        date_mmddyyyy = query_dt.strftime("%m-%d-%Y")

        try:
            cache_key = _cache_key(cap, query)
            day_slots = self._cache.get(cache_key)
            if day_slots is None:
                day_slots = await self._fetch_day(
                    cache_key, cap, date_mmddyyyy, query.date, query.party_size
                )
                if day_slots is None:
                    return None  # couldn't check

            return _emit_slots(
                day_slots, cap, query, distance_miles=distance_miles, course=course
            )
        except Exception:
            log.warning("foreup: slots_for_capability failed unexpectedly", exc_info=True)
            return None

    # ── Fetch path: single-flight -> rate limiter -> breaker -> HTTP ───────

    async def _fetch_day(
        self, cache_key: str, cap: CourseBookingCapability,
        date_mmddyyyy: str, query_date: str, party_size: int,
    ) -> list[dict] | None:
        async def _do() -> list[dict] | None:
            # Double-checked cache read — another flight may have resolved
            # and cached between our first `.get()` and acquiring the flight.
            cached = self._cache.get(cache_key)
            if cached is not None:
                return cached
            result = await self._do_fetch(cap, date_mmddyyyy, query_date, party_size)
            if result is not None:
                self._cache.set(cache_key, result)
            return result

        return await self._singleflight.run(cache_key, _do)

    async def _do_fetch(
        self, cap: CourseBookingCapability, date_mmddyyyy: str,
        query_date: str, party_size: int,
    ) -> list[dict] | None:
        # Rate limiter first — self-throttling is not an upstream signal, so
        # it never counts a breaker failure.
        retry_after = self._limiter.check(FOREUP_HOST)
        if retry_after is not None:
            log.info("foreup: rate-limited host=%s retry_after=%.1fs", FOREUP_HOST, retry_after)
            return None

        if not self._breaker.allow():
            return None

        url, params, headers = build_times_request(cap.schedule_id, date_mmddyyyy, party_size)
        try:
            async with httpx.AsyncClient(
                timeout=REQUEST_TIMEOUT_S, transport=self._transport
            ) as client:
                resp = await client.get(url, params=params, headers=headers)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            log.warning("foreup: request error host=%s exc=%r", FOREUP_HOST, exc)
            self._breaker.record_failure(reason="request-error")
            return None
        except Exception as exc:  # never raise out of the fetch path
            log.warning("foreup: unexpected request error host=%s exc=%r", FOREUP_HOST, exc)
            self._breaker.record_failure(reason="request-error")
            return None

        if resp.status_code != 200:
            log.warning("foreup: non-200 status=%d host=%s", resp.status_code, FOREUP_HOST)
            self._breaker.record_failure(reason=str(resp.status_code))
            return None

        try:
            data = resp.json()
        except Exception:
            log.warning("foreup: non-JSON response host=%s", FOREUP_HOST)
            self._breaker.record_failure(reason="non-json")
            return None

        if not isinstance(data, list):
            log.warning(
                "foreup: response is not a JSON array (type=%s) host=%s",
                type(data).__name__, FOREUP_HOST,
            )
            self._breaker.record_failure(reason="non-array")
            return None

        self._breaker.record_success()
        return _normalize_day(data, query_date=query_date, party_size=party_size)

    # ── Standalone provider mode (TEETIME_PROVIDER=foreup, debug only) ─────

    async def search_availability(self, query: TeeTimeQuery) -> list[TeeTimeSlot]:
        try:
            origin = _parse_latlng(query.area)
            if origin is None:
                return []
            max_dist = query.max_distance_miles if query.max_distance_miles is not None else 15.0

            results: list[TeeTimeSlot] = []
            for cap in self._capabilities():
                if cap.is_private:
                    continue
                dist = round(_haversine_miles(origin[0], origin[1], cap.lat, cap.lng), 1)
                if dist > max_dist:
                    continue
                slots = await self.slots_for_capability(cap, query, distance_miles=dist)
                if slots:
                    results.extend(slots)

            results.sort(key=lambda s: (s.distance_miles, s.course_name, s.time))
            return results
        except Exception:
            log.exception("foreup: search_availability failed — returning empty")
            return []

    async def book(self, slot: TeeTimeSlot, _details: BookingDetails) -> BookingResult:
        """ALWAYS needs_human — S2 owns the booking handoff UX; we NEVER book
        programmatically. Never a confirmation number."""
        time12 = _format_time12h(slot.time) if slot.time else slot.time
        message = (
            f"{time12} at {slot.course_name} is open — finish booking on the "
            "course's site. They take the reservation."
        )
        return BookingResult(
            status="needs_human",
            confirmation_number=None,
            message=message,
            booking_url=slot.booking_url,
        )
