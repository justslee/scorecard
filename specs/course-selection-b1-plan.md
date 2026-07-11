# B1 Implementation Plan — `GET /api/courses/in-bounds` (backend-only)

**Slice:** B1 of `specs/course-selection-ux-plan.md` (§B.1, lines 21-25). Backend only. B2 (map UI) is a separate later cycle — no frontend changes in this slice.

**Goal:** viewport bounding-box course PINS (real course centers only), cache-first and budget-safe: DB (PostGIS bbox) is the instant authoritative layer; OSM fills cold ~0.05° geo-cells with positive-only caching and write-through; Google Places and GolfAPI are NEVER touched on this path.

---

## 1. Endpoint contract

**Route:** `GET /api/courses/in-bounds` in `backend/app/routes/course_search.py` (same `router`, prefix `/api/courses`).

**Auth:** none — mirrors `/nearby` and `/search-osm` (no paid API on this path; `/search` is auth-gated only because it calls paid Places). Do NOT add `Depends(current_user_id)`.

**Query params** (all required floats; FastAPI coerces type, semantic validation is ours):

| param | meaning |
|---|---|
| `swLat` | south edge latitude |
| `swLng` | west edge longitude |
| `neLat` | north edge latitude |
| `neLng` | east edge longitude |

**Validation → `HTTPException(400, ...)` on any of:**
- non-finite values (`math.isfinite` check — FastAPI accepts `nan`/`inf` as floats)
- `swLat < -90 or neLat > 90 or swLng < -180 or neLng > 180`
- `swLat >= neLat` (inverted/degenerate)
- `swLng >= neLng` (inverted/degenerate — **this intentionally rejects antimeridian-crossing boxes; documented B1 scope decision**, see §7)

**Response shape** (always all three keys):

```json
{
  "courses": [
    {"id": "<uuid or provider-id>", "name": "...", "address": "... | null",
     "center": {"lat": 40.71, "lng": -73.45}, "source": "local" | "osm"}
  ],
  "degraded": false,
  "zoomIn": false
}
```

- Pin shape is the same course-dict the `/nearby` and `/search` legs emit (`id/name/address/center/source`); OSM hits also carry `osm_id` passthrough, harmless and consistent with `/nearby`. DB pins are mapped from `_list_item` rows exactly like `_list_local_courses` does (`center` ← `location`, `source: "local"`).
- `degraded: true` ⇢ the OSM fill leg is known-impaired this request (see §4); DB pins are still present. Never omitted, never a 500.
- `zoomIn: true` ⇢ viewport too large for pins; `courses` is `[]` and NO legs ran. Exact rule: bbox area `(neLat-swLat) * (neLng-swLng) > 0.25` square degrees → return `{"courses": [], "degraded": false, "zoomIn": true}` immediately after validation.
  - **Justification for 0.25 sq°:** 0.5° × 0.5° ≈ 55 km N–S × ~42 km E–W at 40°N — a full metro area, the largest viewport where individual pins are still meaningful. Beyond it, the box covers >100 geo-cells (fanout explosion) and would need hundreds of pins; the client's honest move is "zoom in to see courses". Module constant `IN_BOUNDS_MAX_AREA_SQDEG = 0.25`.
- Pin cap: `IN_BOUNDS_MAX_PINS = 40` (spec §B.1 "Cap ~40 pins"), applied after merge/dedupe. DB pins are ordered center-proximity-first and listed before OSM pins, so truncation drops far OSM extras, never central DB courses.

---

## 2. The three legs, in order

Handler signature mirrors `/search`'s BackgroundTasks usage:
`async def in_bounds_courses(swLat: float = Query(...), swLng: float = Query(...), neLat: float = Query(...), neLng: float = Query(...), background_tasks: BackgroundTasks = None)`.

### 2a. DB bbox leg — ALWAYS runs (the honesty floor)

New store function in `backend/app/services/courses_mapped.py` (place next to `nearby_courses`, `:111-127`):

```
async def courses_in_bounds(sw_lat, sw_lng, ne_lat, ne_lng, limit: int = 60) -> list[dict]
```

Mirrors `nearby_courses` exactly in style (raw `text()` SQL, `async_session()`, `_list_item(r)` rows):

