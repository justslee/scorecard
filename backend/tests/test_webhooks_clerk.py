"""Clerk webhook receiver — route tests (no DB, no real Clerk/Svix calls).

specs/multi-user-epic-plan.md §3.4 + backlog `multiuser-p0-migrations-revocation`.
Signs test payloads with a known secret using the EXACT Svix scheme the
handler verifies against (see app/routes/webhooks.py's module docstring), so
these tests exercise the real verification path end-to-end — not a mock.

Mirrors the no-DB TestClient pattern in test_rehearsal_call.py: a minimal
FastAPI app exposing just this router, so importing app.routes.webhooks
(which pulls in only app.services.revocation, no app.db.engine) never
requires DATABASE_URL.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routes import webhooks as route_mod
from app.services import revocation

_TEST_SECRET_RAW = b"test-secret-material-for-hmac-signing-only-32b"
_TEST_SECRET = "whsec_" + base64.b64encode(_TEST_SECRET_RAW).decode()


def _sign(svix_id: str, svix_timestamp: str, body: bytes, secret: str = _TEST_SECRET) -> str:
    key = base64.b64decode(secret[len("whsec_"):])
    signed_content = f"{svix_id}.{svix_timestamp}.".encode() + body
    sig = base64.b64encode(hmac.new(key, signed_content, hashlib.sha256).digest()).decode()
    return f"v1,{sig}"


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(route_mod.router)
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    monkeypatch.delenv("CLERK_WEBHOOK_SECRET", raising=False)
    revocation._debug_clear()
    route_mod._seen_ids.clear()
    yield
    revocation._debug_clear()
    route_mod._seen_ids.clear()


def _post(
    client: TestClient,
    body: dict,
    *,
    svix_id: str = "msg_1",
    ts: str | None = None,
    secret: str = _TEST_SECRET,
):
    ts = ts if ts is not None else str(int(time.time()))
    raw = json.dumps(body).encode()
    sig = _sign(svix_id, ts, raw, secret=secret)
    headers = {"svix-id": svix_id, "svix-timestamp": ts, "svix-signature": sig}
    return client.post("/api/webhooks/clerk", content=raw, headers=headers)


# ─── Valid, signature-verified deliveries ────────────────────────────────────


class TestValidDelivery:
    def test_user_deleted_revokes(self, monkeypatch):
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", _TEST_SECRET)
        res = _post(_client(), {"type": "user.deleted", "data": {"id": "user_abc"}})
        assert res.status_code == 200
        assert revocation.is_revoked("user_abc")

    def test_user_banned_revokes(self, monkeypatch):
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", _TEST_SECRET)
        res = _post(_client(), {"type": "user.banned", "data": {"id": "user_xyz"}})
        assert res.status_code == 200
        assert revocation.is_revoked("user_xyz")

    def test_session_revoked_revokes_by_user_id_field(self, monkeypatch):
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", _TEST_SECRET)
        res = _post(
            _client(),
            {"type": "session.revoked", "data": {"id": "sess_1", "user_id": "user_sess"}},
        )
        assert res.status_code == 200
        assert revocation.is_revoked("user_sess")

    def test_unhandled_event_type_is_acked_but_does_not_revoke(self, monkeypatch):
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", _TEST_SECRET)
        res = _post(_client(), {"type": "user.created", "data": {"id": "user_new"}})
        assert res.status_code == 200
        assert not revocation.is_revoked("user_new")


# ─── Signature verification is mandatory ─────────────────────────────────────


class TestSignatureRejection:
    def test_tampered_body_is_rejected(self, monkeypatch):
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", _TEST_SECRET)
        client = _client()
        ts = str(int(time.time()))
        raw = json.dumps({"type": "user.deleted", "data": {"id": "user_abc"}}).encode()
        sig = _sign("msg_1", ts, raw)
        tampered = raw.replace(b"user_abc", b"user_xyz")  # body changed AFTER signing
        res = client.post(
            "/api/webhooks/clerk",
            content=tampered,
            headers={"svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": sig},
        )
        assert res.status_code == 401
        assert not revocation.is_revoked("user_xyz")

    def test_wrong_secret_is_rejected(self, monkeypatch):
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", _TEST_SECRET)
        other_secret = "whsec_" + base64.b64encode(b"a-completely-different-secret!!").decode()
        res = _post(
            _client(),
            {"type": "user.deleted", "data": {"id": "user_abc"}},
            secret=other_secret,
        )
        assert res.status_code == 401
        assert not revocation.is_revoked("user_abc")

    def test_garbage_signature_is_rejected(self, monkeypatch):
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", _TEST_SECRET)
        client = _client()
        raw = json.dumps({"type": "user.deleted", "data": {"id": "user_abc"}}).encode()
        res = client.post(
            "/api/webhooks/clerk",
            content=raw,
            headers={
                "svix-id": "msg_1",
                "svix-timestamp": str(int(time.time())),
                "svix-signature": "v1,not-a-real-signature",
            },
        )
        assert res.status_code == 401

    def test_missing_headers_rejected(self, monkeypatch):
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", _TEST_SECRET)
        res = _client().post(
            "/api/webhooks/clerk",
            content=b'{"type":"user.deleted","data":{"id":"user_abc"}}',
        )
        assert res.status_code == 400

    def test_unset_secret_fails_closed(self, monkeypatch):
        monkeypatch.delenv("CLERK_WEBHOOK_SECRET", raising=False)
        res = _post(_client(), {"type": "user.deleted", "data": {"id": "user_abc"}})
        assert res.status_code == 401
        assert not revocation.is_revoked("user_abc")


# ─── Replay protection ────────────────────────────────────────────────────────


class TestReplayProtection:
    def test_stale_timestamp_rejected(self, monkeypatch):
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", _TEST_SECRET)
        stale_ts = str(int(time.time()) - 600)  # 10 minutes old, outside +-5min
        res = _post(
            _client(),
            {"type": "user.deleted", "data": {"id": "user_abc"}},
            ts=stale_ts,
        )
        assert res.status_code == 400
        assert not revocation.is_revoked("user_abc")

    def test_future_timestamp_rejected(self, monkeypatch):
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", _TEST_SECRET)
        future_ts = str(int(time.time()) + 600)
        res = _post(
            _client(),
            {"type": "user.deleted", "data": {"id": "user_abc"}},
            ts=future_ts,
        )
        assert res.status_code == 400

    def test_exact_redelivery_within_window_rejected(self, monkeypatch):
        monkeypatch.setenv("CLERK_WEBHOOK_SECRET", _TEST_SECRET)
        client = _client()
        ts = str(int(time.time()))
        body = {"type": "user.deleted", "data": {"id": "user_abc"}}
        first = _post(client, body, svix_id="msg_replay", ts=ts)
        assert first.status_code == 200
        second = _post(client, body, svix_id="msg_replay", ts=ts)
        assert second.status_code == 400
