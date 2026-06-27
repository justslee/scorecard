"""007_golfer_profile_fields: add name and home_course columns to golfer_profiles.

Revision ID: 007_golfer_profile_fields
Revises: 006_scoring_courses
Create Date: 2026-06-26

The original ``golfer_profiles`` table (migration 002_core_scoring) stores
``home_course_id`` (a cross-reference course ID) and has no ``name`` column.
The frontend ``GolferProfile`` type expects:

  - ``name``       — display name for the golfer (free text)
  - ``homeCourse`` — free-text home course name (not an ID)

This migration adds both as nullable Text columns so the backend can serve the
exact camelCase shape the frontend contract requires.  ``home_course_id`` is
intentionally kept for potential future FK/caddie cross-reference.

Schema decisions:
  * Both columns are nullable so existing rows (none in beta) are unaffected.
  * ``home_course`` is a free-text name, not an ID — matches the TS type.
  * ``name`` defaults to NULL; callers pass it on create/update.
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

# revision identifiers
revision: str = "007_golfer_profile_fields"
down_revision: Union[str, Sequence[str], None] = "006_scoring_courses"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add display name to golfer_profiles (matches GolferProfile.name in types.ts)
    op.add_column(
        "golfer_profiles",
        sa.Column("name", sa.Text, nullable=True),
    )
    # Add free-text home course (matches GolferProfile.homeCourse in types.ts)
    # home_course_id is kept for future course-table cross-reference.
    op.add_column(
        "golfer_profiles",
        sa.Column("home_course", sa.Text, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("golfer_profiles", "home_course")
    op.drop_column("golfer_profiles", "name")
