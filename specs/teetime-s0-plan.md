# S0 Implementation Plan — "Kill fake data" (tee-time slice S0)

**Repo:** /Users/justinlee/projects/scorecard · **Epic:** specs/teetime-real-booking-plan.md (S0 bullet) · **Owner directive:** "I want real data." No foreUP, no new DB table, no migration.

## 0. What exists today (verified in code)

- `backend/app/services/tee_times/affiliate.py` — `AffiliateLinkProvider.search_availability()` emits ONE `estimated=True` slot per discovered course with `time = query.time_window_start` (lines 149–166). This is the synthesized-slot source the frontend renders as "Held".
- `backend/app/routes/tee_times.py:246–252` — when a real provider returns `[]`, the route substitutes the mock catalogue and labels it `mock-fallback` ("the screen never goes empty"). `_get_provider()` (lines 62–81) defaults to affiliate, and **any unknown `TEETIME_PROVIDER` value silently falls through to `MockTeeTimeProvider()`** — a typo in a prod env var yields demo data on the real path.
- `frontend/src/lib/teetime/client.ts:55–59, 78–81` — a **second** fake-data path: any backend failure silently falls back to the frontend mock provider (`getActiveProvider()`, which defaults to mock).
- `frontend/src/app/tee-time/page.tsx` — Confirmed component: `stampWord = "Held"` for `needs_human` (line 1079), "Held for you to book" in the looper line (1082) and sub-copy (1186), `isMock` "Demo" stamp (1122) and "(Demo data.)" suffixes (1082–1083); Searching logs "Provider unavailable — demo data" (886).
- `search_cache.py` keys on `provider.name` (`query_cache_key`, line 30) — a provider rename orphans old cache entries (which is desirable here: stale fake slots become unreachable).
- `TeeTimeBooking` ORM (`backend/app/db/models.py:462–484`): `slot_time` is `Text NOT NULL` — an empty string is valid; **no migration needed**.
- The frontend `TeeTimeSlot` mirror lives at **`frontend/src/lib/teetime/types.ts`** (not `lib/types.ts` — that file has no tee-time types).
- No private-club handling exists anywhere (`grep Liberty` only hits specs).

## 1. Core decisions

### 1a. Delete `affiliate.py`; create `routing.py` (recommended)

**Delete, don't gut.** Rationale:
- The epic plan explicitly lists "DELETE backend/app/services/tee_times/affiliate.py".
- The synthesized-slot emission *is* the heart of the class — its name, docstring, provider label `"affiliate"`, and legal-posture comments all encode the estimated-slot design. Gutting leaves a misnamed shell whose `provider="affiliate"` string keeps propagating into cache keys, DB rows, and the frontend.
- The genuinely reusable, non-fake code — `_default_find_courses`, `_parse_latlng`, `_haversine_miles`, `_radius_meters`, `MAX_COURSES`, the `CourseFinder` injectable-finder type — moves **verbatim** into `routing.py`. Behavioral churn stays near zero where it matters; only the slot-emission loop is rewritten.

### 1b. The S0 `RoutingTeeTimeProvider` contract (the core design decision)

`search_availability()` returns **one route-tagged entry per discovered public course (max 8), with NO fabricated time** — not always-empty. Justification:

1. The epic's S0 bullet requires route-driven "Found" / "Call" / "Book on course site" copy — that needs course entries to render. Always-empty would kill the whole surface until S1; that's not honesty, it's absence.
2. Course discovery (name, distance, website, rating) is **real data** — only the time and the "Held" framing were fabricated. We delete exactly the fabrication.
3. The frontend's Searching→Confirmed flow is built around picking one entry and getting a `needs_human` handoff (`page.tsx:900–920`); routing entries preserve that flow with zero architectural rework.

Exact return, per course (pipeline: discover → `dedupe_by_name` → **private filter** → cap at `MAX_COURSES=8` → sort by `(distance, name)`; filter BEFORE the cap so a private club never consumes a result slot):

```python
TeeTimeSlot(
    id=f"{course_id}-{query.date}-route",   # no time component
    course_id=course_id,
    course_name=name,
    city=course.get("address") or "",
    date=query.date,
    time="",                     # ← NO fabricated time. S1 fills real times.
    players=query.party_size,    # echo of the request — documented as such, never claimed capacity
    price_usd=None,              # never fabricated (unchanged)
    cart_included=False,
    distance_miles=distance,     # same haversine computation, moved verbatim
    rating=float(rating) if rating is not None else 0.0,
    designer=None,
    provider="routing",
    holes=18,                    # pre-existing simplification, unchanged
    booking_url=course.get("website"),
    estimated=False,             # never True from any provider after S0
    route="book_on_site" if course.get("website") else "call",
)
```

