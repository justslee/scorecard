"""Route integration tests — prove security properties and data persistence.

Each test exercises a real FastAPI request against a real Postgres test DB
(scorecard_test).  The suite is skipped gracefully when Postgres is not
reachable (see conftest._db autouse fixture); CI provides the Postgres service.

Tests (one assertion cluster per security/persistence property):
  1. Auth required (fails closed)     — unauth access returns 401 or 503
  2. IDOR protection                  — owner A's round returns 404 for owner B
  3. Score persistence + upsert       — score round-trips; re-posting same
                                        hole updates instead of duplicating
  4. Profile CRUD round-trip          — GET 204 → PUT creates → GET returns it
  5. Players scoped to owner          — owner B cannot see owner A's players
"""

import pytest
from .conftest import TEST_OWNER_ID, OTHER_OWNER_ID, set_auth

# ── shared payloads ───────────────────────────────────────────────────────────

_PLAYER_ID = "aaaaaaaa-0000-0000-0000-000000000001"

_MINIMAL_ROUND = {
    "courseId": "course-test-001",
    "courseName": "Test Links",
    "players": [{"id": _PLAYER_ID, "name": "Test Golfer"}],
    "holes": [{"number": i, "par": 4} for i in range(1, 10)],
    "games": [],
}


# ─────────────────────────────────────────────────────────────────────────────
# 1. AUTH REQUIRED — fails closed
# ─────────────────────────────────────────────────────────────────────────────


