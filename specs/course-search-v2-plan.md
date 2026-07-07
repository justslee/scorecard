# Course Search v2 — Implementation Plan

Owner escalation: search still can't find "Pebble Beach"; the slide-up sheet resizes constantly. Direction: "model the UI after Google Maps search while maintaining our theme."

This plan builds on the VERIFIED DIAGNOSIS (2026-07-06, see tasks/progress.md):
1. The un-anchored OSM by-name query is a planet-wide Overpass regex scan with [timeout:4] — it ALWAYS times out (verified live: 2 attempts, 11s, 0 results). Never contributes; adds ~11s to every cold query.
2. Overpass is generally unreliable (busy pages from the main host, mirror timeouts) — best-effort geometry enrichment only, never load-bearing.
3. Cold-query backend latency 11-16s+ (gather waits on the doomed OSM leg); frontend fetchAPI has NO timeout; the next keystroke aborts the request.
4. course_search_cache negative-caches [] for 5 min without distinguishing "all external legs errored" from "genuinely no match" — one bad moment poisons a query for 5 min.
5. search_google_places silently returns [] on ANY failure (no logging). Places (Text Search New, key present in prod per /api/config-status) is the only fast reliable name-search leg; whether the prod key has "Places API (New)" enabled is UNVERIFIED — leg-health observability is required.
6. Frontend searchAllCourses fans out to 3 client legs settling at different times (jank). Owner standing requirement: ONE unified search path.

Two builder-parallelizable work items. The contract between them is the **public signature of `searchAllCourses(query, { signal, onResults })`** and its append-only `onResults` semantics — both stay stable, so Work Item B (UI) does not depend on Work Item A (backend) landing first.

---

## Contract between A and B (freeze this first)

`frontend/src/lib/golf-api.ts` → `searchAllCourses(query, options)` keeps:
- signature `(query: string, options?: { signal?: AbortSignal; onResults?: (results: CourseSearchResult[]) => void }) => Promise<CourseSearchResult[]>`
- append-only `onResults` semantics (rows never reorder/remove for a live query)
- `CourseSearchResult` shape (adding an optional `sourceLabel?: string` field is backward-compatible; see B).
- `course-search-session.ts` `SearchAllFn` type stays as-is (already matches).

Work Item A changes the **internals** of `searchAllCourses` (collapse 3 legs → 1) but not its signature. Work Item B rebuilds `CourseSearch.tsx` against the unchanged signature. Neither blocks the other. **A owns golf-api.ts** (including adding the `'google_places'` source union member + `sourceLabel` up front so B never touches that file).

---

## WORK ITEM A — Backend: search that actually works

### A0. Root behavior change (decisive picks)

1. **Kill the un-anchored global OSM scan.** In `course_search.py`, the `search_golf_courses(name=q, interactive=True)` leg (no lat/lng) is a planet-wide Overpass regex that always times out. Remove it from the fan-out entirely. OSM is used ONLY anchored (around a Places/Mapbox center).
   - *Rejected:* keep it with a shorter timeout — still unreliable, still adds latency, never contributes.

2. **Google Places becomes the PRIMARY external text-search leg** (already wired via `_search_google_places`, 4s budget). Local DB stays first.

3. **Anchored OSM enrichment becomes non-blocking.** Return Places/Mapbox results immediately; run anchored OSM (8km facility expansion) + write-through in a **FastAPI `BackgroundTasks`** job so enrichment lands in the DB for *next* time without adding latency now. Worst-case interactive latency drops to Places' 4s budget (target <2s typical).
   - *Rejected:* inline `asyncio.wait_for(osm, 2s)` — still adds up to 2s and couples UI latency to Overpass.
   - *Rejected:* fully async queue/worker — overkill; `BackgroundTasks` runs in-worker after response flush.

4. **Add golfapi as an internal backend leg** (concurrent with Places), reusing the existing server-side cached client (`services/golfapi_cache.py`). Preserves the golfapi coverage the frontend leg is dropping, keeps ONE unified path.
   - *Rejected:* accept Places-only coverage — owner repeatedly cares about coverage; drop only if the server-side client can't be reused cleanly (documented fallback: Places-only).

