# Real-data wiring plan — kill the mocks, persist to the DB

> Source: intensive Plan-agent audit (2026-06-26). This is the reference spec for the
> "replace mocks with real DB-backed data" initiative. Board cards + `backlog.json`
> items point here. Build order is data-layer-first (Phase 0 → 3).

## Executive summary
The repo has **two parallel realities that don't connect**:
1. A polished yardage-book UI (`app/page.tsx`, `profile/page.tsx`, `tee-time/page.tsx`,
   `round/new/page.tsx`, `tournament/[id]/TournamentPageClient.tsx`) that is largely
   **scripted/mocked** — module-level constant arrays, `setTimeout`-faked voice, no persistence.
2. A functional-but-local path (`RoundPageClient`, `players/page.tsx`,
   `NewTournamentRoundClient`) that persists to **localStorage** via `lib/storage.ts`, not the backend.

Backend is also split:
- **Core domain** (players, rounds, scores, tournaments, scoring-courses) = **JSON files** in
  `backend/data/*.json` via `backend/app/storage.py` (camelCase Pydantic, `PUT` verbs).
- **Caddie/sessions/shots/pins/memory/personas/mapped-courses** = **real Postgres (RDS) + PostGIS**
  via `backend/app/db/engine.py` + `db/models.py` + migrations 001–004. This half is genuinely DB-backed.

**Root cause the app feels "unwired":** `frontend/src/lib/api.ts` uses snake_case fields, `PATCH`,
and endpoints that don't exist (`/api/profile/golfer`, `/api/games`, `/api/rounds/{id}/players`).
The backend rounds API uses camelCase `Score{playerId,holeNumber,strokes}` + `PUT`. So
`storage-api.ts` always silently falls back to localStorage (`storage-api.ts:34-37`). Fixing the
backend changes nothing until this contract is aligned.

**Genuinely wired (leave alone):** OCR scan (`lib/ocr.ts` → `/api/voice/parse-scorecard`),
course search/import (`lib/golf-api.ts` → `/api/golf`, `/api/courses/search`, `/api/courses/mapped`),
caddie (`CaddiePanel` → `/api/caddie/*`, Postgres), shots/pins (Postgres).

## A. Inventory of mocks / gaps
| Location | What's faked | Should do |
|---|---|---|
| `app/page.tsx:12-27,212` | `SAMPLE_RECENT/STATS/HDCP/FEED`; hardcoded `/tournament/sunday-cup-2024` | Real recent rounds + handicap/stats; real "most recent tournament" link |
| `app/profile/page.tsx:12-92` | `PP_*` + `buildYear()` heatmap — entire page mock | Real profile, handicap history, bag, strokes-gained, scoring-by-tee, year log |
| `app/tee-time/page.tsx:15-55,281-289` | Entire "Dispatch Looper" flow; `setInterval` search theater; no backend | Real discovery/booking OR explicit demo label |
| `app/round/new/page.tsx:62-144` | Scripted voice demo, hardcoded course/players, `saveRound` to localStorage | Real `VoiceRoundSetup`+`CourseSearch`+`PlayerAutocomplete` → `POST /api/rounds` |
| `app/round/[id]/RoundPageClient.tsx:14,55,172` | `getRound`/`saveRound` localStorage only | Load + persist scores to backend per stroke |
| `components/yardage/LeaderboardSheet.tsx:21` | `LB_MOCK` nassau/skins/threePoint | Compute from scores via `lib/games.ts` |
| `app/tournament/[id]/TournamentPageClient.tsx:7` | 100% from `yardage/tournamentData.ts` | Fetch by id from `/api/tournaments/{id}` + computed standings |
| `lib/storage.ts:112-165,258-371` | `getDefaultCourses()` / `getDefaultPlayers()` hardcoded | Courses + players from backend |
| `backend/app/storage.py:94-173` | `seed_default_data()` — 11 players + 3 courses | Remove; serve real per-user data from DB |
| `lib/api.ts:86-116,408-442,231-239` | snake_case + `PATCH` + nonexistent endpoints | Align to real backend contract (camelCase, `PUT`, real paths) |
| `lib/storage-api.ts:34-37,94-96` | silent `catch → localStorage` masks API failures | API authoritative; localStorage = explicit offline cache only |
| `app/settings/page.tsx:39-50` | "Load Sample Players" → `seedDefaultPlayers()` | Remove demo seeding |
| `lib/games.ts:85` + AddGameModal/GameResults/GameLeaderboards | Match-play Nassau stubbed (stroke totals) | Implement real match-play Nassau |

