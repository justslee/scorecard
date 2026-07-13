# S4f — Coverage flywheel: honest-empty telemetry → probe feed, coverage metric, re-probe sweep, schema-drift canary (plan)

*Backlog id `teetime-s4f-coverage-flywheel` (status: ready, "bundle-rider" sized). Parent plan: `specs/teetime-availability-everywhere-plan.md` §2b (probe pipeline + cache discipline), §8 S4f bullet, §9 (schema-drift canary, "no live hits in CI, ever"). Backend/ops-only, SILENT: zero user-facing surface, zero behavior change to search results — the only change to the search path is one fire-and-forget side-effect record.*

**Conformance note:** the parent plan prescribes exactly this slice (§8: "capability auto-probe on honest-empty telemetry → feed the probe script, '% of searched courses returning real availability' metric, monthly re-probe sweep, schema-drift canary"; §2b: "re-probe cadence: breaker feedback + a monthly manual sweep — never re-probe per search"; §9: "a manual/scheduled canary probe re-runs one live fetch per engine and diffs the shape against the fixture"). No deviations from the parent plan are needed. One packaging refinement vs. the brief's default: the report/sweep/canary modes go in a **sibling script** (`coverage_flywheel.py`) that imports the probe pipeline, rather than modes bolted onto `probe_booking_capability.py` — justified in §6.

**Migration verdict: NO Alembic migration.** Parent plan §2a (line ~63) explicitly defers a DB table until rows > ~100 / transactional needs; the telemetry store is one bounded JSON file under `backend/data/`, same injectable file-backed pattern as `availability_call_cache.py` / `search_cache.py` / `capability_store.py`. Nothing here needs transactions or cross-process write contention beyond what the sibling stores already tolerate. No STOP-for-owner-approval required.

---

## 1. Telemetry seam — outcome enum + fire-and-forget recording

### 1a. Seam

`RoutedTeeTimeProvider._slots_for_course` in `backend/app/services/tee_times/router_provider.py`. Its return points already classify every per-course outcome; we record the classification, changing nothing else. Exact mapping (current line refs):

