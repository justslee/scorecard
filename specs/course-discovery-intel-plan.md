# Course discovery intel — implementation plan

Plan for `specs/course-discovery-intel.md` (PM spec). This plan is the build contract:
files, shapes, decisions, and gates are final unless the owner redirects. Serves
NORTHSTAR.md — prose and honest data inside the existing yardage-book system.

Branch: `integration/next`. Bundle class: **NOTICEABLE** (all three builds ship together);
the migration + writer + tests are silent riders in the same PR.

**Ships are HELD this cycle** (unrelated tree-distance verification), so nothing here
reaches the owner's device until the bundle ships regardless of storage choice.

---

## 0. Decisions locked by this plan

| # | Decision | Verdict |
|---|---|---|
| 1 | Storage | **Option A** — additive Alembic migration `courses.course_intel jsonb NOT NULL DEFAULT '{}'` (see §2, the crux) |
| 2 | Writer model env | `COURSE_INTEL_MODEL`, default `claude-sonnet-5` (verified: mirrors `GUIDE_WRITER_MODEL` at `guide_writer.py:249`; the runtime `ANTHROPIC_MODEL` (Sonnet 4.5) does not support `messages.parse` structured outputs) |
| 3 | No web_search | Locked by PM. The writer uses parametric knowledge only — zero injection surface from the network, zero search cost, one bounded call per course |
| 4 | Facts vs prose | The writer emits `landscape` prose (geometry-grounded, no specific claims) PLUS separate per-fact *sentences* each with self-reported confidence. Composition appends only `high`-confidence fact sentences. This is what makes the confidence gate surgically enforceable — an integrated paragraph could not be validated deterministically |
| 5 | Endpoint | `GET /api/courses/{course_id}/intel` → `CourseIntel`, DB-only, never 404s for a well-formed id (empty rows → honest nulls/zeros) |
| 6 | Stars identity | `course_reviews.course_key == public.courses.id`, owner-scoped (`current_user_id`) — the exact identity `CourseDetailClient.tsx:64` already passes. Honestly single-user today; documented, not "fixed" |
| 7 | Naming collision | `app/caddie/course_intel.py` (live per-hole caddie intelligence) and `POST /api/caddie/course-intel` (`routes/caddie.py:1250`) ALREADY EXIST. The new modules keep the PM's names but MUST carry docstring cross-references both ways, and must never import `app.caddie.course_intel` |

---

## 1. The shared shape — `CourseIntel`

Wire contract, camelCase (house convention: `CourseReview` in `backend/app/models.py:251`
mirrors `types.ts:281`). Keep both files in sync in the same commit.

`frontend/src/lib/types.ts` (insert after `CourseReviewCreate`, ~line 300):

```ts
// ────────────────────────────────────────────────────────────────────────────
// Course intel (course-discovery-intel) — kept in sync with backend
// app/models.py CourseIntel. One shape feeds BOTH the map tap-sheet and the
// course detail page. Pure-DB read; description is a precomputed cache.
// ────────────────────────────────────────────────────────────────────────────

export interface CourseIntelDescription {
  text: string | null;               // composed prose; null = not yet seeded
  provenance: "landscape" | "enriched" | null;
  factsUsed: string[];               // subset of ["architect","yearBuilt","styleNotes","notableHistory"]
  generatedAt: string | null;        // ISO datetime
  model: string | null;
}

export interface CourseIntel {
  courseId: string;                  // public.courses.id
  description: CourseIntelDescription;
  stars: {
    avg: number | null;              // null iff count === 0 — never a fabricated 0.0
    count: number;
  };
  stats: {
    parTotal: number | null;         // null if not mapped
    yardageByTee: Record<string, number> | null;
    holesMapped: number | null;      // count of REAL public.holes rows, null if 0
    roundsPlayed: number;            // honest count, 0 is real
    avgScore: number | null;         // null unless ≥1 COMPLETE round exists
  };
}
```

`backend/app/models.py` (insert after `CourseReviewCreate`, ~line 274): matching
Pydantic models `CourseIntelDescription`, `CourseIntelStars`, `CourseIntelStats`,
`CourseIntel` with identical field names (camelCase, per the `CourseReview` precedent).

Stored column value (`public.courses.course_intel` jsonb, snake_case at rest —
the route maps to camelCase like `_orm_to_pydantic` in `routes/course_reviews.py:28`):

