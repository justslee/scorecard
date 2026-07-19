"""MULTI-USER FLIP-TIME GATE — the owner's named acceptance test,
specs/login-onboarding-redesign-plan.md §4.5.

Proves the server-side hydration seam (specs/onboarding-bag-caddie-grounding-
plan.md §2): two accounts with different bags (7-iron 170 vs 150, one with no
driver) start caddie sessions WITHOUT sending `club_distances` in the request
— the client sends none on purpose, so the ONLY way the session ends up
grounded in the right bag is the server reading `golfer_profiles.bag_clubs`
(written by the real onboarding/profile write path) at `/session/start`.
Every downstream payload — tee-shot recommendation, "what club from 160",
the player profile block — must then bind to THAT account's own bag, never
leak across accounts, and never crash or fabricate "driver" for a bag that
doesn't have one.

Same harness as test_caddie_profile_session.py: real Postgres (skipped
without one — CI provides it via `required-backend`), auth injected via
dependency_overrides, ASGI client (no network).
"""

import json

from .conftest import TEST_OWNER_ID, OTHER_OWNER_ID, set_auth

from app.caddie import tools as caddie_tools
from app.caddie.session import sessions
from app.caddie.types import HoleIntelligence

USER_A = TEST_OWNER_ID       # bomber
USER_B = OTHER_OWNER_ID      # short bag, NO driver (the harder §4.5 variant)
USER_C = "flip-user-c"       # skipped bag entirely

ROUND_A = "flip-round-a"
ROUND_B = "flip-round-b"
ROUND_A_REQUEST_WINS = "flip-round-a-request-wins"
ROUND_C = "flip-round-c"

BAG_A_CAMEL = {  # 7-iron 170 (the spec's number)
    "driver": 300, "threeWood": 270, "hybrid": 240, "fourIron": 220,
    "fiveIron": 205, "sixIron": 190, "sevenIron": 170, "eightIron": 158,
    "nineIron": 145, "pitchingWedge": 132, "gapWedge": 118, "sandWedge": 105,
    "lobWedge": 90,
}
BAG_B_CAMEL = {  # 7-iron 150, NO DRIVER — must not crash, must never hear "driver"
    "threeWood": 200, "fiveWood": 190, "hybrid": 180, "fiveIron": 165,
    "sixIron": 158, "sevenIron": 150, "eightIron": 140, "nineIron": 130,
    "pitchingWedge": 120, "gapWedge": 110, "sandWedge": 95, "lobWedge": 80,
}

# Canonical (post-normalize_club_distances) form of the two bags above —
# proves camelCase GolferProfile keys resolved through the ONE chokepoint.
BAG_A_CANONICAL = {
    "driver": 300, "3wood": 270, "hybrid": 240, "4iron": 220, "5iron": 205,
    "6iron": 190, "7iron": 170, "8iron": 158, "9iron": 145, "pw": 132,
    "gw": 118, "sw": 105, "lw": 90,
}
BAG_B_CANONICAL = {
    "3wood": 200, "5wood": 190, "hybrid": 180, "5iron": 165, "6iron": 158,
    "7iron": 150, "8iron": 140, "9iron": 130, "pw": 120, "gw": 110, "sw": 95,
    "lw": 80,
}

# Bethpage Black hole 1, black tees — card-verified in test_bethpage_validation.py CARD[1].
# No weather cached (still air) + elevation_change_ft defaults to 0.0, so the
# engine solve is fully deterministic for the whole suite.
BETHPAGE_1 = HoleIntelligence(hole_number=1, par=4, yards=430, effective_yards=430)


async def _seed_bag(client, user_id: str, bag_camel: dict) -> None:
    """The REAL write path — same as onboarding Slice 4 / the /profile editor."""
    set_auth(user_id)
    r = await client.put("/api/profile/golfer", json={"clubDistances": bag_camel})
    assert r.status_code == 200, f"seed PUT /api/profile/golfer failed: {r.text}"


async def _start_session_no_bag(client, user_id: str, round_id: str) -> dict:
    """Start a session WITHOUT client club_distances — the deliberate omission
    that proves server-side hydration (client sends none on purpose)."""
    set_auth(user_id)
    r = await client.post("/api/caddie/session/start", json={"round_id": round_id})
    assert r.status_code == 200, f"session/start failed: {r.text}"
    return r.json()


