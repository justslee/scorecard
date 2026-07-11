"""
ClubProphetProvider — H1 rung-2a Club Prophet Systems (CPS) availability
(specs/teetime-headless-scraper-plan.md §6/H1, §1a).

Read-only availability display against a CPS course's own public,
unauthenticated `onlineresweb` reservation API — the same calls the course's
own `*.cps.golf/onlineresweb` Angular booking page makes on every search.
Endpoint + response shapes + the token dance were LIVE-VERIFIED by the
eng-lead (a real end-to-end probe against Harbor Links Golf Course,
`harborlinksgc.cps.golf`, honest UA, no login, real times returned) on
2026-07-10. Ground truth (RE-VERIFIED, not taken on faith from the plan
draft, which had the token path `connect/token/short` — the live short-lived
flow is actually `myconnect/token/short`):

  The public config the SPA loads (`{siteHost}/onlineresweb/Home/Configuration`)
  yields `authorityBaseUrl`, `onlineApi`, and `websiteId`. Those three are
  PRE-RESOLVED offline by the probe into the capability row's `platform_ids`
  (`authority_base_url`, `online_api`) alongside the numeric `course_id` — so
  this adapter NEVER calls the config endpoint at request time (same
  "ids pre-resolved by the probe" discipline as chronogolf.py's Step A). The
  request-time flow is three calls, all against the SAME pre-resolved CPS
  host (never a user-supplied URL — SSRF-safe):

  Step 1 — mint a short-lived bearer token (public creds, NO login, NO secret
  of ours): `POST {authority_base_url}/myconnect/token/short` with a single
  multipart field `client_id=onlinereswebshortlived` (CPS's OWN public
  short-lived client id, read verbatim from the app's `assets/env.js`
  `SHORT_LIVED_CLIENT_ID`). Response `{"access_token": "...",
  "expires_in": 600, ...}`. This is CPS's public browse token — anyone loading
  the booking page mints the identical one; we never send a password, never
  authenticate a user, never use a client_secret.

  Step 2 — register a client-generated transaction id (the site's own
  anti-abuse pre-search handshake, required before every search; it does NOT
  create/modify any booking): `POST {online_api}/RegisterTransactionId` with
  JSON `{"transactionId": "<uuid4>"}` → `true`. Header `x-componentid: 1` is
  required on every onlineApi call (a missing/invalid componentid is a hard
  400).

  Step 3 — availability: `GET {online_api}/TeeTimes` with query params
  `searchDate=YYYY-MM-DD&holes=18&numberOfPlayer=<party>&courseIds=<course_id>
   &teeOffTimeMin=0&teeOffTimeMax=24&searchTimeType=0&transactionId=<uuid4>`
  and headers `Authorization: Bearer <token>` + `x-componentid: 1`. NO login.

Response = `{"transactionId": str, "isSuccess": bool, "content": ...}` where
`content` is EITHER:
  - a JSON ARRAY of teetime records (real availability), each:
    `{"startTime": "2026-07-16T06:40:00", "courseId": 1, "holes": 18,
      "minPlayer": 1, "maxPlayer": 4, "availableParticipantNo": [1,2,3,4],
      "courseName": "CHAMPIONSHIP COURSE",
      "shItemPrices": [{"shItemCode": "GreenFee18", "displayPrice": 71.0,
                        "price": 71.0, ...}], ...}` — verified live; OR
  - an object `{"messageKey": "NO_TEETIMES", "messageTemplate":
    "No tee times available", ...}` — a REAL verified-empty day.

KEY SEMANTICS — read carefully:

- `startTime` is an ISO-8601 timestamp ALREADY in the course's LOCAL time
  (no timezone suffix, e.g. "2026-07-16T06:40:00"). Like chronogolf's
  `start_time` (and UNLIKE teeitup's UTC `teetime`), we do NOT convert — we
  date-filter on the local date part (== the query date) and window-filter the
  local "HH:MM".
- Open spots: `maxPlayer` is the real maximum party still bookable for that
  slot (a genuine remaining-capacity ceiling, like teeitup's `maxPlayers` —
  NOT chronogolf's honest-but-flat party-size stand-in). A slot is bookable
  for the query iff `minPlayer <= party_size <= maxPlayer` (exact ints via the
  bool-before-int guard `_as_int`; a missing/malformed `maxPlayer` ⇒ the slot
  is omitted, never assumed bookable — "omit on doubt" per no-fake-data). We
  report `players = maxPlayer` (the real ceiling), never a fabricated number.
- Price: the cheapest `displayPrice` (fall back to `price`) across the slot's
  `shItemPrices[]`, already in DOLLARS (live values 27.0–71.0 — NOT cents, so
  never divided by 100, which would be teeitup's cents step misapplied here).
  `price_usd = None` when no `shItemPrices` entry carries a usable positive
  fee (never fabricated as $0). Uses `_as_price` (0/negative/bool/missing ⇒
  None).
- `holes`: `entry["holes"]` when it is 9 or 18, else defaults to 18.

EMPTY / DRIFT DECISION (documented, per plan §5 schema-drift-canary rule):
  - `content` is a list (incl. `[]`) ⇒ parse it; a genuinely closed/unpublished
    day plausibly returns `[]` and that IS a real verified-empty result.
  - `content` is an object with `messageKey == "NO_TEETIMES"` ⇒ verified empty.
  - ANYTHING else — non-200, non-JSON body, a top level that is not a dict,
    a missing `content`, or a `content` object whose `messageKey` is NOT
    "NO_TEETIMES" (an unexpected/error message we must not silently read as
    "empty") — maps to "couldn't check" (`None`) + a breaker failure. The
    token/config indirection is the brittle part; a schema-guard violation
    degrades to `None` (S0 fallback), never a silent fake empty.

We identify honestly (the same `Looper/1.0` UA every adapter uses), reuse the
extracted politeness stack (fetch_discipline.py) with our OWN per-host
limiter/breaker/single-flight/cache (never shared with foreUP/TeeItUp/
Chronogolf — different host), never log in, never solve CAPTCHAs, never book
or charge, and back off via a circuit breaker on any 4xx/5xx/parse failure.
Never raises — every external call sits under a catch-all that returns `None`
("couldn't check").
"""