`name` property returns `"routing"`. `book()` keeps the affiliate semantics (they were already honest): always `needs_human`, message route-driven ("finish on the course site" / "call or visit … to book"), never a confirmation number. Error/empty discovery → `[]` (honest empty; contract "never raise" preserved).

### 1c. `route` field — the cross-layer contract

- **`backend/app/services/tee_times/base.py`** — add to `TeeTimeSlot`:
  ```python
  route: Literal["book_on_site", "call"] | None = None
  ```
  S0 values: `"book_on_site"` (course website known → deep-link handoff), `"call"` (no website → phone the pro shop), `None` (provider knows real availability — mock today, foreUP in S1). Also update the `provider` comment (`"mock" | "routing" | …`) and mark `estimated` as **legacy/deprecated** (kept with default `False` this slice to avoid touching book-rehydration/ICS/mock-test surfaces; no provider may ever set it `True` again; delete in S1 cleanup).
- **`backend/app/routes/tee_times.py`** — `TeeTimeSlotOut`: add `route: Literal["book_on_site", "call"] | None = None`, map in `from_svc`; in `/book` rehydration add `route=slot_data.get("route")`.
- **`frontend/src/lib/teetime/types.ts`** — mirror on `TeeTimeSlot`:
  ```ts
  /** How this entry gets booked: deep-link handoff, phone call, or (undefined) real bookable availability. */
  route?: "book_on_site" | "call";
  ```
  Keep `types.ts` ↔ `base.py`/`TeeTimeSlotOut` field-for-field in sync (both sides change in this slice; call this out in the PR description).

### 1d. Provider selection — mock only on explicit opt-in

Rewrite `_get_provider()`:

```python
provider_name = os.getenv("TEETIME_PROVIDER", "routing")
if provider_name == "mock":
    return MockTeeTimeProvider()          # dev/tests only — explicit opt-in
if provider_name not in ("routing", "affiliate"):   # "affiliate" = legacy alias
    log.warning("Unknown TEETIME_PROVIDER=%r — using routing", provider_name)
return RoutingTeeTimeProvider()
```

Two deliberate inversions: (1) unknown values now fail toward the **real** provider, never demo data; (2) `"affiliate"` is accepted as a legacy alias so a prod environment still carrying `TEETIME_PROVIDER=affiliate` lands on the real path with zero env change (without the alias it would fall to mock — the worst possible S0 outcome).

**Delete the mock-fallback block** (routes/tee_times.py:246–252, and the module docstring line "falls back to mock results…"): `provider_name` is always `provider.name`; empty is empty and gets cached as such (empty lists are already valid cache hits per `test_empty_result_list_is_a_valid_hit`).

## 2. Private-club filter — the correctness surface

### Files
- **`backend/app/services/tee_times/private_filter.py`** (new)
- **`backend/data/private_clubs.json`** (new; sits beside `courses.json` etc.)

### JSON shape

```json
{
  "_comment": "Private clubs excluded from tee-time results BEFORE routing. Matching: exact normalized-name equality (name or alias) with generic suffix folding; optional near-anchor and provider ids. NEVER substring match. Keep entries specific; always set `near` when known.",
  "clubs": [
    {
      "name": "Liberty National Golf Club",
      "aliases": ["Liberty National Golf Course", "Liberty National"],
      "ids": [],
      "near": { "lat": 40.7095, "lng": -74.0532, "radius_miles": 10 }
    }
  ]
}
```

- `name` (required): canonical full name.
- `aliases` (optional): known source variants — OSM often tags "… Golf Course" where Places says "… Golf Club" (verified: OSM results carry `tags.name`; Places carries `displayName.text`).
- `ids` (optional): exact provider-namespaced ids (`"gplaces-<placeId>"`, `"way/<n>"`) — zero-false-positive matches once an offender's id is known.
- `near` (optional but strongly recommended): geo anchor; when both the entry and the discovered course have coordinates, the name match only excludes within `radius_miles`.

### Matching rule (spell it out — the reviewer surface)

`is_private(course, clubs)` returns True iff:
1. `course["id"]`/`course["osm_id"]` is in any entry's `ids`, **or**
2. `normalize(course["name"])` equals `normalize(entry.name)` or any `normalize(alias)`, **and** (if the entry has `near` and the course has a `center`) haversine(course.center, entry.near) ≤ `radius_miles`. Entries without `near`, or courses without a center, match on name alone.