```json
{
  "attempted_at": "2026-07-17T…Z",
  "description": {
    "text": "…", "provenance": "enriched",
    "facts_used": ["architect", "notable_history"],
    "generated_at": "…", "model": "claude-sonnet-5", "schema_version": 1
  }
}
```

`attempted_at` alone (no `description`) = negative cache: writer failed or validator
rejected — never re-spend automatically ([[no-fake-data-fallbacks]]: nothing is shown).

---

## 2. Storage — Option A, and why (the crux)

**Verdict: Option A.** New Alembic migration `backend/migrations/versions/0012_015_course_intel.py`:

```python
revision: str = "015_course_intel"
down_revision = "014_tournament_round_courses"   # verified current head

def upgrade() -> None:
    op.execute(
        "ALTER TABLE public.courses "
        "ADD COLUMN IF NOT EXISTS course_intel jsonb NOT NULL DEFAULT '{}'::jsonb"
    )

def downgrade() -> None:
    op.execute("ALTER TABLE public.courses DROP COLUMN IF EXISTS course_intel")
```

Justification — decided on verified code, not aesthetics:

1. **Option B is destroyed by re-mapping, verifiably.** `courses_mapped.upsert_course`
   runs `delete from public.hole_features where hole_id = :hole_id` and re-inserts
   features from the CLIENT payload on every course save (`courses_mapped.py:436-439`).
   Any course-level description parked on a canonical green's `properties` — and its
   `attempted_at` negative-cache marker — dies on the next edit unless the client
   happens to round-trip it. Paid-for LLM output silently lost, or silently re-spent.
2. **Option B cannot serve write-through-only rows.** OSM pins persisted by
   `attach_stable_ids` / `external_course_rows` (`course_finder.py:216-226`) have a
   `courses` row but ZERO holes/features — there is no green to write to. `/intel`
   must work for ANY courses row (PM spec).
3. **Migrations are routine here, and Alembic already touches `public.courses`:**
   `0008_011_courses_trgm_index.py` adds an index on it. Eleven migrations landed via
   the standing approval gate. The guarded dir is `backend/supabase/migrations/**` —
   this plan does NOT touch it.
4. **The taste argument for B is weaker than it looks.** The deliverable is *prose*.
   The builder end-to-end verifies against local/CI Postgres (column present there —
   see split below) and pastes the REAL generated Bethpage Black text + a screenshot
   of the live card/page (local backend) into the PR + Notion card. The owner tastes
   the actual pipeline output either way; ships are held this cycle regardless, so
   B buys no earlier TestFlight moment.

### Build-now vs STOP (exact split)

**Build now (everything):**
- The migration FILE `0012_015_course_intel.py` — committed, applied only to dev/CI DBs.
- `backend/tests/integration/conftest.py`: after the verbatim replay of
  `001_course_mapping_schema.sql` (`conftest.py:100-113`), add
  `ALTER TABLE courses ADD COLUMN IF NOT EXISTS course_intel jsonb NOT NULL DEFAULT '{}'::jsonb`
  — the exact precedent of the `scores_round_player_hole_uq` block (`conftest.py:85-98`)
  for schema that lives outside `Base.metadata`. (The guarded supabase SQL is NOT edited.)
- Writer, validator, service, route, Pydantic/TS types, both frontend surfaces,
  all tests, the backfill entry point.
- Local end-to-end: `alembic upgrade head` on the dev DB → run the backfill for the
  locally-mapped Bethpage Black → verify the card + detail page render the real
  description → capture prose + screenshots as PR evidence.

**STOP — owner approval required before:**
1. Applying `015_course_intel` to the prod/staging DB (standing migration gate).
2. Running the seed backfill against prod for Bethpage Black, Bethpage Red, Pebble
   Beach. Spend is pre-authorized (standing guide-generation pattern) and tiny:
   1 call/course, no search, ~2-3k in / ~1k out tokens ≈ **<$0.03/course, ~$0.10 total**
   (vs ~$1.5/course for hole guides). Cost-logged per course like `guide_writer.py:283-289`.

Until then the prod UI renders the honest empty states — by design, never a shimmer.

---

## 3. Build 1 — description pipeline

### 3a. Writer module — `backend/app/caddie/course_intel_writer.py` (new)

