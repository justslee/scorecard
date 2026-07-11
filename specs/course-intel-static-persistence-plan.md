# Plan: course-intel-static-persistence (v2 — Gap A + Gap B closure)

Backend only. Silent. **NO Alembic migration** (ruling + justification in section 3). Supersedes the v1 plan at this path, which was implemented verbatim in commits `0200576` + `9c5e338`.

## 1. Status: the item is ~90% built — this cycle closes two verified gaps

Verified in code (do not rebuild any of this):

- **Persistence exists, per-hole**: `tee_elevation_ft`, `green_elevation_ft`, `delta_ft`, `plays_like_yards`, `green_slope{direction,severity,percent_grade,description}` live in the green feature's `hole_features.properties` JSONB, written via the non-destructive, hole-number-validated JSONB `||` merge `update_green_feature_properties()` + the single patch builder `_elevation_patch()` (`backend/app/services/courses_mapped.py:446-506`).
- **Instant read exists**: `build_hole_intelligence` (`backend/app/caddie/course_intel.py:117-137`) makes ZERO USGS/3DEP calls on a persisted hit; wired in `get_course_intel` (`backend/app/routes/caddie.py:1219-1231`) via `_green_persisted_elevation` (`caddie.py:126`).
- **Bulk compute-once exists**: `_precompute_course_elevations` (`backend/app/routes/caddie.py:179-225`) — 2 batched 3DEP calls via `sample_course_elevations`, idempotent (skips holes with `tee_elevation_ft`), best-effort (never raises).
- **Backfill-on-demand exists**: live-compute miss with valid course_id + validated hole number writes back (`course_intel.py:161-178`).
- **Honesty preserved**: USGS `None` → nothing persisted (`sample_course_elevations` omits the hole; write-back guards both endpoints non-None). No fabricated zeros.

**Gap A (confirmed)**: `_precompute_course_elevations` fires ONLY from `/session/start` (`caddie.py:323`). `create_mapped`/`put_mapped` (`backend/app/routes/courses_mapped.py:68-78, 105-116`) schedule the GUIDES precompute but not elevations — a freshly-mapped course races its first course-intel open.

**Gap B (confirmed, and worse than stated)**: the idempotent skip is "has `tee_elevation_ft`". `upsert_course` is delete+reinsert of `hole_features` using *client-supplied* properties (`courses_mapped.py:402-427`), and the course editor round-trips `get_course` output — so after a geometry re-map the STALE elevation props ride back in and the skip keeps them forever. There is no stamp to detect this.

## 2. Static-vs-dynamic classification (confirmed, one addition)

| Data | Class | Handling |
|---|---|---|
| tee/green elevation, `delta_ft`, `plays_like_yards` | **Static per hole** | persisted (done) + invalidate on geometry change (Gap B) |
| `green_slope` (3DEP Sobel around green center) | **Static per hole** | same store, same invalidation — its sampled inputs are fully determined by the green center |
| `strategy_guide` | Static per hole | already handled separately (own precompute + negative cache) — out of scope |
| weather (temp/wind/humidity/pressure/conditions, air-density) | **Dynamic** | `build_weather_conditions` stays live every call — DO NOT persist |
| course `altitude_ft` inside weather | quasi-static | already served through the service-level quantized DB cache (`fetch_elevation_cached`) — no change |
| hazards / bend / approach bearing / effective_yards | pure functions of stored geometry + request, no network | correctly computed per request — no change |

Nothing else qualifies. Classification in the codebase is already correct.

## 3. SCHEMA RULING — Option 1: existing per-feature JSONB + stamp inside it. **NO new column. NO Alembic migration.** (Deliberate, explicit deviation from the prescriptive prompt.)

The task text prescribes "a new `courses.static_intel` JSONB column + Alembic migration". **Ruling against that, loudly and on the record**, and this plan is the contract justifying it:

1. **The data is per-hole, not per-course.** Elevation delta and green slope differ per hole. A course-level `static_intel` blob would be an 18-key map re-encoding data that already lives on the exact row that owns it (the hole's green feature).
2. **It creates a second source of truth.** Read path, write-back, precompute, ingest (`osm_ingest.embed_elevation_in_green_features`), AND the frontend map page (`frontend/src/lib/course/hole-elevation.ts` reads `tee_elevation_ft`/`green_slope` straight off green-feature GeoJSON properties) all consume the per-feature JSONB today. A course-level copy must be kept in sync with all five, and invalidation must touch both stores. Strictly worse architecture for zero functional gain.
3. **The backlog's literal words are already satisfied.** "Persist on the mapped course record" — `hole_features` is a child table of `courses`; the per-feature JSONB *is* part of the stored mapped-course record and round-trips through `get_course`/`upsert_course`.
4. **The one scenario that could justify a column — cheap bulk invalidation — doesn't hold.** Invalidation here is content-addressed per hole (section 4): a re-map invalidates exactly the holes whose tee/green centers moved, automatically, with no flag to bump. A hypothetical "invalidate all holes" is still one SQL statement over JSONB — no scalar column needed. A course-level `intel_version` would additionally be blind to which holes changed, forcing full-course resamples on any edit.
5. **Migrations are not free.** A new column is permanent API surface on the hottest table's parent, needs backfill semantics, and — per this repo's migration guard rules — is a NEW file reviewers must clear. Spending that on redundant data is the wrong trade.

**Reviewer contract:** if this deviation is challenged, the answer is: the prompt's *goal* (compute once, persist on the course record, serve instantly) is fully met by the existing per-feature JSONB; the prompt's *mechanism* (new column) was written before the trace showed v1 already shipped the store. Zero-migration is the deliberate design, not an omission.

## 4. Invalidation design (Gap B): content-addressed `elevation_coords_key`

**Chosen: quantized coords-hash. Rejected: bare `computed_at` (cannot detect geometry change), version int (requires a human/process to remember to bump; detects nothing).**

Two new keys inside the existing green-feature JSONB patch — no schema change, additive, invisible to typed API contracts:

- `elevation_coords_key: str` — `f"{tee_lng:.6f},{tee_lat:.6f};{green_lng:.6f},{green_lat:.6f}"` from the STORED tee/green feature centers (6 dp ≈ 0.11 m — far below any real re-map, far above float noise; both comparison sides always come from the same `get_course` → `ST_AsGeoJSON` pipeline, so it is deterministic). These centers are exactly the sampled inputs of both the elevation endpoints and the slope Sobel grid, so key-equality ⇒ persisted data is valid by construction.
- `elevation_computed_at: str` — ISO-8601 UTC, observability only, never read by logic.

**Who stamps what:**
- `_elevation_patch()` gains `elevation_computed_at` (single builder → both write-back and precompute stamp it).
- **Only `_precompute_course_elevations` stamps `elevation_coords_key`** (it is the only writer that samples the canonical stored centers; the request-path write-back samples client-sent coords and must NOT stamp a key it can't vouch for).

**New skip logic in the precompute (this IS the invalidation):** skip a hole iff persisted elevation exists AND `persisted["elevation_coords_key"] == current_key(stored centers)`. Missing key (legacy / write-back-seeded / ingest-seeded blobs) or mismatched key (re-mapped geometry) → resample and overwrite via the existing `||` merge, now stamped. Converges: every course gets re-validated + stamped exactly once after deploy, then skips forever until geometry actually moves.

**Read path stays UNTOUCHED** — no key check on the hot path. After a re-map there is a seconds-wide window serving the previous (plausible, real) values until the background task lands; that beats a strip-induced slow-path window, and a failed task self-heals on the next trigger (every `/session/start` re-fires). Deliberately NOT stripping incoming elevation props at the route: stripping destroys valid data on every editor save and regresses the course to the slow path whenever 3DEP hiccups.

## 5. Exact changes by file

### 5a. NEW `backend/app/services/course_elevation.py` — move the precompute out of the caddie route (import hygiene)

Wiring the precompute into `routes/courses_mapped.py` by importing from `routes/caddie.py` would not cycle today (verified: nothing under `app/` imports `app.routes.*` except `main.py`), but it couples the light CRUD route to the heaviest module in the app and inverts the established pattern — guides already live in `app/services/course_guides.py` for exactly this reason. Move, don't cross-import.

Move verbatim from `routes/caddie.py` (deleting them there): `_feature_center` (caddie.py:152-176, takes the `_ring_centroid` import with it), `_green_persisted_elevation` (:126-136), `_precompute_course_elevations` (:179-225). Add: `elevation_coords_key(tee_c, green_c) -> str` (tuples are `(lng, lat)` as `_feature_center` returns them). Then modify `_precompute_course_elevations`:

- In the per-hole loop, compute `current_key = elevation_coords_key(tee_c, green_c)`; replace the skip with: `persisted = _green_persisted_elevation(h)`; `if persisted is not None and persisted.get("elevation_coords_key") == current_key: continue`. Record `key_by_hole[h["number"]] = current_key` for synth holes.
- In the write-back loop: `patch = courses_mapped._elevation_patch(profile)`; `patch["elevation_coords_key"] = key_by_hole[hole_number]`; pass to `update_green_feature_properties` unchanged.

Module imports: `app.services.courses_mapped`, `app.services.elevation.sample_course_elevations`, and the `_ring_centroid` helper — none import back; no cycle. (Verify `_ring_centroid`'s actual home module before moving — grep for its definition.)

### 5b. `backend/app/routes/caddie.py`

- Delete the three moved functions; import `_green_persisted_elevation` and `_precompute_course_elevations` from `app.services.course_elevation` (mirrors the existing `_precompute_course_guides` import at :54). Drop the now-unused `_ring_centroid` import if nothing else in the file uses it. Call sites (:323, :1220) unchanged.

### 5c. `backend/app/routes/courses_mapped.py` (Gap A — the headline fix)

In BOTH `create_mapped` and `put_mapped`, inside the existing `if course:` block, add `bg.add_task(_precompute_course_elevations, course["id"])` **BEFORE** the existing guides task — BackgroundTasks run in order, and `_precompute_course_guides` reads `delta_ft`/`green_slope` off the green props for research context (`course_guides.py:102-103`), so elevation must land first (this also matches the `/session/start` ordering, caddie.py:323 before :328). Import from `app.services.course_elevation`. ~3 lines per route.

### 5d. `backend/app/services/courses_mapped.py`

`_elevation_patch()`: add `"elevation_computed_at": datetime.now(timezone.utc).isoformat()`. Nothing else. (Docstring: note it now supersets — not mirrors — `embed_elevation_in_green_features`'s mapping; ingest stays unstamped by design and gets re-validated + stamped by the first precompute pass.)

### 5e. Explicitly untouched

`course_intel.py` read/write-back logic, `elevation.py`, `osm_ingest.py`, `upsert_course`, weather path, all frontend, all migrations (`backend/migrations/versions/**`, `backend/supabase/migrations/**` — guarded, do not touch).

## 6. Edge cases & risks

- **Idempotency / cost**: unchanged-geometry editor save → all keys match → zero 3DEP calls. One-hole re-map → 2 batched calls carrying only that hole. Post-deploy first trigger per course → one full resample (2 calls) to stamp legacy data — desirable revalidation, bounded, background.
- **Best-effort/never-500 preserved**: outer try/except in the precompute and per-hole write-back try/except are moved verbatim; route handlers only ever `add_task`.
- **No-fabrication preserved**: `sample_course_elevations` omits USGS-None holes → no merge → old values (if any) remain with their old key → retried next trigger. Absent stays absent; a real 0.0 delta still persists.
- **Concurrent merges**: `put_mapped`-triggered task vs `/session/start` task vs request write-back — all funnel through the single-statement JSONB `||` UPDATE; last-writer-wins per key, no torn state. A precompute mid-flight across an `upsert_course` delete+reinsert lands old-geometry values stamped with the old key → next trigger detects mismatch and heals.
- **BackgroundTasks semantics**: tasks run after the response; the `bg = background_tasks if ... else BackgroundTasks()` fallback (existing pattern) means direct unit calls don't auto-run — production always injects. Unchanged idiom.
- **Stale-read window**: seconds between re-map commit and task completion serves prior real values (never fabricated). Accepted; documented above.

## 7. Shared-types sync check — clean, verified

- `elevation_coords_key`/`elevation_computed_at` are internal JSONB props, not typed API surface. `backend/app/models.py`, `app/caddie/types.py` (`HoleIntelligence`), and the course-intel response shape are unchanged.
- Frontend: mapped-course features are typed as generic `GeoJSON.FeatureCollection`; `frontend/src/lib/course/hole-elevation.ts` picks known keys off props — additive keys are invisible to it. **No `frontend/src/lib/types.ts` change.**

## 8. Tests + gates (the verification contract)

**Update** the existing precompute-elevation unit test (imports move to `app.services.course_elevation`) and add cases: (1) matching key → skip, zero sampler calls; (2) missing key with elevation present → resample; (3) mismatched key → resample + patch carries new `elevation_coords_key`; (4) `elevation_coords_key` quantization determinism; (5) `_elevation_patch` includes `elevation_computed_at` and still omits `green_slope`-when-None.

**New** `backend/tests/test_mapping_precompute_wiring.py` (non-DB, monkeypatch `store.upsert_course` + both precompute fns): `create_mapped` and `put_mapped` schedule elevation-then-guides, in that order; no task scheduled when upsert returns None.

**Extend** the mapped-course DB integration test (real docker Postgres): (a) update the existing idempotency test for the moved import — second run must still be zero-sample because the first run stamped the key; (b) **remap-invalidation round-trip**: seed → precompute (stub sampler) → `upsert_course` with a MOVED green polygon round-tripping the stale props → precompute again → assert values overwritten, new key stamped, unrelated props preserved; (c) graceful-degrade: stub returns `{}` → props untouched.

**Keep green (no-regression)**: the existing course-intel static-read, resilience, hole-elevation-ingest, course-guides, and green-slope-ingest tests. (Verify exact test file names by listing `backend/tests` before editing; adjust if the repo names differ.)

Gates, exactly:
1. `cd backend && ruff check .`
2. `cd backend && python -m pytest -q` (non-DB suite, DB-stub pattern)
3. DB suite against real Postgres: `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=scorecard_test postgis/postgis:16-3.4`, then run the integration suite with `DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/scorecard_test`. The integration harness bootstraps schema itself (`Base.metadata.create_all` + running the real `001_course_mapping_schema.sql` verbatim in `tests/integration/conftest.py`); there is no `alembic upgrade head` step, and none is needed since this plan adds no migration. CI already runs this against the `postgis/postgis:16-3.4` service.
4. Frontend untouched — confirm no-regression only: `cd frontend && npm run lint && npx tsc --noEmit && npx tsx voice-tests/runner.ts --smoke`.

## 9. Implementation order

1. `services/course_elevation.py` (move + key + skip-logic) → 2. `services/courses_mapped.py` `_elevation_patch` stamp → 3. `routes/caddie.py` import swap → 4. `routes/courses_mapped.py` wiring → 5. tests → 6. gates.
