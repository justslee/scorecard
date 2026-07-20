"""Clerk JWT verification as a FastAPI dependency.

When CLERK_JWKS_URL is set, the Authorization: Bearer <token> header is verified
against Clerk's public JWKS and the request is bound to the Clerk user_id (the
JWT's `sub` claim).

When CLERK_JWKS_URL is not set (dev), we still extract `sub` from an unverified
token if one is present, otherwise return "anonymous". Production deployments
MUST set CLERK_JWKS_URL.
"""

import logging
import os
from typing import Optional
import jwt
from jwt import PyJWKClient
from fastapi import Depends, Header, HTTPException

from app.services import revocation

log = logging.getLogger("looper.clerk_auth")

CLERK_JWKS_URL = os.getenv("CLERK_JWKS_URL")
CLERK_ISSUER = os.getenv("CLERK_ISSUER")
OWNER_CLERK_USER_ID = os.getenv("OWNER_CLERK_USER_ID")
# Fail closed by default: only serve anonymous/unverified requests when this is
# explicitly set for local development.
ALLOW_ANONYMOUS = os.getenv("ALLOW_ANONYMOUS") == "1"

_jwks_client: Optional[PyJWKClient] = PyJWKClient(CLERK_JWKS_URL) if CLERK_JWKS_URL else None
_anonymous_user_id = "anonymous"


def _extract_bearer(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    parts = authorization.split()
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1]
    return None


def _authorized_parties() -> Optional[list[str]]:
    """CLERK_AUTHORIZED_PARTIES, comma-separated, read dynamically (not a module
    constant) so tests can toggle it per-test. None when unset — the azp check
    is backward-compatible opt-in (§3.8 SHOULD-FIX #2)."""
    raw = os.getenv("CLERK_AUTHORIZED_PARTIES")
    if not raw:
        return None
    parties = [p.strip() for p in raw.split(",") if p.strip()]
    return parties or None


def _verified_user_id(token: str) -> str:
    signing_key = _jwks_client.get_signing_key_from_jwt(token).key
    options = {"verify_aud": False}
    payload = jwt.decode(
        token,
        signing_key,
        algorithms=["RS256"],
        issuer=CLERK_ISSUER if CLERK_ISSUER else None,
        options=options,
    )

    # azp fail-closed hardening: when CLERK_AUTHORIZED_PARTIES is configured,
    # reject a token whose azp claim is absent or not on the allowlist. When
    # unset (today's owner-mode prod), behavior is unchanged.
    authorized_parties = _authorized_parties()
    if authorized_parties is not None:
        azp = payload.get("azp")
        if not azp or azp not in authorized_parties:
            raise HTTPException(401, "Token azp not authorized for this deployment")

    sub = payload.get("sub")
    if not sub:
        raise HTTPException(401, "JWT missing sub claim")
    return sub


def _unverified_user_id(token: str) -> str:
    try:
        payload = jwt.decode(token, options={"verify_signature": False})
        return payload.get("sub") or _anonymous_user_id
    except jwt.PyJWTError:
        return _anonymous_user_id