| Branch (today) | Outcome recorded |
|---|---|
| `not self._foreup_enabled` early return (line ~176) | **nothing** — kill switch reverts to byte-identical S0; telemetry of a disabled system would poison the metric |
| capability lookup raised → `cap = None` fallback (line ~183) | **nothing** — internal failure, not a coverage fact |
| `cap is None` (line ~186) | `"no_capability"` — **this is deliverable 1's probe-feed queue** |
| `cap.is_private` (line ~191) | `"private"` |
| `adapter is None` or engine not in `TEETIME_ENGINES` (line ~194) | `"no_adapter"` — capability known, engine unimplemented/disabled; NOT probe-feed (probing can't help), reported separately |
| `real_slots` non-empty (line ~212) | `"real_availability"` |
| `real_slots == []` (line ~215) | `"verified_empty"` |
| `real_slots is None` → degraded route entry (line ~220) | `"couldnt_check"` |

Enum: `SearchOutcome = Literal["real_availability", "verified_empty", "couldnt_check", "no_capability", "no_adapter", "private"]`.

Record **before** the `_with_availability_cache` voice overlay on the two S0-fallback branches: the capability gap is the fact the flywheel needs, regardless of whether a prior phone call papered over it. `platform` (from `cap.platform`, else `None`) is recorded alongside so the report can break down `couldnt_check` per engine.

### 1b. Fire-and-forget mechanism

Add to the constructor: `telemetry: SearchTelemetryStore | None = None`, defaulting to the **module-level singleton** `default_search_telemetry_store()` in the new store module (NOT a per-instance `FileSearchTelemetryStore()` — `routes/tee_times.py:_get_provider()` constructs `RoutedTeeTimeProvider()` per request, so per-instance state would defeat in-memory dedup/debounce; the module-singleton pattern is already used for `_limiter`/`_breaker` in `adapters/teeitup.py` and `_search_cache` in `routes/tee_times.py`).

Recording helper in the router — the entire invariant lives here:

```python
def _record_outcome(self, course: dict, outcome: SearchOutcome, platform: str | None = None) -> None:
    """Fire-and-forget: NEVER raises, never awaits, never alters the result."""
    try:
        self._telemetry.record(course, outcome, platform=platform)
    except Exception:
        log.debug("search_telemetry: record failed (ignored)", exc_info=True)
```

Mechanism choice: **synchronous in-memory dict update + debounced opportunistic file flush** (flush at most once per 30 s, plus immediately when a *new* course key appears — new courses are the valuable probe-feed signal; count bumps can wait a window). Justification against the sibling patterns: the existing adapters already perform synchronous JSON file writes on the search hot path (`FileSearchCacheStore.set` → `write_text`, called from every cache-miss `_fetch_day`), so a *debounced, smaller* write is strictly cheaper than what the path already tolerates; an async task would add lifecycle/leak complexity for no measurable win and no sibling precedent. Every file op inside the store is itself wrapped (`_save` failure logged + swallowed) so the router-level `try/except` is belt-and-suspenders.

No changes to `routing.py`, `routes/tee_times.py`, adapters, or any response shape. Note for the metric docs: searches served from the 15-min route-level search cache never reach `_slots_for_course`, so telemetry counts provider-executed searches — fine for an ops metric, stated honestly in the report header.

## 2. Store module — `backend/app/services/tee_times/search_telemetry.py`

Mirrors `availability_call_cache.py`: abstract store + file-backed impl + dataclass records, module docstring carrying the invariants.

```python
SearchOutcome = Literal["real_availability", "verified_empty", "couldnt_check",
                        "no_capability", "no_adapter", "private"]

@dataclass(frozen=True)
class SearchedCourseRecord:
    course_id: str                     # dedup key: discovery-namespaced id (course["id"] or ["osm_id"])
    name: str
    lat: float | None                  # from course["center"] when present
    lng: float | None
    website: str | None                # course identity attrs already on the discovery dict —
    phone: str | None                  #   required so the sweep can fingerprint WITHOUT Google Places
    outcome_counts: dict[str, int]     # per-outcome cumulative counts
    latest_outcome: str                # latest-outcome semantics (edge-case §9)
    latest_platform: str | None        # cap.platform at last record, when a cap matched
    first_seen: str                    # ISO-8601 UTC
    last_seen: str

class SearchTelemetryStore:            # abstract, injectable
    def record(self, course: dict, outcome: SearchOutcome, *, platform: str | None = None) -> None: ...
    def all_records(self) -> tuple[SearchedCourseRecord, ...]: ...

class FileSearchTelemetryStore(SearchTelemetryStore):
    # path=backend/data/search_telemetry.json (gitignored via backend/data/*),
    # now_fn + clock injectable, flush_interval_s=30, max_courses=500
```

- **Dedup key** = `course_id` (one record per distinct course, counters bumped in place — the file grows with *distinct courses searched*, not per-search appends).
- **Bounded growth**: hard cap `MAX_COURSES = 500`; on overflow evict smallest `last_seen` at flush time. 500 records × ~300 bytes ≈ 150 KB worst case. Flush also prunes malformed entries (fail-soft load, same as `_load` in the siblings).
- File shape: `{"courses": {"<course_id>": {record fields}}}`; lazy first read merges existing file into memory, `record()` updates memory + debounced `_save`, `all_records()` re-reads the file and overlays memory (the report script runs in a different process — it reads the file the server flushed).
- **No PII**: course id/name/geo/website/business phone only — all attributes of a golf course, none of the searcher. No query text, no user id, no timestamps finer than first/last seen.
- Also in this module, the **pure metric function** (`coverage_summary(records) -> CoverageSummary`) so metric math is unit-testable without any file (§3).

## 3. Coverage metric — precise definition + where it's read

Computed from the same telemetry records, **latest-outcome semantics** (a course that later gains a capability row and returns real slots flips buckets on its next search).

- **Denominator** = distinct recorded courses with `latest_outcome != "private"` (private courses are excluded by design and can never count for or against coverage).
- **Primary — "coverage %"** = |latest_outcome ∈ {`real_availability`, `verified_empty`}| ÷ denominator. Rationale: the owner's ask is *fetchability* ("FETCH tee times regardless of the course"); a genuinely sold-out day is a successfully fetched real answer, and counting it as a miss would make the metric noise with demand.
- **Secondary — "strict %"** = |latest_outcome == `real_availability`| ÷ denominator (printed alongside, labeled).
- Full per-outcome breakdown + per-platform `couldnt_check` counts printed with both.

**Read via** `uv run backend/scripts/coverage_flywheel.py report` (no dashboard, no API route). Output: summary block (distinct courses, coverage %, strict %, breakdown) + the **probe-feed queue**: `no_capability` courses sorted by total search count desc, with name/lat/lng/website/phone and a ready-to-paste `probe_booking_capability.py` command line per row. `--json` flag for machine consumption. Report-side (not store-side) coalescing of name-variant duplicates: rows whose `private_filter.normalize(name)` match AND haversine ≤ 1.0 mi (reuse `capability_store.MATCH_RADIUS_MILES` + `_haversine_miles`) are folded, counts summed — display concern only, store stays keyed by `course_id`.

## 4. Schema-drift canary

### 4a. Pure, CI-testable drift function — `backend/app/services/tee_times/schema_canary.py`

Reuses each adapter's **own** pure parse layer (never duplicates parsing): `foreup._normalize_day`, `adapters/teeitup._normalize_day`, `adapters/chronogolf._normalize_day`, `adapters/clubprophet._normalize_day`, `adapters/quick18._parse_matrix`.

```python
@dataclass(frozen=True)
class CanaryResult:
    platform: str
    healthy: bool
    reason: str          # "" | "non-json" | "top-level-shape" | "no-entries" | "implausible: ..."
    entries: int         # normalized day-dicts observed

def check_shape(platform: str, raw_body: bytes, *, query_date: str,
                party_size: int = 1, expect_nonempty: bool = False) -> CanaryResult: ...
```

Three checks, in order — **"drift" is precisely any of**:
1. **Top-level shape guard** mirroring each adapter's `_do_fetch` guards (the exact conditions that make the adapter return `None`): body not JSON; teeitup → not a list or an *empty* list (teeitup.py line ~407 treats empty top-level array as drift, not empty day); foreup/chronogolf/clubprophet → their respective expected top-level containers (builder: transcribe from each `_do_fetch`, do not invent); quick18 → `_parse_matrix` returns `None` (parse raised or `saw_table` false).
2. **Plausibility pass** over the normalized day dicts (the §9 "plausible ranges" guard, centralized here): `time` parses as `%H:%M`; `players` int in 1–8; `price_usd` is `None` or `0 < p < 2000`; `holes ∈ {9, 18}`. Any violation → drift with the offending field in `reason`.
3. **`expect_nonempty=True`** (fixture mode against a known-good *non-empty* capture): zero normalized entries → drift — this is what catches a renamed key that the skip-tolerant `_normalize_day`s silently drop (e.g. `teetimes` → `teeTimes` yields 0 entries, not an exception).

`query_date` is supplied by the caller and, in tests, **derived from the fixture** (same pattern the existing adapter tests use, e.g. `test_tee_time_teeitup.py`) — never hardcoded against a live clock.

### 4b. CI-safe unit test — `backend/tests/test_tee_time_schema_canary.py`

Zero network, pure function on bytes. Per engine: (a) the existing checked-in good fixture (`foreup_18mile_times.json`, `teeitup_golfnyc_times.json`, `chronogolf_rockspring_times.json`, `clubprophet_harborlinks_times.json`, `quick18_searchmatrix_times.html`) → `healthy=True, entries>0`; (b) mutated copies built in-test (rename the entries key, e.g. `"teetimes"`→`"tt"`; wrap the array in an object; set an implausible `maxPlayers=999`; truncate the HTML table) → `healthy=False` with the right `reason`; (c) `expect_nonempty` distinguishes a good *empty* capture (`teeitup_empty.json` fixture ⇒ actually drift for teeitup per rule 1 — assert that; `clubprophet_harborlinks_empty.json`/`quick18_searchmatrix_empty.html` ⇒ healthy with `entries=0` when `expect_nonempty=False`). Builder: use whichever good/empty fixtures actually exist in `backend/tests/fixtures/`; adapt fixture names to reality, keep the good-vs-drifted assertion structure.

### 4c. Live canary entrypoint — `coverage_flywheel.py canary` (manual/cron only)

- **Known-good course per engine** = configured, never guessed: the curated seed rows. Selection rule: per platform in `ADAPTERS`, the seed row (from `foreup_ny_seed.json` + `booking_capabilities_seed.json`) carrying an optional additive `"canary": true` marker, else the first `probe_status == "verified"` seed row. (Extra JSON keys are ignored by `_parse_generalized_row`, so the marker is a zero-risk data-only change; the slice adds `"canary": true` to one existing row per platform.)
- One live fetch per engine, sequential, `asyncio.sleep(6)` between engines (≤10 rpm global), 8 s timeout, `fetch_discipline.USER_AGENT`, date = today+3 (probe script's default). For foreup/teeitup/chronogolf/quick18 the script builds the request via the adapter's exported `build_times_request`/`_searchmatrix_url` and runs `check_shape` on the raw body (precise drift reason + `--capture-fixture`-style optional re-capture of the body). Clubprophet's three-step token dance is not duplicated: its canary calls `ClubProphetProvider(cache=<in-memory no-op>).slots_for_capability(...)` and flags `None` as "couldn't check (drift or transient — inspect)" — honest, lower resolution, no logic duplication.
- Output: per-engine `PASS` / `DRIFT(<reason>)` lines; **exit code 1 if any engine drifted** (cron-friendly). Report-only — it mutates no store, no capability row (seed rows are checked-in and must not be script-mutated). Docs in the script docstring: suggested cadence monthly, alongside the sweep; scheduling itself is ops/owner, not this slice.

## 5. Monthly re-probe sweep — `coverage_flywheel.py sweep` (manual/cron only)

Reads the demand-driven queue and re-probes through the **existing** probe pipeline (imports `probe_booking_capability`'s `fingerprint_website`, `probe_foreup`/`probe_teeitup`/`probe_chronogolf`, `_build_record`, `_upsert_record`, `_load_courses` — scripts dir added to `sys.path`, hand-run only, never imported by tests; use the actual function names as they exist in the script):

1. **Queue** = telemetry records with `latest_outcome == "no_capability"`, sorted by total search count desc then `last_seen` desc; **plus** staleness pass: rows in `booking_capabilities_validated.json` with `probe_status ∈ {"stale","failed"}` or `verified_at` older than `--stale-days` (default 30). Seed-file rows are never touched.
2. **Bounds + politeness**: `--limit` (default 10) courses per run; strictly sequential; `asyncio.sleep(6)` between courses; every fetch inherits the probe pipeline's honest UA + 8 s timeout; `--dry-run` prints intended probes and writes nothing. A course with no `website` in telemetry and no phone is skipped with a note (nothing to fingerprint — **no Google Places lookup on this path, ever**); website-less but phone-known courses get the probe script's existing `phone_only` row treatment.
3. Successful probes upsert into `booking_capabilities_validated.json` exactly as the probe script does today; the next real search then matches a capability and the course's `latest_outcome` flips — closing the flywheel. The sweep itself never writes telemetry.
4. **Bright lines restated in the script docstring + enforced by construction**: no CAPTCHA solving, no fingerprint/UA spoofing, no login (all inherited — the probe pipeline has none of these); GolfAPI and Google Places are simply never imported here (review invariant + docstring; no import of `app.services.golfapi*` or `app.services.course_finder` in `coverage_flywheel.py`).

## 6. Script packaging decision

**Sibling script `backend/scripts/coverage_flywheel.py`** with argparse **subcommands `report | sweep | canary`**, importing `probe_booking_capability` for the pipeline, rather than adding modes to the probe script. Justification: `probe_booking_capability.py`'s CLI has `--name` as a required top-level arg and its exact invocations are documented in specs/usage strings — retrofitting subparsers would break the documented contract or force awkward mode flags; a sibling keeps the probe script byte-identical (zero regression risk on the S4c deliverable) while reusing 100% of its pipeline code. Same "never imported by tests, never run in CI" rule, stated in the module docstring.

## 7. Shared types

**None.** No API route, no response-model change, no `backend/app/models.py` change, no `frontend/src/lib/types.ts` change. `TeeTimeSlot` untouched. Confirmed: this slice's only app-code surface is `router_provider.py` (side-effect record), two new service modules, one new script, and a `"canary": true` marker on existing seed rows.

## 8. Gates

- `cd backend && uv run ruff check .` (CI pins ruff in the dev group).
- New unit tests (all DB-free, all network-free):
  - `backend/tests/test_tee_time_search_telemetry.py` — store: dedup by course_id; counter accumulation; latest-outcome flip (`no_capability` → `real_availability` after a capability appears); first/last_seen; `max_courses` eviction (oldest `last_seen`); debounced flush (injected `now_fn`: two records inside the window ⇒ one `_save`; new-course record ⇒ immediate flush); file round-trip via `tmp_path`; fail-soft on malformed file; **metric math**: `coverage_summary` numerator/denominator/private-exclusion/strict-vs-primary on hand-built record sets.
  - `backend/tests/test_tee_time_router_telemetry.py` — the fire-and-forget invariant: `RoutedTeeTimeProvider(telemetry=RaisingStore())` returns **exactly** the same slots as `telemetry=NoopStore()` for every branch (no-cap, private, real, `[]`, `None`, disabled engine) — reuse the fake-finder/FakeForeUp scaffolding from `test_tee_time_router.py`; plus a RecordingStore asserting the exact outcome enum recorded per branch and that the kill-switch path records nothing.
  - `backend/tests/test_tee_time_schema_canary.py` — §4b.
- **DB-backed tests: none** (file store, no migration) — confirmed. CI's backend gate (ruff + full pytest incl. `tests/integration/` with its Postgres service) runs unchanged; locally run `uv run ruff check . && uv run pytest --ignore=tests/integration` (no local Postgres).
- Scripts are never imported by tests and never run in CI (existing convention, restated in docstrings).

## 9. Edge cases + risks

- **Telemetry write failure is swallowed twice** (store-internal `_save` try/except + router `_record_outcome` catch-all); the RaisingStore test pins it.
- **No latency risk**: sync dict update + ≤1 debounced small-file write per 30 s — strictly less I/O than the availability caches already do per cache-miss on the same path.
- **Unbounded growth**: impossible by construction — one record per distinct course, 500-record cap with LRU-by-last_seen eviction, prune on flush.
- **Latest-outcome semantics**: a course that gains a capability row (via the sweep or hand-probe) flips its bucket on the next search; counts are cumulative but the metric reads only `latest_outcome`.
- **Name-variant dedup**: store keys by `course_id` (stable per discovery source); cross-source duplicates (gplaces vs OSM id for the same course) are coalesced in the report via normalized-name + ≤1 mi, never merged destructively in the store.
- **Search cache masking**: route-level 15-min cache hits bypass `_slots_for_course` → telemetry undercounts raw searches; documented in the report header, irrelevant to distinct-course coverage.
- **No PII** (§2); no GolfAPI, no Google Places anywhere on the flywheel path; probes bounded (`--limit`, sleep, timeout) and honest-UA; canary is 1 request/engine/run.
- **Search path byte-identical**: no return value changes anywhere; reviewer checklist = diff of `_slots_for_course` shows only added `self._record_outcome(...)` lines + constructor param.
- **Risk — two processes writing `search_telemetry.json`** (multi-worker deploy): last-write-wins can drop a counter bump; acceptable for an ops metric (same posture as every sibling file store), noted in the module docstring; the >~100-rows-→-DB rule from §2a is the escalation path.
- **Risk — canary false alarms** on a transient upstream blip: mitigated by the exit-code-only contract (cron re-run) and the clubprophet "drift or transient" honest wording.

## 10. Implementation order

1. `search_telemetry.py` (store + `coverage_summary` + module singleton) + its test file.
2. `router_provider.py` wiring (`telemetry` param, `_record_outcome`, six record points) + fire-and-forget/branch tests.
3. `schema_canary.py` (`check_shape` reusing adapter parsers) + canary tests; add `"canary": true` to one seed row per platform.
4. `scripts/coverage_flywheel.py` (`report`, `sweep`, `canary` subcommands) — docstring carries the cron/cadence + bright-line docs.
5. Gates: ruff + pytest; hand-run `coverage_flywheel.py report` on an empty store (prints zeros honestly) and `canary --dry-run`-style smoke without network where possible.

### Critical Files for Implementation
- `backend/app/services/tee_times/router_provider.py` — the telemetry seam (`_slots_for_course` branch classification + fire-and-forget hook)
- `backend/app/services/tee_times/availability_call_cache.py` — the injectable file-backed store pattern the new `search_telemetry.py` mirrors
- `backend/scripts/probe_booking_capability.py` — the probe pipeline the sweep imports; `coverage_flywheel.py` is its sibling
- `backend/app/services/tee_times/adapters/teeitup.py` — reference `_normalize_day` + `_do_fetch` shape guards the canary reuses (same pattern in foreup.py, chronogolf.py, clubprophet.py, quick18.py)
- `backend/app/services/tee_times/capability_store.py` — seed/validated loading, dedup key, `MATCH_RADIUS_MILES`, and the no-migration precedent