### A1. Restructured pipeline (`backend/app/routes/course_search.py` `search_courses`)

Keep steps 1 (cache), local-first short-circuit (`_LOCAL_MIN_HITS = 3`), relevance gate, ranking, `attach_stable_ids`, `external_course_rows`, auth — all as-is. Change the fan-out:

```
cache → local-first (unchanged)
  if local_passing >= 3: rank, cache (positive), return   # unchanged

  # FAN OUT (local thin) — concurrent, tight budgets, NO un-anchored OSM:
  places, golfapi = await asyncio.gather(
      _search_google_places(q),        # 4s, PRIMARY
      _search_golfapi(q),              # NEW internal leg, cached, ~1-2s
  )   # each wrapped so one failure != whole-request failure

  combined = _dedupe_by_name(local_passing + places + golfapi)
  anchor = places[0]["center"] if places else None

  if not combined:                      # Mapbox anchor fallback (unchanged intent)
      mapbox = await _search_mapbox(q, timeout_s=4.0)
      if mapbox:
          anchor, searched_near = mapbox[0]["center"], mapbox[0]["name"]
          # anchored OSM inline ONLY here (nothing else matched — worth the wait)
          combined = await search_golf_courses(name=q, lat=..., lng=..., radius_m=8000, interactive=True)

  gated  = [c for c in combined if matches_query_prefix(c["name"], q)]
  ranked = rank_courses(gated, q, anchor=anchor)

  # NON-BLOCKING enrichment + write-through (BackgroundTasks):
  if anchor:
      background_tasks.add_task(_enrich_and_write_through, q, anchor, ranked)
  else:
      background_tasks.add_task(_write_through_courses, external_course_rows(external_hits))

  _set_cache_smart(cache_key, ranked, leg_health)   # see A2
  return {"courses": ranked, "query": q, "legHealth": leg_health, ...searchedNear}
```

`_enrich_and_write_through` runs the anchored 8km OSM search, dedupes new siblings (e.g. Bethpage Black/Red/Green), and write-throughs them so the *next* identical search is local-fast and complete — multi-course facilities fill in over time without blocking interactive latency.

- Add `background_tasks: BackgroundTasks` param to `search_courses`.
- Add `_search_golfapi(q)` helper (module-level, monkeypatchable) delegating to `golfapi_cache`, mapping clubs → the same course-dict shape (`id`, `name`, `address`, `center`, `source: "golfapi"`), 3-4s budget.

### A2. Cache fix — don't poison on error (`course_search_cache.py` + route)

