"""
Owner rehearsal-call harness — route tests (no telephony, no DB, no Postgres).

specs/teetime-rehearsal-call-harness.md + specs/teetime-s3-caller-plan.md §6.

The endpoint places a LIVE outbound call to the owner's OWN verified number and
bridges it to the real booking agent. These tests prove the safety envelope
WITHOUT ever dialing:
  - owner-auth is enforced (403 for a non-owner);
  - the dialed number comes ONLY from server config, never a request value
    (dial-safety invariant) — a hostile request body cannot change the callee;
  - compliance gates + the disabled/unshipped-bridge gates are honored;
  - the full dialog runs against an injected SimulatedCallTransport (CI-safe).

Live telephony is never touched: every path either injects a fake transport via
`_rehearsal_transport_factory` or exercises the real `telephony.get_live_transport`
error paths (which only read env and raise — no network).
"""

from __future__ import annotations

import inspect
from datetime import date

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.routes import tee_times as route_mod
from app.services import clerk_auth
from app.services.clerk_auth import current_user_id
from app.services.voice_booking.compliance import ComplianceCheck
from app.services.voice_booking.simulator import SimulatedCallTransport
from app.services.voice_booking.types import CallOutcome

_OWNER_RAW = "+1 (415) 555-0199"
_OWNER_E164 = "+14155550199"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Start every test from a known-empty voice-booking env + no injected
    transport, so one test's setenv/monkeypatch can't leak into the next."""
    for var in (
        "VOICE_BOOKING_OWNER_NUMBER", "VOICE_BOOKING_OWNER_NAME",
        "VOICE_BOOKING_REHEARSAL_TZ", "VOICE_BOOKING_ENABLED",
        "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER",
        "VOICE_BOOKING_PUBLIC_HOST",
    ):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(route_mod, "_rehearsal_transport_factory", None)
    yield


class _CapturingTransport:
    """Records the ctx it was handed; returns a benign unresolved outcome."""

    def __init__(self):
        self.ctx = None

    async def run_call(self, ctx):
        self.ctx = ctx
        return [], CallOutcome(result="unclear", detail="captured")


def _exploding_factory():  # pragma: no cover - asserts if ever called
    raise AssertionError("transport factory must NOT be called on this path")


# ─── Auth ───────────────────────────────────────────────────────────────────


def _client(user_id: str) -> TestClient:
    """A minimal app exposing the tee-times router with the owner-only gate the
    endpoint itself declares. `current_user_id` is overridden to `user_id`."""
    app = FastAPI()
    app.include_router(route_mod.router)
    app.dependency_overrides[current_user_id] = lambda: user_id
    return TestClient(app)


def test_non_owner_is_forbidden(monkeypatch):
    monkeypatch.setattr(clerk_auth, "OWNER_CLERK_USER_ID", "owner_1")
    monkeypatch.setenv("VOICE_BOOKING_OWNER_NUMBER", _OWNER_RAW)
    # Even if configured, an intruder never reaches the handler body.
    monkeypatch.setattr(route_mod, "_rehearsal_transport_factory", _exploding_factory)
    res = _client("intruder").post("/api/tee-times/rehearsal-call")
    assert res.status_code == 403


# ─── Unconfigured / bad config → 503 ─────────────────────────────────────────


async def test_unconfigured_owner_number_raises_503():
    route_mod._rehearsal_transport_factory = _exploding_factory  # must not be called
    try:
        with pytest.raises(HTTPException) as exc:
            await route_mod.rehearsal_call(owner_id="owner_1")
    finally:
        route_mod._rehearsal_transport_factory = None
    assert exc.value.status_code == 503
    assert "VOICE_BOOKING_OWNER_NUMBER" in exc.value.detail


async def test_unnormalizable_owner_number_raises_503(monkeypatch):
    monkeypatch.setenv("VOICE_BOOKING_OWNER_NUMBER", "123")  # too short → None
    monkeypatch.setattr(route_mod, "_rehearsal_transport_factory", _exploding_factory)
    with pytest.raises(HTTPException) as exc:
        await route_mod.rehearsal_call(owner_id="owner_1")
    assert exc.value.status_code == 503


# ─── Dial-safety invariant ───────────────────────────────────────────────────


async def test_dialed_number_comes_only_from_config(monkeypatch):
    monkeypatch.setenv("VOICE_BOOKING_OWNER_NUMBER", _OWNER_RAW)
    cap = _CapturingTransport()
    monkeypatch.setattr(route_mod, "_rehearsal_transport_factory", lambda: cap)
    resp = await route_mod.rehearsal_call(owner_id="owner_1")
    assert resp.status == "completed"
    assert cap.ctx is not None
    # The callee AND the disclosure callback are the owner's own normalized number.
    assert cap.ctx.phone == _OWNER_E164
    assert cap.ctx.callback_number == _OWNER_E164


def test_endpoint_takes_no_request_body():
    """Static guarantee: there is no request-body parameter to smuggle a number
    through — the handler's only parameter is the auth dependency."""
    params = inspect.signature(route_mod.rehearsal_call).parameters
    assert list(params) == ["owner_id"]


