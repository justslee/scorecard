"""Agentic caddie P2 integration tests — shared ledger append + session tool reads.

Covers the server-side pieces of "real voice":
  1. POST /caddie/session/message  — voice turns land in the caddie_messages
     ledger (pair = atomic dual append) so the text mouth shares history;
     owner-scoped; roles fixed by field name; content validated.
  2. GET /caddie/session/{id}/conditions      — honest tool read: weather from
     the session cache, plays-like only when hole intel exists (never a guess).
  3. GET /caddie/session/{id}/player-profile  — handicap + entered club
     distances + tendencies for the get_player_profile tool.

record_shot dual-write parity: the Realtime `record_shot` tool dispatches to
the SAME POST /caddie/session/shot endpoint as the sheet (see frontend
lib/voice/realtime.ts dispatchTool + realtime-dispatch.test.ts), so the P1
dual-write suite in test_caddie_profile_session.py covers the voice path too.

Same harness as test_routes.py: real Postgres (skipped without one; CI
provides it), auth injected via dependency_overrides.
"""

from .conftest import TEST_OWNER_ID, OTHER_OWNER_ID, set_auth

ROUND_ID = "caddie-p2-round-001"


async def _start_session(client, round_id: str = ROUND_ID, **extra):
    payload = {"round_id": round_id, **extra}
    r = await client.post("/api/caddie/session/start", json=payload)
    assert r.status_code == 200, f"session/start failed: {r.text}"
    return r.json()


# ─────────────────────────────────────────────────────────────────────────────
# 1. POST /session/message — shared conversation ledger
# ─────────────────────────────────────────────────────────────────────────────


class TestSessionMessageAppend:
    async def test_pair_appends_both_roles_in_order(self, client):
        set_auth(TEST_OWNER_ID)
        await _start_session(client)

        r = await client.post("/api/caddie/session/message", json={
            "round_id": ROUND_ID,
            "user_content": "What should I hit?",
            "assistant_content": "Easy 8-iron, favor the left side.",
            "hole_number": 4,
        })
        assert r.status_code == 200, r.text
        assert r.json() == {"status": "recorded", "appended": 2}

        status = await client.get(f"/api/caddie/session/{ROUND_ID}")
        assert status.json()["conversation_length"] == 2

        # Ledger rows carry the right roles/content in conversation order.
        from sqlalchemy import select
        from app.db.engine import async_session
        from app.db.models import CaddieMessage

        async with async_session() as db:
            rows = list((await db.execute(
                select(CaddieMessage)
                .where(CaddieMessage.round_id == ROUND_ID)
                .order_by(CaddieMessage.created_at)
            )).scalars().all())
        assert [(m.role, m.content) for m in rows] == [
            ("user", "What should I hit?"),
            ("assistant", "Easy 8-iron, favor the left side."),
        ]
        assert all(m.hole_number == 4 for m in rows)

    async def test_lone_assistant_turn_appends_one_row(self, client):
        """The caddie may speak first (greeting) — a lone side is allowed."""
        set_auth(TEST_OWNER_ID)
        await _start_session(client)

        r = await client.post("/api/caddie/session/message", json={
            "round_id": ROUND_ID,
            "assistant_content": "Morning — ready when you are.",
        })
        assert r.status_code == 200
        assert r.json()["appended"] == 1

        status = await client.get(f"/api/caddie/session/{ROUND_ID}")
        assert status.json()["conversation_length"] == 1

    async def test_empty_body_is_rejected(self, client):
        set_auth(TEST_OWNER_ID)
        await _start_session(client)

        r = await client.post("/api/caddie/session/message", json={
            "round_id": ROUND_ID,
            "user_content": "   ",
        })
        assert r.status_code == 422

    async def test_oversized_content_is_rejected(self, client):
        set_auth(TEST_OWNER_ID)
        await _start_session(client)

        r = await client.post("/api/caddie/session/message", json={
            "round_id": ROUND_ID,
            "user_content": "x" * 4001,
            "assistant_content": "ok",
        })
        assert r.status_code == 422

    async def test_requires_round_ownership(self, client):
        set_auth(TEST_OWNER_ID)
        await _start_session(client)

        set_auth(OTHER_OWNER_ID)
        r = await client.post("/api/caddie/session/message", json={
            "round_id": ROUND_ID,
            "user_content": "hi",
            "assistant_content": "hello",
        })
        assert r.status_code == 404, "non-owner must get 404, not append"

        set_auth(TEST_OWNER_ID)
        status = await client.get(f"/api/caddie/session/{ROUND_ID}")
        assert status.json()["conversation_length"] == 0

    async def test_shared_with_text_mouth_history(self, client):
        """Turns appended by the voice mouth appear in the same ledger that
        /session/voice reads (conversation_history on the session)."""
        set_auth(TEST_OWNER_ID)
        await _start_session(client)

        await client.post("/api/caddie/session/message", json={
            "round_id": ROUND_ID,
            "user_content": "Wind check?",
            "assistant_content": "Ten miles an hour, helping.",
        })

        from app.caddie.session import sessions

        session = await sessions.get(ROUND_ID)
        assert [(m.role, m.content) for m in session.conversation_history] == [
            ("user", "Wind check?"),
            ("assistant", "Ten miles an hour, helping."),
        ]


