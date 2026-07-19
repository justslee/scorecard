"""Route-integration test harness.

CRITICAL: app/db/engine.py reads DATABASE_URL at module-import time and raises
RuntimeError if unset.  This conftest sets DATABASE_URL in os.environ at the
very top — before any import of app modules — so pytest can import and collect
the test file safely.

Architecture notes:
  - Routes import async_session from app.db.engine directly (not via
    Depends(get_session)), so we cannot swap the DB through dependency_overrides.
    Instead we point the whole engine at the test DB via DATABASE_URL.
  - current_user_id / require_owner ARE Depends-based, so we can override them
    via app.dependency_overrides to inject a test identity without real JWTs.
  - Schema is created with Base.metadata.create_all (no alembic in tests).
    The scores_round_player_hole_uq constraint lives only in the migration, so
    we add it via raw SQL after create_all.
"""

import os
import re
import socket
from pathlib import Path

# ── MUST come before any app import ──────────────────────────────────────────
# CI sets DATABASE_URL explicitly; local default points to a test Postgres.
_TEST_DB_URL: str = os.environ.get(
    "DATABASE_URL",
    "postgresql+asyncpg://postgres:postgres@localhost:5432/scorecard_test",
)
os.environ["DATABASE_URL"] = _TEST_DB_URL

# Keep auth closed for the "fails-closed" tests — no CLERK_JWKS_URL, no
# ALLOW_ANONYMOUS.  These values are read at import time by clerk_auth.py.
os.environ.pop("CLERK_JWKS_URL", None)
os.environ.pop("ALLOW_ANONYMOUS", None)

# ── Standard imports (after env patch) ───────────────────────────────────────
# E402 is expected here: os.environ must be patched before these imports so
# that any transitive import of app.db.engine finds DATABASE_URL already set.
import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from httpx import AsyncClient, ASGITransport  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402

# ── Shared constants ──────────────────────────────────────────────────────────
TEST_OWNER_ID = "test-owner-user-id"
OTHER_OWNER_ID = "other-owner-user-id"

# ── Postgres reachability probe ───────────────────────────────────────────────


def _parse_db_host_port() -> tuple[str, int]:
    """Extract host:port from the DATABASE_URL for the TCP probe."""
    m = re.search(r"@([^:@/]+):(\d+)/", _TEST_DB_URL)
    if m:
        return m.group(1), int(m.group(2))
    return "localhost", 5432


def _postgres_reachable() -> bool:
    host, port = _parse_db_host_port()
    try:
        socket.create_connection((host, port), timeout=2).close()
        return True
    except OSError:
        return False


# ── Schema lifecycle (created once, truncated between tests) ─────────────────
_schema_ready: bool = False


async def _ensure_schema(engine) -> None:
    global _schema_ready
    if _schema_ready:
        return
    from app.db.engine import Base  # lazy: DATABASE_URL already set

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # scores_round_player_hole_uq is defined in migration 0002, not in the
        # ORM model.  Add it via raw SQL so the pg on_conflict_do_update upsert
        # works correctly in the test DB.
        await conn.execute(
            text("""
                DO $$ BEGIN
                  IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = 'scores_round_player_hole_uq'
                  ) THEN
                    ALTER TABLE scores
                      ADD CONSTRAINT scores_round_player_hole_uq
                      UNIQUE (round_id, player_id, hole_number);
                  END IF;
                END $$;
            """)
        )

        # course-mapping tables (courses/tee_sets/holes/hole_yardages/hole_features)
        # are NOT ORM/Base tables — they come from raw SQL in migration 001. Run the
        # real migration file verbatim so the test schema never drifts from prod.
        mig = (
            Path(__file__).resolve().parents[2]
            / "supabase" / "migrations" / "001_course_mapping_schema.sql"
        )
        if not mig.is_file():
            raise RuntimeError(f"course-mapping migration not found: {mig}")
        sql_script = mig.read_text()
        # asyncpg's simple-query protocol runs a whole multi-statement / dollar-quoted
        # script; text()/prepared-statement path would choke on it.
        raw = await conn.get_raw_connection()
        await raw.driver_connection.execute(sql_script)

        # courses.course_intel is added by Alembic migration 015_course_intel
        # (backend/migrations/versions/0012_015_course_intel.py), NOT by the
        # 001 SQL replayed above — same precedent as the
        # scores_round_player_hole_uq block: schema that lives outside both
        # Base.metadata AND the guarded 001 supabase SQL is added here
        # explicitly so the test DB matches prod/staging after the real
        # migration runs there.
        await conn.execute(
            text(
                "ALTER TABLE courses ADD COLUMN IF NOT EXISTS course_intel "
                "jsonb NOT NULL DEFAULT '{}'::jsonb"
            )
        )

        # hole_pins.pin_geom is populated by the raw-SQL upsert in
        # app/routes/pins.py (PostGIS geography point) but is NOT part of the
        # HolePin ORM model (see models.py's HolePin docstring — adding it
        # would force create_all to need PostGIS before the 001 replay above
        # creates the extension). Same precedent as the course_intel block
        # directly above: schema outside both Base.metadata AND the guarded
        # 001 supabase SQL is added here explicitly. Nullable here vs NOT
        # NULL in prod (migration 004) is fine — the only write path always
        # supplies it.
        await conn.execute(
            text(
                "ALTER TABLE hole_pins ADD COLUMN IF NOT EXISTS pin_geom "
                "geography(point, 4326)"
            )
        )
    _schema_ready = True


