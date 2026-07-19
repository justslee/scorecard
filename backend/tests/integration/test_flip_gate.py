"""THE FLIP-GATE — multi-user open-mode acceptance suite.

specs/multiuser-p0-authz-flip-plan.md §5. Proves the FOUR gaps closed by
this slice (durable revocation, per-user hole_pins, persona visibility
enforcement, plus the boot-config machine-check) under the REAL
`APP_ACCESS_MODE=open` boot configuration — not just unit-level pieces.

Every test in this file runs under the `open_mode` fixture below, which sets
APP_ACCESS_MODE=open via monkeypatch ONLY (never anywhere else — the hard
project rule) and proves `_assert_boot_config()` — the actual startup gate —
passes with this exact env. `pytestmark = pytest.mark.flip_gate` (registered
in pyproject.toml) lets `pytest -m flip_gate` run this acceptance gate in
isolation ahead of a real flip.

Real Postgres required (skipped without one — see conftest._db; CI provides
the Postgres service via `required-backend`). `gate=True` throughout (see
conftest.set_auth's docstring) — the REAL require_member/require_owner run,
not the belt-and-suspenders dependency-override bypass used by the
row-scoping suite.

Does NOT edit test_authz_isolation.py / test_clerk_auth.py /
test_webhooks_clerk.py (frozen pins) — this is new, additive coverage.
"""

from __future__ import annotations

import pytest

from app.caddie.session import sessions
from app.services import clerk_auth, revocation
from app.services.clerk_auth import _assert_boot_config

from .conftest import TEST_OWNER_ID, OTHER_OWNER_ID, set_auth
from .test_bag_caddie_grounding import BAG_A_CAMEL, BAG_B_CAMEL, BAG_A_CANONICAL, BAG_B_CANONICAL

pytestmark = pytest.mark.flip_gate

A = TEST_OWNER_ID
B = OTHER_OWNER_ID

_MINIMAL_ROUND = {
    "courseId": "flip-gate-course-001",
    "courseName": "Flip Gate Links",
    "players": [{"id": "aaaaaaaa-1111-0000-0000-000000000099", "name": "Flip Golfer"}],
    "holes": [{"number": i, "par": 4} for i in range(1, 10)],
    "games": [],
}


@pytest.fixture
def open_mode(monkeypatch):
    """The "real boot config" — set ONLY via monkeypatch, per the hard rule
    that APP_ACCESS_MODE is never set anywhere outside test configs.
    Proves the actual startup gate (`_assert_boot_config`) passes with this
    exact env, not just that individual pieces behave under a bare
    `APP_ACCESS_MODE=open` setenv (see test_authz_isolation.py's tests,
    which don't exercise the boot gate itself)."""
    monkeypatch.setenv("APP_ACCESS_MODE", "open")
    monkeypatch.setenv("CLERK_JWKS_URL", "https://clerk.test.looper/.well-known/jwks.json")
    monkeypatch.setenv("CLERK_ISSUER", "https://clerk.test.looper")
    monkeypatch.setenv("CLERK_AUTHORIZED_PARTIES", "https://localhost,https://test.looper")
    monkeypatch.delenv("ALLOW_ANONYMOUS", raising=False)
    _assert_boot_config()  # the REAL boot gate must pass under this env


@pytest.fixture(autouse=True)
def _clean_revocation():
    """The in-process revocation cache is module-level state — clear it
    around every test in this file so revoke_durable() calls here never
    leak into (or pick up cruft from) other test files/tests."""
    revocation._debug_clear()
    yield
    revocation._debug_clear()


# ─────────────────────────────────────────────────────────────────────────────
# 1. Boot config gate — the flip-day env checklist, machine-checked
# ─────────────────────────────────────────────────────────────────────────────


class TestBootConfigGate:
    async def test_boot_config_gate(self, open_mode, monkeypatch):
        # The fixture itself already proved the passing case (it calls
        # _assert_boot_config() and would have raised). Prove the negatives
        # here, starting from that same known-good env.
        monkeypatch.delenv("CLERK_ISSUER", raising=False)
        with pytest.raises(RuntimeError, match="CLERK_ISSUER"):
            clerk_auth._assert_boot_config()

        monkeypatch.setenv("CLERK_ISSUER", "https://clerk.test.looper")
        monkeypatch.setenv("ALLOW_ANONYMOUS", "1")
        with pytest.raises(RuntimeError, match="ALLOW_ANONYMOUS"):
            clerk_auth._assert_boot_config()


# ─────────────────────────────────────────────────────────────────────────────
# 2. Revocation survives a restart (durable store, migration 017)
# ─────────────────────────────────────────────────────────────────────────────