## B. Cleanup list
- Delete `components/yardage/tournamentData.ts` (after tournament wired).
- Delete mock constants: `SAMPLE_RECENT/STATS/HDCP/FEED`, all `PP_*`+`buildYear`, `TT_*` (pending tee-time decision), `LB_MOCK`.
- Replace scripted `app/round/new/page.tsx` with the already-built `VoiceRoundSetup`/`CourseSearch`/`PlayerAutocomplete`.
- Remove seeds: `getDefaultCourses/getDefaultPlayers/seedDefaultPlayers` (`lib/storage.ts`), `seed_default_data` (`backend/app/storage.py`), "Load Sample Players" (settings).
- Rewrite `lib/api.ts` to the real contract; remove dead endpoints until they exist.
- Demote localStorage in `storage.ts`/`storage-api.ts` to an explicit offline cache (not a silent fallback).

## C. Data-model plan (RDS / Postgres)
Target: Postgres on RDS via existing `DATABASE_URL`/asyncpg (`db/engine.py`). `infra/looper-aws.yaml`
already provisions private encrypted RDS (PostGIS-capable, `DATABASE_URL` via Secrets Manager).
**Supabase migrations are reference-only (do-not-touch).** New core scoring domain needs a **new
migration `005`** applied via the asyncpg DB (NOT in `supabase/`).

Already in Postgres (keep): `courses`, `tee_sets`, `holes`, `hole_yardages`, `hole_features`,
`caddie_sessions`, `caddie_messages`, `player_profiles`, `caddie_memories`, `shots`,
`caddie_personas`, `hole_pins`, `elevation_cache`.

Still on JSON → migrate to Postgres (new mig 005 + ORM), keep camelCase `types.ts`↔`models.py` parity:
`players`, `golfer_profiles` (new — distinct from caddie `player_profiles`; consider unifying),
`rounds`, `round_players` (normalize), `scores` (normalize), `games`, `player_groups`, `tournaments`.
Add `ownerId`/`userId` columns now (single-owner beta, multi-user-ready), mirroring caddie tables.

**Contract decision:** `types.ts` + `models.py` already aligned in camelCase; `api.ts` is the
outlier. Conform `api.ts` to the existing camelCase backend (cheapest). Add only the genuinely
missing endpoints: `/api/profile/golfer` and a games surface.

