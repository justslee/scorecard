"""010_tee_time_bookings: persist every tee-time booking attempt (Phase 1b).

Schema decisions:
  * Every provider.book() call is recorded — including needs_human handoffs —
    so the owner keeps a durable record of what was (or still must be) booked.
  * slot_date/slot_time are Text matching the TeeTimeSlot wire shape
    (YYYY-MM-DD / HH:MM), consistent with rounds.date being Text.
  * price_usd is nullable Numeric: affiliate slots carry no known price and we
    never fabricate one (legal posture, specs/tee-time-booking-phase1b.md).
  * status is plain Text; the BookingResult status vocabulary (confirmed |
    pending | failed | needs_human | not_supported) is a stable app-level
    contract enforced in code, not a DB enum, so it can extend without DDL.
  * course_id/slot_id are Text with no FK — provider-namespace ids (OSM /
    Places / mock), same precedent as course_reviews.course_key.
  * owner_id is NOT NULL + indexed for the owner-scoped bookings list.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers
revision: str = "010_tee_time_bookings"
down_revision: Union[str, Sequence[str], None] = "009_course_reviews"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "tee_time_bookings",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=False),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("owner_id", sa.Text, nullable=False),
        sa.Column("slot_id", sa.Text, nullable=False),
        sa.Column("course_id", sa.Text, nullable=False),
        sa.Column("course_name", sa.Text, nullable=False),
        sa.Column("slot_date", sa.Text, nullable=False),
        sa.Column("slot_time", sa.Text, nullable=False),
        sa.Column("party_size", sa.Integer, nullable=False),
        sa.Column("price_usd", sa.Numeric, nullable=True),
        sa.Column("status", sa.Text, nullable=False),
        sa.Column("booking_url", sa.Text, nullable=True),
        sa.Column("provider", sa.Text, nullable=False),
        sa.Column("confirmation_code", sa.Text, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_tee_time_bookings_owner_id", "tee_time_bookings", ["owner_id"])


def downgrade() -> None:
    op.drop_index("ix_tee_time_bookings_owner_id", table_name="tee_time_bookings")
    op.drop_table("tee_time_bookings")
