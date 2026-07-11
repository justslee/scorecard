# Course Selection UX Plan — Named-Course Bug (A) + Map-Based Course Search (B)

## Part A — THE BUG: "Marine Park" from Pittsburgh searched Pittsburgh

### A.1 Root cause (full chain)
The named course is **silently dropped at the parse step**; later stages faithfully execute a GPS-nearby search.
- **Parser hears only on-screen courses.** `frontend/src/app/tee-time/page.tsx:426-432` calls `parseTeeTimePrefs({transcript, known:{courses: courses.map(c=>c.name)}})` — `known.courses` is the GPS-seeded prefs list (page.tsx:161,211-220 → `fetchNearbyCourseOptions`, courses.ts:364-380). In Pittsburgh = 8 Pittsburgh courses. `matchKnownCourses` (parseTeeTimePrefs.ts:324,150-185) matches ONLY that list; "Marine Park" ("park" is generic) → `courseNames:[]`. **No extraction of an unmatched spoken name exists.** LLM pass doesn't run (local has signal, returns at :389-390) and even if it did, drops unknown names into `warnings` no UI speaks (:456-467). Aggravator: keyterm bias toward Pittsburgh names (page.tsx:425).
- **Apply dispatches anyway.** `caddie-task.ts:79` skips the course branch when `courseNames.length===0`. `caddie-task.ts:106` `dispatched = windows.length>0 || dispatch` → day/time heard → arms the 1400ms dispatch. Even in the partial path (name parsed but misses list), the ack says "couldn't find X — kept your picks" then STILL dispatches 1.4s later.
- **Query carries only GPS + GPS-preselected picks** (courses.ts:200-204, page.tsx:809-820, query.ts:36-60).
- **Backend has no named-course targeting when area is GPS** (routing.py:140-146 → OSM nearby around GPS; place-name branch 148-160 unreachable; `course_ids` only FILTER the GPS-radius set — a 350mi selector matches 0, logged, never used as a location; selection.py:105-158 resolves ids→center but only for match verification).
- Summary: "near me" and "this specific course" are structurally the same intent today — GPS always wins.

