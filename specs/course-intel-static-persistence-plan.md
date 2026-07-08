# Plan: course-intel-static-persistence

Backend only. No frontend change. No Alembic/SQL migration. No `upsert_course` on any hot path.

## Goal

course-intel should READ per-hole elevation intel (tee/green elevation, delta, plays-like,
green slope) from PERSISTED `hole_features.properties` (green feature) when present and SKIP
recomputing it via USGS 3DEP / slope; otherwise compute it live (as today) and WRITE IT BACK
via a TARGETED JSONB `||` merge UPDATE. A FastAPI `BackgroundTasks` job fired at `/session/start`
precomputes all holes for the course (2 batched 3DEP calls) so the second time the owner opens
intel, elevation shows instantly with ZERO USGS calls.

## Ground-truth anchors (verified — build on exactly these)

- Persisted field names + shape come from `embed_elevation_in_green_features`
  (`backend/app/services/osm_ingest.py:252-308`): into the green feature's `properties` it writes
  `tee_elevation_ft`, `green_elevation_ft`, `delta_ft` (alias of `net_change_ft`, +uphill),
  `plays_like_yards`, and `green_slope` (nested dict `direction/severity/percent_grade/description`)
  ONLY when not None. REUSE these exact keys — do not invent new ones.
- Precompute engine: `sample_course_elevations(holes, target_course_name)`
  (`backend/app/services/elevation.py:388-502`) → `{hole_number: profile}` for holes where BOTH
  tee+green succeeded (missing holes OMITTED = the "absent != zero" guarantee); exactly 2 batched
  `fetch_3dep_samples` calls per course. `compute_hole_elevation_profile(tee_ft, green_ft, green_slope=None)`
  (`elevation.py:213-256`) is PURE → `tee_elevation_ft/green_elevation_ft/net_change_ft/plays_like_yards/green_slope`.
- Storage: `get_course` (`backend/app/services/courses_mapped.py:118-255`) spreads each feature's JSONB
  `properties` back into the returned feature `properties` (`:205-215`), so persisted elevation
  round-trips with no schema change. `upsert_course` (`:259-393`) is DESTRUCTIVE
  (`delete from hole_features ... ` then re-insert, `:363-389`) — MUST NOT be used here.
  `hole_features.properties` is `jsonb not null default '{}'`
  (`backend/supabase/migrations/001_course_mapping_schema.sql:60`, do-not-touch).
- Request path: `POST /api/caddie/course-intel` → `get_course_intel`
  (`backend/app/routes/caddie.py:965-1047`) already reads the stored course at `:1006-1009`
  (`courses_mapped.get_course(owned_session.course_id)`) for curated hazards, keyed by hole number
  — the precedent for feeding persisted per-hole data into the intel builder. Per hole it calls
  `build_hole_intelligence` (`backend/app/caddie/course_intel.py:23-106`), which calls
  `fetch_elevation_cached(tee)` + `fetch_elevation_cached(green)` (`:65-66`) and
  `compute_green_slope(green)` (`:76`).
- Session start: `start_session` (`backend/app/routes/caddie.py:143-210`) has NO BackgroundTasks
  today. Pattern to mirror: `backend/app/routes/course_search.py` (`BackgroundTasks` import `:22`,
  param `background_tasks: BackgroundTasks = None` `:214`, `bg = background_tasks or BackgroundTasks()`
  `:254`, `bg.add_task(...)` `:334-336`).
- Reusable centroid: `_ring_centroid(ring) -> (lon, lat)`
  (`backend/app/services/course_spatial.py:276-295`), already imported by `app/caddie/hazards.py:31`
  — reuse to derive green/tee centres from stored polygon features.

## JSONB-shape contract (the one source of truth for every read/write here)

The green feature's `properties` (as returned by `get_course` and as consumed by course-intel)
carries these elevation keys when persisted:

    tee_elevation_ft:   float
    green_elevation_ft: float
    delta_ft:           float          # == net_change_ft; +uphill; green - tee
    plays_like_yards:   float          # net_change_ft / 3
    green_slope:        dict | null    # {direction, severity, percent_grade, description}; OMITTED when null

Rules:
- `delta_ft` is the STORED alias of `net_change_ft`. When building a write-back patch from a
  `compute_hole_elevation_profile` result, map `net_change_ft -> delta_ft`.