Mirror of `guide_writer.py`'s writer+validator split. Docstring MUST note: "Course-level
descriptions for course DISCOVERY. Not `app.caddie.course_intel` (the live per-hole
caddie intelligence builder) — see that module's docstring." Add the reciprocal note
to `app/caddie/course_intel.py`.

**Ground-truth block** — `build_course_ground_truth_block(course: dict) -> str`, pure,
course-scope analogue of `build_ground_truth_block` (`guide_writer.py:100`). Input is
`courses_mapped.get_course(...)` output. Derives ONLY from our data:
- holes mapped (count holes with non-empty `features.features` or `yardages` — the
  get_course 18-hole default fill at `courses_mapped.py:302-316` fabricates par-4
  placeholders; NEVER count those), par total over real holes, par-3/4/5 counts;
- total yardage for the longest tee (reuse `_TEE_PRIORITY` logic from
  `course_guides.py:37-63`);
- per-hole `extract_hole_hazards(...)` aggregate: number of holes with water,
  bunker count, OB presence;
- elevation character: min/max `delta_ft` across green props; tree presence count
  (`trees` features if mapped);
- the same closing invariants as the hole writer: "the COMPLETE list — there are NO
  others" / "NONE mapped. Do not name any specific hazard."

**Structured output** (`messages.parse`, `output_format=`):

```python
class _CourseWriterOutput(BaseModel):
    landscape: str = ""                       # 3-5 sentences, geometry-grounded ONLY
    architect_sentence: str = ""              # one sentence, or ""
    architect_confidence: str = "unknown"     # high | medium | low | unknown
    year_built_sentence: str = ""
    year_built_confidence: str = "unknown"
    style_sentence: str = ""
    style_confidence: str = "unknown"
    history_sentence: str = ""
    history_confidence: str = "unknown"
```

**Networked function** — `write_course_description(course_name, address, ground_truth)`:
the ONLY networked function in the module. `AsyncAnthropic.messages.parse`,
`model=os.getenv("COURSE_INTEL_MODEL", "claude-sonnet-5")`, `thinking={"type": "adaptive"}`,
`max_tokens=3000`, **NO tools** (no web_search — no pause_turn loop needed), cost-guard
log line (`input_tokens/output_tokens`, mirroring `guide_writer.py:286-289`). Stamps
`generated_at`/`model`/`schema_version` itself — never asked of the model.

**System prompt** (`COURSE_WRITER_SYSTEM`): WRITER-not-knower framing adapted for
parametric knowledge:
- GROUND TRUTH block is authoritative for everything physical (holes/par/yardage/
  water/elevation/trees); the model may not contradict or extend it.
- `landscape` must contain NO architect, NO year, NO tournament/championship names,
  NO proper-noun history — routing/terrain/character only, grounded in the block.
- Each `*_sentence` is one plain sentence; confidence is the model's honest
  self-assessment; "when in doubt, say `low` — a dropped fact costs nothing, a wrong
  fact is worse than none."