from __future__ import annotations

import json
import logging
import time
import uuid
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

CLUBPROPHET_CACHE_TTL_S = AVAILABILITY_CACHE_TTL_S   # 8 min, same band as every adapter
CLUBPROPHET_RPM = 10                                 # per-host, 60s window
MAX_SLOTS_PER_COURSE = 6                             # earliest N inside the window — calm, scannable

# CPS's OWN public short-lived browse client id, read verbatim from the app's
# `onlineresweb/assets/env.js` (`SHORT_LIVED_CLIENT_ID`). Public, static, and
# the same value every browser mints its browse token with — NOT a secret of
# ours, NOT a user credential, NEVER a password/client_secret.
SHORT_LIVED_CLIENT_ID = "onlinereswebshortlived"

# All CPS hosts live under this domain. Every pre-resolved URL in a capability
# row's platform_ids is asserted to sit on it before we make a request — a
# defense-in-depth guard against a poisoned seed pointing us at an arbitrary
# host (SSRF). The hosts are curated seed strings, never user input.
_CPS_DOMAIN_SUFFIX = ".cps.golf"

# `startTime` is already course-local; this constant is purely documentary /
# defensive today (the single seed course is on Eastern time). Revisit (read
# tz from platform_ids) before seeding a non-Eastern CPS course.
_COURSE_TZ = ZoneInfo("America/New_York")

_DATA_DIR = Path(__file__).parent.parent.parent.parent.parent / "data"

_NO_TEETIMES_MESSAGE_KEY = "NO_TEETIMES"


# ─── Request builders (exact, live-verified shapes) ─────────────────────────────

def build_token_request(authority_base_url: str) -> tuple[str, dict[str, str], dict[str, str]]:
    """(url, form_fields, headers) for the short-lived browse-token mint. A
    single multipart field `client_id` = CPS's public SHORT_LIVED_CLIENT_ID —
    no secret, no grant_type, no login."""
    url = f"{authority_base_url.rstrip('/')}/myconnect/token/short"
    return url, {"client_id": SHORT_LIVED_CLIENT_ID}, {"User-Agent": USER_AGENT, "Accept": "application/json"}


def build_register_txn_request(
    online_api: str, transaction_id: str
) -> tuple[str, dict, dict[str, str]]:
    """(url, json_body, headers) for the pre-search transaction-id handshake.
    `x-componentid: 1` is required on every onlineApi call."""
    url = f"{online_api.rstrip('/')}/RegisterTransactionId"
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json", "x-componentid": "1"}
    return url, {"transactionId": transaction_id}, headers


