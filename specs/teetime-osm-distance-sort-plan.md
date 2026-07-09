# Plan: Sort OSM course results by distance before truncation

**Backlog id:** `teetime-osm-distance-sort-before-truncate` (P1, low-risk, backend-only)
**Spec path:** `specs/teetime-osm-distance-sort-plan.md`
**Author:** Fable plan agent (cycle 47)

## Problem

`backend/app/services/osm.py` → `search_golf_courses()` ends with `return results[:15]` (line 423). `results` is in Overpass's arbitrary element order, not distance order. At the tee-time UI's default 15-mile radius the cap can silently drop the closest course — reproducibly drops "18 Mile Creek Golf Course" (Hamburg NY), the S1 foreUP reference course, so the owner doesn't see the real foreUP availability data on TestFlight. Same latent pattern exists in `search_osm_with_geometry()` (`return results[:25]`, line 516).

## Fix

### 1. `search_golf_courses` (osm.py ~359–423)

**Distance source of truth:** add a small module-local haversine to `osm.py`. No haversine exists in this module today; the codebase convention is a private per-module copy (`routing._haversine_miles`, `course_finder._haversine_m`, `shots._haversine_yards`, `capability_store._haversine_miles`, `private_filter._haversine_miles`) rather than cross-module imports of private helpers. Importing `course_finder._haversine_m` would couple `osm.py` to a higher-level service (and `course_finder` sits above `osm` in the dependency graph). So:

- Add `import math` to `osm.py`.
- Add `_haversine_m(lat1, lng1, lat2, lng2) -> float` — a verbatim mirror of `course_finder._haversine_m` (meters), docstring noting "mirrors course_finder._haversine_m". Units don't matter for a sort key; meters matches the module's `radius_m` vocabulary.

**Sort + cap:** extract the sort into a tiny pure helper so both fetch functions and the unit test share it:

```
def _sort_by_distance(results, lat, lng):  # pure, no I/O
    # key: (haversine_m(lat,lng, center), name) — name tie-break for determinism,
    # matching routing.py's (distance, course_name) pattern. Missing center
    # lat/lng sorts last (math.inf). Stable sort preserves Overpass order on ties.
```

In `search_golf_courses`, replace `return results[:15]` with:

- `if lat is not None and lng is not None: results = _sort_by_distance(results, lat, lng)` — exactly the same condition that builds the `around` clause. Name-only searches (no coords) have no distance to sort by; their current Overpass ordering is preserved untouched.
- `return results[:_MAX_COURSE_RESULTS]`.

**Cap constant:** promote the bare `15` to a module constant `_MAX_COURSE_RESULTS = 15` with a one-line comment (and `_MAX_GEOMETRY_RESULTS = 25` for the geometry variant). Recommendation: do this — it's two lines, makes the new test's ">15 fixture" self-explanatory, and stops the magic number appearing in both prod code and test. Do NOT make it a parameter or config — no caller needs to vary it.

### 2. Name + location interaction

Callers that pass BOTH `name` and `lat/lng`: yes, two — `course_search._enrich_and_write_through` (line 216, background 8 km facility-sibling enrichment) and the Mapbox-fallback inline leg (line 330). Prescribed behavior: **sort by distance whenever lat/lng are provided, even with a name.** This is safe because neither caller uses OSM order as the user-visible ranking:

- The inline Mapbox-fallback path feeds results through `course_finder.rank_courses(gated, q, anchor=anchor)`, whose key is `(exact, prefix, local, venue_penalty, dist, name)` — name-relevance tiers dominate and its own `dist` component already sorts by anchor distance within a tier. A distance pre-sort can only change stable-tie order to match what `rank_courses` would do anyway. Relevance cannot be clobbered.
- The background enrichment path only dedupes and write-throughs (no user-visible order). Bonus: `dedupe_by_name` is first-wins, so distance-sorted input makes the *closest* duplicate survive — a mild improvement.
- What the sort fixes for these callers: the 15-cap now keeps the 15 nearest name-matches instead of 15 arbitrary ones. Strictly better.

### 3. `search_osm_with_geometry` — yes, same fix

Same truncate-before-sort pattern (`results[:25]`, line 516) with a bigger default radius (50 km, callers allow up to 100 km via `/api/courses/search-osm`), so dropping the nearest is *more* likely there. It's user-reachable (route at `course_search.py` line 370). Apply the identical two lines using the shared `_sort_by_distance` helper and `_MAX_GEOMETRY_RESULTS`. Note its `center` can be synthesized from geometry bbox — the helper doesn't care where center came from.

### 4. Edge cases