- Single line each, no markdown, no URLs, no newlines.
- **The two few-shot anchors below, verbatim** (the designer flagged prompt drift as
  the #1 quality risk — these are FIXED string constants, not paraphrased):

Exemplar (target register, shown as a decomposed example — landscape sentences plus
an architect sentence and a history sentence woven to read as one paragraph):

> "Bethpage Black climbs out of the Long Island pines the moment you leave the first
> tee, and it does not come back down until the 18th green. A.W. Tillinghast built it
> broad-shouldered — brawny, uphill par-4s, fairways pinched by rough, greens set
> behind bunkers deep enough to swallow a stance. It has stood up to two U.S. Opens
> and a PGA Championship without softening a line, and the tee sign that warns off the
> ordinary golfer is no idle boast. There is little room for a loose swing here, and
> no shortcut through the closing holes, which rise steadily toward the clubhouse for
> a finish that feels earned rather than given. It is a public course built to
> championship scale — honest, demanding, and unmistakably itself."

Low-confidence fallback anchor (what `landscape`-only must read like — geometry only):

> "The Black plays broad-shouldered from the first tee, uphill and demanding a full
> swing to reach fairways pinched tight by rough. Bunkers sit deep enough to swallow
> a stance, guarding greens that give no easy line in. The finishing holes keep
> climbing, right up to the clubhouse, so the round never really eases off. It is a
> course built to full scale — nothing here plays short, and nothing plays soft."

### 3b. Validator — `validate_course_description(draft, par_total) -> Optional[dict]`

**PURE function** (no LLM, no I/O, deterministic — unit-testable offline exactly like
`validate_guide`). Returns the composed description dict on PASS, `None` on REJECT
(caller writes only the negative-cache marker). Rules, in order:

1. **Injection scan → REJECT ALL**: the exact `validate_guide` regex
   (`guide_writer.py:937-941`: `ignore|instructions?|you are|system prompt|https?://|
   www\.|<[a-z/!]|disregard`) over every field.
2. **Landscape structural → REJECT ALL**: empty after strip; `\n`/`\r` present;
   > 700 chars; markdown markers (`#`, `*`, `- ` at start, backticks).
3. **Fact-leak scan on `landscape` → REJECT ALL** (the confidence gate is worthless if
   facts leak into the unconditional field): case-insensitive scan for
   `\b(1[89]\d{2}|20[0-2]\d)\b` (years), `architect`, `designed`, `redesign`,
   `champion`, `u\.?s\.? open`, `pga`, `ryder`, `walker cup`, `host(ed)?`. Fail-closed:
   we cannot deterministically scrub prose, so a leak rejects the whole draft.
4. **Confidence gate per fact**: keep a `*_sentence` iff its confidence is exactly
   `"high"` AND the sentence is non-empty, ≤ 220 chars, newline-free. Any violation →
   DROP that fact (it is optional data); `medium`/`low`/`unknown` → DROP.
5. **Course-par claim check**: any standalone `par (6\d|7\d)\b` in ANY surviving text
   must equal the real `par_total` (when known) → else REJECT ALL. Cheap, deterministic,
   catches the classic wrong-"par 72".
6. **Compose**: `text = landscape + " " + " ".join(surviving fact sentences)`;
   `provenance = "enriched"` if any fact survived else `"landscape"`;
   `facts_used` = names of survivors. Composed total ≤ 1200 chars else REJECT ALL.

### 3c. Precompute + backfill — `backend/app/services/course_intel.py` (new)

Sibling of `course_guides.py`, same discipline (docstring cross-references
`app.caddie.course_intel` per Decision 7):

- `_precompute_course_intel(course_id)` — best-effort (never raises), idempotent:
  read `courses.course_intel`; skip if `description` OR `attempted_at` present; write
  `{"attempted_at": now}` FIRST (can't mark → don't spend, `course_guides.py:105-115`
  pattern); build ground truth from `get_course`; skip entirely (no marker, no spend)
  when 0 real mapped holes — a landscape description needs geometry; call writer;
  validate; merge `{"description": ...}` into the column on PASS.
- New helpers in `backend/app/services/courses_mapped.py` (owns all `public.courses`
  SQL): `get_course_intel_blob(course_id) -> dict` and
  `merge_course_intel_blob(course_id, patch: dict)` (jsonb `||` merge, parameterized).
- Wire as a BackgroundTask in `backend/app/routes/courses_mapped.py` `create_mapped`
  (~line 105) and `put_mapped` (~line 150), added AFTER `_precompute_course_guides`
  (order comment there is load-bearing).
- `run_course_intel_backfill()` — operator-only, mirrors `run_guide_backfill`
  (`course_guides.py:183-201`): `COURSE_INTEL_BACKFILL_COURSES` (comma-separated UUIDs,
  empty default = no-op), hard-capped by `COURSE_INTEL_BACKFILL_MAX_COURSES`
  (default 1; ops sets 3 for the seed run). Never wired to a route or scheduler.
  Seed = Bethpage Black + Bethpage Red + Pebble Beach ids looked up by the operator
  (`GET /api/courses/mapped?search=…`), never hardcoded.

---

## 4. Builds 2+3 backend — `GET /api/courses/{course_id}/intel`

New file `backend/app/routes/course_intel.py`; `router = APIRouter(prefix="/api/courses",
tags=["course-intel"])`; registered in `backend/app/main.py` BEFORE the catch-all
courses router (house convention per `routes/course_reviews.py` docstring). Auth: the
app-level gate plus `Depends(current_user_id)` for stars scoping — identical to
`list_reviews` (`course_reviews.py:71-90`).

Pure-DB aggregation (in `services/course_intel.py`, `get_course_intel_payload(course_id,
owner_id) -> CourseIntel`), all direct SQL / ORM selects — **never `get_course`** (its
18-hole default fill fabricates par-4s; computing `parTotal` from it would invent
par 72 for a 3-hole-mapped course):

- `description`: from `courses.course_intel` (missing row / empty column → all-null block).
- `stars`: `SELECT AVG(rating), COUNT(*) FROM course_reviews WHERE course_key = :id
  AND owner_id = :owner_id` (ORM select on `CourseReviewORM`). `avg` null iff count 0.
- `parTotal`/`holesMapped`: `SELECT COALESCE(SUM(par),0), COUNT(*) FROM public.holes
  WHERE course_id = :id` — 0 holes → both null.
- `yardageByTee`: join `hole_yardages`→`holes`→`tee_sets`, sum yards per tee name;
  empty → null.
- `roundsPlayed`: `SELECT COUNT(*) FROM rounds WHERE mapped_course_id = :id` (PM
  decision: not owner-scoped, honest by construction — unresolved legacy rounds
  simply don't count).
- `avgScore`: for each such round, resolve the owner's player (`owner_player_id`,
  fallback first `round_players` row — the established API fallback), collect its
  `scores` rows with `strokes IS NOT NULL`; a round is COMPLETE iff it covers every
  mapped `hole_number` of the course (and holesMapped > 0). `avg` of complete-round
  totals, else null. Python-side over small result sets (single-user scale).

Budget invariant: the new route/service files import nothing from `golf.py`, Places,
or GolfAPI paths — verify with the grep sweep in §7. No LLM call is reachable from
the route.

Frontend API: `getCourseIntel(courseId: string): Promise<CourseIntel>` in
`frontend/src/lib/api.ts` next to `getCourseReviews` (~line 529), via the same
`fetchAPI` (auth headers included).

---

## 5. Frontend

### 5a. Map tap-sheet — replace `CourseScoutMap.tsx:402-481`

**Correction to the brief:** `CaddiePanel.tsx` does not exist. The sheet idiom to
mirror is `LooperSheetShell` — `frontend/src/components/LooperSheet.tsx:138-172`
(AnimatePresence; `initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}`,
`transition={T.springSoft}`, `background: `${PAPER_NOISE}, ${T.paper}``,
`backgroundBlendMode: "multiply"`, hairline border, soft upward shadow). Per the
designer this card is a **FLOATING INSET** paper slide-up, not the docked edge-to-edge
shell: keep the current tap-card's inset geometry (`left: 14, right: 14,
bottom: max(14px, env(safe-area-inset-bottom))`, `borderRadius` on ALL corners ~16),
`maxHeight` ~`52dvh`, content scrolls. No new library.

New component `frontend/src/components/course/CourseIntelSheet.tsx`:
- Props: `{ pin: InBoundsCourse; intel: CourseIntel | null; onAdd; onStartRound;
  onViewCourse; onClose }`. Dumb renderer — fetching stays in CourseScoutMap.
- Grabber (36×4 rounded `T.hairline` bar), serif course name (same register as the
  current card: `T.serif` 16→18), mono uppercase subline (`sourceLabelFor`).
- **Ink stars, typographic, never colored**: `★★★★☆`-style glyphs in `T.ink` +
  `4.3 (12)` in `T.mono`; `count === 0` → serif-italic quiet line
  "No reviews yet — play it and be the first." (the empty state IS the content).
- Stats row: MiniStat-style items (mono kicker + serif value) for Holes / Par /
  Rounds played (+ Avg score only when non-null). Whole row omitted when
  `parTotal`/`holesMapped` are null (unmapped pin) — mirrors the `!isCenterOnly`
  Tees guard.
- Description: 2-line clamp (`WebkitLineClamp: 2`) + calm "More" text-button expand
  (serif, no chevron animation); block omitted entirely when `text` is null (a quiet
  "Course notes unavailable." line is acceptable on the detail page only, per PM).
- Actions row: **Start a round** (primary, ink pill like the current Add button),
  **Add** (existing `handleAdd`, unchanged semantics, keeps `data-testid="course-scout-add"`),
  **View course** (quiet text button). All ≥44pt.
- Empty/failed intel: name + subline + Add only. Never a spinner that blocks the
  sheet; never a skeleton shimmer — the sheet opens instantly from `selectedPin`
  (name already known) and intel fades in beneath (opacity transition only).

`CourseScoutMap.tsx` changes:
- `const [intel, setIntel] = useState<CourseIntel | null>(null)`; effect keyed on
  `selectedPin?.id`: clear to null, `getCourseIntel(id).catch(() => null)`, apply only
  if `selectedPin.id` unchanged (stale-guard — replaces cleanly when a second pin is
  tapped; no stacked sheets, `selectedPin` replace semantics untouched).
- **Status-pill offset** (`bottom: selectedPin ? 92 : 20`, line 382): the sheet is now
  tall — hide the pill entirely while `selectedPin` is set (calmer than chasing a
  dynamic height).
- **Pin-toward-top nudge** (designer): on pin select, `setCamera` (via the existing
  `CameraQueue` — `fitBounds` is BANNED per the file header) to the pin's coordinate
  with latitude offset ≈ -35% of the visible span so the pin sits in the upper third,
  above the sheet.
- Backdrop: none (map stays visible/interactive above the inset card); existing
  map-tap-clears-`selectedPin` behavior is the dismissal, plus downward swipe on the
  grabber (framer-motion `drag="y"` + `dragConstraints`, release past threshold →
  close — same pattern family as the shell).

### 5b. Detail page — `frontend/src/app/courses/[id]/CourseDetailClient.tsx`

- `load()` effect (~line 61): add `const intelP = getCourseIntel(courseId!).catch(() => null);`
  and await it in each branch's `Promise.all` (silent-fail convention of line 64).
  Existing `getCourseReviews` call and review rendering UNCHANGED.
- **Rating row** under the header (after Location, inside the header block ending
  ~line 387): ink stars + count, or the honest no-reviews line. Sourced from
  `intel.stars` (same aggregate the map shows — one shape, two renderers).
- **About section** inserted between the header block (ends line 387/388) and the
  Tees section (line 390): mono uppercase kicker "About" (exact style of the Tees
  kicker, lines 392-403), serif body, 2-line clamp + "More" expand (same affordance
  as the sheet), stats MiniStat additions (Rounds played; Avg score only when
  present) alongside the existing Par/Holes MiniStats. When `description.text` is
  null: the quiet serif-italic "Course notes unavailable." line (register of "Tee
  data unavailable.", line 416) — or omit; never invented prose, never a skeleton.
- Shared bits: new `frontend/src/components/course/intel-bits.tsx` exporting
  `InkStars`, `ClampedProse` (used by both surfaces). The page's private `MiniStat`
  (line 670) stays as-is; the sheet carries its own copy of the same 6-line pattern
  (repo convention favors local micro-components over refactor churn).

---

## 6. Offline validator test matrix — `backend/tests/test_course_intel_writer.py`

Pure, no network, no DB, no `DATABASE_URL` needed (module imports only
`course_intel_writer`). This is the correctness crux; QA runs it offline.

| # | Case | Input | Expect |
|---|---|---|---|
| 1 | Confident facts accepted | landscape clean; architect+history `high` | composed text = landscape + both sentences; `provenance="enriched"`; `facts_used=["architect","notable_history"]` |
| 2 | Low/medium/unknown dropped | architect `medium`, year `low`, style `unknown` | all dropped → landscape-only, `provenance="landscape"`, `facts_used=[]` |
| 3 | Thin-fact fallback voice | all facts non-high | output text == landscape verbatim (no appended fragments) |
| 4 | Fact leak into landscape | landscape contains "A.W. Tillinghast"-style claim via `designed`/year `1936`/`U.S. Open` | **None** (reject all — leak cannot bypass the gate) |
| 5 | Injection patterns | any field with `ignore previous instructions`, a URL, `<div`, `you are` | **None** |
| 6 | Newline / length | landscape with `\n`; landscape 701 chars; composed > 1200 | **None** |
| 7 | Fact sentence structural | architect `high` but 300 chars / contains `\n` | that fact DROPPED, rest survives |
| 8 | Wrong course par | text claims "par 72", real par_total 71 | **None**; claims matching 71 → pass |
| 9 | Empty landscape | `""` / whitespace | **None** |
| 10 | Determinism | same draft twice | identical composed dict |

Plus service tests `backend/tests/test_course_intel_service.py` mirroring
`test_course_guides.py` (placeholder `DATABASE_URL`, monkeypatched I/O — copy its
documented anti-`sys.modules`-stub rationale): idempotent skip on existing
description, negative-cache skip on `attempted_at`, marker-write-fails → no spend,
writer-raises → marker only, validator-None → marker only, zero-mapped-holes → no
marker & no spend, success → merged description patch. Backfill: empty env → no-op;
cap enforced.

Integration `backend/tests/integration/test_course_intel_route.py`: seeded courses/
holes/tee_sets/hole_yardages/course_reviews/rounds/scores → full `CourseIntel`
assertions incl. empty-reviews honesty (`avg: null, count: 0`), unmapped row (stats
null, roundsPlayed 0), partial round excluded from `avgScore`, and description
round-trip through the jsonb column (proves the conftest column-add works).

---

## 7. Gates (all must pass before "done")

1. `cd backend && ruff check .`
2. `cd backend && uv run pytest` — unit + the new offline validator matrix + route
   integration against the CI Postgres service (`ci.yml` backend gate).
3. `cd frontend && npx tsc --noEmit`
4. `cd frontend && npm run lint && npm run build`
5. `cd frontend && npx tsx voice-tests/runner.ts --smoke`
6. Budget grep sweep (must return nothing):
   `grep -n "fetchAPI\|searchAll\|searchNearby\|places" backend/app/routes/course_intel.py backend/app/services/course_intel.py backend/app/caddie/course_intel_writer.py frontend/src/components/course/CourseIntelSheet.tsx`
7. Local end-to-end evidence in the PR: real Bethpage Black composed text (verbatim)
   + screenshots of the map sheet and detail page against the local backend.
8. `/security-review` + `/code-review` (new endpoint + new LLM surface — mandatory
   per CLAUDE.md).

---

## 8. Risks & edge cases

- **Self-reported confidence is the only fact signal** (no architect column to check
  against). Mitigations: strict `high`-only gate, fact-leak scan on landscape,
  fail-closed reject-all, and the seed set is 3 world-famous courses where parametric
  knowledge is strongest. Residual risk accepted by the PM spec.
- **Model drift**: anchors are fixed constants; `schema_version: 1` in the stored
  blob allows a future re-write pass.
- **`get_course` default-fill trap** (fabricated par-4s) — stats must come from
  direct SQL; called out in §4; integration test #unmapped covers it.
- **Conftest/prod schema skew**: the guarded supabase SQL can't gain the column; the
  conftest ALTER (precedented) keeps CI honest. If someone later regenerates the test
  schema from 001 alone, the integration description round-trip test fails loudly.
- **Stale intel on re-map**: par/yardage stats are computed live so they never go
  stale; the description references geometry loosely (character, not numbers besides
  course par) — acceptable; a re-mapped course keeps its description (column survives
  by design). Manual refresh = clear the column.
- **`/intel` failure on the map**: Add must keep working — the sheet renders from
  `selectedPin` alone; intel is additive. Acceptance: `Add` works with the network
  tab showing `/intel` 500.
- **Unmapped OSM pin**: honest name-only sheet; `View course` uses
  `courseDetailHref` (`lib/course-url.ts`) with the pin's `source`/`center` so it
  lands on the same unified detail page.
- **Camera nudge**: must go through the existing `CameraQueue`; `fitBounds` is
  banned (native crash, file header `CourseScoutMap.tsx:24`).

---

## 9. File manifest

**Create (backend):** `app/caddie/course_intel_writer.py` · `app/services/course_intel.py`
· `app/routes/course_intel.py` · `migrations/versions/0012_015_course_intel.py` ·
`tests/test_course_intel_writer.py` · `tests/test_course_intel_service.py` ·
`tests/integration/test_course_intel_route.py`
**Touch (backend):** `app/models.py` · `app/main.py` · `app/routes/courses_mapped.py`
· `app/services/courses_mapped.py` · `app/caddie/course_intel.py` (docstring note only)
· `tests/integration/conftest.py`
**Create (frontend):** `src/components/course/CourseIntelSheet.tsx` ·
`src/components/course/intel-bits.tsx`
**Touch (frontend):** `src/lib/types.ts` · `src/lib/api.ts` ·
`src/components/CourseScoutMap.tsx` · `src/app/courses/[id]/CourseDetailClient.tsx`

**Guarded/untouched:** `backend/supabase/migrations/**`, `.env*`, `deploy/**`.
