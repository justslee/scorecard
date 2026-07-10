# Plan — Wire `TeeTimeQuery.course_ids` into the real tee-time path (`teetime-course-ids-not-wired-real-provider`, P3)

_Fable implementation plan (2026-07-09, eng-lead cycle 48). Contract for the builder — implement exactly; do not re-plan._

## 0. Verified ground truth (do not re-derive)

- `GET /api/tee-times/search` (`backend/app/routes/tee_times.py:236,247`) parses `courseIds` CSV → `SvcQuery(course_ids=[c.strip() for c in courseIds.split(",")])`. **Bug within the bug:** `",".split(",") → ["",""]` produces a non-empty list of empty strings (a legacy/edge client sending `courseIds=","` would, after this fix, filter everything out). Guard required (§3.1).
- `RoutingTeeTimeProvider.search_availability` (`backend/app/services/tee_times/routing.py:181–209`) discovers by area only, builds `course_id = str(course.get("id") or course.get("osm_id") or "")` (line 192, mirrored at 97 in `build_route_entry`), and never consults `query.course_ids`. `RoutedTeeTimeProvider` (`router_provider.py:45`) inherits this loop and only overrides `_slots_for_course` — a filter in the base loop covers routing, router, and the foreUP capability path.
- The MAX_COURSES cap (`routing.py:191`, `courses[:MAX_COURSES]`, MAX=8) is applied **before** the loop — a selection filter must run **before the cap**, or a selected course ranked 9th-nearest silently vanishes.
- `search_golf_courses` (`backend/app/services/osm.py:450–460`) returns dicts keyed **`osm_id`** (`"way/123"` / `"relation/123"`), **no `id` key**. Confirmed.
- `/api/courses/nearby` (`backend/app/routes/course_search.py:391–426`) returns those dicts **RAW** — it never calls `attach_stable_ids` (only `/api/courses/search` does, at `course_search.py:346`). So the frontend OSM-leg mapping `id: c.id` (`frontend/src/lib/golf-api.ts:873`) is **genuinely `undefined` at runtime**. Confirmed. (The existing tests `golf-api-nearby.test.ts` never caught this because they fake an `id` key the real backend never sends.)
- Runtime consequence today: `selectedCourses.map(c => c.id)` (`page.tsx:844`) for OSM-leg rows yields `[undefined,…]`; `client.ts:61` `join(",")` renders `undefined` as empty string → `courseIds=""` (falsy → `course_ids=[]`, accidental no-op) or `","` for multiple (→ `["",""]`, the §3.1 hazard). Also latent frontend bugs: duplicate React keys `key={c.id}` (`page.tsx:711,722`) and `toggleCourse(c.id)` (`page.tsx:467–470`) toggling **all** OSM rows together, since every OSM row shares `id === undefined`.
- Identity helpers already exist and are pure: `course_finder.deterministic_course_id(key)` = SHA-1 UUID of `"golfapi:{key}"` (`course_finder.py:194–200`), `external_course_key(course)` → `"osm-{osm_id}"` or the namespaced id (`course_finder.py:203–213`). Write-through rows (`external_course_rows`, `course_finder.py:229–250`) and `attach_stable_ids` search hits use exactly these keys — so a mapped row created by search write-through has `id == deterministic_course_id("osm-way/N")`.
- Homegrown fully-ingested mapped courses use **slug** keys (e.g. `"osm-bethpage-black"`, `osm_ingest.py:217`) — their UUIDs are **not** derivable from any discovery dict. Id matching alone can never reconcile them; only name+proximity can.
- Name/proximity machinery already exists: `private_filter.normalize` (`private_filter.py:85`, exact-equality normalizer) and `MATCH_RADIUS_MILES = 1.0` (`capability_store.py:47`), used the same way by `match_capability` (`capability_store.py:151–184`).
- Cache: `query_cache_key` includes `"ids": sorted(query.course_ids)` (`search_cache.py:43`); mock's cache key likewise (`mock.py:75`). Different selections already produce different cache entries — no cross-contamination.
- Mock semantics to mirror: empty `course_ids` = all courses (`mock.py:119`).
- The tee-time page's `area` is **always** `"lat,lng"` or null (`page.tsx:155,211`). Place-name areas reach the backend only from other callers; on this page the real discovery leg is OSM.

## 1. ID-provenance truth table

Selected-id value (what `CourseOption.id` / `courseIds` carries) vs routing discovery `course_id`:

