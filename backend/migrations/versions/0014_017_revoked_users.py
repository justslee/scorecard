"""017_revoked_users: durable revocation store (multi-user P0 authz flip).

Closes the first of the four DEFERRED gaps in
``backend/app/services/clerk_auth.py:143-163`` — the in-process revocation
dict (``app/services/revocation.py``) is cleared on every restart/deploy,
which is only safe because owner mode never consults it. Before
``APP_ACCESS_MODE=open`` ships, a restart must never silently un-revoke a
banned member once real strangers exist, so revocations need a durable
backing store.

New table ``public.revoked_users`` — write-through target for
``revocation.revoke_durable()`` (Svix-verified Clerk webhook handler,
``app/routes/webhooks.py``), read back into the in-process cache at boot via
``revocation.warm_revocation_cache()`` (open mode only, ``app/main.py``
startup). Empty, additive table — no data, no lock hazard, no backfill.

Deliberately NOT a per-user/per-owner "tenant" table for
``ci_scripts/scoping_lint.py`` purposes — it is the global ban list, queried
without caller scoping by design (see that script's TENANT_MODELS comment).
"""

from typing import Sequence, Union

from alembic import op

# revision identifiers
revision: str = "017_revoked_users"
down_revision: Union[str, Sequence[str], None] = "016_golfer_profile_onboarding"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS public.revoked_users (
            user_id     text PRIMARY KEY,
            revoked_at  timestamptz NOT NULL DEFAULT now(),
            reason      text,
            source      text
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS public.revoked_users")
