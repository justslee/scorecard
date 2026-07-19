# Multi-User Epic — Architecture & Phased Build Plan

**File:** `specs/multi-user-epic-plan.md`
**Status:** APPROVED-FOR-BUILD ARCHITECTURE (owner greenlit the epic 2026-07-16). No code lands from this doc directly; P0 items become backlog entries next cycle. Every phase is `/security-review`-gated before merge.
**Owner's ask (verbatim):** "make this multi user. So many people can create accounts... this platform is intended to be used and distributed on the App Store. So a very secure login system, and ability to connect with users and being able to search their profiles connect via phone number, email (or whatever identifiers). Then I want to implement that virtual match capability."

---

## 1. Where auth stands today (grounded audit)

**Identity is already real and verified.** Every request's identity is the Clerk user id (JWT `sub`), verified against Clerk's JWKS (RS256, no shared secret) in `backend/app/services/clerk_auth.py` — `current_user_id` dependency (:63-89). Fail-closed: with no JWKS configured and no explicit `ALLOW_ANONYMOUS=1`, requests get 503 (:70-79). Audience is NOT verified (`verify_aud: False`, :41).

**Single-user is one gate, applied at one chokepoint.** `require_owner` (:92-102) wraps `current_user_id` and 403s any verified sub that isn't env `OWNER_CLERK_USER_ID` — a single id in an env var, no table, and a no-op when unset. It is applied once, in `backend/app/main.py:62` (`_owner_only = [Depends(require_owner)]`), attached to all 17 data routers (:64-87). Open routes: `/health`, `/`, `/api/config-status`, and the Twilio media-stream WS (call-token guarded, main.py:89-93).

**Row scoping already exists almost everywhere.** Route handlers filter by the verified user: `rounds.py:19-20` states it ("every query filters by owner_id == current_user_id") and the pattern is pervasive across players/tournaments/courses/course_reviews/profile/shots/memory/tee_times. The caddie enforces ownership per session via `get_owned_session()` — 404 (not 403) on mismatch to prevent round-id enumeration (`backend/app/caddie/session.py:418-432`).

**So "the flip" is small; the residue is what matters:**
- `hole_pins` is global with last-writer-wins upsert on `(course_id, hole_number, pin_date)` — any authed user overwrites any pin (`backend/app/routes/pins.py:59-127`; `marked_by_user_id` is attribution only, models.py:114).
- Availability-call job ids are fetchable by any authed user (`tee_times.py` `get_availability_call`, job dict has no user stamp); same pattern risk on scorecard-OCR / course-search job ids.
- Caller-voice + rehearsal-call endpoints hard-bind `require_owner` at the parameter level (`tee_times.py:633,767,787`) — these dial/configure the owner's phone and must stay owner-only post-flip.
- **NO users table** — Clerk is the identity store; `golfer_profiles.user_id` (UNIQUE NOT NULL, models.py:237) is the closest local user record.
- **NO RLS** — tenancy is 100% app-level `.where()`.
- Per-user-ready tables with **nullable** owner columns needing backfill+tighten: `rounds.owner_id` (:299), `tournaments` (:271), `players` (:204, plus unused `clerk_user_id` :211), `scoring_courses` (:419), `caddie_sessions.user_id` (:27), `shots.user_id` (:140). Already NOT NULL real-id: `golfer_profiles`, `course_reviews` (:511), `tee_time_bookings` (:484), `caddie_memories` (:94), `player_profiles` (PK = user_id, :73). Global reference data — **read-only-correct, but NOT write-correct**: PostGIS `courses`/`tee_sets`/`holes`/`hole_yardages`/`hole_features`, `elevation_cache`. Reads are global-by-design; but `backend/app/routes/courses_mapped.py` exposes member-reachable **writes** to this geometry (POST :68 / PUT :109 / DELETE :126, no owner scoping) — see the BLOCKING gap in §3.3.0. Already multi-user-shaped: `caddie_personas` (`is_public` + `author_user_id`, :180-181).
- Loose refs: `round_players.player_id` / `scores.player_id` are Text with no FK (:367, :394) — rosters are name-strings.

**The client is the real work.** `useUser()` is never called for identity; "who am I" is a manual per-round assertion — `ownerIndex` defaults to 0 (`app/round/new/page.tsx:98`), the "this is me" pill (:1509-1531), and `lib/round-owner.ts` falls back to `players[0]`. localStorage is device-global, not per-user (`lib/storage.ts:5-9`: `scorecard_rounds/courses/tournaments/profile/players`; plus persona/favorites/tts/live-mode/map-view prefs). The offline fallback picks API-vs-local via `!!window.Clerk?.session` (`storage-api.ts:24-26`) — identity-blind. The native iOS JWT is persisted **plaintext** in Capacitor Preferences (`lib/native-token-store.ts:7-15`, already flagged for Keychain). Signup is open at the app layer (only the backend 403 restricts today). One thing already good: per-user rate limiting exists on all paid LLM endpoints (`backend/app/services/rate_limit.py`, `caddie_rate_limited_user` used across caddie/voice/realtime routes).

---

## 2. The key architectural call: Postgres RLS vs application-layer scoping

**Decision: application-layer scoping for P0, with a P0 structural change that makes RLS a drop-in later hardening. RLS itself is deferred to the end of P1 (before the social surface opens broadly), as an owner decision.**

Reasoning:

**For app-layer now:**
1. **The scoping already exists and is tested-shaped.** Every data route filters on the verified id today; the P0 work is closing three known gaps and adding an isolation test suite — days, not weeks.
2. **RLS under this stack is invasive.** Routes acquire sessions directly via `async_session()` (module-scoped in `app/db/engine.py`), not via a FastAPI dependency — the integration conftest explicitly documents this (`backend/tests/integration/conftest.py:10`: "Routes open sessions directly... so we cannot swap the DB through dependency_overrides"). RLS requires `SET LOCAL app.current_user_id` on every transaction, which means either touching every session acquisition site or centralizing acquisition first.
3. **Connection-role pitfall.** The app connects as a single role that likely owns the tables; table owners **bypass RLS** unless `FORCE ROW LEVEL SECURITY` is set per table. Doing this correctly means a dedicated non-owner app role, policy per tenant table (~12 tables), and policies that don't break the PostGIS raw-SQL paths (`pins.py:88-117` uses `text()` SQL) — all through the **guarded migrations** process.
4. **RLS wouldn't cover the actual residual risks.** The known gaps (pins global-by-design, in-process job dicts, localStorage leaks) are not row-policy problems. RLS protects against the *unknown future* missing-`.where()` bug — real, but a defense-in-depth layer, not the P0 crux.

**What P0 does to keep RLS cheap later (the load-bearing part):**
- Introduce **one canonical session-acquisition helper**: `user_session(user_id)` (async context manager wrapping `async_session()`) that every tenant-data route migrates to. In P0 it does nothing extra — behavior byte-identical. When RLS lands, it becomes the single place that issues `SET LOCAL app.current_user_id = :uid`, and RLS becomes a pure migration + one-file change.
- Add a **CI lint** (simple grep-based check in `ci_scripts/`) that flags any `select(`/`update(`/`delete(` against a tenant table in `backend/app/routes/` that lacks an owner-scoping `.where` or `user_session` usage — the structural substitute for RLS until it lands.

**RLS later (end of P1):** enable per-table `ROW LEVEL SECURITY` + `FORCE`, policies of the form `USING (owner_id = current_setting('app.current_user_id'))`, dedicated `looper_app` role. Listed in the owner-decision section with cost/benefit.

---

## 3. P0 — Secure multi-account foundation (build spec, next cycle)

Goal: any person can create an account and get a fully isolated, App-Store-security-grade Looper. Single-user behavior stays **byte-identical** until the owner flips one env var.

### 3.1 The flip (authz transition)

- Add `APP_ACCESS_MODE` env (`owner` | `open`) read in `clerk_auth.py`. New dependency `require_member`:
  - `owner` mode (the default, and the deployed value until launch): identical semantics to today's `require_owner` — verified sub must equal `OWNER_CLERK_USER_ID`, else 403. **Byte-identical.**
  - `open` mode: any verified Clerk sub passes (plus a denylist check, §3.4).