| Selection source | Selected id today | Selected id after fix | Discovery id, lat,lng area (OSM) | Discovery id, place-name area | Match after this plan |
|---|---|---|---|---|---|
| Mapped leg, search write-through row | `det_uuid("osm-way/N")` / `det_uuid("gplaces-P")` UUID | unchanged | `"way/N"` | `"gplaces-P"` / `"way/N"` | via **deterministic-UUID candidate** (§3.3) |
| Mapped leg, homegrown-ingested row (slug key) | `det_uuid("osm-<slug>")` UUID | unchanged | `"way/N"` | `"gplaces-P"` / `"way/N"` | via **name+proximity selector** (§3.4) |
| OSM leg `/api/courses/nearby` | **`undefined`** | **`"way/N"`** (frontend fix §4; backend `/nearby` also gains `attach_stable_ids` → `det_uuid("osm-way/N")`, either shape matches) | `"way/N"` | `"gplaces-P"` / `"way/N"` | **direct osm_id or det-UUID candidate** |
| Add-sheet `/api/courses/search`, OSM hit | `det_uuid("osm-way/N")` | unchanged | `"way/N"` | — | det-UUID candidate |
| Add-sheet, Places hit | `"gplaces-P"` | unchanged | `"way/N"` | `"gplaces-P"` | direct in place-name; name+proximity in lat,lng |

Without this plan, **no cell matches reliably** — a naive `course_id in query.course_ids` filter returns zero for every real selection. That is the regression this plan makes impossible.

## 2. Approach (decision summary)

