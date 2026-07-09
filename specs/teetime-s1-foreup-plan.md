# S1 Implementation Plan — Real foreUP availability (teetime-s1-foreup-availability)

**Repo:** /Users/justinlee/projects/scorecard · **Epic:** specs/teetime-real-booking-plan.md (S1 bullet) · **Builds on:** specs/teetime-s0-plan.md (shipped).

**Goal:** when a discovered course is known to be foreUP-bookable, return REAL tee-time
slots from foreUP's public times endpoint + a deep-link to the course's foreUP booking
page; every other course keeps the exact S0 behavior (route entry `book_on_site` /
`call`, private excluded, honest empty). No migration, no DB — this machine has no
local Postgres and the migrations dir is guarded; ALL S1 storage is file/JSON.

**NORTHSTAR alignment:** honest data only — a slot is shown iff foreUP's own public
endpoint returned it; we never fabricate a time, price, or capacity, and we never claim
a booking. Read-only, honest UA, heavily cached, circuit-broken.

---

## 0. Verified ground truth (do not re-derive; do NOT re-probe the endpoint)

- **Endpoint (live-verified this cycle):**
  `GET https://foreupsoftware.com/index.php/api/booking/times?time=all&date=MM-DD-YYYY&holes=all&players={N}&booking_class=false&schedule_id={SID}&specials_only=0&api_key=no_limits`
  with required header `api-key: no_limits`. Returns HTTP 200 + a **JSON array** of slot
  objects. `date` is `MM-DD-YYYY`. `booking_class=false` works (no class id needed).
- **Per-slot fields (confirmed):** `time` (`"YYYY-MM-DD HH:MM"`, **course-local** — use
  THIS, not `start_front`), `course_id` (int), `course_name`, `schedule_id`,
  `teesheet_id`, `teesheet_holes` (int), `available_spots` (int),
  `available_spots_9`, `available_spots_18`, `maximum_players_per_booking`,
  `minimum_players`, `allowed_group_sizes` (array of strings), `holes` (`"9/18"`),
  `has_special`, plus green-fee/cart-fee and tax fields. **Any field may be JSON
  `false` instead of null** — parse defensively.
- **Seed course (real, verified):** 18 Mile Creek Golf Course, Hamburg NY —
  foreUP course_id **20410**, schedule_id **4467**, public booking page
  `https://foreupsoftware.com/index.php/booking/20410/4467`.
- **Existing contracts (verified in code):**
  - `backend/app/services/tee_times/base.py` — `TeeTimeSlot` already has `time`,
    `route` (`"book_on_site"|"call"|None`, where `None` = "provider knows real
    availability"), `phone`, `booking_url`, `price_usd`, `estimated` (deprecated,
    always False). **No new slot fields are needed for S1.**
  - `routing.py` — `RoutingTeeTimeProvider`: pipeline discover → `dedupe_by_name` →
    `exclude_private` → cap `MAX_COURSES=8` → sort `(distance, name)`; contract
    "never raise, return []".
  - `search_cache.py` — `SearchCacheStore`/`FileSearchCacheStore` (injectable
    TTL JSON-file cache) + `query_cache_key`. Reuse `FileSearchCacheStore` as-is
    for the availability cache (different path + TTL — both are ctor params).
  - `rate_limit.py` — `SlidingWindowLimiter(rpm, window_s, clock)` with
    `.check(key)` → `None` (allowed, recorded) or retry-after seconds. Keyed by an
    arbitrary string — we key on the foreUP **host**.
  - `routes/tee_times.py` — `_get_provider()` env-driven; route-level 15-min search
    cache keyed on `provider.name`; `TeeTimeSlotOut` already carries
    `route`/`phone`/`bookingUrl`. **The route contract does not change in S1.**
  - `frontend/src/lib/teetime/types.ts` mirrors `TeeTimeSlot`; no field changes
    needed (comment updates only).
  - Runtime data files (`backend/data/tee_time_search_cache.json`,
    `caddie_rate_limit.json`) are gitignored via the root `.gitignore` — mirror that
    for the new runtime files.
- **Test posture:** NO live hits in CI or tests. This machine has NO local Postgres —
  every new test must be non-DB (plain pytest, file/JSON fixtures). DB-backed
  integration tests stay in CI and are NOT touched by this slice.

---

## 1. Decision summary (the seven pinned decisions)

1. **`ForeUpProvider`** — new `backend/app/services/tee_times/foreup.py`, implements
   the `TeeTimeProvider` ABC, plus a router-facing
   `slots_for_capability(...) -> list[TeeTimeSlot] | None` where `None` means
   "couldn't check" (breaker open / rate-limited / HTTP or parse failure) and `[]`
   means "verified: nothing available". Full parse contract in §3.
2. **Capability persistence = JSON files, NO migration, NO DB.** Checked-in curated
   seed `backend/data/foreup_ny_seed.json` (fail-loud on parse, like
   `private_clubs.json`) + optional script-appended
   `backend/data/foreup_validated.json` (fail-soft, gitignored). Store module
   `backend/app/services/tee_times/capability_store.py`. **A real DB table is NOT
   needed for S1** — the record set is a curated handful of NY courses; a table
   becomes worthwhile only at S3+ scale. Record shape pinned in §4.
3. **Router = new `backend/app/services/tee_times/router_provider.py`** with
   `RoutedTeeTimeProvider(RoutingTeeTimeProvider)` overriding a small per-course hook
   extracted in `routing.py`. Matching = exact normalized name (reuse
   `private_filter.normalize`) + proximity ≤ 1.0 mile, or exact provider-namespaced
   id. Fallback order pinned in §5.
