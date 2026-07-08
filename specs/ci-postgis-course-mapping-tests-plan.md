# Implementation Plan: `ci-postgis-course-mapping-tests`

## Summary
Give the CI Postgres service PostGIS, bootstrap the raw-SQL course-mapping schema inside the integration conftest, and land 3 DB-backed integration tests against `app/services/courses_mapped.py`. This is silent infra/test work — no app source, no user-facing surface, no new dependencies. All DB-backed tests self-skip on this dev machine (no local Postgres) and run for real only on the CI backend gate.

Editable files (the only three surfaces touched):
1. `.github/workflows/ci.yml` — one-line image swap.
2. `backend/tests/integration/conftest.py` — schema bootstrap + TRUNCATE list additions.
3. `backend/tests/integration/test_courses_mapped_db.py` — NEW test file (3 tests + fixtures).

Guardrail compliance: no edits to `backend/app/**`, `deploy/**`, or `backend/supabase/migrations/**` (all read-only here). No new pip deps.

---

## Part 1 — CI: PostGIS-capable Postgres service

### File: `.github/workflows/ci.yml`
In the `required-backend` job's `services.postgres`, change exactly one line:

```yaml
    services:
      postgres:
        image: postgis/postgis:16-3.4      # was: postgres:16
```

Nothing else in the job changes. Rationale, verified against the current job body:
- `env` (`POSTGRES_PASSWORD: postgres`, `POSTGRES_DB: scorecard_test`), `ports: 5432:5432`, and the `--health-cmd "pg_isready -U postgres"` health check are all still valid — `postgis/postgis:16-3.4` is the official PostGIS image built ON TOP of `postgres:16`, so `pg_isready`, the Postgres entrypoint, and the `POSTGRES_*` env contract are identical.
- The image's init scripts auto-create the `postgis` extension in `template1` and in `$POSTGRES_DB` (`scorecard_test`). So the migration's `create extension if not exists postgis;` becomes a no-op success rather than a permission/availability failure.
- `DATABASE_URL: postgresql+asyncpg://postgres:postgres@localhost:5432/scorecard_test` and the `uv sync` / `ruff` / `uv run pytest` steps are unchanged.

There is NO Alembic step to add. This repo bootstraps schema in the conftest (`Base.metadata.create_all` + raw SQL), not via alembic-in-tests — the item's original "run Alembic migrations" framing does not match reality. We extend the conftest fixture route instead.

---

## Part 2 — Conftest: bootstrap the course-mapping schema

### File: `backend/tests/integration/conftest.py`

Two edits, both inside the existing schema/fixture machinery. Do not touch the DATABASE_URL preamble, the `_postgres_reachable` probe, `client`, or the auth helpers.

#### 2a. Add a top-of-module import for `Path`
Alongside the existing stdlib imports (`os`, `re`, `socket`), add `from pathlib import Path`.

#### 2b. Extend `_ensure_schema(engine)` to run the course-mapping SQL

Current `_ensure_schema` runs `Base.metadata.create_all` then adds `scores_round_player_hole_uq`. Append a third step inside the SAME `async with engine.begin() as conn:` block, AFTER the scores-constraint `DO $$` block, that executes the entire `001_course_mapping_schema.sql` file.

Why the file must NOT go through `conn.execute(text(...))`: the SQLAlchemy/asyncpg path prepares and runs ONE statement. `001_course_mapping_schema.sql` is a multi-statement script containing `create extension`, five `create table`s, four `create index`es, a `create or replace function ... $$ ... $$`, and a `do $$ ... $$` trigger block. asyncpg rejects multi-command / dollar-quoted scripts through the prepared-statement path. The robust route is asyncpg's own simple-query protocol via `Connection.execute(script)` with NO args, which runs a full multi-statement script.

Specify it concretely as (illustrative — final code lives in the file):

