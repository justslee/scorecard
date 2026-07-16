"""In-process revocation store — multi-user P0 slice 3 (interim, dark).

specs/multi-user-epic-plan.md §3.4 "Session revocation & bans": Clerk calls
``POST /api/webhooks/clerk`` (see ``app/routes/webhooks.py``) on
``user.deleted`` / ``user.banned`` / ``session.revoked``; the verified
handler marks that Clerk ``user_id`` revoked here. ``require_member``
(``clerk_auth.py``) consults ``is_revoked()`` in **open mode ONLY** — owner
mode short-circuits before ever calling this module (see
``require_member``'s docstring), so this store is completely inert in
today's dark/owner-mode deployment.

INTERIM, NOT DURABLE — this is a plain in-process dict. It is cleared on
every restart/deploy. That is acceptable ONLY because:
  (a) owner mode (today's only deployed mode) never consults it, and
  (b) **the durable ``revoked_users`` Postgres table is REQUIRED before
      ``APP_ACCESS_MODE=open`` ships to prod.** The table design (columns:
      ``user_id`` PK/unique, ``reason``, ``revoked_at``, ``source``) is
      specced in specs/multi-user-epic-plan.md §3.4 and goes through the
      guarded-migrations process as its own reviewed PR — a restart must
      never silently un-revoke a banned member once real strangers exist.

Swap plan (keeps this a localized change): once the durable table lands,
``is_revoked``/``revoke`` become a DB-backed cache with a ``_TTL_SECONDS``
freshness window (re-check Postgres at most once per TTL per user, per the
plan's "cached in-process, 60s TTL") instead of the sole source of truth.
Today there is no external source of truth to go stale against, so this
store is simply authoritative for the life of the process — no TTL
eviction happens here yet.
"""

from __future__ import annotations

import threading
import time
from typing import Optional

# Once the durable revoked_users table lands, this becomes the cache
# freshness window described in the module docstring. No effect today.
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