## D. Feature breakdown (ordered) — N = noticeable on TestFlight, S = silent
### Phase 0 — Foundation (silent)
- **db-core-schema** (S, med) — **wire Alembic** to the asyncpg `DATABASE_URL` + baseline caddie schema 001–004, then author `005_core_scoring` (first Alembic revision) + ORM for players/golfer_profiles/rounds/round_players/scores/games/player_groups/tournaments. Apply on the EC2 deploy box (DATABASE_URL is there + Secrets Manager). Deps: none.
- **api-contract-align** (S, med) — rewrite `lib/api.ts` + `storage-api.ts`: camelCase, `PUT`, real paths, stop silent fallback. Deps: none.
### Phase 1 — Backend domain on DB (silent)
- **backend-players-db** (S, low) — `routes/players.py` CRUD on Postgres; drop seed. Deps: db-core-schema.
- **backend-rounds-scores-db** (S, med) — `routes/rounds.py` round+normalized scores/players/groups; keep `POST /{id}/scores` upsert. Deps: db-core-schema.
- **backend-tournaments-db** (S, low) — `routes/tournaments.py` on DB. Deps: backend-rounds-scores-db.
- **backend-courses-db** (S, med) — scoring-courses on Postgres; consider unifying with mapped `courses` (mig 001). Deps: db-core-schema.
- **backend-profile-endpoint** (S, low) — new `routes/profile.py` (`GET/POST/PUT /api/profile/golfer`) backed by the new **`golfer_profiles`** table (distinct from caddie `player_profiles`); register in `main.py`. Deps: db-core-schema.
- **backend-games-surface** (S, med) — persist games in the normalized **`games`** table (FK round/tournament), managed via the round/tournament endpoints; **no standalone `/api/games`** — delete `getGame/createGame/...` from `api.ts`. Deps: backend-rounds-scores-db.
- **json-to-db-backfill** (S, low) — one-off import of real `data/*.json`, then retire files. Deps: all Phase 1.
### Phase 2 — Wire the surfaces (noticeable)
- **wire-round-new** (N, high) — real round setup → `POST /api/rounds`. Deps: api-contract-align, backend-rounds-scores-db, backend-courses-db.
- **wire-round-scoring** (N, med) — `RoundPageClient`/`ScoreGrid` load+persist per stroke. Deps: api-contract-align, backend-rounds-scores-db.
- **wire-leaderboard-real** (N, med) — replace `LB_MOCK` with `lib/games.ts` from scores. Deps: wire-round-scoring.
- **wire-home** (N, med) — real recent rounds/stats, fix tournament link. Deps: api-contract-align, backend-rounds-scores-db, backend-profile-endpoint.
- **wire-profile-identity** (N, med) — masthead + handicap from `/api/profile/golfer`. Deps: backend-profile-endpoint.
- **wire-profile-bag** (N, med) — bag from `clubDistances` (reuse caddie shot data). Deps: backend-profile-endpoint.
- **wire-profile-stats** (N, high) — strokes-gained/scoring-by-tee/year-log from rounds/shots (may need `backend-stats-agg` S/med). Deps: wire-round-scoring.
- **wire-players-page** (N, low) — `players/page.tsx` → `/api/players`; drop seeds. Deps: backend-players-db, api-contract-align.
- **wire-tournament-detail** (N, high) — fetch by id, computed standings; delete `tournamentData.ts`. Deps: backend-tournaments-db, wire-round-scoring.
- **wire-tournament-new** (N, low) — persist via API (currently localStorage). Deps: backend-tournaments-db.
- **settings-cleanup** (N, low) — remove "Load Sample Players". Deps: backend-players-db.
- **games-matchplay-nassau** (N, med) — real match-play Nassau in `lib/games.ts` (+ modal/results/leaderboards) + tests. Deps: none.
### Phase 3 — Tee-time real integration (owner chose: build it for real)
- **tee-time-real** (N, high) — build the REAL tee-time integration, phased. **Phase 1** (ready): real course search + GolfNow/course booking deep-links, no gated API — replaces the `setInterval` mock with a real flow. **Phase 2** (owner creds): live slots via provider (GolfNow Affiliate & Partner API). **Phase 3** (owner creds): real auto-booking (Lightspeed/foreUP). Touches `app/tee-time/page.tsx` (+ home entry). Deps: api-contract-align; Phases 2–3 blocked on owner-supplied provider creds.

## E. Decisions — RESOLVED (owner, 2026-06-26)
1. **RDS: already up.** `DATABASE_URL` lives on the EC2 box + AWS Secrets Manager — no provisioning needed. Apply migrations on the deploy box (EC2) where `DATABASE_URL` resolves (deploy step or one-shot SSM run); the Mac loop authors the migration, the deploy applies it. PostGIS already enabled.
2. **Migration runner: Alembic.** Wire Alembic to the existing asyncpg `DATABASE_URL` (`db/engine.py`); baseline the already-applied caddie schema (001–004) so Alembic won't recreate it, then author `005_core_scoring` as the first Alembic revision. `backend/supabase/migrations/**` stays do-not-touch reference.
3. **Profile table: new `golfer_profiles`.** Keep distinct from the caddie `player_profiles` (that one serves the AI; this is the user-facing identity/handicap/bag). May cross-reference later.
4. **Games storage: normalized `games` table, round/tournament-scoped.** FK `roundId`/`tournamentId` (nullable) + `format`, `name`, `playerIds` jsonb, `teams` jsonb, `settings` jsonb. Managed through the round/tournament endpoints (round GET returns its games; round create/update upserts them). NO standalone `/api/games` CRUD; delete `getGame/createGame/...` from `api.ts`.
5. **Tee-time: build the REAL integration** (not a demo). Phased: (1) real course search + booking deep-links (no gated API), (2) live slots via a provider (e.g. GolfNow Affiliate & Partner API), (3) real auto-booking (Lightspeed/foreUP). Phase 1 needs no creds; Phases 2–3 need owner-supplied provider API credentials — the one remaining owner dependency.