class TestRevocationSurvivesRestart:
    async def test_revocation_survives_restart(self, open_mode, client, monkeypatch):
        from sqlalchemy import text as sa_text

        from app.db.engine import async_session

        banned = "flip-gate-banned-user"

        await revocation.revoke_durable(banned, reason="user.banned", source="clerk_webhook")

        # 1. Persisted to the durable table, not just the in-process dict.
        async with async_session() as db:
            result = await db.execute(
                sa_text("SELECT user_id FROM public.revoked_users WHERE user_id = :uid"),
                {"uid": banned},
            )
            assert result.scalar_one() == banned

        # 2. Simulate a restart: in-process state gone.
        revocation._debug_clear()
        assert not revocation.is_revoked(banned)

        # 3. Boot warm restores it from Postgres.
        n = await revocation.warm_revocation_cache()
        assert n >= 1
        assert revocation.is_revoked(banned)

        # 4. The revoked member is rejected end-to-end through the real gate.
        set_auth(banned, gate=True)
        r = await client.get("/api/rounds")
        assert r.status_code == 403

        # 5. Owner mode never consults the store — owner still passes even
        #    with a (differently-keyed) revocation present.
        monkeypatch.delenv("APP_ACCESS_MODE", raising=False)
        monkeypatch.setenv("OWNER_CLERK_USER_ID", TEST_OWNER_ID)
        set_auth(TEST_OWNER_ID, gate=True)
        r2 = await client.get("/api/rounds")
        assert r2.status_code == 200


# ─────────────────────────────────────────────────────────────────────────────
# 3. Pins isolated per user (migration 018)
# ─────────────────────────────────────────────────────────────────────────────


class TestPinsIsolatedPerUser:
    async def test_pins_isolated_per_user(self, open_mode, client):
        course_id = "flip-gate-pins-course"

        set_auth(A, gate=True)
        r_a1 = await client.post(
            f"/api/courses/{course_id}/pins",
            json={"hole_number": 1, "pin_lat": 40.700, "pin_lng": -73.700},
        )
        assert r_a1.status_code == 200, r_a1.text

        set_auth(B, gate=True)
        assert (await client.get(f"/api/courses/{course_id}/pins")).json() == [], (
            "B must not see A's pin"
        )
        r_b1 = await client.post(
            f"/api/courses/{course_id}/pins",
            json={"hole_number": 1, "pin_lat": 40.800, "pin_lng": -73.800},
        )
        assert r_b1.status_code == 200, r_b1.text

        set_auth(A, gate=True)
        pins_a = (await client.get(f"/api/courses/{course_id}/pins")).json()
        assert len(pins_a) == 1, "A must see exactly A's own pin, unchanged by B's POST"
        assert pins_a[0]["pin_lat"] == 40.700
        assert pins_a[0]["marked_by_user_id"] == A

        set_auth(B, gate=True)
        pins_b = (await client.get(f"/api/courses/{course_id}/pins")).json()
        assert len(pins_b) == 1
        assert pins_b[0]["pin_lat"] == 40.800
        assert pins_b[0]["marked_by_user_id"] == B

        # A re-marks — upsert stays within-user, never clobbers B's row.
        set_auth(A, gate=True)
        r_a2 = await client.post(
            f"/api/courses/{course_id}/pins",
            json={"hole_number": 1, "pin_lat": 40.701, "pin_lng": -73.701},
        )
        assert r_a2.status_code == 200, r_a2.text
        pins_a2 = (await client.get(f"/api/courses/{course_id}/pins")).json()
        assert len(pins_a2) == 1
        assert pins_a2[0]["pin_lat"] == 40.701

        set_auth(B, gate=True)
        pins_b2 = (await client.get(f"/api/courses/{course_id}/pins")).json()
        assert len(pins_b2) == 1
        assert pins_b2[0]["pin_lat"] == 40.800, "A's re-post must not clobber B's pin"


# ─────────────────────────────────────────────────────────────────────────────
# 4. Persona read isolation (load_personality visibility enforcement)
# ─────────────────────────────────────────────────────────────────────────────


