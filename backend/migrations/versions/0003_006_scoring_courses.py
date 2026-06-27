"""006_scoring_courses: scoring-course picker table.

Revision ID: 006_scoring_courses
Revises: 002_core_scoring
Create Date: 2026-06-26

Creates the ``scoring_courses`` table which replaces the JSON file
``backend/data/courses.json`` (and ``courses_storage`` in storage.py).

This is intentionally a NEW owner-scoped table and is distinct from the
PostGIS-backed ``courses``/``tee_sets``/``holes`` tables (caddie migration
001–004, baseline revision 001_baseline). Unifying scoring-courses with
mapped-courses is a deliberate FUTURE refactor (touches the working
caddie/import half) — tracked as a follow-up in specs/real-data-wiring-plan.md.

Schema decisions:
  * ``holes`` — JSONB list of {number, par, yards?, handicap?}, matching the
    HoleInfo Pydantic shape.  Mirrors how ``rounds.holes`` is stored.
  * ``tees``  — JSONB list of {id, name, holes[]}, matching TeeOption shape.
  * ``owner_id`` nullable (single-owner beta, multi-user-ready).
"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

from alembic import op

# revision identifiers
revision: str = "006_scoring_courses"
down_revision: Union[str, Sequence[str], None] = "002_core_scoring"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── scoring_courses ──────────────────────────────────────────────────────
    # Stores the user-created/picked scoring courses used by the round-setup
    # picker.  Distinct from the PostGIS mapped-courses tables (migration 001).
    op.create_table(
        "scoring_courses",
        sa.Column(
            "id",
            UUID(as_uuid=False),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("owner_id", sa.Text, nullable=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("location", sa.Text, nullable=True),
        # JSONB list of HoleInfo: [{number, par, yards?, handicap?}]
        sa.Column(
            "holes",
            JSONB,
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        # JSONB list of TeeOption: [{id, name, holes:[HoleInfo]}]
        sa.Column("tees", JSONB, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("scoring_courses_owner_id_idx", "scoring_courses", ["owner_id"])


def downgrade() -> None:
    op.drop_table("scoring_courses")
