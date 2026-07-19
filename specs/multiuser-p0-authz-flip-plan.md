# Implementation Plan — `multiuser-p0-authz-flip` FLIP-PREP (authz core)

> Fable plan, 2026-07-19. Grounded against a fresh recon + verified file/line reads.
> This slice makes the deployment **flip-ready**; it does NOT flip prod (owner-gated
> separate call). Owner/single-user mode stays byte-identical. `APP_ACCESS_MODE` is
> never set outside test configs (monkeypatch only). Lands as ONE bundle item
> ("multi-user: flip-ready") on `integration/next`; migrations 017/018 are additive
> and auto-apply at merge (`.github/workflows/deploy.yml` runs `alembic upgrade head`).

**Slice goal:** close the four DEFERRED gaps documented in `backend/app/services/clerk_auth.py:143-163` (durable revocation, per-user `hole_pins`, persona author-scoping hardening, plus the flip-gate acceptance suite) so the deployment is *flip-ready*.

## 0. Grounding verification — corrections to the recon

All cited files/lines were read and verified. Confirmed accurate: `revocation.py` (in-process dict, `revoke()/is_revoked()` sync, `_debug_clear/_debug_snapshot/_debug_entry`), single writer `webhooks.py:167`, single reader `clerk_auth.py:192` (open mode only, owner short-circuit at :183-189), boot hook `main.py:114-138`, `HolePin` ORM `models.py:104-120` (no `user_id`), `pins.py` routes (:59-69 unscoped list, :72-127 upsert, `ON CONFLICT` at :100), prod DDL from `backend/supabase/migrations/004_simplify_hole_pins.sql` (unique `(course_id,hole_number,pin_date)`, `pin_geom geography NOT NULL`), scoping-lint exemptions at `ci_scripts/scoping_lint.py:109-119`, CI wiring `.github/workflows/ci.yml` (`required-backend`: ruff → scoping_lint → pytest, postgis:16-3.4 service), `conftest.py:152-160` TRUNCATE (no `hole_pins`/`caddie_personas`), `set_auth` :182-216 with `gate=True`, `courses_mapped.py` `require_owner` at :93/:142/:165, migration head `016_golfer_profile_onboarding` (single head), no frontend `HolePin` in `types.ts` (wire type is `PinRecord` in `frontend/src/lib/caddie/api.ts:528`).

**Corrections (these change the plan):**

1. **Personas: the "all callers gate with `personality_visible` first" claim is FALSE.** Two routes pass a client-supplied persona id straight to `load_personality()` with NO visibility gate:
   - `backend/app/routes/voice.py:100` — `POST /speak` (`persona = await load_personality(req.personality_id)`).
   - `backend/app/routes/realtime.py:87` — `POST /realtime/setup-session` (`personality = await load_personality(request.personality_id)`).
   Today user B who learns A's `custom-<slug>-<8hex>` id can bind A's private persona (voice identity; and any future caller that uses `system_prompt` would leak it). So item 4 is a **real gap closure**, not only defense-in-depth. The gated callers (with `"classic"` fallback) are `caddie.py:875-878`, `caddie.py:1707-1710`, `realtime.py:139-142`; `caddie.py:1478` gates profile writes.
