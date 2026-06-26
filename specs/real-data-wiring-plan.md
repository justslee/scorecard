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
- **db-core-schema** (S, med) — mig `005_core_scoring.sql` + ORM for players/golfer_profiles/rounds/round_players/scores/games/player_groups/tournaments. Deps: none.
- **api-contract-align** (S, med) — rewrite `lib/api.ts` + `storage-api.ts`: camelCase, `PUT`, real paths, stop silent fallback. Deps: none.
### Phase 1 — Backend domain on DB (silent)
- **backend-players-db** (S, low) — `routes/players.py` CRUD on Postgres; drop seed. Deps: db-core-schema.
- **backend-rounds-scores-db** (S, med) — `routes/rounds.py` round+normalized scores/players/groups; keep `POST /{id}/scores` upsert. Deps: db-core-schema.
- **backend-tournaments-db** (S, low) — `routes/tournaments.py` on DB. Deps: backend-rounds-scores-db.
- **backend-courses-db** (S, med) — scoring-courses on Postgres; consider unifying with mapped `courses` (mig 001). Deps: db-core-schema.
- **backend-profile-endpoint** (S, low) — new `routes/profile.py` (`GET/POST/PUT /api/profile/golfer`); register in `main.py`. Decide reuse caddie `player_profiles` vs new `golfer_profiles`. Deps: db-core-schema.
- **backend-games-surface** (S, med) — decide embedded-in-round vs standalone `/api/games`; align `api.ts` accordingly. Deps: backend-rounds-scores-db.
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
### Phase 3 — Product decision
- **tee-time-decision** (N, blocked, high) — real booking backend vs labeled demo. **Owner decision required.**

## E. Owner decisions / provisioning required
- **RDS:** deploy `infra/looper-aws.yaml`; `CREATE EXTENSION postgis;`; apply migrations 001–004 + new 005; set `DATABASE_URL` in `looper/prod` secret (backend won't boot without it).
- **Secrets:** `CLERK_JWKS_URL`, `CLERK_ISSUER`, `OWNER_CLERK_USER_ID` (auth fails closed otherwise); `ANTHROPIC_API_KEY`, `GOLF_API_KEY`, `MAPBOX_TOKEN`, `DEEPGRAM_API_KEY`.
- **Migration runner:** none wired for the asyncpg DB — decide Alembic vs raw-SQL apply for `005`.
- **Profile table:** new `golfer_profiles` vs reuse caddie `player_profiles` (overlap on handicap + club_distances).
- **Games storage:** embedded-in-round vs standalone table/endpoint.
- **Tee-time:** real feature vs labeled demo (no backend exists).

## Risks
- **Silent-fallback masking:** until `api-contract-align` lands, backend fixes won't change app behavior (failures swallowed into localStorage). Do it early.
- **Single-owner gate:** every data router is `require_owner`; bake `ownerId` columns now, relax gate later.
- **Course identity duality:** scoring-courses (JSON) vs mapped-courses (PostGIS) vs GolfAPI-imported — unify deliberately in `backend-courses-db`.
- **Native auth:** `lib/api.ts` reads `window.Clerk`; ensure Clerk inits in the Capacitor WebView (`capacitor://localhost`).
- **Gates:** new endpoints + data handling must pass `/security-review` + `/code-review`.
