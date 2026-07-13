"""014_tournament_round_courses: per-day course plan for tournament setup.

Adds nullable ``round_courses`` (JSONB list, index = day-1; entries mirror the
rounds course-anchor shape or are null = "to be drawn") to ``tournaments``.
Powers the per-round COURSE plan at tournament setup (specs/
tournament-per-round-format-course-plan.md §1) — the golf-trip shape (Day 1
Bethpage Black, Day 2 Bethpage Red).

Additive and nullable, no default: NULL reads as "no plan", which is the exact
semantics of every existing tournament. Metadata-only change (no table
rewrite, no lock hazard). No backfill needed.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers
revision: str = "014_tournament_round_courses"
down_revision: Union[str, Sequence[str], None] = "013_caller_voice"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "tournaments",
        sa.Column("round_courses", postgresql.JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("tournaments", "round_courses")
