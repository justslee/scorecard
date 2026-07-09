"""Agentic caddie P1 integration tests — session dual-write, profile API, anchor intel.

Covers the three server-side pieces of "wire the existing brain":
  1. /session/shot dual-write   — a voice-logged shot lands in BOTH the volatile
                                  session history and the durable `shots` table
                                  (feeds learning.py), with retry idempotence.
  2. /caddie/profile GET + PUT  — owner-scoped read of player_profiles and the
                                  preferred_personality_id upsert (persona fix).
  3. /caddie/course-intel       — honors the round's stored course anchor
                                  (course_lat/course_lng) and caches intel +
                                  weather into the session when round_id passed.

Same harness as test_routes.py: real Postgres (skipped without one; CI provides
it), auth injected via dependency_overrides.
"""

from .conftest import TEST_OWNER_ID, OTHER_OWNER_ID, set_auth

ROUND_ID = "caddie-p1-round-001"


async def _start_session(client, round_id: str = ROUND_ID):
    r = await client.post("/api/caddie/session/start", json={"round_id": round_id})
    assert r.status_code == 200, f"session/start failed: {r.text}"
    return r.json()


async def _durable_shots(round_id: str = ROUND_ID):
    """Read the durable shots table directly (engine points at the test DB)."""
    from sqlalchemy import select
    from app.db.engine import async_session
    from app.db.models import Shot

    async with async_session() as db:
        result = await db.execute(
            select(Shot).where(Shot.round_id == round_id).order_by(Shot.shot_number)
        )
        return list(result.scalars().all())


# ─────────────────────────────────────────────────────────────────────────────
# 1. /session/shot dual-write
# ─────────────────────────────────────────────────────────────────────────────


class TestSessionShotDualWrite:
    async def test_shot_writes_session_and_durable_row(self, client):
        set_auth(TEST_OWNER_ID)
        await _start_session(client)

        r = await client.post("/api/caddie/session/shot", json={
            "round_id": ROUND_ID,
            "hole_number": 3,
            "club": "7i",
            "distance_yards": 152,
            "result": "green",
        })
        assert r.status_code == 200, r.text
        assert r.json()["total_shots"] == 1

        rows = await _durable_shots()
        assert len(rows) == 1, "voice-logged shot must land in the durable shots table"
        row = rows[0]
        assert row.user_id == TEST_OWNER_ID
        assert row.hole_number == 3
        assert row.shot_number == 1
        assert row.club == "7i"
        assert float(row.distance_yards) == 152.0
        assert row.result == "green"
        assert row.start_lat is None and row.end_lat is None  # voice path has no GPS

        # Session history got it too.
        status = await client.get(f"/api/caddie/session/{ROUND_ID}")
        assert status.json()["shot_count"] == 1

    async def test_identical_retry_does_not_double_insert(self, client):
        set_auth(TEST_OWNER_ID)
        await _start_session(client)

        payload = {
            "round_id": ROUND_ID,
            "hole_number": 5,
            "club": "pw",
            "distance_yards": 110,
            "result": "short",
        }
        r1 = await client.post("/api/caddie/session/shot", json=payload)
        assert r1.status_code == 200
        r2 = await client.post("/api/caddie/session/shot", json=payload)  # retry
        assert r2.status_code == 200
        assert r2.json().get("duplicate") is True
        assert r2.json()["total_shots"] == 1

        assert len(await _durable_shots()) == 1, "retry must not double-insert"

        status = await client.get(f"/api/caddie/session/{ROUND_ID}")
        assert status.json()["shot_count"] == 1, "retry must not double-append session history"

    async def test_distinct_shots_get_sequential_shot_numbers(self, client):
        set_auth(TEST_OWNER_ID)
        await _start_session(client)

        for club, dist in [("driver", 260), ("9i", 140)]:
            r = await client.post("/api/caddie/session/shot", json={
                "round_id": ROUND_ID,
                "hole_number": 1,
                "club": club,
                "distance_yards": dist,
            })
            assert r.status_code == 200

        rows = await _durable_shots()
        assert [(s.shot_number, s.club) for s in rows] == [(1, "driver"), (2, "9i")]

    async def test_shot_requires_round_ownership(self, client):
        set_auth(TEST_OWNER_ID)
        await _start_session(client)

        set_auth(OTHER_OWNER_ID)
        r = await client.post("/api/caddie/session/shot", json={
            "round_id": ROUND_ID,
            "hole_number": 1,
            "club": "7i",
            "distance_yards": 150,
        })
        assert r.status_code == 404, "IDOR: another user must not log shots into this round"
        assert await _durable_shots() == []