- `green_slope` is only written when not None (mirrors `embed_elevation_in_green_features:298`).
- A green feature is considered "has persisted elevation" iff its `properties` contains BOTH
  `tee_elevation_ft` AND `green_elevation_ft` (both non-None). `green_slope` is independent and
  may be absent even when elevation is present.

## Approach (three coordinated changes)

1. READ path: `build_hole_intelligence` accepts a new optional `persisted_elevation` dict. When it
   carries `tee_elevation_ft`+`green_elevation_ft`, USE it and SKIP `fetch_elevation_cached` (both
   calls) and `compute_green_slope`. Cache-hit issues ZERO USGS/3DEP calls. The route extracts the
   green feature's persisted properties from the stored course it ALREADY reads (no second DB read)
   and passes them in.
2. WRITE-BACK: `build_hole_intelligence` accepts new optional `course_id`. On a genuine LIVE compute
   (persisted absent) that produces real tee AND green elevations, it persists the profile into the
   green feature via a NEW targeted `courses_mapped` helper (JSONB `||` merge, single feature). Never
   `upsert_course`. Never write zeros/None to fill a gap.
3. PRECOMPUTE: `/session/start` fires a `BackgroundTasks` job that samples all holes MISSING persisted
   elevation for the course (2 batched calls via `sample_course_elevations`) and writes each success
   back through the same targeted helper. Resilient (never fails the request), idempotent, no
   `upsert_course`.

## Exact edits

### Edit 1 — new targeted UPDATE helper in `backend/app/services/courses_mapped.py`

Add after `upsert_course` (i.e. after `:393`). NET-NEW; no such helper exists today.

Signature:

    async def update_green_feature_properties(
        course_id: str,
        hole_number: int,
        patch: dict,
    ) -> bool:
        """Merge `patch` into the green feature's JSONB `properties` for one hole.

        Non-destructive single-feature JSONB `||` merge — the OPPOSITE of
        `upsert_course` (which deletes+reinserts every feature). Safe on hot/read
        paths and concurrent with reads. No-op-safe: returns False when the hole
        or its green feature is absent (no row updated), True otherwise. Never
        raises on a missing target; only genuine DB/driver errors propagate to
        the caller's try/except.
        """

Body (single parameterized statement; jsonb merge preserves `featureType` and every other key):

    if not patch:
        return False
    async with async_session() as db:
        result = await db.execute(
            text(
                """
                update public.hole_features hf
                set properties = coalesce(hf.properties, '{}'::jsonb) || cast(:patch as jsonb)
                from public.holes h
                where hf.hole_id = h.id
                  and h.course_id = :course_id
                  and h.hole_number = :hole_number
                  and hf.feature_type = 'green'
                """
            ),
            {
                "course_id": course_id,
                "hole_number": hole_number,
                "patch": json.dumps(patch),
            },
        )
        await db.commit()
    return (result.rowcount or 0) > 0

Notes:
- `feature_type = 'green'` is the normalized column (not `properties.featureType`); `get_course`
  re-injects `featureType` from that column at `:212`, and `upsert_course` sets it from
  `props.get("featureType")` at `:370`. Filtering on the column is correct and index-friendly.
- `||` is a shallow merge: it REPLACES top-level keys named in `patch` and leaves all other
  top-level keys intact. Our patch only ever contains the elevation keys, so `featureType`,
  geometry-derived props, curated hazard props, etc. are never clobbered.
- `json` is already imported at `courses_mapped.py:12`; `text` at `:15`; `async_session` at `:17`.
- If a hole has multiple green features (rare, but `embed_elevation_in_green_features` tolerates it),
  all of them are updated — acceptable and consistent with that function.

Add a small private builder next to the helper (or inline in callers — keep it in ONE place) that
maps a `compute_hole_elevation_profile`-shaped dict to the persisted patch, applying the
`net_change_ft -> delta_ft` alias and the omit-green_slope-when-None rule:

    def _elevation_patch(profile: dict) -> dict:
        patch = {
            "tee_elevation_ft":   profile["tee_elevation_ft"],
            "green_elevation_ft": profile["green_elevation_ft"],
            "delta_ft":           profile["net_change_ft"],
            "plays_like_yards":   profile.get("plays_like_yards", 0.0),
        }
        if profile.get("green_slope") is not None:
            patch["green_slope"] = profile["green_slope"]
        return patch

This is the exact mirror of `embed_elevation_in_green_features:289-299`. Keep it in
`courses_mapped.py` (or a shared spot) so both the request write-back and the precompute use it —
one place, no drift.