def build_times_request(
    online_api: str, course_id: str, date_yyyymmdd: str, party_size: int,
    transaction_id: str, access_token: str,
) -> tuple[str, dict[str, str], dict[str, str]]:
    """(url, params, headers) for the TeeTimes availability GET — the exact,
    live-verified request shape. `date` is already "YYYY-MM-DD" (native).
    `teeOffTimeMax` must be an integer hour bound (the API rejects "23.99");
    0..24 spans the whole day and we window-filter locally afterward."""
    url = f"{online_api.rstrip('/')}/TeeTimes"
    params = {
        "searchDate": date_yyyymmdd,
        "holes": "18",
        "numberOfPlayer": str(party_size),
        "courseIds": course_id,
        "teeOffTimeMin": "0",
        "teeOffTimeMax": "24",
        "searchTimeType": "0",
        "transactionId": transaction_id,
    }
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Authorization": f"Bearer {access_token}",
        "x-componentid": "1",
    }
    return url, params, headers


# ─── Price selection — cheapest present fee, in dollars ─────────────────────────

def _cheapest_price(sh_item_prices: object) -> float | None:
    """Cheapest usable fee across the slot's `shItemPrices[]`, already in
    dollars (never divided — this is NOT teeitup's cents shape). Prefers
    `displayPrice`, falls back to `price`. `None` when the list is
    missing/empty or carries no positive numeric fee — never fabricated as $0."""
    items = sh_item_prices if isinstance(sh_item_prices, list) else []
    prices: list[float] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        p = _as_price(it.get("displayPrice"))
        if p is None:
            p = _as_price(it.get("price"))
        if p is not None:
            prices.append(p)
    return min(prices) if prices else None


# ─── Parse + normalize ──────────────────────────────────────────────────────────

def _normalize_day(records: list, *, query_date: str, party_size: int) -> list[dict]:
    """Parse the CPS `content` array into cache-safe day dicts
    (`{"time": "HH:MM", "players": maxPlayer, "price_usd": x|None, "holes":
    9|18}`). `startTime` is already local — no timezone conversion. Filters:
    local date == query_date, and `minPlayer <= party_size <= maxPlayer` (exact
    ints; a missing/malformed bound omits the slot). Never raises — malformed
    entries are skipped, not fatal."""
    out: list[dict] = []
    for entry in records:
        if not isinstance(entry, dict):
            continue

        raw_time = entry.get("startTime")
        if not isinstance(raw_time, str):
            continue
        try:
            local_dt = datetime.fromisoformat(raw_time)
        except ValueError:
            continue
        if local_dt.strftime("%Y-%m-%d") != query_date:
            continue
        hhmm = local_dt.strftime("%H:%M")

        min_player = _as_int(entry.get("minPlayer"))
        max_player = _as_int(entry.get("maxPlayer"))
        if max_player is None:
            continue  # can't confirm capacity — omit, never assume bookable
        lo = min_player if min_player is not None else 1
        if not (lo <= party_size <= max_player):
            continue

        holes_raw = entry.get("holes")
        holes = holes_raw if holes_raw in (9, 18) else 18

        price = _cheapest_price(entry.get("shItemPrices"))
        out.append({"time": hhmm, "players": max_player, "price_usd": price, "holes": holes})
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

    host = cap.platform_ids.get("host", "")
    course_id_platform = cap.platform_ids.get("course_id", "")
    course_id = f"clubprophet-{host}-{course_id_platform}"
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
            provider="clubprophet",
            holes=d["holes"],  # type: ignore[arg-type]
            booking_url=cap.booking_url,
            estimated=False,
            route=None,   # CPS knows real availability — route=None per base.py.
            phone=cap.phone,
        ))
    return slots


def _cache_key(cap: CourseBookingCapability, query: TeeTimeQuery) -> str:
    """Deterministic cache key: `(host, course_id, date, players)`. `players`
    is load-bearing — the CPS request itself takes `numberOfPlayer`, and the
    normalize filter (`minPlayer <= party_size <= maxPlayer`) depends on it."""
    return json.dumps({
        "v": 1,
        "host": cap.platform_ids.get("host"),
        "course_id": cap.platform_ids.get("course_id"),
        "date": query.date,
        "players": query.party_size,
    }, sort_keys=True)