`normalize()`: NFKD-fold to ASCII, casefold, strip punctuation, collapse whitespace, then strip **one trailing generic suffix** from a fixed set — `golf club`, `golf course`, `golf links`, `country club`, `golf resort`, `gc`, `cc` — so "Liberty National Golf Club" and "Liberty National Golf Course" both normalize to `liberty national`. **Exact equality only — never substring/token-subset matching** (substring would let a "Liberty National" entry swallow an unrelated "Liberty National Park Golf Course"; token-subset would let "Liberty" swallow every Liberty-named muni).

**False-positive risks & mitigations (state these in the module docstring):**
- *Same stripped name, different place* ("Riverside Country Club" private in one state vs "Riverside Golf Course" public in another): mitigated by `near` — set it on every entry; Liberty National's entry ships with it.
- *Suffix folding collisions*: only one trailing suffix is stripped, and only from the fixed generic set — "Liberty National" never folds further to "Liberty".
- *False negatives* (unlisted variants, e.g. "Liberty National GC"): accepted for S0 — `gc` is in the suffix set, other variants go in `aliases`; the S1 `CourseBookingCapability.is_private` fact record supersedes this list per-course.

**Loading policy:** parse the file eagerly on first use (module-cached, path injectable for tests) and **raise on missing/malformed JSON** — the file is checked into the repo, so a broken edit must fail CI/boot loudly rather than silently readmitting Liberty National (fail-open here would be the silent-fake-data bug in a new costume). A test pins that the shipped file parses and contains Liberty National.

API: `load_private_clubs(path=DEFAULT) -> tuple[PrivateClubEntry, ...]`, `is_private(course: dict, clubs=None) -> bool`, `exclude_private(courses: list[dict], clubs=None) -> list[dict]`. Called from `RoutingTeeTimeProvider.search_availability()` right after `dedupe_by_name`, before the cap.

## 3. Frontend — kill "Held", honest copy, no demo leakage

All in `frontend/src/app/tee-time/page.tsx` unless noted. Keep the yardage-book components/typography exactly as they are — this is a copy-and-logic change, not a redesign (NORTHSTAR: calm, quiet, honest).

1. **Extract a pure copy helper** — new `frontend/src/lib/teetime/confirm-copy.ts`: `confirmCopy(slot, bookingResult) -> { stampWord, looperLine, ctaLabel, subCopy }`. This is what makes "no Held anywhere" *testable* (vitest asserts it), and it slims the Confirmed component.
   - `stampWord`: `confirmed → "Booked"`, `pending → "Pending"`, `needs_human → "Found"` (**"Held" dies here**), else `"Found"`.
   - `looperLine`, route-driven:
     - `route === "book_on_site"`: `Found ${courseName}, ${distanceMiles} mi away. They take the reservation — book on the course site.`
     - `route === "call"`: `Found ${courseName}. No online booking — call the pro shop to set it up.`
     - real confirmed (mock dev mode only): existing "Found one…" line, keeping the "(Demo data.)" suffix **only** for `provider === "mock"` (honest labeling of an explicitly-mocked dev run; unreachable on the real path after this slice).
   - `subCopy` under the CTA: replace "Held for you to book — the course takes the reservation" (line 1186) with "You book direct — the course takes the reservation."
   - CTA stays "Book on the course site →" / "Call the course to book" (already honest).
2. **Confirmed component** (~1040–1236):
   - Use `confirmCopy`. Delete the inline `stampWord`/`looperLine` ternaries with "Held".
   - **Time card without a fabricated time**: gate every render of `slot.time` on truthiness (`formatTime12h("")` currently produces `NaN:NaN`). When `slot.time === ""` and `route` is set: kicker "Your window" instead of "Tee off", and the big figure shows the requested window. Pass the page's `windows` state (selected entries) into `Confirmed` as a new prop (trivial — `TeeTimePage` already holds it, line 107/243) and pick the window whose `date` matches `slot.date`, falling back to the first selected. Render e.g. "7:00–10:00 AM".
   - Drop the `~` estimated-prefix logic (1069–1070) — no provider emits `estimated=True` anymore; the field stays typed but inert.
   - **Calendar button** (1228–1235): render only when `slot.time` is non-empty — never a calendar event at a fabricated time. (ICS code untouched; S1 restores the button with real times.)
   - Keep the `isMock` "Demo" stamp — it is honest labeling and now unreachable outside explicit mock mode.