### Edit 2 — READ + WRITE-BACK in `backend/app/caddie/course_intel.py`

Change `build_hole_intelligence` signature (add two optional params; both default None so no caller
breaks and no positional callers shift):

    async def build_hole_intelligence(
        hole_coords: dict,
        par: Optional[int] = 4,
        yards: Optional[int] = 400,
        handicap_rating: Optional[int] = 9,
        osm_features: Optional[dict] = None,
        persisted_elevation: Optional[dict] = None,   # NEW: green feature's persisted props
        course_id: Optional[str] = None,              # NEW: enables write-back on live compute
    ) -> HoleIntelligence:

Replace the elevation+slope block (`course_intel.py:62-83`) with a read-first / compute-then-persist
branch. Pseudocode:

    elevation_change = 0.0
    green_slope_data = None

    persisted_hit = (
        persisted_elevation is not None
        and persisted_elevation.get("tee_elevation_ft") is not None
        and persisted_elevation.get("green_elevation_ft") is not None
    )

    if persisted_hit:
        # READ PATH — zero USGS/3DEP. Prefer stored delta_ft; fall back to
        # (green - tee) if delta_ft somehow absent.
        delta = persisted_elevation.get("delta_ft")
        if delta is None:
            delta = persisted_elevation["green_elevation_ft"] - persisted_elevation["tee_elevation_ft"]
        elevation_change = float(delta)
        gs = persisted_elevation.get("green_slope")
        if gs:
            green_slope_data = GreenSlope(
                direction=gs["direction"],
                severity=gs["severity"],
                percent_grade=gs["percent_grade"],
                description=gs["description"],
            )
    else:
        # LIVE COMPUTE — unchanged behavior, plus write-back.
        tee_elev = green_elev = None
        if tee and green:
            tee_elev = await fetch_elevation_cached(tee["lat"], tee["lng"])
            green_elev = await fetch_elevation_cached(green["lat"], green["lng"])
            if tee_elev is not None and green_elev is not None:
                elevation_change = green_elev - tee_elev

        slope_result = await compute_green_slope(green) if green else None
        if slope_result:
            green_slope_data = GreenSlope(
                direction=slope_result["direction"],
                severity=slope_result["severity"],
                percent_grade=slope_result["percent_grade"],
                description=slope_result["description"],
            )

        # WRITE-BACK — only on a genuine compute with BOTH real elevations.
        # Never synthesize 0/None to fill a gap (the "+0ft" lesson): if either
        # endpoint is None, persist nothing (absent stays absent).
        if course_id and tee_elev is not None and green_elev is not None:
            profile = compute_hole_elevation_profile(
                tee_elev, green_elev, slope_result  # slope_result is the raw dict|None
            )
            try:
                await courses_mapped.update_green_feature_properties(
                    course_id, hole_number, courses_mapped._elevation_patch(profile)
                )
            except Exception:  # noqa: BLE001 — persistence is best-effort; never sink intel
                log.warning("elevation write-back failed for hole %s", hole_number, exc_info=True)

    effective_yards = None if yards is None else yards + round(elevation_change / 3)

Keep the rest (`effective_yards`, hazards, the `HoleIntelligence(...)` return) unchanged;
`elevation_change_ft=round(elevation_change, 1)` still holds for both branches.

Imports to add at top of `course_intel.py`:
- `from app.services.elevation import ... compute_hole_elevation_profile` (extend the existing
  `:12` import which already pulls `fetch_elevation_cached, compute_green_slope`).
- `from app.services import courses_mapped`.

Notes:
- `compute_green_slope` returns the raw dict `{direction, severity, percent_grade, description}`
  (course_intel already reads those keys at `:79-82`); it passes straight into
  `compute_hole_elevation_profile` as `green_slope` and is stored as-is — shape matches the persisted
  `green_slope` from `embed_elevation_in_green_features`. No conversion needed.
- Sign convention is consistent everywhere: delta/net_change = green - tee, +uphill.

### Edit 3 — request-time wiring in `backend/app/routes/caddie.py::get_course_intel`

In the existing loop (`caddie.py:1013-1032`), before/at the `build_hole_intelligence` call, look up
the persisted green props from `stored_holes_by_number` (already built at `:1005-1009` — reuse it,
NO second `get_course`):

    stored_hole = stored_holes_by_number.get(hc.get("holeNumber"))   # or resolve after intel
    persisted_elev = _green_persisted_elevation(stored_hole)          # helper below, or None

    intel = await build_hole_intelligence(
        hole_coords=hc,
        par=hc.get("par"),
        yards=hc.get("yards"),
        handicap_rating=hc.get("handicap"),
        osm_features=osm_features,
        persisted_elevation=persisted_elev,
        course_id=owned_session.course_id if owned_session else None,
    )

