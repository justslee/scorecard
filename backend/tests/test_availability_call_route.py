"""Availability-by-call trigger + status endpoints — S4e rung 3
(specs/teetime-availability-everywhere-plan.md §5). Route tests (no telephony,
no DB, no Postgres) — same style as test_rehearsal_call.py.

These prove the safety envelope WITHOUT ever dialing:
  - DARK BY DEFAULT: with no Twilio keys / VOICE_BOOKING_ENABLED (CI/default),
    POST returns status="not_enabled" immediately and enqueues nothing;
  - the owner-verified-lines allowlist gates every number (empty by default
    -> refused, same as VoiceCallProvider);
  - a search never reaches this endpoint (structural: it's a separate route,
    never called from search_tee_times);
  - the full ask-mode flow runs end to end against an injected
    SimulatedCallTransport, writes the availability_by_call cache, and GET
    reflects the resolved status;
  - the window passed to the call context is EXACTLY the request's query
    window — never derived from any TeeTimeSlot.time (the S3 "window bug"
    class of mistake structurally cannot occur here).
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException

from app.routes import tee_times as route_mod
from app.services.tee_times.availability_call_cache import FileAvailabilityCallCacheStore
from app.services.voice_booking.simulator import SimulatedCallTransport
from app.services.voice_booking.types import CallOutcome

LA = ZoneInfo("America/Los_Angeles")
NOON = datetime(2026, 7, 11, 12, 0, tzinfo=LA)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    for var in (
        "VOICE_BOOKING_ENABLED", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN",
        "TWILIO_FROM_NUMBER", "VOICE_BOOKING_PUBLIC_HOST",
        "VOICE_BOOKING_VERIFIED_LINES", "VOICE_BOOKING_OWNER_NAME",
        "VOICE_BOOKING_OWNER_NUMBER",
    ):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(route_mod, "_availability_call_transport_factory", None)
    monkeypatch.setattr(route_mod, "_availability_call_now_override", NOON)
    monkeypatch.setattr(route_mod, "_availability_jobs", {})
    # Isolate the cache to a scratch file so tests never touch backend/data/.
    monkeypatch.setattr(
        route_mod, "_availability_cache_store",
        FileAvailabilityCallCacheStore(path=tmp_path / "availability_by_call_cache.json"),
    )
    yield


def _req(**overrides) -> "route_mod.AvailabilityCallRequest":
    # Window matches the "lists_three_times" persona's spoken times
    # (07:20 / 08:40 / 09:15) so the full-flow tests exercise all three.
    defaults = dict(
        courseId="way/999", courseName="No Website Municipal Course",
        phone="+17165551212", date="2026-07-11",
        timeWindowStart="07:00", timeWindowEnd="10:00", partySize=2,
        golferName="Justin", callbackNumber="+14155550199",
    )
    defaults.update(overrides)
    return route_mod.AvailabilityCallRequest(**defaults)


def _exploding_factory():  # pragma: no cover - asserts if ever called
    raise AssertionError("transport factory must NOT be called on this path")


# ─── Dark by default — the core invariant ──────────────────────────────────────


class TestShipsDark:
    async def test_no_keys_returns_not_enabled_and_enqueues_nothing(self):
        resp = await route_mod.request_availability_call(_req(), _owner_id="u1")
        assert resp.status == "not_enabled"
        assert resp.id == ""
        assert "voice booking disabled" in (resp.reason or "")
        assert route_mod._availability_jobs == {}   # nothing was enqueued

    async def test_transport_factory_never_called_when_dark(self, monkeypatch):
        # Real telephony.get_live_transport() path (factory left None) —
        # proves the DEFAULT production path is inert, not just an injected one.
        resp = await route_mod.request_availability_call(_req(), _owner_id="u1")
        assert resp.status == "not_enabled"

    async def test_enabled_but_missing_creds_still_not_enabled(self, monkeypatch):
        monkeypatch.setenv("VOICE_BOOKING_ENABLED", "1")
        resp = await route_mod.request_availability_call(_req(), _owner_id="u1")
        assert resp.status == "not_enabled"
        assert "credentials" in (resp.reason or "")
        assert route_mod._availability_jobs == {}

    async def test_configured_transport_but_empty_allowlist_still_not_enabled(self, monkeypatch):
        """Even with a transport available (injected for the test), the
        owner-verified-lines allowlist is EMPTY by default — the compliance
        gate refuses before any dial, exactly like VoiceCallProvider.book()."""
        monkeypatch.setattr(
            route_mod, "_availability_call_transport_factory",
            lambda: SimulatedCallTransport("lists_three_times"),
        )
        resp = await route_mod.request_availability_call(_req(), _owner_id="u1")
        assert resp.status == "not_enabled"
        assert "landline" in (resp.reason or "")
        assert route_mod._availability_jobs == {}

    async def test_a_request_value_cannot_smuggle_a_dial_around_the_allowlist(self, monkeypatch):
        """Dial-safety invariant: the phone comes from the request (the
        golfer picked a course) but STILL must clear the allowlist — an
        attacker-controlled phone field can never bypass it."""
        monkeypatch.setattr(
            route_mod, "_availability_call_transport_factory",
            lambda: _exploding_factory(),  # would raise if ever invoked
        )

        class _Boom:
            async def run_call(self, ctx):  # pragma: no cover
                raise AssertionError("must never be reached — allowlist refuses first")

        monkeypatch.setattr(route_mod, "_availability_call_transport_factory", lambda: _Boom())
        resp = await route_mod.request_availability_call(
            _req(phone="+19998887777"), _owner_id="u1"
        )
        assert resp.status == "not_enabled"


# ─── Full happy path via the simulator (transport injected, gate open) ────────


class TestFullFlowViaSimulator:
    async def test_pending_then_completed_with_spoken_slots(self, monkeypatch):
        monkeypatch.setenv("VOICE_BOOKING_VERIFIED_LINES", "+17165551212")
        monkeypatch.setattr(
            route_mod, "_availability_call_transport_factory",
            lambda: SimulatedCallTransport("lists_three_times"),
        )
        resp = await route_mod.request_availability_call(_req(), _owner_id="u1")
        assert resp.status == "pending"
        assert resp.id

        # Let the background task run to completion (test-only determinism —
        # production polls GET instead of awaiting this directly).
        await route_mod._availability_jobs[resp.id]["_task"]

        status = await route_mod.get_availability_call(resp.id, _owner_id="u1")
        assert status.status == "completed"
        assert status.outcome == "availability"
        assert [s.time for s in status.slotsSpoken] == ["07:20", "08:40", "09:15"]
        assert status.calledAt is not None

    async def test_no_availability_persona_completes_with_zero_slots(self, monkeypatch):
        monkeypatch.setenv("VOICE_BOOKING_VERIFIED_LINES", "+17165551212")
        monkeypatch.setattr(
            route_mod, "_availability_call_transport_factory",
            lambda: SimulatedCallTransport("no_availability_ask"),
        )
        resp = await route_mod.request_availability_call(_req(), _owner_id="u1")
        await route_mod._availability_jobs[resp.id]["_task"]
        status = await route_mod.get_availability_call(resp.id, _owner_id="u1")
        assert status.status == "completed"
        assert status.outcome == "no_availability"
        assert status.slotsSpoken == []

    async def test_completed_call_writes_the_availability_cache(self, monkeypatch):
        from app.services.tee_times.availability_call_cache import availability_cache_key

        monkeypatch.setenv("VOICE_BOOKING_VERIFIED_LINES", "+17165551212")
        monkeypatch.setattr(
            route_mod, "_availability_call_transport_factory",
            lambda: SimulatedCallTransport("lists_three_times"),
        )
        resp = await route_mod.request_availability_call(_req(), _owner_id="u1")
        await route_mod._availability_jobs[resp.id]["_task"]

        key = availability_cache_key("way/999", "2026-07-11", "07:00", "10:00", 2)
        record = route_mod._availability_cache_store.get(key)
        assert record is not None
        assert record.outcome == "availability"
        assert [s.time for s in record.slots_spoken] == ["07:20", "08:40", "09:15"]

    async def test_unknown_job_id_is_404(self):
        with pytest.raises(HTTPException) as exc:
            await route_mod.get_availability_call("nope", _owner_id="u1")
        assert exc.value.status_code == 404


# ─── Window derivation — the S3 bug class structurally cannot occur here ──────


class TestWindowComesOnlyFromTheRequestQuery:
    async def test_call_context_window_equals_the_requested_query_window_exactly(self, monkeypatch):
        """The availability-ask context is built directly from the request's
        date/timeWindowStart/timeWindowEnd — never from a TeeTimeSlot.time
        (which is "" on every route entry). Proves there is no path by which
        an empty slot.time could leak into `_window_end("")` here."""
        monkeypatch.setenv("VOICE_BOOKING_VERIFIED_LINES", "+17165551212")

        captured = {}

        class _CapturingTransport:
            async def run_call(self, ctx):
                captured["ctx"] = ctx
                return [], CallOutcome(result="unclear", detail="captured")

        monkeypatch.setattr(
            route_mod, "_availability_call_transport_factory", lambda: _CapturingTransport()
        )
        req = _req(timeWindowStart="13:15", timeWindowEnd="16:45")
        resp = await route_mod.request_availability_call(req, _owner_id="u1")
        await route_mod._availability_jobs[resp.id]["_task"]

        ctx = captured["ctx"]
        assert ctx.time_window_start == "13:15"
        assert ctx.time_window_end == "16:45"
        assert ctx.mode == "availability"


# ─── Structural: a search never reaches this endpoint ──────────────────────────


def test_search_route_has_no_reference_to_availability_call_trigger():
    """search_tee_times must never call request_availability_call (or enqueue
    a job) — a static guarantee that a search cannot place a call as a side
    effect."""
    import inspect

    src = inspect.getsource(route_mod.search_tee_times)
    assert "availability_call" not in src
    assert "_availability_jobs" not in src
