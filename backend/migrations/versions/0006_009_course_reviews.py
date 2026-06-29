"""009_course_reviews: add course_reviews table for owner-scoped course ratings (B2).

Schema decisions:
  * course_key is a plain Text (not FK) keyed on a GolfAPI id string when known,
    else a name:<slug> fallback — sidesteps course-identity unification (B5).
  * round_id is plain Text with no DB FK, matching round_players.player_id precedent.
  * rating is Integer with NO DB CHECK CONSTRAINT; enforcement lives in Pydantic (ge=1, le=5).
  * owner_id is NOT NULL (a review always has an author, unlike the nullable Player.owner_id).
  * Indexes on owner_id and course_key for B3 list-by-course queries.
  * gen_random_uuid() is built-in in Postgres 13+ (PG16 in prod) — no pgcrypto needed.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers
revision: str = "009_course_reviews"
down_revision: Union[str, Sequence[str], None] = "008_round_owner_player"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "course_reviews",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=False),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("owner_id", sa.Text, nullable=False),
        sa.Column("course_key", sa.Text, nullable=False),
        sa.Column("course_name", sa.Text, nullable=True),
        sa.Column("round_id", sa.Text, nullable=True),
        sa.Column("rating", sa.Integer, nullable=False),
        sa.Column("body", sa.Text, nullable=True),
        sa.Column("played_at", sa.Date, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_course_reviews_owner_id", "course_reviews", ["owner_id"])
    op.create_index("ix_course_reviews_course_key", "course_reviews", ["course_key"])


def downgrade() -> None:
    op.drop_index("ix_course_reviews_course_key", table_name="course_reviews")
    op.drop_index("ix_course_reviews_owner_id", table_name="course_reviews")
    op.drop_table("course_reviews")
