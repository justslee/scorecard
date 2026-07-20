"""Revocation store — multi-user P0 authz flip (write-through cache).

specs/multi-user-epic-plan.md §3.4 "Session revocation & bans": Clerk calls
``POST /api/webhooks/clerk`` (see ``app/routes/webhooks.py``) on
``user.deleted`` / ``user.banned`` / ``session.revoked``; the verified
handler write-throughs that Clerk ``user_id`` into the durable
``revoked_users`` Postgres table (migration 017) via ``revoke_durable()``,
which unconditionally also updates the in-process cache below.
``require_member`` (``clerk_auth.py``) consults ``is_revoked()`` — the fast,
cache-only read — in **open mode ONLY**; owner mode short-circuits before
ever calling this module (see ``require_member``'s docstring), so this store
is completely inert in today's dark/owner-mode deployment.

The in-process ``dict`` below is cleared on every restart/deploy, so it is
warmed from ``revoked_users`` at boot (``warm_revocation_cache()``, called
from ``app/main.py``'s startup handler, open mode only, fail-closed) before
the app starts serving traffic. With a single writer process and
write-through persistence, the cache is always a superset of the DB during
a process's life — no TTL re-poll is needed yet. ``_TTL_SECONDS`` remains
the documented freshness window for a future multi-instance/Redis follow-up
(still unused today).

``revoke()``/``is_revoked()`` keep their exact original sync signatures and
semantics — existing callers (incl. ``tests/test_clerk_auth.py``) are
untouched. ``revoke_durable()`` is the new write-through entry point the
webhook handler calls.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Optional

log = logging.getLogger("looper.revocation")

# The freshness window for a future multi-instance/Redis follow-up (see
# module docstring). No effect today — single-writer, write-through cache.
_TTL_SECONDS = 60

# Defense against unbounded memory growth in a long-lived single-process
# deployment — user ids are real Clerk subs, so growth is bounded by actual
# bans/deletions in practice; this is a belt-and-suspenders cap only
# (mirrors rate_limit.py's MAX_TRACKED_USERS pattern).
_MAX_TRACKED = 100_000

_lock = threading.Lock()
_revoked: dict[str, dict[str, object]] = {}  # user_id -> {reason, source, revoked_at}


def revoke(user_id: str, reason: str = "unknown", source: str = "clerk_webhook") -> None:
    """Mark a Clerk user_id revoked. Idempotent — re-revoking refreshes the
    record. Called only from the Svix-signature-verified webhook handler."""
    if not user_id:
        return
    with _lock:
        if len(_revoked) >= _MAX_TRACKED and user_id not in _revoked:
            # Extremely unlikely in practice; refuse to grow further rather
            # than silently evict an existing revocation.
            return
        _revoked[user_id] = {"reason": reason, "source": source, "revoked_at": time.time()}


def is_revoked(user_id: str) -> bool:
    """True if this Clerk user_id has been revoked.

    Called from ``require_member`` in OPEN mode only — see module docstring.
    Owner mode never reaches this function.
    """
    with _lock:
        return user_id in _revoked


async def _persist_revocation(user_id: str, reason: str, source: str) -> None:
    """Write-through the revocation to the durable ``revoked_users`` table.

    Lazy-imports ``app.db.engine`` INSIDE this function — not at module
    scope — so importing ``app.services.revocation`` (and therefore
    ``app.routes.webhooks``) never requires ``DATABASE_URL`` to be set.
    ``tests/test_webhooks_clerk.py`` deliberately runs with no DB configured;
    that import property must survive this change.

    Idempotent — ``ON CONFLICT (user_id) DO UPDATE`` refreshes
    ``revoked_at``/``reason``/``source`` on re-revocation, mirroring
    ``revoke()``'s in-process refresh semantics.
    """
    from sqlalchemy import text

    from app.db.engine import async_session

    async with async_session() as db:
        await db.execute(
            text(
                """
                INSERT INTO public.revoked_users (user_id, reason, source, revoked_at)
                VALUES (:user_id, :reason, :source, now())
                ON CONFLICT (user_id) DO UPDATE SET
                    revoked_at = now(),
                    reason = excluded.reason,
                    source = excluded.source
                """
            ),
            {"user_id": user_id, "reason": reason, "source": source},
        )
        await db.commit()


async def revoke_durable(
    user_id: str, reason: str = "unknown", source: str = "clerk_webhook"
) -> None:
    """Write-through entry point for the Clerk webhook handler.

    Persists to ``revoked_users`` FIRST, then unconditionally updates the
    in-process cache (``finally``) — the ban is enforced for this process's
    lifetime even if the DB write fails.

    DB-write failure policy: log loudly at ERROR and do NOT re-raise. The
    webhook handler still acks 200 to Clerk/Svix. Residual risk: if the
    process restarts before a successful persist ever lands, that
    revocation is silently lost (Clerk will not redeliver an acked event) —
    accepted for this slice given single-instance deployment and that Clerk
    bans are re-issuable from the dashboard. Returning 5xx to force a Svix
    retry would conflict with the webhook's own replay guard (which records
    the delivery's ``svix-id`` before this call), so is deliberately NOT
    done here; see specs/multiuser-p0-authz-flip-plan.md §2 for the full
    trade-off discussion.
    """
    try:
        await _persist_revocation(user_id, reason, source)
    except Exception:
        log.error(
            "revocation DB write FAILED for %s — enforced in-process only "
            "until the next successful boot warm or persist",
            user_id[:12] if user_id else user_id,
            exc_info=True,
        )
    finally:
        revoke(user_id, reason=reason, source=source)


async def warm_revocation_cache() -> int:
    """Populate the in-process cache from ``revoked_users`` at boot.

    Called ONLY in open mode (``app/main.py`` startup) — owner mode never
    consults this store, so warming it would be pure wasted boot work.
    Merges into the existing dict rather than clearing it first: the cache
    may already hold webhook-delivered entries from before this call.
    Raises on a DB failure — deliberately fail-closed (a DB that can't serve
    one SELECT at boot can't serve the app anyway), consistent with
    ``_assert_boot_config``'s philosophy: booting open-mode without the ban
    list would silently un-revoke banned members.

    Returns the number of rows read (for the boot log / test assertions).
    """
    from sqlalchemy import text

    from app.db.engine import async_session

    async with async_session() as db:
        result = await db.execute(
            text("SELECT user_id, reason, source FROM public.revoked_users")
        )
        rows = result.all()

    with _lock:
        for row in rows:
            if len(_revoked) >= _MAX_TRACKED and row.user_id not in _revoked:
                log.warning(
                    "warm_revocation_cache: _MAX_TRACKED (%d) reached — "
                    "skipping remaining rows",
                    _MAX_TRACKED,
                )
                break
            _revoked[row.user_id] = {
                "reason": row.reason,
                "source": row.source,
                "revoked_at": time.time(),
            }

    return len(rows)


def _debug_snapshot() -> dict[str, dict[str, object]]:
    """Test-only helper — a shallow copy of the current store."""
    with _lock:
        return dict(_revoked)


def _debug_clear() -> None:
    """Test-only helper — reset the store between tests (module-level state
    would otherwise leak across the test session)."""
    with _lock:
        _revoked.clear()


def _debug_entry(user_id: str) -> Optional[dict[str, object]]:
    """Test-only helper — the raw record for one user, or None."""
    with _lock:
        rec = _revoked.get(user_id)
        return dict(rec) if rec is not None else None
