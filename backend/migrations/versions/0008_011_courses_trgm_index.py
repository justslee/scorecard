"""011_courses_trgm_index: pg_trgm extension + GIN trigram index on courses.name.

Backs the local-first course-search ranking (services/courses_mapped.py
list_courses): prefix-match boost + ``similarity()`` fuzzy scoring need a
trigram index to stay fast as the write-through course index grows (every
external search hit that gets written through /api/courses/search adds a row).

``CREATE EXTENSION IF NOT EXISTS pg_trgm`` requires no special privilege on
RDS Postgres (it's on the default allow-list); ``CONCURRENTLY`` is skipped
because Alembic runs migrations inside a transaction and CONCURRENTLY cannot
run in one — an acceptable brief lock for a table of this size.
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers
revision: str = "011_courses_trgm_index"
down_revision: Union[str, Sequence[str], None] = "010_tee_time_bookings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_courses_name_trgm "
        "ON public.courses USING gin (name gin_trgm_ops)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_courses_name_trgm")
    # Extension is left in place on downgrade — other tables/migrations may
    # depend on it and DROP EXTENSION would fail if anything else uses it.
