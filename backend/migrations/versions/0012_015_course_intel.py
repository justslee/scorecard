"""015_course_intel: course-level precomputed intel cache.

Adds additive, non-nullable-with-default ``courses.course_intel jsonb`` — the
cache for the precomputed Augusta-styled description (course-discovery-intel,
specs/course-discovery-intel-plan.md §2). ``'{}'::jsonb`` is the honest "no
intel yet" state for every existing row; the app treats an absent
``description``/``attempted_at`` key inside it identically. No backfill
needed — new courses seed at mapping time going forward; the 3-course seed
set (Bethpage Black, Bethpage Red, Pebble Beach) is a separate, manually
operator-invoked, env-gated backfill (STOP item — owner approval required
before running it against prod/staging, see the plan §2).

Correct cardinality: a course-level fact belongs on the course-level row, not
parked on one arbitrary hole's ``hole_features.properties`` (Option B in the
plan, rejected — destroyed by re-mapping, and cannot serve write-through-only
rows with zero holes). Metadata-only change (no table rewrite beyond the
``ADD COLUMN ... DEFAULT``, no lock hazard at this table's scale).
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers
revision: str = "015_course_intel"
down_revision: Union[str, Sequence[str], None] = "014_tournament_round_courses"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE public.courses "
        "ADD COLUMN IF NOT EXISTS course_intel jsonb NOT NULL DEFAULT '{}'::jsonb"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE public.courses DROP COLUMN IF EXISTS course_intel")
