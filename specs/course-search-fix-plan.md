# Course Search — Fix Plan (owner escalation 2026-07-01, "asked many times")

Owner symptoms (Start Round → Search Course, e.g. "Bethpage Black"): (A) very slow;
(B) results change/reshuffle while on screen; (C) irrelevant hits — "Bethpa" shows
"Bethel Island"/"Bethanga" towns instead of only Bethpage Black/Red/Green, and the full
"Bethpage Black" still shows non-matches; (D/E) Courses tab vs Start Round behave
differently, and the round screen ("yardage book") shows the paper mock drawing instead
of the Google satellite map that /map/course shows.

## Diagnosed root causes (file:line evidence in this plan's recon, 2026-07-01)
- A: `routes/course_search.py:51-72` awaits 2–5 external calls SERIALLY per request —
  Overpass (10s client timeout, `[timeout:8]`, +1 retry w/ 2s backoff), Places (8s),
  a second unfiltered 8km Overpass, Mapbox (8s) + a third Overpass. No server cache.
  No local DB consulted by this endpoint.
- B: `CourseSearch.tsx:196,232-241` creates an AbortController but the signal is NEVER
  passed into `searchAllCourses` (`golf-api.ts:408-491`) — abort is dead code; no
  request-id guard → last-response-wins across overlapping keystrokes.
- C: when OSM+Places miss (ALWAYS in prod today: `config-status` shows
  `google_places:false`), `course_search.py:66-75` falls through to Mapbox place
  geocoding with NO golf/name filter → literal towns. On hits, `course_search.py:58-62`
  merges every OSM course within 8km unfiltered; `_dedupe_by_name` does no ranking;
  frontend sorts only by source (`golf-api.ts:494-500`).
- D/E: one shared `CourseSearch` component, divergent handlers — Courses tab select →
  bare `/map/course` (`courses/page.tsx:504-524`); Start Round keeps state → Tee Off →
  `/round/view` (`round/new/page.tsx:1383-1386`, `:336`). The round screen resolves the
  mapped course BY NAME (`RoundPageClient.tsx:408-412`); a miss silently falls back to
  the paper HoleDiagram — that's why the owner sees "some mock paper drawing" while
  /map/course (which receives explicit lat/lng params) shows real satellite.

## Locked product requirements (owner, verbatim intent — also in agent memory)
1. Prefix-first relevance: "Bethpa" → ONLY Bethpage Black/Red/Green; "Bethpage Black"
   → only that. Rule: EVERY query token must prefix-match some word of the course name.
   Towns/geocoder places must never render as courses.
2. Fast, and results NEVER reshuffle/replace under the user for the same query.
3. One search experience across Courses tab and Start Round.
4. After Tee Off, the yardage-book round screen shows the REAL course map (satellite)
   plus the yardage-book components; paper drawing only when there is truly no location.
   (Works WITHOUT the Places key; key improves coverage only.)

## Work item 1 — backend relevance + speed + local-first
1. **Relevance gate + ranking** (new pure helpers in `services/course_finder.py`, unit-tested):
   - `matches_query_prefix(name, q)`: normalize (case, punctuation, stopwords like
     golf/course/club/links/country/the), every q-token must prefix-match a name token.
   - Apply to ALL results returned by `/api/courses/search` regardless of source.
   - Rank: exact normalized match > all-token prefix > local/mapped source > distance
     (when a location anchor exists) > alpha. Stable within tiers.
   - Mapbox: NEVER emit geocoder places as results. Use a geocode hit only as a location
     anchor for a NAME-FILTERED OSM search near it. The 8km facility expansion stays but
     its results pass through the same relevance gate (so "bethpage" expands to
     Black/Red/Green; "bethpage black" filters expansion to Black).
2. **Latency**: run OSM-by-name + Places (+anchored lookups after) with `asyncio.gather`;
   interactive budgets — Overpass `[timeout:4]`/client 5s, retries at most one with
   0.5s backoff (or none for interactive path); Places/Mapbox timeout 4s. Target: p95
   under ~5s cold WITHOUT cache, instant on cache.
3. **Server TTL cache** for name search (normalized q → results), file/in-memory store
   per the `golfapi_cache.py`/`search_cache.py` idiom; TTL generous (24h) — course names
   don't churn; short negative-cache (5min) for empty results.