4. **Cache 8 min TTL (one poll per course/date/players, window filtered post-cache),
   single-flight via in-process asyncio futures, `SlidingWindowLimiter(rpm=10,
   window_s=60)` keyed `"foreupsoftware.com"`, circuit breaker 3 consecutive
   failures → open 300 s → half-open (1 trial) → close on success.** §6.
5. **`backend/scripts/validate_foreup_courses.py`** — URL → fingerprint → ONE probe →
   append capability row; also `--capture-fixture` (this is how the CI fixture is
   captured). Never run in CI. §7.
6. **Tests** — recorded fixture `backend/tests/fixtures/foreup_18mile_times.json`
   captured LIVE ONCE during build (hand-writing it is a BLOCKING violation —
   tasks/lessons.md); all assertions DERIVED from the fixture so they stay true
   regardless of what the capture contains. §8.
7. **Frontend** — real foreUP slots already flow through the S0 UI (`time !== ""`
   renders the big tee-time figure, calendar button returns, `bookingUrl` renders the
   CTA). Three tiny honesty/copy touches only; `types.ts` comment sync. §9.

---

## 2. Architecture (per search)

```
RoutedTeeTimeProvider.search_availability(query)          [name = "router"]
  └─ inherited pipeline: discover → dedupe → exclude_private → cap(8) → sort
       per course → _slots_for_course(course, query, distance):
         cap = match_capability(course)                    [capability_store]
         cap is None            → [S0 route entry]         (unchanged behavior)
         cap.is_private         → []                       (excluded entirely)
         foreup disabled (env)  → [S0 route entry]
         else → ForeUpProvider.slots_for_capability(cap, query, ...)
                  ├─ list with slots → REAL slots (provider="foreup", route=None,
                  │                    booking_url = cap.booking_url deep-link)
                  ├─ []  (verified empty in window) → OMIT the course
                  └─ None (couldn't check)          → S0 route entry, but with
                        booking_url=cap.booking_url and phone=cap.phone or course's
ForeUpProvider fetch path (inside slots_for_capability / search_availability):
  availability cache (8 min, key=course/date/players) → single-flight →
  rate limiter → circuit breaker → httpx GET (8 s timeout, honest UA) →
  parse JSON array → normalize full day → cache → window/party/price filter
```

`RoutedTeeTimeProvider.book(slot, details)` dispatches on `slot.provider`:
`"foreup"` → `ForeUpProvider.book` (always `needs_human` + deep-link — S2 owns the
booking handoff UX; we NEVER book programmatically), else `super().book`.

---

## 3. `ForeUpProvider` — exact contract (`backend/app/services/tee_times/foreup.py`)

### 3a. Module docstring MUST contain the legal-posture paragraph

> Read-only availability display against foreUP's own public, unauthenticated
> `times` endpoint — the same call the course's public booking page makes. We
> identify honestly (`User-Agent: Looper/1.0 (golf tee-time availability)`), poll at
> low frequency (≤10 req/min per host, 8-minute cache, one poll per
> course/date/party), never log in, never solve CAPTCHAs, never book or charge, and
> back off via a circuit breaker on any 4xx/bot signal. Risk is LOW but not zero
> (browse-wrap ToS); a foreUP vendor-API application is filed in parallel
> (specs/teetime-real-booking-plan.md, "Legal posture").

### 3b. Constructor (everything injectable, defaults real)

```python
ForeUpProvider(
    capabilities: Callable[[], tuple[CourseBookingCapability, ...]] = load_capabilities,
    cache: SearchCacheStore | None = None,      # default FileSearchCacheStore(
                                                #   path=backend/data/foreup_availability_cache.json,
                                                #   ttl_seconds=FOREUP_CACHE_TTL_S)
    limiter: SlidingWindowLimiter | None = None,  # default module singleton rpm=10/60s
    breaker: CircuitBreaker | None = None,        # default module singleton (§6c)
    transport: httpx.AsyncBaseTransport | None = None,  # tests: httpx.MockTransport
    clock: Callable[[], float] = time.monotonic,
)
```

Module constants (pin these literals):

```python
FOREUP_HOST = "foreupsoftware.com"
TIMES_URL = "https://foreupsoftware.com/index.php/api/booking/times"
USER_AGENT = "Looper/1.0 (golf tee-time availability)"   # same style as osm.py
REQUEST_TIMEOUT_S = 8.0
FOREUP_CACHE_TTL_S = 480          # 8 min — inside the required 5–10 min band
FOREUP_RPM = 10                   # per-host, 60 s window
MAX_SLOTS_PER_COURSE = 6          # earliest N inside the window — calm, scannable
```

### 3c. Request build (from `TeeTimeQuery` + capability)

- `query.date` `"YYYY-MM-DD"` → `datetime.strptime(query.date, "%Y-%m-%d")` →
  `strftime("%m-%d-%Y")`. `ValueError` → return `None` ("couldn't check") without
  any network call.
- Params (exact): `time=all`, `date=<MM-DD-YYYY>`, `holes=all`,
  `players=str(query.party_size)`, `booking_class=false`,
  `schedule_id=cap.schedule_id`, `specials_only=0`, `api_key=no_limits`.
- Headers (exact): `{"api-key": "no_limits", "User-Agent": USER_AGENT}`.
- `httpx.AsyncClient(timeout=REQUEST_TIMEOUT_S, transport=self._transport)`.

### 3d. Parse + normalize — field-by-field mapping table

Response must be a JSON **array**; anything else (dict, string, decode error) is a
fetch failure. Helper `_as_int(v)`/`_as_price(v)` treat JSON `false`, `None`, bools,
and non-numeric strings as absent (`isinstance(v, bool)` must be checked BEFORE
`isinstance(v, int)` — Python bools are ints).

