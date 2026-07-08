# Plan — Nearby course-search latency (LATENCY HALF of `search-speed-and-golfapi-verify`)

Status: ready for builder. Scope: **make nearby (GPS idle-state) course search fast.**
The GolfAPI-universe/verify half is **BLOCKED** (key 401s; call-count must be docs-verified
before spend) — **not in this plan, do not touch it.**

## Northstar / owner-law guardrails (every change honors these)
- Quiet, voice-first, yardage-book feel — no new UI chrome, no SaaS/dashboard drift. This
  work is invisible except "nearby appears faster."
- **Prefix-first relevance** — untouched (nearby is distance-sorted, name `/search` is fine).
- **NEVER reshuffle** — results are stable as they arrive; new legs *append*, never reorder
  what the user already sees.
- **ONE unified search path** — we keep `searchNearbyDetailed` as the single nearby entry;
  no forked code path.
- **Honest empty/loading** — never render mock/demo data; never negative-cache an
  error-empty (only a genuine all-legs-ok empty).
- No wire-shape changes: `frontend/src/lib/types.ts` ↔ `backend/app/models.py` stay as-is.

## Root cause (verified against the code)
`CourseSearch.tsx` mounts → one-shot GPS → `searchNearby` → `searchNearbyDetailed`
(`frontend/src/lib/golf-api.ts:807`) fires two backend legs and **blocks on `Promise.all`**:
1. `/api/courses/mapped/nearby` → PostGIS `ST_DWithin` — **fast** leg.
2. `/api/courses/nearby` (`backend/app/routes/course_search.py:372`) →
   `services/osm.search_golf_courses(interactive=False)` — **slow** leg: `[timeout:8]`
   server + 10s client + 2s-backoff retry ⇒ up to ~12s, **no cache**. Capped `[:15]`.

So the whole nearby section waits on the slow OSM leg even though mapped is ready in ms.

## Chosen wins — final set + order (with justification)

**1. (b) Interactive OSM budget on `/api/courses/nearby` — foundation, ~1-line.**
`search_golf_courses` already supports `interactive=True` (4s server / 5s client / 0.5s
backoff — see `osm.py:344-384`). The nearby route calls it with the default
(non-interactive) budget. Switch it. Worst case drops ~12s → ~5.5s. Cheap, high value.

**2. (e) Two-phase / return-fast render — the headline UX fix.**
Stop blocking mapped on OSM. Render the fast mapped leg the instant it lands (~100-300ms),
then merge the OSM leg in late **without reshuffling**. This is what the owner feels.

**3. (c) Positive-only quantized geo-cell cache on the OSM nearby leg — repeat opens instant.**
Reuse `FileSearchCacheStore` keyed by a ~1.1km cell + radius. **Positive-only** (see the
honesty note below) so we never violate the no-error-empty-cache law.

**4. (a) Cap nearby result count — smaller payload/render, owner-requested.**
A distance-sorted `NEARBY_LIMIT` (12) applied in the pure merge helpers + a `LIMIT` on the
mapped SQL. Minor, low-risk; do NOT touch the shared `search_golf_courses` `[:15]` cap
(it feeds the name-search background enrichment for facility siblings).

**5. (d) GIST index — INVESTIGATE + NOTE-AND-DEFER (no migration in this plan).**
`public.courses.location` is declared `sa.Text` (migration `0003_006_scoring_courses.py:52`)
and cast per-query (`location::geography`, `ST_X(location::geometry)`). A plain GIST index
therefore does not apply, and no such index exists in `backend/migrations/versions/`. The
mapped leg is already fast (small mapped-courses table, and it is not the bottleneck — the
OSM leg is). A column-type change / expression index is a schema migration that is out of
scope and unjustified for a latency fix whose bottleneck is external OSM. **Decision:
note-and-defer** — record a backlog note "convert `courses.location` to a typed
`geography(Point,4326)` column + GIST index if the mapped table grows / EXPLAIN shows a
seq-scan cost." No migration now. (No local Postgres on this machine; do not plan EXPLAIN
here — CI covers DB paths.)

---

## Implementation

### A. Backend — interactive budget + cache (`backend/app/routes/course_search.py`)

Edit `nearby_courses` (currently `course_search.py:372-384`):

- Add a module-level cache instance near `_search_cache` (`:54`). It **must** use a distinct
  file from `_search_cache` (whose default filename is `course_search_cache.json`):
  ```python
  from pathlib import Path
  _nearby_cache: SearchCacheStore = FileSearchCacheStore(
      path=Path(__file__).parent.parent.parent / "data" / "nearby_search_cache.json"
  )
  ```
- Add a pure quantization helper (module-level, testable, no I/O):
  ```python
  NEARBY_CELL_DECIMALS = 2   # ~1.1 km cell at mid-latitudes
  def _nearby_cache_key(lat: float, lng: float, radius_m: int) -> str:
      return f"nearby:{round(lat, NEARBY_CELL_DECIMALS)}:{round(lng, NEARBY_CELL_DECIMALS)}:{radius_m}"
  ```