3. **Searching component** (~827–1037):
   - Line 886: "Provider unavailable — demo data" → "Provider unavailable — couldn't check this window." (state stays `miss`; nothing fake arrives anymore).
   - Line 881: when results are route entries (`results[0]?.route`), log "N course(s) open to the public" instead of "N slots".
   - Line 904 "Locking in." → route-aware: "…— closest match. Setting up your handoff." (a route entry is not a lock).
   - Empty state (895) already honest — tune to "No bookable courses found. Try widening the window or radius."
4. **`frontend/src/lib/teetime/client.ts`** — kill the *silent* mock fallback on the real path (both `searchTeeTimes` and `bookTeeTime`): fall back to the frontend mock **only when `process.env.NEXT_PUBLIC_TEETIME_PROVIDER === "mock"`**; otherwise rethrow so Searching shows the honest miss line. Update the file docstring (devs running frontend without backend must now set the env var — say so in the comment). `registry.ts`/`providers/mock.ts` stay (explicit-opt-in dev tooling), but change `getActiveProvider()`'s implicit default from `"mock"` — it's now only reached under the explicit-mock branch, so it may stay as-is; keep it and note it.
5. **`frontend/src/lib/teetime/types.ts`** — add `route` (see 1c); update the `provider` field comment.

## 4. Exact file list

**Create**
- `backend/app/services/tee_times/routing.py` — `RoutingTeeTimeProvider` + discovery helpers moved verbatim from affiliate.py
- `backend/app/services/tee_times/private_filter.py`
- `backend/data/private_clubs.json`
- `backend/tests/test_tee_time_private_filter.py`
- `backend/tests/test_tee_time_routing.py`
- `frontend/src/lib/teetime/confirm-copy.ts` + `frontend/src/lib/teetime/confirm-copy.test.ts`

**Edit**
- `backend/app/services/tee_times/base.py` — `route` field; deprecate `estimated`; comment updates
- `backend/app/routes/tee_times.py` — delete mock-fallback (246–252); `_get_provider` rewrite; `TeeTimeSlotOut.route` (+`from_svc`); `/book` rehydration `route`; module + `/book` docstrings
- `backend/tests/test_tee_time_provider_default.py` — rewritten semantics (below)
- `backend/tests/integration/test_tee_time_bookings.py` — routing serialization section; keep pinned mock tests
- `frontend/src/lib/teetime/types.ts`
- `frontend/src/lib/teetime/client.ts`
- `frontend/src/app/tee-time/page.tsx`

**Delete**
- `backend/app/services/tee_times/affiliate.py`
- `backend/tests/test_tee_time_affiliate.py`

(Only comment-level references to "affiliate" exist elsewhere — `voice_booking/provider.py:76`, `course_finder.py:275`, `client.ts:21`; touch those comments opportunistically, no logic.)

## 5. Tests

**`test_tee_time_private_filter.py`** (non-DB):
- "Liberty National Golf Club" (Places variant) and "Liberty National Golf Course" (OSM variant) both excluded — with `center` inside the `near` radius.
- A public course kept: "Lincoln Park Golf Course".
- **No substring false positive**: "Liberty Golf Course" (different course) is kept; a same-normalized-name course *outside* the `near` radius is kept.
- Case/punctuation insensitivity; `ids` exact match excludes regardless of name.
- Shipped `private_clubs.json` parses and contains Liberty National; malformed JSON raises (fail-loud pin).

**`test_tee_time_routing.py`** (non-DB; port the injected-finder fixtures from the deleted affiliate test):
- One route entry per public course; `route == "book_on_site"` with website, `"call"` without.
- **Honest core**: every entry has `time == ""`, `estimated is False`, `price_usd is None` — a synthesized time slot is a test failure.
- Liberty National in the finder's results never reaches the output (filter wired in, before the cap).
- Distance sort/filter, MAX_COURSES cap, empty finder → `[]`, finder error → `[]` (never raises), skips id-less/nameless courses (all ported).
- `book()` → `needs_human`, message route-appropriate, never a confirmation number.
- `_parse_latlng` / `_haversine_miles` helper tests ported.

**`test_tee_time_provider_default.py`** (rewrite):
- Default (env unset) → `RoutingTeeTimeProvider`; `TEETIME_PROVIDER=mock` → mock; **`TEETIME_PROVIDER=affiliate` (legacy) → routing; unknown value → routing** (inverted from today's mock fallback — the old `test_unknown_value_falls_back_to_mock` asserts the behavior we're killing).
- Replace `TestEmptyResultFallback` with the honest-empty pin: empty routing result → `resp.results == []`, `resp.provider == "routing"` — **never** `mock-fallback`, and grep-level: the string `mock-fallback` no longer exists in the route.