1. **Filter in the base provider loop, pre-cap** (`routing.py`) — covers routing, router, and foreUP; mock untouched; empty `course_ids` = all (mock parity).
2. **Match against a candidate-id set per discovered course** — `{course["id"], course["osm_id"], deterministic_course_id(external_course_key(course))}` — not the single built `course_id`. Works for OSM ids, Places ids, and every write-through UUID with zero DB work.
3. **Resolve selected UUIDs to name+center selectors** (one small DB lookup in the route) and fall back to **name+proximity matching** (reusing `normalize` + `MATCH_RADIUS_MILES`) — rescues homegrown-mapped selections (the owner's favorited home course, the *default pre-selected* case via `toCourseOptions` favorite pre-selection) and cross-area-kind selections.
4. **Fix the OSM-leg id at both ends**: `/api/courses/nearby` gains `attach_stable_ids` (unifies ids with `/api/courses/search`, makes favorites match across surfaces) and the frontend maps `id: c.id ?? c.osm_id` (covers old cached backend responses mid-deploy).
5. **Honesty posture**: a selection that cannot be reconciled with anything actually discovered is **dropped** — never a fabricated route entry for a course we didn't verify exists nearby. Zero results is the honest answer; log it, do NOT fail open.
6. **No wire/shared-shape change**: `courseIds` already exists in `frontend/src/lib/teetime/types.ts:18` and the route param; `types.ts` ↔ `models.py` untouched. The new `course_selectors` field is backend-internal on the `TeeTimeQuery` dataclass only.

## 3. Backend edits (exact)

### 3.1 `backend/app/routes/tee_times.py`
- Line 247: harden the parse to drop empties — `course_ids=[c for c in (s.strip() for s in courseIds.split(",")) if c] if courseIds else []`.
- After constructing `query` (~line 250), when `query.course_ids` is non-empty: `query.course_selectors = await resolve_selectors(query.course_ids)` (new, §3.2), **before** the cache lookup so behavior is uniform; cache key needs no change.

### 3.2 New module `backend/app/services/tee_times/selection.py` (pure core + one thin DB function)
- `@dataclass(frozen=True) CourseSelector: id: str; name: str | None = None; lat: float | None = None; lng: float | None = None`.
- `candidate_ids(course: dict) -> set[str]` — `{str(course.get("id") or ""), str(course.get("osm_id") or "")}` plus `deterministic_course_id(external_course_key(course))` when a key exists; discard empties.
- `matches_selection(course: dict, selectors: Sequence[CourseSelector]) -> bool` — True if any `selector.id` is in `candidate_ids(course)`; else, for selectors with a name: `normalize(selector.name) == normalize(course["name"])` (exact equality, never substring) AND, when both sides have coordinates, haversine ≤ `MATCH_RADIUS_MILES`. Selector or course missing a center → name equality alone (mirrors `match_capability`).
- `async resolve_selectors(course_ids: list[str]) -> list[CourseSelector]` — for each raw id, build the DB lookup key set: the raw id itself when UUID-parsable, plus `deterministic_course_id(raw)` and `deterministic_course_id(f"osm-{raw}")`. Fetch matching rows via a new `courses_mapped.courses_by_ids(ids)` (§3.3); first hit per raw id wins → `CourseSelector(id=raw, name=row["name"], lat=…, lng=…)`; no hit → `CourseSelector(id=raw)`. **Never raises** — any exception returns id-only selectors.

### 3.3 `backend/app/services/courses_mapped.py`
- New `async courses_by_ids(ids: list[str]) -> list[dict]` next to `nearby_courses` (line 109): `SELECT id::text AS id, name, ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat FROM public.courses WHERE id = ANY(:ids)`; caller passes only UUID-parsable strings (pre-filter with `uuid.UUID(...)` try/except so the uuid column cast can't error).

### 3.4 `backend/app/services/tee_times/base.py`
- `TeeTimeQuery` (line 26–34) gains `course_selectors: list["CourseSelector"] | None = None` (backend-internal; document "resolved by the route from course_ids — providers must treat None as 'derive id-only selectors from course_ids'"). Import via `from .selection import CourseSelector` — verify no import cycle (selection imports only `private_filter`, `capability_store`, `course_finder`; none import `base`). If the builder finds a cycle, define `CourseSelector` in `base.py` and have `selection.py` import it.

### 3.5 `backend/app/services/tee_times/routing.py`
- In `search_availability`, immediately after `courses = exclude_private(courses)` (line 188) and **before** the `courses[:MAX_COURSES]` slice (line 191), insert the selection filter:
  - if `query.course_ids` is non-empty: `selectors = query.course_selectors or [CourseSelector(id=i) for i in query.course_ids]`; `courses = [c for c in courses if matches_selection(c, selectors)]`.
  - if the pre-filter list was non-empty and the filtered list is empty, log one structured line (`tee_time_selection: %d selected ids matched 0 of %d discovered courses`) — the QA falsification hook. Add `log = logging.getLogger(__name__)` (routing.py has none today).
- Nothing else in the loop changes; `RoutedTeeTimeProvider` inherits; foreUP now only consulted for selected courses (quota win). `mock.py` untouched.

## 4. Frontend edits (exact)

1. `backend/app/routes/course_search.py:418–425` (`/api/courses/nearby`): wrap results with `course_finder.attach_stable_ids(results)` before the positive-cache `set` and return — one line plus comment.
2. `frontend/src/lib/golf-api.ts:873`: `id: c.id ?? c.osm_id ?? ""` — covers 15-min-old cached `/nearby` payloads that predate (1). Skip rows where the id is empty so an unidentifiable row can never be selected.
3. `frontend/src/lib/golf-api.ts:419–431` (`CourseSearchApiResponse`): `id` becomes optional (`id?: string`) and add `osm_id?: string`.
4. `frontend/src/app/tee-time/page.tsx:844`: `courseIds: selectedCourses.map((c) => c.id).filter(Boolean)`.
5. Checked consumers — all improve or unaffected: React keys `page.tsx:711,722` (undefined-duplicate keys fixed), `toggleCourse` `page.tsx:467` (all-OSM-rows-toggle-together bug fixed), `toCourseOptions` favorites (`teetime/courses.ts:97`), `mergeCourseOptions`/`addCourseOption` dedupe (`courses.ts:161–166, 224–231`), map pins (name/distance-based).

`frontend/src/lib/teetime/types.ts` / `backend/app/models.py`: **no change** — confirm in review.

## 5. Edge cases (pinned behavior)

- **Empty `course_ids`** → no filter, all discovered courses (mock parity).
- **Selected OSM course seen nearby** → kept via direct osm_id / det-UUID candidate; unselected dropped.
- **Selected mapped-only UUID truly not discoverable** → dropped honestly; possible zero-result; UI renders honest "Nothing in <window>" (`page.tsx:889`); backend logs zero-after-filter. No fabricated slot.
- **Homegrown-mapped selection physically nearby** → rescued by name+proximity (courses row has name+location). Name differing beyond `normalize` equality drops; acceptable, logged, falsifiable.
- **Place-name area** (non-page callers): Places ids match directly; osm-id/UUID selections reconcile via selector name+proximity; otherwise dropped honestly.
- **foreUP capability course**: selected → passes filter → `_slots_for_course` capability path unchanged. Not selected → filtered before `_slots_for_course` → foreUP never called.
- **Cache**: `course_ids` sorted into both cache keys already — no contamination.
- **Legacy `courseIds=","` / empty members** → parsed away by §3.1 → no filter.
- **Selected course beyond routing's radius clamp** (`_radius_meters` caps at 50 km): not discovered → dropped. Pre-existing bound; document, don't widen.
- **Pre-cap filtering**: a selected course ranked below the 8-course cap is returned (test-pinned).

## 6. Gates

Backend (`cd backend && ruff check . && python -m pytest tests/ -k tee_time`):
- **MANDATORY no-always-zero regression guard** — `tests/test_tee_time_routing.py`, new `class TestCourseSelectionFilter`:
  - `test_selected_osm_id_keeps_only_that_course`: fake finder returns three realistic OSM-shaped dicts (`osm_id="way/101|102|103"`, **no `id` key**); `course_ids=["way/102"]` → exactly that course, others absent.
  - `test_empty_course_ids_returns_all`.
  - `test_mapped_only_uuid_selection_drops_honestly`: `course_ids=[str(uuid4())]`, no selectors → `[]`.
  - `test_deterministic_uuid_selection_matches`: `course_ids=[deterministic_course_id("osm-way/102")]` → kept.
  - `test_selector_name_and_proximity_matches`: id-mismatched selector with the course's name + a center <1 mi → kept; same name far center → dropped.
  - `test_selection_filter_runs_before_cap`: 9 courses, select the farthest → returned.
  - `test_selected_private_course_still_excluded`.
- New `tests/test_tee_time_selection.py`: pure tests for `candidate_ids`, `matches_selection` (incl. generic-name same-name-different-center negative), `resolve_selectors` never-raises fallback, and the empty-string CSV guard.
- `tests/test_tee_time_router.py`: selected capability course still yields real foreUP slots; **unselected** capability course → `FakeForeUp` never called.
Frontend (`cd frontend && npx vitest run src/lib/golf-api-nearby.test.ts src/lib/teetime/courses.test.ts && npx tsc --noEmit && npm run lint`):
- `golf-api-nearby.test.ts`: new case with the realistic backend shape — OSM leg `{ osm_id: "way/123", name, center }` no `id` → `result.id === "way/123"`; and `{ id: "uuid", osm_id: "way/123" }` → `"uuid"` wins.
- Voice smoke (`npx tsx voice-tests/runner.ts --smoke`) before done.
Manual/QA: on-device, select 1 nearby course → only it returns; deselect-all → all return; select only a far hand-added course → honest zero + backend log line; repeat within 15 min → `cached: true` same filtered set.

## 7. Risks & how the reviewer/QA falsify them

1. **Zero-result regression re-emerges via id drift**: candidate-set matching covers `id`, `osm_id`, det-UUID; falsify by the mandatory guard test with both shapes.
2. **DB down during selector resolution**: `resolve_selectors` never raises, id-only selectors still satisfy OSM/direct cells; falsify by monkeypatching `courses_by_ids` to raise and asserting osm-id selection still filters.
3. **Name-match false positive** (two same-normalized-name courses <1 mi apart): bounded by exact-equality `normalize` + 1 mi; falsify with the negative unit test; residual risk accepted (same as `match_capability`).
4. **Stale-cache cross-contamination**: keys include sorted ids; falsify by "search all, then filtered inside the TTL" + search-cache unit test.
5. **Frontend behavior shifts from ids becoming defined**: all shifts are bug-fixes; falsify on-device (toggle single OSM row must not toggle siblings; favorited search-added course pre-selects its nearby twin).
6. **Mid-deploy skew** (old cached `/nearby` payload without ids + new frontend): covered by `c.id ?? c.osm_id`; falsify in vitest with the id-less fixture.

## 8. Scope verdict

**Bounded — one builder, one PR.** Backend: one new small module (`selection.py`, pure core), one ~15-line DB helper, a dataclass field, a ~6-line filter hook pre-cap, a parse guard, one line in `/api/courses/nearby`. Frontend: one id-source line + type honesty + one `.filter(Boolean)`. No wire-contract or `types.ts`/`models.py` changes. The name+proximity selector layer is required (default pre-selected favorites are mapped UUIDs — without it the *default* flow zeroes out) and reuses existing tested normalize/radius machinery. **Defer / flag for owner:** widening the 50 km discovery radius clamp; any fail-open policy; unifying `/api/courses/nearby` write-through.

### Critical Files
- backend/app/services/tee_times/routing.py
- backend/app/routes/tee_times.py
- backend/app/services/tee_times/selection.py (new)
- backend/app/services/tee_times/base.py
- backend/app/services/courses_mapped.py
- backend/app/services/course_finder.py (helpers reused)
- frontend/src/lib/golf-api.ts
- backend/app/routes/course_search.py
- frontend/src/app/tee-time/page.tsx
- backend/tests/test_tee_time_routing.py