`stored_holes_by_number` is keyed by hole number; `hc` uses `holeNumber` (see `hole_coords` at
course_intel.py:33/42) — key the lookup by `hc.get("holeNumber")`. (The existing hazard block at
`:1022` keys by `intel.hole_number`, which equals `hc["holeNumber"]`; either is fine — be consistent.)

Add a tiny module-level helper in `caddie.py` (or inline) that pulls the green feature's persisted
elevation subset from a stored hole:

    def _green_persisted_elevation(stored_hole: Optional[dict]) -> Optional[dict]:
        if not stored_hole:
            return None
        feats = (stored_hole.get("features") or {}).get("features") or []
        for f in feats:
            props = f.get("properties") or {}
            if props.get("featureType") == "green" and props.get("tee_elevation_ft") is not None:
                return props   # full props dict; build_hole_intelligence reads only elevation keys
        return None

Write-back note: write-back only fires when `persisted_elev is None` AND `owned_session.course_id`
is set (the branch inside `build_hole_intelligence`). For an anonymous/unowned call
(`owned_session is None`), `course_id` is None → no write-back, read still works if the stored
course happened to be loaded (it isn't when unowned — `stored_holes_by_number` is empty). That's
correct: only owned, mapped rounds persist.

### Edit 4 — precompute BackgroundTask in `backend/app/routes/caddie.py::start_session`

Add the FastAPI dependency and schedule the job (mirror `course_search.py:214/254/334`):

    from fastapi import BackgroundTasks   # add to the fastapi import at caddie.py:3

    @router.post("/session/start")
    async def start_session(
        request: StartSessionRequest,
        background_tasks: BackgroundTasks = None,   # type: ignore[assignment]
        user_id: str = Depends(current_user_id),
    ):
        ...
        # after course_id is resolved (:156-163) and non-None:
        if course_id:
            bg = background_tasks if background_tasks is not None else BackgroundTasks()
            bg.add_task(_precompute_course_elevations, course_id)
        ...

Add the job coroutine in `caddie.py` (module-level). It runs AFTER the response is sent, must never
raise, must not run `upsert_course`, must only sample holes MISSING persisted elevation (idempotent
+ cheap on re-run: if all holes already have elevation, ZERO USGS calls):

    async def _precompute_course_elevations(course_id: str) -> None:
        """Seed per-hole elevation into green-feature properties so the 2nd
        course-intel open shows elevation instantly. Best-effort: never raises."""
        try:
            course = await courses_mapped.get_course(course_id)
            if not course:
                return

            # Build the minimal LineString hole list sample_course_elevations
            # expects (tee = coords[0], green = coords[-1]), deriving tee/green
            # centres from stored polygon features. Only holes MISSING persisted
            # elevation are sampled (idempotent + avoids re-hitting USGS).
            synth_holes: list[dict] = []
            SYNTH_NAME = "precompute"
            for h in course.get("holes", []):
                feats = (h.get("features") or {}).get("features") or []
                green_c = _feature_center(feats, "green")
                tee_c   = _feature_center(feats, "tee")
                if green_c is None or tee_c is None:
                    continue   # absent != zero — cannot sample; skip
                if _green_persisted_elevation(h) is not None:
                    continue   # already persisted — idempotent skip
                synth_holes.append({
                    "type": "Feature",
                    "properties": {"course_name": SYNTH_NAME, "ref": h["number"]},
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [
                            [tee_c[0],   tee_c[1]],     # [lng, lat] tee   -> coords[0]
                            [green_c[0], green_c[1]],   # [lng, lat] green -> coords[-1]
                        ],
                    },
                })

            if not synth_holes:
                return   # nothing to do — zero USGS calls

            profiles = await sample_course_elevations(synth_holes, SYNTH_NAME)  # 2 batched calls
            for hole_number, profile in profiles.items():   # omit-on-missing already applied
                try:
                    await courses_mapped.update_green_feature_properties(
                        course_id, hole_number, courses_mapped._elevation_patch(profile)
                    )
                except Exception:
                    log.warning("precompute write-back failed hole %s", hole_number, exc_info=True)
        except Exception:
            log.warning("elevation precompute failed course=%s", course_id, exc_info=True)