def _valid_cps_url(url: object) -> bool:
    """Defense-in-depth SSRF guard: a pre-resolved platform_ids URL must be an
    https URL whose host sits under `.cps.golf`. Rejects a poisoned/malformed
    seed before any request leaves the process."""
    if not isinstance(url, str) or not url.startswith("https://"):
        return False
    host = url[len("https://"):].split("/", 1)[0].split(":", 1)[0].lower()
    return host.endswith(_CPS_DOMAIN_SUFFIX)


# ─── Module singletons (this engine's own host — never shared) ─────────────────

_limiter = SlidingWindowLimiter(rpm=CLUBPROPHET_RPM, window_s=60.0)
_breaker = CircuitBreaker()


# ─── Provider ──────────────────────────────────────────────────────────────────

class ClubProphetProvider(TeeTimeProvider):
    """Real Club Prophet (CPS) tee-time availability for courses with a known
    booking capability (backend/data/booking_capabilities_seed.json +
    booking_capabilities_validated.json, platform=="clubprophet")."""

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
            path=_DATA_DIR / "clubprophet_availability_cache.json",
            ttl_seconds=CLUBPROPHET_CACHE_TTL_S,
        )
        self._limiter = limiter or _limiter
        self._breaker = breaker or _breaker
        self._transport = transport
        self._clock = clock
        self._singleflight = SingleFlight()

    @property
    def name(self) -> str:
        return "clubprophet"

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
        parse failure / missing-or-untrusted ids). `[]` = verified: nothing
        available. Never raises."""
        try:
            datetime.strptime(query.date, "%Y-%m-%d")
        except (ValueError, TypeError):
            return None

        authority_base_url = cap.platform_ids.get("authority_base_url")
        online_api = cap.platform_ids.get("online_api")
        course_id = cap.platform_ids.get("course_id")
        if not authority_base_url or not online_api or not course_id:
            log.warning(
                "clubprophet: capability missing authority_base_url/online_api/course_id — cannot check"
            )
            return None
        if not _valid_cps_url(authority_base_url) or not _valid_cps_url(online_api):
            log.warning("clubprophet: capability URL not a trusted https cps.golf host — refusing")
            return None

        try:
            cache_key = _cache_key(cap, query)
            day_slots = self._cache.get(cache_key)
            if day_slots is None:
                day_slots = await self._fetch_day(
                    cache_key, authority_base_url, online_api, course_id,
                    query.date, query.party_size,
                )
                if day_slots is None:
                    return None  # couldn't check

            return _emit_slots(
                day_slots, cap, query, distance_miles=distance_miles, course=course
            )
        except Exception:
            log.warning("clubprophet: slots_for_capability failed unexpectedly", exc_info=True)
            return None

    # ── Fetch path: single-flight -> rate limiter -> breaker -> HTTP ───────

    async def _fetch_day(
        self,
        cache_key: str,
        authority_base_url: str,
        online_api: str,
        course_id: str,
        query_date: str,
        party_size: int,
    ) -> list[dict] | None:
        async def _do() -> list[dict] | None:
            # Double-checked cache read — another flight may have resolved and
            # cached between our first `.get()` and acquiring the flight.
            cached = self._cache.get(cache_key)
            if cached is not None:
                return cached
            result = await self._do_fetch(
                authority_base_url, online_api, course_id, query_date, party_size
            )
            if result is not None:
                self._cache.set(cache_key, result)
            return result

        return await self._singleflight.run(cache_key, _do)

    async def _do_fetch(
        self, authority_base_url: str, online_api: str, course_id: str,
        query_date: str, party_size: int,
    ) -> list[dict] | None:
        # Host key for the limiter/breaker = the onlineApi host (the engine we
        # actually pull availability from).
        host = online_api[len("https://"):].split("/", 1)[0]

        # Rate limiter first — self-throttling is not an upstream signal, so it
        # never counts a breaker failure.
        retry_after = self._limiter.check(host)
        if retry_after is not None:
            log.info("clubprophet: rate-limited host=%s retry_after=%.1fs", host, retry_after)
            return None

        if not self._breaker.allow():
            return None

        async with httpx.AsyncClient(
            timeout=REQUEST_TIMEOUT_S, transport=self._transport
        ) as client:
            # Step 1 — short-lived public browse token.
            token = await self._mint_token(client, authority_base_url, host)
            if token is None:
                return None
            # Step 2 — register the pre-search transaction id.
            transaction_id = str(uuid.uuid4())
            if not await self._register_txn(client, online_api, transaction_id, host):
                return None
            # Step 3 — availability.
            return await self._fetch_times(
                client, online_api, course_id, query_date, party_size,
                transaction_id, token, host,
            )

    async def _mint_token(
        self, client: httpx.AsyncClient, authority_base_url: str, host: str
    ) -> str | None:
        url, fields, headers = build_token_request(authority_base_url)
        try:
            resp = await client.post(url, data=fields, headers=headers)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            log.warning("clubprophet: token request error host=%s exc=%r", host, exc)
            self._breaker.record_failure(reason="token-request-error")
            return None
        except Exception as exc:
            log.warning("clubprophet: token unexpected error host=%s exc=%r", host, exc)
            self._breaker.record_failure(reason="token-request-error")
            return None

        if resp.status_code != 200:
            log.warning("clubprophet: token non-200 status=%d host=%s", resp.status_code, host)
            self._breaker.record_failure(reason=f"token-{resp.status_code}")
            return None
        try:
            token = resp.json().get("access_token")
        except Exception:
            self._breaker.record_failure(reason="token-non-json")
            return None
        if not isinstance(token, str) or not token:
            self._breaker.record_failure(reason="token-missing")
            return None
        return token

    async def _register_txn(
        self, client: httpx.AsyncClient, online_api: str, transaction_id: str, host: str
    ) -> bool:
        url, body, headers = build_register_txn_request(online_api, transaction_id)
        try:
            resp = await client.post(url, json=body, headers=headers)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            log.warning("clubprophet: register-txn request error host=%s exc=%r", host, exc)
            self._breaker.record_failure(reason="register-request-error")
            return False
        except Exception as exc:
            log.warning("clubprophet: register-txn unexpected error host=%s exc=%r", host, exc)
            self._breaker.record_failure(reason="register-request-error")
            return False
        if resp.status_code != 200:
            log.warning("clubprophet: register-txn non-200 status=%d host=%s", resp.status_code, host)
            self._breaker.record_failure(reason=f"register-{resp.status_code}")
            return False
        return True

    async def _fetch_times(
        self, client: httpx.AsyncClient, online_api: str, course_id: str,
        query_date: str, party_size: int, transaction_id: str, token: str, host: str,
    ) -> list[dict] | None:
        url, params, headers = build_times_request(
            online_api, course_id, query_date, party_size, transaction_id, token
        )
        try:
            resp = await client.get(url, params=params, headers=headers)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            log.warning("clubprophet: times request error host=%s exc=%r", host, exc)
            self._breaker.record_failure(reason="request-error")
            return None
        except Exception as exc:
            log.warning("clubprophet: times unexpected error host=%s exc=%r", host, exc)
            self._breaker.record_failure(reason="request-error")
            return None

        if resp.status_code != 200:
            log.warning("clubprophet: times non-200 status=%d host=%s", resp.status_code, host)
            self._breaker.record_failure(reason=str(resp.status_code))
            return None
        try:
            data = resp.json()
        except Exception:
            log.warning("clubprophet: non-JSON response host=%s", host)
            self._breaker.record_failure(reason="non-json")
            return None

        if not isinstance(data, dict) or "content" not in data:
            log.warning("clubprophet: unexpected top-level shape host=%s", host)
            self._breaker.record_failure(reason="non-dict")
            return None

        content = data["content"]
        if isinstance(content, list):
            self._breaker.record_success()
            return _normalize_day(content, query_date=query_date, party_size=party_size)
        if isinstance(content, dict) and content.get("messageKey") == _NO_TEETIMES_MESSAGE_KEY:
            # Real verified-empty day.
            self._breaker.record_success()
            return []

        # A content object with any other messageKey (unexpected/error message)
        # — do NOT read it as empty. Schema drift ⇒ couldn't check + breaker.
        log.warning(
            "clubprophet: unexpected content shape (messageKey=%r) host=%s",
            content.get("messageKey") if isinstance(content, dict) else type(content).__name__,
            host,
        )
        self._breaker.record_failure(reason="content-drift")
        return None

    # ── Standalone provider mode (debug only, mirrors ChronogolfProvider) ──

    async def search_availability(self, query: TeeTimeQuery) -> list[TeeTimeSlot]:
        try:
            origin = _parse_latlng(query.area)
            if origin is None:
                return []
            max_dist = query.max_distance_miles if query.max_distance_miles is not None else 15.0

            results: list[TeeTimeSlot] = []
            for cap in self._capabilities():
                if cap.platform != "clubprophet" or cap.is_private:
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
            log.exception("clubprophet: search_availability failed — returning empty")
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
