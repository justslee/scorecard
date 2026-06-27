# Progress log

The team writes here so work survives context resets and usage-limit pauses.
Format: date — done / in-progress / blocked.

## 2026-06-21
- **Done:** Phase 0 foundation — project `CLAUDE.md`, `.claude/settings.json` +
  `guard.sh` guardrail hook (tested), the 8-agent team in `.claude/agents/`,
  and a seeded `backlog.json`.
- **In progress (local, safe):** CI workflow, Playwright smoke tests, the limit
  governor, the release email/clip templates, and the `scorecard-ai-team.md`
  concept doc.
- **Blocked / awaiting owner go:** create the Notion board, enable Vercel
  previews + staging, GitHub branch protection on `main`, set the $50 usage-credit
  cap, and schedule the first (dry-run) routine.
- **First task when the loop starts:** `test-games-engine` (lowest risk).

## 2026-06-23
- **Plan pivot (approved):** secure, owner-only **native iOS beta** (TestFlight via
  Xcode Cloud) on **AWS** (RDS replaces Supabase), email approvals, **always-on**
  agent team on the EC2. Full plan: `~/.claude/plans/snazzy-sniffing-summit.md`.
- **Done:** Phase A2 — owner-only auth gate → **PR #24** (`feat/owner-only-auth-gate`).
  Discovery: `backend/app/db/engine.py` already uses a generic `DATABASE_URL`/asyncpg,
  so the backend is already RDS-ready — "dropping Supabase" is mainly a frontend + config change.
- **Next:** B1/A3 — relocate course CRUD to the backend over the DB, remove the client
  Supabase path + `NEXT_PUBLIC_SUPABASE_*`, and remove the browser Anthropic key (`ocr.ts`).
- **Owner-only (blocked on you):** AWS infra (RDS, Secrets Manager, IAM, ALB/ACM, CloudWatch),
  Apple/Xcode Cloud setup, rotate keys, `deploy/` + EC2 systemd units, Settings → Usage $50 cap.

### 2026-06-23 (later)
- Shipped **PR #25** (`feat/ocr-server-side`): scorecard OCR moved server-side, browser
  Anthropic key removed. Plus `.gitignore` hardened, `infra/looper-aws.yaml` CloudFormation
  drafted (owner reviews + applies; guardrail blocks `deploy/`), `release-manager` rewritten
  for the TestFlight/always-on loop, git-sync added to `eng-lead`/`builder`, `OWNER_SETUP.md` written.
- **Open PRs for owner review:** #24 (auth gate), #25 (OCR server-side), #26 (caddie client authed), #27 (dead apiKey removed).
- **Clean no-infra wins: DONE** (#24–#27). **Remaining is RDS-gated** (verify against the real
  backend, so do it after RDS is up): course CRUD → new `/api/courses/mapped` routes over RDS,
  then repoint `golf-api.ts` + `voice-parser.ts` (the backend parse-transcript returns a
  different shape — verify before swapping), then B3 static export. Then Capacitor (C).

## 2026-06-26
- **Done:** backlog `voice-nickname-jt` (priority 1) → **PR #47** (`fix/voice-nickname-jt`).
  Made the local score parser's explicit-pattern pass nickname-aware (`aliasesForPlayer`),
  with a collision guard so a real `JT` player isn't conflated with `Justin`. Fixes the last
  failing smoke case. Gates: **voice-tests 260/260**, tsc clean, build OK, no new lint.
  Minor change (no auth/data/endpoints/deps) — eng-lead ran an adversarial reviewer pass; not
  pinging owner. **Follow-up:** promote voice-tests to a *required* CI gate (separate PR).
- **Done:** backlog `db-core-schema` (P1, SILENT) — Alembic + core scoring schema.
  - Added `alembic>=1.13.0` to `backend/pyproject.toml`; installed (1.18.5).
  - Created `backend/alembic.ini` + `backend/migrations/` (env.py async, script.py.mako).
  - Revision `001_baseline` (empty no-op): marks caddie tables 001–004 as already applied.
  - Revision `002_core_scoring` (005_core_scoring): creates 8 new tables: players,
    golfer_profiles, tournaments, rounds, player_groups, round_players, scores, games.
  - Added ORM models (Player, GolferProfile, Tournament, Round, PlayerGroup, RoundPlayer,
    Score, Game) to `backend/app/db/models.py`.
  - Gates: ruff clean, ORM import clean, alembic offline SQL clean, voice-tests 260/260.
  - DB application deferred to EC2 deploy box. Deploy protocol:
      DATABASE_URL=<real> uv run alembic stamp 001_baseline
      DATABASE_URL=<real> uv run alembic upgrade head
  - SILENT — no TestFlight-visible change.
