"""
ChronogolfProvider — S4c rung-1 Chronogolf marketplace availability
(specs/teetime-availability-everywhere-plan.md §3/§6).

Read-only availability display against Chronogolf's own public,
unauthenticated marketplace "teetimes" endpoint — the same call the course's
own `chronogolf.com/club/<slug>` booking page makes. Endpoint + response
shape were LIVE-VERIFIED by the eng-lead (a real probe, honest UA, no auth,
Cloudflare present but NOT blocking) on 2026-07-10 — ground truth:

  Step A — id lookup (offline, in the probe script only, NEVER at request
  time): `GET https://www.chronogolf.com/marketplace/v2/clubs/<slug>` returns
  `{"id": <club_id>, "courses": [{"id": <course_id>, "holes": 18, ...}],
  "default_affiliation_type_id": <int>, "timezone": "America/New_York", ...}`.
  This adapter never calls Step A — `club_id`/`course_id`/`affiliation_type_id`
  are pre-resolved into the capability row's `platform_ids` by the probe.

  Step B — availability (what this adapter calls):
  `GET https://www.chronogolf.com/marketplace/clubs/<club_id>/teetimes
       ?date=YYYY-MM-DD&course_id=<course_id>&nb_holes=18
       &affiliation_type_ids[]=<affiliation_type_id>`
  headers: {"User-Agent": "Looper/1.0 (golf tee-time availability)",
            "Accept": "application/json"}. NO auth.

Response = a JSON ARRAY of teetime records (NOT wrapped per-facility like
TeeItUp): `{"id":int,"uuid":str,"course_id":int,"start_time":"HH:MM",
"date":"YYYY-MM-DD","hole":int,"round":int,"format":str,
"restrictions":[str],"out_of_capacity":bool,"frozen":bool,
"green_fees":[{"green_fee":109.0,"half_cart":23.45,"price":109.0,
"affiliation_type_id":int,...}]}`.

KEY SEMANTICS — these differ from TeeItUp, read carefully:

- `start_time` ("HH:MM") is ALREADY in the course's LOCAL timezone. Unlike
  TeeItUp's UTC `teetime`, we do NOT convert — we date-filter directly on the
  `date` field (== the query date) and window-filter the local "HH:MM".
- `out_of_capacity: true` means fully booked / NOT bookable online. We
  include ONLY entries with `out_of_capacity is False` (the exact bool, never
  a truthy check on a possibly-missing/malformed field — "omit on doubt" per
  `no-fake-data-fallbacks`: a missing/non-bool value is treated as NOT
  bookable, i.e. excluded, rather than assumed bookable).
- `green_fees[].green_fee` is already in DOLLARS (e.g. `109.0`), NOT cents —
  fed straight into `_as_price`, never divided by 100 (that would be the
  TeeItUp cents-to-dollars step misapplied here, silently 100x-understating
  the fee). We choose the CHEAPEST `green_fee` across `green_fees[]`;
  `price_usd=None` when the entry carries no `green_fees` at all (a real,
  observed shape on this endpoint for some restricted slots — never
  fabricated).
- There is NO per-slot open-spots count on this endpoint, and Chronogolf's
  own `players`/party-size query param is a documented no-op on this
  marketplace route. So `TeeTimeSlot.players` here is set to
  `query.party_size` for every bookable slot — this is HONEST but NOT a real
  remaining-capacity count (unlike TeeItUp's `maxPlayers` or foreUP's
  `available_spots`): it means "this tee time is bookable online for a party
  of your size", the same fact the course's own Chronogolf widget conveys.
  It must never be read as "N spots remain" — we never fabricate a larger
  number than the party actually searched for.
- `restrictions` is honored conservatively: when the query is a single
  player (`party_size == 1`) and any restriction string case-insensitively
  contains "single player" (the live, observed wording is "Single players
  are not allowed to book online onto a fully empty tee time..."), that slot
  is omitted — Chronogolf itself won't let a lone golfer book it, so listing
  it as bookable would be a fake-availability violation. Any other
  restriction text is left alone (simple, conservative substring match; we
  do not attempt to parse every possible restriction).

EMPTY-ARRAY DECISION (documented, per plan §3 "decide and DOCUMENT your
choice"): a Chronogolf `200 []` for a known (club_id, course_id) is treated
as a REAL verified-empty day (`[]`, course omitted), NOT a couldn't-check —
unlike TeeItUp, where an empty top-level array is itself schema-drift (a
queried facility always returns at least a `dayInfo` wrapper even when sold
out). Chronogolf's endpoint has no such per-request wrapper: the array IS
the day's teetimes, so a genuinely closed/unpublished day plausibly returns
`[]` directly, and treating every empty response as "couldn't check" would
degrade correct behavior into a permanent unnecessary S0 fallback for every
sold-out or off-season day. A non-200 status, non-JSON body, or non-array
JSON body are all real signals of something upstream breaking (Cloudflare
challenge, schema change, 5xx) and DO map to "couldn't check" (`None`) +
breaker failure, same as every other adapter.

We identify honestly (the same `Looper/1.0` UA every adapter uses), reuse
the extracted politeness stack (fetch_discipline.py) with our OWN per-host
limiter/breaker/single-flight/cache (never shared with foreUP's or
TeeItUp's — different host), never log in, never solve CAPTCHAs, never book
or charge, and back off via a circuit breaker on any 4xx/5xx/parse failure.
Never raises — every external call sits under a catch-all that returns
`None` ("couldn't check").
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
    _as_price,
    _format_time12h,
)
from ..routing import _haversine_miles, _parse_latlng
from ..search_cache import FileSearchCacheStore, SearchCacheStore

log = logging.getLogger(__name__)

# ─── Module constants ───────────────────────────────────────────────────────────

CHRONOGOLF_HOST = "www.chronogolf.com"
CHRONOGOLF_CACHE_TTL_S = AVAILABILITY_CACHE_TTL_S   # 8 min, same band as every adapter
CHRONOGOLF_RPM = 10                                  # per-host, 60s window
MAX_SLOTS_PER_COURSE = 6                             # earliest N inside the window — calm, scannable

# All 3 seed rows today are NJ/NY-metro courses on Eastern time, and
# `start_time` is already local per the endpoint's own semantics (no UTC
# conversion needed) — so this constant is purely documentary/defensive today.
# Revisit (read tz from platform_ids) before seeding a non-Eastern course.
_COURSE_TZ = ZoneInfo("America/New_York")

_DATA_DIR = Path(__file__).parent.parent.parent.parent.parent / "data"

_SINGLE_PLAYER_RESTRICTION_MARKER = "single player"


# ─── Request builder ────────────────────────────────────────────────────────────

def build_times_request(
    club_id: str, course_id: str, affiliation_type_id: str, date_yyyymmdd: str
) -> tuple[str, dict[str, str], dict[str, str]]:
    """Return (url, params, headers) for the Chronogolf marketplace teetimes
    GET — the exact, live-verified request shape. `date` is already
    "YYYY-MM-DD" (TeeTimeQuery's native format). `affiliation_type_ids[]` is
    a literal bracketed key — httpx percent-encodes the brackets
    (`affiliation_type_ids%5B%5D=...`), which the server accepts identically
    to the unencoded form (verified live)."""
    url = f"https://{CHRONOGOLF_HOST}/marketplace/clubs/{club_id}/teetimes"
    params = {
        "date": date_yyyymmdd,
        "course_id": course_id,
        "nb_holes": "18",
        "affiliation_type_ids[]": affiliation_type_id,
    }
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    return url, params, headers


# ─── Price selection — cheapest present green_fee, in dollars ─────────────────

def _cheapest_green_fee(green_fees: object) -> float | None:
    """Cheapest `green_fee` across the entry's `green_fees[]`, already in
    dollars (never divided — this is NOT TeeItUp's cents shape). `None` when
    the list is missing/empty or carries no usable numeric fee — never
    fabricated as $0."""
    fees = green_fees if isinstance(green_fees, list) else []
    prices = [
        p for p in (_as_price(f.get("green_fee")) for f in fees if isinstance(f, dict))
        if p is not None
    ]
    return min(prices) if prices else None


# ─── Parse + normalize ──────────────────────────────────────────────────────────

def _normalize_day(records: list, *, query_date: str, party_size: int) -> list[dict]:
    """Parse the raw Chronogolf JSON array into cache-safe day dicts
    (`{"time": "HH:MM", "players": party_size, "price_usd": x|None,
    "holes": 18}`). `start_time` is already local — no timezone conversion.
    Filters: `date == query_date`, `out_of_capacity is False` (exact bool),
    and — only for `party_size == 1` — omits any entry whose `restrictions`
    contain a "single player(s)" booking restriction. Never raises —
    malformed entries are skipped, not fatal."""
    out: list[dict] = []
    for entry in records:
        if not isinstance(entry, dict):
            continue

        if entry.get("date") != query_date:
            continue

        raw_time = entry.get("start_time")
        if not isinstance(raw_time, str):
            continue
        try:
            datetime.strptime(raw_time, "%H:%M")
        except ValueError:
            continue

        # Exact bool check — a missing/malformed `out_of_capacity` is treated
        # as "not confirmed bookable" (omit), never assumed bookable.
        if entry.get("out_of_capacity") is not False:
            continue

        restrictions = entry.get("restrictions")
        restrictions = restrictions if isinstance(restrictions, list) else []
        if party_size == 1 and any(
            isinstance(r, str) and _SINGLE_PLAYER_RESTRICTION_MARKER in r.lower()
            for r in restrictions
        ):
            continue

        price = _cheapest_green_fee(entry.get("green_fees"))
        out.append({"time": raw_time, "players": party_size, "price_usd": price, "holes": 18})
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

    club_id = cap.platform_ids.get("club_id", "")
    course_id_platform = cap.platform_ids.get("course_id", "")
    course_id = f"chronogolf-{club_id}-{course_id_platform}"
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
            provider="chronogolf",
            holes=d["holes"],  # type: ignore[arg-type]
            booking_url=cap.booking_url,
            estimated=False,
            route=None,   # Chronogolf knows real availability — route=None per base.py.
            phone=cap.phone,
        ))
    return slots


def _cache_key(cap: CourseBookingCapability, query: TeeTimeQuery) -> str:
    """Deterministic cache key: `(club_id, course_id, affiliation_type_id,
    date, players)`. `players` is included (mirroring teeitup's pinned
    pattern) even though the upstream request doesn't take a players param —
    here it's actually load-bearing: the single-player-restriction filter in
    `_normalize_day` depends on `party_size`, so the cached day itself
    differs between a party-of-1 query and a party-of-2+ query."""
    return json.dumps({
        "v": 1,
        "club_id": cap.platform_ids.get("club_id"),
        "course_id": cap.platform_ids.get("course_id"),
        "affiliation_type_id": cap.platform_ids.get("affiliation_type_id"),
        "date": query.date,
        "players": query.party_size,
    }, sort_keys=True)


# ─── Module singletons (this engine's own host — never shared with foreUP/TeeItUp)

_limiter = SlidingWindowLimiter(rpm=CHRONOGOLF_RPM, window_s=60.0)
_breaker = CircuitBreaker()


# ─── Provider ──────────────────────────────────────────────────────────────────

class ChronogolfProvider(TeeTimeProvider):
    """Real Chronogolf tee-time availability for courses with a known
    booking capability (backend/data/booking_capabilities_seed.json +
    booking_capabilities_validated.json, platform=="chronogolf")."""

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
            path=_DATA_DIR / "chronogolf_availability_cache.json",
            ttl_seconds=CHRONOGOLF_CACHE_TTL_S,
        )
        self._limiter = limiter or _limiter
        self._breaker = breaker or _breaker
        self._transport = transport
        self._clock = clock
        self._singleflight = SingleFlight()

    @property
    def name(self) -> str:
        return "chronogolf"

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

        club_id = cap.platform_ids.get("club_id")
        course_id = cap.platform_ids.get("course_id")
        affiliation_type_id = cap.platform_ids.get("affiliation_type_id")
        if not club_id or not course_id or not affiliation_type_id:
            log.warning(
                "chronogolf: capability missing club_id/course_id/affiliation_type_id — cannot check"
            )
            return None

        try:
            cache_key = _cache_key(cap, query)
            day_slots = self._cache.get(cache_key)
            if day_slots is None:
                day_slots = await self._fetch_day(
                    cache_key, club_id, course_id, affiliation_type_id, query.date, query.party_size
                )
                if day_slots is None:
                    return None  # couldn't check

            return _emit_slots(
                day_slots, cap, query, distance_miles=distance_miles, course=course
            )
        except Exception:
            log.warning("chronogolf: slots_for_capability failed unexpectedly", exc_info=True)
            return None

    # ── Fetch path: single-flight -> rate limiter -> breaker -> HTTP ───────

    async def _fetch_day(
        self,
        cache_key: str,
        club_id: str,
        course_id: str,
        affiliation_type_id: str,
        query_date: str,
        party_size: int,
    ) -> list[dict] | None:
        async def _do() -> list[dict] | None:
            # Double-checked cache read — another flight may have resolved
            # and cached between our first `.get()` and acquiring the flight.
            cached = self._cache.get(cache_key)
            if cached is not None:
                return cached
            result = await self._do_fetch(club_id, course_id, affiliation_type_id, query_date, party_size)
            if result is not None:
                self._cache.set(cache_key, result)
            return result

        return await self._singleflight.run(cache_key, _do)

    async def _do_fetch(
        self, club_id: str, course_id: str, affiliation_type_id: str, query_date: str, party_size: int,
    ) -> list[dict] | None:
        # Rate limiter first — self-throttling is not an upstream signal, so
        # it never counts a breaker failure.
        retry_after = self._limiter.check(CHRONOGOLF_HOST)
        if retry_after is not None:
            log.info("chronogolf: rate-limited host=%s retry_after=%.1fs", CHRONOGOLF_HOST, retry_after)
            return None

        if not self._breaker.allow():
            return None

        url, params, headers = build_times_request(club_id, course_id, affiliation_type_id, query_date)
        try:
            async with httpx.AsyncClient(
                timeout=REQUEST_TIMEOUT_S, transport=self._transport
            ) as client:
                resp = await client.get(url, params=params, headers=headers)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            log.warning("chronogolf: request error host=%s exc=%r", CHRONOGOLF_HOST, exc)
            self._breaker.record_failure(reason="request-error")
            return None
        except Exception as exc:  # never raise out of the fetch path
            log.warning("chronogolf: unexpected request error host=%s exc=%r", CHRONOGOLF_HOST, exc)
            self._breaker.record_failure(reason="request-error")
            return None

        if resp.status_code != 200:
            log.warning("chronogolf: non-200 status=%d host=%s", resp.status_code, CHRONOGOLF_HOST)
            self._breaker.record_failure(reason=str(resp.status_code))
            return None

        try:
            data = resp.json()
        except Exception:
            log.warning("chronogolf: non-JSON response host=%s", CHRONOGOLF_HOST)
            self._breaker.record_failure(reason="non-json")
            return None

        if not isinstance(data, list):
            log.warning(
                "chronogolf: response is not a JSON array (type=%s) host=%s",
                type(data).__name__, CHRONOGOLF_HOST,
            )
            self._breaker.record_failure(reason="non-array")
            return None

        # A 200 [] here IS a real verified-empty day (see module docstring's
        # "EMPTY-ARRAY DECISION") — unlike TeeItUp, the array itself is the
        # day's teetimes with no per-request wrapper to sanity-check against.
        self._breaker.record_success()
        return _normalize_day(data, query_date=query_date, party_size=party_size)

    # ── Standalone provider mode (debug only, mirrors TeeItUpProvider) ─────

    async def search_availability(self, query: TeeTimeQuery) -> list[TeeTimeSlot]:
        try:
            origin = _parse_latlng(query.area)
            if origin is None:
                return []
            max_dist = query.max_distance_miles if query.max_distance_miles is not None else 15.0

            results: list[TeeTimeSlot] = []
            for cap in self._capabilities():
                if cap.platform != "chronogolf" or cap.is_private:
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
            log.exception("chronogolf: search_availability failed — returning empty")
            return []

    async def book(self, slot: TeeTimeSlot, _details: BookingDetails) -> BookingResult:
        """ALWAYS needs_human — never book programmatically. Never a
        confirmation number (same S2 invariant as every adapter)."""
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
