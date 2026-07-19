"""Pure (no-DB) tests for migration 0013_016_golfer_profile_onboarding.

Encodes the reviewer's blocking existing-user-safety invariant as executable
checks (specs/onboarding-shell-and-gate-plan.md §6/§7): the new column must
carry NO server-side default (new rows insert NULL = needs onboarding), and
the one-time backfill must mark every PRE-EXISTING row 'done' so no current
user — including the owner — is ever funneled into first-run onboarding.
"""

import importlib.util
from pathlib import Path

_MIGRATION_PATH = (
    Path(__file__).resolve().parents[1]
    / "migrations"
    / "versions"
    / "0013_016_golfer_profile_onboarding.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location(
        "onboarding_migration_0013", _MIGRATION_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _source() -> str:
    return _MIGRATION_PATH.read_text()


def test_revision_identifiers():
    mig = _load_migration()
    assert mig.revision == "016_golfer_profile_onboarding"
    assert mig.down_revision == "015_course_intel"


def test_add_column_has_no_default():
    src = _source()
    # The ADD COLUMN statement (built from adjacent string literals inside
    # op.execute(...)) must carry no DEFAULT clause — a DEFAULT of 'done'
    # would make brand-new sign-ups insert 'done' and skip onboarding.
    assert "ADD COLUMN IF NOT EXISTS onboarding_step text" in src
    upgrade_src = src.split("def upgrade")[1].split("def downgrade")[0]
    add_column_stmt = upgrade_src.split("op.execute(")[1]
    assert "DEFAULT" not in add_column_stmt.upper()


def test_backfill_marks_preexisting_rows_done():
    src = _source()
    assert "SET onboarding_step = 'done'" in src
    assert "WHERE onboarding_step IS NULL" in src


def test_downgrade_drops_column():
    mig = _load_migration()
    assert callable(mig.downgrade)
    src = _source()
    assert "DROP COLUMN IF EXISTS onboarding_step" in src
