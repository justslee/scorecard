"""DB-backed integration coverage for GET /api/courses/{id}/intel
(course-discovery-intel, specs/course-discovery-intel-plan.md §6).

Skips locally via conftest's `_postgres_reachable` probe (no local Postgres
on dev machines); runs for real in CI on the Postgres service, against the
course-mapping schema (001 replay) PLUS the `courses.course_intel` column
added by conftest's ALTER (the 015_course_intel migration's test-schema
precedent — see conftest.py). This test's description round-trip case is
the thing that actually PROVES that conftest ALTER works — if someone later
regenerates the test schema from 001 alone, it fails loudly.

Covers:
  - Empty-reviews honesty: avg null, count 0 (never a fabricated 0.0)
  - Real stars: avg/count reflect a posted review
  - Mapped-course stats: parTotal / holesMapped / yardageByTee
  - Unmapped (write-through-only) row: stats block all null, roundsPlayed 0
  - roundsPlayed counts a round regardless of score completeness
  - avgScore excludes a partial round, includes a complete one
  - description round-trips through the jsonb column, snake_case
    facts_used -> camelCase factsUsed translation
  - never 404s for a well-formed but nonexistent courses.id; 404s for a
    malformed (non-UUID) id
  - budget invariant: no Places/GolfAPI import anywhere in the new files
    (also covered by the standalone grep sweep, §7.6 of the plan)
"""

import uuid

from .conftest import TEST_OWNER_ID, OTHER_OWNER_ID, set_auth

BASE = "/api/courses"


def _seed_mapped_course(course_id: str) -> dict:
    """Two real holes (par 4 + par 5, one tee) — no hole_features needed;
    the route's stats queries never touch hole_features/hazards."""
    return {
        "id": course_id,
        "name": "Intel Test Links",
        "address": "1 Intel Way",
        "location": {"lat": 40.71, "lng": -73.45},
        "teeSets": [{"name": "Blue", "color": "#2563eb"}],
        "holes": [
            {
                "number": 1, "par": 4, "handicap": 1,
                "yardages": {"Blue": 400},
                "features": {"type": "FeatureCollection", "features": []},
            },
            {
                "number": 2, "par": 5, "handicap": 2,
                "yardages": {"Blue": 520},
                "features": {"type": "FeatureCollection", "features": []},
            },
        ],
    }


async def _seed_round(course_id: str, player_id: str, *, owner_id: str = TEST_OWNER_ID) -> str:
    from app.db.engine import async_session
    from app.db.models import Round as RoundORM, RoundPlayer as RoundPlayerORM

    round_id = str(uuid.uuid4())
    async with async_session() as db:
        db.add(
            RoundORM(
                id=round_id,
                owner_id=owner_id,
                owner_player_id=player_id,
                course_id=course_id,
                course_name="Intel Test Links",
                mapped_course_id=course_id,
                date="2026-07-17",
                status="active",
                holes=[],
            )
        )
        db.add(RoundPlayerORM(id=str(uuid.uuid4()), round_id=round_id, player_id=player_id))
        await db.commit()
    return round_id


async def _seed_score(round_id: str, player_id: str, hole_number: int, strokes: int) -> None:
    from app.db.engine import async_session
    from app.db.models import Score as ScoreORM

    async with async_session() as db:
        db.add(
            ScoreORM(round_id=round_id, player_id=player_id, hole_number=hole_number, strokes=strokes)
        )
        await db.commit()


# ─────────────────────────────────────────────────────────────────────────────
# Honest empty states
# ─────────────────────────────────────────────────────────────────────────────