4. **Local-first**: new Alembic migration (backend/migrations/, NOT the blocked
   backend/supabase/migrations/): `CREATE EXTENSION IF NOT EXISTS pg_trgm` + GIN trgm
   index on `courses.name`. Upgrade `courses_mapped.list_courses` search to ranked
   (prefix-match boost + `similarity()`), not `updated_at` order. **Write-through**:
   persist external search hits (deterministic UUID from source id, name, lat/lng,
   address; geometry NULL) into `courses` with ON CONFLICT DO NOTHING, so the DB becomes
   the canonical index (per the course-DB epic) and repeat searches are local-fast.
   `/api/courses/search` queries local FIRST and only fans out when local results are
   thin (<3 relevance-passing hits), merging + deduping by normalized name.
5. Existing test contracts in `backend/tests/test_course_search.py` must keep passing
   (osm_name_filter AND-of-words, _dedupe_by_name order, no-key Places noop, Mapbox URL
   encoding). Extend, never weaken. New tests: the Bethpage repro table —
   "bethpa" → Bethpage* only; "bethpage black" → exactly Bethpage Black; town names
   never emitted; ranking order; cache hit path; write-through idempotency.

## Work item 2 — frontend race fix + stable rendering
1. `fetchAPI` accepts an `AbortSignal`; `searchAllCourses(query, {signal})` threads it
   into all three legs; `CourseSearch` actually aborts the previous call.
2. **Stale guard**: capture the query per request; apply results only if it still equals
   the live query (belt for browsers where abort races).
3. **Append-only progressive render**: fast legs (mapped/local) render immediately;
   slower legs may only APPEND new (deduped) rows below existing ones for the same
   query — never remove/reorder rendered rows. New query → clean slate.
4. **Client-side prefix filter** mirroring `matches_query_prefix` (shared util in
   `frontend/src/lib/`, unit-tested) as defense in depth — towns never render even
   against a stale backend.
5. Keep 250ms debounce + 2-char min. Show the searching state on the slow legs without
   blocking rendered rows.
6. Tests: stale-guard (out-of-order resolution), append-only merge, prefix filter,
   abort actually cancels (mock fetch).

## Work item 3 — satellite in the yardage book + unified routing
1. **Persist the course anchor on the round**: add optional `courseLat`/`courseLng`
   (+ `mappedCourseId` when known) to Round — `frontend/src/lib/types.ts` +
   `backend/app/models.py` + rounds table (Alembic migration, additive nullable cols)
   + `round/new/page.tsx` createRound payload (from the selected search result, which
   has center/lat/lng today).
2. **Round screen uses the anchor**: `RoundPageClient` drives `GoogleSatelliteMap` from
   stored `mappedCourseId` (geometry) or `courseLat/Lng` (center) exactly like
   `/map/course` does; the by-NAME resolution stays only as fallback for legacy rounds;
   the paper HoleDiagram renders only when no location exists at all. Keep the
   Paper⇄Satellite toggle + satellite default (getMapViewPref) semantics.
3. **Unify Courses-tab select**: selecting a search result in the Courses tab goes to
   the course DETAIL page (`/courses/[id]` — which already has the start-round handoff
   via `stashCourseForRound`), NOT the bare `/map/course`. `/map/course` stays reachable
   from course detail (map affordance) — it's a viewer, not a landing.
4. Tests: round create payload carries the anchor; RoundPageClient picks satellite given
   an anchor (component/unit level); routing unit test for the select handler mapping.

## Sequencing & gates
Items 1+2 in parallel (backend-only vs frontend-only files), then item 3 (touches both).
Every item: full gates (backend ruff+pytest / frontend tsc+lint+vitest+voice smoke+build)
before its commit on integration/next. QA repro after: scripted "Bethpa"/"Bethpage Black"
checks against the route (mock externals), plus the headless sim check
(frontend/ios/simtest-headless.mjs, see SIMTEST.md) for the satellite-in-round change.
Adversarial review + /security-review delta (endpoint behavior changed; new migration).
Owner note: setting GOOGLE_PLACES_API_KEY in prod (looper/prod secrets) remains open and
will further improve coverage — but nothing above depends on it.