### A.2 Fix
Principle: a named course OVERRIDES GPS; resolution goes through the ONE unified search (`backend/app/routes/course_search.py:230-367`); ambiguity → caddie CLARIFIES; unresolvable → honest, do NOT dispatch a substitute.
- **A.2.1 Parse extraction (pure, offline):** add `unresolvedCourseNames: string[]` to the schema; in `parseTeeTimePrefsLocally` after `matchKnownCourses`, run a conservative `\b(?:at|on|over at|out at)\s+([a-z][a-z' ]{2,40})` capture bounded by the day/period/party/price vocabulary; fuzzy-match known → `courseNames`, else `unresolvedCourseNames`. LLM pass maps dropped names into it (not warnings-only).
- **A.2.2 Resolution:** new `frontend/src/lib/teetime/course-resolve.ts` `resolveSpokenCourse(name, origin)` on `searchAllCourses` (golf-api.ts:525-580 — same path typed search uses, cached 24h, budget-guarded). One dominant hit → `"one"`; 2–4 facilities → `"ambiguous"` (candidates w/ locality); zero → `"none"`. Never fabricate, never GPS-fallback. Called in the async `parse` (contract allows async, caddie-context.ts:62), ~4s timeout → `"none"`.
- **A.2.3 Apply gating:** `planTeeTimeApply` — `"one"` → add via `courseOptionFromSelection`+`addCourseOption`, select it + deselect GPS auto-preselects (golfer's own toggles survive), honest distance banner (no 50mi pretense). `"ambiguous"` → `dispatched:false`, ack asks the question, pending candidates in page state, next utterance resolves (BARE_YES_RE/ordinal precedent). `"none"` → `dispatched:false`, honest line. **Hardening: `dispatched` must be false whenever a course-miss/unresolved name exists** — a sentence naming a course must never dispatch a search ignoring it. `TaskAck` gains `expectReply?:boolean` so the orb keeps the mic open for the clarify turn.
- **A.2.4 Backend selector-centered discovery:** when resolved selectors carry centers (selection.py:151), discover around each selector center (~5km, osm.py:398) and merge with / (when all selected are beyond the GPS radius) replace the GPS discovery; distance stays honest from GPS origin. Skip the `distance>max_distance_miles` prune (routing.py:219-220) for selector-matched courses.
- **A.2.5 Fixture (RED today):** `parseTeeTimePrefsLocally("...at Marine Park Saturday morning",{courses:[8 Pittsburgh]})` → `unresolvedCourseNames:["marine park"]`; `planTeeTimeApply` unresolved → `dispatched:false` + line names Marine Park; backend query area=Pittsburgh + course_ids=[marine-park-uuid] w/ Brooklyn-center resolver → finder invoked around Brooklyn, slot emitted.

## Part B — THE FEATURE: map-based course search
### B.1 Marker data source (budget-aware): our own course DB (PostGIS bbox) as the instant layer + cached OSM as fill. NO Google Places per pan, GolfAPI NEVER on this path (golfapi-budget-cache-first).
- New `GET /api/courses/in-bounds?swLat&swLng&neLat&neLng` in course_search.py: (1) DB bbox query (ST_MakeEnvelope, like nearby_courses courses_mapped.py:111-127), ~0 cost, grows via write-through; (2) OSM leg quantized to ~0.05° geo-cells, one `search_golf_courses` per cold cell, positive-cached (FileSearchCacheStore geo-cell pattern, long TTL), write-through to DB; (3) merge/dedupe by courseNameKey + attach_stable_ids. Cap ~40 pins; zoomed way out → "zoom in to see courses". Client: fire on camera-idle, debounced 500-700ms, skip covered cells, abort-hardened.
- Honesty: pins only for real centers; OSM timeout ≠ empty (show DB pins + quiet note, never authoritative empty).
### B.2 UX (calm lens, not a fork): a "Map" mode toggle inside `frontend/src/components/CourseSearch.tsx` (the shared surface — arrives in tee-time/round/courses at once, one unified path). New `CourseScoutMap.tsx` reusing `@capacitor/google-maps` (GoogleSatelliteMap.tsx layering precedent), roadmap type (calmer than satellite), quiet golf-flag ink markers (no red teardrops/clusters), tap → one-row yardage-book card w/ "Add" (same CourseSelectPayload contract). Typed query pans to top hit (never reshuffle). Empty → honest one-liner. No Maps key → toggle doesn't render (list unchanged).
### B.3 Shared resolution with A: one identity pipeline (map pin → stable UUID → CourseSelectPayload → addCourseOption → courseIds → resolve_selectors → selector-centered discovery). The map FEEDS the resolver — scanned cells write courses through so voice "Marine Park" resolves local-fast over time.

## Sequencing (bug first)
- **A0 — Stop the lie (smallest, pure, ships alone):** `unresolvedCourseNames` extraction + `dispatched` gating + honest ack. Marine-Park fixture RED→GREEN.
- **A1 — Backend selector-centered discovery** (routing.py + pytest). Also fixes hand-add-far-course-then-search dead end.
- **A2 — Voice resolution** (`course-resolve.ts`, single-hit auto-add+select+honest-widen, "none" honest). E2E: Marine Park from Pittsburgh searches Brooklyn.
- **A3 — Clarify turn** (ambiguous candidates, `expectReply`, pending-state follow-up parse).
- **B1 — `/api/courses/in-bounds`** (DB bbox + geo-cell-cached OSM + write-through + stable ids).
- **B2 — Map mode in CourseSearch** (CourseScoutMap, debounced, pins, tap-to-add, honest empty; designer review).
- **B3 — Polish** (pin cap/zoom copy, viewport persistence, favorites star, map-follows-query).

## Risks
Resolution latency in the voice turn (timeout-bound + interim line + cache); false positives from "at <name>" capture (conservative, ≥1 non-generic token, failure = clarify not wrong search); ambiguity overtrigger (dominance + location rank keeps obvious cases silent); Overpass flakiness (geo-cell cache + DB leg degrade to fewer-pins-quiet-note); native map layering in the sheet (proven but finicky; fall back to full-screen map mode); selector-discovery scope creep (additive-merge so pure near-me is byte-identical).

### Critical Files
- `frontend/src/lib/voice/parseTeeTimePrefs.ts` (extraction; silent drop :150-185,:324)
- `frontend/src/lib/teetime/caddie-task.ts` (apply + dispatch gating :79-108)
- `backend/app/services/tee_times/routing.py` (selector-centered discovery :130-162,:194-222)
- `frontend/src/components/CourseSearch.tsx` (map-mode host; one unified path)
- `backend/app/routes/course_search.py` (unified resolver + new /in-bounds; geo-cell cache :57-73)
- Also: `frontend/src/app/tee-time/page.tsx` (:398-434 contract, :809-820 query), `teetime/courses.ts`, `tee_times/selection.py`, `caddie-context.ts`, `GoogleSatelliteMap.tsx`.
