"""016_golfer_profile_onboarding: resumable first-run onboarding state.

Adds additive, NULLABLE ``golfer_profiles.onboarding_step text`` — the last
COMPLETED onboarding step (NULL | 'name' | 'handicap' | 'bag' | 'done', see
specs/login-onboarding-redesign-plan.md §4.1), then a ONE-TIME backfill of
'done' for every PRE-EXISTING row so no current user (incl. the owner) is
ever funneled into first-run onboarding.

CRITICAL: the column has NO DEFAULT on purpose. A DEFAULT of 'done' would
make brand-new sign-ups insert 'done' and skip onboarding entirely. New rows
must insert NULL (= needs onboarding); only rows that predate this migration
are backfilled to 'done'. Metadata-only ADD COLUMN + one small UPDATE — no
lock hazard at this table's scale.
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers
revision: str = "016_golfer_profile_onboarding"
down_revision: Union[str, Sequence[str], None] = "015_course_intel"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE public.golfer_profiles "
        "ADD COLUMN IF NOT EXISTS onboarding_step text"
    )
    # One-time backfill: every row existing at migration time is a
    # pre-feature user — mark COMPLETED so they are never onboarded.
    op.execute(
        "UPDATE public.golfer_profiles "
        "SET onboarding_step = 'done' "
        "WHERE onboarding_step IS NULL"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE public.golfer_profiles DROP COLUMN IF EXISTS onboarding_step"
    )