async def current_user_id(authorization: Optional[str] = Header(default=None)) -> str:
    """FastAPI dependency: returns the Clerk user_id, or 'anonymous' in dev.

    Raises 401 only when JWKS is configured and a token fails verification.
    """
    token = _extract_bearer(authorization)

    if _jwks_client is None:
        # No JWKS configured. Permit anonymous access only when explicitly enabled
        # for local dev; otherwise fail closed so a misconfigured production box can
        # never silently serve unauthenticated requests.
        if not ALLOW_ANONYMOUS:
            raise HTTPException(
                503,
                "Auth not configured: set CLERK_JWKS_URL (or ALLOW_ANONYMOUS=1 for local dev).",
            )
        return _unverified_user_id(token) if token else _anonymous_user_id

    if not token:
        raise HTTPException(401, "Missing Authorization: Bearer <token>")

    try:
        return _verified_user_id(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.PyJWTError as e:
        raise HTTPException(401, f"Token verification failed: {e}")


async def require_owner(user_id: str = Depends(current_user_id)) -> str:
    """FastAPI dependency: allow only the configured owner through.

    Layered on top of ``current_user_id`` (which verifies the Clerk JWT). When
    OWNER_CLERK_USER_ID is set, any other identity is rejected with 403 — the
    owner-only gate for the private beta. When it is unset (local dev), the
    underlying ``current_user_id`` behavior applies unchanged.
    """
    if OWNER_CLERK_USER_ID and user_id != OWNER_CLERK_USER_ID:
        raise HTTPException(403, "Forbidden: this deployment is owner-only.")
    return user_id


def _access_mode() -> str:
    """APP_ACCESS_MODE, read dynamically (not a module constant) so tests can
    toggle it per-test without reimporting this module. "owner" (default) is
    byte-identical to today's require_owner gate; "open" admits any verified
    Clerk identity, relying on per-row scoping to isolate tenants."""
    return (os.getenv("APP_ACCESS_MODE") or "owner").strip().lower()


def _owner_id() -> Optional[str]:
    """OWNER_CLERK_USER_ID, read dynamically (see _access_mode)."""
    return os.getenv("OWNER_CLERK_USER_ID")


# ─────────────────────────────────────────────────────────────────────────────
# DEFERRED — must close before APP_ACCESS_MODE=open ships to prod (P0 multi-user
# epic, specs/multi-user-epic-plan.md). require_member's own gate is complete
# in this slice; these are separate, already-known gaps in OTHER code that stay
# safe only because the flag defaults OFF.
#
# CLOSED by specs/multiuser-p0-authz-flip-plan.md (the FLIP-PREP slice):
#   - revocation durability — now a durable Postgres table (`revoked_users`,
#     migration 017), write-through from the Svix-verified webhook
#     (`revocation.revoke_durable`) and warmed into the in-process cache at
#     boot (`revocation.warm_revocation_cache`, open mode only, main.py). A
#     restart can no longer silently un-revoke a banned member.
#   - hole_pins → per-user (§3.3.1) — migration 018 adds `user_id` +
#     a (course_id, hole_number, pin_date, user_id) unique key; pins.py is
#     scoped end to end (list/upsert/read-back).
#   - caddie_personas author-scoping (§3.3.4) — `load_personality` itself now
#     enforces visibility (built-in/public/author-match else silent fallback
#     to default), closing the two call sites (voice.py /speak,
#     realtime.py /setup-session) that previously passed a client-supplied
#     persona id straight through with no gate.
#
# Still deferred — do not consider these closed by this slice:
#   - availability/OCR async job stamp-and-match (§3.3.2) — request_availability_
#     call is owner-only in this slice (see the carve-out below), so no
#     non-owner jobs exist yet; must close before genericizing past the owner.
#   - user_session(user_id) centralization — the RLS seam; a large mechanical
#     refactor, its own future slice. ci_scripts/scoping_lint.py is the interim
#     structural guard against new unscoped tenant queries.
# ─────────────────────────────────────────────────────────────────────────────
async def require_member(user_id: str = Depends(current_user_id)) -> str:
    """FastAPI dependency: the multi-user authz gate (P0 slices 1 + 3).

    mode="owner" (default, unset APP_ACCESS_MODE): BYTE-IDENTICAL to
    require_owner today — owner passes, everyone else 403s, and an unset
    OWNER_CLERK_USER_ID passes everyone through unchanged. Prod ships with
    the flag unset, so this slice changes NOTHING in production. This branch
    returns BEFORE the revocation check below runs — owner mode never
    consults the revocation store, by design (see
    app/services/revocation.py's module docstring; proven by
    TestByteIdenticalOwnerMode in test_clerk_auth.py).

    mode="open": any verified Clerk `sub` passes UNLESS it has been revoked
    (banned/deleted via the Clerk webhook — app/routes/webhooks.py, checked
    against app/services/revocation.py). Per-row scoping (owner_id/user_id
    columns, already in place for the resources the isolation suite covers)
    is what isolates one member's data from another.
    """
    mode = _access_mode()
    if mode != "open":
        # owner mode (default): BYTE-IDENTICAL to require_owner today. MUST
        # short-circuit here, before any revocation lookup.
        owner = _owner_id()
        if owner and user_id != owner:
            raise HTTPException(403, "Forbidden: this deployment is owner-only.")
        return user_id

    # open mode only.
    if revocation.is_revoked(user_id):
        raise HTTPException(403, "Forbidden: this account has been revoked.")
    return user_id


def _assert_boot_config() -> None:
    """Refuse to boot in an unsafe auth configuration.

    Called from the FastAPI startup event — deliberately NOT at import time.
    An import-time raise would break the ASGITransport test-app fixture (it
    imports app.main without ever triggering FastAPI's startup event), so the
    guard would fire in the test process and break every test collection.

    open mode requires:
      - CLERK_JWKS_URL set (§3.1's existing open-mode guard) and
        ALLOW_ANONYMOUS unset — an anonymous/unverified caller must never be
        treated as a distinct member identity.
      - CLERK_ISSUER and CLERK_AUTHORIZED_PARTIES both set (§3.8 SHOULD-FIX
        #2) — open mode is multi-party by definition, so token provenance
        must be pinned to this deployment's own Clerk instance + client(s).

    owner mode (default): no boot guard fires — but if CLERK_JWKS_URL is
    configured (a real deployment) and OWNER_CLERK_USER_ID is unset, that is
    today's silent fail-open (every verified Clerk user passes require_owner/
    require_member) — log it loudly rather than leave it silent.
    """
    mode = _access_mode()
    jwks_url = os.getenv("CLERK_JWKS_URL")
    allow_anonymous = os.getenv("ALLOW_ANONYMOUS") == "1"

    if mode == "open":
        if not jwks_url or allow_anonymous:
            raise RuntimeError(
                "APP_ACCESS_MODE=open requires CLERK_JWKS_URL set and "
                "ALLOW_ANONYMOUS unset — refusing to boot with anonymous "
                "callers able to pass as distinct members."
            )
        if not os.getenv("CLERK_ISSUER") or not os.getenv("CLERK_AUTHORIZED_PARTIES"):
            raise RuntimeError(
                "APP_ACCESS_MODE=open requires CLERK_ISSUER and "
                "CLERK_AUTHORIZED_PARTIES set — refusing to boot without "
                "pinned token provenance for a multi-party deployment."
            )
    elif jwks_url and not os.getenv("OWNER_CLERK_USER_ID"):
        log.warning(
            "APP_ACCESS_MODE=owner (default) with CLERK_JWKS_URL configured but "
            "OWNER_CLERK_USER_ID unset: require_owner/require_member fail OPEN — "
            "every verified Clerk user passes. Set OWNER_CLERK_USER_ID to lock "
            "this deployment to one user."
        )


async def optional_user_id(authorization: Optional[str] = Header(default=None)) -> Optional[str]:
    """Like current_user_id, but returns None if no token is present (does not raise)."""
    token = _extract_bearer(authorization)
    if not token:
        return None
    if _jwks_client is None:
        return _unverified_user_id(token)
    try:
        return _verified_user_id(token)
    except jwt.PyJWTError:
        return None