Fix at the **call site** (the route knows leg outcomes; the store stays a dumb TTL map):
- Compute `all_external_ok` = every attempted external leg returned `ok`/`empty` (NOT `error`/`timeout`).
- Non-empty results → cache (24h positive, unchanged).
- Empty AND `all_external_ok` (genuine no-match) → cache (5 min negative, unchanged).
- Empty AND any external leg errored/timed out → **do not cache** (route simply doesn't call `set`; no store API change).
- An empty result always went through fan-out (local short-circuit only fires when local >= 3), so leg-health is always known at cache time.
- Update the `course_search_cache.py` module docstring to reflect the new rule.

### A3. Leg-health observability

- Define a `LegHealth` shape: `{ "source": str, "outcome": "ok"|"empty"|"error"|"timeout", "count": int, "ms": int, "detail"?: str }` (mirror the CallOutcomeOut idiom in routes/tee_times.py).
- Route-level timing wrapper `_run_leg(name, coro)` that catches, times, logs (`log.warning` on error with HTTP status where available — a prod key-not-enabled 403 SERVICE_DISABLED must show up in logs), and records `LegHealth` — keeps the pure helpers' return types stable for their existing tests.
- Add **`legHealth: list[LegHealth]`** to the `/search` response (additive; frontend may ignore).

### A4. Frontend lib collapse (`golf-api.ts` `searchAllCourses`)

- Collapse to **ONE** call: `fetchAPI('/api/courses/search?q=...', { signal })`. Drop the client-side mapped + golfapi legs (backend covers both now).
- Map the response's `courses[]` to `CourseSearchResult[]`; normalize sources (`local`→`mapped`-equivalent handling, `google_places` first-class).
- Keep `matchesQueryPrefix` client gate + `courseNameKey` dedupe as defense in depth. Keep the append-only merge shape so `onResults` semantics are unchanged.
- **Add a timeout to the search fetch**: combine the caller's abort signal with `AbortSignal.timeout(8000)` (via `AbortSignal.any`) so a wedged backend can't hang until the next keystroke.
- `course-search-session.ts`: unchanged.

### A5. Shared types to keep in sync

- `CourseSearchResult.source` union: add `'google_places'` (keep `'local'`). `courseDetailHref` already routes any non-mapped/non-golfapi source with a center via the param path — verify `google_places` falls into that branch (it does).
- `/search` response stays a plain dict; document the shape. Add the TS `legHealth` type only where consumed.

### A6. Backend tests

**Frozen (must keep passing, do NOT weaken):** `test_osm_name_filter_*`, `test_dedupe_by_name_*`, `test_google_places_is_noop_without_key`, `test_mapbox_url_encodes_query_path_injection`, `test_mapbox_url_normal_query_unaffected`, all of `test_course_finder_relevance.py`.

**Update (pipeline changed):**
- `test_fewer_than_three_local_hits_fans_out_and_merges`: external contribution now comes from Places (or golfapi); assert `search_golf_courses` is called ONLY anchored or in a background task, never un-anchored.
- `test_three_or_more_local_hits_skips_all_external_calls`: add `_search_golfapi` to the never-called set.
- Other route tests: add `_search_golfapi` monkeypatch (default empty).
- Starlette TestClient runs BackgroundTasks synchronously — assert write-through happens via background task in the fan-out path.

**New tests:**
- **Pebble Beach repro**: `"pebble beach"` with Places returning "Pebble Beach Golf Links" → returned and gated-in; `"pebble"` → Pebble Beach only, no towns. Mirror the Bethpage table.
- **Cache poisoning fix**: external leg errors + empty → NOT cached (next call re-runs); genuine no-match → 5 min negative; positive → 24h.
- **legHealth**: response includes per-leg outcome/count/ms; a leg raising → `outcome: "error"` + `log.warning` (caplog).
- **Non-blocking enrichment**: Places anchor schedules anchored-OSM + write-through as background task; response returns Places rows without waiting on OSM.
- `_search_golfapi` mapping unit test.

### A7. Gates (A)
`cd backend && ruff check . && pytest` (course-search suites + new). Frontend for the lib change: tsc, lint, `vitest run` (golf-api-search, course-search-session, course-search-helpers), voice smoke. `/security-review` delta (endpoint behavior changed: internal golfapi leg, BackgroundTasks, cache policy) + `/code-review`.

---

## WORK ITEM B — Frontend: Google-Maps-style full-screen search, yardage-book theme

### B0. The structural fix (kills resize jank)

The bottom sheet uses `maxHeight: "90vh"` + flex content that grows/shrinks as results and the iOS keyboard viewport change. On Capacitor iOS the keyboard shrinks the visual viewport → `90vh` recomputes → the sheet jumps.

**Fix: FULL-SCREEN fixed surface** — `position: fixed; inset: 0`, fixed `100dvh` height NOT bound to content; header (search bar) fixed at top; sections/results scroll in a flex-1 `overflow-y: auto` region with `env(safe-area-inset-bottom)` padding. The keyboard overlays the bottom of the scroll region instead of resizing the sheet. Verify Capacitor Keyboard resize mode (`capacitor.config`) — if set app-global, the fixed layout tolerates it because nothing is vh-content-bound. Do NOT edit deploy/**.

### B1. Layout — model after Google Maps search (in-theme)

Rewrite `frontend/src/components/CourseSearch.tsx` (keep file + default export + `CourseSearchProps` + `CourseSelectPayload` + `resultToPayload` so all 3 callers keep working):

- **Top fixed search bar**: back chevron (left, calls `onClose`) + text input + **mic affordance** (right). Serif/mono theme, `T.*` tokens, `PAPER_NOISE`. No sheet chrome, no drag handle.
- **Idle (no query) stable sections**, in order: **Favorites** (course-favorites.ts), **Recent** (`getRecentCourses()` — new to this surface, matches Google Maps "Recent"), **Nearby** (existing `searchNearby` + `mergeAndSortNearby`). Existing `SectionLabel` idiom.
- **Typed results** replace the idle sections as a **single stable list** (append-only via unchanged `onResults`).
- **Loading = subtle inline state** (pulsing dot in the search bar), NEVER a layout shift.
- **One result-row idiom** for all four sections: consolidate `ResultRow`/`FavoriteRow` into one `CourseRow` `{ title, subline, trailing, onSelect, onStar }` — name serif 16-17, mono uppercase subline (city/state | distance | source tag), chevron. Keep the star toggle.
- Drop the footer attribution; source becomes a subtle per-row tag via `sourceLabel` (added by A).

### B2. Two modes (navigate vs pick-and-return)

Driven entirely by the `onSelectCourse` callback the caller passes (no new prop): courses tab navigates via `courseDetailHref` (shipped #93); round/new and tee-time set state and stay in-flow. Keep `CourseSelectPayload` + `resultToPayload` exactly.

### B3. Voice-first mic affordance

- Mic dispatches to an optional `onVoiceSearch?()` callback; in round/new it can reuse `setShowVoiceSetup(true)` (realtime setup already resolves a course by name). Courses tab / tee-time: planned stub — speech-to-text into the query input flowing through the same `searchAllCourses` path.
- Do NOT build a full realtime voice course-picker in this item; flag to owner as a follow-up.

### B4. Files (B)

- `frontend/src/components/CourseSearch.tsx` — rewrite.
- `frontend/src/lib/course-search-helpers.ts` — helper mapping Recent/Favorite/Nearby into the unified `CourseRow` view-model (unit-tested); idle-section dedupe by `courseNameKey`.
- NO changes to `golf-api.ts` (A owns it). Optionally pass `onVoiceSearch` in round/new. Keep `AnimatePresence` wrappers; enter/exit becomes full-screen fade/slide (`T.springSoft`/`T.ease`).

### B5. Edge cases / risks (B)
- iOS keyboard overlap of last rows → scroll-region bottom padding `max(24px, env(safe-area-inset-bottom))`.
- Back gesture / focus trap → back chevron = `onClose`; keep unmount abort (`sessionRef.cancel()`).
- `autoFocus` opens the keyboard immediately (Google Maps behavior) — must not resize (B0).
- Dedupe across idle sections by `courseNameKey` (a favorite isn't also shown under Recent).
- Empty/denied states stay calm; no layout jump.
- `google_places` rows: center, no clubId — `courseDetailHref` param path renders detail without a fetch (verified).

### B6. Tests (B)
- `course-search-session.test.ts` stays green (SearchAllFn unchanged).
- `golf-api-search.test.ts`: updated by A (single-leg).
- `course-search-helpers.test.ts`: extend for the row view-model / idle-section dedupe.
- Component test asserting fixed container height independent of result count (the core owner complaint); headless sim check (frontend/ios/simtest-headless.mjs, SIMTEST.md) for no-resize on keyboard open.
- `designer` review against NORTHSTAR (notable UI change).

### B7. Gates (B)
tsc, lint, full vitest, voice smoke, build. Headless sim no-resize check. `designer` + `/code-review`.

---

## Sequencing

- **A and B run in parallel** (two builders). Contract = frozen `searchAllCourses` signature + append-only `onResults`. Only shared file is `golf-api.ts` → **A owns it entirely** (including B's `sourceLabel` + `'google_places'` union additions up front).
- Both land on `integration/next`; bundle to ship (owner-noticeable: search finds Pebble Beach + no resize jank) → approval request.
- Backend change is owner-testable on staging (`/api/courses/search?q=pebble beach`, inspect `legHealth`) — qualifies for a "major backend change he can test" ping with how-to-test.

## Critical files
- backend/app/routes/course_search.py
- backend/app/services/course_finder.py
- backend/app/services/course_search_cache.py
- frontend/src/lib/golf-api.ts
- frontend/src/components/CourseSearch.tsx