| foreUP field | → TeeTimeSlot | Rule (pin exactly) |
|---|---|---|
| `time` `"YYYY-MM-DD HH:MM"` | `date`, `time` | split on the single space; left part MUST equal `query.date` else drop the slot; right part must parse via `strptime("%H:%M")` else drop. Course-local; no TZ math ever. |
| `available_spots` | `players` | must be a real int (not bool) and `>= query.party_size`, else **drop** — we never overstate capacity. `players = available_spots` (real open spots, not an echo). |
| `green_fee` | `price_usd` | numeric (int/float, not bool) and `> 0` → `float(green_fee)`; otherwise `None` — NEVER fabricated, never 0. (Confirm exact key name against the captured fixture; if the fixture spells it differently — e.g. `green_fee_18` — map that instead and note it in the module docstring. Tax and cart fields are ignored.) |
| `teesheet_holes` | `holes` | `9` or `18` → itself; anything else → `18`. (`holes: "9/18"` string is ignored.) |
| `course_name` | — | ignored for display (`cap.name` is canonical); asserted in tests against the fixture. |
| `course_id`, `schedule_id`, `teesheet_id`, `available_spots_9/18`, `maximum_players_per_booking`, `minimum_players`, `allowed_group_sizes`, `has_special` | — | ignored in S1. |

Fixed fields on every emitted slot:

- `course_id = f"foreup-{cap.foreup_booking_id}"`
- `id = f"{course_id}-{query.date}-{slot_time}-{i}"` (`slot_time` = `"HH:MM"`, `i` =
  index after sorting — matches the `${courseId}-${date}-${time}-${slotIndex}`
  contract in types.ts)
- `course_name = cap.name`; `city` = matched discovered course's `address` or `""`;
  `distance_miles` = value passed in by the router (0.0 standalone);
  `rating` = matched course's rating or 0.0
- `provider = "foreup"`; `route = None` (real availability — the documented meaning
  of `None` in base.py); `booking_url = cap.booking_url`; `phone = cap.phone`;
  `cart_included = False`; `designer = None`; `estimated = False`.

### 3e. Filters (applied AFTER the cache, in this order)

1. window: `query.time_window_start <= slot.time <= query.time_window_end`
   (compare `datetime.time` objects parsed from both sides; a malformed window value
   → return `None`, never raise).
2. party: `players >= query.party_size` (part of normalize, above — re-checked here
   because cached entries were fetched with the same `players` param anyway).
3. price ceiling: if `query.max_price_usd is not None` and `price_usd is not None`
   and `price_usd > query.max_price_usd` → drop. **Unknown price is kept** (we
   don't claim it's in budget; the deep-link shows the real price).
4. sort ascending by `time`; truncate to `MAX_SLOTS_PER_COURSE`.

### 3f. Contracts

- `slots_for_capability(cap, query, *, distance_miles=0.0, course: dict | None = None)
  -> list[TeeTimeSlot] | None` — `None` = couldn't check; `[]` = verified empty;
  never raises (catch-all → log `warning` once with host+status, count a breaker
  failure where applicable, return `None`).
- `search_availability(query)` (ABC) — standalone mode (e.g. `TEETIME_PROVIDER=foreup`
  for debugging): parse origin from `query.area` via `routing._parse_latlng`; for each
  non-private capability within `query.max_distance_miles` (default 15 mi, haversine
  origin↔cap lat/lng), gather `slots_for_capability`, coerce `None`→`[]`, merge, sort
  `(distance_miles, course_name, time)`. No origin → `[]`. Never raises.
- `book(slot, details)` — ALWAYS
  `BookingResult(status="needs_human", confirmation_number=None,
  message=f"{time12} at {slot.course_name} is open — finish booking on the course's
  site. They take the reservation.", booking_url=slot.booking_url)` where `time12` is
  a local 12-h render of `slot.time`. Never a confirmation number (S2 owns handoff).
- `name` property → `"foreup"`.

---

## 4. Capability store (`backend/app/services/tee_times/capability_store.py`) — NO migration

**Conclusion on storage:** a DB table is NOT unavoidable — do NOT design one. The S1
record set is a curated, hand-validated handful; the injectable file-backed pattern of
`search_cache.py`/`private_filter.py` is sufficient and keeps every test DB-free.

### 4a. Record shape (exact keys; one JSON object per course)

```json
{
  "platform": "foreup",
  "course_id": null,
  "foreup_booking_id": "20410",
  "schedule_id": "4467",
  "booking_url": "https://foreupsoftware.com/index.php/booking/20410/4467",
  "phone": null,
  "is_private": false,
  "verified_at": "2026-07-09T00:00:00Z",
  "name": "18 Mile Creek Golf Course",
  "lat": 42.7,
  "lng": -78.83,
  "aliases": []
}
```

- `platform`: literal `"foreup"` (rows with any other value are skipped with a log
  warning — forward-compat for S4 platforms).
- `course_id`: optional internal/discovery id (e.g. `"gplaces-<placeId>"`,
  `"way/<n>"`); `null` until known. When set, matching may use it exactly (§5b).
- `foreup_booking_id` / `schedule_id`: strings (they appear in URLs; never do math).
- `phone`: E.164 or national string, `null` when unknown — NEVER invented.
- `verified_at`: ISO-8601 UTC of the last successful probe.
- `lat`/`lng`: REAL coordinates for proximity matching. The builder must source them
  from OSM/Places/the validation probe — never guessed. (The values above are
  placeholders in this plan; the seed file ships with real ones.)
- `aliases`: optional list of name variants (additive, mirrors private_clubs.json).

### 4b. Files

- `backend/data/foreup_ny_seed.json` — checked in:
  `{"_comment": "...curated foreUP capability rows; validated via
  scripts/validate_foreup_courses.py; matching is exact-normalized-name + <=1.0 mi
  proximity...", "courses": [<18 Mile Creek row>]}`. **Fail-loud** on
  missing/malformed (same policy + rationale as `private_clubs.json`: a broken edit
  must fail CI, not silently drop the real-data path).
