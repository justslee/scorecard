# Per-round COURSE at tournament setup — implementation plan
`tournament-per-round-format-course` · branch `integration/next` · plan is the build contract
(fable plan, cycle 120, 2026-07-13)

The golf-trip shape: Day 1 Bethpage Black, Day 2 Bethpage Red. Setup assigns a course per
Day in the Program itinerary; drawing round N opens at that day's course with the full
course anchor (satellite map / yardage book / caddie follow). Sibling of the shipped
per-round FORMAT feature (v1.1.5, specs/tournament-per-round-format-plan.md).

> **STATUS (eng-lead, cycle 120): BLOCKED — needs owner decision.** This feature requires
> (a) a guarded Alembic migration (§0/§1) and (b) resolving a discovered gap: there is
> currently NO in-app navigation to `/tournament/[id]/round/new` (§6), so the tournament
> round-creation surface — where the shipped per-round FORMAT lives — is reachable only by
> direct URL. Both are owner decisions. Plan saved as the design record; NOT built this
> cycle. Do not write the migration or the migration-dependent code until the owner approves.

---

## §0 MIGRATION VERDICT (headline): **MIGRATION REQUIRED — one nullable JSONB column, guarded**

The per-day course PLAN must survive setup → draw (days later, possibly another device,
possibly after reinstall). The backlog's "add schema fields" hunch was written before
rounds carried course anchors — re-verified: the ROUND side needs **nothing**
(`rounds.course_id/course_name/course_lat/course_lng/mapped_course_id` all exist,
migration `0009_012_round_course_anchor.py`; `POST /api/rounds` already persists and
round-trips them — `backend/app/models.py:151-171`, integration tests
`test_anchor_roundtrips` / `test_anchor_is_optional_and_null_for_legacy_clients` in
`backend/tests/integration/test_routes.py:378-401`). But the PLAN itself — courses chosen
for rounds that don't exist yet — has no home:

- `tournaments` table (`backend/app/db/models.py:263-283`) has only `num_rounds`,
  `round_ids` JSONB, `player_ids` JSONB. No course/plan column.
- **Option B1 (localStorage write-through, no migration) — REJECTED.** Tournament creation
  is deliberately online-only ("tournament creation requires a server-assigned id",
  `frontend/src/app/tournament/new/page.tsx:227-232`); the tournament is backend-source-
  of-truth everywhere else. A plan that silently evaporates on reinstall/second device is
  exactly the fake-persistence [[no-fake-data-fallbacks]] forbids: the itinerary would
  SHOW "Day 2 · Bethpage Red" on one device and "Course to be drawn" on another.
- **Option B2 (eagerly create N Round rows at setup, course pre-assigned) — REJECTED.**
  Pre-created rounds are visible members everywhere immediately: the round progress strip
  and Rounds tab render every member round (`TournamentPageClient.tsx:618-704, 1178-1445`),
  "Rounds x/y played" becomes N/N, and `computeStandings` iterates all member rounds. It
  also destroys the per-round FORMAT seam (games are chosen at draw time and POSTed with
  the round, `NewTournamentRoundClient.tsx:445, 456-466`) and makes single-course
  tournaments visibly different from today — the hard byte-identical requirement fails.
- **Option A (nullable JSONB `round_courses` on `tournaments`) — CHOSEN.** One additive,
  nullable, no-default column; NULL = exactly today's semantics. Matches the precedent of
  `round_ids`/`player_ids` JSONB on the same table and the additive-nullable pattern of
  migrations 0009/0010.

