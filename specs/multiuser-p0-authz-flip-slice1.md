# P0 Slice 1 — `require_member` authz foundation (build spec)

**Parent:** `specs/multi-user-epic-plan.md` §3.1 / §3.3.0 / §3.6 / §3.8. This is the FIRST
buildable slice of the owner-greenlit multi-user epic. **Backend only. Ships DARK: the flag
defaults OFF and prod behavior is byte-identical to today until the owner flips it.**

Classification: **SILENT** (no user-facing change while dark). MAJOR (auth) → `/security-review`
+ `/code-review` mandatory before ready.

## In scope (exactly these — do not scope-creep)

### 1. The flip: `require_member` with an owner-mode default
- Add env `APP_ACCESS_MODE` (values: `owner` (DEFAULT) | `open`) read **dynamically** in
  `backend/app/services/clerk_auth.py` via a small helper `def _access_mode() -> str:
  return (os.getenv("APP_ACCESS_MODE") or "owner").strip().lower()`. Read at call time (not a
  module constant) so tests can toggle it per-test without reimport. Cost is negligible.
- Add `def _owner_id() -> str | None: return os.getenv("OWNER_CLERK_USER_ID")` read dynamically
  (so the flip-regression test can set it).
- New dependency:
  ```python
  async def require_member(user_id: str = Depends(current_user_id)) -> str:
      mode = _access_mode()
      if mode == "open":
          # any verified Clerk sub passes; per-row scoping isolates data.
          # (denylist/revocation check is a LATER slice — noted, not built here)
          return user_id
      # owner mode (default): BYTE-IDENTICAL to require_owner today.
      owner = _owner_id()
      if owner and user_id != owner:
          raise HTTPException(403, "Forbidden: this deployment is owner-only.")
      return user_id
  ```
- `require_owner` stays **unchanged** (kept for the by-nature owner-only routes).
- `backend/app/main.py`: change `_owner_only = [Depends(require_owner)]` →
  `_member = [Depends(require_member)]` and apply `_member` to the SAME 17 data routers.
  Import `require_member` instead of (or alongside) `require_owner`.
- **Byte-identical proof:** in owner mode with `OWNER_CLERK_USER_ID` set, `require_member`
  returns exactly what `require_owner` returned (owner passes; non-owner 403; unset owner →
  passes through, same as today). Pin this with a test that asserts the two dependencies agree
  across {owner sub, non-owner sub, owner unset} × the same inputs.

### 2. Carve-outs stay owner-only (explicit `require_owner`, post-flip)
- **[BLOCKING find §3.3.0] `courses_mapped.py`**: add `Depends(require_owner)` to the three
  write handlers — `create_mapped` (POST `""`), `put_mapped` (PUT `/{course_id}`),
  `delete_mapped` (DELETE `/{course_id}`). GET handlers stay member-reachable. These mutate
  GLOBAL PostGIS geometry (no owner column) and re-precompute elevations/guides — a stranger
  must never overwrite/delete course geometry. Import `require_owner` into the module and add
  the dependency at the route decorator level (e.g. `dependencies=[Depends(require_owner)]` on
  the route, or as a param). In owner mode this is redundant-but-harmless (byte-identical); in
  open mode it is the actual guard.
- **`request_availability_call` (tee_times.py:960)**: currently `Depends(current_user_id)`.
  Change to `Depends(require_owner)` — it places a real outbound Twilio call and can speak the
  OWNER's `VOICE_BOOKING_OWNER_NUMBER`. Stays owner-only in slice 1 (the per-user-callback
  genericization is a later slice).
- `rehearsal_call` (:633), `get_caller_voice` (:767), `update_caller_voice` (:787) already bind
  `require_owner` — verify they survive the flip unchanged (they do; no edit needed, just a
  test asserting non-owner → 403 in open mode).