- `backend/data/foreup_validated.json` — written by the validation script, same
  `{"courses": [...]}` shape, **gitignored** (add to root `.gitignore` next to
  `backend/data/tee_time_search_cache.json`), **fail-soft** (missing → `()`,
  malformed → log ERROR, return `()` — a bad script write must not take down search).

### 4c. API

```python
@dataclass(frozen=True)
class CourseBookingCapability: ...           # fields exactly as §4a

load_capabilities(seed_path=SEED_PATH, validated_path=VALIDATED_PATH)
    -> tuple[CourseBookingCapability, ...]   # module-cached per path pair;
                                             # validated rows APPEND after seed rows;
                                             # duplicate (foreup_booking_id, schedule_id)
                                             # keeps the SEED row (curated wins)

match_capability(course: dict, caps) -> CourseBookingCapability | None   # §5b
```

---

## 5. Router (`backend/app/services/tee_times/router_provider.py`) + routing.py hook

### 5a. Where the foreUP leg lives — decision

**A new `router_provider.py` composing via subclass**, NOT inline edits to
`RoutingTeeTimeProvider`: the epic's file list names `router_provider.py`; routing.py
stays the pure S0 fallback (and the kill-switch target); the S0 test suite keeps
passing untouched. To avoid duplicating the discovery pipeline, `routing.py` gets a
minimal refactor (behavior-identical):