- `main.py:62` changes from `_owner_only = [Depends(require_owner)]` to `_member = [Depends(require_member)]` on the same 17 routers. `require_owner` itself is **kept, unchanged**, for the endpoints that are owner-only *by nature*: caller-voice GET/PUT, rehearsal-call, and any voice-booking config surface (already bound at param level in `tee_times.py:633,767,787` — they survive the flip automatically).
- Startup guards (fail-closed hardening, in `main.py` startup or module import):
  - If `APP_ACCESS_MODE=open` and (`CLERK_JWKS_URL` unset or `ALLOW_ANONYMOUS=1`) → **refuse to boot** (raise). The dev-anonymous path must be structurally impossible in an open deployment.
  - If `APP_ACCESS_MODE=owner` and `OWNER_CLERK_USER_ID` unset in a JWKS-configured deployment → log a loud warning (today it silently degrades to any-verified-user, clerk_auth.py:97-98 — that's a latent fail-open).
- Clerk dashboard: keep signups **restricted** in the Clerk instance until launch day; opening signups + setting `APP_ACCESS_MODE=open` is the launch action. Frontend sign-up page already exists (`app/sign-up/[[...sign-up]]/`).

**The owner becomes account #1 automatically:** his Clerk user already owns every row (see backfill), his `golfer_profiles` row exists, and nothing about his experience changes at flip time.

### 3.2 Backfill / tighten migration (DESIGN — goes through the guarded migrations process as its own reviewed PR)

**Step 0 — verify before assuming (read-only, run against prod first):** for each of `rounds`, `tournaments`, `players`, `scoring_courses`, `caddie_sessions`, `shots`: `SELECT count(*) FILTER (WHERE owner_id IS NULL), array_agg(DISTINCT owner_id) FROM <t>`. Expected outcome: every non-NULL value already equals the owner's Clerk id (prod has always run under his verified JWT and routes stamp the id on create), and NULL counts are zero or confined to pre-auth-era rows. **If NULL counts are zero, the backfill migration is a no-op and we skip straight to tightening.**

**Migration A (data):** `UPDATE <t> SET owner_id = :owner WHERE owner_id IS NULL` (and `user_id` for caddie_sessions/shots), with `:owner` read from `OWNER_CLERK_USER_ID` at migration run time; abort if unset. Idempotent, online-safe (rows are few — single-user data).

**Migration B (tighten, separate migration, after ≥1 week soak with the flip live):** `ALTER COLUMN owner_id SET NOT NULL` on the six tables + composite indexes where lists filter by owner (`rounds(owner_id, updated_at)`, `players(owner_id)`, etc. — several already indexed per models.py). Also: decide `golfer_profiles.owner_id` (:238) — it's redundant with `user_id`; recommend leaving nullable and dropping in a later cleanup migration rather than backfilling.

### 3.3 Close the unscoped-route gaps

0. **[BLOCKING — reviewer pass] `courses_mapped.py` writes global course geometry with NO owner scoping.** POST `""` (:68), PUT `/{course_id}` (:109), DELETE `/{course_id}` (:126) have no `current_user_id` dependency and mutate the global PostGIS `courses/tee_sets/holes/hole_yardages/hole_features` tables (rows that have no owner column). Today they are safe only because `_owner_only` gates the whole router; the §3.1 flip to `_member` opens them to **any verified user overwriting/deleting any course's hole geometry — last-writer-wins, and PUT/DELETE fire `_precompute_course_elevations` + `_precompute_course_guides`, silently corrupting the caddie's yardages and strategy guides for every user of that course.** Same integrity-attack class as pins (§3.3.1) but higher blast radius. **Fix: carve these three mutations to stay `require_owner` (or a future admin-role gate) post-flip — exactly like caller-voice/rehearsal (§3.3.3) — since the rows have no owner to scope by.** Add a negative write-authz test (member → PUT/DELETE mapped course → 403/404, geometry unchanged) to §3.6.

1. **`hole_pins` → per-user (recommendation; owner decision #6).** A pin *is* shared physical reality, but cross-tenant last-writer-wins means a stranger's mismarked pin silently corrupts your caddie's yardages — an integrity attack on the crux feature. Design: add `user_id` (backfill = `marked_by_user_id` else owner), change the unique key to `(course_id, hole_number, pin_date, user_id)`, scope `list_pins`/`upsert_pin` (`pins.py:59-127`) to the caller. A future "course-verified/community pin" (the admin `source='admin'` path already anticipated in pins.py:30-32) can layer shared pins back in deliberately.
2. **Availability-call jobs:** stamp `user_id` into `_availability_jobs[job_id]` (tee_times.py:852) at creation; `GET /availability-call/{job_id}` returns 404 unless the stamp matches the caller (uuid4 unguessability is not authorization). Apply the identical stamp-and-match pattern to any future course-search async job. **Doc correction (reviewer):** `scorecard.py:161 /scan` is **synchronous** (returns OCR inline — no job-id dict), so it needs no stamp-and-match; ignore the earlier "scorecard-OCR job ids" mention. **Also (reviewer SHOULD-FIX):** `request_availability_call` (tee_times.py:959) places a *real outbound Twilio call* and, if the member omits `callbackNumber`, speaks the OWNER's `VOICE_BOOKING_OWNER_NUMBER` to the pro shop (:977-979). For P0 either keep `request_availability_call` on `require_owner`, or — if per-user — REQUIRE the member's own `callbackNumber` (never fall back to the owner's number) under a tight per-user telephony rate limit. Resolve this explicitly; the §3.4 threat table's "voice-call endpoints stay owner-only" must actually cover this route.
3. **Caller-voice / rehearsal-call / voice-booking:** stay `require_owner` (they dial `VOICE_BOOKING_OWNER_NUMBER` and store a single owner preference). Post-P0, either hide these UI surfaces for non-owner users or genericize per-user verified callback numbers — out of P0 scope; the frontend must not render broken owner-only controls for members (check `settings`/tee-times UI).
4. **`caddie_personas`:** audit the routes (memory.py/caddie.py): reads = `is_builtin OR is_public OR author_user_id = me`; writes stamp `author_user_id`; update/delete require author match, 404 on mismatch.

### 3.4 App-Store-grade security posture

- **Native token → Keychain.** Swap the `@capacitor/preferences` backend in `lib/native-token-store.ts` for a Keychain-backed plugin (`@aparajita/capacitor-secure-storage`), `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` (encrypted at rest, excluded from iCloud/device backups). The file was designed for a one-file swap (:12-17). Include a one-time migrate-then-delete of the plaintext Preferences value.
- **Audience/authorized-party verification.** Clerk session tokens carry `azp`, not `aud`. Add `CLERK_AUTHORIZED_PARTIES` env (comma-separated origins: the Capacitor origin `https://localhost` + prod web origin); in `_verified_user_id` reject tokens whose `azp` claim is present and not in the set. Keep `verify_aud: False` unless a JWT template adds `aud` (then flip it on with the configured audience). This closes cross-app token replay against our API.
- **Session revocation & bans.** Clerk session JWTs are short-lived (~60s) and refreshed against Clerk — sign-out/revocation propagates within TTL for API access; acceptable. For bans/deletions: add a Clerk **webhook receiver** (`POST /api/webhooks/clerk`, Svix-signature-verified, NOT behind `require_member`) handling `user.deleted`/`user.banned` → a small `revoked_users` table checked in `require_member` (cached in-process, 60s TTL). This is also the anchor for App Store account deletion (§ owner decision #5): in-app "Delete account" → Clerk user deletion → webhook → cascade-delete all rows for that user id (design the deletion job per table list in §1).
- **Fail-open flags.** Boot guard above (§3.1) for `ALLOW_ANONYMOUS`. For the frontend `NEXT_PUBLIC_AUTH_BYPASS` (`AuthGate.tsx:89-95`, `api.ts:78-79`): add a production-build CI assertion that the flag is unset; it's compile-time so a guarded build pipeline is sufficient.
- **Rate limiting.** Extend the existing pattern (`backend/app/services/rate_limit.py`, per-user sliding window, honest 429 fail-state) rather than adding middleware from scratch: (a) keep `caddie_rate_limited_user` on all LLM/paid endpoints — post-flip this is also the **cost-abuse** control, so revisit its per-user budget for strangers; (b) add a general per-user write-RPM dependency for mutation endpoints (generous, anti-abuse only); (c) per-IP limiting for the few unauthenticated routes stays at the ALB/reverse-proxy level. In-process store is fine (single EC2); note Redis as the multi-instance follow-up. Login/signup brute force is Clerk's job (enable bot protection in the dashboard).
- **Secrets:** unchanged — AWS Secrets Manager loader (`main.py:22`) already in place; add `CLERK_AUTHORIZED_PARTIES` and the Svix webhook secret there.

**Threat model of the flip (the hotspot — what could let A read B's data):**

| Vector | Status / P0 action |
|---|---|
| Missing `.where(owner_id=...)` in some route | The core risk. Isolation test suite (§3.6) + CI scoping lint (§2) + `user_session` centralization. |
| Id enumeration (uuid probing) | All cross-tenant reads must 404 identically to nonexistent ids (caddie already does — session.py:426-431). Codify as a tested property. |
| Job-id dicts (availability/OCR) | Stamp-and-match (§3.3.2). |
| Shared-table write clobber (pins) | Per-user pins (§3.3.1). |
| Token theft from device backup | Keychain swap. |
| Token replay from another Clerk app | `azp` check. |
| Misconfig fail-open (`ALLOW_ANONYMOUS`, unset `OWNER_CLERK_USER_ID`, `AUTH_BYPASS`) | Boot guards + CI assertion. |
| Cost abuse (LLM endpoints, voice) | Existing per-user limiter, tightened budgets; voice-call endpoints stay owner-only. |
| Signup spam | Clerk bot protection + restricted-mode launch ramp. |
| `/api/config-status` info disclosure | Presence-only booleans (main.py:124-139) — acceptable; note in review. |

### 3.5 Client: identity, storage, offline

- **Derive "me" from Clerk.** Introduce `lib/identity.ts`: current Clerk user id + a `useMe()` hook (wraps `useUser()`; ClerkProvider already wraps the app). On sign-in, ensure the `golfer_profiles` row exists (profile route already upserts) and ensure a **self SavedPlayer** exists with `clerkUserId = me` (the waiting column, types.ts:59 / models.py:211).
- **"This is me" pill's future:** round setup defaults `ownerIndex` to the roster player whose `clerkUserId === me` (auto-added as player 1); the pill (`new/page.tsx:1509-1531`) stays as a rarely-needed override (e.g., scoring for someone else) — no visual change, just a correct default. `lib/round-owner.ts` keeps its fallback chain; new rounds always stamp `ownerPlayerId`.
- **Per-user localStorage namespacing.** Add a key-derivation function in `lib/storage.ts` — `key(name) = scorecard_${userId}_${name}` — used by all five data keys (:5-9) AND the pref stores (`caddie/persona.ts`, favorites, `voice/tts-pref.ts`, `voice/live-mode-pref.ts`, map-view). GolfAPI course cache stays device-global (non-personal). One-time migration: on first namespaced run, if legacy un-namespaced keys exist, move them into the current signed-in user's namespace (that device's data is definitionally the owner's today) and record `scorecard_migrated_v1`. Settings "clear data" clears only the current namespace (today's `localStorage.clear()` nukes other users).
- **Offline fallback identity leak.** `storage-api.ts` mode-picks via `!!window.Clerk?.session` (:24-26): signed-out/offline reads hit device-global cache. Fix: persist `scorecard_last_user_id`; offline mode serves ONLY that user's namespace; if no namespace for the current context, serve empty — never another user's cache.

### 3.6 Test strategy (authz isolation — the P0 acceptance bar)

The harness already supports identity injection (`backend/tests/integration/conftest.py:176-184` overrides `current_user_id`/`require_owner` per test).

1. **Per-router isolation suite** (parametrized over every tenant resource: rounds, tournaments, players, scoring-courses, profile, reviews, shots, memories, caddie sessions, pins, bookings): user A creates → as user B: `GET /{id}` → **404**; `LIST` → does not contain A's row; `PUT/PATCH/DELETE /{id}` → **404** and A's row is bit-for-bit unchanged.
2. **404-not-403 enumeration property:** assert cross-tenant response status+body is identical to a random-nonexistent-id request, for every id-keyed route (extends the caddie's existing discipline, session.py:426-431).
3. **Flip regression:** `APP_ACCESS_MODE=owner` → non-owner verified user gets 403 on all 17 routers, owner unaffected (today's contract, frozen as a test); `APP_ACCESS_MODE=open` → both users pass auth and suite (1) holds.
4. **Fail-closed tests:** JWKS unset + no ALLOW_ANONYMOUS → 503 (exists — keep); `open` + `ALLOW_ANONYMOUS` → boot refusal; revoked-user webhook → 403 within cache TTL.
5. **Job-scoping tests:** availability/OCR job created by A → B's GET → 404.
6. **Client unit tests:** storage key namespacing; user-switch on one device sees empty state, not A's rounds; offline fallback refuses foreign cache.

### 3.7 P0 security-review checklist
- [ ] `require_member` matrix: owner/open × valid/expired/wrong-azp/no token
- [ ] Boot guards verified (ALLOW_ANONYMOUS, OWNER_CLERK_USER_ID, AUTH_BYPASS CI assertion)
- [ ] Isolation suite green across all routers; 404-uniformity property green
- [ ] Pins, job-ids, personas gaps closed; caller-voice/rehearsal still owner-only
- [ ] Keychain storage verified on device (no plaintext JWT in Preferences after migration; backup-excluded)
- [ ] Webhook receiver: Svix signature verified, replay-resistant, not member-gated
- [ ] Rate-limit budgets reviewed for stranger-cost abuse
- [ ] Migration A/B reviewed; prod verify-first query output attached to the PR

### 3.8 P0 threat-model review — findings folded in (reviewer pass, 2026-07-16)

The design was adversarially threat-modeled before build. Verdict: the app-layer-scoping + `user_session`-centralization architecture (§2) is defensible and the RLS deferral is sound; the row-scoping audit in §1 is accurate. Findings, all folded into the P0 build scope:

- **BLOCKING — `courses_mapped.py` global-geometry writes** → §3.3.0 above. Carve POST/PUT/DELETE to `require_owner` post-flip; negative write-authz test. (§1 misclassified these tables as "correct as-is" — true for reads, false for the mutation surface; corrected.)
- **SHOULD-FIX — `azp`/issuer fail-open.** `clerk_auth.py:41` sets `verify_aud:False` and `:46` verifies the issuer only if `CLERK_ISSUER` is set (else unverified — signature-only). The §3.4 azp rule ("reject present-and-mismatched azp") leaves a hole: a token minted with **no** `azp` bypasses it. Fix: in open mode, boot-guard-require both `CLERK_ISSUER` and `CLERK_AUTHORIZED_PARTIES`, and make `_verified_user_id` reject a token whose `azp` is **absent OR** not in the allowlist.
- **SHOULD-FIX — member-accessible outbound telephony** (`request_availability_call`) → folded into §3.3.2 above.
- **SHOULD-FIX — CI scoping-lint blind spot.** The §2 lint scoped to `backend/app/routes/` misses tenant queries in `app/services/` (the `courses_mapped` store — finding #1's actual write site) and `app/caddie/` (`session.py:407 _load_messages`, `memory.py`). Fix: extend the lint to `app/services/` + `app/caddie/`, OR enumerate the transitive-ownership exemptions (e.g. `_load_messages` is safe only because it is reached via `get_owned_session`) so exemptions are auditable, not accidental.
- **SHOULD-FIX — backfill misses `"anonymous"`-stamped rows.** With JWKS unset / `ALLOW_ANONYMOUS=1`, `current_user_id` returns the literal `"anonymous"` (clerk_auth.py:79/27), which routes stamp into `owner_id`/`user_id`. `UPDATE ... WHERE owner_id IS NULL` (§3.2 Migration A) skips these → permanently orphaned post-tighten. Fix: reassign `owner_id IN (NULL, 'anonymous')` to the owner (or delete `'anonymous'` rows) and assert Step-0 finds no owner_id outside `{NULL, 'anonymous', OWNER_CLERK_USER_ID}` before proceeding.
- **SHOULD-FIX — conftest must override `require_member`.** `conftest.py:176-184 set_auth` overrides `current_user_id`/`require_owner`; the flip adds `require_member` as the router gate. Fix: `set_auth` must also override `require_member`; add a flip-regression test that drives the REAL gate with `APP_ACCESS_MODE` toggled (owner-mode: non-owner→403 all routers; open-mode: both pass, then row-isolation holds).
- **NICE-TO-HAVE** — §3.6 isolation suite: add explicit negative write-authz cases on shared/global tables (mapped courses, pre-fix pins); extend the conftest `TRUNCATE` list (:140-146) for new tables the suite touches (`caddie_personas`, later `user_identifiers`).

**Cycle count: ~3–4.** (1: backend flip + gap closures [incl. courses_mapped carve-out] + isolation suite; 1: migrations design/verify [incl. anonymous-row handling] + webhook/revocation + azp/issuer boot guards; 1–1.5: client identity + namespacing + Keychain; 0.5: hardening + review remediation.)

---

## 4. P1 — Profiles, discovery, connect (technical/security design; PM owns UX)

### 4.1 Schema (design only)

- **Canonical local user record = extend `golfer_profiles`** (already one row per Clerk user, UNIQUE user_id, has `name`) rather than a new users table. Add: `avatar_url`, `handle` (unique @handle), `discoverable_by_email bool default false`, `discoverable_by_phone bool default false`, `public_fields JSONB` (which profile facets connections may see: handicap, home course, etc.).
- **`user_identifiers`** — the privacy-preserving lookup index. Columns: `user_id`, `kind ('email'|'phone')`, `identifier_hash` (**HMAC-SHA256 over the normalized identifier** — lowercased email / E.164 phone — keyed by a server-side pepper held ONLY in AWS Secrets Manager, never in the DB or repo), `verified bool`, `discoverable bool`, unique `(kind, identifier_hash)`. **Raw identifiers are never stored in this table and never queryable.** Rows are written exclusively from Clerk webhooks (`user.created`/`user.updated`) using Clerk-verified identifiers — users cannot claim unverified emails/phones into the index. Plain SHA-256 is insufficient (email/phone spaces are enumerable offline if the table leaks); the pepper makes offline reversal infeasible.
- **`user_connections`** — `id`, `requester_user_id`, `addressee_user_id`, `status ('pending'|'accepted'|'declined')`, timestamps; uniqueness on the unordered pair (`UNIQUE (LEAST(a,b), GREATEST(a,b))` via expression index). Request/accept (mutual) model — Virtual Match requires mutual consent anyway, and "connect" is two-sided.
- **`user_blocks`** — `blocker_user_id`, `blocked_user_id`, unique pair, independent of connection state. A block: hides each from the other's lookup (indistinguishable from nonexistent), auto-declines/prevents requests, severs an existing connection.
- **Roster formalization:** start using `players.clerk_user_id` (models.py:211): an accepted connection can be linked to one of my SavedPlayers ("this Mike is @mike") — offer **"Link to Mike's account"** rather than creating a duplicate row. Scores stay the owner's copy — linking adds identity, not shared writes. `round_players.player_id`/`scores.player_id` stay Text (no FK migration needed yet); linkage is at the `players` table level.

### 4.2 API surface

- `POST /api/users/lookup` — body `{kind, identifier}` (raw, over TLS); server normalizes → HMAC → exact match where `verified AND discoverable` and no block either direction → minimal profile card `{user_id, name, handle, avatar}` (a business card: no handicap/stats/history until connected). **No partial/prefix/name search in MVP beyond exact handle. No bulk endpoint in MVP** (bulk contact-sync is owner decision #8 — it changes the App Store privacy label and the scraping math). Phone match, when enabled, is client-hashed (native per-contact picker, hashes only) → matched against `user_identifiers` — raw contacts never uploaded.
- `GET /api/profile/handle-available` — handle uniqueness check.
- `POST /api/connections` (request), `POST /api/connections/{id}/accept|decline`, `DELETE /api/connections/{id}`, `GET /api/connections` (mine only).
- `POST /api/blocks`, `DELETE /api/blocks/{user_id}`, `GET /api/blocks` (mine).
- `GET /api/users/{user_id}` — profile visible only if connected (fields per `public_fields`); otherwise 404 (not 403 — no existence oracle).
- `PATCH /api/profile/discoverability`.

### 4.3 Privacy threat model

- **Identifier enumeration:** lookup inherently confirms existence for discoverable users — that IS the feature; non-discoverable and blocked users return the exact same empty result as nonexistent. Mitigations: default discoverability **off** (owner decision #3, recommend opt-in), hard per-user lookup quota (e.g. 20/hr, 100/day) + per-IP quota, constant-shaped responses, audit log on lookup volume.
- **Scraping/graph harvesting:** no list/search endpoints, connections visible only to their members, quotas above, alerting on quota-ceiling users.
- **Harassment:** blocks are silent and total; repeated-request throttling per pair.
- **App Store privacy labels:** collected-and-linked: contact info (email/phone), user content (rounds), identifiers (user ID); if bulk contact sync ships later → "Contacts" label + purpose string. Native per-contact picker (not blanket Contacts permission) keeps the Contacts data-collection category off the label. Account deletion flow (P0 webhook + cascade) must also delete `user_identifiers`, connections, blocks — but must NOT delete historical shared round scorecards (sever the identity link only, matching how `Round.players` already tolerates local-only players).
- **Clerk & phone:** Clerk natively supports phone-number auth/verification via SMS — flag plan/pricing for the owner (decision #1/#2); email-first launch avoids SMS cost entirely while `user_identifiers` still indexes Clerk-verified phones for lookup if the user adds one.
- **Voice-first angle:** the caddie orb handles pull intents only ("add Mike as a partner" → search + a confirm step before sending a request; "who's on my partners list" → read-back). The OS contact-permission dialog stays a tap — voice can't drive it.

### 4.4 Client surface (PM-specced)
"My Players" (`/players`) evolves in place into the Partners hub (it already renders a `clerkUserId` "Linked" badge, players/page.tsx:~499): add a discovery search-mode (handle/email/phone), a Requests section, and profile-settings (handle/avatar/visibility toggles). **No new bottom-tab** — the real nav is Home/Courses/Tee-times/Profile (4 tabs; the Partners slot was deliberately dropped); Partners stays reachable from Profile, per Northstar's minimal-chrome bar. Public discovery card reads as a business card, not a stats dashboard.

### 4.5 Tests & review checklist
Isolation suite extends to connections/blocks (A cannot read B's connection list; pair-scoped access only). Property tests: blocked ≡ nonexistent across every endpoint; lookup quota enforced; pepper never present in DB dumps/fixtures; webhook is the only writer of `user_identifiers`. Security review adds: identifier-hash design review, webhook signature, discoverability-default confirmation, App Store privacy-label diff. **This is also the recommended point to land RLS** (owner decision #7) — the social graph tables are the highest-value rows to defense-in-depth.

**Cycle count: ~3.** (1 schema+webhooks+lookup, 1 connections/blocks+tests, 1 client UI — PM-specced — + review.)

---

## 5. P2 — Virtual Match (the headline)

### 5.1 MVP shape: async round-vs-round net match play, live standings

Two **connected** users each play their own round (their own course, their own scoring — everything existing stays untouched); a virtual match overlays net match-play between their rounds with a standings view that updates as scores land. Simultaneous-live presence/chat/spectating = later phase.

> **Grounding note (from the PM pass):** `computeMatchPlay` in `frontend/src/lib/games.ts:739` is **gross-only today** — it does not allocate handicap strokes via `HoleInfo.handicap` (stroke index). Net match play for Virtual Match is therefore **genuinely new logic**, not a drop-in reuse. What *is* reusable is the `matchDiff` / `statusLabel` ("AS" / "N UP") / early-clinch (`closedAt`) vocabulary from `MatchPlayResults` / `NassauMatchSegment`, which ports directly to a cross-round comparison.

### 5.2 Schema (design only)

**`virtual_matches`**: `id`, `format` (MVP: `'matchPlay'` net), `creator_user_id`, `opponent_user_id`, `status`, `creator_round_id (nullable)`, `opponent_round_id (nullable)`, `course_id`/`tee_id` (locked at acceptance), `settings JSONB` (handicap allowance %, holes, stakes label), `frozen_handicaps JSONB` (each player's index snapshotted at acceptance, not live), `result JSONB` (final ledger snapshot), `expires_at`, timestamps. Both users must have an accepted connection at creation. Mirror `Round.tournamentId` with an optional `virtualMatchId` on `Round`/`RoundCreate` — zero new round architecture; the round/new flow pre-fills the locked course/tee and tags the round.

**State machine:** `proposed` →(opponent accepts)→ `accepted` (course/tee/handicaps now locked) →(either round attached/started)→ `active` →(both rounds completed)→ `completed`; plus `declined`, `cancelled` (either party pre-active), `abandoned`/`expired` (staleness timeout). Consent is structural: no opponent data is visible before `accepted`; each user can attach **only a round they own** (`round.owner_id == me`, and only their designated slot). If one player never posts a single hole by expiry → `expired`/void (owner decision #11 — recommend void unless a true zero-hole no-show; never force a loss on a good-faith partial round). One gentle reminder near expiry, no repeated nudging (Northstar: quiet).

### 5.3 Authz & anti-tamper

- Match rows readable/writable only by the two participants (404 otherwise — same enumeration discipline).
- Neither player can touch the other's scores — this falls out of P0 for free: scores live under each owner's round, writable only by that owner. The match only **reads projections**.
- **Data minimization:** the opponent sees a scores-only projection (`hole_number`, `strokes`, net figures, course par/handicap snapshot) — never GPS shots, caddie sessions, or memories. New endpoint, new response model; never reuse the full Round shape cross-account.
- Standings/result computed **server-side** (`GET /api/virtual-matches/{id}/standings`) — a small pure Python net-match-play function (the new logic noted in §5.1), with **parity tests** against games.ts fixtures (the 15-format engine stays the client-side source of truth for local games; only this one format gets a backend twin, since the client legitimately cannot read the opponent's raw round). Late edits after `completed` trigger recompute + both-party notice; `result` snapshot is the settled record.

### 5.4 API + client surface

`POST /api/virtual-matches` (propose), `accept|decline|cancel`, `POST /{id}/attach-round`, `GET /api/virtual-matches` (mine), `GET /{id}`, `GET /{id}/standings` (poll — reuse the live-leaderboard client patterns; websockets later). Client: a "Challenge to a Virtual Match" entry on a Partner's profile; a small setup step (reuses the round-creation course/tee picker); a quiet match status card (holes-posted progress + live net diff using the existing status-label vocabulary) surfaced from Home/Profile — **not** a new bottom-tab; a result screen with one calm caddie line. New pure fn `lib/virtual-match.ts: computeVirtualMatchResult(roundA, roundB, holes, frozenHandicaps)`, unit-testable like `games.ts`/`settlement.ts`. Voice-first: "how's my match with Mike" is a caddie-answerable read — wire standings into the caddie tool surface **as data, not as prompt-trusted text** (see §7). Explicitly **no per-hole push/taunt notifications** (SaaS gamification noise the Northstar rejects).

### 5.5 Tests & review checklist
State-machine table tests (every illegal transition 4xx); isolation: non-participant → 404 everywhere; projection endpoint leaks nothing beyond the whitelist (snapshot-tested response shape); parity tests backend-vs-games.ts; consent tests (nothing visible pre-accept; attach-only-own-round). Review adds: projection minimization, recompute/tamper audit trail, notification content (no data leakage in push/email).

**Explicitly deferred (not MVP):** simultaneous/real-time hole-by-hole play, group/league (3+) matches, money settlement on virtual matches (a stretch reusing `settlement.ts`), chat/trash-talk, rematches/series, spectating/sharing, any format besides net match play.

**Cycle count: ~3–4 MVP** (1 schema+state machine+authz, 1 standings engine+parity, 1–2 client+polish+review). Simultaneous-live: +2 later.

---

## 6. Owner decisions (consolidated — need answers before the relevant phase ships)

1. **Clerk plan & pricing.** Production instance on a custom domain is required for launch. Free tier covers ~10k MAU; the Pro tier (~$25/mo base + per-MAU beyond the free allowance) unlocks the production feature set. **Verify current pricing at clerk.com before launch** — flag: costs scale with signups.
2. **Phone verification costs / launch identifiers.** SMS verification bills per message via Clerk's SMS add-on and is the main variable cost of "connect via phone number." Recommendation: launch email-first (free), enable phone as an added verified identifier; revisit phone-as-login later.
3. **Discoverability default:** opt-in (recommended — App-Store-privacy-friendly, anti-scraping) vs opt-out (better cold-start discovery).
4. **Migration timing:** run verify-first queries + Migration A during a quiet window pre-flip; Migration B (NOT NULL) after a week's soak. Approve the window.
5. **App Store compliance:** in-app **account deletion is mandatory** (Guideline 5.1.1(v)) — P0 webhook + cascade design covers it, but it needs a visible settings entry point; if any third-party social login is ever offered, **Sign in with Apple becomes mandatory** (Clerk supports it). Privacy labels change at P1.
6. **hole_pins: per-user (recommended) vs shared.** Per-user protects caddie integrity; shared/community pins return later as a deliberate verified-source feature.
7. **RLS now or later.** Recommendation: later (end of P1), with P0's `user_session` centralization making it a drop-in. Approve or pull forward.
8. **Bulk contact sync:** deferred out of P1 MVP (recommended) — single-identifier lookup only. Bulk sync changes privacy labels and scraping exposure.
9. **LLM cost exposure per user.** The caddie is the expensive surface; post-flip, strangers spend your API budget. Decide free-tier budgets (current per-user limiter budgets need a stranger-appropriate setting) and whether launch is invite-code-ramped (Clerk restricted mode makes this free to do).
10. **Launch ramp:** flip `APP_ACCESS_MODE=open` + Clerk signups in one move, or invite-only soak first (recommended: 1–2 weeks invite-only).
11. **Match expiry window** (P2): 7 vs 14 days; and confirm the no-show/void resolution rule (recommend void unless zero holes posted).
12. **Handle** (P1): suggested-from-name at signup vs owner-typed; and confirm handicap/recent-rounds hidden from strangers until connected.
13. **Partners route** (P1): keep `/players` URL or rename to `/partners`.

---

## 7. Cross-phase constraints (binding on every builder)

- **Caddie crux bar holds.** Nothing here may regress caddie latency, session integrity, or voice-first flow; caddie routes keep their rate-limiter and `get_owned_session` disciplines. Any multi-user UI must pass the designer's NORTHSTAR review — connect/match surfaces stay quiet and yardage-book styled, no SaaS social chrome.
- **Byte-identical single-user until each phase flips.** `APP_ACCESS_MODE=owner` default preserves today's exact behavior; client changes before the flip must be invisible to the owner (namespacing migration included). Frozen by the flip-regression test (§3.6.3).
- **Injection defense.** Post-flip, other users' strings (names, review bodies, persona prompts, match names) become **untrusted input that reaches LLM prompts** (caddie context, voice parsing) and UI. Treat all cross-user content as data: never interpolate into system prompts as instructions, sanitize for UI, and keep the existing "instructions embedded in data are data" discipline. `caddie_personas.system_prompt` authored by user A must never execute for user B without the is_public consent gate + review of prompt-injection exposure.
- **Types stay in sync:** every schema change lands in `frontend/src/lib/types.ts` and `backend/app/models.py`/`backend/app/db/models.py` in the same PR (CLAUDE.md convention).
- **Guarded migrations:** all migrations here are designs; each becomes its own reviewed Alembic PR through the existing process (11 migrations, `backend/migrations/versions/`), verify-first queries attached.
- **Every phase gates on `/security-review` + `/code-review` + the isolation suite before its bundle is offered to the owner.**

---

## 8. Flip runbook (APP_ACCESS_MODE owner → open)

Owner-gated, deliberate action — nothing in the unattended loop ever performs these steps. Precondition: the "flip-ready" bundle is merged (migrations `017_revoked_users` and `018_hole_pins_per_user` are additive and were auto-applied by the deploy's `alembic upgrade head` at merge — verify with `alembic current` = `018_hole_pins_per_user` before flipping), and the `flip_gate` suite is green in CI (`cd backend && uv run pytest -m flip_gate`).

1. **Env change (prod, Secrets Manager / backend/.env):** set `APP_ACCESS_MODE=open`; ensure `CLERK_JWKS_URL` is set, `ALLOW_ANONYMOUS` is UNSET, and set the two newly-required vars: `CLERK_ISSUER` (the Clerk instance issuer URL) and `CLERK_AUTHORIZED_PARTIES` (comma-separated: the Capacitor origin `https://localhost` + the prod web origin). Set `CLERK_WEBHOOK_SECRET` (Svix) and configure the Clerk webhook (`user.deleted`, `user.banned`, `session.revoked` → `POST /api/webhooks/clerk`). Open Clerk signups (dashboard) as the same action.
2. **Restart the backend.** `_assert_boot_config()` refuses to boot on any misconfiguration above; startup then warms the revocation cache from `revoked_users` (open mode only) — a restart can never silently un-revoke a banned member.
3. **Migration order note:** 017 then 018, both already applied (additive, backward-compatible with owner-mode code — that is why they merge ahead of the flip). No flip-day migration work. The separate §3.2 backfill/tighten migrations remain their own reviewed PR.
4. **Live post-flip smoke:** sign in with a second real Clerk account: it sees empty rounds/pins/profile (never the owner's data); create a round + mark a pin; verify the owner's app is unaffected (his rounds, his pins for the same course/date unchanged); verify a revoked test account 403s on `/api/rounds`. Owner account: everything byte-identical.
5. **Rollback:** unset `APP_ACCESS_MODE` (or set `owner`) + restart — require_member reverts to the owner-only gate. Migrations STAY (additive and backward-compatible: `hole_pins.user_id` is stamped by owner-mode writes too; `revoked_users` is inert in owner mode). Optionally re-restrict Clerk signups.
6. **Carve-outs that STAY owner-only after the flip:** `courses_mapped.py` POST/PUT/DELETE (:93/:142/:165 — global course geometry); caller-voice GET/PUT, rehearsal-call, voice-booking config (`tee_times.py` param-level `require_owner`); `request_availability_call` (real outbound telephony; per-member callback numbers are a future slice). Availability-job stamp-and-match and `user_session` centralization remain deferred, safe behind these carve-outs (see the DEFERRED block in `clerk_auth.py`).

---

### Critical Files for Implementation
- `backend/app/services/clerk_auth.py` — the gate: `require_member`, azp check, boot guards, revocation hook
- `backend/app/main.py` — the one-line chokepoint flip (:62) + startup guards + webhook router
- `backend/app/db/models.py` — every schema design lands here (owner columns, user_identifiers, connections, virtual_matches)
- `frontend/src/lib/storage.ts` (+ `storage-api.ts`) — per-user namespacing and the offline identity fix
- `frontend/src/lib/native-token-store.ts` — the single-file Keychain swap
- `backend/tests/integration/conftest.py` — the identity-injection harness the isolation suite builds on

---

### Provenance
- Auth-today audit: grounded read of the tree (cited file:line throughout §1), verified independently by the Plan pass.
- Architecture + phasing + the RLS-vs-app-layer decision: Plan agent on **fable** (owner directive — plan quality gates the epic), 2026-07-16.
- P1/P2 product shapes (connect model, Partners hub, Virtual Match MVP): `product-manager` pass, 2026-07-16.
- P0 design threat-model: adversarial `/security-review`-minded reviewer pass, 2026-07-16 — 1 BLOCKING (courses_mapped global-geometry writes) + 5 SHOULD-FIX + 2 NICE-TO-HAVE, all folded into §3.3.0 / §3.3.2 / §3.8.