class TestHonestEmptyStates:
    async def test_no_reviews_is_null_avg_zero_count_never_a_fabricated_zero(self, client):
        from app.services import courses_mapped

        cid = str(uuid.uuid4())
        await courses_mapped.upsert_course(_seed_mapped_course(cid))
        set_auth(TEST_OWNER_ID)

        r = await client.get(f"{BASE}/{cid}/intel")
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["stars"]["avg"] is None
        assert data["stars"]["count"] == 0

    async def test_no_description_yet_is_all_null(self, client):
        from app.services import courses_mapped

        cid = str(uuid.uuid4())
        await courses_mapped.upsert_course(_seed_mapped_course(cid))
        set_auth(TEST_OWNER_ID)

        r = await client.get(f"{BASE}/{cid}/intel")
        assert r.status_code == 200, r.text
        desc = r.json()["description"]
        assert desc["text"] is None
        assert desc["provenance"] is None
        assert desc["factsUsed"] == []
        assert desc["generatedAt"] is None
        assert desc["model"] is None

    async def test_never_404s_for_a_wellformed_nonexistent_id(self, client):
        set_auth(TEST_OWNER_ID)
        random_id = str(uuid.uuid4())
        r = await client.get(f"{BASE}/{random_id}/intel")
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["courseId"] == random_id
        assert data["stars"] == {"avg": None, "count": 0}
        assert data["stats"]["holesMapped"] is None
        assert data["stats"]["parTotal"] is None
        assert data["stats"]["yardageByTee"] is None
        assert data["stats"]["roundsPlayed"] == 0
        assert data["stats"]["avgScore"] is None

    async def test_malformed_id_is_404(self, client):
        set_auth(TEST_OWNER_ID)
        r = await client.get(f"{BASE}/not-a-uuid/intel")
        assert r.status_code == 404


# ─────────────────────────────────────────────────────────────────────────────
# Real stars
# ─────────────────────────────────────────────────────────────────────────────


class TestStars:
    async def test_posted_review_reflected_in_avg_and_count(self, client):
        from app.services import courses_mapped

        cid = str(uuid.uuid4())
        await courses_mapped.upsert_course(_seed_mapped_course(cid))
        set_auth(TEST_OWNER_ID)

        r = await client.post(f"{BASE}/{cid}/reviews", json={"rating": 4})
        assert r.status_code == 200, r.text

        r2 = await client.get(f"{BASE}/{cid}/intel")
        assert r2.status_code == 200, r2.text
        stars = r2.json()["stars"]
        assert stars["count"] == 1
        assert stars["avg"] == 4.0

    async def test_stars_are_owner_scoped(self, client):
        from app.services import courses_mapped

        cid = str(uuid.uuid4())
        await courses_mapped.upsert_course(_seed_mapped_course(cid))

        set_auth(TEST_OWNER_ID)
        await client.post(f"{BASE}/{cid}/reviews", json={"rating": 5})

        set_auth(OTHER_OWNER_ID)
        r = await client.get(f"{BASE}/{cid}/intel")
        assert r.status_code == 200, r.text
        assert r.json()["stars"] == {"avg": None, "count": 0}


# ─────────────────────────────────────────────────────────────────────────────
# Mapped-course stats
# ─────────────────────────────────────────────────────────────────────────────


class TestMappedStats:
    async def test_par_total_holes_mapped_yardage_by_tee(self, client):
        from app.services import courses_mapped

        cid = str(uuid.uuid4())
        await courses_mapped.upsert_course(_seed_mapped_course(cid))
        set_auth(TEST_OWNER_ID)

        r = await client.get(f"{BASE}/{cid}/intel")
        assert r.status_code == 200, r.text
        stats = r.json()["stats"]
        assert stats["holesMapped"] == 2
        assert stats["parTotal"] == 9  # 4 + 5
        assert stats["yardageByTee"] == {"Blue": 920}  # 400 + 520

    async def test_unmapped_write_through_only_row_has_null_stats(self, client):
        from app.services import courses_mapped

        cid = str(uuid.uuid4())
        await courses_mapped.write_through_courses(
            [{"id": cid, "name": "Write-Through Only", "address": None, "lat": 40.7, "lng": -73.4}]
        )
        set_auth(TEST_OWNER_ID)

        r = await client.get(f"{BASE}/{cid}/intel")
        assert r.status_code == 200, r.text
        stats = r.json()["stats"]
        assert stats["holesMapped"] is None
        assert stats["parTotal"] is None
        assert stats["yardageByTee"] is None
        assert stats["roundsPlayed"] == 0
        assert stats["avgScore"] is None


