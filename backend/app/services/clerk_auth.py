"""Clerk JWT verification as a FastAPI dependency.

When CLERK_JWKS_URL is set, the Authorization: Bearer <token> header is verified
against Clerk's public JWKS and the request is bound to the Clerk user_id (the
JWT's `sub` claim).

When CLERK_JWKS_URL is not set (dev), we still extract `sub` from an unverified
token if one is present, otherwise return "anonymous". Production deployments
MUST set CLERK_JWKS_URL.
"""

import os
from typing import Optional
import jwt
from jwt import PyJWKClient
from fastapi import Header, HTTPException


CLERK_JWKS_URL = os.getenv("CLERK_JWKS_URL")
CLERK_ISSUER = os.getenv("CLERK_ISSUER")

_jwks_client: Optional[PyJWKClient] = PyJWKClient(CLERK_JWKS_URL) if CLERK_JWKS_URL else None
_anonymous_user_id = "anonymous"


def _extract_bearer(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    parts = authorization.split()
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1]
    return None


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
        return _unverified_user_id(token) if token else _anonymous_user_id

    if not token:
        raise HTTPException(401, "Missing Authorization: Bearer <token>")

    try:
        return _verified_user_id(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.PyJWTError as e:
        raise HTTPException(401, f"Token verification failed: {e}")


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