- Rewrite the handler body:
  ```python
  radius = radiusMeters or 50000
  key = _nearby_cache_key(lat, lng, radius)
  cached = _nearby_cache.get(key)
  if cached is not None:
      return {"courses": cached}
  results = await search_golf_courses(
      lat=lat, lng=lng, radius_m=radius, interactive=True,   # win (b)
  )
  # HONESTY (no-fake-data / no-error-empty): search_golf_courses returns [] for BOTH a
  # genuine empty AND a timeout/error (it returns [] when _post_with_retry -> None). Those
  # are indistinguishable at this seam, so we cache POSITIVE results ONLY and never
  # negative-cache nearby. A genuinely empty area simply re-queries next open (rare, safe).
  if results:
      _nearby_cache.set(key, results)
  return {"courses": results}
  ```
- Wire shape unchanged: still `{"courses": [...]}`.

Note: `search_golf_courses` is imported into the `course_search` module namespace
(`course_search.py:28`), so tests monkeypatch `course_search.search_golf_courses` — keep it
called as the bare imported name (do not switch to `osm.search_golf_courses`).

### B. Frontend — progressive per-leg callback (`frontend/src/lib/golf-api.ts`)

Extend `searchNearbyDetailed` (`:807`) with an **optional** 4th arg so all existing
positional callers (`teetime/courses.ts:291`, `courses/page.tsx`, and the `searchNearby`
wrapper) keep compiling and the final `Promise.all` return value is unchanged:

```ts
export interface NearbyLegUpdate {
  leg: 'mapped' | 'osm';
  results: CourseSearchResult[];
  ok: boolean;
}
export async function searchNearbyDetailed(
  lat: number, lng: number, radiusMeters = 25000,
  onLeg?: (u: NearbyLegUpdate) => void,
): Promise<NearbySearchOutcome> { ... }
```

Inside each leg, build that leg's own `CourseSearchResult[]` locally, push into the shared
`results` (as today, for the aggregate return), AND fire `onLeg`:
- mapped `.then`: `onLeg?.({ leg: 'mapped', results: mappedResults, ok: true })`; `.catch`:
  `{ leg: 'mapped', results: [], ok: false }` (and keep `mappedOk = false`).
- osm `.then`/`.catch`: same with `leg: 'osm'`.
Keep the existing dedupe-against-`results` in the OSM `.then` for the aggregate return; the
progressive path dedupes independently in the component helper (below).

### C. Frontend — stable append helper (`frontend/src/lib/course-search-helpers.ts`)

Add a pure, side-effect-free helper next to `mergeAndSortNearby` (`:151`):