- **Done:** backlog `api-contract-align` (Phase 0, SILENT) — rewrite `frontend/src/lib/api.ts`
  and `frontend/src/lib/storage-api.ts` to match the real FastAPI/Pydantic contract.
  Key fixes:
  - All interfaces now camelCase (matching `backend/app/models.py` + `frontend/src/lib/types.ts`).
  - Domain types imported from `types.ts` instead of redefined in api.ts.
  - `updateRound` changed from `PATCH` → `PUT`; body now `RoundUpdate {scores,games,groups,status}`.
  - `addScore` body now camelCase `{playerId,holeNumber,strokes}`; return type `Round` not `Score`.
  - `createRound` body camelCase; `players` now includes `id` (required by backend Pydantic model).
  - Removed `RoundListItem` (backend returns full `Round[]`); removed N+1 getRound-per-item calls.
  - `updateTournament` changed from `PATCH` → `PUT`; body camelCase.
  - `addPlayerToTournament` fixed to path-param style `/api/tournaments/{id}/players/{playerId}`.
  - `searchCourses` removed (backend has no `?q=` param); replaced with `getCourses()`.
  - Added Players API (`getPlayers`, `createPlayer`, `updatePlayer`, `deletePlayer`).
  - Removed `addPlayerToRound` (endpoint doesn't exist).
  - Removed Games CRUD (`getGame/createGame/updateGame/deleteGame` — no `/api/games` route).
  - Profile functions stubbed with `// TODO(backend-profile-endpoint)` — return null, no HTTP calls.
  - `storage-api.ts`: replaced silent `catch → localStorage` swallowing with `console.error` +
    explicit offline fallback; removed snake_case converters (no longer needed); profile functions
    simplified to localStorage-only; `saveRoundAsync` sends full scores in one PUT instead of
    N individual addScore calls; player `id` field now included in `createRound`.
  - Gates: tsc clean, lint clean (src/), voice-tests 260/260, build ✓.
  - SILENT — no TestFlight-visible behavior change for un-migrated screens.
- **Done:** backlog `backend-players-db` (P3, Phase 1, SILENT) — `routes/players.py` CRUD
  migrated from JSON-file storage to Postgres `players` table (ORM revision 002_core_scoring).
  - Rewrote all five endpoints (GET list, GET id, POST, PUT, DELETE) to use the async SQLAlchemy
    session (`async with async_session() as db`), filtering every query by `owner_id == current_user_id`.
  - camelCase Pydantic contract (SavedPlayer / PlayerCreate / PlayerUpdate) preserved unchanged;
    ORM → Pydantic mapping in `_orm_to_pydantic`.
  - Removed `players_storage = JSONStorage("players.json", SavedPlayer)` from `storage.py` and
    removed `SavedPlayer` from that file's late import.
  - Removed the 11-player seeding block from `seed_default_data`; course seeding remains
    (rounds/tournaments/courses migrate in later items).
  - Gates: ruff clean, AST parse OK, tsc clean, voice-tests 260/260, build OK.
  - Functional DB verification deferred to EC2 deploy (DATABASE_URL not set locally; import
    of app.main already required DATABASE_URL pre-change due to caddie/shots/pins routes).
  - SILENT — no TestFlight-visible change.
- **Done:** backlog `backend-rounds-scores-db` (P4, Phase 1, SILENT) — `routes/rounds.py` round +
  normalised scores/players/groups/games migrated to Postgres (ORM revision 002_core_scoring).
  - All 6 endpoints rewritten (GET list, GET id, POST create, PUT update, POST scores upsert,
    POST complete, DELETE) using async SQLAlchemy session, owner_id scoping via `current_user_id`.
  - Normalisation: rounds row (JSONB holes), round_players (player_id + handicap + group_id),
    player_groups, scores (upsert on constraint `scores_round_player_hole_uq` via pg_insert
    ON CONFLICT), games (round_id FK).
  - Reassembly: `_build_full_round` joins players table for names; falls back to "Unknown" for
    deleted-roster players (cross-domain plain-text FK, per spec §C loosely coupled).
  - Tournament linkage: POST adds round_id to tournament.round_ids JSONB; DELETE removes it;
    `flag_modified` used to mark JSONB list changes to SQLAlchemy session.
  - Pydantic `Game` model updated: added `roundId: Optional[str] = None` and
    `teams: Optional[list] = None` (closes review follow-up; aligns with types.ts Game.roundId
    + Game.teams, avoids silent data loss for team-format games).
  - Removed `rounds_storage = JSONStorage("rounds.json", Round)` from `storage.py`.
  - Fixed `routes/tournaments.py`: removed broken `rounds_storage` import; tournament-delete
    round cleanup deferred to `backend-tournaments-db` (Postgres rounds' FK is SET NULL).
  - Gates: ruff clean, `import app.main` clean (no live DB), tsc clean, voice-tests 260/260,
    build OK.
  - Functional DB verification deferred to EC2 deploy (DATABASE_URL not set locally).
  - Pre-existing frontend lint issue in `ios/App/App/public/_next/static/` (compiled Capacitor
    assets not excluded from ESLint) and `src/app/players/page.tsx` (pre-existing setState-in-effect
    warning) — both unrelated to this item.
  - SILENT — no TestFlight-visible change.
- **Done:** backlog `backend-tournaments-db` (P5, Phase 1, SILENT) — `routes/tournaments.py` CRUD
  migrated from JSON-file storage to Postgres `tournaments` table (ORM revision 002_core_scoring).
  - All 6 endpoints rewritten (GET list, GET id, POST create, PUT update, DELETE, POST players/{id})
    using async SQLAlchemy session, owner_id scoping via `current_user_id`.
  - `id` is now a real UUID (`str(uuid.uuid4())`), so rounds can FK to tournaments via
    `rounds.tournament_id` — the guarded linkage in `create_round` activates automatically.
  - `playerNamesById` derived on read via a join to the `players` table (owner-scoped, same
    pattern as `_build_full_round` in rounds.py). No separate JSONB column needed; falls back to
    "Unknown" for deleted-roster players. `player_name` query param on add-player is still accepted
    for API compat but no longer stored (players table is source of truth for names).
  - Tournament-scoped games loaded from the `games` table (tournament_id FK, round_id NULL);
    wholesale-replaced (delete-then-insert) on PUT when data.games is supplied.
  - DELETE cascades to tournament-scoped games (FK ondelete='CASCADE'); linked rounds have
    tournament_id SET NULL (FK ondelete='SET NULL') — round rows preserved.
  - Removed `tournaments_storage = JSONStorage("tournaments.json", Tournament)` from `storage.py`
    and removed `Tournament` from that file's late import.
  - Gates: ruff clean, `import app.main` clean (no live DB), tsc clean, voice-tests 260/260,
    build OK.
  - Functional DB verification deferred to EC2 deploy (DATABASE_URL not set locally).
  - SILENT — no TestFlight-visible change.
- **Done:** backlog `backend-courses-db` (P6, Phase 1, SILENT) — `routes/courses.py` scoring
  courses migrated from JSON-file storage to Postgres `scoring_courses` table (new Alembic
  migration `006_scoring_courses`).
  - New Alembic revision `006_scoring_courses` (file `0003_006_scoring_courses.py`): creates
    `scoring_courses` table — id (UUID), owner_id (Text nullable), name (Text), location
    (Text nullable), holes (JSONB — list of HoleInfo), tees (JSONB nullable — list of TeeOption),
    created_at, updated_at. Owner index: `scoring_courses_owner_id_idx`.
  - New ORM class `ScoringCourse` added to `backend/app/db/models.py` with matching columns.
    Intentionally separate from the PostGIS `courses`/`tee_sets`/`holes` tables (caddie/import,
    migration 001 baseline) — unification is a deliberate future refactor.
  - Rewrote all 5 endpoints in `routes/courses.py` (GET list, GET {id}, POST, POST /default,
    DELETE) using `async with async_session() as db`, filtering every query by
    `owner_id == current_user_id`. camelCase Pydantic contract (Course / CourseCreate /
    HoleInfo / TeeOption) preserved unchanged; ORM → Pydantic mapping in `_orm_to_pydantic`.
  - Removed `courses_storage = JSONStorage("courses.json", Course)` from `storage.py`.
  - `seed_default_data` is now a no-op (all 4 domains Postgres-backed): kept as empty function
    body with comment, the startup call in `main.py` removed to avoid dead code.
  - Follow-up note added to `specs/real-data-wiring-plan.md`: course-identity unification
    (scoring_courses vs mapped-courses PostGIS tables) deferred as a future refactor.
  - Mapped-courses path (`routes/courses_mapped.py`, `services/courses_mapped`) untouched.
  - Gates: ruff clean, `DATABASE_URL=... alembic upgrade head --sql` renders `scoring_courses`
    table cleanly, `import app.main` clean, tsc clean, voice-tests 260/260, build OK.
  - Functional DB verification deferred to EC2 deploy (DATABASE_URL not set locally).
  - SILENT — no TestFlight-visible change.
- **Done:** backlog `backend-profile-endpoint` (P7, Phase 1, SILENT) — new `routes/profile.py`
  (`GET/POST/PUT /api/profile/golfer`) backed by the `golfer_profiles` Postgres table; frontend
  client un-stubbed.
  - Shape reconciliation: ORM `golfer_profiles` (migration 002_core_scoring) lacked `name` (display
    name) and a free-text `home_course` field (had only `home_course_id`, a course-ID reference).
    Frontend `GolferProfile` (types.ts) requires `name` (str), `handicap` (float|null),
    `homeCourse` (str|null), `clubDistances` (JSONB dict).
  - New Alembic revision `007_golfer_profile_fields` (`0004_007_golfer_profile_fields.py`): adds
    `name TEXT NULL` and `home_course TEXT NULL` to `golfer_profiles`. `home_course_id` kept for
    future caddie cross-reference. Revision chain: 007 revises 006_scoring_courses.
  - ORM `GolferProfile` updated (`db/models.py`): added `name: Optional[str]` and
    `home_course: Optional[str]` mapped columns.
  - Pydantic models added to `models.py`: `GolferProfile` (response), `GolferProfileCreate`
    (POST body), `GolferProfileUpdate` (PUT body). All camelCase: `handicap` ← `handicap_index`,
    `homeCourse` ← `home_course`, `clubDistances` ← `bag_clubs`.
  - New `backend/app/routes/profile.py`:
    - `GET /api/profile/golfer` — returns 200+body when profile exists, 204 No Content when none.
    - `POST /api/profile/golfer` — create; 409 if already exists.
    - `PUT /api/profile/golfer` — upsert (create or partial-update). Preferred for saves.
    - Owner scoping: `user_id == current_user_id`; `require_owner` gate applied in `main.py`.
  - `main.py`: registered `profile.router` under `_owner_only` dependencies.
  - Frontend `api.ts`: replaced null-return/throw stubs with real HTTP calls.
    - `getGolferProfileAsync()` — GET; handles 204 → null; auth-checks before calling.
    - `createGolferProfile(data)` — POST with typed `GolferProfileCreate` body.
    - `updateGolferProfile(data)` — PUT with typed `GolferProfileUpdate` body (upsert).
    - `GolferProfile` re-exported from api.ts.
  - Frontend `storage-api.ts`: `getGolferProfileAsync` / `saveGolferProfileAsync` now API-
    authoritative (API call + write-through to localStorage on success; localStorage fallback
    on API failure with `console.error`). `saveGolferProfileAsync` calls `updateGolferProfile`
    (PUT upsert). Removes the `// TODO(backend-profile-endpoint)` stubs.
  - Profile UI page (`app/profile/page.tsx`) intentionally untouched — that is a later `wire-profile-*` item.
  - Gates: ruff clean, `alembic upgrade head --sql` renders 007 columns cleanly,
    `import app.main` clean (DATABASE_URL=fake), tsc clean, voice-tests 260/260.
  - Functional DB verification deferred to EC2 deploy.
  - SILENT — no TestFlight-visible change; `useGolferProfile` hook not imported by any screen yet.
- **Done:** backlog `json-to-db-backfill` (P9, Phase 1, SILENT) — one-off idempotent
  migration script `backend/scripts/backfill_core_data.py` that imports all four
  `backend/data/*.json` files into Postgres and retires the stale JSON files.
  - Reads players.json → `players`, courses.json → `scoring_courses`,
    tournaments.json → `tournaments` + tournament-scoped `games`,
    rounds.json → `rounds` + `round_players` + `player_groups` + `scores` + round-scoped `games`.
  - Legacy non-UUID ids (e.g. `player-ryan-murphy`, `course-augusta`) are mapped to
    deterministic UUID v5 values (namespace=NAMESPACE_URL) so every re-run produces
    the same DB primary key for the same source record.
  - Cross-table remapping: player_id_map, course_id_map, tournament_id_map built in
    order; round.courseId / round.tournamentId / player references all remapped.
    Second pass patches tournament.round_ids with new round UUIDs after rounds import.
  - Upserts: players/courses/tournaments/rounds/games use ON CONFLICT (id) DO UPDATE;
    round_players uses ON CONFLICT ON CONSTRAINT round_players_round_player_uq;
    scores uses ON CONFLICT ON CONSTRAINT scores_round_player_hole_uq. Fully
    idempotent — re-runs skip/update without duplicating.
  - Owner assignment: --owner-id CLI arg (falls back to $OWNER_CLERK_USER_ID); fails
    with a clear error if neither is supplied.
  - Dry-run: --dry-run prints the full import plan (UUIDs per record) with NO DB
    connection. Demonstrated: 11 players + 3 courses → deterministic UUIDs shown.
  - File retirement: after successful commit renames data/<name>.json →
    data/<name>.json.imported (never hard-deletes); idempotent re-runs no-op cleanly.
  - Deploy runbook line: `cd backend && DATABASE_URL=<RDS_URL> uv run python -m scripts.backfill_core_data --owner-id $OWNER_CLERK_USER_ID`
  - Gates: ruff clean, import clean (DATABASE_URL fake), dry-run demo clean (no DB),
    tsc clean, voice-tests 260/260.
  - SILENT — no TestFlight-visible change; script runs once on EC2 deploy box.
- **Done:** backlog `test-games-engine` (P2, SILENT) — 46 unit tests for `lib/games.ts`
  via Vitest (already a devDep + `test` script; no new dependencies added).
  - New file: `frontend/src/lib/games.test.ts` (picked up by `vitest.config.ts` pattern
    `src/**/*.test.ts`).
  - Covers all 7 exported compute* functions + the `computeGameResults` dispatcher:
    skins (7 tests), bestBall (4), nassau (5), threePoint (5), stableford (5),
    matchPlay (5), wolf (7), dispatcher (8). Total: 46 tests, 46 pass.
  - Edge cases: carryover multi-tie chains, partial rounds, ties (null winner),
    lone-wolf win/loss (+3/-3), partner mode win/loss (+1 each), match-play early end
    ("10 & 8"), NO_SCORE holes, empty playerIds falling back to round.players,
    modifiedStableford routing to computeStableford, unimplemented format → {}.
  - Documented stub: nassauMode='match' always uses stroke totals (P21 pending) —
    asserted as current behavior, marked with a STUB comment, NOT fixed.
  - No bugs found that warrant stopping; all format outputs match expected behavior.
  - Gates: npm test 46/46 pass, lint clean (src/), tsc --noEmit clean,
    voice-tests 260/260 pass, npm run build OK.
  - SILENT — runtime-neutral (test file only, no app code modified, no lib/games.ts
    changes).
- **Done:** backlog `test-voice-pipeline` (P30, SILENT) — unit tests for the voice
  pipeline's schemas + normalization, complementing the integration harness.
  - New files (no app code touched):
    - `frontend/src/lib/voice/parseVoiceScores.test.ts` — 46 tests for `parseVoiceScoresLocally`:
      STT number-word normalization (ford/fore/four/ate/won/too/to/tree → integers), all six
      score-phrasing patterns (made a / got a / with a / shot a / shot / bare), golf-term
      scoring (birdie/eagle/bogey/double/par at any par value), everyone-par (8 variants
      incl. "all bogey" / "everybody double"), conjunction splitting (and / comma / then /
      no-punctuation chains), nickname resolution (jt→Justin, mike→Michael, bob→Robert),
      collision guard (PR #47): when "JT" is a literal player "jt" matches JT not Justin,
      edge cases (empty/filler/uppercase/key-casing/prefix match).
    - `frontend/src/lib/voice/schemas.test.ts` — 46 tests for Zod schemas: GameFormatSchema
      (all 8 valid formats + 3 invalid), VoiceScoreParseResultSchema (6 valid + 11 invalid
      incl. hole=0, float hole, negative/fractional score, confidence out-of-range, extra
      fields, missing required fields), ParsedGameConfigSchema, ParsedTournamentConfigSchema,
      VoiceParseResultSchema (game + tournament paths, normalization field, matchPlay settings).
    - `frontend/src/lib/voice/utils.test.ts` — 47 tests: parseSpokenNumber (27 words incl.
      all STT variants; confirms "ford" is NOT in utils WORD_NUMBERS — only in parseVoiceScores
      WORD_TO_NUM), normalizeName, clamp01, levenshtein, similarity (incl. 0.92 prefix-match
      constant), fuzzyBestMatch (custom minScore threshold), safeJsonExtract (fenced + bare JSON),
      stripFillerWords, normalizeTranscript (basketball→best ball ASR fix).
  - BUGS FOUND (not fixed — behavior-change blocked while PR #51 is in review):
    1. `parseVoiceScoresLocally` regex: `"for"` (listed in WORD_TO_NUM as 4) is absent from
       both the first-pass and second-pass capture-group alternations. "Justin with a for"
       produces no score. `parseSpokenNumber` in utils.ts DOES handle "for" → 4, so the gap
       is only in parseVoiceScores.ts's own regex alternations.
    2. `parseVoiceScoresLocally` everyone-pattern: "everybody dbl bogey" matches the regex
       (alternation has "dbl bogey") but the value-selector checks `t.includes("double")`
       (false for "dbl") and falls through to `t.includes("bogey")` → returns par+1 instead
       of par+2. Inconsistent with "dbl bogey" being in the regex.
  - Gates: npm test 230/230 pass (was 46/46 + 184 new), tsc 0 errors, voice-tests 260/260,
    build OK, new test files lint-clean.
  - SILENT — runtime-neutral (test files only, zero app/lib/voice code changes).
- **Next ready backlog items:** `frontend-lint-cleanup` (P9), `tee-time-finder` Phase 1 (P8).

## 2026-06-26 (wire-leaderboard-real)
- **Done:** backlog `wire-leaderboard-real` (P12, NOTICEABLE) — replaced `LB_MOCK` with
  real computation from `lib/games.ts` via the round's real scores.
  Key changes:
  - **Removed:** `LB_MOCK` constant (nassau/skins/threePoint hardcoded mid-round state).
  - **Tabs now dynamic:** `TABS` replaced with computed list — always "Overall" first, then
    one tab per game in `round.games` (uses game id as tab key). Tab label includes
    `game.settings.pointValue` if set (e.g. "Nassau · $20").
  - **New `round` prop on `LeaderboardSheet`:** `RoundPageClient` passes `round={round}`
    so the sheet can read `round.games` and build the engine call.
  - **Engine wiring:** `computeGameResults(engineRound, game)` called for each game;
    `engineRound` has `round.scores` replaced with the display-scores map converted to
    `Score[]` via `displayScoresToArr()` — so pending (not-yet-confirmed) scores are
    included in game computations.
  - **Nassau:** real `NassauResults` — F9/B9/overall winner grid, running totals table.
    `scope=team` uses team names from `game.teams`; `scope=individual` uses player names.
    When `nassauResults.mode === 'match'`, a calm note explains that match-play scoring
    is pending P21 and stroke totals are shown instead.
  - **Skins:** real `SkinsResults` — per-player skin count, holes won; pot-carrying
    callout computed from `holeWinners` + display scores (played-hole detection). Shows
    "up for grabs" value if `game.settings.pointValue` is set.
  - **3-Point:** real `ThreePointResults` — team A vs B scoreboard using real points;
    team names from `game.teams`.
  - **Generic fallback:** `GenericGame` handles bestBall, stableford, matchPlay, wolf, and
    unknown formats — shows a minimal score/status display in the yardage-book aesthetic.
  - **Empty states:** no games → "No games yet" prompt shown below Overall tab. No scores
    yet for a format → calm italic "Scores will appear here as you play." (or format-
    specific equivalent). Match-play Nassau shows stroke-total note (P21 pending).
  - **No new design language:** all inline styles use T.* tokens; no new deps; existing
    Tab, DotStrip, Overall sub-components preserved unchanged.
  - **Games.ts functions used:** `computeGameResults` (dispatch), `computeSkins`,
    `computeNassau`, `computeThreePoint`, `computeMatchPlay`, `computeStableford`,
    `computeBestBall`, `computeWolf` (via the dispatch switch — all formats).
  - **Data flow:** `RoundPageClient.round.games` (from backend) + display `scores`
    (pending overlay included) → `computeGameResults` → `NassauResults | SkinsResults |
    ThreePointResults | ...` → tab-specific render component.
  - **Match-play Nassau (P21):** engine comment preserved ("falls back to stroke totals");
    UI shows a note on the Nassau tab when `nassauResults.mode === 'match'`.
  - Gates: lint clean (src/), tsc clean (0 errors), voice-tests 260/260, build OK.
  - NOTICEABLE — leaderboard tabs now show real standings from entered scores; game tabs
    appear/disappear based on which games are actually on the round.
- **Done:** designer follow-up fixes for `wire-leaderboard-real` (5 must-fix + 2 polish).
  1. Safe-area top: `top: 36` → `top: "max(36px, env(safe-area-inset-top))"` (Dynamic Island).
  2. Safe-area bottom: scroll padding bottom → `paddingBottom: "max(40px, env(safe-area-inset-bottom))"` (home indicator).
  3. Close button hit area: `width:32,height:32` → `minWidth:44,minHeight:44,display:flex` (iOS 44pt min).
  4. Tab touch target: `padding:"8px 14px"` → `"12px 14px"` (~44pt height on-course).
  5. "Through hole 0" guard: `{thru > 0 ? \`Through hole ${thru}\` : "—"}`.
  6. DotStrip eagle color: inline `"oklch(0.48 0.14 280)"` → `T.eagle` (tokenized).
  7. Skins pot callout background: `rgba(26,42,26,0.02)` (invisible) → `T.paperDeep`.
  Deferred (logged, not blocking): Nassau redundant empty-state text alongside winner grid;
  3-Point scoring guide always visible even when no scores; tab-bar overflow scrollbar not
  hidden; drag handle implies swipe-to-dismiss but only backdrop-tap dismisses — flag for owner.
  - Gates: lint clean, tsc 0 errors, voice-tests 260/260, build OK.

### 2026-06-27 — Backend DB layer COMPLETE + DEPLOYED (real-data wiring Phase 0/1)
- Shipped & merged **bundle #48** to main: db-core-schema, api-contract-align, and the
  full backend domain on Postgres (players, rounds/scores, tournaments, courses, profile,
  games) via Alembic 005/006/007 + a backfill script. Every item adversarially reviewed.
- **Deploy incident (resolved):** first deploy false-greened — migration 002 actually failed
  (`asyncpg InvalidTextRepresentationError: Token "'" is invalid`) because JSONB
  `server_default`s were plain strings; deploy only checked /health. Offline `--sql` missed
  it (renders without executing). **Fixes:** (1) wrap JSONB defaults in `sa.text(...)` (#49);
  (2) harden `deploy.yml` to `set -eu` fail-fast + run alembic before restart + `uv sync` in
  backend/ (#49, #50 — `set -o pipefail` failed under dash/SSM, switched to `set -eu`).
- **Redeploy SUCCESS:** alembic applied 001→002→006→007 cleanly on the live EC2 Postgres;
  /health ok; SSM Success. Backend DB layer is LIVE.
- **Open decision:** one-time backfill of `data/*.json` — likely seed-only, recommend SKIP
  for a clean DB start unless EC2 has real owner data.
- **Next: Phase 2 (NOTICEABLE) UI wiring** — flipped `wire-round-new` (P10) + `wire-round-scoring`
  (P11) to ready; these are user-facing → TestFlight approval bundles. Lesson: add a real-DB
  migration smoke test (throwaway Postgres) to catch execution-time DDL bugs the offline gate can't.

## 2026-06-26 (wire-round-scoring — reviewer pass 3 fixes)
- **Done:** reviewer pass 3 fixes for `wire-round-scoring` (commit e7d91b5 on integration/next).
  BLOCKER #1 (FIXED):
  - Non-404 load error and 404/LOCAL paths both rendered from localStorage WITHOUT seeding
    `pendingRef`. The next successful foreground save called
    `buildLocalRound(serverSnapshot, pending={})`, permanently erasing prior-session unsynced scores.
  - Fix: new `seedPendingFromLocal(local, pending)` helper seeds ALL non-null local scores into
    `pendingRef` before the `setScores` call. Both catch branches now call it and use
    `mergeWithPending` (not bare `buildScoreMap`) so the pending overlay is active from the start.
  Fix #3 (`retrySyncPending` seq-guard race):
  - Background retry called `setRound(updated)` + `setScores(...)` without the `addScoreSeqRef`
    guard, racing concurrent foreground saves.
  - Fix: retry now only confirms pending removal (`pendingRef.current.delete(key)`) — no UI state
    application, no localStorage write. UI remains correct via pending overlay already set at load;
    next foreground save writes localStorage.
  Fix #4 (`isNotFoundOrNetworkError` too broad):
  - The JSON-parse `catch` fell back to `m.toLowerCase().includes("not found")` on arbitrary body
    text, misclassifying 5xx errors containing "not found" prose as LOCAL mode.
  - Fix: catch now returns `false`; only trust `TypeError`, the exact `"API error: 404"` string
    (changed from substring to equality), and parsed FastAPI `{"detail":"...not found..."}`.
  Fix #6 (banner backgrounds inline RGB):
  - Added `T.errorWash: "rgba(184,74,58,0.13)"` and `T.warningWash: "rgba(184,118,58,0.13)"` to
    `frontend/src/components/yardage/tokens.ts`. Both banner `background` props now reference the tokens.
  - Gates: lint clean (src/), tsc clean, voice-tests 260/260, pushed to integration/next.
  - NOTICEABLE — prior-session score preservation now correct in all three load-error paths.

## 2026-06-26 (wire-round-scoring — reviewer fixes)
- **Done:** reviewer + designer follow-up fixes for `wire-round-scoring` (same branch).
  BLOCKER fixed:
  A. **Silent permanent score loss (FIXED):** introduced `pendingRef` (Map<string,Score>,
     key="{playerId}:{holeNumber}") to track scores entered but not yet server-confirmed.
     - `mergeWithPending()`: overlays pending on every server snapshot so a failed-save
       score is never wiped by the next success.
     - `buildLocalRound()`: merges pending into the round saved to localStorage so a page
       reload re-discovers unsynced scores.
     - Pending removal: only when server confirms exact (playerId, holeNumber, strokes)
       — rapid re-entry of the same hole leaves the newer pending value intact.
     - On load: compares API response vs localStorage; re-adds any local-only scores to
       pending; fires `retrySyncPending()` (background, silently logged on failure).
  CORRECTNESS fixed:
  1. Load catch now calls `isNotFoundOrNetworkError(e)`: `TypeError` (network) or
     message contains "not found"/"API error: 404" → LOCAL mode; all other errors
     (500, auth) → stay ONLINE, show banner, render from localStorage cache.
  2. Out-of-order responses: `addScoreSeqRef` + `lastAppliedSeqRef` — each addScore
     call gets a seq; response is skipped if `mySeq ≤ lastApplied` (a newer one already
     updated state). Combined with pending overlay prevents stale snapshots from
     clobbering latest UI state.
  3. Stale closures eliminated: all LOCAL-branch and error-branch `round` mutations now
     use `setRound(prev → …)` functional updaters (reads latest state, not closed-over
     stale value). `localSaveRound` called inside the updater with latest `prev`.
  DESIGN fixed:
  4. "LOCAL" badge fontSize 7.5 → 9 (readable in sunlight).
  5. Error-banner × button: `width:28,height:28,display:'flex',alignItems:'center',
     justifyContent:'center',flexShrink:0` (adequate touch target on-course).
  6. Header course-name span: `flex:1,minWidth:0,overflow:hidden,textOverflow:ellipsis,
     whiteSpace:nowrap` — real course names no longer overflow on small viewports.
  7. Status-zone backgrounds: error `rgba(184,74,58,0.08)→0.13`, LOCAL
     `rgba(184,118,58,0.07)→0.13` — contrast for sunlight use.
  8. Hole nav chips: `Array.from({length:holeCount},…)` not hardcoded 18 — 9-hole
     rounds render 9 chips.
  9. `T.errorInk:"#b84a3a"` + `T.warningInk:"#b8763a"` registered in `tokens.ts`;
     all hardcoded hex refs in RoundPageClient replaced with token references.
  - Gates: lint clean (src/), tsc --noEmit clean, voice-tests 260/260, build OK.
  - NOTICEABLE — all fixes are behavioural + visual improvements to the scoring screen.

## 2026-06-26 (wire-round-scoring)
- **Done:** backlog `wire-round-scoring` (P11, NOTICEABLE) — `RoundPageClient.tsx` now loads
  and persists scores via the backend instead of SEED_SCORES/SEED_PLAYERS mocks.
  Key changes:
  - **Removed:** `SEED_SCORES` and `SEED_PLAYERS` constants (the mock data); `getRound`/`saveRound`
    localStorage-only imports replaced with separate API + local imports.
  - **Round loading:** async on mount — tries `api.getRound(id)` (GET /api/rounds/{id}).
    On success: populates `players` (SeedPlayer[]) and `scores` map from the server response.
    On 404 or network error: falls back to `localGetRound(id)` (localStorage), sets
    `isLocalRound = true`. If no local copy either, renders a "Round not found" screen.
  - **Orphan/offline handling (§Review follow-up carry-over):** rounds created by the
    wire-round-new offline fallback have a client UUID not known to the backend; they 404 on
    load. `isLocalRound = true` activates: scores saved to localStorage only, no API calls.
    The round is marked "LOCAL" in the header chrome and a calm amber notice is shown inline.
    Deferred: re-creating the orphan round on the backend and reconciling IDs (a full sync
    engine is out of scope for this item — noted for a follow-up).
  - **Per-stroke persist:** `handleSetScore` calls `api.addScore(roundId, {playerId, holeNumber, strokes})`
    (POST /api/rounds/{id}/scores) after an optimistic local update. On success: syncs all scores
    from the server response + write-through to localStorage. On error: surfaces via `apiError`
    banner (dismissible, #b84a3a color, no silent swallow), saves optimistic state locally.
  - **Finish round:** `handleFinish` now async — calls `api.completeRound(id)` for API-backed
    rounds; falls back to local status='completed' save on error. Local rounds save locally only.
  - **Player/score conversion:** `buildSeedPlayers()` maps `Round.players` → `SeedPlayer[]`
    (PLAYER_COLORS palette); `buildScoreMap()` maps `Round.scores Score[]` → `Record<string,
    (number|null)[]>` (indexed by hole 0–17). Hole nav chips use first player's score to show
    "played" indicator (was hardcoded to 'p1').
  - **par for scoring:** prefers `round.holes[currentHole-1].par` (authoritative); falls back
    to `HOLES[currentHole-1].par` (illustration constant). `PlayerPanel` and `LeaderboardSheet`
    receive round's holes pars array (fallback to HOLES pars if round.holes is empty).
  - **UX preserved:** all inline styles use `T.*` tokens; no new design language; yardage-book
    feel intact. Footer changed from hardcoded "Pebble Beach Golf Links · 6,828 yds · Par 72"
    to real `round.courseName · N holes · teeName tees`.
  - **No-round state:** renders a calm not-found screen (T.serif italic message + back button)
    instead of a broken/empty scorecard.
  - **Designer flag:** "LOCAL" badge and amber notice use `#b8763a` (warm ink, not generic red)
    — consistent with the yardage-book palette; designer should verify against NORTHSTAR.
  - Deferred sync follow-up added as note in code (orphan round re-creation on backend).
  - Gates: lint clean (src/), tsc --noEmit clean, voice-tests 260/260, npm run build OK.
  - NOTICEABLE — user-visible on TestFlight: scoring screen now loads real round data and
    persists each stroke to the backend.

## 2026-06-26 (wire-round-new — follow-up fixes)
- **Done:** coordinator review fixes for `wire-round-new` (same branch, amend-style commit).
  BLOCKERS:
  1. **Error handling (BLOCKER 1):** `handleTeeOff` catch now distinguishes `TypeError`
     (network-down = offline fallback OK) from `Error` (HTTP 4xx/5xx = show `createError`
     banner, no local round fabricated).
  2. **Player de-dup (BLOCKER 2):** `deduped` filter added after `roundPlayers` assignment
     — prevents duplicate `round_players` rows when voice maps the same name twice to one
     saved player id.
  3. **VoiceRoundSetup restyled (BLOCKER 3):** full rewrite — `T.*` tokens, `PAPER_NOISE`
     background, inline SVG mic/close/refresh, `Waveform` from `Voice.tsx`. No more
     `bg-zinc-950`, `bg-emerald-500`, or lucide-react.
  4. **CourseSearch restyled (BLOCKER 4):** bottom sheet on `T.paper` (was `fixed inset-0
     bg-zinc-950/95`); drag handle; T.serif/T.mono headers; dashed-border result rows;
     inline SVG search/mapPin/close; loading pulse animation.
  5. **PlayerAutocomplete restyled (BLOCKER 5):** `T.paperDeep` input, `T.paper` dropdown,
     `T.ink` avatar circle, `DEFAULT_ACCENT` match highlight via inline style (no
     `text-emerald-300`); no lucide-react; keyboard hint footer removed. Player picker sheet
     reverted from `T.ink` to `T.paper` background (header colors updated to T.ink/T.pencil).
  SHOULD-FIX:
  6. Disabled hint "Add a player above to start" shown below Tee off button when not ready.
  7. "+ Add" button touch target raised to minHeight 44px.
  8. Mic button: 56px T.ink circle with accent ring + "Speak" T.mono label below.
  9. Quick-reply chip padding raised to 9px/13px (minHeight 38px).
  DEFER (noted, not done): footer gradient, auto-trigger after record, desktop nav hint,
  TEE_OPTIONS yardage not tied to course.
  - Gates: tsc --noEmit clean (0 errors), voice-tests 260/260 pass, npm run build OK.
  - NOTICEABLE — design overhaul is user-visible.

## 2026-06-26 (wire-round-new)
- **Done:** backlog `wire-round-new` (P10, NOTICEABLE) — replaced the scripted demo in
  `app/round/new/page.tsx` with a real round-setup flow that persists to the backend.
  Key changes:
  - Removed: scripted `useEffect` auto-typing demo, hardcoded `utter`/`course`/`players`
    constants, `heardCourse`/`heardJack`/`heardSam` detection, `saveRound` to localStorage.
  - Added `selectedCourse: SelectedCourse | null` state; course card now shows empty state
    ("Tap to search") or selected course info (name, location, par/holes); tapping opens
    `CourseSearch` overlay (full-screen dark modal — existing component, unchanged).
  - Added `players: Player[]` (min 1 slot) + `savedPlayers: SavedPlayer[]` state; loaded
    on mount by calling `getPlayers()` (API) with `getSavedPlayers()` (localStorage) fallback.
    Each player row is tappable and opens a dark picker sheet hosting `PlayerAutocomplete`
    (the dark Tailwind theme works correctly against the ink-colored sheet background).
    Auto-closes when a saved player is selected by click/enter; "Done" button for typed names.
    "+ Add" button appends a new slot and opens the picker for it.
  - Voice path: mic button opens `VoiceRoundSetup` overlay (existing component, unchanged);
    `onSetupRound({courseName, playerNames, teeName})` callback populates selectedCourse,
    players (linked to savedPlayers where name matches), and tee; then displays a conversation
    summary in the caddy-bubble surface with quick-reply chips for "Change game", "Different
    tees", "Add a player".
  - `handleTeeOff`: calls `api.createRound(...)` directly (POST /api/rounds); backend assigns
    its own UUID as the round id. Server-returned round is write-through cached to localStorage
    (`localSaveRound(created)`), then navigates to `/round/${created.id}` (server id, not
    client). Offline fallback: if API throws, generates a client UUID, saves locally, navigates.
    This is the §"Review follow-ups" reconciliation for wire-round-new.
  - Game objects built in `handleTeeOff` from the selected GameId (mapped via
    `GAME_ID_TO_FORMAT` to `GameFormat`); `roundId: ''` placeholder used on create (backend
    assigns real FK). Stroke/None produce no game object.
  - Yardage-book aesthetic preserved: all inline styles use `T.*` tokens; no new Tailwind
    in the main page; sub-components (PickerRow, GamePicker, TeePicker, SidesPicker,
    HolesPicker, MiniStat) kept with identical styling.
  - Designer note: `VoiceRoundSetup` and `CourseSearch` overlays use dark Tailwind styling
    (zinc/emerald), not yardage tokens — acceptable as modal interactions but flagged for a
    future design-pass to restyle them with T.* tokens.
  - Gates: lint clean (src/), tsc --noEmit clean, voice-tests 260/260, npm run build OK.
  - NOTICEABLE — user-visible on TestFlight: the scripted demo is gone; real round setup
    with backend persistence replaces it.

## 2026-06-27 (wire-home)
- **Done:** backlog `wire-home` (P13, NOTICEABLE) — `app/page.tsx` home screen now loads
  real data from the backend via the storage-api.ts API-authoritative pattern.
  Key changes:
  - **Removed:** `SAMPLE_RECENT`, `STATS`, `HDCP`, `FEED` mock constants (5 hardcoded entries,
    fake handicap/scoring stats, fake social feed). `initializeStorage` + sync `getRounds`
    localStorage imports replaced with async `getRoundsAsync`/`getTournamentsAsync`/
    `getGolferProfileAsync` from `storage-api.ts`.
  - **Recent rounds:** async-loaded from `GET /api/rounds` (owner-scoped). Rounds sorted
    most-recent-first; top 5 shown. Each row derived via `deriveRecentRows()`: date formatted
    (month + day), course name, total strokes + toPar net via `calculateTotals()` from
    `types.ts`, holesPlayed count, "T" tag for tournament rounds, "Live" badge for active
    rounds. Rows are now tappable and navigate to `/round/{id}`.
  - **Handicap:** from `GET /api/profile/golfer` → `profile.handicap`. Shows "—" when null
    (no profile or no handicap set). Also displayed on the profile card (was hardcoded "77").
    Sparkline removed (no historical handicap series available yet — flagged for
    wire-profile-stats item).
  - **Scoring average:** derived client-side from the loaded rounds list via `deriveScoringAvg()`
    — averages total strokes over completed rounds with ≥9 holes played. Shows "—" when
    insufficient data. Trend arrow removed (requires historical handicap series).
  - **Fairways / GIR / Putts:** all show "—". Per-hole shot data is not tracked yet; these
    three stats require a per-shot data source. Flagged for a future wire-profile-stats item.
  - **Tournament link:** `QuickAction "Tournament"` and the Trophy Case block both route to
    `GET /api/tournaments` most-recent tournament (`/tournament/{id}`) rather than the
    hardcoded `/tournament/sunday-cup-2024`. If no tournament exists, the quick-action routes
    to `/tournament/new` and the Trophy Case shows a calm "No tournaments yet — Start one →"
    empty state.
  - **Social feed ("From the group") — REMOVED:** no real data source exists for a social
    feed. The `FEED` constant was fabricated (Jack/Sam/Justin). Removed entirely rather than
    show fake data. Decision logged in code comment for the designer/owner; re-introduce when
    a real activity stream is backed by the API.
  - **Empty states:** new user with no rounds sees a calm serif italic "No rounds yet. Tap
    'Start a round' above to begin." empty state inside the rounds section. Stats section
    shows "—" for all missing values. Trophy case shows calm empty state with "Start one →"
    CTA.
  - **Live round:** detection moved from sync `getRounds()` (localStorage only) to the async
    loaded rounds list — active round is found from the same API-authoritative fetch.
  - **Loading state:** `loading` boolean guards the stats/rounds sections so "—" is shown
    (not stale/wrong) while the API call is in flight.
  - **Error surfacing:** uses `storage-api.ts` explicit-offline-cache pattern — API is
    authoritative; on failure `console.error` is logged + localStorage fallback returned.
    No silent swallowing.
  - **Yardage-book feel preserved:** all inline styles use T.* tokens; no new dependencies
    or design language; serif/mono typography and paper/ink palette unchanged; motion pulsing
    mic CTA retained.
  - **Decisions for designer/owner review:**
    1. Sparkline removed — bring back when handicap history is available (wire-profile-stats).
    2. Trend arrow removed — same reason.
    3. Social feed removed — no backend; re-add when a real activity stream exists.
    4. Fairways/GIR/Putts show "—" — requires per-shot tracking (future item).
    5. "San Francisco" and "66°F, wind WNW 8. Presidio tee times open from 10:40." in masthead
       are still hardcoded — location/weather wiring is out of scope for this item.
  - **Gates:** lint clean (`src/app/page.tsx` 0 errors), tsc --noEmit 0 errors,
    voice-tests 260/260 pass, npm run build OK.
  - NOTICEABLE — user-visible on TestFlight: home screen shows real rounds, real handicap,
    real tournament link; no fabricated data.

## 2026-06-27 (wire-home reviewer + designer follow-up fixes)
- **Done:** reviewer + designer follow-up fixes for `wire-home` (one commit on integration/next).
  BLOCKERS fixed:
  1. **Hardcoded city + weather removed:** "San Francisco" header div and "66°F, wind WNW 8.
     Presidio tee times open from 10:40." subtitle both deleted. Masthead now shows only the
     time-of-day greeting. No location/weather data source exists — showing nothing is honest.
  2. **"to par avg" math fixed:** replaced `scoringAvg - handicap` (nonsense) with real
     `toParAvg` derived from `calculateTotals().toPar` over the same eligible rounds. Renamed
     `deriveScoringAvg` → `deriveScoringStats` (returns `{avg, toParAvg}`); both stats use the
     same eligible set so they are consistent. Display hidden when no eligible rounds.
  3. **Profile card Dynamic Island fix:** `top: 14` → `top: "max(14px, env(safe-area-inset-top))"`.
     Card now clears the notch/Dynamic Island on iPhone 14/15/16 Pro.
  4. **Dead "All" button removed:** no /rounds index page; button had cursor:pointer but no
     onClick — confusing on-device. Removed. Section heading still present.
  5. **Fairways/Greens/Putts row hidden:** removed the 3-stat grid showing three permanent "—"
     values. Per-shot tracking not available yet. `StatBit` helper also removed (now unused).
     Handicap + Scoring avg remain as they fill from real data.
  SHOULD-FIX done:
  6. **Round row touch target:** `minHeight: 44` on each round row button (44pt iOS minimum).
  7. **Bottom safe-area:** `paddingBottom: "env(safe-area-inset-bottom, 16px)"` on the inner
     container so the last block clears the home indicator.
  8. **Owner-is-players[0] comments:** added at both `players[0]` usages in `deriveRecentRows`
     and `deriveScoringStats`, noting single-owner beta assumption and revisit note.
  - Gates: lint 0 errors (src/app/page.tsx), tsc 0 errors, voice-tests 260/260, build OK.
  - NOTICEABLE — fixes are user-visible: Dynamic Island clearance, correct to-par number,
    no fake weather, cleaner stats block.

## 2026-06-27 (wire-profile-identity)
- **Done:** backlog `wire-profile-identity` (P14, NOTICEABLE) — profile masthead (name,
  home course) + handicap index wired to `GET /api/profile/golfer`; editable via
  `PUT /api/profile/golfer` with write-through localStorage cache.
  Key changes:
  - **`types.ts`:** `GolferProfile.name` changed `string` → `string | null` to match the
    backend's `Optional[str]`. Callers that assumed non-null now safely use `?? '—'`.
  - **`api.ts`:** `GolferProfileUpdate.name/handicap/homeCourse` typed as `T | null` to
    allow explicit null (intentional field clear). Comment explains omitted = no-change,
    null = clear.
  - **`storage-api.ts` (null-clear fix — review follow-up):** removed `?? undefined`
    coercion from `saveGolferProfileAsync`. `handicap: profile.handicap ?? undefined` →
    `handicap: profile.handicap` (same for homeCourse). Null now flows as `"handicap":null`
    in the JSON body so the backend can see it in `model_fields_set`.
  - **`backend/app/routes/profile.py` (null-clear fix):** PUT partial-update logic changed
    from `if data.field is not None:` → `if "field" in data.model_fields_set:`. This
    distinguishes "omitted" (no change) from "sent as null" (clear the value). Affects
    name, handicap, homeCourse, clubDistances.
  - **`app/profile/page.tsx` — real data wiring:**
    - Uses `getGolferProfileAsync` / `saveGolferProfileAsync` from `storage-api.ts` in
      a `useEffect` (NOT the `useGolferProfile` hook which calls `useAuth()` and breaks
      Next.js static prerender).
    - `Masthead`: name + home course now show real values from profile (or "—" when
      null/loading). Editable in-place via `<input>` styled with T.serif/T.mono to
      match the yardage-book feel. "Edit" button in masthead header; Save/Cancel replace
      it in edit mode. iOS safe-area top (`max(14px, env(safe-area-inset-top))`) unchanged.
      All buttons minHeight 44px (iOS 44pt touch target). caddyNo/ghin/memberSince
      remain as placeholder mocks (not in GolferProfile type yet).
    - `HandicapModule`: big handicap index number wired to real `profile.handicap`
      (shows "—" when null). Editable in edit mode via decimal `<input>`. Empty state:
      "No handicap set — tap Edit to add one." when null. Trend badge / sparkline /
      low-high / differential still mock stats (wired in wire-profile-stats P16).
    - `IdentityDraft` type: `{ name: string; homeCourse: string; handicap: string }` —
      a string-form draft for all three editable fields, parsed to typed values on save.
    - Validation: handicap parsed as float; empty = null (clear); non-numeric = error
      shown inline above Save button (T.errorInk color, no silent swallow).
    - **Null-clear end-to-end:** clearing handicap/homeCourse to empty and saving now
      sends `{"handicap":null}` (not omitted), backend model_fields_set fires, column
      written to NULL — field is cleared. Round-trip confirmed by code review.
    - Bag / StrokesGained / FairwayFan / ScoringByTee / YearLog / Recent: untouched.
      All still use PP_* mock constants (wire-profile-bag P15 / wire-profile-stats P16).
  - Gates: tsc 0 errors, lint clean (modified files), ruff clean (backend), voice-tests
    260/260 pass, npm run build OK (profile page prerenders as static shell ○).
  - NOTICEABLE — user-visible on TestFlight: profile masthead + handicap show real data;
    owner can tap Edit, set name/home course/handicap, tap Save — persists to the backend.
  - Designer flags: edit inputs are underline-only (yardage-book minimal); edit mode
    spans masthead+handicap simultaneously (single Save); caddyNo card is placeholder
    pending a GolferProfile extension. Mock stats sections (sparkline, trend, SG, bag)
    are still visible alongside real identity data — designer to confirm this is OK
    or flag to hide until wire-profile-stats lands.
