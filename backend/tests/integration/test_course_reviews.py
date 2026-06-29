"""Integration tests for course-reviews endpoints (B2 + B3).

Covers:
  1. Create + echo (POST → 200, fields round-trip)
  2. List owner-scoped (GET as A sees own review; GET as B sees nothing)
  3. Rating validation (0 → 422, 6 → 422; boundary 1 and 5 → 200)
  4. Body cap (2001 chars → 422)
  5. Auth fails-closed (no auth → 401 or 503)
  6. name: key with special chars (URL-encoded, slash-free round-trip)
  7. No-shadowing guard (/{id} 404 via catch-all still works alongside /{key}/reviews)
  8. GET /api/reviews/mine — own reviews across keys (B3)
"""

from urllib.parse import quote

from .conftest import TEST_OWNER_ID, OTHER_OWNER_ID, set_auth

BASE = "/api/courses"


# ─────────────────────────────────────────────────────────────────────────────
# 1. Create + echo
# ─────────────────────────────────────────────────────────────────────────────


class TestCreateReview:
    async def test_create_returns_200_and_echoes_fields(self, client):
        set_auth(TEST_OWNER_ID)
        payload = {
            "rating": 4,
            "body": "calm and scenic",
            "roundId": "r-abc-001",
            "courseName": "Pebble Beach",
            "playedAt": "2026-06-20",
        }
        r = await client.post(f"{BASE}/12345/reviews", json=payload)
        assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text}"
        data = r.json()
        assert data["ownerId"] == TEST_OWNER_ID
        assert data["courseKey"] == "12345"
        assert data["rating"] == 4
        assert data["body"] == "calm and scenic"
        assert data["roundId"] == "r-abc-001"
        assert data["courseName"] == "Pebble Beach"
        assert data["playedAt"] == "2026-06-20"
        assert "id" in data
        assert "createdAt" in data

    async def test_create_without_optional_fields(self, client):
        set_auth(TEST_OWNER_ID)
        r = await client.post(f"{BASE}/67890/reviews", json={"rating": 3})
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["rating"] == 3
        assert data["body"] is None
        assert data["roundId"] is None
        assert data["courseName"] is None
        assert data["playedAt"] is None


# ─────────────────────────────────────────────────────────────────────────────
# 2. List owner-scoped
# ─────────────────────────────────────────────────────────────────────────────


class TestListReviews:
    async def test_list_returns_own_reviews(self, client):
        set_auth(TEST_OWNER_ID)
        await client.post(f"{BASE}/12345/reviews", json={"rating": 5, "body": "excellent"})
        r = await client.get(f"{BASE}/12345/reviews")
        assert r.status_code == 200, r.text
        items = r.json()
        assert len(items) == 1
        assert items[0]["rating"] == 5
        assert items[0]["body"] == "excellent"
        assert items[0]["ownerId"] == TEST_OWNER_ID

    async def test_list_cross_user_isolation(self, client):
        """Owner A's review must not appear in owner B's list."""
        set_auth(TEST_OWNER_ID)
        await client.post(f"{BASE}/12345/reviews", json={"rating": 4})

        set_auth(OTHER_OWNER_ID)
        r = await client.get(f"{BASE}/12345/reviews")
        assert r.status_code == 200, r.text
        assert r.json() == [], (
            f"Cross-user isolation: owner B should see [], got {r.json()}"
        )

    async def test_list_empty_when_no_reviews(self, client):
        set_auth(TEST_OWNER_ID)
        r = await client.get(f"{BASE}/nonexistent-key-xyz/reviews")
        assert r.status_code == 200, r.text
        assert r.json() == []


# ─────────────────────────────────────────────────────────────────────────────
# 3. Rating validation
# ─────────────────────────────────────────────────────────────────────────────


class TestRatingValidation:
    async def test_rating_zero_is_422(self, client):
        set_auth(TEST_OWNER_ID)
        r = await client.post(f"{BASE}/12345/reviews", json={"rating": 0})
        assert r.status_code == 422, f"Expected 422 for rating=0, got {r.status_code}"

    async def test_rating_six_is_422(self, client):
        set_auth(TEST_OWNER_ID)
        r = await client.post(f"{BASE}/12345/reviews", json={"rating": 6})
        assert r.status_code == 422, f"Expected 422 for rating=6, got {r.status_code}"

    async def test_rating_boundary_one_is_200(self, client):
        set_auth(TEST_OWNER_ID)
        r = await client.post(f"{BASE}/12345/reviews", json={"rating": 1})
        assert r.status_code == 200, f"Expected 200 for rating=1 (boundary), got {r.status_code}"

    async def test_rating_boundary_five_is_200(self, client):
        set_auth(TEST_OWNER_ID)
        r = await client.post(f"{BASE}/12345/reviews", json={"rating": 5})
        assert r.status_code == 200, f"Expected 200 for rating=5 (boundary), got {r.status_code}"


# ─────────────────────────────────────────────────────────────────────────────
# 4. Body cap
# ─────────────────────────────────────────────────────────────────────────────