class TestPersonasReadIsolation:
    async def test_load_personality_function_level_lock(self, open_mode, client):
        from app.caddie.personalities import load_personality

        set_auth(A, gate=True)
        r = await client.post(
            "/api/caddie/personalities",
            json={
                "name": "A's Secret Coach",
                "description": "private",
                "avatar": "🕵️",
                "system_prompt": "SECRET PROMPT FOR A ONLY",
            },
        )
        assert r.status_code == 200, r.text
        persona_id = r.json()["id"]

        as_b = await load_personality(persona_id, user_id=B)
        assert as_b.id != persona_id, "B must never load A's private persona"
        assert as_b.system_prompt != "SECRET PROMPT FOR A ONLY"

        as_a = await load_personality(persona_id, user_id=A)
        assert as_a.id == persona_id, "A's OWN private persona must still load for A"
        assert as_a.system_prompt == "SECRET PROMPT FOR A ONLY"

        as_nobody = await load_personality(persona_id)
        assert as_nobody.id != persona_id, "no identity -> silent fallback, not A's persona"

    async def test_route_level_read_isolation(self, open_mode, client):
        set_auth(A, gate=True)
        r = await client.post(
            "/api/caddie/personalities",
            json={
                "name": "A's Other Secret Coach",
                "description": "private",
                "avatar": "🕵️",
                "system_prompt": "ANOTHER A-ONLY SECRET",
            },
        )
        assert r.status_code == 200, r.text
        persona_id = r.json()["id"]

        set_auth(B, gate=True)
        r_b = await client.get("/api/caddie/personalities")
        ids_b = {p["id"] for p in r_b.json()["personalities"]}
        assert persona_id not in ids_b, "B's persona list must not include A's private persona"

        set_auth(A, gate=True)
        r_a = await client.get("/api/caddie/personalities")
        ids_a = {p["id"] for p in r_a.json()["personalities"]}
        assert persona_id in ids_a, "A's own list must include A's own persona"


# ─────────────────────────────────────────────────────────────────────────────
# 5. Cross-user sweep — real gate, complementing test_authz_isolation.py
# ─────────────────────────────────────────────────────────────────────────────


class TestCrossUserSweepRealGate:
    async def test_cross_user_sweep_real_gate(self, open_mode, client):
        set_auth(A, gate=True)
        r = await client.post("/api/rounds", json=_MINIMAL_ROUND)
        assert r.status_code == 200, r.text
        round_id = r.json()["id"]

        set_auth(B, gate=True)
        assert (await client.get(f"/api/rounds/{round_id}")).status_code == 404
        assert (await client.put(
            f"/api/rounds/{round_id}", json={"status": "completed"}
        )).status_code == 404
        assert (await client.delete(f"/api/rounds/{round_id}")).status_code == 404

        set_auth(A, gate=True)
        r_check = await client.get(f"/api/rounds/{round_id}")
        assert r_check.status_code == 200
        assert r_check.json()["status"] == "active", "B's failed writes must not touch A's round"

        # Caddie session status (get_owned_session's real 404).
        await client.post("/api/caddie/session/start", json={"round_id": round_id})
        set_auth(B, gate=True)
        assert (await client.get(f"/api/caddie/session/{round_id}")).status_code == 404

        # Profile isolation — each account sees only its own row.
        set_auth(A, gate=True)
        assert (await client.put("/api/profile/golfer", json={"name": "Flip Gate A"})).status_code == 200
        set_auth(B, gate=True)
        assert (await client.put("/api/profile/golfer", json={"name": "Flip Gate B"})).status_code == 200

        set_auth(A, gate=True)
        pa = await client.get("/api/profile/golfer")
        assert pa.status_code == 200
        assert pa.json()["name"] == "Flip Gate A"

        set_auth(B, gate=True)
        pb = await client.get("/api/profile/golfer")
        assert pb.status_code == 200
        assert pb.json()["name"] == "Flip Gate B"


# ─────────────────────────────────────────────────────────────────────────────
# 6. Two-user bags under the real gate (compact companion to
#    test_bag_caddie_grounding.py, which this file's marker also folds in)
# ─────────────────────────────────────────────────────────────────────────────


async def _seed_bag_gate(client, user_id: str, bag_camel: dict) -> None:
    """Same real write path as _seed_bag in test_bag_caddie_grounding.py,
    but gate=True — that module's helpers hardcode gate=False."""
    set_auth(user_id, gate=True)
    r = await client.put("/api/profile/golfer", json={"clubDistances": bag_camel})
    assert r.status_code == 200, f"seed PUT /api/profile/golfer failed: {r.text}"


async def _start_session_no_bag_gate(client, user_id: str, round_id: str) -> dict:
    set_auth(user_id, gate=True)
    r = await client.post("/api/caddie/session/start", json={"round_id": round_id})
    assert r.status_code == 200, f"session/start failed: {r.text}"
    return r.json()


class TestTwoUserBagsUnderRealGate:
    async def test_two_user_bags_under_real_gate(self, open_mode, client):
        round_a = "flip-gate-bag-round-a"
        round_b = "flip-gate-bag-round-b"

        await _seed_bag_gate(client, A, BAG_A_CAMEL)
        await _seed_bag_gate(client, B, BAG_B_CAMEL)
        await _start_session_no_bag_gate(client, A, round_a)
        await _start_session_no_bag_gate(client, B, round_b)

        session_a = await sessions.get(round_a)
        session_b = await sessions.get(round_b)
        assert session_a.club_distances == BAG_A_CANONICAL
        assert session_b.club_distances == BAG_B_CANONICAL
        assert "driver" not in session_b.club_distances, (
            "B's bag has no driver — the server must not invent one"
        )