**`integration/test_tee_time_bookings.py`** (DB-backed — CI runs it; locally only with the test DB up):
- The two tests pinned in 74626fb (`test_confirmed_booking_is_persisted`, `test_mock_slots_are_not_estimated`) **still hold unchanged** — they set `TEETIME_PROVIDER=mock` explicitly, and explicit mock remains reachable. Verified: assertions don't touch the fallback path.
- `_use_affiliate`/`_AFFILIATE_SLOT` → `_use_routing`/`_ROUTING_SLOT` (injected finder; slot has `time: ""`, `route: "book_on_site"`, `provider: "routing"`); `slot_time=""` persists fine (`Text NOT NULL`).
- Section 5 becomes "routing slots serialize honestly": `route` present, `time == ""`, `estimated is False`, `priceUsd is None`, no `"Held"` anywhere in the response payload.
- `TestSearchCache` currently runs the **default provider with no injected finder** — post-S0 that's routing, whose Places/Mapbox legs no-op without keys but shouldn't be trusted in CI: pin `TEETIME_PROVIDER=mock` (cache semantics are provider-agnostic) or inject an empty-finder routing provider; cached-empty (`cached=True` on `[]`) still passes because empty lists are valid hits.

**Frontend** (`confirm-copy.test.ts`): for every `(route, status, bookingUrl)` combination, output contains no `"Held"` substring; `book_on_site` → "book on the course site" copy; `call` → call copy; `needs_human` stamp is "Found". `teetime.test.ts` (mock provider/registry) unchanged.

`test_tee_time_search_cache.py` — untouched (provider name is a free string parameter there).

## 6. Edge cases & risks

- **Private-filter false positives/negatives** — §2; the mitigations (exact normalized equality, fixed suffix set, `near` anchors, no substrings) are the reviewer's checklist.
- **Cache keys**: `query_cache_key` embeds `provider.name`; renaming `affiliate → routing` orphans every pre-S0 cache entry in `backend/data/tee_time_search_cache.json`. That is a *feature* — stale fake `estimated` slots become unreachable instantly — and the 15-min TTL prunes them on the next write. **No migration of any kind in S0** (no schema change; `slot_time=""` fits the existing Text column; historic booking rows keep `provider="affiliate"`, display-only).
- **Prod env**: if prod sets `TEETIME_PROVIDER=affiliate`, the alias keeps it on the real path; without the alias it would silently become *mock* — the exact failure mode this slice exists to kill. Also flag `NEXT_PUBLIC_TEETIME_PROVIDER` must NOT be `mock` in prod.
- **`formatTime12h("")` → `NaN:NaN`** — every `slot.time` render must be gated (Confirmed time card, ICS button, Searching log line 904).
- **Local dev without backend**: client.ts no longer silently serves mock — devs opt in with `NEXT_PUBLIC_TEETIME_PROVIDER=mock`; document in the client.ts docstring.
- **Auto-book still fires** in Searching for route entries → `needs_human` rows with `slot_time=""` persist as handoff records — acceptable and honest; revisit UX in S1.
- **`VoiceCallProvider.book` assumes `slot.time` is `HH:MM`** (`voice_booking/provider.py:78–79`) — unreachable from S0 routing (nothing returns it from `_get_provider`), but S3 must feed it the window, not `""`. Leave a TODO comment.
- **`estimated` kept-but-inert** — deliberate churn limiter; schedule deletion in S1.

## 7. Gates (run in this order)

```
cd /Users/justinlee/projects/scorecard/backend && ruff check .
cd backend && python -m pytest tests/test_tee_time_routing.py tests/test_tee_time_private_filter.py \
    tests/test_tee_time_provider_default.py tests/test_tee_time_search_cache.py -q   # non-DB, run locally
# DB-backed (CI; locally only with the test DB): pytest tests/integration/test_tee_time_bookings.py -q
cd frontend && npm run lint
cd frontend && npx tsc --noEmit
cd frontend && npx vitest run src/lib/teetime   # teetime.test.ts + confirm-copy.test.ts + courses.test.ts
cd frontend && npm run build
cd frontend && npx tsx voice-tests/runner.ts --smoke   # tee-time prefs parsing unaffected, but pins the voice path
```

Manual noticeability check (what the owner sees): search with location on → real nearby public courses stamped **"Found"**, window shown instead of a fake tee time, "Book on the course site →" or "Call the course to book"; Liberty National absent; no location/nothing found → honest "No bookable courses found", never the demo catalogue; no "Held" anywhere.