# ─────────────────────────────────────────────────────────────────────────────
# 2. GET /session/{id}/conditions — honest tool read
# ─────────────────────────────────────────────────────────────────────────────


class TestSessionConditions:
    async def test_no_intel_returns_null_plays_like(self, client):
        """No cached hole intel → plays_like is null (the model must say it
        doesn't have the number, not invent one)."""
        set_auth(TEST_OWNER_ID)
        await _start_session(client)

        r = await client.get(f"/api/caddie/session/{ROUND_ID}/conditions?hole_number=3")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["hole_number"] == 3
        assert body["plays_like"] is None
        assert body["weather"] is None  # no course-intel/weather fetched yet

    async def test_with_intel_returns_plays_like_delta(self, client):
        set_auth(TEST_OWNER_ID)
        await _start_session(client)

        from app.caddie.session import sessions
        from app.caddie.types import HoleIntelligence, WeatherConditions

        intel = HoleIntelligence(
            hole_number=5, par=4, yards=410, effective_yards=422, elevation_change_ft=24.0,
        )
        await sessions.set_hole_intel(
            ROUND_ID, {5: intel},
            weather=WeatherConditions(temperature_f=61.0, wind_speed_mph=12.0, wind_direction=270),
        )

        r = await client.get(f"/api/caddie/session/{ROUND_ID}/conditions?hole_number=5")
        body = r.json()
        assert body["plays_like"] == {
            "yards": 410,
            "effective_yards": 422,
            "plays_like_delta": 12,
            "elevation_change_ft": 24.0,
        }
        assert body["weather"]["wind_speed_mph"] == 12.0

    async def test_requires_ownership(self, client):
        set_auth(TEST_OWNER_ID)
        await _start_session(client)
        set_auth(OTHER_OWNER_ID)
        r = await client.get(f"/api/caddie/session/{ROUND_ID}/conditions")
        assert r.status_code == 404


# ─────────────────────────────────────────────────────────────────────────────
# 3. GET /session/{id}/player-profile — player numbers tool read
# ─────────────────────────────────────────────────────────────────────────────


class TestSessionPlayerProfile:
    async def test_returns_session_clubs_and_handicap(self, client):
        set_auth(TEST_OWNER_ID)
        await _start_session(
            client,
            club_distances={"7iron": 155, "pw": 120},
            handicap=11.2,
        )

        r = await client.get(f"/api/caddie/session/{ROUND_ID}/player-profile")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["handicap"] == 11.2
        # Display names, zero-distance clubs dropped.
        assert body["club_distances"] == {"7 Iron": 155, "PW": 120}

    async def test_requires_ownership(self, client):
        set_auth(TEST_OWNER_ID)
        await _start_session(client)
        set_auth(OTHER_OWNER_ID)
        r = await client.get(f"/api/caddie/session/{ROUND_ID}/player-profile")
        assert r.status_code == 404
