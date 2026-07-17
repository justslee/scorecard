# Course discovery: Augusta-styled descriptions + honest stars/stats + map slide-up detail card

Owner directive (2026-07-17, 2 screenshots — a bare Bethpage Black detail page, a map pin with
only a marker): "improve the search experience and course finding significantly. Each course
seeded with an Augusta-styled description + a collection of user-reviewed stars and stats if
available. The map view should show a slide-up modal with course details, not just the marker."

Serves NORTHSTAR.md: this is prose and honest data in the existing yardage-book system, not a
new SaaS surface. No new component library, no new design language.

---

## User stories

1. As the golfer opening a course I've never played, I want a short, evocative passage about the
   course — routing, character, history where it's real — so the course feels like a place, not a
   database row, before I even tee off.
2. As the golfer browsing the map, I want to tap a pin and see the same rich detail (not just a
   name) so I can decide whether to add/start/inspect the course without leaving the map.
3. As the golfer who has played and rated a course, I want to see that rating reflected — and as a
   golfer looking at an unreviewed course, I want an honest "no reviews yet," never a fabricated
   number.
4. As the owner, I never want to see a wrong fact (architect, year, "hosted the 19—something") in
   a course description — a wrong claim is worse than no claim.

---

## The single data shape — `CourseIntel`

One shape feeds both surfaces (detail page + map card). `courseId` is the SAME id already used
everywhere else in course discovery: `public.courses.id`, which is both `InBoundsCourse.id`
(the pin id — write-through-persisted by `attach_stable_ids` /
`backend/app/services/course_finder.py:216-226`) and the `id` `CourseDetailClient.tsx` already
loads by by (`mapped.id` for `isMapped` rows). No new identity bridge needed for course
identity — it already unifies at this UUID.

```
CourseIntel {
  courseId: string;                 // public.courses.id

  description: {
    text: string | null;            // final composed prose; null = not yet seeded
    provenance: "landscape" | "enriched" | null;
    generatedAt: string | null;     // ISO timestamp
    model: string | null;
  };

  stars: {
    avg: number | null;             // null iff count === 0 — never a fabricated 0.0
    count: number;                  // 0 = honest "no reviews yet"
  };

  stats: {
    parTotal: number | null;        // null if course is not mapped (no holes data)
    yardageByTee: Record<string, number> | null;  // tee name -> total yards; null if not mapped
    holesMapped: number | null;     // null if not mapped
    roundsPlayed: number;           // 0 is a real, honest count — always shown
    avgScore: number | null;        // null unless >=1 COMPLETE round exists (see stats below)
  };
}
```

Backend: add the matching Pydantic model `CourseIntel` to `backend/app/models.py` (next to the
other course response models). Frontend: add the matching TS type to `frontend/src/lib/types.ts`
next to `CourseReview` (`types.ts:281-291`).

New endpoint: **`GET /api/courses/{id}/intel` → `CourseIntel`**. `id` is `public.courses.id`.
Works for ANY courses row, mapped or write-through-only — stats fields are simply `null` when the
course has no holes/tee_sets rows yet. This is a pure-DB read (see Budget invariants) — no LLM
call happens inline; it only ever reads a precomputed cache.

- **stars**: `SELECT AVG(rating), COUNT(*) FROM course_reviews WHERE course_key = :id AND
  owner_id = :current_user_id`. This reuses the EXACT identity `CourseDetailClient.tsx:64`
  already passes today (`getCourseReviews(courseId!)` → `GET /api/courses/{course_key}/reviews`,
  owner-scoped) — for a mapped course that key is already the `courses.id` UUID at that call
  site, so no new keying scheme is introduced. **Honesty note, state it plainly in-app nowhere but
  document it here**: `course_reviews` is owner-scoped today (multi-user is "eventually" —
  [[multi-user-direction]]), so `stars` is *the owner's own reviews*, not a community rating.
  This is not a bug to fix in this spec; B5 identity unification is deferred.
- **stats.parTotal / yardageByTee / holesMapped**: from the existing mapped-course tables
  (`holes`, `tee_sets`) — same computation `CourseDetailClient.tsx:110-134` already does
  client-side (`mappedPar`, per-tee `totalYards`), just done once server-side so the map card gets
  it too without shipping the full `CourseData` payload to every tapped pin.