```python
# course-mapping tables (courses/tee_sets/holes/hole_yardages/hole_features)
# are NOT ORM/Base tables — they come from raw SQL in migration 001. Run the
# real migration file verbatim so the test schema never drifts from prod.
mig = (
    Path(__file__).resolve().parents[2]
    / "supabase" / "migrations" / "001_course_mapping_schema.sql"
)
if not mig.is_file():
    raise RuntimeError(f"course-mapping migration not found: {mig}")
sql_script = mig.read_text()
# asyncpg's simple-query protocol runs a whole multi-statement / dollar-quoted
# script; text()/prepared-statement path would choke on it.
raw = await conn.get_raw_connection()
await raw.driver_connection.execute(sql_script)
```

Verified details:
- `Path(__file__).resolve().parents[2]` resolves to `/Users/justinlee/projects/scorecard/backend`, so the joined path is the real migration file and `.is_file()` is True.
- `conn.get_raw_connection()` returns SQLAlchemy's adapted connection; `.driver_connection` is the underlying `asyncpg.Connection`. `asyncpg.Connection.execute(sql)` with no positional args uses the simple-query protocol and executes all statements in the script. Running it on the same `engine.begin()` connection keeps it in the create_all transaction (DDL is transactional in Postgres, so this is atomic and consistent).
- Decision: run the file VERBATIM, not a trimmed inline subset. The file is self-contained, idempotent (`create ... if not exists`, `create or replace`, guarded `do $$` trigger creation), needs only the postgres superuser + the postgis extension (both present on `postgis/postgis:16-3.4`), and running it verbatim guarantees the test schema tracks the production schema with zero maintenance drift.
- `gen_random_uuid()` is core in PG16. `ST_GeomFromGeoJSON` / `ST_SetSRID` / `ST_MakePoint` / `geography` / `geometry(Geometry,4326)` are all provided by the auto-created `postgis` extension. Nothing beyond the image is required.
- Error handling: the explicit `is_file()` guard raises a clear `RuntimeError` so a moved/renamed migration fails CI loudly at schema-setup time.
- The module-global `_schema_ready` guard already ensures this runs exactly once per session.

#### 2c. Add the 5 course-mapping tables to the per-test TRUNCATE list

In the autouse `_db` fixture's `TRUNCATE TABLE ... RESTART IDENTITY CASCADE`, add the course-mapping tables (single comma list, CASCADE, ordering irrelevant; children-before-parent for readability):

```
... player_profiles,
hole_features, hole_yardages, holes, tee_sets, courses
RESTART IDENTITY CASCADE
```