```ts
export const NEARBY_LIMIT = 12;

/** Append newly-arrived nearby results to an already-rendered list WITHOUT
 *  reshuffling existing rows. New rows are deduped against what's shown (by
 *  courseNameKey), sorted among THEMSELVES by distance (mapped-first tie-break),
 *  appended below, then the whole list is capped at `limit`. Honors the owner's
 *  no-reshuffle law: existing rows never move. */
export function appendNearby(
  existing: NearbyResult[],
  incoming: CourseSearchResult[],
  userLat: number, userLng: number,
  limit = NEARBY_LIMIT,
): NearbyResult[]
```
- Compute `distanceMi` for incoming (reuse `distanceMiles`).
- Drop incoming whose `courseNameKey(name)` is already in `existing`.
- Sort the *new* ones by `distanceMi` (Infinity last) with mapped-first tie-break (mirror
  `mergeAndSortNearby`'s comparator).
- Return `[...existing, ...newSorted].slice(0, limit)`.

Also add the same `limit = NEARBY_LIMIT` cap to `mergeAndSortNearby` (used by the other
callers) — win (a), applied at the pure layer so every caller benefits.

### D. Frontend — two-phase render (`frontend/src/components/CourseSearch.tsx`)

Replace the GPS effect (`:435-452`). Instead of `await searchNearby` + one
`mergeAndSortNearby`, drive the two legs progressively:

```ts
GPSWatcher.getCurrentPosition().then(async (pos) => {
  let mappedDone = false, osmDone = false;
  let bothErrored = true;
  await searchNearbyDetailed(pos.lat, pos.lng, 25000, ({ leg, results, ok }) => {
    if (ok && results.length) bothErrored = false;
    // First leg seeds via mergeAndSortNearby; later legs append (no reshuffle).
    setNearby((prev) =>
      prev.length === 0
        ? mergeAndSortNearby(results, pos.lat, pos.lng)
        : appendNearby(prev, results, pos.lat, pos.lng),
    );
    if (leg === 'mapped') mappedDone = true; else osmDone = true;
  });
  setNearbyState('done');
  // optional honest error line: if both legs failed AND nothing rendered
  // setNearbyError(both legs !ok && nearby.length === 0)
}, () => setNearbyState('denied'));
```

Adjust the idle-render block (`:754-792`) so rows show progressively and states stay honest:
- Show the `Nearby` section header + rows whenever `nearby.length > 0` (mapped rows appear
  while OSM is still in flight).
- Show the "Finding nearby courses…" pulse ONLY when `nearbyState === 'loading' &&
  nearby.length === 0` (still finding, nothing yet).
- `done` + empty → render nothing extra (favorites/recent hints as today) = genuine empty.
- Keep the existing `denied` hints unchanged.
- OPTIONAL honest touch (recommended, keeps to owner law): when **both** legs errored and
  the list is empty, show a single quiet mono line "Couldn't load nearby courses" instead of
  a silent empty — surfaces the error state honestly. Reuses `NearbySearchOutcome`
  `mappedOk`/`osmOk` semantics already in the lib. Keep it one calm line, no retry button.

Update the file's top doc-comment (`:16-17`) to mention the two-phase append.
`searchNearby` (the wrapper) stays for `courses/page.tsx` — leave it.

---

## Edge cases the builder MUST handle
- **OSM arrives before mapped** (rare): `prev.length === 0` seeds from whichever lands
  first; the other appends. Arrival order is the contract (no reshuffle). Fine.
- **Duplicate names across legs**: `appendNearby` dedupes by `courseNameKey`; a name already
  shown from mapped is not re-added from OSM. Matches current `dedupeByName` intent.
- **Cache key collision with `/search` cache**: MUST pass a distinct file path to the nearby
  `FileSearchCacheStore` (see A). Verify the two data files differ.
- **Negative cache**: nearby is positive-only — never call `_nearby_cache.set` with `[]`.
- **Radius**: FE sends 25000; route default 50000; cache key includes radius so different
  radii don't cross-contaminate.
- **Stale mapped data**: mapped leg is NOT cached (always fresh from DB); only the external
  OSM leg is cached. New ingests appear immediately in the mapped section.
- **`dedupeIdleSections` / favorites-recent-nearby cross-dedupe**: unchanged; still runs on
  the final `nearby` array each render.

## Tests (deterministic; NONE require local Postgres)

**Backend (`cd backend`, pytest — non-DB only):**
- New `tests/test_nearby_cache_key.py` (or add to `test_course_search.py`): unit-test
  `_nearby_cache_key` quantization — points inside the same ~1.1km cell produce the SAME
  key; points in different cells differ; radius participates in the key.
- Extend `tests/test_course_search.py` (reuse its `_fake_cache`/monkeypatch pattern +
  direct route-function call, no TestClient DB): call `course_search.nearby_courses(...)`
  with `course_search.search_golf_courses` monkeypatched to (i) return hits → asserts result
  cached + interactive budget requested; (ii) return `[]` → asserts **nothing cached**
  (positive-only / honesty law); (iii) a warmed cache → `search_golf_courses` is NOT called
  (assert via a `_never_called`-style stub) and cached rows return.
- `test_course_search_cache.py` already covers the store's TTL with `FakeClock` + `tmp_path`
  — the nearby cache reuses that store, so no store-level test churn needed.
- OSM budget: `test_osm_fetch_hardening.py` already covers the retry/backoff seam
  (`_post_with_retry` via AsyncMock). No new OSM network test needed.

**Frontend (`cd frontend`, vitest):**
- New cases in `src/lib/course-search-helpers.test.ts`: `appendNearby` (a) preserves the
  order of existing rows when a nearer OSM row arrives (NO reshuffle — the load-bearing
  assertion for the owner law); (b) dedupes incoming by `courseNameKey`; (c) sorts only the
  new rows among themselves by distance; (d) caps at `NEARBY_LIMIT`. Plus `mergeAndSortNearby`
  cap assertion.
- Extend `src/lib/golf-api-nearby.test.ts` (mocks `@/lib/api` `fetchAPI`): assert `onLeg`
  fires once per leg with correct `{leg, ok, results}`, that a down leg fires `ok:false`
  with `[]`, and the aggregate `NearbySearchOutcome` return is unchanged (back-compat).

## Gate commands (run all; all must pass)
- `cd frontend && npm run lint`
- `cd frontend && npx tsc --noEmit`
- `cd frontend && npm run build`
- `cd frontend && npx tsx voice-tests/runner.ts --smoke`
- `cd frontend && npx vitest run src/lib/course-search-helpers.test.ts src/lib/golf-api-nearby.test.ts`
- `cd backend && ruff check .`
- `cd backend && python -m pytest tests/test_course_search.py tests/test_course_search_cache.py tests/test_osm_fetch_hardening.py tests/test_nearby_cache_key.py -q`
  (all non-DB; DB-backed nearby SQL is covered by CI, not here)

## Out of scope (do not touch)
- GolfAPI universe/verify half (BLOCKED — 401 key, unverified call count).
- `courses.location` column-type migration / GIST index (note-and-defer, see win 5).
- Existing guarded migrations; `.env*`; `deploy/**`; `backend/supabase/migrations/**`.

## Critical files for implementation
- /Users/justinlee/projects/scorecard/backend/app/routes/course_search.py
- /Users/justinlee/projects/scorecard/frontend/src/components/CourseSearch.tsx
- /Users/justinlee/projects/scorecard/frontend/src/lib/golf-api.ts
- /Users/justinlee/projects/scorecard/frontend/src/lib/course-search-helpers.ts
- /Users/justinlee/projects/scorecard/backend/app/services/course_search_cache.py