class TestBodyCap:
    async def test_body_2001_chars_is_422(self, client):
        set_auth(TEST_OWNER_ID)
        r = await client.post(
            f"{BASE}/12345/reviews",
            json={"rating": 3, "body": "x" * 2001},
        )
        assert r.status_code == 422, (
            f"Expected 422 for body > 2000 chars, got {r.status_code}"
        )

    async def test_body_2000_chars_is_200(self, client):
        set_auth(TEST_OWNER_ID)
        r = await client.post(
            f"{BASE}/12345/reviews",
            json={"rating": 3, "body": "x" * 2000},
        )
        assert r.status_code == 200, (
            f"Expected 200 for body == 2000 chars, got {r.status_code}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 5. Auth fails-closed
# ─────────────────────────────────────────────────────────────────────────────


class TestAuthFailsClosed:
    async def test_post_without_auth_returns_401_or_503(self, client):
        # No set_auth — dependency_overrides are clear (see _clear_auth_overrides).
        r = await client.post(f"{BASE}/12345/reviews", json={"rating": 3})
        assert r.status_code in (401, 503), (
            f"Expected 401 or 503 without auth, got {r.status_code}"
        )

    async def test_get_without_auth_returns_401_or_503(self, client):
        r = await client.get(f"{BASE}/12345/reviews")
        assert r.status_code in (401, 503), (
            f"Expected 401 or 503 without auth, got {r.status_code}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 6. name: key with special chars — URL-encoded, slash-free round-trip
# ─────────────────────────────────────────────────────────────────────────────


class TestNameKeyEncoding:
    async def test_name_key_round_trips(self, client):
        """name:pebble-beach-old-course is slash-free; encode the colon as %3A."""
        set_auth(TEST_OWNER_ID)
        raw_key = "name:pebble-beach-old-course"
        encoded_key = quote(raw_key, safe="")  # %3A for ':', no '/' in value

        r = await client.post(
            f"{BASE}/{encoded_key}/reviews",
            json={"rating": 4, "courseName": "Pebble Beach / Old Course"},
        )
        assert r.status_code == 200, f"POST with name: key failed: {r.text}"
        data = r.json()
        # Server stores and echoes the decoded key
        assert data["courseKey"] == raw_key, (
            f"courseKey mismatch: expected {raw_key!r}, got {data['courseKey']!r}"
        )

        # GET round-trips the key correctly
        r2 = await client.get(f"{BASE}/{encoded_key}/reviews")
        assert r2.status_code == 200, r2.text
        items = r2.json()
        assert len(items) == 1
        assert items[0]["courseKey"] == raw_key


# ─────────────────────────────────────────────────────────────────────────────
# 7. No-shadowing guard — catch-all /{id} still works alongside /{key}/reviews
# ─────────────────────────────────────────────────────────────────────────────


class TestNoShadowing:
    async def test_single_segment_course_404_and_reviews_200(self, client):
        """GET /api/courses/<random-id> → 404 (catch-all courses.router owns it).
        GET /api/courses/<key>/reviews → 200/[] (course_reviews.router owns it).
        Both must coexist without shadowing.
        """
        set_auth(TEST_OWNER_ID)
        random_id = "00000000-dead-beef-cafe-000000000000"

        # Single-segment — must 404 (no such scoring course)
        r_single = await client.get(f"{BASE}/{random_id}")
        assert r_single.status_code == 404, (
            f"Expected 404 for non-existent course id, got {r_single.status_code}"
        )

        # Two-segment reviews — must 200 (empty list, not a 404)
        r_reviews = await client.get(f"{BASE}/{random_id}/reviews")
        assert r_reviews.status_code == 200, (
            f"Expected 200 for /{random_id}/reviews, got {r_reviews.status_code}: {r_reviews.text}"
        )
        assert r_reviews.json() == []


# ─────────────────────────────────────────────────────────────────────────────
# 8. GET /api/reviews/mine — own reviews across all course keys (B3)
# ─────────────────────────────────────────────────────────────────────────────

MINE = "/api/reviews/mine"


class TestMyReviews:
    async def test_returns_own_across_keys_ordered_desc(self, client):
        set_auth(TEST_OWNER_ID)
        # Seed reviews across multiple course_keys
        await client.post(f"{BASE}/11111/reviews", json={"rating": 3, "body": "first"})
        await client.post(f"{BASE}/22222/reviews", json={"rating": 5, "body": "second"})
        encoded_name_key = quote("name:third-course", safe="")
        await client.post(
            f"{BASE}/{encoded_name_key}/reviews",
            json={"rating": 4, "body": "third"},
        )
        r = await client.get(MINE)
        assert r.status_code == 200, r.text
        items = r.json()
        assert len(items) == 3
        # All owned by caller
        assert all(it["ownerId"] == TEST_OWNER_ID for it in items)
        # Spans multiple keys
        assert {it["courseKey"] for it in items} == {"11111", "22222", "name:third-course"}
        # created_at desc — non-increasing
        created = [it["createdAt"] for it in items]
        assert created == sorted(created, reverse=True)

    async def test_cross_user_isolation(self, client):
        set_auth(TEST_OWNER_ID)
        await client.post(f"{BASE}/11111/reviews", json={"rating": 4})
        set_auth(OTHER_OWNER_ID)
        r = await client.get(MINE)
        assert r.status_code == 200, r.text
        assert r.json() == [], f"owner B must not see owner A's reviews, got {r.json()}"

    async def test_empty_when_none(self, client):
        set_auth(OTHER_OWNER_ID)
        r = await client.get(MINE)
        assert r.status_code == 200, r.text
        assert r.json() == []

    async def test_auth_fails_closed(self, client):
        # No set_auth — dependency overrides are cleared by the fixture
        r = await client.get(MINE)
        assert r.status_code in (401, 503), (
            f"expected fail-closed, got {r.status_code}"
        )