Notes:
- These tables use uuid PKs (no sequences), so `RESTART IDENTITY` is a harmless no-op for them.
- No effect on existing integration tests: they never populate course-mapping tables, TRUNCATE-of-empty is a no-op, and there is no FK from any ORM table into `public.courses` (the ORM's course concept is the separate `scoring_courses` table), so `CASCADE` cannot reach ORM data.

---

## Part 3 — New DB-backed test file

### File: `backend/tests/integration/test_courses_mapped_db.py` (NEW)

Three async tests exercising the live engine via `app/services/courses_mapped.py`. They inherit the autouse `_db` fixture from conftest, so each self-skips locally (no reachable Postgres) and runs for real in CI, with a truncated schema before each test.

Module docstring should state: DB-backed integration coverage for the PostGIS mapped-course layer (previously zero live-DB coverage); skips locally via conftest's `_postgres_reachable` probe, runs in CI on the `postgis/postgis:16-3.4` service.

Imports: `import pytest`, and lazy in-test imports of the app modules (`from app.services import courses_mapped`, and for test (d) `import app.routes.caddie as caddie_routes`) so DATABASE_URL is already set by conftest before any app import. Mark async tests per the repo convention — mirror the existing `tests/integration/` async style.

#### Shared seed helper
A builder `_seed_course(course_id, *, green_geometry, green_props, par=5)` returning the exact dict shape `upsert_course` consumes:

```python
{
    "id": course_id,                       # uuid string, e.g. str(uuid.uuid4())
    "name": "DB Test Course",
    "address": "1 Integration Way",
    "location": {"lat": 40.71, "lng": -73.45},
    "teeSets": [{"name": "Blue", "color": "#2563eb"}],
    "holes": [
        {
            "number": 1,
            "par": par,                    # 5, i.e. != 4 so the hole is never
                                           # skipped as an "untouched default"
            "handicap": 1,
            "yardages": {"Blue": 540},
            "features": {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"featureType": "green", **green_props},
                        "geometry": green_geometry,   # Point or Polygon
                    },
                    # tee feature added only by tests that need precompute
                ],
            },
        }
    ],
}
```

Critical seeding rules derived from `upsert_course`:
- The hole MUST persist. `upsert_course` skips a hole when `not has_features and not has_yardages and par == 4`. Our seed hole has a feature AND a yardage AND `par=5` — persists unambiguously.
- Feature `feature_type` is taken from `properties.featureType` (default `"green"`). We set it explicitly so `update_green_feature_properties` (targets `feature_type='green'`) and `_feature_center(..., "green"/"tee")` match.
- Geometry is stored via `ST_SetSRID(ST_GeomFromGeoJSON(:geom),4326)`, so any valid GeoJSON Point/Polygon works. Use a Point `{"type":"Point","coordinates":[-73.452,40.710]}` for the green in (b)/(e); (d) needs both a tee Point and a green Point.

Use `uuid.uuid4()` string ids per test so tests are independent.

#### Test (b): write-back → get_course round-trip
1. `cid = str(uuid.uuid4())`. `await courses_mapped.upsert_course(_seed_course(cid, green_geometry=<Point>, green_props={"existing": 1}))`.
2. `ok = await courses_mapped.update_green_feature_properties(cid, 1, {"delta_ft": 4.2})` → assert `ok is True`.
3. `course = await courses_mapped.get_course(cid)`.

Assertions:
- `course is not None`; `course["holes"]` has 18 entries; hole index 0 is number 1 with `par == 5`.
- `feats = course["holes"][0]["features"]["features"]`; find `properties["featureType"] == "green"`.
- `green["properties"]["delta_ft"] == 4.2`; `green["properties"]["existing"] == 1`; `green["properties"]["hole"] == 1`.

#### Test (e): merge preserves other keys + no-op returns False
Part 1 — merge preserves:
1. `cid = str(uuid.uuid4())`; upsert seed with `green_props={"existing": 1}`.
2. `ok = await courses_mapped.update_green_feature_properties(cid, 1, {"new": 2})` → assert `True`.
3. `get_course(cid)`; green props → assert BOTH `existing == 1` AND `new == 2` survive (additive `||` merge).

Part 2 — no-op returns False (no state change):
- Absent green feature: seed a SECOND course whose only hole feature is NON-green (`featureType: "tee"`, plus a yardage/par=5 so the hole persists). `await update_green_feature_properties(cid2, 1, {"x": 1})` → assert `False`; `get_course(cid2)` shows nothing written.
- Nonexistent hole number on the first course: `update_green_feature_properties(cid, 7, {"x": 1})` → assert `False`.
- Cheap extra real-DB no-write assertions: `update_green_feature_properties(cid, 0, {"x": 1})` → `False` (via `_valid_hole_number`); `update_green_feature_properties(cid, 1, {})` → `False` (empty patch).

#### Test (d): precompute backfill through the real DB seam
Seam: call `app.routes.caddie._precompute_course_elevations(course_id)` with module-level `sample_course_elevations` monkeypatched to a deterministic offline stub, but `get_course` / `update_green_feature_properties` LEFT REAL so they hit the live DB. Exercises real read → synth-hole construction → real write-back → real read-back, and idempotency.

Seed: one hole with BOTH a tee Point feature and a green Point feature, green props `{"existing": 1}` (NO `tee_elevation_ft`, so `_green_persisted_elevation` returns None and the hole is eligible). `par=5`, a yardage.

Monkeypatch (pytest `monkeypatch`): patch `caddie_routes.sample_course_elevations` to an async stub:

```python
async def _stub_sample(synth_holes, target_course_name):
    assert target_course_name == "precompute"
    refs = {f["properties"]["ref"] for f in synth_holes}
    return {
        ref: {
            "tee_elevation_ft": 90.0,
            "green_elevation_ft": 100.0,
            "net_change_ft": 10.0,
            "plays_like_yards": 3.3,
            "green_slope": None,
        }
        for ref in refs
    }
monkeypatch.setattr(caddie_routes, "sample_course_elevations", _stub_sample)
```

Do NOT patch `caddie_routes.courses_mapped.get_course` / `update_green_feature_properties`.

Steps + assertions:
1. `cid = str(uuid.uuid4())`; `upsert_course(seed_with_tee_and_green)`.
2. First run: `await caddie_routes._precompute_course_elevations(cid)`. `course = await courses_mapped.get_course(cid)`; green props → `delta_ft == 10.0` (from `net_change_ft` via `_elevation_patch`), `tee_elevation_ft == 90.0`, `green_elevation_ft == 100.0`, `plays_like_yards == 3.3`, `existing == 1` still present; `green_slope` ABSENT (`_elevation_patch` omits None).
3. Idempotency: wrap the stub with a call counter; run `_precompute_course_elevations(cid)` a SECOND time. Assert: no exception; the sampler was NOT called on the second run (count stays 1 — after run 1 the green carries `tee_elevation_ft`, so `_green_persisted_elevation is not None` filters the hole out → zero-sample early return); re-read `get_course`; green props unchanged and exactly one green feature (`len([f for f in feats if f["properties"]["featureType"]=="green"]) == 1`).

Confirm the exact precompute entrypoint name / `sample_course_elevations` signature / `ref` key by reading `app/routes/caddie.py` before writing — adjust the stub to match its real call shape and the `_elevation_patch` field mapping.

---

## Part 4 — Edge cases / risks
- Table-name collision: RESOLVED — no ORM/`Base` model maps `courses`/`tee_sets`/`holes`/`hole_yardages`/`hole_features` (ORM uses `scoring_courses`, `hole_pins`). Disjoint tables — no collision.
- PostGIS image pull: `postgis/postgis:16-3.4` is layered on `postgres:16`; pulled in well under a minute on GitHub runners. `< +3 min` comfortably met. No local pull on this dev machine.
- `gen_random_uuid()` / `ST_GeomFromGeoJSON`: no prerequisites beyond the image.
- TRUNCATE impact on existing integration tests: none (empty tables, no FK path to ORM data).
- Multi-statement execution: mitigated via asyncpg simple-query `Connection.execute(script)` (no args). Broken future migration → loud CI schema-setup failure.
- Missing-file risk: guarded by explicit `is_file()` → clear `RuntimeError`.

---

## Part 5 — Gates
Local (DB tests self-skip — validates lint + non-DB logic only; do NOT start a local Postgres/container):
```
cd /Users/justinlee/projects/scorecard/backend
ruff check .
uv run pytest -k "not integration or courses_mapped"
```
Expect: ruff clean; new DB tests SKIPPED locally; existing non-DB `test_precompute_elevation.py` still passes.

Real verification — CI `required-backend` job on the pushed PR (pinned to head SHA):
- Read the `Backend gate` log; assert the 3 new tests in `test_courses_mapped_db.py` show PASSED (not skipped — skipped ⇒ PostGIS service/probe failure, investigate). Suite count up by 3, stays green.
- No regressions in the existing ~151-test suite.

Consistency with NORTHSTAR.md: silent infra/test-only work — nothing user-facing added or altered.