2. **`hole_pins` in the test schema is broken for the upsert path today, and `user_id` alone won't fix it.** `Base.metadata.create_all` builds `hole_pins` from the ORM model, which has (a) **no `pin_geom` column** (the raw SQL at `pins.py:91-107` inserts it → `UndefinedColumnError` in the test DB) and (b) **no unique constraint** (`HolePin` has no `__table_args__` → `ON CONFLICT (…)` has no arbiter → `InvalidColumnReferenceError`). No existing integration test exercises `POST /pins`, which is why this never surfaced. The flip-gate pins tests require the conftest/ORM fixes in §3 below. (`geoalchemy2` is already a dependency — `backend/pyproject.toml:16` — but is unused in the ORM; do NOT introduce it into the model, see §3.)
3. **Stale test-class name:** the owner-mode-never-consults-revocation pin lives in `tests/test_clerk_auth.py::TestByteIdenticalOwnerMode` (:29) — there is no `TestRequireMemberOwnerModeUntouched` (the name in `require_member`'s docstring, `clerk_auth.py:174`, is stale). The pins that MUST stay green are `TestByteIdenticalOwnerMode`, `TestBootGuard`, `TestAzpHardening`, `TestRevocation` (:245-264) and all of `tests/test_webhooks_clerk.py`. Optionally fix the stale docstring reference while editing that block.
4. **Two omissions in the pins sketch:** (a) `list_pins` currently has **no identity dependency at all** — it needs `Depends(current_user_id)` added, not just a filter; (b) the read-back `select` after the upsert (`pins.py:119-126`) must also gain `HolePin.user_id == user_id`, otherwise `scalar_one()` raises `MultipleResultsFound` the moment two users have pinned the same (course, hole, date).
5. **`tests/test_webhooks_clerk.py` deliberately runs with NO DB** (module docstring: importing `app.routes.webhooks` "pulls in only app.services.revocation, no app.db.engine"). The durable-revocation design must preserve that import property (lazy engine import) and be DB-failure-tolerant, or those tests break. Also note: when the full suite runs in CI, `tests/integration/conftest.py` sets `DATABASE_URL` process-wide at collection time, and `test_webhooks_clerk` drives the route through a **sync `TestClient`** (its own event loop) — a DB write there could hit the shared asyncpg engine from a foreign loop. §2 designs around this with a monkeypatchable persistence seam + catch-all fallback.

---

## 1. Migration 017 — durable `revoked_users` (+ ORM model)

**Files:**
- NEW `backend/migrations/versions/0014_017_revoked_users.py` — `revision = "017_revoked_users"`, `down_revision = "016_golfer_profile_onboarding"` (follow the exact idioms of `0013_016_golfer_profile_onboarding.py`: module docstring, `op.execute`, `IF NOT EXISTS`, typed `revision/down_revision`).
- `backend/app/db/models.py` — new `class RevokedUser(Base)` (place after `CaddiePersona`, before the core-scoring banner, with a docstring citing §3.4 and migration 017).

**Decision (per prompt): BOTH the ORM model and the Alembic migration, kept consistent.** The ORM model makes `create_all` build the table in the test DB automatically (same mechanism as every other Base table in `conftest._ensure_schema`); the migration creates it in prod. Columns identical in both:

```
user_id     text primary key
revoked_at  timestamptz not null default now()
reason      text            -- nullable
source      text            -- nullable
```

ORM: `user_id: Mapped[str] = mapped_column(Text, primary_key=True)`; `revoked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())`; `reason`/`source` `Mapped[Optional[str]]` Text nullable.

Migration `upgrade()`: single `op.execute("CREATE TABLE IF NOT EXISTS public.revoked_users ( ... )")` — idempotent, additive, no data. `downgrade()`: `op.execute("DROP TABLE IF EXISTS public.revoked_users")`.

**Scoping lint:** `RevokedUser` is deliberately NOT a `TENANT_MODELS` entry — it is the global ban list, queried without caller scoping by design. Add it to the "Deliberately NOT here (and why)" comment block in `ci_scripts/scoping_lint.py:50-65` so the omission is visible and reasoned, not accidental (the lint scans `app/services/`, where `revocation.py`'s new `select(RevokedUser)` will live — since the class isn't in `TENANT_MODELS`, it passes; the comment prevents a future reader from "fixing" that).

**Edge cases / risks:** none material — empty additive table. Prod deploy order is safe: `deploy.yml` runs `alembic upgrade head` before the app restarts, so the table exists before any warm-read.
**Gate:** migration file lints (ruff); table appears in test DB via `create_all` (exercised by the §5 revocation test); `alembic heads` shows the single head `018_...` after §3 (verify with `cd backend && uv run alembic heads` — read-only, no DB needed for `heads`).

## 2. `revocation.py` — write-through + boot-warmed read cache

**Files:** `backend/app/services/revocation.py` (core), `backend/app/routes/webhooks.py` (one-line call change + docstring touch), `backend/app/main.py` (startup warm), `backend/app/services/clerk_auth.py` (DEFERRED-block comment update only — no logic change).

**Design — three functions, existing API untouched:**

1. **`revoke()` — UNCHANGED, byte-for-byte.** It remains the sync, in-process cache primitive with the exact current signature `revoke(user_id, reason="unknown", source="clerk_webhook")`. `tests/test_clerk_auth.py::TestRevocation` (:253-259 calls `revocation.revoke(...)` sync) stays green with zero edits.

2. **NEW `async def revoke_durable(user_id: str, reason: str = "unknown", source: str = "clerk_webhook") -> None`** — the write-through entry point for the webhook:
   ```
   persist first, cache always:
     try:    await _persist_revocation(user_id, reason, source)   # DB row
     except Exception: log.error("revocation DB write FAILED for %s — enforced in-process only until restart", ...)  # loud, no re-raise
     finally: revoke(user_id, reason=reason, source=source)        # in-process cache, unconditional
   ```
   **NEW internal seam `async def _persist_revocation(user_id, reason, source)`**: lazy-imports `from app.db.engine import async_session` **inside the function** (preserves the no-`DATABASE_URL`-needed import property that `test_webhooks_clerk.py` depends on), then `INSERT INTO revoked_users ... ON CONFLICT (user_id) DO UPDATE SET revoked_at=now(), reason=excluded.reason, source=excluded.source` (idempotent — re-revoking refreshes, mirroring `revoke()`'s semantics). Implement with the ORM/`text()` — either is fine; `text()` avoids importing the model here.

3. **NEW `async def warm_revocation_cache() -> int`** — reads all `revoked_users` rows and populates the in-process dict under `_lock` (merge, don't clear — cache may already hold webhook-delivered entries), returning the row count (useful for the boot log + tests). Same lazy-import discipline.

**Webhook handler (`webhooks.py:167`):** change the one line to `await revocation.revoke_durable(revoked_user_id, reason=event_type, source="clerk_webhook")`. Nothing else in the handler changes; Svix verification, replay guard, and the ack contract are untouched. Update the module docstring's "in-process revocation store" phrase to "durable revocation store (Postgres `revoked_users`, write-through to the in-process cache)".

**DB-write failure policy — recommend fail-*enforced*, ack 200 (as the prompt suggests):** on persistence failure we still update the in-process cache (the ban IS enforced for this process's lifetime), log at ERROR, and return 200. Residual risk: if the process restarts before a successful write ever lands, that revocation is silently lost (Clerk will not redeliver an acked event). Discussion of the alternative — returning 500 so Clerk/Svix retries: it interacts badly with our own replay guard (`webhooks.py:104-111` records `svix_id` in `_seen_ids` *before* the revoke call, so a Svix retry reusing the same `svix-id` within the 5-minute window would be rejected as a replay with 400), and fixing that means only recording the replay-id after success — a behavior change to tested code. Given single-instance deployment, an in-process-enforced ban until next successful boot-warm, and Clerk bans being re-issuable from the dashboard, the 200-ack posture is the right risk trade for this slice. Document exactly this in `revoke_durable`'s docstring. (If the eng-lead wants the stricter posture later, it's a contained follow-up: move the `_seen_ids` record after the revoke and return 503 on persist failure.)

**Boot warm (`main.py` startup, :114-138):** after `_assert_boot_config()` (:127), add:
```python
from app.services import revocation
from app.services.clerk_auth import _access_mode   # or reuse existing import style
if _access_mode() == "open":
    count = await revocation.warm_revocation_cache()   # raises on failure — fail closed
    log.info("revocation cache warmed: %d revoked user(s)", count)
```
- **Open-mode-only warm, and failure = refuse to boot** (let the exception propagate out of `startup`, consistent with `_assert_boot_config`'s fail-closed philosophy): in open mode, booting without the ban list would silently un-revoke banned members — exactly the scenario the DEFERRED note forbids. A DB that can't serve one SELECT at boot can't serve the app anyway.
- **Owner mode: no warm call at all** — owner-mode boot does ZERO new work (byte-identical guarantee; owner mode never consults the store, `clerk_auth.py:183-189`). The flip runbook's restart is what performs the first warm.
- The ASGITransport test fixture never fires FastAPI startup (documented in `_assert_boot_config`'s docstring, `clerk_auth.py:197-204`), so existing integration tests see no behavior change; the flip-gate suite calls `warm_revocation_cache()` explicitly.

**Docstring updates in `revocation.py`:** rewrite the "INTERIM, NOT DURABLE" module docstring: the store is now a write-through cache over `revoked_users` (migration 017), warmed at boot in open mode; keep the `_TTL_SECONDS` note but restate it honestly — with a single writer process and write-through, the cache is always a superset of the DB during a process's life, so no TTL re-poll is needed yet; `_TTL_SECONDS` remains the documented freshness window for the future multi-instance/Redis follow-up (and is still unused). `is_revoked()` stays sync + cache-only (the fast path in `require_member`).

**`clerk_auth.py:143-163` DEFERRED block:** update it — mark revocation durability CLOSED (migration 017 + write-through + boot warm), mark hole_pins CLOSED (migration 018, §3), mark caddie_personas CLOSED (§4); leave availability/OCR stamp-and-match (safe via the `request_availability_call` owner-only carve-out) and `user_session` centralization as the remaining deferred items. Fix the stale `TestRequireMemberOwnerModeUntouchable` → `TestByteIdenticalOwnerMode` reference at :174 while there. Comment-only edit; no logic.

**Edge cases:**
- `test_webhooks_clerk.py` in CI: `DATABASE_URL` is set process-wide (integration conftest import), the sync `TestClient` loop ≠ the session asyncio loop, so `_persist_revocation` may fail with a loop-binding error — caught by the catch-all, cache still updated, assertions (`revocation.is_revoked(...)`) stay green. If CI shows noisy ERROR logs or (worst case) pool pollution, the sanctioned extension is to add `monkeypatch.setattr(revocation, "_persist_revocation", <async no-op>)` to that file's autouse fixture — an extension of a no-DB unit file to keep it a no-DB unit file, not a force-pass edit. Prefer to try without it first.
- `_MAX_TRACKED` cap: `warm_revocation_cache` should log a warning if row count exceeds the cap (practically impossible).
- Never let owner mode consult the store: no changes to `require_member` at all in this slice.

**Gate:** `tests/test_clerk_auth.py` + `tests/test_webhooks_clerk.py` green unmodified; flip-gate revocation-survives-restart test (§5) green in CI.

## 3. Migration 018 — `hole_pins` per-user + ORM + `pins.py` scoping + lint exemption removal

**Files:** NEW `backend/migrations/versions/0015_018_hole_pins_per_user.py` (`revision = "018_hole_pins_per_user"`, `down_revision = "017_revoked_users"`); `backend/app/db/models.py:104-120`; `backend/app/routes/pins.py`; `backend/ci_scripts/scoping_lint.py`; `backend/tests/integration/conftest.py`.

### 3a. Migration 018 `upgrade()` (all `op.execute`, idempotent, additive-compatible)
1. `ALTER TABLE public.hole_pins ADD COLUMN IF NOT EXISTS user_id text`
2. **Backfill with anonymous-row handling** (§3.8 SHOULD-FIX): via `op.get_bind()`:
   - `owner = os.getenv("OWNER_CLERK_USER_ID")`.
   - Count rows needing the owner fallback: `SELECT count(*) FROM public.hole_pins WHERE user_id IS NULL AND (marked_by_user_id IS NULL OR marked_by_user_id = 'anonymous')`. **If count > 0 and `owner` is unset → `raise RuntimeError` (abort the migration)** — never invent an identity. (Abort-if-needed-and-unset is the right call: prod has `OWNER_CLERK_USER_ID` set, so this never fires there; a dev DB with orphan pins fails loudly instead of silently mis-owning data. Empty/clean DBs migrate fine with the var unset.)
   - `UPDATE public.hole_pins SET user_id = coalesce(nullif(marked_by_user_id, 'anonymous'), :owner) WHERE user_id IS NULL` (bound param; the `WHERE user_id IS NULL` makes re-runs no-ops).
3. `ALTER TABLE public.hole_pins ALTER COLUMN user_id SET NOT NULL` (required: NULLs never conflict under a unique constraint, which would break upsert semantics).
4. `ALTER TABLE public.hole_pins DROP CONSTRAINT IF EXISTS hole_pins_course_id_hole_number_pin_date_key` (the auto-generated name from 004's inline `unique(...)` — verify the name in the migration with a `pg_constraint` guard, same DO-block idiom as 004's trigger guard).
5. Add the new unique, guarded for idempotency:
   ```sql
   DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hole_pins_course_hole_date_user_key') THEN
       ALTER TABLE public.hole_pins ADD CONSTRAINT hole_pins_course_hole_date_user_key
         UNIQUE (course_id, hole_number, pin_date, user_id);
     END IF;
   END $$
   ```
   (Safe from duplicate-key failure: the old 3-column unique guaranteed at most one row per triple, so the 4-column key cannot collide.)
6. `CREATE INDEX IF NOT EXISTS hole_pins_user_course_date_idx ON public.hole_pins (user_id, course_id, pin_date)` — serves the new `list_pins` predicate; keep 004's `hole_pins_course_date_idx` (future community-pin reads).

`downgrade()`: drop the new index + constraint; **dedupe before restoring the old unique** (`DELETE` keeping the max-`updated_at` row per `(course_id, hole_number, pin_date)` — document the deliberate last-writer data collapse in the docstring); re-add the 3-column unique under its original name; `DROP COLUMN IF EXISTS user_id`.

### 3b. ORM (`models.py` `HolePin`)
- Add `user_id: Mapped[str] = mapped_column(Text, nullable=False)` after `pin_date`.
- Add `__table_args__ = (UniqueConstraint("course_id", "hole_number", "pin_date", "user_id", name="hole_pins_course_hole_date_user_key"),)` — name matches the migration exactly. Import `UniqueConstraint` in the existing sqlalchemy import at :14-16.
- Update the class/module docstring (keyed per-user since migration 018; `pin_geom` exists only in prod DDL/conftest, not in the ORM — note it).
- **Do NOT add `pin_geom` to the ORM** (would need a GeoAlchemy2 column type and would force `create_all` to require PostGIS *before* the 001 replay creates the extension in `_ensure_schema`'s ordering). Instead, in `conftest._ensure_schema`, **after** the 001 replay (:100-113, which runs `create extension if not exists postgis` — verified at 001:5), add the same explicit-DDL precedent as the `course_intel` block (:115-127):
  ```python
  await conn.execute(text(
      "ALTER TABLE hole_pins ADD COLUMN IF NOT EXISTS pin_geom geography(point, 4326)"
  ))
  ```
  (Nullable in tests vs NOT NULL in prod — acceptable: the only write path, the raw upsert, always supplies it; note the delta in the comment.) The `user_id` column + unique arbiter come from `create_all` via the ORM — no further conftest DDL.

### 3c. `pins.py` scoping
- `list_pins` (:59-69): add `user_id: str = Depends(current_user_id)` (new — the route currently has no identity dep at all) and `.where(HolePin.user_id == user_id)`. Response model/order unchanged.
- `upsert_pin` (:72-127):
  - raw SQL: add `user_id` to the insert column list and `:user_id` to VALUES; conflict target → `on conflict (course_id, hole_number, pin_date, user_id) do update set ...` (DO UPDATE list unchanged — `marked_by_user_id = excluded.marked_by_user_id` stays; it now always equals `user_id` for manual pins, and remains the honest wire field).
  - read-back select (:119-126): add `HolePin.user_id == user_id` (**required** — prevents `MultipleResultsFound` once two users pin the same triple).
- Module docstring (:1-9): storage now keyed `(course_id, hole_number, pin_date, user_id)`, per-user since migration 018; the `source='admin'` community-pin future note stays.
- **Wire shape: UNCHANGED.** `PinOut` keeps its exact fields (`marked_by_user_id` already carries the author). Do NOT add `user_id` to the response. Verified: `frontend/src/lib/types.ts` has no pin type; the client shape is `PinRecord` (`frontend/src/lib/caddie/api.ts:528`) served by `fetchPinsForCourse`/`markPin` (:539/:544) — no frontend change, therefore **no `types.ts`↔`models.py` sync needed and no frontend gates**.

### 3d. Scoping lint
- Delete both `("app/routes/pins.py", "list_pins")` and `("app/routes/pins.py", "upsert_pin")` entries from `EXEMPTIONS` (:109-119).
- Update `TENANT_MODELS["HolePin"]` (:83) from the "NOT YET per-user" note to plain `"user_id"`.
- `list_pins` now satisfies rule (a) via `.user_id`; the raw-SQL upsert remains out of scan surface (module doc :27-31) but its read-back select is scoped. Lint must pass with the exemptions **removed** — that's the structural proof of closure.

**Edge cases:** existing prod pins backfill to `marked_by_user_id` (the owner's sub for every real row) → owner sees all his pins post-migration, byte-identical experience; a non-owner (post-flip) starts with zero pins for every course — the accepted §3.3.1 behavior change; `pin_date` defaulting to server "today" unchanged; `hole_number` 1–18 check lives only in prod DDL (fine).
**Risks:** constraint-name mismatch between 004's auto-generated name and step 4 (mitigated: `IF EXISTS` + a fallback lookup-by-columns in the DO block if paranoid); downgrade data collapse (documented, and downgrade is never auto-run).
**Gate:** scoping_lint clean with zero pins exemptions; flip-gate pins-isolation tests (§5) green in CI; ruff.

## 4. Personas — harden `load_personality` + read-isolation test

**Files:** `backend/app/caddie/personalities.py:177-183`; call sites `backend/app/routes/voice.py:100`, `backend/app/routes/realtime.py:87` and `:142`, `backend/app/routes/caddie.py:878` and `:1710`; test in §5's file.

**No migration needed — confirmed** (`caddie_personas` already has `is_builtin/is_public/author_user_id`, `models.py:179-181`; supabase 003 created them; writes already author-stamp + force private, `caddie.py:1375-1420`; list/visible already scoped, `personalities.py:186-246`). There are no persona UPDATE/DELETE endpoints — confirmed; nothing to scope there (a future authoring slice adds them WITH author-match-404, per §3.3.4 — note this in the DEFERRED-block rewrite as covered/naturally-scoped).

**Change:** make `load_personality` itself enforce visibility (defense-in-depth that also closes the two genuinely ungated callers found in §0-correction-1):
```python
async def load_personality(personality_id: str, user_id: Optional[str] = None) -> CaddiePersonality:
    """Resolve a personality by id — DB first, hardcoded fallback.
    A DB persona is returned only if it is built-in, public, or authored by
    user_id; anything else falls back to the default persona (same silent-
    fallback semantics as an unknown id — no enumeration signal)."""
    async with async_session() as db:
        row = await db.get(CaddiePersonaRow, personality_id)
        if row is not None and (row.is_builtin or row.is_public
                                or (user_id and row.author_user_id == user_id)):
            return _row_to_personality(row)
    return PERSONALITIES.get(personality_id, PERSONALITIES[DEFAULT_PERSONALITY_ID])
```
Keyword default `user_id=None` keeps the signature backward-compatible; **every caller is updated to pass its identity** (all five have `user_id` in scope from `Depends(caddie_rate_limited_user)` / `Depends(current_user_id)`): `voice.py:100` → `load_personality(req.personality_id, user_id=user_id)`; `realtime.py:87` and `:142` likewise; `caddie.py:878` and `:1710` likewise. Critical subtlety: the gated callers currently call `load_personality(persona_id)` *after* resolving the fallback id — passing `user_id` there is required anyway, because a user's OWN private persona (author == me) must still load; with `user_id=None` it would wrongly fall back to classic. The `personality_visible` pre-gates (:139/:875/:1707/:1478) stay — they exist to give honest fallback/validation UX; `load_personality` is now the enforcement backstop ("caller-gating invariant" becomes a hard invariant of the loader itself).

**Tests (in the flip-gate file, §5):** (a) function-level lock: A creates a private persona via `POST /api/caddie/personalities`; `load_personality(id, user_id=B)` returns the classic fallback (assert `persona.id != created_id` and `system_prompt != A's`), `load_personality(id, user_id=A)` returns A's; `load_personality(id)` (no user) returns fallback. (b) route-level read isolation: B's `GET /api/caddie/personalities` does not contain A's persona id; A's does. This is the §3.3.4 read-isolation proof.

**Edge cases:** builtin seed rows in the DB (`is_builtin=True`) unaffected; `optional_user_id` callers (`GET /personalities`, `caddie.py:1351`) unchanged; no wire-shape change anywhere.
**Risk:** minimal — a stricter loader can only *narrow* what loads; the only narrowing is private-persona-to-non-author, which was the leak.

## 5. THE FLIP-GATE suite

**Files:** NEW `backend/tests/integration/test_flip_gate.py`; `backend/tests/integration/conftest.py` (TRUNCATE + pin_geom DDL from §3b); `backend/pyproject.toml` (`markers`); one-line marker addition to `backend/tests/integration/test_bag_caddie_grounding.py`.

**Marker + collection:** register in `[tool.pytest.ini_options]`: `markers = ["flip_gate: multi-user open-mode acceptance gate — runs under REAL APP_ACCESS_MODE=open boot config"]`. New file sets `pytestmark = pytest.mark.flip_gate`. CI needs **no workflow change** — `uv run pytest` with `testpaths=["tests"]` collects it in `required-backend` automatically (Postgres service present). `pytest -m flip_gate` runs the gate in isolation. Add `pytestmark = pytest.mark.flip_gate` to `test_bag_caddie_grounding.py` too (it is literally titled "MULTI-USER FLIP-TIME GATE" — marking it folds the existing 6 two-user bag tests into the gate without touching their bodies; an extension, not an edit-to-pass).

**conftest changes:** TRUNCATE list (:152-160) += `hole_pins, caddie_personas, revoked_users` (all three now data-bearing in the suite); plus the `pin_geom` ALTER from §3b. `set_auth` needs NO change (`gate=True` already leaves the real `require_member` in place, :196-216).

**The open-mode env fixture** (the "real boot config" — set ONLY via monkeypatch, per the hard rule):
```python
@pytest.fixture
def open_mode(monkeypatch):
    monkeypatch.setenv("APP_ACCESS_MODE", "open")
    monkeypatch.setenv("CLERK_JWKS_URL", "https://clerk.test.looper/.well-known/jwks.json")
    monkeypatch.setenv("CLERK_ISSUER", "https://clerk.test.looper")
    monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES", "https://localhost,https://test.looper")
    monkeypatch.delenv("ALLOW_ANONYMOUS", raising=False)
    from app.services.clerk_auth import _assert_boot_config
    _assert_boot_config()          # the REAL boot gate must pass under this env
```
Note: monkeypatching `CLERK_JWKS_URL` does not rebuild the module-level `_jwks_client` (`clerk_auth.py:30`) — irrelevant here because identity is injected via `set_auth(uid, gate=True)` (only `current_user_id` overridden; `require_member` runs REAL against the dynamic `_access_mode()`).

**Tests:**
1. `test_boot_config_gate(open_mode)` — the fixture already proves `_assert_boot_config()` passes; add negatives inside the test: `monkeypatch.delenv("CLERK_ISSUER")` → raises; `setenv("ALLOW_ANONYMOUS","1")` → raises (asserting the flip-day env checklist is machine-checked, complementing `TestBootGuard`).
2. `test_revocation_survives_restart(open_mode, client)` — `await revocation.revoke_durable("banned-b", reason="user.banned", source="clerk_webhook")` → assert DB row exists (direct select via the test engine) → `revocation._debug_clear()` (simulated restart: in-process state gone) → assert `not revocation.is_revoked("banned-b")` → `n = await revocation.warm_revocation_cache()`; assert `n >= 1` and `is_revoked("banned-b")` → `set_auth("banned-b", gate=True)`; `GET /api/rounds` → **403**; then `set_auth(TEST_OWNER_ID, gate=True)` with `APP_ACCESS_MODE` deleted + `OWNER_CLERK_USER_ID=TEST_OWNER_ID` → owner still 200 (owner mode never consults the store, route-level).
3. `test_pins_isolated_per_user(open_mode, client)` — A (`gate=True`) `POST /api/courses/c-1/pins` hole 1 (lat/lng α) → 200; B `GET` → `[]`; B `POST` same course/hole/date (β) → 200 (no clobber — distinct rows under the 4-column key); A `GET` → exactly α (unchanged, `marked_by_user_id == A`); B `GET` → exactly β; A re-`POST` (α′) → A sees α′, B still sees β (upsert stays within-user).
4. `test_personas_read_isolation(open_mode, client)` — §4's (a)+(b).
5. `test_cross_user_sweep_real_gate(open_mode, client)` — the 403/404 sweep with the REAL gate under full open env (complements `test_authz_isolation.py`, whose per-router classes run `gate=False` and only set `APP_ACCESS_MODE`): A creates a round → B `GET/PUT/DELETE /api/rounds/{id}` → 404 each, A's row byte-unchanged; B `GET /api/caddie/session/{A_round}/status`-equivalent → 404; A/B `GET /api/profile/golfer` return their own rows only.
6. `test_two_user_bags_under_real_gate(open_mode, client)` — a compact gate=True variant of the bag cross-leak proof: seed A and B bags via real `PUT /api/profile/golfer` with `set_auth(uid, gate=True)`, start sessions without `club_distances`, assert each session's hydrated bag binds to its own account (reuse `BAG_A_CAMEL/BAG_B_CAMEL` constants by importing from `.test_bag_caddie_grounding`; write local seed/start helpers since that module's helpers hardcode `gate=False`). The full 6-test bag suite still runs (now `flip_gate`-marked) with its own harness.

**Do NOT edit** `test_authz_isolation.py`, `test_clerk_auth.py`, or `test_webhooks_clerk.py` bodies — they are the frozen pins.

**Edge cases:** session-scoped event loop (pyproject :36-41) means `revoke_durable`/`warm_revocation_cache` in tests share the routes' engine loop — consistent, no loop mismatch in the async tests; `_debug_clear` between tests via an autouse fixture in the new file (mirror `TestRevocation`'s `_clean_revocation`); TRUNCATE handles `revoked_users` rows.

## 6. FLIP RUNBOOK — exact section to append to `specs/multi-user-epic-plan.md`

Insert as a new `## 8. Flip runbook (APP_ACCESS_MODE owner → open)` immediately **before** the `### Critical Files for Implementation` heading (line 253), after the `## 7` section's closing `---`. Content (verbatim-ready):

> ## 8. Flip runbook (APP_ACCESS_MODE owner → open)
>
> Owner-gated, deliberate action — nothing in the unattended loop ever performs these steps. Precondition: the "flip-ready" bundle is merged (migrations `017_revoked_users` and `018_hole_pins_per_user` are additive and were auto-applied by the deploy's `alembic upgrade head` at merge — verify with `alembic current` = `018_hole_pins_per_user` before flipping), and the `flip_gate` suite is green in CI (`cd backend && uv run pytest -m flip_gate`).
>
> 1. **Env change (prod, Secrets Manager / backend/.env):** set `APP_ACCESS_MODE=open`; ensure `CLERK_JWKS_URL` is set, `ALLOW_ANONYMOUS` is UNSET, and set the two newly-required vars: `CLERK_ISSUER` (the Clerk instance issuer URL) and `CLERK_AUTHORIZED_PARTIES` (comma-separated: the Capacitor origin `https://localhost` + the prod web origin). Set `CLERK_WEBHOOK_SECRET` (Svix) and configure the Clerk webhook (`user.deleted`, `user.banned`, `session.revoked` → `POST /api/webhooks/clerk`). Open Clerk signups (dashboard) as the same action.
> 2. **Restart the backend.** `_assert_boot_config()` refuses to boot on any misconfiguration above; startup then warms the revocation cache from `revoked_users` (open mode only) — a restart can never silently un-revoke a banned member.
> 3. **Migration order note:** 017 then 018, both already applied (additive, backward-compatible with owner-mode code — that is why they merge ahead of the flip). No flip-day migration work. The separate §3.2 backfill/tighten migrations remain their own reviewed PR.
> 4. **Live post-flip smoke:** sign in with a second real Clerk account: it sees empty rounds/pins/profile (never the owner's data); create a round + mark a pin; verify the owner's app is unaffected (his rounds, his pins for the same course/date unchanged); verify a revoked test account 403s on `/api/rounds`. Owner account: everything byte-identical.
> 5. **Rollback:** unset `APP_ACCESS_MODE` (or set `owner`) + restart — require_member reverts to the owner-only gate. Migrations STAY (additive and backward-compatible: `hole_pins.user_id` is stamped by owner-mode writes too; `revoked_users` is inert in owner mode). Optionally re-restrict Clerk signups.
> 6. **Carve-outs that STAY owner-only after the flip:** `courses_mapped.py` POST/PUT/DELETE (:93/:142/:165 — global course geometry); caller-voice GET/PUT, rehearsal-call, voice-booking config (`tee_times.py` param-level `require_owner`); `request_availability_call` (real outbound telephony; per-member callback numbers are a future slice). Availability-job stamp-and-match and `user_session` centralization remain deferred, safe behind these carve-outs (see the DEFERRED block in `clerk_auth.py`).

## Build order

1. §1 — Migration 017 + `RevokedUser` ORM + lint comment.
2. §2 — `revocation.py` durable layer; `webhooks.py` one-liner; `main.py` open-mode warm; `clerk_auth.py` comment update. Run pure-logic pytest locally (green without DB).
3. §3 — Migration 018 + `HolePin` ORM + `pins.py` + lint exemptions removed + conftest `pin_geom`/TRUNCATE.
4. §4 — `load_personality` hardening + 5 call sites.
5. §5 — `test_flip_gate.py` + marker registration + bag-file marker.
6. §6 — runbook appended to the epic plan; update `tasks/progress.md`.
7. Gates, then `/security-review` + `/code-review` (mandatory: auth + data-handling change, per CLAUDE.md).

## Gates (exact list)

- `cd backend && uv run ruff check .`
- `cd backend && uv run python ci_scripts/scoping_lint.py` (must be clean with the two pins exemptions REMOVED)
- `cd backend && uv run pytest` locally — pure-logic tests must pass; `tests/integration/` **skips gracefully** (no local Postgres on this machine — do NOT spin up a container; the conftest's reachability probe handles it)
- DB-backed proof runs in CI `required-backend` (postgis:16-3.4): full suite incl. `tests/integration/test_flip_gate.py`; confirm `pytest -m flip_gate` selects the gate
- `cd backend && uv run alembic heads` → single head `018_hole_pins_per_user`
- Frontend gates (tsc/lint/voice-tests): **NOT required** — no frontend file is touched (pin wire shape unchanged; verified `PinRecord` needs no change). If review ends up adding `user_id` to `PinOut` (not recommended), then and only then sync `PinRecord` and run `npx tsc --noEmit` + `npm run lint` + voice smoke.

## Shared-type sync

None. `types.ts` untouched (no pin type exists there); `backend/app/models.py` (API models) untouched; the only schema change (`hole_pins.user_id`, `revoked_users`) is server-internal in `backend/app/db/models.py` and never serialized to the client.

## De-scope flags / owner decisions

- **Owner decision #6 (per-user pins):** this slice implements the epic's *recommendation*; the flip runbook's community-pin note preserves the future shared-pin path (`source='admin'`). Flag in the bundle notes that the recommendation was taken.
- **Deliberately still deferred (safe):** availability-job stamp-and-match (behind the `request_availability_call` owner-only carve-out) and `user_session` centralization — keep in the updated DEFERRED block; do not attempt in this slice.
- **Needs no owner call but worth surfacing:** webhook DB-write-failure = enforce-in-process + ack-200 (lost-write-until-reban residual risk, §2); migration 018 aborts if `OWNER_CLERK_USER_ID` is unset while orphan/anonymous pins exist (deploy env must keep the var set — it is set today).
- The DEFERRED comment rewrite in `clerk_auth.py` and the bag-file marker are comment/marker-only edits — inside the guard rules (no test bodies edited, no guarded paths touched; `backend/supabase/migrations/**` is read-only and stays untouched).