# ── autouse fixture: skip if no Postgres, else clean tables between tests ─────


@pytest_asyncio.fixture(autouse=True)
async def _db():
    """Ensure schema exists and wipe data before each test.

    Skips the test gracefully if Postgres is not reachable (local dev without a
    running DB).  In CI the Postgres service is always up, so tests run there.
    """
    if not _postgres_reachable():
        pytest.skip(
            "Postgres not reachable — integration tests require a running "
            "Postgres.  Set DATABASE_URL or start postgres locally."
        )

    engine = create_async_engine(_TEST_DB_URL, echo=False)
    try:
        await _ensure_schema(engine)
        # Wipe all data-bearing tables before each test so tests are isolated.
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "TRUNCATE TABLE scores, games, round_players, player_groups,"
                    " rounds, course_reviews, players, golfer_profiles, tournaments,"
                    " tee_time_bookings, caddie_sessions, caddie_messages, shots,"
                    " player_profiles, caddie_memories, scoring_courses,"
                    " hole_features, hole_yardages, holes, tee_sets, courses"
                    " RESTART IDENTITY CASCADE"
                )
            )
        yield engine
    finally:
        await engine.dispose()


# ── HTTP client fixture ───────────────────────────────────────────────────────


@pytest_asyncio.fixture
async def client(_db):
    """httpx.AsyncClient bound to the FastAPI app via ASGI transport (no I/O)."""
    from app.main import app  # lazy import — DATABASE_URL is already set

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


# ── Auth helpers ──────────────────────────────────────────────────────────────


def set_auth(user_id: str | None, gate: bool = False) -> None:
    """Inject or clear Clerk auth dependency overrides on the FastAPI app.

    Call set_auth(TEST_OWNER_ID) to authenticate as that user for the next
    request(s); call set_auth(None) to restore the no-override (unauthenticated)
    state so that subsequent "fails-closed" assertions are correct.

    gate=False (default, used by the existing row-scoping/IDOR suite):
    overrides current_user_id, require_owner, AND require_member all -> uid.
    Identity is injected and the gate dependencies are bypassed entirely —
    matches today's belt-and-suspenders behavior (row-scoping is the real
    guard under test), so existing tests keep passing unchanged.

    gate=True (flip-regression tests ONLY, see test_authz_isolation.py): only
    current_user_id is overridden -> uid; require_member/require_owner are
    left REAL so the actual gate logic (APP_ACCESS_MODE / OWNER_CLERK_USER_ID,
    set via monkeypatch.setenv and read dynamically) is exercised end-to-end.
    """
    from app.main import app
    from app.services.clerk_auth import current_user_id, require_member, require_owner

    if user_id is None:
        app.dependency_overrides.pop(current_user_id, None)
        app.dependency_overrides.pop(require_owner, None)
        app.dependency_overrides.pop(require_member, None)
    else:
        uid = user_id  # close over value, not name
        app.dependency_overrides[current_user_id] = lambda: uid
        if gate:
            app.dependency_overrides.pop(require_owner, None)
            app.dependency_overrides.pop(require_member, None)
        else:
            app.dependency_overrides[require_owner] = lambda: uid
            app.dependency_overrides[require_member] = lambda: uid


@pytest.fixture(autouse=True)
def _clear_auth_overrides():
    """Ensure dependency_overrides are cleared after every test."""
    yield
    set_auth(None)