Secrets to confirm present on the deploy box: `CLERK_JWKS_URL`, `CLERK_ISSUER`, `OWNER_CLERK_USER_ID` (auth fails closed otherwise); `ANTHROPIC_API_KEY`, `GOLF_API_KEY`, `MAPBOX_TOKEN`, `DEEPGRAM_API_KEY`; + tee-time provider creds for Phases 2–3.

## Risks
- **Silent-fallback masking:** until `api-contract-align` lands, backend fixes won't change app behavior (failures swallowed into localStorage). Do it early.
- **Single-owner gate:** every data router is `require_owner`; bake `ownerId` columns now, relax gate later.
- **Course identity duality:** scoring-courses (JSON) vs mapped-courses (PostGIS) vs GolfAPI-imported — unify deliberately in `backend-courses-db`.
- **Native auth:** `lib/api.ts` reads `window.Clerk`; ensure Clerk inits in the Capacitor WebView (`capacitor://localhost`).
- **Gates:** new endpoints + data handling must pass `/security-review` + `/code-review`.

## Review follow-ups (carry into the routes-wiring items)
- **`wire-profile-identity`/`wire-profile-bag` (from backend-profile-endpoint review):** the PUT
  is a partial update that skips None, and `storage-api.ts saveGolferProfileAsync` sends
  `?? undefined` — so a user CANNOT clear `handicap`/`homeCourse` back to null (old value
  sticks). When wiring the profile UI, send `null` explicitly and have PUT distinguish
  "omitted" from "set null" (e.g. `model_fields_set`). Also tighten the `name` nullability
  mismatch (backend `Optional[str]` vs `types.ts` non-null `string`). (Inert today — no screen
  imports `useGolferProfile`.)
- **`wire-round-new` / `wire-round-scoring` (from api-contract-align review):** `RoundCreate`
  has no `scores` field and `rounds.py` assigns a fresh `round-{uuid}` ignoring the client id —
  so `getRound(clientId)` always 404s and every `saveRoundAsync` re-creates a NEW round, dropping
  pre-existing scores on create. Before wiring the real scoring flow: persist the server id back
  to the client (use the server-returned round) and/or accept scores on create, so reads reconcile.
  (The async `storage-api.ts`/`useApi.ts` layer is currently dead code — not imported by any
  screen — so this is latent until Phase 2.)

- **`backend-games-surface`:** Pydantic `Game` (`models.py:71`) has no `teams` field but the ORM/`games` table does — add `teams` to the API model when wiring.
- **`backend-tournaments-db`:** `Tournament.playerNamesById` (`models.py:124`) has no column in the normalized `tournaments` table — derive it via a `players` join; don't silently drop it.
- **Loose coupling (intentional):** cross-domain refs (`round_players.player_id`, `scores.player_id`, `rounds.course_id/tee_id`, `golfer_profiles.home_course_id/user_id`) are plain Text, not FKs — no DB-level referential integrity to players/courses. Validate in the service layer when wiring routes.
- **`owner_id` nullable on all 8 tables** (single-owner beta by design): when multi-user lands, owner-scoped queries must handle NULL `owner_id` rows to avoid cross-tenant reads.
- **`backend-courses-db` follow-up — course-identity unification deferred:** `scoring_courses` (round-setup picker, migration 006) and the PostGIS `courses`/`tee_sets`/`holes` tables (caddie/import, migration 001) are intentionally kept separate. Unifying them is a future refactor that touches the working caddie/import half; do NOT collapse them now.
