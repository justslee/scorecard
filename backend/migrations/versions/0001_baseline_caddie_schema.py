"""Baseline: represents caddie schema (supabase/migrations 001–004) already on RDS.

Revision ID: 001_baseline
Revises: (none)
Create Date: 2026-06-26

This revision has NO upgrade ops. It exists as a marker so Alembic can track
the pre-existing schema without trying to recreate it.

Tables already in Postgres (applied via supabase/migrations/001–004.sql):
  courses, tee_sets, holes, hole_yardages, hole_features,
  caddie_sessions, caddie_messages, player_profiles, caddie_memories,
  shots, caddie_personas, hole_pins, elevation_cache.

Deploy protocol (EC2 deploy box, run ONCE before any upgrade):
  DATABASE_URL=<real-url> uv run alembic stamp 001_baseline
  DATABASE_URL=<real-url> uv run alembic upgrade head
The stamp tells Alembic that 001_baseline is already applied; upgrade head
then applies ONLY the subsequent revisions (002_core_scoring, etc.).
"""

from typing import Sequence, Union

# revision identifiers
revision: str = "001_baseline"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # no-op: existing caddie tables were applied via supabase/migrations/001–004.sql
    pass


def downgrade() -> None:
    # Dropping the caddie schema is destructive and out of scope for this migration.
    pass
