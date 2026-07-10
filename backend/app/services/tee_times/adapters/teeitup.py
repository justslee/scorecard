"""
TeeItUpProvider — S4a rung-1 TeeItUp (GolfNow/Kenna platform) availability
(specs/teetime-availability-everywhere-plan.md §3/§6).

Read-only availability display against TeeItUp's own public, unauthenticated
`v2/tee-times` endpoint — the same call the course's own `*.book.teeitup.com`
booking page makes. Endpoint + response shape were LIVE-VERIFIED (not taken
from the original plan draft, which had the wrong path/params — see the
module-level correction below); ground truth:

  GET https://phx-api-be-east-1b.kenna.io/v2/tee-times?date=YYYY-MM-DD&facilityIds=<N>
  headers: {"x-be-alias": "<tenant>",
            "User-Agent": "Looper/1.0 (golf tee-time availability)",
            "Accept": "application/json"}
  NO auth. `courseIds` / `numberOfPlayers` params return HTTP 400 — do not
  add them (the original plan draft had `courseIds`; corrected from the SPA).

Response = a JSON ARRAY of per-facility records:
`[{"dayInfo": {...}, "teetimes": [...], "courseId": "<hex>",
   "totalAvailableTeetimes": N, "fromCache": bool, "message"?: str}]`.
Verified empty availability = `"teetimes": []` (a real, valid response — not
an error). Each teetime: `{"teetime": "<ISO-8601 UTC>", "rates": [...],
"bookedPlayers": int, "minPlayers": int, "maxPlayers": int, ...}`.

We identify honestly (the same `Looper/1.0` UA foreup.py uses), reuse the
extracted politeness stack (fetch_discipline.py) with our OWN per-host
limiter/breaker/single-flight/cache (never shared with foreUP's — different
host), never log in, never solve CAPTCHAs, never book or charge, and back
off via a circuit breaker on any 4xx/bot signal. Never raises — every
external call sits under a catch-all that returns `None` ("couldn't check").
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import Callable
from zoneinfo import ZoneInfo

import httpx

from app.services.rate_limit import SlidingWindowLimiter

from ..base import (
    BookingDetails,
    BookingResult,
    TeeTimeProvider,
    TeeTimeQuery,
    TeeTimeSlot,
)
from ..capability_store import CourseBookingCapability, load_all_capabilities
from ..fetch_discipline import (
    AVAILABILITY_CACHE_TTL_S,
    REQUEST_TIMEOUT_S,
    USER_AGENT,
    CircuitBreaker,
    SingleFlight,
    _as_int,
    _as_price,
    _format_time12h,
)
from ..routing import _haversine_miles, _parse_latlng
from ..search_cache import FileSearchCacheStore, SearchCacheStore

log = logging.getLogger(__name__)

# ─── Module constants ───────────────────────────────────────────────────────────

TEEITUP_HOST = "phx-api-be-east-1b.kenna.io"
TIMES_URL = "https://phx-api-be-east-1b.kenna.io/v2/tee-times"
TEEITUP_CACHE_TTL_S = AVAILABILITY_CACHE_TTL_S   # 8 min, same band as foreUP
TEEITUP_RPM = 10                                  # per-host, 60s window
MAX_SLOTS_PER_COURSE = 6                          # earliest N inside the window — calm, scannable

# Seed rows today are all NYC-area courses; hardcoding the facility timezone
# is acceptable per plan §3 ("simplest: store tz in platform_ids or default
# America/New_York"). Revisit (read tz from platform_ids) before seeding a
# non-Eastern course.
_COURSE_TZ = ZoneInfo("America/New_York")

_DATA_DIR = Path(__file__).parent.parent.parent.parent.parent / "data"


# ─── Request builder ────────────────────────────────────────────────────────────

def build_times_request(alias: str, facility_id: str, date_yyyymmdd: str) -> tuple[str, dict[str, str], dict[str, str]]:
    """Return (url, params, headers) for the TeeItUp times GET — the exact,
    live-verified request shape. `date` is already "YYYY-MM-DD" (TeeTimeQuery's
    native format) — unlike foreUP, no mm-dd-yyyy conversion is needed."""
    params = {"date": date_yyyymmdd, "facilityIds": facility_id}
    headers = {"x-be-alias": alias, "User-Agent": USER_AGENT, "Accept": "application/json"}
    return TIMES_URL, params, headers


# ─── Price/holes selection — "chosen rate" is the cheapest present fee ────────

def _rate_min_cents(rate: dict) -> int | None:
    """Min of `greenFeeWalking`/`greenFeeCart` present on one rate, in CENTS.
    Uses the bool-before-int guard (`_as_int`) — never trusts a bare truthy
    check on a fee field."""
    vals = [
        c for c in (_as_int(rate.get("greenFeeWalking")), _as_int(rate.get("greenFeeCart")))
        if c is not None
    ]
    return min(vals) if vals else None


def _choose_rate(rates: list) -> dict | None:
    """Pick the rate with the lowest available green fee (walking or cart);
    falls back to the first rate when no rate carries a usable fee. `None`
    when there are no rates at all."""
    priced = [(r, _rate_min_cents(r)) for r in rates if isinstance(r, dict)]
    with_price = [(r, c) for r, c in priced if c is not None]
    if with_price:
        return min(with_price, key=lambda rc: rc[1])[0]
    return rates[0] if rates and isinstance(rates[0], dict) else None


# ─── Parse + normalize ──────────────────────────────────────────────────────────

def _normalize_day(records: list, *, query_date: str, party_size: int) -> list[dict]:
    """Parse the raw TeeItUp JSON array (one entry per queried facility) into
    cache-safe day dicts (`{"time": "HH:MM", "players": n, "price_usd":
    x|None, "holes": 9|18}`), converted from UTC to the course's local
    timezone and date-filtered on the LOCAL date (a UTC entry near midnight
    can roll to the next/previous local calendar day) + party-size filtered.
    Never raises — malformed entries are skipped, not fatal."""
    out: list[dict] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        teetimes = record.get("teetimes")
        if not isinstance(teetimes, list):
            continue

        for entry in teetimes:
            if not isinstance(entry, dict):
                continue

            raw_time = entry.get("teetime")
            if not isinstance(raw_time, str):
                continue
            try:
                utc_dt = datetime.fromisoformat(raw_time.replace("Z", "+00:00"))
            except ValueError:
                continue
            local_dt = utc_dt.astimezone(_COURSE_TZ)
            if local_dt.strftime("%Y-%m-%d") != query_date:
                continue
            hhmm = local_dt.strftime("%H:%M")

            # "players" (open spots) = maxPlayers, NOT bookedPlayers/minPlayers
            # — confirmed live: maxPlayers is how many are still bookable.
            players = _as_int(entry.get("maxPlayers"))
            if players is None or players < party_size:
                continue

            rates = entry.get("rates")
            rates = rates if isinstance(rates, list) else []
            chosen = _choose_rate(rates)

            price: float | None = None
            holes: int = 18
            if chosen is not None:
                cents = _rate_min_cents(chosen)
                # Cents -> dollars BEFORE the positive-guard (feeding cents
                # straight into `_as_price` would silently 100x-overstate the
                # fee — see module docstring / plan §3).
                price = _as_price(cents / 100.0) if cents is not None else None
                holes_raw = chosen.get("holes")
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
    """Apply the post-cache filters (window, party, price) + sort + truncate,
    and build the TeeTimeSlot list. Returns `None` on a malformed window
    (never raises); `[]` is a valid "verified empty" result."""
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

    alias = cap.platform_ids.get("alias", "")
    facility_id = cap.platform_ids.get("facility_id", "")
    course_id = f"teeitup-{alias}-{facility_id}"
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
            provider="teeitup",
            holes=d["holes"],  # type: ignore[arg-type]
            booking_url=cap.booking_url,
            estimated=False,
            route=None,   # TeeItUp knows real availability — route=None per base.py.
            phone=cap.phone,
        ))
    return slots


def _cache_key(cap: CourseBookingCapability, query: TeeTimeQuery) -> str:
    """Deterministic cache key: `(alias, facility_id, date, players)` — same
    shape as foreUP's `_cache_key` (plan §3), even though TeeItUp's own
    request doesn't take a players param; the day-cache entry is still scoped
    per party size to mirror the pinned pattern exactly."""
    return json.dumps({
        "v": 1,
        "alias": cap.platform_ids.get("alias"),
        "facility_id": cap.platform_ids.get("facility_id"),
        "date": query.date,
        "players": query.party_size,
    }, sort_keys=True)


# ─── Module singletons (this engine's own host — never shared with foreUP) ────

_limiter = SlidingWindowLimiter(rpm=TEEITUP_RPM, window_s=60.0)
_breaker = CircuitBreaker()


# ─── Provider ──────────────────────────────────────────────────────────────────

class TeeItUpProvider(TeeTimeProvider):
    """Real TeeItUp tee-time availability for courses with a known
    booking capability (backend/data/booking_capabilities_seed.json +
    booking_capabilities_validated.json, platform=="teeitup")."""

    def __init__(
        self,
        capabilities: Callable[[], tuple[CourseBookingCapability, ...]] = load_all_capabilities,
        cache: SearchCacheStore | None = None,
        limiter: SlidingWindowLimiter | None = None,
        breaker: CircuitBreaker | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._capabilities = capabilities
        self._cache = cache or FileSearchCacheStore(
            path=_DATA_DIR / "teeitup_availability_cache.json",
            ttl_seconds=TEEITUP_CACHE_TTL_S,
        )
        self._limiter = limiter or _limiter
        self._breaker = breaker or _breaker
        self._transport = transport
        self._clock = clock
        self._singleflight = SingleFlight()

    @property
    def name(self) -> str:
        return "teeitup"

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
        parse failure / missing ids). `[]` = verified: nothing available.
        Never raises."""
        try:
            datetime.strptime(query.date, "%Y-%m-%d")
        except (ValueError, TypeError):
            return None

        alias = cap.platform_ids.get("alias")
        facility_id = cap.platform_ids.get("facility_id")
        if not alias or not facility_id:
            log.warning("teeitup: capability missing alias/facility_id — cannot check")
            return None

        try:
            cache_key = _cache_key(cap, query)
            day_slots = self._cache.get(cache_key)
            if day_slots is None:
                day_slots = await self._fetch_day(
                    cache_key, alias, facility_id, query.date, query.party_size
                )
                if day_slots is None:
                    return None  # couldn't check

            return _emit_slots(
                day_slots, cap, query, distance_miles=distance_miles, course=course
            )
        except Exception:
            log.warning("teeitup: slots_for_capability failed unexpectedly", exc_info=True)
            return None

    # ── Fetch path: single-flight -> rate limiter -> breaker -> HTTP ───────

    async def _fetch_day(
        self, cache_key: str, alias: str, facility_id: str, query_date: str, party_size: int,
    ) -> list[dict] | None:
        async def _do() -> list[dict] | None:
            # Double-checked cache read — another flight may have resolved
            # and cached between our first `.get()` and acquiring the flight.
            cached = self._cache.get(cache_key)
            if cached is not None:
                return cached
            result = await self._do_fetch(alias, facility_id, query_date, party_size)
            if result is not None:
                self._cache.set(cache_key, result)
            return result

        return await self._singleflight.run(cache_key, _do)

    async def _do_fetch(
        self, alias: str, facility_id: str, query_date: str, party_size: int,
    ) -> list[dict] | None:
        # Rate limiter first — self-throttling is not an upstream signal, so
        # it never counts a breaker failure.
        retry_after = self._limiter.check(TEEITUP_HOST)
        if retry_after is not None:
            log.info("teeitup: rate-limited host=%s retry_after=%.1fs", TEEITUP_HOST, retry_after)
            return None

        if not self._breaker.allow():
            return None

        url, params, headers = build_times_request(alias, facility_id, query_date)
        try:
            async with httpx.AsyncClient(
                timeout=REQUEST_TIMEOUT_S, transport=self._transport
            ) as client:
                resp = await client.get(url, params=params, headers=headers)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            log.warning("teeitup: request error host=%s exc=%r", TEEITUP_HOST, exc)
            self._breaker.record_failure(reason="request-error")
            return None
        except Exception as exc:  # never raise out of the fetch path
            log.warning("teeitup: unexpected request error host=%s exc=%r", TEEITUP_HOST, exc)
            self._breaker.record_failure(reason="request-error")
            return None

        if resp.status_code != 200:
            log.warning("teeitup: non-200 status=%d host=%s", resp.status_code, TEEITUP_HOST)
            self._breaker.record_failure(reason=str(resp.status_code))
            return None

        try:
            data = resp.json()
        except Exception:
            log.warning("teeitup: non-JSON response host=%s", TEEITUP_HOST)
            self._breaker.record_failure(reason="non-json")
            return None

        if not isinstance(data, list):
            log.warning(
                "teeitup: response is not a JSON array (type=%s) host=%s",
                type(data).__name__, TEEITUP_HOST,
            )
            self._breaker.record_failure(reason="non-array")
            return None

        if len(data) == 0:
            # Querying one known facilityIds should always return exactly one
            # record — even a genuinely sold-out day carries dayInfo +
            # "teetimes": []. A fully empty top-level array is a schema-drift
            # signal, not a confirmed empty day: degrade, never claim
            # emptiness we didn't actually observe.
            log.warning(
                "teeitup: empty response array for facility_id=%s — treating as couldn't-check",
                facility_id,
            )
            self._breaker.record_failure(reason="empty-array")
            return None

        self._breaker.record_success()
        return _normalize_day(data, query_date=query_date, party_size=party_size)

    # ── Standalone provider mode (debug only, mirrors ForeUpProvider) ──────

    async def search_availability(self, query: TeeTimeQuery) -> list[TeeTimeSlot]:
        try:
            origin = _parse_latlng(query.area)
            if origin is None:
                return []
            max_dist = query.max_distance_miles if query.max_distance_miles is not None else 15.0

            results: list[TeeTimeSlot] = []
            for cap in self._capabilities():
                if cap.platform != "teeitup" or cap.is_private:
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
            log.exception("teeitup: search_availability failed — returning empty")
            return []

    async def book(self, slot: TeeTimeSlot, _details: BookingDetails) -> BookingResult:
        """ALWAYS needs_human — never book programmatically. Never a
        confirmation number (same S2 invariant as foreup.py)."""
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