```sql
select id::text as id, name, address,
       ST_X(location::geometry) as lng, ST_Y(location::geometry) as lat,
       updated_at
from public.courses
where location is not null
  and ST_Intersects(location::geometry,
                    ST_MakeEnvelope(:sw_lng, :sw_lat, :ne_lng, :ne_lat, 4326))
order by location::geometry <-> ST_SetSRID(ST_MakePoint(:c_lng, :c_lat), 4326)
limit :limit
```

with `c_lat/c_lng` = bbox center, so the closest-to-center rows win when the store limit truncates. Returns `_list_item` dicts (`id/name/address/location/updatedAt`). `limit=60` (> pin cap 40) so dedupe against OSM never starves the merged list.

In the route, add a lazy-import wrapper mirroring `_list_local_courses` (`course_search.py:168-189`) so the module stays importable without `DATABASE_URL` and unit tests can monkeypatch it:

```
async def _db_courses_in_bounds(sw_lat, sw_lng, ne_lat, ne_lng) -> list[dict]:
    from app.services import courses_mapped
    rows = await courses_mapped.courses_in_bounds(sw_lat, sw_lng, ne_lat, ne_lng, limit=60)
    return [{"id": r["id"], "name": r.get("name"), "address": r.get("address"),
             "center": r.get("location"), "source": "local"} for r in rows]
```

### 2b. OSM fill leg — quantized geo-cells, cold cells only

**Dedicated cache** (never share a JSON file across key namespaces — same rule as `_nearby_cache`, `course_search.py:57-63`):

```
_in_bounds_cache: SearchCacheStore = FileSearchCacheStore(
    path=Path(__file__).parent.parent.parent / "data" / "in_bounds_search_cache.json"
)
```

`FileSearchCacheStore` creates the file lazily on first `.set()` — nothing to commit, no new dependency. Default TTLs apply (positive 24h; the negative TTL is irrelevant because we never `.set()` an empty list — positive-only, see below).

**Cell scheme** (pure helpers, unit-testable with no I/O, mirroring `_nearby_cache_key`):

- `IN_BOUNDS_CELL_DEG = 0.05` (~5.5 km N–S per cell)
- Integer cell indices, NOT rounded floats (avoids float-formatting collisions): `ilat = math.floor(lat / IN_BOUNDS_CELL_DEG)`, same for lng.
- `def _in_bounds_cell_key(ilat: int, ilng: int) -> str: return f"inbounds:v1:{ilat}:{ilng}"` — versioned prefix so a future scheme change can't collide with stale entries.
- `def _cells_for_bbox(sw_lat, sw_lng, ne_lat, ne_lng) -> list[tuple[int, int]]`: every integer `(ilat, ilng)` whose cell intersects the bbox (`floor(sw/0.05) .. floor(ne/0.05)` inclusive on both axes), **sorted by cell-center distance to the bbox center ascending** (so the cold-cell cap spends its budget on the middle of the viewport).
- Keys are **per-cell, not per-bbox**, so overlapping viewports reuse each other's warm cells.

**Per-cell fetch (cold cells only):**
- Warm = `_in_bounds_cache.get(key) is not None` → use the cached list, ZERO external calls.
- Cold → exactly ONE call: `search_golf_courses(lat=cell_center_lat, lng=cell_center_lng, radius_m=4000, interactive=True)` where cell center = `((ilat + 0.5) * 0.05, (ilng + 0.5) * 0.05)`. **`radius_m=4000` justification:** the cell half-diagonal is at most `sqrt(2.78² + 2.78²) ≈ 3.93 km` (lng half-width shrinks with `cos(lat)`, so 3.93 km is the worldwide max) — 4000 m always covers the whole cell with minimal overlap. `interactive=True` = the tight budget (`[timeout:4]` server, 5 s client, one 0.5 s-backoff retry — `osm.py:398-440`).
- Per-cell post-processing before caching: `course_finder.attach_stable_ids(hits)` (so cached entries carry the deterministic write-through UUID, exactly like `/nearby` at `course_search.py:428-430`), then **positive-only** `_in_bounds_cache.set(key, hits)` ONLY `if hits`. NEVER cache `[]` (see §4).
- **NO name gate** (`matches_query_prefix` does not apply — there is no query; every real OSM `leisure=golf_course` center in the cell is a valid pin).