Add `_feature_center` helper in `caddie.py` reusing `_ring_centroid`:

    from app.services.course_spatial import _ring_centroid

    def _feature_center(feats: list[dict], feature_type: str) -> Optional[tuple[float, float]]:
        """(lng, lat) centre of the first feature of `feature_type`, or None."""
        for f in feats:
            if (f.get("properties") or {}).get("featureType") != feature_type:
                continue
            geom = f.get("geometry") or {}
            coords = geom.get("coordinates")
            gtype = geom.get("type")
            try:
                if gtype == "Point":
                    return (coords[0], coords[1])
                if gtype == "Polygon":
                    lon, lat = _ring_centroid(coords[0])
                    return (lon, lat)
                if gtype == "MultiPolygon":
                    lon, lat = _ring_centroid(coords[0][0])
                    return (lon, lat)
            except (TypeError, IndexError, KeyError):
                return None
        return None

Imports to add in `caddie.py`:
- `from fastapi import BackgroundTasks` (extend line 3).
- `from app.services.elevation import sample_course_elevations`.
- `from app.services.course_spatial import _ring_centroid`.
- `courses_mapped` already imported at `:43`.

Note the coord convention: `sample_course_elevations` reads `coords[0]=(lat=coord[1], lng=coord[0])`
tee and `coords[-1]` green (elevation.py:445-450), i.e. GeoJSON `[lng, lat]`. `_ring_centroid`
returns `(lon, lat)` (course_spatial.py:295) — so store `[center[0], center[1]] = [lng, lat]`.
Matches.

## Edge cases & concurrency

- Absent != zero (THE rule): write-back and precompute persist a hole ONLY when a real compute
  produced tee AND green elevations. `sample_course_elevations` already omits holes where either
  endpoint is None; the request path guards `tee_elev is not None and green_elev is not None`. A
  genuine 0.0 delta from two real elevations is fine and IS written; we never synthesize 0/None.
- No-op-safe writes: `update_green_feature_properties` updates 0 rows (returns False) when the hole
  or its green feature is absent — never raises, callers ignore the bool.
- Merge, don't clobber: `properties || :patch` preserves `featureType` and every non-elevation key;
  patch only carries elevation keys.
- Concurrency: request-path holes are awaited sequentially (`get_course_intel` loops one await at a
  time) — no intra-request write contention. The precompute job and a concurrent `get_course_intel`
  write-back could both target the same green row; the `||` merge is idempotent and last-writer-wins
  on identical values, so races are benign (no lost non-elevation keys, no torn shape). We do NOT
  hold a transaction across holes. Precompute skips already-persisted holes, shrinking the overlap.
- upsert_course collision: NEVER call `upsert_course` here. It would DELETE all features for a hole
  mid-round and race the reads at `caddie.py:1006-1009`. The targeted UPDATE is the only writer.
- Read-path staleness: if persisted `delta_ft` is present but `green_elevation_ft`/`tee_elevation_ft`
  are not (older/partial blob), `persisted_hit` is False → we recompute live (and re-persist the
  full shape). Self-healing.
- Multi-course facilities: precompute synthesizes its own `course_name` (`"precompute"`) on every
  synth hole and passes it as `target_course_name`, so `sample_course_elevations`' name filter always
  matches — no dependence on the OSM sub-name.
- BackgroundTasks lifecycle: `bg.add_task` runs after the response is returned (Starlette). If FastAPI
  didn't inject `background_tasks` (e.g. a direct unit call), `bg = BackgroundTasks()` is created but
  its task won't auto-run — acceptable; production always injects it. Guarded exactly like
  `course_search.py:254`.

## No shared-type / migration changes (confirmed)

- No Alembic/SQL migration: elevation lives in the existing `hole_features.properties jsonb`. Verified
  the column exists and defaults `'{}'` (`001_course_mapping_schema.sql:60`, do-not-touch/guarded).
- No `frontend/src/lib/types.ts` change: no frontend change; the course-intel response
  (`HoleIntelligence.model_dump()`) shape is unchanged (`elevation_change_ft`, `effective_yards`,
  `green_slope`, `hazards`). Read/write both flow through the existing green-feature `properties`
  blob, which the frontend never types directly here.
- No `backend/app/models.py` change: the persisted fields already exist in the JSONB blob; no new
  Pydantic/ORM field. `HoleIntelligence` (`app/caddie/types.py`) gains NO new field — the two new
  `build_hole_intelligence` params are function args, not response fields.