- **Missing center on an element:** already impossible in `results` — `search_golf_courses` skips elements with no `center` (line 408-410) and `search_osm_with_geometry` skips when `not boundary or not center`. Defensively, the helper treats a `None` `center["lat"]`/`["lng"]` as `math.inf` (sorts last) rather than raising.
- **Ties / identical distances:** key is `(distance, name)`; Python's sort is stable, so exact ties fall back to name then original Overpass order. Deterministic, matches `routing.py`'s `(distance_miles, course_name)` convention.
- **Empty results:** `sorted([])[:15]` is `[]`; the honest empty contract (`None` from `_post_with_retry` → `[]`) is untouched.
- **Name-only search:** no sort applied; existing ordering byte-identical.

### 5. Shared-types check

Backend-only. The returned dict shape (`osm_id, name, address, center, phone, source` / geometry variant) is unchanged — only list order changes. **No `frontend/src/lib/types.ts` ↔ `backend/app/models.py` sync is needed.**

### 6. Gates & tests

**New unit test file:** `backend/tests/test_osm_distance_sort.py` (name mirrors the backlog id; follows the pure/no-network style of `test_osm_fetch_hardening.py`). No DB, no network — monkeypatch `app.services.osm._post_with_retry` with an `AsyncMock` returning a fixture Overpass JSON (`{"elements": [...]}` of `way` elements with `tags={"leisure": "golf_course", "name": ...}` and `center={"lat","lon"}`). Tests (all `@pytest.mark.asyncio` where async):

1. **Regression (the bug):** 16+ courses around a Hamburg-NY-like origin, with the nearest ("18 Mile Creek"-style, ~1 mi away) placed LAST in `elements` and 15+ farther courses first. Call `search_golf_courses(lat=..., lng=..., radius_m=24140)`. Assert: `len(result) == 15`, the nearest course is present (previously dropped), and `result` is ascending by haversine distance from the origin.
2. **Name-only preserves order:** call with `name="pebble"` and no lat/lng (mocked response with 3 courses in a deliberate non-distance order) → returned order equals element order.
3. **Tie determinism:** two courses at identical distance → sorted by name.
4. **`search_osm_with_geometry` regression:** 26+ way elements with ≥4-point closed geometry, nearest last → nearest survives the 25-cap, ascending order.
5. (Optional, cheap) direct tests of the pure `_sort_by_distance` helper incl. `None`-coord-sorts-last.

**Gates to run (no local Postgres — pure unit tests only; DB-backed tests run in CI):**
- `cd backend && ruff check .`
- `cd backend && python -m pytest tests/test_osm_distance_sort.py tests/test_osm_fetch_hardening.py tests/test_course_search.py tests/test_tee_time_routing.py tests/test_course_finder_relevance.py`
- Frontend untouched → no typecheck/voice-smoke deltas expected, but run the standard `npm run lint` / `npx tsc --noEmit` if bundling per CLAUDE.md.

### 7. Risks

- **Interactive search relevance:** none in final ordering — `rank_courses` re-ranks downstream with relevance tiers dominant (see §2). Only the *membership* of the capped set changes, in the right direction.
- **Existing order-asserting tests:** `test_course_search.py` monkeypatches `course_search.search_golf_courses` wholesale and `test_tee_time_routing.py` injects `find_courses` — neither exercises the real function, so no breakage expected. Verify with the pytest gate above.
- **Honesty/empty contract:** unchanged — failure still returns `[]`, no fabricated data, `routing.search_availability` still never raises. The routing per-course `distance > max_distance_miles` filter still works: it computes its own haversine per course and is order-independent; `courses[:MAX_COURSES]` (8) now takes the 8 closest, which is the intent of that cap. `slots.sort(...)` re-sorting an already-sorted list is harmless (no incorrect double-sort).
- **Stale caches:** `_nearby_cache` / `_search_cache` entries persist old orderings until TTL — cosmetic only, self-heals.
- **Latency:** sort is client-side over ≤ a few hundred dicts — negligible; Overpass query unchanged.

## Critical Files for Implementation
- /Users/justinlee/projects/scorecard/backend/app/services/osm.py
- /Users/justinlee/projects/scorecard/backend/tests/test_osm_distance_sort.py (new)
- /Users/justinlee/projects/scorecard/backend/app/services/tee_times/routing.py (reconcile only — no change)
- /Users/justinlee/projects/scorecard/backend/app/routes/course_search.py (reconcile only — no change)
- /Users/justinlee/projects/scorecard/backend/tests/test_osm_fetch_hardening.py (style reference for the pure-mock test)
