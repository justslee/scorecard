"""Clerk webhook receiver — ``POST /api/webhooks/clerk``.

Multi-user P0 slice 3 (specs/multi-user-epic-plan.md §3.4). Verifies Clerk's
Svix-signed webhook deliveries and marks a user revoked in the durable
revocation store (Postgres ``revoked_users``, write-through to the
in-process cache — ``app/services/revocation.py``) on ``user.deleted`` /
``user.banned`` / ``session.revoked``. Unhandled event types are 200-acked
without action (Clerk retries on anything but 2xx).

NOT member-gated. Clerk calls this server-to-server with no user session —
Svix signature verification IS the authentication. Mounted in ``main.py``
WITHOUT ``Depends(require_member)``, reachable alongside ``/health`` and
``/``.

Fail-closed: if ``CLERK_WEBHOOK_SECRET`` is unset, every request is rejected
(401) — this endpoint NEVER accepts an unsigned event. In today's dark
owner-mode deployment the secret is unset and Clerk never calls this
endpoint, so the whole router is inert.

Svix scheme (https://docs.svix.com/receiving/verifying-payloads/how):
headers ``svix-id`` / ``svix-timestamp`` / ``svix-signature``; secret format
``whsec_<base64>``. Signed content is the exact bytes
``f"{svix_id}.{svix_timestamp}.{body}"``, HMAC-SHA256'd with the
base64-decoded secret (the ``whsec_`` prefix stripped), base64-encoded, and
compared constant-time against each ``v1,<sig>`` entry in the
space-separated ``svix-signature`` header (Clerk may dual-sign during
rotation, so any match is valid).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import time
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Request

from app.services import revocation

log = logging.getLogger("looper.webhooks")

router = APIRouter(prefix="/api/webhooks", tags=["webhooks"])

# ±5 minutes — Svix's own default tolerance; rejects replayed/stale deliveries.
_REPLAY_TOLERANCE_SECONDS = 300

# Bounded in-process replay-id cache (belt-and-suspenders on top of the
# timestamp tolerance above — rejects an EXACT redelivery of a still-fresh
# event, e.g. a captured request replayed within the 5-minute window).
_SEEN_IDS_MAX = 10_000
_seen_ids: dict[str, float] = {}

_USER_EVENTS = {"user.deleted", "user.banned"}


def _webhook_secret() -> Optional[str]:
    """CLERK_WEBHOOK_SECRET, read dynamically (not a module constant) so
    tests can toggle it per-test — mirrors clerk_auth._access_mode's pattern."""
    return os.getenv("CLERK_WEBHOOK_SECRET")


def _verify_signature(secret: str, svix_id: str, svix_timestamp: str, body: bytes, svix_signature: str) -> None:
    """Raise HTTPException(401) unless at least one signature in the header
    verifies. Comparison is constant-time (hmac.compare_digest) per entry."""
    if not secret.startswith("whsec_"):
        raise HTTPException(401, "Malformed webhook secret")
    try:
        key = base64.b64decode(secret[len("whsec_"):])
    except Exception:
        raise HTTPException(401, "Malformed webhook secret")

    signed_content = f"{svix_id}.{svix_timestamp}.".encode() + body
    expected = base64.b64encode(hmac.new(key, signed_content, hashlib.sha256).digest()).decode()

    matched = False
    for candidate in svix_signature.split():
        parts = candidate.split(",", 1)
        if len(parts) != 2:
            continue
        _version, sig = parts
        if hmac.compare_digest(sig, expected):
            matched = True
    if not matched:
        raise HTTPException(401, "Invalid webhook signature")


def _verify_timestamp_and_replay(svix_id: str, svix_timestamp: str) -> None:
    """Raise HTTPException(400) if the delivery is stale (outside the
    tolerance window) or an exact redelivery of an already-seen svix-id."""
    try:
        ts = int(svix_timestamp)
    except ValueError:
        raise HTTPException(400, "Invalid svix-timestamp")

    now = time.time()
    if abs(now - ts) > _REPLAY_TOLERANCE_SECONDS:
        raise HTTPException(400, "Webhook timestamp outside tolerance (possible replay)")

    # Opportunistic cleanup of expired entries, then check-and-record.
    expired = [k for k, seen_at in _seen_ids.items() if now - seen_at > _REPLAY_TOLERANCE_SECONDS]
    for k in expired:
        del _seen_ids[k]

    if svix_id in _seen_ids:
        raise HTTPException(400, "Duplicate webhook delivery (replay)")
    if len(_seen_ids) < _SEEN_IDS_MAX:
        _seen_ids[svix_id] = now


def _extract_revoked_user_id(event_type: str, data: dict) -> Optional[str]:
    """Pull the Clerk user id to revoke out of a verified event payload.

    All payload fields are untrusted DATA (came from the request body) — used
    only as a dict lookup key here, never interpolated into a log-as-code
    string, SQL, or a prompt.
    """
    if event_type in _USER_EVENTS:
        uid = data.get("id")
    elif event_type == "session.revoked":
        uid = data.get("user_id")
    else:
        return None
    return uid if isinstance(uid, str) and uid else None


@router.post("/clerk")
async def clerk_webhook(
    request: Request,
    svix_id: Optional[str] = Header(default=None, alias="svix-id"),
    svix_timestamp: Optional[str] = Header(default=None, alias="svix-timestamp"),
    svix_signature: Optional[str] = Header(default=None, alias="svix-signature"),
) -> dict:
    secret = _webhook_secret()
    if not secret:
        # Fail-closed: never accept an unsigned event, ever.
        raise HTTPException(401, "Webhook receiver not configured")

    if not svix_id or not svix_timestamp or not svix_signature:
        raise HTTPException(400, "Missing svix-id/svix-timestamp/svix-signature headers")

    # Raw bytes, NOT a re-serialized dict — the signature is over the exact
    # wire body.
    body = await request.body()

    # Signature verification is the first real check performed (after the
    # fail-closed unset-secret / missing-header guards above, which cannot
    # be bypassed by anything in the request body).
    _verify_signature(secret, svix_id, svix_timestamp, body, svix_signature)
    _verify_timestamp_and_replay(svix_id, svix_timestamp)

    try:
        event = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(400, "Invalid JSON payload")

    event_type = event.get("type")
    data = event.get("data") or {}
    if not isinstance(event_type, str) or not isinstance(data, dict):
        raise HTTPException(400, "Malformed event payload")

    revoked_user_id = _extract_revoked_user_id(event_type, data)
    if revoked_user_id is not None:
        await revocation.revoke_durable(revoked_user_id, reason=event_type, source="clerk_webhook")
        log.info("clerk_webhook: revoked user (event=%s)", event_type)
    else:
        log.info("clerk_webhook: ignoring unhandled event type=%r", event_type)

    # Clerk expects 2xx or it retries — ack every verified event regardless
    # of whether this handler acted on the type.
    return {"received": True}
