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
- **Next ready backlog items:** `test-games-engine` (P2), `test-voice-pipeline` (P3),
  `frontend-lint-cleanup` (P9), `tee-time-finder` Phase 1 (P8).