# ─────────────────────────────────────────────────────────────────────────────
# 1. Session start hydrates each user's stored bag, per user
# ─────────────────────────────────────────────────────────────────────────────


class TestSessionStartHydratesStoredBag:
    async def test_session_start_hydrates_stored_bag_per_user(self, client):
        await _seed_bag(client, USER_A, BAG_A_CAMEL)
        await _seed_bag(client, USER_B, BAG_B_CAMEL)

        resp_a = await _start_session_no_bag(client, USER_A, ROUND_A)
        assert resp_a["bag_source"] == "profile"
        resp_b = await _start_session_no_bag(client, USER_B, ROUND_B)
        assert resp_b["bag_source"] == "profile"

        session_a = await sessions.get(ROUND_A)
        session_b = await sessions.get(ROUND_B)
        assert session_a.club_distances == BAG_A_CANONICAL
        assert session_b.club_distances == BAG_B_CANONICAL
        assert "driver" not in session_b.club_distances, (
            "B's bag has no driver — the server must not invent one"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 2. The spec's verbatim scenario — the 160-yard ask
# ─────────────────────────────────────────────────────────────────────────────


class Test160YardAskPayloadsDifferAndBindToOwnBag:
    async def test_160_yard_ask_payloads_differ_and_bind_to_own_bag(self, client):
        await _seed_bag(client, USER_A, BAG_A_CAMEL)
        await _seed_bag(client, USER_B, BAG_B_CAMEL)
        await _start_session_no_bag(client, USER_A, ROUND_A)
        await _start_session_no_bag(client, USER_B, ROUND_B)

        session_a = await sessions.get(ROUND_A)
        session_b = await sessions.get(ROUND_B)

        p_a = caddie_tools.shot_distance_payload(session_a, hole_number=1, target_yards=160)
        p_b = caddie_tools.shot_distance_payload(session_b, hole_number=1, target_yards=160)

        assert p_a["available"] is True
        assert p_b["available"] is True
        assert p_a["suggested_club"] in session_a.club_distances
        assert p_b["suggested_club"] in session_b.club_distances
        assert p_a["suggested_club"] != p_b["suggested_club"]
        # Pinned literal — the still-air solve at 160y with each bag's near-160
        # club (A: 8iron/158y, B: 6iron/158y) is deterministic.
        assert p_a["suggested_club"] == "8iron"
        assert p_b["suggested_club"] == "6iron"

        profile_a = await caddie_tools.player_profile_payload(session_a, USER_A)
        profile_b = await caddie_tools.player_profile_payload(session_b, USER_B)
        assert profile_a["club_distances"]["7 Iron"] == 170
        assert profile_b["club_distances"]["7 Iron"] == 150
        assert profile_a["club_distances"]["Driver"] == 300
        assert "Driver" not in profile_b["club_distances"]


# ─────────────────────────────────────────────────────────────────────────────
# 3. Tee-shot recommendation differs; the no-driver bag never hears "driver"
# ─────────────────────────────────────────────────────────────────────────────


class TestTeeRecoDiffersAndNoDriverBagNeverHearsDriver:
    async def test_tee_reco_differs_and_no_driver_bag_never_hears_driver(self, client):
        await _seed_bag(client, USER_A, BAG_A_CAMEL)
        await _seed_bag(client, USER_B, BAG_B_CAMEL)
        await _start_session_no_bag(client, USER_A, ROUND_A)
        await _start_session_no_bag(client, USER_B, ROUND_B)
        await sessions.set_hole_intel(ROUND_A, {1: BETHPAGE_1})
        await sessions.set_hole_intel(ROUND_B, {1: BETHPAGE_1})

        session_a = await sessions.get(ROUND_A)
        session_b = await sessions.get(ROUND_B)

        ra = await caddie_tools.recommend_payload(session_a, ROUND_A, 1, yards=430)
        assert "error" not in ra
        assert ra["club"] == "driver"
        assert ra["tee_shot_numbers"]["club_stored_yards"] == 300
        assert (
            ra["tee_shot_numbers"]["leave_exact_yards"]
            == 430 - ra["tee_shot_numbers"]["drive_total_yards"]
        )

        rb = await caddie_tools.recommend_payload(session_b, ROUND_B, 1, yards=430)
        assert "error" not in rb, "a no-driver bag must never crash the tee recommendation"
        assert rb["club"] == "3wood", "B's longest club is 3wood"
        assert rb["club"] != "driver"
        assert rb["tee_shot_numbers"]["club_stored_yards"] == 200
        assert "driver" not in json.dumps(rb).lower()

        assert ra["club"] != rb["club"]


# ─────────────────────────────────────────────────────────────────────────────
# 4. Multi-user isolation — bags never cross-leak
# ─────────────────────────────────────────────────────────────────────────────


class TestBagsNeverCrossLeak:
    async def test_bags_never_cross_leak(self, client):
        await _seed_bag(client, USER_A, BAG_A_CAMEL)
        await _seed_bag(client, USER_B, BAG_B_CAMEL)
        await _start_session_no_bag(client, USER_A, ROUND_A)
        await _start_session_no_bag(client, USER_B, ROUND_B)
        await sessions.set_hole_intel(ROUND_A, {1: BETHPAGE_1})
        await sessions.set_hole_intel(ROUND_B, {1: BETHPAGE_1})

        session_a = await sessions.get(ROUND_A)
        session_b = await sessions.get(ROUND_B)

        # Interleaved: seed A, seed B (done above), assemble A first.
        ra = await caddie_tools.recommend_payload(session_a, ROUND_A, 1, yards=430)
        assert "error" not in ra
        rb = await caddie_tools.recommend_payload(session_b, ROUND_B, 1, yards=430)

        # A's session bag must still be exactly A's normalized bag after B's
        # session was started and assembled.
        reread_a = await sessions.get(ROUND_A)
        assert reread_a.club_distances == BAG_A_CANONICAL

        assert "300" not in json.dumps(rb), "B's payload must not carry A's driver yardage"

        profile_a = await caddie_tools.player_profile_payload(session_a, USER_A)
        profile_b = await caddie_tools.player_profile_payload(session_b, USER_B)

        # B's distinctive values must not appear in A's profile payload...
        assert profile_a["club_distances"].get("7 Iron") != 150
        # ...and A's distinctive values must not appear in B's.
        assert profile_b["club_distances"].get("7 Iron") != 170
        assert profile_b["club_distances"].get("Driver") != 300
        assert "Driver" not in profile_b["club_distances"]
        for distinctive in (300, 270, 170):
            assert distinctive not in profile_b["club_distances"].values(), (
                f"A's distinctive value {distinctive} leaked into B's profile payload"
            )
        assert 150 not in profile_a["club_distances"].values(), (
            "B's distinctive 7-iron value leaked into A's profile payload"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 5. Owner's-path regression guard — explicit request bag still wins
# ─────────────────────────────────────────────────────────────────────────────


class TestExplicitRequestBagStillWins:
    async def test_explicit_request_bag_still_wins(self, client):
        await _seed_bag(client, USER_A, BAG_A_CAMEL)

        set_auth(USER_A)
        r = await client.post("/api/caddie/session/start", json={
            "round_id": ROUND_A_REQUEST_WINS,
            "club_distances": {"7i": 172},
        })
        assert r.status_code == 200, r.text
        assert r.json()["bag_source"] == "request"

        session = await sessions.get(ROUND_A_REQUEST_WINS)
        assert session.club_distances == {"7iron": 172}, (
            "an explicit request bag must beat the stored 170 profile bag"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 6. Skipped-bag path — honest defaults, never a crash
# ─────────────────────────────────────────────────────────────────────────────


class TestSkippedBagDefaults:
    async def test_skipped_bag_defaults_honestly_no_crash(self, client):
        await _seed_bag(client, USER_C, {})

        resp = await _start_session_no_bag(client, USER_C, ROUND_C)
        assert resp["bag_source"] == "none"

        session = await sessions.get(ROUND_C)
        assert session.club_distances == {}

        await sessions.set_hole_intel(ROUND_C, {1: BETHPAGE_1})
        session = await sessions.get(ROUND_C)

        rec = await caddie_tools.recommend_payload(session, ROUND_C, 1, yards=430)
        assert "error" not in rec, "a bagless golfer must still get a recommendation"
        from app.caddie.club_selection import DEFAULT_CLUB_DISTANCES
        assert rec["club"] in DEFAULT_CLUB_DISTANCES

        shot = caddie_tools.shot_distance_payload(session, hole_number=1, target_yards=160)
        assert shot["available"] is False
        assert shot["reason"] == "No club distances on file — plays-like needs at least one."