## Out of scope (explicit)

- NO Alembic/SQL migration; NO edit to `backend/supabase/migrations/**` (guarded).
- NO frontend change; NO `types.ts` / `models.py` / `caddie/types.py` field change.
- NO use of `upsert_course` on the request or precompute path (destructive delete+reinsert).
- NO change to `sample_course_elevations` / `compute_hole_elevation_profile` /
  `embed_elevation_in_green_features` internals — REUSE them as-is.
- NOT wiring precompute into any path other than `/session/start`.

## Tests (new) — mapped to files

Follow the existing DB-stub pattern (`tests/test_hole_elevation_ingest.py:1-40`:
`sys.modules.setdefault("app.db...", MagicMock())` when `DATABASE_URL` unset) and the monkeypatch
style of `tests/test_course_intel_resilience.py`.

(a) READ cache-HIT skips USGS/slope entirely — `tests/test_course_intel_static_read.py` (NEW):
    monkeypatch `course_intel.fetch_elevation_cached`, `course_intel.compute_green_slope`, and
    `elevation.fetch_3dep_samples` to fail/record; call `build_hole_intelligence` with
    `persisted_elevation={tee_elevation_ft, green_elevation_ft, delta_ft, green_slope}`; assert none
    were called and `intel.elevation_change_ft`/`green_slope`/`effective_yards` come from persisted
    values.

(b) Write-back round-trip (compute -> targeted UPDATE -> get_course returns fields) —
    `tests/integration/test_course_intel_write_back.py` (NEW, DB-backed, CI only): upsert a course
    with a green feature and no elevation; monkeypatch elevation fetchers to return fixed tee/green;
    call `build_hole_intelligence(..., course_id=..., persisted_elevation=None)`; assert
    `get_course` now returns `tee_elevation_ft/green_elevation_ft/delta_ft/plays_like_yards` on the
    green feature.

(c) Absent-vs-zero — `tests/test_course_intel_static_read.py` (NEW, non-DB): with
    `fetch_elevation_cached` returning None for the green (or tee), assert
    `update_green_feature_properties` is NOT called (monkeypatch it to raise/record) and elevation
    stays honest (no write). Also assert `_elevation_patch` omits `green_slope` when None.

(d) Precompute/backfill — `tests/integration/test_session_precompute.py` (NEW, DB-backed, CI only):
    upsert a course with green+tee polygons and no elevation; monkeypatch `sample_course_elevations`
    (or `fetch_3dep_samples`) to return a fixture map; run `_precompute_course_elevations(course_id)`;
    assert every computable hole's green feature now carries elevation and a hole whose fixture omits
    it stays absent. A non-DB variant asserts synth-hole construction skips holes lacking a tee/green
    feature and skips holes already carrying persisted elevation (zero-sample early return).

(e) Targeted UPDATE merges + no-op when green absent —
    `tests/integration/test_green_feature_update.py` (NEW, DB-backed, CI only): seed a green feature
    with an unrelated `properties` key (e.g. `{"featureType":"green","curated":true}`); call
    `update_green_feature_properties` with an elevation patch; assert `curated` and `featureType`
    survive and elevation keys were added; call it for a hole with no green feature and assert it
    returns False and raises nothing.

Unit tests (a)/(c) and the non-DB half of (d) run locally (DB-stubbed). DB-backed (b)/(d)/(e) run
in CI — do NOT spin up local Postgres.

## Verification contract (gates)

- `cd backend && ruff check .` — must pass.
- Backend unit tests locally: `cd backend && python -m pytest tests/test_course_intel_static_read.py
  tests/test_course_intel_resilience.py tests/test_elevation_profile.py -q` (non-DB).
- DB-backed integration tests (b/d/e) run in CI (no local Postgres — do not launch a container).
- Frontend regression sanity per house rules (no frontend change expected):
  `cd frontend && npx tsc --noEmit` and `cd frontend && npx tsx voice-tests/runner.ts --smoke`.

## Critical files

- backend/app/services/courses_mapped.py  (new `update_green_feature_properties` + `_elevation_patch`)
- backend/app/caddie/course_intel.py       (read-first + write-back in `build_hole_intelligence`)
- backend/app/routes/caddie.py             (route wiring, `start_session` BackgroundTask, precompute job)
- backend/app/services/elevation.py        (reuse `sample_course_elevations` / `compute_hole_elevation_profile`)
- backend/tests/test_course_intel_static_read.py + integration tests (new)