class TestAuthRequired:
    """Owner-gated routes must reject unauthenticated requests.

    With no CLERK_JWKS_URL set and no dependency override active, current_user_id
    raises HTTP 503 ("Auth not configured: set CLERK_JWKS_URL").  The gate must
    not silently serve an anonymous caller.
    """

    async def test_get_rounds_requires_auth(self, client):
        # No set_auth call — dependency_overrides are clear (see _clear_auth_overrides)
        r = await client.get("/api/rounds")
        assert r.status_code in (401, 503), (
            f"Expected 401 or 503 without auth, got {r.status_code}"
        )

    async def test_get_profile_requires_auth(self, client):
        r = await client.get("/api/profile/golfer")
        assert r.status_code in (401, 503), (
            f"Expected 401 or 503 without auth, got {r.status_code}"
        )

    async def test_get_players_requires_auth(self, client):
        r = await client.get("/api/players")
        assert r.status_code in (401, 503), (
            f"Expected 401 or 503 without auth, got {r.status_code}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 2. IDOR PROTECTION — owner A's data is invisible to owner B
# ─────────────────────────────────────────────────────────────────────────────


class TestIDOR:
    """Insecure Direct Object Reference: a row owned by user A must not be
    accessible by user B, even with a valid identity.

    _get_owned_round_row filters by BOTH round_id AND owner_id; if owner_id
    doesn't match it returns 404 (not another owner's data, not a 403 leak).
    This test verifies that contract end-to-end through the HTTP layer.
    """

    async def test_round_idor_returns_404(self, client):
        """Owner B gets 404 when fetching owner A's round id."""
        # --- Create round as owner A ---
        set_auth(TEST_OWNER_ID)
        r = await client.post("/api/rounds", json=_MINIMAL_ROUND)
        assert r.status_code == 200, f"create round failed: {r.text}"
        round_id = r.json()["id"]

        # --- Fetch the same round id as owner B ---
        set_auth(OTHER_OWNER_ID)
        r2 = await client.get(f"/api/rounds/{round_id}")
        assert r2.status_code == 404, (
            f"IDOR: owner B should get 404, got {r2.status_code}. "
            f"Body: {r2.text}"
        )

    async def test_score_write_idor_returns_404(self, client):
        """Owner B cannot post a score to owner A's round."""
        set_auth(TEST_OWNER_ID)
        r = await client.post("/api/rounds", json=_MINIMAL_ROUND)
        assert r.status_code == 200
        round_id = r.json()["id"]

        set_auth(OTHER_OWNER_ID)
        r2 = await client.post(
            f"/api/rounds/{round_id}/scores",
            json={"playerId": _PLAYER_ID, "holeNumber": 1, "strokes": 5},
        )
        assert r2.status_code == 404, (
            f"IDOR: score write by wrong owner should be 404, got {r2.status_code}"
        )

    async def test_round_list_scoped_to_owner(self, client):
        """GET /api/rounds for owner B returns empty list even if owner A has rounds."""
        set_auth(TEST_OWNER_ID)
        r = await client.post("/api/rounds", json=_MINIMAL_ROUND)
        assert r.status_code == 200

        set_auth(OTHER_OWNER_ID)
        r2 = await client.get("/api/rounds")
        assert r2.status_code == 200
        assert r2.json() == [], (
            "Owner B's round list must be empty when they have no rounds"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 3. SCORE PERSISTENCE + UPSERT
# ─────────────────────────────────────────────────────────────────────────────


class TestScorePersistence:
    """Scores round-trip through POST /api/rounds/{id}/scores and are readable
    via GET /api/rounds/{id}.  Posting the same (player, hole) pair a second
    time must UPDATE the existing row (via the scores_round_player_hole_uq
    unique constraint) rather than inserting a duplicate.
    """

    async def test_score_roundtrip_and_upsert(self, client):
        set_auth(TEST_OWNER_ID)

        # 1. Create round
        r = await client.post("/api/rounds", json=_MINIMAL_ROUND)
        assert r.status_code == 200
        round_id = r.json()["id"]

        # 2. Post score: hole 1, 4 strokes
        r = await client.post(
            f"/api/rounds/{round_id}/scores",
            json={"playerId": _PLAYER_ID, "holeNumber": 1, "strokes": 4},
        )
        assert r.status_code == 200

        # 3. Read back — score must be present with correct values
        r = await client.get(f"/api/rounds/{round_id}")
        assert r.status_code == 200
        body = r.json()
        h1_scores = [
            s for s in body["scores"]
            if s["playerId"] == _PLAYER_ID and s["holeNumber"] == 1
        ]
        assert len(h1_scores) == 1, "Expected exactly one score for hole 1"
        assert h1_scores[0]["strokes"] == 4

        # 4. Upsert — same hole, different strokes value
        r = await client.post(
            f"/api/rounds/{round_id}/scores",
            json={"playerId": _PLAYER_ID, "holeNumber": 1, "strokes": 3},
        )
        assert r.status_code == 200

        # 5. Read back — must be ONE score (not duplicated), updated to 3
        r = await client.get(f"/api/rounds/{round_id}")
        assert r.status_code == 200
        body = r.json()
        h1_scores = [
            s for s in body["scores"]
            if s["playerId"] == _PLAYER_ID and s["holeNumber"] == 1
        ]
        assert len(h1_scores) == 1, (
            f"Upsert must not create a duplicate row; found {len(h1_scores)} scores"
        )
        assert h1_scores[0]["strokes"] == 3, (
            "Upsert must update strokes from 4 to 3"
        )

    async def test_score_different_holes_persist_separately(self, client):
        """Scores on different holes coexist without collision."""
        set_auth(TEST_OWNER_ID)
        r = await client.post("/api/rounds", json=_MINIMAL_ROUND)
        assert r.status_code == 200
        round_id = r.json()["id"]

        for hole, strokes in [(1, 4), (2, 5), (3, 3)]:
            r = await client.post(
                f"/api/rounds/{round_id}/scores",
                json={"playerId": _PLAYER_ID, "holeNumber": hole, "strokes": strokes},
            )
            assert r.status_code == 200

        r = await client.get(f"/api/rounds/{round_id}")
        body = r.json()
        scores_by_hole = {s["holeNumber"]: s["strokes"] for s in body["scores"]}
        assert scores_by_hole == {1: 4, 2: 5, 3: 3}


# ─────────────────────────────────────────────────────────────────────────────
# 4. PROFILE CRUD ROUND-TRIP
# ─────────────────────────────────────────────────────────────────────────────


class TestProfileCRUD:
    """GET /api/profile/golfer returns 204 when no profile exists; PUT creates
    it; subsequent GET returns the persisted data.
    """

    async def test_profile_get_put_get(self, client):
        set_auth(TEST_OWNER_ID)

        # 1. No profile yet — expect 204
        r = await client.get("/api/profile/golfer")
        assert r.status_code == 204, (
            f"Expected 204 before profile is created, got {r.status_code}"
        )

        # 2. Create / upsert profile
        r = await client.put(
            "/api/profile/golfer",
            json={"name": "Justin", "handicap": 12.5, "homeCourse": "Pebble Beach"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["name"] == "Justin"
        assert body["handicap"] == pytest.approx(12.5)
        assert body["homeCourse"] == "Pebble Beach"

        # 3. Read back — must return the same data
        r = await client.get("/api/profile/golfer")
        assert r.status_code == 200
        body2 = r.json()
        assert body2["name"] == "Justin"
        assert body2["handicap"] == pytest.approx(12.5)
        assert body2["homeCourse"] == "Pebble Beach"

    async def test_profile_partial_update(self, client):
        """PUT with a subset of fields does a partial update (None fields ignored)."""
        set_auth(TEST_OWNER_ID)

        await client.put(
            "/api/profile/golfer",
            json={"name": "Justin", "handicap": 12.5},
        )
        # Update only handicap
        r = await client.put("/api/profile/golfer", json={"handicap": 10.0})
        assert r.status_code == 200

        r = await client.get("/api/profile/golfer")
        body = r.json()
        assert body["handicap"] == pytest.approx(10.0)
        # name should be preserved (was not included in the second PUT)
        assert body["name"] == "Justin"


# ─────────────────────────────────────────────────────────────────────────────
# 5. PLAYERS CRUD — scoped to owner
# ─────────────────────────────────────────────────────────────────────────────


class TestPlayersCRUD:
    """Players are created with owner_id = calling user.  Owner B's GET /api/players
    must return an empty list even when owner A has players — row-level ownership.
    """

    async def test_create_and_list_players(self, client):
        set_auth(TEST_OWNER_ID)

        r = await client.post(
            "/api/players",
            json={"name": "Alice", "handicap": 8.0},
        )
        assert r.status_code == 200
        player_id = r.json()["id"]
        assert r.json()["name"] == "Alice"

        # List — must include the new player
        r = await client.get("/api/players")
        assert r.status_code == 200
        ids = [p["id"] for p in r.json()]
        assert player_id in ids

    async def test_players_not_visible_to_other_owner(self, client):
        """Owner A creates a player; owner B sees an empty list."""
        set_auth(TEST_OWNER_ID)
        r = await client.post("/api/players", json={"name": "Alice"})
        assert r.status_code == 200

        set_auth(OTHER_OWNER_ID)
        r2 = await client.get("/api/players")
        assert r2.status_code == 200
        assert r2.json() == [], (
            "Owner B must not see owner A's players"
        )

    async def test_get_player_idor(self, client):
        """Owner B cannot fetch a player created by owner A by id."""
        set_auth(TEST_OWNER_ID)
        r = await client.post("/api/players", json={"name": "Alice"})
        assert r.status_code == 200
        player_id = r.json()["id"]

        set_auth(OTHER_OWNER_ID)
        r2 = await client.get(f"/api/players/{player_id}")
        assert r2.status_code == 404, (
            f"IDOR: owner B fetching owner A's player should be 404, got {r2.status_code}"
        )


_PLAYER_ID_2 = "aaaaaaaa-0000-0000-0000-000000000002"


class TestRoundOwnerPlayerId:
    """ownerPlayerId identifies the owner's player explicitly instead of the
    brittle players[0] assumption (backlog owner-player-identity)."""

    async def test_explicit_owner_player_id_round_trips(self, client):
        """A round created with an explicit ownerPlayerId (a non-first player)
        returns and persists that id — not players[0]."""
        set_auth(TEST_OWNER_ID)
        payload = {
            **_MINIMAL_ROUND,
            "players": [
                {"id": _PLAYER_ID, "name": "Other Golfer"},
                {"id": _PLAYER_ID_2, "name": "The Owner"},
            ],
            "ownerPlayerId": _PLAYER_ID_2,  # owner is NOT first-listed
        }
        r = await client.post("/api/rounds", json=payload)
        assert r.status_code == 200, f"create failed: {r.text}"
        assert r.json()["ownerPlayerId"] == _PLAYER_ID_2

        # And it survives a fresh fetch.
        round_id = r.json()["id"]
        r2 = await client.get(f"/api/rounds/{round_id}")
        assert r2.status_code == 200
        assert r2.json()["ownerPlayerId"] == _PLAYER_ID_2

    async def test_owner_player_id_defaults_to_first_player(self, client):
        """When the client omits ownerPlayerId, the backend defaults to the
        first player (preserving the prior players[0] behaviour)."""
        set_auth(TEST_OWNER_ID)
        payload = {
            **_MINIMAL_ROUND,
            "players": [
                {"id": _PLAYER_ID, "name": "First Golfer"},
                {"id": _PLAYER_ID_2, "name": "Second Golfer"},
            ],
        }
        r = await client.post("/api/rounds", json=payload)
        assert r.status_code == 200, f"create failed: {r.text}"
        assert r.json()["ownerPlayerId"] == _PLAYER_ID