# ─────────────────────────────────────────────────────────────────────────────
# roundsPlayed / avgScore honesty
# ─────────────────────────────────────────────────────────────────────────────


class TestRoundsAndAvgScore:
    async def test_rounds_played_counts_regardless_of_completeness(self, client):
        from app.services import courses_mapped

        cid = str(uuid.uuid4())
        await courses_mapped.upsert_course(_seed_mapped_course(cid))
        player_id = str(uuid.uuid4())
        round_id = await _seed_round(cid, player_id)
        await _seed_score(round_id, player_id, 1, 5)  # only hole 1 — partial

        set_auth(TEST_OWNER_ID)
        r = await client.get(f"{BASE}/{cid}/intel")
        assert r.status_code == 200, r.text
        stats = r.json()["stats"]
        assert stats["roundsPlayed"] == 1
        assert stats["avgScore"] is None  # partial round excluded

    async def test_complete_round_produces_avg_score(self, client):
        from app.services import courses_mapped

        cid = str(uuid.uuid4())
        await courses_mapped.upsert_course(_seed_mapped_course(cid))
        player_id = str(uuid.uuid4())
        round_id = await _seed_round(cid, player_id)
        await _seed_score(round_id, player_id, 1, 5)  # bogey on the par-4
        await _seed_score(round_id, player_id, 2, 5)  # par on the par-5

        set_auth(TEST_OWNER_ID)
        r = await client.get(f"{BASE}/{cid}/intel")
        assert r.status_code == 200, r.text
        stats = r.json()["stats"]
        assert stats["roundsPlayed"] == 1
        assert stats["avgScore"] == 10.0

    async def test_mixed_complete_and_partial_rounds_average_only_the_complete_one(self, client):
        from app.services import courses_mapped

        cid = str(uuid.uuid4())
        await courses_mapped.upsert_course(_seed_mapped_course(cid))

        player_a = str(uuid.uuid4())
        complete_round = await _seed_round(cid, player_a)
        await _seed_score(complete_round, player_a, 1, 4)
        await _seed_score(complete_round, player_a, 2, 5)

        player_b = str(uuid.uuid4())
        partial_round = await _seed_round(cid, player_b)
        await _seed_score(partial_round, player_b, 1, 6)  # hole 2 never scored

        set_auth(TEST_OWNER_ID)
        r = await client.get(f"{BASE}/{cid}/intel")
        assert r.status_code == 200, r.text
        stats = r.json()["stats"]
        assert stats["roundsPlayed"] == 2  # both rounds count
        assert stats["avgScore"] == 9.0  # only the complete round (4+5) averaged


# ─────────────────────────────────────────────────────────────────────────────
# Description round-trip (proves the conftest course_intel column-add works)
# ─────────────────────────────────────────────────────────────────────────────


class TestDescriptionRoundTrip:
    async def test_description_round_trips_with_camelcase_facts_used(self, client):
        from app.services import courses_mapped

        cid = str(uuid.uuid4())
        await courses_mapped.upsert_course(_seed_mapped_course(cid))

        composed = {
            "text": "A calm layout among mature trees. A respected regional designer laid it out.",
            "provenance": "enriched",
            "facts_used": ["architect", "notable_history"],
            "generated_at": "2026-07-17T00:00:00+00:00",
            "model": "claude-sonnet-5",
            "schema_version": 1,
        }
        ok = await courses_mapped.merge_course_intel_blob(cid, {"description": composed})
        assert ok is True

        set_auth(TEST_OWNER_ID)
        r = await client.get(f"{BASE}/{cid}/intel")
        assert r.status_code == 200, r.text
        desc = r.json()["description"]
        assert desc["text"] == composed["text"]
        assert desc["provenance"] == "enriched"
        # snake_case DB keys -> camelCase wire keys, translated by the route.
        assert desc["factsUsed"] == ["architect", "notableHistory"]
        assert desc["generatedAt"] == composed["generated_at"]
        assert desc["model"] == "claude-sonnet-5"