**GATE (do this FIRST, before any code): the feature is migration-gated.** Alembic
migrations are guarded (`CLAUDE.md`: "schema versioned with Alembic … guarded — don't
edit"). The builder must present §1 below to the owner/eng-lead for approval and STOP —
write neither the migration file nor any code that references `round_courses` until the
migration is approved. If the migration is not approved, the feature does not proceed
(no client-side fallback — see B1 rejection). Everything in §2–§8 lands only after
approval, in one bundle with the migration.

---

## §1 The migration (SPEC ONLY — builder stops here until approved)

New file: `backend/migrations/versions/0011_014_tournament_round_courses.py`

- `revision = "014_tournament_round_courses"`
- `down_revision = "013_caller_voice"` (head as of this plan — re-verify at build time
  with `ls backend/migrations/versions/`)
- Docstring: additive + nullable, per the 0009/0010 house style.

```python
def upgrade() -> None:
    op.add_column(
        "tournaments",
        sa.Column("round_courses", postgresql.JSONB(), nullable=True),
    )

def downgrade() -> None:
    op.drop_column("tournaments", "round_courses")
```

- **Nullable:** yes. **Default:** none (NULL). **Backfill:** none needed — NULL reads as
  "no plan", which is the exact semantics of every existing tournament. Adding a nullable
  no-default column is a metadata-only change in Postgres (no table rewrite, no lock
  hazard). Downgrade is a clean drop (data loss limited to the new feature's own data).
- **Stored shape** (list, index = day−1, length = numRounds at creation; entries are
  either `null` = "to be drawn" or an object mirroring the rounds anchor columns):
  `{"courseId": str, "courseName": str, "courseLat"?: float, "courseLng"?: float,
  "mappedCourseId"?: uuid-str}`.

---

## §2 Shapes in sync (types.ts ↔ models.py, exact edits)

### 2a. `frontend/src/lib/types.ts`
Immediately above `Tournament` (line 216), add:

```ts
/**
 * One day's planned course in a tournament (index = day − 1). Mirrors the
 * rounds course-anchor columns so drawing that day can reconstruct the full
 * CourseSearch selection (anchor + mapped identity). null = "Course to be drawn".
 */
export interface TournamentRoundCourse {
  courseId: string;
  courseName: string;
  courseLat?: number;
  courseLng?: number;
  mappedCourseId?: string;
}
```

In `Tournament` (216-230), after `games?: Game[];` add:

```ts
/**
 * Per-day course plan from setup. Absent/undefined when the owner never
 * touched per-round courses (byte-identical guarantee) and on all
 * pre-feature tournaments.
 */
roundCourses?: (TournamentRoundCourse | null)[];
```

### 2b. `frontend/src/lib/api.ts`
`TournamentCreate` (352-356) and `TournamentUpdate` (358-364) each gain:
`roundCourses?: (TournamentRoundCourse | null)[];` (import the type from `./types`).

### 2c. `backend/app/models.py`
Above `Tournament` (182), add — copying `RoundCreate`'s exact anchor validation
(lines 154-161: lat `ge=-90, le=90`, lng `ge=-180, le=180`, mappedCourseId UUID regex,
same "validate at the edge (422)" comment rationale):

```python
class TournamentRoundCourse(BaseModel):
    courseId: str
    courseName: str
    courseLat: Optional[float] = Field(default=None, ge=-90, le=90)
    courseLng: Optional[float] = Field(default=None, ge=-180, le=180)
    mappedCourseId: Optional[str] = Field(
        default=None,
        pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    )
```

Then:
- `Tournament` (182-191): add `roundCourses: Optional[list[Optional[TournamentRoundCourse]]] = None`
- `TournamentCreate` (194-198): add the same field
- `TournamentUpdate` (200-205): add the same field

### 2d. `backend/app/db/models.py`
`Tournament` (263-283): after `player_ids`, add
`round_courses: Mapped[Optional[list]] = mapped_column(JSONB, nullable=True)`.
(Lands in the SAME commit as the migration — an ORM column without the DB column breaks
every tournaments SELECT.)

### 2e. `backend/app/routes/tournaments.py`
- `create_tournament` (149-172): in the `TournamentORM(...)` constructor add
  `round_courses=(
      [rc.model_dump(exclude_none=True) if rc else None for rc in data.roundCourses]
      if data.roundCourses is not None else None
  ),`
- `_build_full_tournament` (48-104): add `roundCourses=row.round_courses,` to the
  returned `Tournament(...)` (Pydantic validates the JSONB dicts; NULL column → None).
- `update_tournament` (175-225): alongside the other partial-update blocks:
  ```python
  if data.roundCourses is not None:
      row.round_courses = [
          rc.model_dump(exclude_none=True) if rc else None for rc in data.roundCourses
      ]
      flag_modified(row, "round_courses")
  ```

---

## §3 New pure helper module (testable seam): `frontend/src/lib/tournament-course-plan.ts`

Same extraction rationale as `tournament-program.ts` / `tournament-standings.ts` (vitest
without framer-motion). Exports:

- `planEntryFromSelection(c: CourseSelectPayload): TournamentRoundCourse` —
  `{ courseId: String(c.id), courseName: c.name, ...anchorFromSelectedCourse(c) }`
  (reuses `frontend/src/lib/round-anchor.ts` — mapped source → `mappedCourseId`,
  `center` → lat/lng; NO forked anchor logic).
- `selectionFromPlanEntry(e: TournamentRoundCourse): { id: string; name: string; source?: "mapped"; center?: {lat:number;lng:number} }`
  — `id: e.mappedCourseId ?? e.courseId`, `source: e.mappedCourseId ? "mapped" : undefined`,
  `center` when both lat/lng present. Round-trips identity: mapped selections come back
  mapped (yardage book / overlays / caddie follow), centre-only selections come back
  centre-only. No fabricated anchors.
- `applyDayCourseSelection(prev: (CourseSelectPayload|null)[], day: number, c: CourseSelectPayload): (CourseSelectPayload|null)[]`
  — **the "one course for all rounds" default:** if NO entry in `prev` is set (first pick),
  fill EVERY slot with `c`; otherwise set only `prev[day]`. (Pick Black once → whole trip
  at Black; tap Day 2, pick Red → Day 2 overrides.)
- `buildRoundCoursesPayload(dayCourses: (CourseSelectPayload|null)[], numRounds: number): (TournamentRoundCourse|null)[] | undefined`
  — slice to `numRounds`, map through `planEntryFromSelection`; return **`undefined` when
  every slot is null** (the byte-identical gate — untouched itinerary writes NO field).
- `nextDayIndex(t: Pick<Tournament,"roundIds">): number` — `t.roundIds.length` (0-based
  index of the next day to draw).
- `planCourseNameForDay(t: Tournament, day: number): string | null` —
  `t.roundCourses?.[day]?.courseName ?? null` (defensive indexing; used by the tournament
  page ghost card and any future surfaces).

---

## §4 Setup UX — the Program itinerary (`frontend/src/app/tournament/new/page.tsx`)
**Designer-BLOCKING page. Extend, don't clutter. Occasion voice per `tournament-program.ts`.**

New state (near line 35):
- `const [dayCourses, setDayCourses] = useState<(CourseSelectPayload | null)[]>([null, null, null, null]);`
  (fixed length 4 = max `NUM_ROUNDS`; render/submit always slice to `numRounds`, so
  toggling 3→2→3 days preserves choices calmly)
- `const [pickingDay, setPickingDay] = useState<number | null>(null);`

Itinerary Day cards (lines 432-479) become tappable, byte-preserving today's look when
untouched:
- Convert each Day card `motion.div` (435) to `motion.button` with `type="button"`,
  `onClick={() => setPickingDay(i)}`, and additive style props only
  (`textAlign: "left"`, `cursor: "pointer"`, `font: "inherit"` via the existing
  fontFamily props, `minHeight: 44` for tap target). Keep every existing style value
  (borderRadius 12, border `1px solid T.hairline`, padding "10px 12px", the "Day {i+1}"
  mono kicker) unchanged.
- The serif line (462-475): render `{dayCourses[i]?.name ?? "Course to be drawn"}`.
  When set, `color: T.ink`; when unset, keep today's exact `T.pencil` +
  literal string `"Course to be drawn"` — byte-preserved placeholder.
- Update the comment at 430-431 (cards are now interactive).

CourseSearch overlay (bottom of the component, sibling of the existing render tree —
same idiom as `round/new/page.tsx:1620-1637`):

```tsx
<AnimatePresence>
  {pickingDay !== null && (
    <CourseSearch
      voiceSearch                     // voice-first, matches courses page usage (courses/page.tsx:526-527)
      onSelectCourse={(course) => {
        setDayCourses((prev) => applyDayCourseSelection(prev, pickingDay, course));
        setPickingDay(null);
      }}
      onClose={() => setPickingDay(null)}
    />
  )}
</AnimatePresence>
```

ONE unified search path — the shared `CourseSearch` (list + map mode, prefix-first,
append-only, favorites/recent/nearby) per [[course-search-ux-requirements]]. No forked
picker, no new design language.

`handleCreate` (171-234): one addition to the `createTournament` body (194-198):

```ts
const roundCourses = buildRoundCoursesPayload(dayCourses, numRounds);
const created = await createTournament({
  name: name.trim(),
  numRounds,
  playerIds: allPlayerIds,
  ...(roundCourses ? { roundCourses } : {}),
});
```

Copy/voice: no new headings, no new copy helpers needed — the Day cards already speak the
itinerary language ("Day 1 / Course to be drawn"); a chosen course simply replaces the
placeholder with the course name in the same serif slot. `fieldSummary`/`colophonLine`
untouched. Voice prefill (`tournamentPrefillFromParse`) untouched — voice course
assignment at setup is a possible follow-up, NOT faked here (the picker itself is already
voice-capable via `voiceSearch` dictation).

---

## §5 Round-creation flow (`frontend/src/app/tournament/[id]/round/new/NewTournamentRoundClient.tsx`)

### 5a. Replace the legacy `<select>` with unified CourseSearch (+ anchor capture)
Remove: `courses` state + the `apiGetCourses/localGetCourses` effect (214, 262-267),
`selectedCourseId` (215), the `selectedCourse` memo over the legacy list (289-294),
`teeOptions` from legacy `Course.tees` + its effect (294-300), the `<select>` at 700-709
and the legacy tee `<select>` block at 725-751.

Add:
- `const [selectedCourse, setSelectedCourse] = useState<SelectedCourse | null>(null);`
  using the same local `SelectedCourse` shape as `round/new/page.tsx:37-48`
  (id, name, clubName?, location?, holes?, par?, source?, center?).
- `const [showCourseSearch, setShowCourseSearch] = useState(false);`
- Course card (677-763): keep the card + "Course" mono label + `courseError` treatment;
  replace the `<select>` with a full-width button row (mirror the Game card's button
  idiom at 788-829): serif text `selectedCourse?.name ?? "Select a course…"` (italic
  placeholder when null), `›` chevron, `onClick={() => { setShowCourseSearch(true); }}`.
- Tee box: adopt `round/new`'s standard-tee model — copy `TEE_OPTIONS`
  (`round/new/page.tsx:54-60`) and a `tee: TeeId` state (default `"white"`), rendered as
  a `<select>` reusing the existing `selectStyle` (178-191) in place of the legacy tee
  select. `teeLabel = TEE_OPTIONS.find(...).l.split(" · ")[0]`. Keep the
  "Tee boxes can change yardage and pars." footnote (752-762).
- CourseSearch overlay at the component tail, exactly the `round/new:1620-1637` idiom
  (no `onVoiceSearch` — this page has no Realtime panel; pass `voiceSearch` instead).

### 5b. Pre-fill from the plan
In the tournament-load `.then` (239-245), after `setTournament(t)`:

```ts
const entry = t.roundCourses?.[nextDayIndex(t)] ?? null;
if (entry) setSelectedCourse(selectionFromPlanEntry(entry));
```

Drawing Day 2 of the Bethpage trip opens with "Bethpage Red" already in the course slot —
mapped id and centre intact — and the golfer can still tap the row to override via
CourseSearch. No plan / no entry for this day → null → identical to today's "pick it
yourself" default.

### 5c. `handleStartRound` (424-486) — precise changes
Keep: the `!selectedCourse → setCourseError(true)` guard, players mapping, `buildRoundGames`
(445), groups mapping, write-through `localSaveRound`, `roundHref` navigation, error
handling — all unchanged.

Replace the holes/tee derivation + `createRound` body (444, 456-466) with the
`round/new:327-365` snapshot pattern:

```ts
const defaultCourse = createDefaultCourse(selectedCourse.name);
let holeList: HoleInfo[] =
  selectedCourse.holes === 9 ? defaultCourse.holes.slice(0, 9) : defaultCourse.holes;
if (selectedCourse.source === "mapped" && selectedCourse.id) {
  try {
    const mapped = await fetchMappedCourse(String(selectedCourse.id));
    // same filter/sort/namesMatch(teeLabel) yardage snapshot as round/new:348-361
    if (snapshot.length > 0) holeList = snapshot;
  } catch { /* offline — honest pars-only default, never fabricated yards */ }
}

const created: Round = await createRound({
  courseId: String(selectedCourse.id),
  courseName: selectedCourse.name,
  ...anchorFromSelectedCourse(selectedCourse),   // ← the currently-missing anchor
  teeId: tee,
  teeName: teeLabel,
  players,
  holes: holeList,
  groups: playerGroups.length > 0 ? playerGroups : undefined,
  games,
  tournamentId,
});
```

New imports: `CourseSearch`, `anchorFromSelectedCourse`, `fetchMappedCourse`,
`namesMatch`, `createDefaultCourse`, `HoleInfo`, helpers from
`tournament-course-plan.ts`. This closes the standing bug that tournament rounds carry no
anchor (no satellite map): `courseLat/courseLng/mappedCourseId` now flow into
`POST /api/rounds`, which already persists them — yardage book / overlays / caddie follow
with zero further backend work.

---

## §6 Entry point — DISCOVERED GAP (verified by eng-lead cycle 120): nothing navigates to the draw page
Grep of `frontend/src` finds **zero** links/pushes to `/tournament/[id]/round/new`
(`TournamentPageClient.tsx`'s only navigations: `router.push("/")` ×2,
`router.push(roundHref(r.id))` ×2). `NewTournamentRoundClient` is imported ONLY by its own
`page.tsx`, and the standalone `/round/new` has no `tournamentId` handling — so there is NO
in-app way to add a round to a tournament today. Without an entry, §5 is unreachable, and
the shipped-v1.1.5 per-round FORMAT feature is reachable only by direct URL.
**This is a product-shape decision for the owner** (how should rounds be added to a
tournament?). One calm option in the existing itinerary idiom:

- `frontend/src/lib/round-url.ts`: add
  `export function tournamentRoundNewHref(id: string): string { return \`/tournament/${ROUND_VIEW_SEGMENT}/round/new?id=${encodeURIComponent(id)}\`; }`
  (same static-path+query trick as `tournamentHref`, lines 22-25 — a real dynamic segment
  hard-navigates and cold-boots under the Capacitor static export).
- `frontend/src/app/tournament/[id]/round/new/page.tsx`: `generateStaticParams` returns
  `[{ id: "view" }]` (was `"placeholder"`, which emitted an unreachable path); wrap the
  client in `<Suspense>` (it will read `useSearchParams`), mirroring
  `tournament/[id]/page.tsx:12-19`.
- `NewTournamentRoundClient.tsx` (205-208): resolve the id query-first:
  `const search = useSearchParams(); const tournamentId = search?.get("id") ?? params?.id;`
- `TournamentPageClient.tsx` round progress strip (618-704): change the gate to
  `{(hasRounds || (tournament.numRounds ?? 0) > 0) && (` and, after the `memberRounds.map`
  cards, when `memberRounds.length < (tournament.numRounds ?? 0)` append ONE ghost card
  (button; same flex/padding/radius as siblings but `border: 1px dashed T.hairline`,
  transparent background): mono kicker `Day {memberRounds.length + 1} · upcoming`
  (`T.pencilSoft`), serif line
  `planCourseNameForDay(tournament, memberRounds.length) ?? "Course to be drawn"`
  (`T.pencil`), `onClick={() => router.push(tournamentRoundNewHref(tournament.id))}`.
  One ghost only — the NEXT day, not all remaining days (calm, not a dashboard).

This is a user-visible addition on the tournament page for every tournament with a
planned round count — flag it to the designer explicitly as part of this feature's review.

---

## §7 The byte-identical guarantee (single-course tournament, owner never touches per-round courses)
1. **Setup page:** untouched Day cards render the literal `"Course to be drawn"` in the
   same slot, same `T.pencil`, same card styles — only additive interactivity (§4).
2. **POST body:** `buildRoundCoursesPayload` returns `undefined` when no day was set →
   `roundCourses` key is NOT in the `createTournament` body → `tournaments.round_courses`
   stays NULL → GET returns `roundCourses: null` (same null-field pattern as
   `playerNamesById` today). No plan data is ever written-but-inert; it is simply not
   written.
3. **Draw flow:** NULL plan → no pre-fill (§5b no-ops) → the golfer picks a course exactly
   as before. (The picker itself upgrades from the legacy `<select>` to the unified
   CourseSearch for ALL tournament rounds — that is a deliberate, mandated part of this
   feature (anchor capture + [[course-search-ux-requirements]] one-search-path), not a
   plan side-effect; semantics of "no plan" are unchanged: nothing pre-selected, golfer
   chooses, round is created with their choice.)
4. **Existing tournaments:** rows read `round_courses = NULL` → `roundCourses: null` →
   every consumer (`?.[day]` indexing) no-ops.

## §8 Standings / settlement — untouched (verified)
`computeStandings` (`frontend/src/lib/tournament-standings.ts:81-152`) consumes only
`r.scores` + `r.holes` (per-round par snapshot via `calculateTotals`) + per-player rounded
handicap — no course identity anywhere. Tournament settlement
(`computeTournamentSettlement` / `settlement.ts`) settles per-round game ledgers, also
course-blind. Per-round course variance therefore introduces NO math change. **Honest
follow-up (do NOT fake):** true per-course handicap adjustment (course rating/slope →
different course handicap at Black vs Red) needs rating data the app doesn't store; today's
model is one manually-set handicap per player applied to every round. File as a follow-up
backlog note; do not silently "adjust" anything here.

---

## §9 Gates & tests

Frontend unit (vitest, `cd frontend && npx vitest run`):
- NEW `frontend/src/lib/tournament-course-plan.test.ts`:
  - untouched itinerary → `buildRoundCoursesPayload(...)` is `undefined` (byte-identical gate);
  - first pick fills all days; second pick overrides only its day (`applyDayCourseSelection`);
  - round-trip `selectionFromPlanEntry(planEntryFromSelection(x))` preserves mapped id +
    `source:"mapped"` + centre (mapped case), centre-only (OSM/GolfAPI case), and bare
    name/id (no-anchor case) — never fabricates an anchor;
  - `buildRoundCoursesPayload` slices to `numRounds`; `nextDayIndex` = `roundIds.length`.
- EXTEND `frontend/src/lib/tournament-standings.test.ts`: two member rounds with
  different `courseId/courseName` but identical holes/scores produce standings identical
  to the same-course case (course variance is inert).
- EXTEND `frontend/src/lib/settlement.tournament.test.ts`: one case where per-round games
  sit on rounds with different courses — transfers unchanged vs same-course fixture.

Backend (pytest; DB-backed tests run in CI — no local Postgres):
- EXTEND `backend/tests/integration/test_routes.py` (mirror `test_anchor_roundtrips`,
  378-401): `test_tournament_round_courses_roundtrip` — POST a tournament with
  `roundCourses: [ {full mapped entry}, null ]` → GET returns it verbatim; PUT replaces
  it; POST **without** the field → GET returns `roundCourses: null`; invalid
  `mappedCourseId` (non-UUID) → 422.

Standing gates (all must pass before done):
- `cd frontend && npm run lint`
- `cd frontend && npx tsc --noEmit`
- `cd frontend && npm run build`
- `cd frontend && npx tsx voice-tests/runner.ts --smoke`
- `cd backend && ruff check .`

## §10 Build order
0. **STOP-gate:** present §1 migration spec for owner approval AND resolve the §6
   entry-point product decision. No code before both.
1. Migration file (§1) + `db/models.py` column (§2d) + Pydantic (§2c) + routes (§2e) +
   backend test (§9) — one commit.
2. Shapes: `types.ts` + `api.ts` (§2a/2b) + `tournament-course-plan.ts` (§3) + its tests.
3. Setup UX (§4).
4. Round-creation upgrade + pre-fill (§5).
5. Entry point (§6).
6. Gates (§9); designer review (setup page + tournament-page ghost card + draw page);
   `/security-review` + `/code-review` per CLAUDE.md (new endpoint field + user-facing
   capability).