**Cold-cell fanout cap:** `IN_BOUNDS_MAX_COLD_CELLS = 4` per request; cold cells beyond the cap are simply skipped this request (they warm on subsequent pans). The ≤4 cold fetches run **concurrently** via `asyncio.gather`. **Justification for 4:** (a) wall time — concurrent, so worst case ≈ one interactive OSM budget (~5.5 s), not N×; (b) Overpass etiquette — the public `overpass-api.de` mirror grants only a few parallel slots per IP; a burst of 4 is polite, dozens is abuse and self-defeating (429s poison the leg); (c) coverage math — a typical neighborhood-zoom mobile viewport spans 0.1–0.2°, i.e. 4–16 cells, so one to four pans fully warms an area, and warm cells cost zero thereafter; the DB leg keeps skipped-cell areas honest meanwhile (any course previously written through still pins instantly). Skipped cold cells do NOT set `degraded` (progressive fill is by design, not impairment) — document this in the handler docstring.

### 2c. Merge, dedupe, cap

1. `merged = db_pins + all_cell_hits` — **DB first**, so on a name tie the DB row (canonical UUID, canonical name casing) wins.
2. `course_finder.dedupe_by_name(merged)` — **the dedupe key is the trimmed, lower-cased course name**: `(c.get("name") or "").strip().lower()`, first occurrence wins (`course_finder.py:331-342`). (The spec calls this "courseNameKey"; the actual implementation is this normalized-name key — name it accurately in code comments.)
3. `course_finder.attach_stable_ids(deduped)` — no-op for DB/cached-warm pins that already carry ids; belt-and-braces for any id-less OSM hit.
4. Truncate to `IN_BOUNDS_MAX_PINS = 40`.
5. **Write-through** (non-blocking, mirrors `/search` step 6, `course_search.py:352-355`): collect this request's *fresh* (cold-cell) OSM hits and schedule `bg.add_task(_write_through_courses, course_finder.external_course_rows(fresh_osm_hits))`. `_write_through_courses` is already lazy-import + no-op-on-empty (`course_search.py:192-200`); `external_course_rows` ids are deterministic so `ON CONFLICT DO NOTHING` stays idempotent (`courses_mapped.py:523-552`). This is the flywheel: scanned cells make future DB legs (and voice course-resolution, spec §B.3) local-fast.

---

## 3. Budget invariants (test-able assertions — the builder MUST encode these)

On the `/in-bounds` path, for every request, warm or cold:

1. `course_search._search_google_places` — **NEVER invoked.**
2. `course_search._search_golfapi` — **NEVER invoked.**
3. `golfapi_cache.*` (specifically `golfapi_cache.discover_golfapi_clubs`) — **NEVER invoked.**
4. `course_finder.search_google_places` — **NEVER invoked** (the underlying helper, in case someone bypasses the route alias).
5. `course_finder.search_mapbox` / `_search_mapbox` — **NEVER invoked** (not listed in the prompt's four but same law; free tier is not the point, path purity is).
6. OSM is reached ONLY through the per-cell cache gate: **a fully-warm viewport makes ZERO external calls of any kind** (assertable: spy on `course_search.search_golf_courses` — the route calls the module-level imported name, so monkeypatch `course_search.search_golf_courses`, exactly as `TestNearbyCourses` does at `test_course_search.py:608-630`).
7. Cold-cell OSM calls per request ≤ `IN_BOUNDS_MAX_COLD_CELLS` (4), each cell at most once per request.

QA/review asserts these with monkeypatched spies that raise `AssertionError` if called (see §5 test T6).

---

## 4. Honesty / degraded-not-empty (no-fake-data law)

- Pins are ONLY real course centers: DB rows (previously ingested/written-through real courses) + real OSM `leisure=golf_course` hits with a `center`. Nothing synthesized, ever.
- **The seam truth** (verified in `osm.py:398-465` + `_post_with_retry` `:43-100`): `search_golf_courses` returns `[]` for BOTH "genuinely no courses here" AND "Overpass timed out / 429 / 5xx / transport error" — transient failures are swallowed *inside* `_post_with_retry` (returns `None` → `[]`). Timeout and empty are indistinguishable at this seam. Therefore:
  - **NEVER negative-cache**: `_in_bounds_cache.set` is called only for non-empty results (same law as `/nearby`, `course_search.py:406-410, 429-430`). A genuinely-empty cell (ocean, desert) re-queries on later requests — rare, cheap, and the only honest option.
  - **NEVER treat empty-from-OSM as authoritative**: an empty OSM leg still returns the DB pins.
- **`degraded` detection**: wrap each cold-cell call in a small try/except (a `_run_leg`-style outcome classifier, cf. `course_search.py:141-165`): if the call **raises** (any `Exception`, incl. `asyncio.TimeoutError`) → catch, log WARNING, contribute `[]`, set `degraded = True`, and do not cache that cell. A cell that *returns* `[]` without raising is classified "empty", NOT degraded.
- **Documented residual limitation (be honest in the docstring + plan):** because `_post_with_retry` swallows the common failure modes into `[]`, most real Overpass flakiness will NOT raise and therefore will NOT set `degraded: true` — it is unknowable at this seam without changing `osm.py` (out of B1 scope). The mitigations that make this acceptable: (a) the DB leg always runs and always returns real pins, (b) empty is never cached, so the very next request retries the cell, (c) the write-through flywheel steadily shrinks OSM dependence. `degraded: true` fires when we KNOW (a raise); silence degrades gracefully to "fewer pins this request, self-healing".

---

## 5. Verification gates (pytest, RED→GREEN)

### DB-free unit tests — new file `backend/tests/test_course_in_bounds.py`

Follow `TestNearbyCourses` conventions: call the handler coroutine directly, monkeypatch `course_search`-module names, reuse a local `FakeCacheStore` (copy the one at `test_course_search.py:95`). Monkeypatch `course_search._db_courses_in_bounds` (no `DATABASE_URL` needed — that's why the lazy wrapper exists). For write-through assertions, pass a real `BackgroundTasks()` and either inspect `.tasks` or monkeypatch `_write_through_courses` with a recording spy.

- **T1 — cell-key/enumeration purity:** `_in_bounds_cell_key` format `inbounds:v1:{ilat}:{ilng}`; `_cells_for_bbox` covers exactly the intersecting cells, center-out ordering; two overlapping bboxes share cell keys (per-cell reuse).
- **T2 — validation → 400:** inverted lat (`swLat >= neLat`), inverted lng incl. antimeridian (`swLng >= neLng`, e.g. 179 → -179), out-of-range lat/lng, non-finite → `HTTPException` with `status_code == 400`.
- **T3 — cold cell:** empty `FakeCacheStore`, DB stub returns `[]`, OSM spy returns one hit → exactly ONE `search_golf_courses` call per cold cell (assert call count and per-call `lat/lng/radius_m=4000/interactive=True`); hit carries `deterministic_course_id("osm-way/…")`; cache `.set` called once per non-empty cell with the right key; write-through scheduled with `external_course_rows` of the fresh hits.
- **T4 — warm cell:** pre-seed `FakeCacheStore` for every covered cell → ZERO `search_golf_courses` calls; cached pins returned; `.set` not called again; no write-through of cached hits.
- **T5 — positive-only cache:** OSM returns `[]` for a cell (no raise) → `.set` NOT called for that cell; `degraded` is `False`.
- **T6 — budget invariant:** monkeypatch `course_search._search_google_places`, `course_search._search_golfapi`, `course_search.golfapi_cache.discover_golfapi_clubs`, `course_finder.search_google_places`, and `course_search._search_mapbox` to raise `AssertionError("budget violation")`; run a cold request AND a warm request → both succeed, zero violations.
- **T7 — degraded, not empty:** `search_golf_courses` monkeypatched to raise; DB stub returns 2 pins → response is those 2 pins + `degraded: True`, NOT `[]`, NOT a 500; nothing cached.
- **T8 — pin cap:** DB stub returns 60 in-box rows → `len(courses) == 40`.
- **T9 — zoomIn:** 1°×1° bbox → `{"courses": [], "degraded": False, "zoomIn": True}`; assert DB stub AND OSM spy were never called.
- **T10 — fanout cap:** bbox covering ~12 cells, all cold → exactly `IN_BOUNDS_MAX_COLD_CELLS` (4) OSM calls, and the 4 called cells are the closest-to-center ones; `degraded` stays `False`.
- **T11 — dedupe across DB+OSM:** DB pin `"Bethpage Black"` + warm-cell OSM hit `"  bethpage black "` → one pin, `source == "local"` (DB-first ordering wins the normalized-name tie).

### DB-backed integration tests — extend `backend/tests/integration/` (new `test_courses_in_bounds_db.py`, reusing `conftest`'s `_postgres_reachable` skip + `_ensure_schema`; runs for real in CI's `required-backend` gate on the `postgis/postgis:16-3.4` service, `ci.yml:66-100`)

- **I1 — bbox correctness:** seed via `write_through_courses` three courses — two inside the envelope, one outside → `courses_in_bounds` returns exactly the two inside, `_list_item` shape (`id/name/address/location/updatedAt`), and excludes the outside one.
- **I2 — limit + center ordering:** seed more rows than `limit`; assert `limit` respected and nearest-to-bbox-center rows returned first.
- **I3 — write-through round-trip (the flywheel):** `write_through_courses(external_course_rows(osm-shaped hits))` → the same deterministic ids appear in a subsequent `courses_in_bounds` call over that box.

(Local dev without Postgres: I-tests auto-skip via `_postgres_reachable`; CI runs them. If running locally with docker: `postgis/postgis:16-3.4` + the schema bootstrap conftest already performs — note the integration conftest uses `Base.metadata.create_all` + the 001 SQL schema, not alembic, so no extra step for the builder.)

---

## 6. Files to touch (complete list — no new dependency)

1. `backend/app/routes/course_search.py` — `_in_bounds_cache`, `IN_BOUNDS_CELL_DEG`, `IN_BOUNDS_MAX_COLD_CELLS`, `IN_BOUNDS_MAX_PINS`, `IN_BOUNDS_MAX_AREA_SQDEG`, `_in_bounds_cell_key`, `_cells_for_bbox`, `_db_courses_in_bounds`, and the `@router.get("/in-bounds")` handler.
2. `backend/app/services/courses_mapped.py` — `courses_in_bounds(...)` (place after `nearby_courses`).
3. `backend/data/in_bounds_search_cache.json` — created lazily by `FileSearchCacheStore` at runtime; nothing to commit.
4. `backend/tests/test_course_in_bounds.py` — new, DB-free (T1–T11).
5. `backend/tests/integration/test_courses_in_bounds_db.py` — new, DB-backed (I1–I3).

**Shared-type sync note:** `frontend/src/lib/golf-api.ts` already models this wire shape — `CourseSearchApiResponse` (`:419-437`, `courses[]` with `id/osm_id/name/address/center/source`) and `CourseSearchResult` (`:399-413`, `source` union already includes `'osm' | 'local'`). `frontend/src/lib/types.ts` has no pin type and needs none. The only additive fields are `degraded` and `zoomIn`, consumed exclusively by the B2 map UI — **no frontend type change in B1** (B1 is backend-only); B2's plan must add those two fields to whatever client type it introduces. State this in the B1 PR description so the follow-up isn't lost.

---

## 7. Edge cases & residual risks

- **Antimeridian crossing** (`swLng > neLng`, e.g. Fiji viewport): **rejected with 400** in B1 (falls out of the `swLng >= neLng` check naturally). Decision: out-of-scope — no golf-market pressure there, and splitting into two envelopes doubles every leg. Document in the handler docstring; B2's client should never emit such a box for supported regions.
- **Cell-cache staleness:** positive TTL is 24 h; a course newly added to OSM inside a warm cell won't appear via the OSM leg until expiry. Mitigation: the DB leg is ALWAYS live — any course that entered `public.courses` via write-through from `/search`, `/nearby`, ingest, or another viewport's cold cell pins immediately regardless of cell warmth. Accept the 24 h OSM lag.
- **Overpass mirror flakiness:** bounded blast radius by design — ≤4 calls/request, interactive budget (~5.5 s worst case), failures→`[]`→never cached→auto-retry next request, DB floor always returned, `degraded` flagged on raises. No retry loops beyond `search_golf_courses`' built-in single retry.
- **Cache-key collision safety:** dedicated file (`in_bounds_search_cache.json`) shared with NO other namespace; versioned `inbounds:v1:` prefix; integer floor-indices (not rounded floats) so `-0.0`/formatting drift can't alias two cells; key never contains user input.
- **Cold-cell skip honesty (residual, accepted):** a large-but-legal viewport (many cold cells) shows DB pins + up to 4 cells of OSM fill on the first pass; remaining cells warm progressively. Not flagged `degraded` (by design). The write-through flywheel makes this converge toward all-DB-instant.
- **Silent Overpass empty (residual, documented in §4):** indistinguishable from genuine empty at the seam; `degraded` cannot fire for it. Accepted for B1; fixing it properly means an outcome-returning variant of `search_golf_courses` in `osm.py` — a candidate follow-up, not this slice.
