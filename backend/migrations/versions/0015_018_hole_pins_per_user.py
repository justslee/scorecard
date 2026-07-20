"""018_hole_pins_per_user: scope hole_pins to the marking user.

Closes DEFERRED gap 2/4 in backend/app/services/clerk_auth.py:143-163
(multiuser-p0-authz-flip §3.3.1). Today ``hole_pins`` is keyed
(course_id, hole_number, pin_date) — effectively a single shared pin per
course/hole/day. Before APP_ACCESS_MODE=open ships, one member's pin must
not clobber or leak to another's, so this migration adds ``user_id`` to the
key.

Steps:
  1. Add nullable ``user_id text``.
  2. Backfill: prefer the existing ``marked_by_user_id`` (already the real
     author of manual pins); rows with no usable author (NULL or the
     'anonymous' sentinel) fall back to ``OWNER_CLERK_USER_ID`` — every real
     row predating this migration was marked by the owner in the
     single-user deployment, so this is the honest owner-mode-continuity
     backfill, not an invented identity. If any such row exists AND
     OWNER_CLERK_USER_ID is unset, the migration ABORTS rather than invent
     an owner — prod has the var set today, so this never fires there; a
     dev DB with orphan pins and no owner configured fails loudly instead
     of silently mis-owning data. Empty/clean DBs migrate fine either way.
  3. NOT NULL (required — NULLs never conflict under a unique constraint,
     which would break upsert semantics).
  4. Drop the old 3-column unique constraint (course_id, hole_number,
     pin_date) — auto-generated name from supabase migration 004's inline
     ``unique(...)``.
  5. Add the new 4-column unique (course_id, hole_number, pin_date,
     user_id), guarded for idempotency. Safe from a duplicate-key failure:
     the old 3-column unique guaranteed at most one row per triple, so the
     4-column key cannot collide.
  6. Index (user_id, course_id, pin_date) to serve the new per-user
     list_pins predicate; keep 004's (course_id, pin_date) index (future
     community-pin reads).

downgrade() dedupes (keeping the max-updated_at row per
(course_id, hole_number, pin_date)) before restoring the 3-column unique —
a deliberate last-writer data collapse, documented here since downgrade is
never auto-run.
"""

import os
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers
revision: str = "018_hole_pins_per_user"
down_revision: Union[str, Sequence[str], None] = "017_revoked_users"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE public.hole_pins ADD COLUMN IF NOT EXISTS user_id text")

    bind = op.get_bind()
    owner = os.getenv("OWNER_CLERK_USER_ID")

    orphan_count = bind.execute(
        sa.text(
            "SELECT count(*) FROM public.hole_pins "
            "WHERE user_id IS NULL AND (marked_by_user_id IS NULL OR marked_by_user_id = 'anonymous')"
        )
    ).scalar()
    if orphan_count and orphan_count > 0 and not owner:
        raise RuntimeError(
            f"migration 018: {orphan_count} hole_pins row(s) have no usable "
            "author (marked_by_user_id NULL/'anonymous') and OWNER_CLERK_USER_ID "
            "is unset — refusing to invent an owner identity. Set "
            "OWNER_CLERK_USER_ID before running this migration, or leave "
            "those rows to be handled manually."
        )

    bind.execute(
        sa.text(
            "UPDATE public.hole_pins "
            "SET user_id = coalesce(nullif(marked_by_user_id, 'anonymous'), :owner) "
            "WHERE user_id IS NULL"
        ),
        {"owner": owner},
    )

    op.execute("ALTER TABLE public.hole_pins ALTER COLUMN user_id SET NOT NULL")

    op.execute(
        "ALTER TABLE public.hole_pins "
        "DROP CONSTRAINT IF EXISTS hole_pins_course_id_hole_number_pin_date_key"
    )

    op.execute(
        """
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'hole_pins_course_hole_date_user_key'
          ) THEN
            ALTER TABLE public.hole_pins ADD CONSTRAINT hole_pins_course_hole_date_user_key
              UNIQUE (course_id, hole_number, pin_date, user_id);
          END IF;
        END $$
        """
    )

    op.execute(
        "CREATE INDEX IF NOT EXISTS hole_pins_user_course_date_idx "
        "ON public.hole_pins (user_id, course_id, pin_date)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS hole_pins_user_course_date_idx")
    op.execute(
        "ALTER TABLE public.hole_pins "
        "DROP CONSTRAINT IF EXISTS hole_pins_course_hole_date_user_key"
    )
    # Dedupe before restoring the 3-column unique — deliberate last-writer
    # data collapse (multiple per-user rows per triple would otherwise
    # violate the restored constraint). downgrade() is never auto-run.
    op.execute(
        """
        DELETE FROM public.hole_pins a USING public.hole_pins b
        WHERE a.course_id = b.course_id
          AND a.hole_number = b.hole_number
          AND a.pin_date = b.pin_date
          AND a.updated_at < b.updated_at
        """
    )
    op.execute(
        """
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'hole_pins_course_id_hole_number_pin_date_key'
          ) THEN
            ALTER TABLE public.hole_pins ADD CONSTRAINT hole_pins_course_id_hole_number_pin_date_key
              UNIQUE (course_id, hole_number, pin_date);
          END IF;
        END $$
        """
    )
    op.execute("ALTER TABLE public.hole_pins DROP COLUMN IF EXISTS user_id")