### 3. SHOULD-FIX hardenings (in scope for slice 1)
- **azp / issuer fail-closed (§3.8 SHOULD-FIX #2):** in `_verified_user_id`:
  - Add `CLERK_AUTHORIZED_PARTIES` env (comma-separated). When set, decode the token and
    **reject** (401) a token whose `azp` claim is **absent OR not in the allowlist**. When the
    env is unset, behavior is unchanged (backward-compatible; owner-mode prod has it unset).
  - Keep `verify_aud: False`.
  - **Open-mode boot guard:** if `_access_mode() == "open"` require BOTH `CLERK_ISSUER` and
    `CLERK_AUTHORIZED_PARTIES` to be set (else refuse to boot). Plus the existing §3.1 open-mode
    guard: refuse to boot if `open` and (`CLERK_JWKS_URL` unset OR `ALLOW_ANONYMOUS=1`). Put
    these in a `def _assert_boot_config()` called from the FastAPI **startup event** (NOT import
    time — import-time raise would break the test app fixture; startup event is skipped by the
    ASGITransport test unless explicitly triggered, and we add a direct unit test for the guard).
  - Owner-mode: loud `logging.warning` if `OWNER_CLERK_USER_ID` unset in a JWKS-configured
    deployment (today's silent fail-open, clerk_auth.py:97-98).
- **conftest `require_member` override (§3.8 SHOULD-FIX #6):** extend `set_auth` in
  `backend/tests/integration/conftest.py`. Give it a `gate: bool = False` param:
  - Default (`gate=False`, used by the row-scoping suite): override `current_user_id`,
    `require_owner`, AND `require_member` all → return `uid` (identity injected, gates bypassed —
    matches today's belt-and-suspenders behavior; existing tests keep passing unchanged).
  - `gate=True` (flip-regression only): override ONLY `current_user_id` → `uid`, leave
    `require_member`/`require_owner` REAL so the actual gate logic is exercised. The test sets
    `APP_ACCESS_MODE` / `OWNER_CLERK_USER_ID` via `monkeypatch.setenv` (read dynamically).
  - `_clear_auth_overrides` must also pop `require_member`.
- **CI scoping-lint (§2 + §3.8 SHOULD-FIX #4):** add `backend/ci_scripts/scoping_lint.py` (a
  grep/AST-based check) that scans `backend/app/routes/`, `backend/app/services/`, and
  `backend/app/caddie/` for `select(`/`update(`/`delete(` statements against a tenant table
  that lack an owner-scoping `.where(... user_id/owner_id ...)` in the same function. Support an
  explicit, commented **exemption allowlist** (e.g. `session.py:_load_messages` is safe only via
  `get_owned_session`; global reference-data reads on `courses/tee_sets/holes/...`; the
  `courses_mapped` store writes which are now `require_owner`-carved). Fail (exit 1) on an
  unexplained hit; print the file:line + table. Wire it into CI as a backend step
  (`uv run python ci_scripts/scoping_lint.py`). **It must pass clean on the current tree** — if
  it flags a real unscoped query that is NOT one of the known-deferred gaps, STOP and report it;
  do not silently exempt a real hole.

### 4. The authz-isolation test suite (the acceptance bar — §3.6)
New file `backend/tests/integration/test_authz_isolation.py`:
- **Per-router isolation, parametrized** over the tenant resources that are ALREADY row-scoped
  and fixed in this slice: **rounds, tournaments, players, profile, course_reviews, shots,
  caddie sessions, caddie memories, tee_time_bookings, scoring-courses**. For each: user A
  creates a row → as user B: `GET /{id}` → **404**; `LIST` → does not contain A's row;
  `PUT/PATCH/DELETE /{id}` → **404** and A's row is unchanged. Run the suite in **open mode**
  (`monkeypatch.setenv("APP_ACCESS_MODE", "open")`) with `set_auth(gate=False)` identity
  injection, so both users authenticate and only row-scoping isolates them. (Reuse/consolidate
  the existing IDOR tests' patterns; you may leave the existing per-file IDOR tests in place.)
- **404-not-403 enumeration property:** for every id-keyed route, assert B's cross-tenant
  response status AND body are identical to a random-nonexistent-id request. Parametrize.
- **Flip-regression (§3.6.3), `gate=True`:**
  - `APP_ACCESS_MODE=owner` + `OWNER_CLERK_USER_ID=A`: request as B (non-owner) → **403** on a
    representative sample across the 17 routers; request as A (owner) → passes. Freezes today's
    contract.
  - `APP_ACCESS_MODE=open`: both A and B pass auth on the same routers; then the row-isolation
    holds (A's data invisible to B).
- **Carve-out negative tests:** in `APP_ACCESS_MODE=open`, member B → POST/PUT/DELETE
  `/api/courses/mapped` → **403** (or 401), and course geometry is unchanged; B →
  `request_availability_call` → 403; B → caller-voice GET/PUT + rehearsal → 403. Owner A →
  these still reach their handler (may 400/not_enabled downstream — assert NOT 403).
- **Byte-identical unit test:** `require_member` (owner mode) agrees with `require_owner` across
  the identity matrix (pure unit test, no DB).
- **Boot-guard unit tests:** `_assert_boot_config()` raises for {open + no JWKS}, {open +
  ALLOW_ANONYMOUS}, {open + missing CLERK_ISSUER}, {open + missing CLERK_AUTHORIZED_PARTIES};
  passes for {owner + anything}, {open + all set}.
- **azp unit tests:** with `CLERK_AUTHORIZED_PARTIES` set, a token with absent `azp` → 401; wrong
  `azp` → 401; allowed `azp` → passes. (Mint test RS256 tokens or monkeypatch the decode path —
  match how existing clerk_auth tests do it if any exist under `backend/tests/`.)

## Out of scope (DEFER — document as "must-close-before-`APP_ACCESS_MODE=open`" in the backlog)
These are real open-mode gaps but are NOT in slice 1 (some need a migration, which is banned
this slice). Because the flag ships OFF, prod is unaffected. Add a prominent comment block above
`require_member` listing them as blockers-before-flip:
- **`hole_pins` → per-user** (§3.3.1) — needs a schema migration (banned this slice).
- **availability/OCR async job stamp-and-match** (§3.3.2) — request_availability_call is
  owner-only in slice 1, so no non-owner jobs exist yet; close before genericizing.
- **`caddie_personas` author-scoping** (§3.3.4).
- **`user_session(user_id)` centralization** — the RLS seam; large mechanical refactor, its own
  slice. The CI scoping-lint is the interim structural guard.
- Client identity / localStorage namespacing / Keychain / migrations / webhooks — separate P0
  slices already filed.

## Guardrails
- Never touch `main`, never force-push, never edit existing migrations, never echo secrets.
- The flag ships OFF (`APP_ACCESS_MODE` unset → owner mode). Prod behavior unchanged.
- Keep `frontend/src/lib/types.ts` ↔ `backend/app/models.py` in sync (this slice touches no
  shared shapes — verify none drift).

## Gates (all must pass on the pushed head)
- `cd backend && ruff check .`
- `cd backend && uv run pytest` (the isolation suite runs against the CI postgis service; locally
  it self-skips if no Postgres — that's expected, CI is the real gate).
- `cd backend && uv run python ci_scripts/scoping_lint.py` (clean).
- Frontend gates unaffected but must stay green: `npm run lint`, `npx tsc --noEmit`,
  `npx tsx voice-tests/runner.ts --smoke`, `npm test`, `npm run test:caddie-experience`.

## Commit
Commit to the current worktree branch with a descriptive message. Do NOT open a PR (the
eng-lead lands this on the fresh `integration/next` after the in-flight ship recuts). Do NOT push.