# ─────────────────────────────────────────────────────────────────────────────
# 2. /caddie/profile
# ─────────────────────────────────────────────────────────────────────────────


class TestCaddieProfile:
    async def test_profile_requires_auth(self, client):
        r = await client.get("/api/caddie/profile")
        assert r.status_code in (401, 503)

    async def test_profile_defaults_when_no_row(self, client):
        set_auth(TEST_OWNER_ID)
        r = await client.get("/api/caddie/profile")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["preferred_personality_id"] == "classic"
        assert body["rounds_analyzed"] == 0
        assert body["handicap"] is None
        # Shape contract for the frontend client.
        for key in ("miss_direction", "miss_short_pct", "three_putts_per_round", "par5_bogey_rate"):
            assert key in body

    async def test_put_persona_round_trips(self, client):
        set_auth(TEST_OWNER_ID)
        r = await client.put(
            "/api/caddie/profile", json={"preferred_personality_id": "strategist"}
        )
        assert r.status_code == 200, r.text
        assert r.json()["preferred_personality_id"] == "strategist"

        r2 = await client.get("/api/caddie/profile")
        assert r2.json()["preferred_personality_id"] == "strategist"

        # Update again — upsert path, not insert-only.
        r3 = await client.put(
            "/api/caddie/profile", json={"preferred_personality_id": "hype"}
        )
        assert r3.status_code == 200
        assert r3.json()["preferred_personality_id"] == "hype"

    async def test_put_unknown_persona_is_404(self, client):
        set_auth(TEST_OWNER_ID)
        r = await client.put(
            "/api/caddie/profile", json={"preferred_personality_id": "steve"}
        )
        assert r.status_code == 404, (
            "an unknown persona id must be rejected, not silently accepted "
            f"(got {r.status_code}: {r.text})"
        )

    async def test_profile_is_owner_scoped(self, client):
        set_auth(TEST_OWNER_ID)
        await client.put("/api/caddie/profile", json={"preferred_personality_id": "professor"})

        set_auth(OTHER_OWNER_ID)
        r = await client.get("/api/caddie/profile")
        assert r.json()["preferred_personality_id"] == "classic", (
            "user B must not see user A's persona preference"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 3. /caddie/course-intel with the round anchor
# ─────────────────────────────────────────────────────────────────────────────


class TestCourseIntelAnchor:
    async def test_anchor_coords_drive_weather_and_intel_caches_in_session(
        self, client, monkeypatch,
    ):
        from app.caddie.types import WeatherConditions, HoleIntelligence

        weather_calls: list[tuple[float, float]] = []

        async def fake_weather(lat: float, lng: float) -> WeatherConditions:
            weather_calls.append((lat, lng))
            return WeatherConditions(temperature_f=61.0, wind_speed_mph=9.0)

        async def fake_intel(*, hole_coords, par, yards, handicap_rating, **kwargs):
            return HoleIntelligence(
                hole_number=hole_coords.get("holeNumber", 0),
                par=par,
                yards=yards,
                effective_yards=yards,
            )

        monkeypatch.setattr("app.routes.caddie.build_weather_conditions", fake_weather)
        monkeypatch.setattr("app.routes.caddie.build_hole_intelligence", fake_intel)

        set_auth(TEST_OWNER_ID)
        await _start_session(client)

        r = await client.post(
            f"/api/caddie/course-intel?round_id={ROUND_ID}",
            json={
                "hole_coordinates": [
                    {"holeNumber": 1, "green": {"lat": 40.744, "lng": -73.445}, "par": 4, "yards": 430},
                    {"holeNumber": 2, "green": {"lat": 40.745, "lng": -73.446}, "par": 3, "yards": 190},
                ],
                # Round anchor (courseLat/courseLng captured at round creation).
                "course_lat": 40.75,
                "course_lng": -73.45,
            },
        )
        assert r.status_code == 200, r.text
        assert weather_calls == [(40.75, -73.45)], (
            "weather must be fetched at the round's stored anchor, not the first green"
        )
        assert len(r.json()["holes"]) == 2

        # Intel + weather must now live in the session for /session/recommend + /session/voice.
        status = await client.get(f"/api/caddie/session/{ROUND_ID}")
        body = status.json()
        assert body["has_weather"] is True
        assert sorted(body["holes_with_intel"]) == [1, 2]