- extract module-level `build_route_entry(course: dict, query: TeeTimeQuery,
  distance: float) -> TeeTimeSlot | None` (returns `None` for id-less/nameless
  courses; body = the current loop's slot construction, verbatim);
- add hook `async def _slots_for_course(self, course, query, distance) ->
  list[TeeTimeSlot]` whose base impl returns `[entry] if entry else []`;
- the loop becomes `slots.extend(await self._slots_for_course(course, query,
  distance))`; sort key becomes `(s.distance_miles, s.course_name, s.time)` so
  multiple real slots per course order by time.

### 5b. Capability matching (discovered OSM/Places course → seed row)

`match_capability(course, caps)` returns the first non-skipped match:

1. **Exact id:** `str(course.get("id") or course.get("osm_id"))` equals
   `cap.course_id` (when set) → match.
2. **Name + proximity:** `private_filter.normalize(course["name"])` equals
   `normalize(cap.name)` or any `normalize(alias)` (reuse the S0 normalizer — same
   suffix folding, exact equality, NEVER substring), **and**:
   - course has a `center` → `_haversine_miles(center, (cap.lat, cap.lng)) <= 1.0`
     (pin `MATCH_RADIUS_MILES = 1.0`; a same-named different course is essentially
     never within a mile). Outside 1.0 mi → no match (keep scanning).
   - course has NO center → name match alone suffices (seed rows are curated; the
     alternative is silently losing the real-data path for hand-added courses).

### 5c. `RoutedTeeTimeProvider`

```python
class RoutedTeeTimeProvider(RoutingTeeTimeProvider):
    def __init__(self, find_courses=None, *, foreup: ForeUpProvider | None = None,
                 capabilities=None, foreup_enabled: bool | None = None): ...
    @property
    def name(self): return "router"     # new route-cache namespace; 15-min-TTL S0
                                        # "routing" entries become unreachable (good)
```

`foreup_enabled` default: `os.getenv("TEETIME_FOREUP_ENABLED", "1") != "0"` — the
kill switch that reverts the whole surface to exact S0 behavior with one env var.

**`_slots_for_course` fallback order (pin exactly):**

1. `not foreup_enabled` or `match_capability(...) is None` → S0 route entry
   (`super()._slots_for_course`). Unchanged behavior.
2. `cap.is_private` → `[]` (course excluded entirely — the capability fact record
   supersedes the name-list filter, per the S0 plan).
3. `slots_for_capability(...)` returns a **non-empty list** → those real slots.
   The router passes `distance_miles=distance` and `course=course` so
   city/rating come from discovery.
4. returns **`[]` (verified empty)** → **omit the course** (return `[]`). We have
   real data saying nothing is open in that window at that party size — emitting a
   "book on site" entry would send the golfer to a page with no times. This is the
   honest-empty leg.
5. returns **`None` (couldn't check: breaker open, rate-limited, timeout, 4xx/5xx,
   parse failure)** → degraded S0 route entry: `super()` entry, then override
   `booking_url = cap.booking_url` (the foreUP page is the best real deep-link we
   have), `phone = cap.phone or entry.phone`, `route = "book_on_site"`. Honest: "we
   couldn't check, here's exactly where to book."

**`book`:** `slot.provider == "foreup"` → `self._foreup.book(slot, details)`, else
`super().book(slot, details)`.

### 5d. `_get_provider()` wiring (`backend/app/routes/tee_times.py`)

Semantics preserved, one class swap:

- default / `"routing"` / `"affiliate"` / unknown → `RoutedTeeTimeProvider()` (still
  never mock on a typo);
- `"mock"` → `MockTeeTimeProvider()` (unchanged explicit opt-in);
- `"foreup"` → `ForeUpProvider()` (standalone debug mode, documented as such).
- Update the module + function docstrings ("router = foreUP real availability where a
  capability is known, S0 routing otherwise; TEETIME_FOREUP_ENABLED=0 reverts to S0").

Route-level cache note (accepted, document in the route docstring): the 15-min
`_search_cache` sits ABOVE the 8-min foreUP cache, so end-to-end staleness of a real
slot is bounded by 15 min; the deep-link always shows live truth. Do not change the
route TTL in this slice (it also guards the Places/Overpass quota).

---

## 6. Cache, single-flight, rate limit, circuit breaker (all in foreup.py)

### 6a. Availability cache

- Reuse `FileSearchCacheStore` verbatim:
  `FileSearchCacheStore(path=backend/data/foreup_availability_cache.json,
  ttl_seconds=FOREUP_CACHE_TTL_S)` (gitignore the file).
- Key (deterministic JSON, mirrors `query_cache_key` style):
  `json.dumps({"v": 1, "booking_id": cap.foreup_booking_id, "schedule_id":
  cap.schedule_id, "date": query.date, "players": query.party_size}, sort_keys=True)`.
  **Window is NOT in the key** — we cache the normalized FULL DAY (`time=all`) and
  filter per-window on read, which is what makes "one poll per course/date" true
  across different windows. `players` IS in the key because it is a request param of
  the verified endpoint shape (never deviate from the probed shape).
- Cached value: the normalized day slots as dicts
  (`{"time": "HH:MM", "players": n, "price_usd": x|null, "holes": 9|18}`) — small,
  JSON-safe, re-hydrated into `TeeTimeSlot`s with the per-call course context.
  A cached `[]` is a valid hit (verified-empty stays cached — no re-poll storm on
  sold-out days).

### 6b. Single-flight

In-process `dict[str, asyncio.Future]` keyed by the cache key: first caller creates
the future, fetches, resolves, removes the entry in a `finally`; concurrent callers
`await` the same future. Re-check the cache after acquiring the flight (double-checked).
Failure resolves the future with `None` (shared by waiters) — one upstream failure is
one request, not N.

### 6c. Per-host rate limiter

Module singleton `SlidingWindowLimiter(rpm=FOREUP_RPM, window_s=60.0)` (import from
`app.services.rate_limit`), called as `limiter.check(FOREUP_HOST)` immediately before
the HTTP request (after cache + flight, so cache hits never consume budget).
Non-`None` (would exceed) → do NOT sleep/wait → treat as "couldn't check" (`None`)
**without counting a breaker failure** (self-throttling is not an upstream signal).

### 6d. Circuit breaker (small class in foreup.py; injectable clock)

```python
class CircuitBreaker:
    def __init__(self, failure_threshold=3, open_seconds=300.0,
                 clock=time.monotonic): ...
    def allow(self) -> bool      # closed → True; open → False until open_seconds
                                 # elapse; then half-open → True for EXACTLY ONE
                                 # in-flight trial (subsequent allow() → False until
                                 # the trial reports)
    def record_success(self): ...  # closes the breaker, resets the failure count
    def record_failure(self): ...  # increments; on >= threshold (or any failure
                                   # while half-open) → open, restart the clock
```

- **Failure =** httpx timeout/transport error, any non-200 status (4xx is the
  bot-signal case — a 403/429 opens the breaker after 3 in a row just like a 500),
  or a response that isn't a JSON array.
- **Success =** HTTP 200 + parsed array (even an empty one).
- Thresholds (pin): `failure_threshold=3` consecutive; `open_seconds=300`;
  half-open admits exactly ONE trial; trial failure → immediately re-open for
  another 300 s; trial success → fully closed.
- While open: `slots_for_capability` returns `None` without any network call →
  the router serves the degraded route entry (§5c-5). One module-level breaker
  instance (single host), injectable for tests.
- Log transitions at WARNING (`"foreup breaker OPEN (3 consecutive failures, last
  status=%s) — serving routing fallback for 300s"`).

---

## 7. Discovery half — `backend/scripts/validate_foreup_courses.py`

Read-only, honest UA, ONE probe per invocation. **Never run in CI** (nothing imports
it; docstring says so explicitly). Follows the argparse style of
`scripts/ingest_osm_course.py`.

CLI (pin):

```
uv run backend/scripts/validate_foreup_courses.py \
    --url https://foreupsoftware.com/index.php/booking/20410/4467 \
    [--name "18 Mile Creek Golf Course"] [--lat 42.7xx --lng -78.8xx] \
    [--phone "+1 716 ..."] [--date YYYY-MM-DD] [--players 1] \
    [--out backend/data/foreup_validated.json] [--seed] [--dry-run] \
    [--capture-fixture PATH]
```

Behavior:
1. Parse `foreup_booking_id`/`schedule_id` from the URL path
   (`/index.php/booking/{id}/{sid}` — regex, fail with a clear message otherwise).
2. GET the booking page with `USER_AGENT` (imported from foreup.py — one honest UA);
   fingerprint: response is 200 and the body contains a foreUP marker
   (`"foreupsoftware"` / the booking bootstrap). Extract the course display name from
   the page when `--name` is absent. Not a foreUP page → exit 2, write nothing.
3. ONE probe of the times endpoint (reusing foreup.py's request builder — same params,
   header, timeout) for `--date` (default: today + 2 days) and `--players`
   (default 1 — the superset view). Non-200 / non-array → exit 3, write nothing.
4. Print an honest summary (course, ids, slot count, first/last time, min/max
   green fee seen).
5. `--capture-fixture PATH` → write the RAW response body verbatim to PATH (this is
   the one sanctioned live capture that produces
   `backend/tests/fixtures/foreup_18mile_times.json`).
6. Append `{record}` (§4a shape, `verified_at` = now UTC) to `--out`
   (default `foreup_validated.json`); with `--seed`, target
   `foreup_ny_seed.json` instead (used once at build time to create the 18 Mile Creek
   row with real data instead of hand-typing it). De-dupe on
   `(foreup_booking_id, schedule_id)` (replace, refreshing `verified_at`).
   `--dry-run` prints the row and writes nothing.

---

## 8. Tests (all non-DB; NO live hits; run locally + CI)

### 8a. The fixture — `backend/tests/fixtures/foreup_18mile_times.json`

Captured ONCE during build via
`validate_foreup_courses.py --url .../booking/20410/4467 --players 1
--capture-fixture backend/tests/fixtures/foreup_18mile_times.json` (date ≈ build
date + 2). **NEVER hand-written or edited — a fabricated "real" fixture is a
BLOCKING violation.** Because its exact contents are unknown at plan time, every
assertion is DERIVED from the fixture at test runtime:

- `fixture_date` = the `YYYY-MM-DD` prefix of the first entry's `time`;
- `full_window` = (`"00:00"`, `"23:59"`); narrower windows computed from the parsed
  times actually present;
- expected sets computed by re-applying the documented rules in the test itself
  (e.g. `[e for e in fixture if is_int(e["available_spots"]) and
  e["available_spots"] >= p]`), then asserted equal to provider output.
- One sanity gate that the capture is real: fixture is a non-empty JSON array and
  every entry has a `time` starting with a date and containing `available_spots` —
  if the live course had zero future slots at capture time, the builder re-captures
  with a different `--date` rather than committing an empty fixture.

### 8b. `backend/tests/test_tee_time_foreup.py`

`ForeUpProvider` with `httpx.MockTransport` serving the fixture (asserting the
request it receives has the exact params/headers of §3c — URL, `MM-DD-YYYY` date,
`booking_class=false`, `api-key` header, honest UA), in-memory fake cache store:

- parse/normalize: every emitted slot has `provider="foreup"`, `route is None`,
  `estimated is False`, `time` = `"HH:MM"` matching a fixture entry, `date ==
  query.date`, `booking_url == cap.booking_url`, id shape
  `foreup-20410-<date>-<HH:MM>-<i>`;
- window filter: derived sub-window → exactly the fixture times inside it; a window
  containing no fixture times → `[]` (verified empty, not `None`);
- party filter: for a derived `p` where the fixture has both passing and failing
  entries, output == derived expectation; `players` on each slot equals the fixture's
  `available_spots`, never an echo of the request;
- price: entries with numeric `green_fee` map to `float`; a synthetic array (NOT the
  recorded fixture — a separate hand-built `false`-heavy payload is fine and labeled
  as synthetic) where `green_fee`/`available_spots`/`teesheet_holes` are `false` →
  price `None` / slot dropped / holes 18, no exception;
- `max_price_usd` drops known-over-budget, keeps unknown-price;
- MAX_SLOTS_PER_COURSE truncation keeps the earliest, sorted ascending;
- error legs → `None` from `slots_for_capability`, `[]` from `search_availability`,
  never a raise: transport error, timeout, 500, 403, non-array JSON body,
  `date="not-a-date"`;
- cache: second call within TTL performs zero HTTP calls (transport handler counts);
  after TTL (fake `now_fn` on the store) → refetch; cached `[]` is a hit;
- single-flight: `asyncio.gather` of 5 concurrent calls → exactly 1 HTTP call;
- rate limiter: a limiter pre-filled to the cap → `None` returned, zero HTTP calls,
  breaker NOT failed;
- breaker: 3 failing responses → open (4th call: zero HTTP); injectable clock past
  300 s → exactly one half-open trial; trial success closes (subsequent calls flow),
  trial failure re-opens;
- `book()` → `needs_human`, message contains the 12-h time and course name, carries
  `booking_url`, `confirmation_number is None`.

### 8c. `backend/tests/test_tee_time_capability_store.py`

- shipped `foreup_ny_seed.json` parses; contains 18 Mile Creek with
  `foreup_booking_id="20410"`, `schedule_id="4467"`, `is_private=False`, real
  lat/lng, the booking URL; malformed seed raises (fail-loud pin); missing/malformed
  validated file → seed rows only (fail-soft pin);
- validated row appends; duplicate `(booking_id, schedule_id)` → seed row wins;
- `match_capability`: name variant via alias + center within 1.0 mi → match; same
  normalized name with center 5 mi away → no match; no center → name-only match;
  exact `course_id` match wins regardless of name; `platform != "foreup"` skipped.

### 8d. `backend/tests/test_tee_time_router.py`

`RoutedTeeTimeProvider` with an injected finder (S0 test style) returning: a course
matching the 18 Mile Creek capability (name + nearby center), a plain public course
with a website, a website-less course, and Liberty National; injected fake
`ForeUpProvider` (records calls; scriptable return):

- matched course → real foreup slots present (time non-empty, provider "foreup");
  unmatched public courses → S0 route entries EXACTLY as before (`time==""`,
  route book_on_site/call); Liberty National absent;
- fake returns `[]` (verified empty) → the matched course appears NOWHERE in results;
- fake returns `None` (couldn't check) → a route entry for the course whose
  `booking_url == cap.booking_url` and `route == "book_on_site"`;
- `cap.is_private=True` → course absent even though the finder returned it;
- `foreup_enabled=False` → fake never called; output == plain
  `RoutingTeeTimeProvider` output;
- ordering: `(distance, name, time)` — a matched course's slots are time-ascending;
- `book` dispatch: foreup slot → fake's book called; routing slot → `needs_human`
  via super; `name == "router"`;
- never raises: finder that raises → `[]`.

### 8e. Edits to existing tests

- `backend/tests/test_tee_time_provider_default.py` — default / `"routing"` /
  `"affiliate"` / unknown now assert `isinstance(..., RoutedTeeTimeProvider)` (they
  currently assert `RoutingTeeTimeProvider`; the subclass keeps them true, but pin the
  exact class); add `TEETIME_PROVIDER=foreup` → `ForeUpProvider`; mock opt-in and
  honest-empty tests unchanged.
- `test_tee_time_routing.py`, `test_tee_time_private_filter.py`,
  `test_tee_time_search_cache.py` — MUST pass unchanged (the routing.py refactor is
  behavior-identical; treat any needed edit there as a red flag).
- DB-backed `tests/integration/test_tee_time_bookings.py` — untouched (CI-only). A
  real `slot_time="HH:MM"` persists fine in the existing Text column; no migration.

---

## 9. Frontend (verified against the current code — minimal touches)

**Verified: real foreUP slots already render correctly through the S0 UI.** In
`frontend/src/app/tee-time/page.tsx`: `hasKnownTime = slot.time !== ""` → the time
card shows the real tee time (68-px figure) and the add-to-calendar button returns;
`bookingUrl` (from the `needs_human` BookingResult or the slot) renders the CTA
anchor; Searching's best-pick sort (distance, then known price first) already handles
mixed real-slot + route-entry results. `types.ts` needs NO field changes.

Three small changes:

1. `frontend/src/lib/teetime/confirm-copy.ts` — the `needsHuman` branch currently
   ignores a real time. Add, as the FIRST case inside `needsHuman`:
   `if (slot.time)` → looperLine
   `` `Found ${formatTime12hOrEmpty(slot.time)} at ${slot.courseName} — they take the
   reservation, book it on the course site.` `` (call/book_on_site cases below it
   unchanged — foreup slots have `route` undefined). CTA/subCopy logic unchanged
   (bookingUrl present → "Book on the course site →").
2. `frontend/src/app/tee-time/page.tsx` (~line 914) — the non-route bestLine
   `"… — ${best.players} open. Locking in."` → `"… — ${best.players} open. Setting it
   up."` ("locking in" overclaims for a needs_human deep-link handoff; NORTHSTAR
   honesty).
3. `frontend/src/lib/teetime/types.ts` — comment-only sync: add `"foreup"` to the
   `provider` field comment and note that foreup slots carry a real `time` +
   `bookingUrl` deep-link with `route` undefined. Mirror the same comment touch on
   `provider` in `backend/app/routes/tee_times.py` / `base.py` if drifted.

New vitest cases in `frontend/src/lib/teetime/confirm-copy.test.ts`: needs_human +
`time="07:10"` → looperLine contains `"7:10 AM"` and the course name, no `"Held"`
anywhere; needs_human + `time=""` keeps the existing route-driven lines (regression).

---

## 10. Exact file list

**Create**
- `/Users/justinlee/projects/scorecard/backend/app/services/tee_times/foreup.py`
- `/Users/justinlee/projects/scorecard/backend/app/services/tee_times/capability_store.py`
- `/Users/justinlee/projects/scorecard/backend/app/services/tee_times/router_provider.py`
- `/Users/justinlee/projects/scorecard/backend/data/foreup_ny_seed.json`
- `/Users/justinlee/projects/scorecard/backend/scripts/validate_foreup_courses.py`
- `/Users/justinlee/projects/scorecard/backend/tests/fixtures/foreup_18mile_times.json` (live-captured, §8a)
- `/Users/justinlee/projects/scorecard/backend/tests/test_tee_time_foreup.py`
- `/Users/justinlee/projects/scorecard/backend/tests/test_tee_time_capability_store.py`
- `/Users/justinlee/projects/scorecard/backend/tests/test_tee_time_router.py`

**Edit**
- `/Users/justinlee/projects/scorecard/backend/app/services/tee_times/routing.py` (extract `build_route_entry` + async `_slots_for_course` hook; sort key `+ s.time`; behavior-identical)
- `/Users/justinlee/projects/scorecard/backend/app/routes/tee_times.py` (`_get_provider` → `RoutedTeeTimeProvider`; `"foreup"` opt-in; docstrings incl. staleness note)
- `/Users/justinlee/projects/scorecard/backend/tests/test_tee_time_provider_default.py`
- `/Users/justinlee/projects/scorecard/.gitignore` (add `backend/data/foreup_availability_cache.json`, `backend/data/foreup_validated.json`)
- `/Users/justinlee/projects/scorecard/frontend/src/lib/teetime/confirm-copy.ts` + `confirm-copy.test.ts`
- `/Users/justinlee/projects/scorecard/frontend/src/lib/teetime/types.ts` (comments)
- `/Users/justinlee/projects/scorecard/frontend/src/app/tee-time/page.tsx` (one copy line)

**Do NOT touch:** `backend/migrations/**` (guarded), `backend/app/db/models.py`,
`search_cache.py`, `private_filter.py`, `rate_limit.py`, DB integration tests,
`base.py` fields (comment touches only). `estimated`-field deletion stays deferred
(bigger blast radius than this slice; note it in the PR).

---

## 11. Ordered build steps

1. `capability_store.py` + a **placeholder-free** seed: run
   `validate_foreup_courses.py` is not built yet, so first write the store +
   `foreup_ny_seed.json` with the verified literals (20410/4467/URL/name) and real
   coordinates obtained from OSM/Places for "18 Mile Creek Golf Course, Hamburg NY"
   (never guessed). Tests 8c green.
2. `foreup.py` (request builder, parser, cache, single-flight, limiter, breaker,
   book) with a temporary synthetic array for red/green TDD of the `false`-handling
   test only.
3. `validate_foreup_courses.py` (imports the §3c request builder + UA from foreup.py).
4. **One live capture** (the single sanctioned probe):
   `uv run backend/scripts/validate_foreup_courses.py --url
   https://foreupsoftware.com/index.php/booking/20410/4467 --players 1
   --capture-fixture backend/tests/fixtures/foreup_18mile_times.json --dry-run`.
   Inspect: non-empty array, fields per §0; confirm the exact green-fee key name and
   adjust the §3d mapping if it differs (document in the module docstring). Refresh
   the seed row's `verified_at` (and phone if the page shows one).
5. Finish `test_tee_time_foreup.py` against the recorded fixture (derived
   assertions, §8a/8b).
6. `routing.py` hook extraction; confirm `test_tee_time_routing.py` passes UNCHANGED.
7. `router_provider.py` + `test_tee_time_router.py`.
8. Route wiring + `test_tee_time_provider_default.py` update + `.gitignore`.
9. Frontend touches + vitest cases.
10. Full gates (§12); manual noticeability pass (§12 end).

---

## 12. Gates (run in this order; absolute paths, no local DB ever)

```
cd /Users/justinlee/projects/scorecard/backend && ruff check .
cd /Users/justinlee/projects/scorecard/backend && python -m pytest \
    tests/test_tee_time_foreup.py tests/test_tee_time_capability_store.py \
    tests/test_tee_time_router.py tests/test_tee_time_routing.py \
    tests/test_tee_time_private_filter.py tests/test_tee_time_provider_default.py \
    tests/test_tee_time_search_cache.py tests/test_rate_limit.py -q
# DB-backed tests: CI only (tests/integration/test_tee_time_bookings.py) — never
# start a local Postgres/container (tasks/lessons.md).
cd /Users/justinlee/projects/scorecard/frontend && npm run lint
cd /Users/justinlee/projects/scorecard/frontend && npx tsc --noEmit
cd /Users/justinlee/projects/scorecard/frontend && npx vitest run src/lib/teetime
cd /Users/justinlee/projects/scorecard/frontend && npm run build
cd /Users/justinlee/projects/scorecard/frontend && npx tsx voice-tests/runner.ts --smoke
```

Grep-level gates: `grep -rn "no_limits" backend/app | wc -l` is small and confined to
foreup.py; no test file contains a URL fetch; `Held` still absent from the frontend.

**Manual noticeability check (owner's view):** search near Hamburg NY with a
reasonable window → 18 Mile Creek shows REAL tee times (real clock time on the card,
calendar button back, "Book on the course site →" opening
foreupsoftware.com/index.php/booking/20410/4467); other courses unchanged
("Found …" route entries); pull the network / set a bogus schedule_id in a dev copy →
course degrades to a route entry, never an error screen, never a fake time.

---

## 13. Edge cases (must be handled + tested)

- Empty array from foreUP → verified-empty → course omitted; cached as `[]`.
- All-`false` price fields → `price_usd=None` everywhere; UI shows "—" (already does).
- `available_spots` `false`/missing/bool → slot dropped (never overstate capacity).
- Window with no matching slots (but a non-empty day) → verified-empty for that
  window; a different window on the same day reuses the cached day (no second poll).
- party_size > every slot's spots → verified-empty.
- foreUP 4xx / timeout / HTML error page (non-array JSON) → `None` → degraded route
  entry + breaker failure; 3 in a row → open 300 s.
- `query.date` malformed → `None` without a network call.
- Slot `time` whose date prefix ≠ query.date (foreUP quirk) → dropped.
- `time` missing the space separator / unparseable clock → dropped, no raise.
- Seed file edited badly → loud failure at import/first-use (CI catches);
  validated file corrupt → logged, ignored.
- Two capabilities matching one course → first match wins (seed order; curated).
- Concurrent identical searches → exactly one upstream request (single-flight test).
- Booking rehydration (`/book`) of a foreup slot → `slot_time="07:10"` persists in
  the existing Text column; `provider="foreup"` recorded; no schema change.

## 14. Risks — and what the reviewer should adversarially check

1. **Fixture authenticity (BLOCKING class).** `foreup_18mile_times.json` must be a
   raw live capture (step 11.4), never hand-written/edited; tests must DERIVE
   expectations from it, not hardcode counts that could be quietly bent. Reviewer:
   diff the fixture for suspicious uniformity, confirm the capture command in the PR
   description, and confirm no test asserts literal slot counts/times typed by hand.
2. **Wrong-course real times (worst honesty failure).** A capability matching a
   different discovered course would display Course A's real availability under
   Course B's name. Reviewer: check `match_capability` enforces exact normalized
   equality + ≤1.0 mi, that the >1 mi test exists, and that slot `course_name` comes
   from the capability, `booking_url` from the same capability row.
3. **Fabrication creep in fallbacks.** Verified-empty must OMIT the course (not emit
   a book_on_site entry implying availability); `players` must be foreUP's
   `available_spots`, never an echo; `false` prices must be `None`, never 0.
   Reviewer: hunt for any code path where a foreup-branded slot is constructed
   without a fixture-backed `time`.
4. **Politeness machinery built but not wired.** Cache/limiter/breaker must sit ON
   the fetch path (cache → flight → limiter → breaker → HTTP), not beside it.
   Reviewer: the counting-transport tests (zero HTTP on cache hit / limiter block /
   open breaker) are the proof — confirm they count transport calls, not mock-layer
   calls.
5. **Cache key omissions.** `players` and `date` must be in the availability key
   (a party-of-4 must never see a party-of-1 cached capacity view); window must NOT
   be (or the one-poll property dies). Reviewer: read the key literal.
6. **Behavior drift in the routing.py refactor.** S0 tests must pass byte-identical;
   any edit to `test_tee_time_routing.py`/`test_tee_time_private_filter.py` is a red
   flag (lessons.md: never weaken a spec assertion).
7. **Bool-as-int Python trap.** `isinstance(False, int)` is True — `available_spots:
   false` would pass a naive int check as 0 (or worse, `True` as 1). Reviewer: check
   `_as_int` rejects bools explicitly.
8. **Never-raise contract.** `search_availability` raising bubbles to a 502 in the
   route. Reviewer: every external call in foreup.py sits under the catch-all.
