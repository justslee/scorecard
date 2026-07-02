"""012_round_course_anchor: carry the course anchor on rounds.

Adds nullable ``course_lat``/``course_lng`` (geographic centre of the selected
course) and ``mapped_course_id`` (courses.id when the selection is an ingested/
write-through course) to ``rounds``. The round screen uses the anchor to render
the Google satellite map directly — the previous by-NAME lookup against
/api/courses/mapped silently dropped to the paper drawing on any miss.

Additive and nullable: legacy rounds keep working via the name-resolution
fallback; no backfill needed.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers
revision: str = "012_round_course_anchor"
down_revision: Union[str, Sequence[str], None] = "011_courses_trgm_index"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("rounds", sa.Column("course_lat", sa.Float(), nullable=True))
    op.add_column("rounds", sa.Column("course_lng", sa.Float(), nullable=True))
    op.add_column(
        "rounds",
        sa.Column("mapped_course_id", postgresql.UUID(as_uuid=False), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("rounds", "mapped_course_id")
    op.drop_column("rounds", "course_lng")
    op.drop_column("rounds", "course_lat")