- **stats.roundsPlayed**: `SELECT COUNT(*) FROM rounds WHERE mapped_course_id = :id`. New query —
  none exists today (`backend/app/db/models.py:290-327`, `Round.mapped_course_id` is nullable,
  legacy rounds may have it unset). Honest by construction: a round whose `mapped_course_id` was
  never resolved is not counted — never estimated or backfilled here.
- **stats.avgScore**: only computed over rounds that are *complete* (every one of the course's
  mapped holes has a `Score` row for that round — `Score` is per round/player/hole,
  `backend/app/db/models.py:379+`, there is no stored round total). If zero complete rounds exist,
  `avgScore` is `null` and the field is omitted from the UI entirely — never averaged over partial
  rounds (a partial round's "score" is not comparable and would silently skew the number).

---

## Build 1 — Augusta-styled per-course description

**Pattern**: mirrors `backend/app/caddie/guide_writer.py` exactly — a grounded WRITER + a
deterministic, fail-CLOSED validator. New module: `backend/app/caddie/course_intel_writer.py`.

**Ground truth block** (course-level analog of `build_ground_truth_block`, §4a in guide_writer.py):
built ONLY from data we own — par, total yardage, hole count, and an aggregate hazard/terrain
profile computed by running the existing `hazards.extract_hole_hazards` across every hole
(water-hole count, bunker density, elevation range, tree density if mapped). These are facts we
own; never fabricated.

**Structured writer output** (Claude + structured output, `messages.parse`, same
`COURSE_INTEL_MODEL` env pattern as `GUIDE_WRITER_MODEL`, default `claude-sonnet-5`):

```
landscape: str                      # ALWAYS present — Augusta-broadcast-register scene-setting,
                                     # grounded ONLY in our own geometry (routing, water,
                                     # elevation, tree density). No specific unverifiable claims.
architect: Optional[str]
architect_confidence: "high" | "medium" | "low" | "unknown"
year_built: Optional[str]
year_built_confidence: same enum
style_notes: Optional[str]          # e.g. "classic parkland routing"
style_confidence: same enum
notable_history: Optional[str]      # e.g. major championships hosted
notable_history_confidence: same enum
```

**Key design choice — no web_search tool.** Unlike the hole-strategy writer, this writer is NOT
grounded against a live search (the owner's wording: "verifiable via the model's own knowledge").
No search tool means no untrusted web content to defend against, no per-search cost, and a single,
cheap, bounded call per course. State this explicitly to the fable plan as the recommended
default; if a future pass wants live-verified facts, that's a distinct, larger spec (web_search +
a `HAZARD_GROUNDING_RULE`-style injection defense, per-fact citation).

**Validator — `validate_course_intel`** (deterministic, no LLM, fail-closed, same spirit as
`validate_guide`):
1. Structural: `landscape` non-empty after strip, length-capped (mirror `_MAX_FIELD_CHARS`-style
   cap, e.g. 700 chars — long enough for 3-5 sentences, short enough for a mobile card), no
   markdown/headers, no internal newlines (same MED-1 rationale as guide_writer.py:966-973 — this
   text is rendered directly, never treated as an instruction).
2. **Confidence gate** (the core control, per owner: "a wrong architect is worse than none"): for
   EACH of `architect` / `year_built` / `style_notes` / `notable_history`, drop the field to
   `None` unless `*_confidence == "high"`. No independent grounding is possible here (we don't
   store architect/year in our DB to check against, unlike hazards) — self-reported confidence is
   the only signal, so the threshold is strict and the default on ambiguity is to drop.
3. Injection-pattern scan: reuse the same defense-in-depth regex as `validate_guide`
   (guide_writer.py:957-961) — `ignore`, `instructions?`, `you are`, `system prompt`, URLs, HTML
   tags, `disregard`.
4. Compose final `description.text` = `landscape`, with any surviving high-confidence fact
   fields appended as 1-2 additional sentences. `description.provenance` = `"enriched"` if any
   factual field survived, else `"landscape"`. This keeps the frontend dumb — it renders one
   string.

**Storage — STORAGE FORK, fable plan to finalize:**

- **Option A (recommended)**: new additive Alembic migration, `backend/migrations/versions/`
  chained off the current head `0011_014_tournament_round_courses.py`, adding
  `courses.course_intel jsonb NULL` (or discrete columns — fable plan's call) directly on
  `public.courses`. Correct cardinality (course-level fact on the course-level row), no coupling
  to hole-mapping churn (re-ingest, hole renumbering, a missing green feature can't orphan it).
  Cost: one migration. Per CLAUDE.md, `backend/supabase/migrations/**` is do-not-touch, but this
  is a NEW file under `backend/migrations/versions/` (Alembic-guarded, not Supabase-guarded) — it
  still routes through the standing "migration → design + STOP for owner approval" gate before a
  builder runs it against prod. Flag this explicitly in the build plan; it does not block writing
  code, only applying it beyond a dev/staging DB.
- **Option B**: reuse `hole_features.properties` JSONB on a canonical hole's feature (the
  `strategy_guide` precedent, `course_guides.py:66-146` — no migration needed). Con, stated
  plainly: course-level data stored on one arbitrary hole's feature row is semantically muddy and
  fragile — if that hole is re-mapped, renumbered, or its green feature is dropped on a re-ingest,
  the course description silently disappears with it, with no relationship to what actually
  changed.
- **Recommendation**: Option A. The one-migration cost is worth it for correct cardinality and
  zero coupling to hole/feature churn. Final call is the fable plan's per the owner's routing.

**Precompute wiring**: new job in `backend/app/services/course_intel.py` (sibling to
`course_guides.py`), fired at course-mapping/ingest time (mirrors the strategy-guide precompute:
idempotent — skip if already set — best-effort, never raises, negative-cached via an
`attempted_at` marker so a failure doesn't re-spend on every load). ONE Claude call per course
(not per hole) — materially cheaper than the ~$1.5/course hole-guide precompute.

**Seeding**: Bethpage Black, Bethpage Red, Pebble Beach seeded now via a one-off, env-gated
backfill script mirroring `GUIDE_BACKFILL_MAX_COURSES` (run manually by ops against staging/prod,
not auto-fired). New courses seed automatically at mapping time going forward.

### Acceptance criteria
- Bethpage Black/Red/Pebble each have a non-null `description.text` after the backfill runs.
- No description ever contains an architect/year/history claim whose confidence wasn't "high" —
  verify by forcing a low-confidence structured output in a unit test and asserting the composed
  text omits it, falling back to `landscape`-only, `provenance: "landscape"`.
- A course with no cached description renders the honest empty state (see Edge cases), never a
  loading spinner that never resolves and never placeholder Lorem-ipsum-style text.

---

## Build 2 — Stars + stats

Surfaces `CourseIntel.stars` and `CourseIntel.stats` (shapes above) on both surfaces.

**Explicitly OUT of scope**: external/Google ratings. No new Places calls anywhere in this
feature. Note for the owner as a future option: the app already holds a live Places key
(commit `0d2f535`), so a Place Details lookup with the ratings field is a config flip later, not
a build — rough cost order-of-magnitude ~$5-17 per 1,000 lookups depending on field mask (verify
current SKU pricing before turning it on; do not build against this estimate).

### Acceptance criteria
- `stars.count === 0` → UI shows "No reviews yet — play it and be the first," never "0.0★" and
  never an omitted section (the empty state itself is the content).
- `stars.count > 0` → shows `avg` (one decimal) + `count`, e.g. "★ 4.3 (12)".
- `stats.roundsPlayed` shows even when `0` — it's a neutral, honest count, not a rating; render it
  as a plain stat (`MiniStat` component, reusing `CourseDetailClient.tsx:383`'s existing
  `<MiniStat k="Par" v={displayPar} />` pattern), not hidden.
- `stats.avgScore` is entirely OMITTED (no row, no dash) when `null` — never shown as "—" (a
  score-shaped placeholder implies data almost exists; it doesn't).
- Unmapped course (write-through-only pin): `parTotal` / `yardageByTee` / `holesMapped` all
  `null` → the whole stats block is omitted, mirroring the existing `!isCenterOnly` guard already
  used to hide the Tees section for center-only courses (`CourseDetailClient.tsx:390`).

---

## Build 3 — Map slide-up detail card

Replaces the entire "Tap card" block in `frontend/src/components/CourseScoutMap.tsx:402-481`
(currently: name + subline + a single "Add" button, `gridTemplateColumns: "1fr auto"`, a thin
absolutely-positioned bar).

**New behavior**: on pin tap (`selectedPin` set, same state that already exists), fetch
`GET /api/courses/{selectedPin.id}/intel` and open a slide-up sheet — the yardage-book sheet
idiom, not a SaaS bottom-sheet. Study `CaddiePanel.tsx`'s existing slide-up sheet mechanics (the
Looper orb's "tap → sheet" — [[floating-island-tab-nav]]) as the idiom to reuse: same easing,
same paper/hairline/serif tokens already imported in this file (`T.paper`, `T.hairline`,
`T.serif`, `T.mono` — `CourseScoutMap.tsx:33`), dismiss via backdrop-tap/swipe-down. Do not pull
in a new sheet/bottomsheet library.

**Sheet contents** (one `CourseIntel` fetch, all from the shape above):
- Course name, serif, same weight/size register as the current tap card's name line.
- Description: first ~3 lines, "Read more" expand (same truncate+expand affordance to build on
  the detail page, see Build 1/2 insertion below) — omitted entirely if `description.text` is
  null (see Edge cases).
- Stars + count (Build 2 states).
- Key stats row: `holesMapped`, `parTotal`, `roundsPlayed` (omit `avgScore` unless present) — same
  `MiniStat`-style presentation as the detail page for visual consistency between the two
  surfaces.
- Actions: **Add** (existing `handleAdd` behavior, unchanged, `CourseScoutMap.tsx:461`), **Start a
  round** (new — wire to the existing start-round entry point the app already uses elsewhere for
  a selected course; do not build a new round-start flow here), **View course** (new — navigate to
  `/courses/[id]?id={selectedPin.id}&src=mapped`, the SAME query-param convention
  `CourseDetailClient.tsx` already reads for `isMapped` rows, so it's the identical detail page,
  not a new one).

**Loading/error states**: the sheet opens immediately on tap (name is already known from
`selectedPin`); the intel fetch fills in underneath with a quiet skeleton/fade, never blocking the
sheet's appearance. A failed fetch degrades to name-only + Add (never blocks the existing Add
flow — Add must keep working exactly as it does today even if `/intel` 500s).

### Acceptance criteria
- Tapping a pin opens the slide-up sheet, not the old one-row bar (the bar is deleted, not kept
  behind a flag).
- Sheet content and detail-page content for the SAME course render the same description text,
  same stars, same stats (one shape, two renderers) — this is directly verifiable by opening both
  for the same course and diffing.
- `View course` from the sheet lands on the same detail page as navigating there any other way.
- Tapping a different pin while a sheet is open replaces it cleanly (no stacked sheets, no stale
  data flash from the previous pin) — reuse the existing `selectedPin` replace semantics, just
  re-fetch `/intel` keyed on the new id.

---

## Detail page insertion (Builds 1 + 2)

`frontend/src/app/courses/[id]/CourseDetailClient.tsx`, natural insertion point ~line 388, between
the existing header/par-holes `MiniStat` block (ends line 387) and the `Tees` section (starts line
390, `!isCenterOnly` guard). Fetch `CourseIntel` via a new `getCourseIntel(id)` in
`frontend/src/lib/api.ts` (or `frontend/src/lib/courses/mapped-course-api.ts`), called alongside
the existing `fetchMappedCourse`/`getCourseReviews` calls in the `load()` effect
(`CourseDetailClient.tsx:61-106`); wrap in the same silent-fail `.catch()` convention already used
for `getCourseReviews` at line 64 — falls back to an all-null `CourseIntel` on any failure, never
throws into the page. The existing `getCourseReviews` call and any downstream review-list
rendering are UNCHANGED — this is additive.

---

## Edge cases / honest empty states (every field)

| Field | Empty condition | UI |
|---|---|---|
| `description.text` | not yet seeded (no cache) | Omit the description block; optionally a quiet placeholder line matching the existing empty-state voice already in this file ("Tee data unavailable." — `CourseDetailClient.tsx:416`), e.g. "Course notes unavailable." Never invented prose. |
| `stars.avg`/`count` | `count === 0` | "No reviews yet — play it and be the first." Never "0.0★". |
| `stats.parTotal`/`yardageByTee`/`holesMapped` | course not mapped | Omit the entire stats block (mirrors existing `!isCenterOnly` Tees guard). |
| `stats.roundsPlayed` | `0` | Shown as `0` — a real count, not hidden. |
| `stats.avgScore` | no complete rounds | Row omitted entirely, no dash/placeholder. |
| `/intel` fetch fails | network/5xx | Detail page: page still renders with the intel section simply absent (matches existing all-null fallback pattern for course/club). Map sheet: degrades to name-only + Add. |

---

## Budget invariants

- **No new Google Places or GolfAPI calls anywhere in this feature** — not in `/intel`, not in the
  map card, not in the detail page. `/intel` reads Postgres only (`course_reviews`, `holes`,
  `tee_sets`, `rounds`, `Score`, and the cached description column/JSONB). Verify with a grep
  sweep of the new route/service files for `fetchAPI`/`searchAll`/`searchNearby`/Places SDK
  imports → nothing, same discipline `CourseScoutMap.tsx:12-15`'s header comment already documents
  for the in-bounds fetch.
- **Description LLM spend is precompute-only, never inline on a request.** `/intel` never calls
  Claude; it only reads a cache. One Claude call per course (no `web_search` tool — no per-search
  cost), same dedicated-env + cost-guard-log pattern as `guide_writer.py:283-289`.
- **The per-tap map card adds zero external calls.** Its one network call is
  `GET /api/courses/{id}/intel`, our own backend, DB-only.

---

## Noticeable vs silent

**NOTICEABLE.** All three builds ship together as one bundle — a golfer on TestFlight sees new
prose on course pages, real stars/stats where they exist, and a materially different (slide-up,
not a one-row bar) map tap experience. This triggers the standing owner-approval gate for the
bundle it lands in.

Silent riders that belong in the same PR (do not independently trigger anything, but ride along):
the Alembic migration itself (if Option A) and its guarded owner-approval step, the
writer/validator module + its unit tests, the new `/intel` route + Pydantic/TS types, and the
backfill script. None of these have an independent visible surface — they're infrastructure for
the noticeable UI work above.

---

## Explicitly OUT of scope
- External/Google ratings (Places) — noted as a future flip, not built here.
- Cross-user/community star aggregation — deferred to the multi-user epic (B5 identity
  unification); `stars` today is honestly the owner's own reviews only.
- Live web-search-grounded description facts — the writer uses the model's own parametric
  knowledge only, per the owner's wording; a future spec could add `web_search` + a
  `HAZARD_GROUNDING_RULE`-style defense if deeper factual coverage is wanted.
- Editing/moderating descriptions from the app — read-only surfacing of the precomputed cache.
- Backfilling `roundsPlayed`/`avgScore` for legacy rounds with a null `mapped_course_id` — counted
  honestly as 0/absent, never guessed.

---

## End-to-end verification

1. Run the seed backfill on staging for Bethpage Black, Bethpage Red, Pebble Beach; confirm each
   has a non-null cached description (DB check or a diagnostic script, no UI needed for this step).
2. Open the Bethpage Black course detail page in the app: description renders (serif, truncated
   with a working "Read more" expand), stars show either a real avg+count or the honest
   "no reviews yet" line, stats show `holesMapped`/`parTotal`/`roundsPlayed` (and `avgScore` only
   if the test account has a complete logged round there).
3. Open the map, pan to Bethpage Black, tap its pin: a slide-up sheet opens (not the old thin
   bar) with the SAME description/stars/stats as step 2. Confirm `Add`, `Start a round`, and
   `View course` all work; `View course` lands on the exact same detail page as step 2.
4. Tap a pin for a course that has never been mapped (write-through-only, e.g. a random nearby OSM
   course not yet seeded): sheet opens with name + honest empty description/stats, `Add` still
   works.
5. With the browser/device network inspector open, repeat steps 2-3 and confirm zero requests to
   Google Places or GolfAPI domains fire at any point.
6. `cd frontend && npx tsc --noEmit && npm run lint && npx tsx voice-tests/runner.ts --smoke` and
   `cd backend && ruff check . && pytest` all green.