def test_hostile_request_body_cannot_change_the_callee(monkeypatch):
    monkeypatch.setattr(clerk_auth, "OWNER_CLERK_USER_ID", None)  # any user passes
    monkeypatch.setenv("VOICE_BOOKING_OWNER_NUMBER", _OWNER_RAW)
    cap = _CapturingTransport()
    monkeypatch.setattr(route_mod, "_rehearsal_transport_factory", lambda: cap)
    res = _client("owner").post(
        "/api/tee-times/rehearsal-call",
        json={"phone": "+19998887777", "calleeNumber": "+19998887777",
              "number": "+19998887777"},
    )
    assert res.status_code == 200
    # The injected body is entirely ignored; the callee stays the config number.
    assert cap.ctx is not None
    assert cap.ctx.phone == _OWNER_E164


# ─── Compliance gates honored ────────────────────────────────────────────────


async def test_compliance_refusal_short_circuits(monkeypatch):
    monkeypatch.setenv("VOICE_BOOKING_OWNER_NUMBER", _OWNER_RAW)
    monkeypatch.setattr(route_mod, "_rehearsal_transport_factory", _exploding_factory)
    monkeypatch.setattr(
        route_mod, "check_call_allowed",
        lambda *a, **k: ComplianceCheck(False, "test reason"),
    )
    resp = await route_mod.rehearsal_call(owner_id="owner_1")
    assert resp.status == "refused"
    assert resp.reason == "test reason"
    assert resp.transcript == []
    assert resp.disclosure is not None       # still previewed on a refusal
    assert resp.calleeNumber and resp.calleeNumber.endswith("0199")


# ─── Live-calling gate: disabled / unshipped bridge ──────────────────────────


async def test_not_enabled_when_voice_booking_disabled(monkeypatch):
    monkeypatch.setenv("VOICE_BOOKING_OWNER_NUMBER", _OWNER_RAW)
    # _rehearsal_transport_factory left None → real telephony.get_live_transport,
    # which raises RuntimeError("voice booking disabled") with the flag unset.
    resp = await route_mod.rehearsal_call(owner_id="owner_1")
    assert resp.status == "not_enabled"
    assert "voice booking disabled" in (resp.reason or "")
    assert resp.transcript == []


async def test_not_enabled_when_public_host_missing(monkeypatch):
    # The live bridge SHIPPED (specs/teetime-s3b-twilio-bridge-plan.md) — flag +
    # full Twilio creds now construct a real LiveCallTransport UNLESS the public
    # wss host Twilio would connect back to is also configured. Still zero
    # network — get_live_transport only reads env and raises.
    monkeypatch.setenv("VOICE_BOOKING_OWNER_NUMBER", _OWNER_RAW)
    monkeypatch.setenv("VOICE_BOOKING_ENABLED", "1")
    monkeypatch.setenv("TWILIO_ACCOUNT_SID", "AC_test")
    monkeypatch.setenv("TWILIO_AUTH_TOKEN", "tok_test")
    monkeypatch.setenv("TWILIO_FROM_NUMBER", "+15005550006")
    monkeypatch.delenv("VOICE_BOOKING_PUBLIC_HOST", raising=False)
    resp = await route_mod.rehearsal_call(owner_id="owner_1")
    assert resp.status == "not_enabled"
    assert "VOICE_BOOKING_PUBLIC_HOST" in (resp.reason or "")


# ─── Full happy path via the simulator ───────────────────────────────────────


async def test_full_rehearsal_via_simulated_transport(monkeypatch):
    monkeypatch.setenv("VOICE_BOOKING_OWNER_NUMBER", _OWNER_RAW)
    monkeypatch.setenv("VOICE_BOOKING_OWNER_NAME", "Justin")
    monkeypatch.setattr(
        route_mod, "_rehearsal_transport_factory",
        lambda: SimulatedCallTransport("friendly"),
    )
    resp = await route_mod.rehearsal_call(owner_id="owner_1")
    assert resp.status == "completed"
    # Disclosure is ALWAYS the agent's first spoken words.
    agent_turns = [t for t in resp.transcript if t.speaker == "agent"]
    assert agent_turns
    assert "automated AI assistant" in agent_turns[0].text
    assert "Justin" in (resp.disclosure or "")
    assert resp.outcome is not None and resp.outcome.result == "booked"
    assert resp.result is not None and resp.result.status == "confirmed"
    assert resp.calleeNumber and resp.calleeNumber.endswith("0199")
    # Masked — the raw number is never returned.
    assert _OWNER_E164 not in (resp.calleeNumber or "")


# ─── Pure context builder ────────────────────────────────────────────────────


def test_build_rehearsal_context_next_saturday():
    # 2026-07-06 is a Monday → the coming Saturday is 2026-07-11.
    ctx = route_mod._build_rehearsal_context(
        _OWNER_E164, "Justin", "America/New_York", today=date(2026, 7, 6)
    )
    assert ctx.date == "2026-07-11"
    assert ctx.course_name == "Rehearsal Pro Shop"
    assert ctx.phone == ctx.callback_number == _OWNER_E164
    assert ctx.party_size == 1
    assert ctx.course_tz == "America/New_York"


def test_build_rehearsal_context_on_saturday_rolls_to_next_week():
    # 2026-07-11 is itself a Saturday → strictly-after gives the following one.
    ctx = route_mod._build_rehearsal_context(
        _OWNER_E164, "Justin", "America/New_York", today=date(2026, 7, 11)
    )
    assert ctx.date == "2026-07-18"
