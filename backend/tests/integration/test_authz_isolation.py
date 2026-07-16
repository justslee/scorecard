"""P0 slice 1 authz-isolation acceptance suite.

specs/multiuser-p0-authz-flip-slice1.md §4 — the acceptance bar for
`require_member`. Real Postgres required (skipped without one — see
conftest._db; CI provides the Postgres service). Covers:

  0. Router wiring          — structural: every data route carries
                               require_member, or the documented require_owner
                               carve-out. No HTTP, no DB semantics — pure
                               introspection of app.routes.
  1. Per-router isolation   — open mode, gate=False (identity injected, row-
                               scoping is what's actually under test): create
                               as A, prove B can't read/list/write/delete it.
  2. 404-not-403 enumeration — B's cross-tenant response is byte-identical
                               (status + body) to a genuinely nonexistent id.
  3. Flip-regression         — gate=True (the REAL require_member/require_owner
                               execute): owner mode freezes today's contract
                               (non-owner 403, owner passes); open mode admits
                               both, row-scoping still isolates them.
  4. Carve-out negatives     — even in open mode, courses_mapped writes,
                               request_availability_call, and caller-voice/
                               rehearsal stay owner-only.

gate=False vs gate=True is set_auth's own contract (see conftest.py's
docstring) — gate=False bypasses require_member/require_owner entirely via
dependency_overrides (today's belt-and-suspenders posture, used for the row-
scoping suite); gate=True overrides ONLY current_user_id and lets the real
gate dependencies run against monkeypatched APP_ACCESS_MODE/OWNER_CLERK_USER_ID.
"""

from __future__ import annotations

import pytest

from app.services import clerk_auth
from app.services.clerk_auth import require_member, require_owner
from .conftest import TEST_OWNER_ID, OTHER_OWNER_ID, set_auth

A = TEST_OWNER_ID
B = OTHER_OWNER_ID
_RANDOM_ID = "00000000-0000-0000-0000-000000000000"

_PLAYER_ID = "aaaaaaaa-0000-0000-0000-000000000099"
_MINIMAL_ROUND = {
    "courseId": "authz-course-001",
    "courseName": "Authz Links",
    "players": [{"id": _PLAYER_ID, "name": "Authz Golfer"}],
    "holes": [{"number": i, "par": 4} for i in range(1, 10)],
    "games": [],
}

_VOICE_BOOKING_ENV_VARS = (
    "VOICE_BOOKING_ENABLED", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN",
    "TWILIO_FROM_NUMBER", "VOICE_BOOKING_PUBLIC_HOST",
    "VOICE_BOOKING_VERIFIED_LINES", "VOICE_BOOKING_OWNER_NAME",
    "VOICE_BOOKING_OWNER_NUMBER",
)


def _clear_voice_booking_env(monkeypatch) -> None:
    """Force the dark-by-default posture regardless of ambient CI/local env —
    same list test_availability_call_route.py clears."""
    for var in _VOICE_BOOKING_ENV_VARS:
        monkeypatch.delenv(var, raising=False)


def _set_owner(monkeypatch, owner_id: str) -> None:
    """Set OWNER_CLERK_USER_ID for BOTH gate dependencies:
      - require_member reads it dynamically via _owner_id() (os.getenv at call
        time) — monkeypatch.setenv alone is enough for that one.
      - require_owner reads the FROZEN module-level constant
        clerk_auth.OWNER_CLERK_USER_ID, bound once at import time — setenv
        alone does NOT affect it.
    gate=True tests exercise require_owner directly (every carve-out
    dependency, and require_owner is also what require_member's byte-
    identical owner-mode path itself piggybacks the *concept* of, though not
    the constant) — so any test that needs the REAL gate to actually reject a
    non-owner must go through this helper, not a bare setenv."""
    monkeypatch.setenv("OWNER_CLERK_USER_ID", owner_id)
    monkeypatch.setattr(clerk_auth, "OWNER_CLERK_USER_ID", owner_id)


# ── Shared creation helpers (used by both the isolation suite and the
#    enumeration-property parametrized class) ────────────────────────────────


async def _create_round(client) -> str:
    r = await client.post("/api/rounds", json=_MINIMAL_ROUND)
    assert r.status_code == 200, f"round create failed: {r.text}"
    return r.json()["id"]


async def _create_tournament(client) -> str:
    r = await client.post("/api/tournaments", json={"name": "Isolation Cup"})
    assert r.status_code == 200, f"tournament create failed: {r.text}"
    return r.json()["id"]


async def _create_player(client) -> str:
    r = await client.post("/api/players", json={"name": "Iso Player"})
    assert r.status_code == 200, f"player create failed: {r.text}"
    return r.json()["id"]


async def _create_scoring_course(client) -> str:
    r = await client.post(
        "/api/courses",
        json={"name": "Iso Links", "holes": [{"number": i, "par": 4} for i in range(1, 10)]},
    )
    assert r.status_code == 200, f"course create failed: {r.text}"
    return r.json()["id"]


# ─────────────────────────────────────────────────────────────────────────────
# 0. Router wiring — structural, no HTTP
# ─────────────────────────────────────────────────────────────────────────────


def _all_dependant_calls(dependant) -> set:
    calls = {d.call for d in dependant.dependencies}
    for sub in dependant.dependencies:
        calls |= _all_dependant_calls(sub)
    return calls


class TestRouterWiring:
    """Introspects app.routes directly (no HTTP, no auth needed) — proves
    every data route carries require_member (member-reachable) or the
    documented require_owner carve-out, and that health/root/config-status
    are the ONLY unauthenticated exceptions. Placed in tests/integration/ (so
    it self-skips locally without Postgres, per conftest's autouse _db) purely
    for co-location with the rest of this acceptance suite — it makes zero DB
    calls itself."""

    _OPEN_PATHS = {"/health", "/", "/api/config-status"}
    # The documented carve-outs (multiuser-p0-authz-flip-slice1.md §2): these
    # routes ALSO carry require_member (router-level, applied uniformly) but
    # additionally require require_owner — that's the actual guard once
    # APP_ACCESS_MODE=open.
    _OWNER_CARVE_OUTS = {
        ("POST", "/api/courses/mapped"),
        ("PUT", "/api/courses/mapped/{course_id}"),
        ("DELETE", "/api/courses/mapped/{course_id}"),
        ("POST", "/api/tee-times/availability-call"),
        ("POST", "/api/tee-times/rehearsal-call"),
        ("GET", "/api/tee-times/caller-voice"),
        ("PUT", "/api/tee-times/caller-voice"),
    }

    async def test_every_data_route_is_member_or_owner_gated(self, client):
        from app.main import app

        missing: list[str] = []
        seen_carve_outs: set[tuple[str, str]] = set()

        for route in app.routes:
            path = getattr(route, "path", None)
            if path is None or path in self._OPEN_PATHS:
                continue
            if "voice-booking" in path:
                continue  # deliberately ungated WS — see main.py's comment
            dependant = getattr(route, "dependant", None)
            methods = getattr(route, "methods", None) or set()
            if dependant is None:
                continue
            calls = _all_dependant_calls(dependant)
            for method in methods:
                if method == "HEAD":
                    continue
                key = (method, path)
                if key in self._OWNER_CARVE_OUTS:
                    seen_carve_outs.add(key)
                    if require_owner not in calls:
                        missing.append(f"{method} {path}: expected require_owner carve-out")
                    continue
                if require_member not in calls:
                    missing.append(f"{method} {path}: missing require_member")

        assert missing == [], "\n".join(missing)
        # Every documented carve-out must correspond to a REAL registered
        # route — a stale entry here would silently stop proving anything.
        assert seen_carve_outs == self._OWNER_CARVE_OUTS, (
            f"carve-out list is stale: expected {self._OWNER_CARVE_OUTS}, "
            f"found {seen_carve_outs}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 1. Per-router isolation — open mode, gate=False (row-scoping under test)
# ─────────────────────────────────────────────────────────────────────────────


class TestRoundsIsolation:
    async def test_get_list_put_delete_isolated(self, client, monkeypatch):
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        set_auth(A)
        round_id = await _create_round(client)

        set_auth(B)
        assert (await client.get(f"/api/rounds/{round_id}")).status_code == 404
        assert (await client.get("/api/rounds")).json() == []
        assert (await client.put(
            f"/api/rounds/{round_id}", json={"status": "completed"}
        )).status_code == 404
        assert (await client.delete(f"/api/rounds/{round_id}")).status_code == 404

        set_auth(A)
        r = await client.get(f"/api/rounds/{round_id}")
        assert r.status_code == 200
        assert r.json()["status"] == "active", "B's failed PUT must not have touched A's round"


class TestTournamentsIsolation:
    async def test_get_list_put_delete_isolated(self, client, monkeypatch):
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        set_auth(A)
        tid = await _create_tournament(client)

        set_auth(B)
        assert (await client.get(f"/api/tournaments/{tid}")).status_code == 404
        assert (await client.get("/api/tournaments")).json() == []
        assert (await client.put(
            f"/api/tournaments/{tid}", json={"name": "Hijacked"}
        )).status_code == 404
        assert (await client.delete(f"/api/tournaments/{tid}")).status_code == 404

        set_auth(A)
        r = await client.get(f"/api/tournaments/{tid}")
        assert r.status_code == 200
        assert r.json()["name"] == "Isolation Cup"


class TestPlayersIsolation:
    async def test_get_list_put_delete_isolated(self, client, monkeypatch):
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        set_auth(A)
        pid = await _create_player(client)

        set_auth(B)
        assert (await client.get(f"/api/players/{pid}")).status_code == 404
        assert (await client.get("/api/players")).json() == []
        assert (await client.put(
            f"/api/players/{pid}", json={"name": "Hijacked"}
        )).status_code == 404
        assert (await client.delete(f"/api/players/{pid}")).status_code == 404

        set_auth(A)
        r = await client.get(f"/api/players/{pid}")
        assert r.status_code == 200
        assert r.json()["name"] == "Iso Player"


class TestScoringCoursesIsolation:
    """courses.py — no PUT route, so this covers GET/list/DELETE only."""

    async def test_get_list_delete_isolated(self, client, monkeypatch):
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        set_auth(A)
        cid = await _create_scoring_course(client)

        set_auth(B)
        assert (await client.get(f"/api/courses/{cid}")).status_code == 404
        assert (await client.get("/api/courses")).json() == []
        assert (await client.delete(f"/api/courses/{cid}")).status_code == 404

        set_auth(A)
        assert (await client.get(f"/api/courses/{cid}")).status_code == 200


class TestProfileIsolation:
    """profile.py is keyed by user_id (no {id} path param) — isolation means
    B's own profile is unaffected by A's writes; there's no id-keyed 404/
    enumeration surface here to test."""

    async def test_upsert_is_scoped_to_the_caller(self, client, monkeypatch):
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        set_auth(A)
        r = await client.put("/api/profile/golfer", json={"name": "Owner A"})
        assert r.status_code == 200, r.text

        set_auth(B)
        r2 = await client.get("/api/profile/golfer")
        assert r2.status_code == 204, "B must not see A's profile"


class TestCourseReviewsIsolation:
    """course_reviews.py has no {id}-keyed GET/PUT/DELETE — only POST create
    and two list surfaces, both owner-scoped. Isolation = B's lists never
    contain A's review."""

    async def test_lists_are_scoped_to_the_caller(self, client, monkeypatch):
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        set_auth(A)
        r = await client.post(
            "/api/courses/authz-course-key/reviews",
            json={"rating": 5, "body": "great track"},
        )
        assert r.status_code == 200, r.text

        set_auth(B)
        r_list = await client.get("/api/courses/authz-course-key/reviews")
        assert r_list.json() == [], "B must not see A's review for the same course_key"
        r_mine = await client.get("/api/reviews/mine")
        assert r_mine.json() == [], "B's /mine must not include A's review"


class TestShotsIsolation:
    async def test_round_scoped_read_and_delete_are_isolated(self, client, monkeypatch):
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        round_id = "authz-shots-round-001"
        set_auth(A)
        await client.post("/api/caddie/session/start", json={"round_id": round_id})
        r = await client.post("/api/shots", json={
            "round_id": round_id, "hole_number": 1, "club": "7i", "result": "green",
        })
        assert r.status_code == 200, r.text
        shot_id = r.json()["id"]

        set_auth(B)
        # get_owned_session rejects a round_id it never started -> 404.
        assert (await client.get(f"/api/shots/round/{round_id}")).status_code == 404
        assert (await client.delete(f"/api/shots/{shot_id}")).status_code == 404

        set_auth(A)
        r2 = await client.get(f"/api/shots/round/{round_id}")
        assert r2.status_code == 200
        assert len(r2.json()) == 1, "B's failed delete must not have touched A's shot"


class TestCaddieSessionsIsolation:
    async def test_session_status_is_isolated(self, client, monkeypatch):
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        round_id = "authz-caddie-round-001"
        set_auth(A)
        await client.post("/api/caddie/session/start", json={"round_id": round_id})

        set_auth(B)
        assert (await client.get(f"/api/caddie/session/{round_id}")).status_code == 404
        r = await client.post("/api/caddie/session/shot", json={
            "round_id": round_id, "hole_number": 1, "club": "driver", "distance_yards": 250,
        })
        assert r.status_code == 404, "IDOR: B must not log a shot into A's session"


class TestCaddieMemoriesIsolation:
    """memory.py's /me is keyed by the caller's identity only — no id route."""

    async def test_memories_are_scoped_to_the_caller(self, client, monkeypatch):
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        set_auth(A)
        r = await client.post(
            "/api/memory/me",
            json={"kind": "preference", "summary": "prefers terse advice"},
        )
        assert r.status_code == 200, r.text

        set_auth(B)
        r2 = await client.get("/api/memory/me")
        summaries = [m["summary"] for m in r2.json()["memories"]]
        assert "prefers terse advice" not in summaries, "B must not see A's memory"


class TestTeeTimeBookingsIsolation:
    """tee_times.py's /bookings is a list-only surface (no {id} route)."""

    async def test_bookings_are_scoped_to_the_caller(self, client, monkeypatch):
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        monkeypatch.setenv("TEETIME_PROVIDER", "mock")
        set_auth(A)
        slot = {
            "id": "authz-mock-slot-1", "courseId": "presidio", "courseName": "Presidio",
            "city": "SF", "date": "2026-08-01", "time": "07:30", "players": 4,
            "priceUsd": 80.0, "cartIncluded": False, "distanceMiles": 1.0,
            "rating": 4.0, "designer": None, "bookingUrl": None, "provider": "mock",
            "holes": 18,
        }
        r = await client.post(
            "/api/tee-times/book", json={"slot": slot, "details": {"name": "A", "partySize": 4}}
        )
        assert r.status_code == 200, r.text

        set_auth(B)
        r2 = await client.get("/api/tee-times/bookings")
        assert r2.json() == [], "B must not see A's booking"


# ─────────────────────────────────────────────────────────────────────────────
# 2. 404-not-403 enumeration property (parametrized)
# ─────────────────────────────────────────────────────────────────────────────

_ID_KEYED_RESOURCES = [
    ("rounds", _create_round, "/api/rounds/{id}"),
    ("tournaments", _create_tournament, "/api/tournaments/{id}"),
    ("players", _create_player, "/api/players/{id}"),
    ("scoring-courses", _create_scoring_course, "/api/courses/{id}"),
]


class TestEnumerationProperty:
    """B's cross-tenant GET must be byte-identical (status AND body) to a GET
    for an id that genuinely doesn't exist — no leak of "this exists but
    isn't yours" via a different status or body shape."""

    @pytest.mark.parametrize("name,create_fn,url_tpl", _ID_KEYED_RESOURCES)
    async def test_cross_tenant_matches_nonexistent(
        self, client, monkeypatch, name, create_fn, url_tpl
    ):
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        set_auth(A)
        owned_id = await create_fn(client)

        set_auth(B)
        r_cross = await client.get(url_tpl.format(id=owned_id))
        r_ghost = await client.get(url_tpl.format(id=_RANDOM_ID))

        assert r_cross.status_code == 404, f"{name}: expected 404, got {r_cross.status_code}"
        assert r_cross.status_code == r_ghost.status_code
        assert r_cross.json() == r_ghost.json(), (
            f"{name}: cross-tenant body must match a genuinely nonexistent id — "
            f"got {r_cross.json()!r} vs {r_ghost.json()!r}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 3. Flip-regression (§3.6.3) — gate=True, the REAL gate dependencies run
# ─────────────────────────────────────────────────────────────────────────────

# A representative, DB-only (no external network) sample spanning most of the
# 17+ member-gated routers. main.py wires the exact SAME `_member =
# [Depends(require_member)]` object to every one of them uniformly (see
# TestRouterWiring above, which proves ALL of them, not just this sample) —
# so this HTTP-level sample is corroborating evidence the wiring actually
# behaves as expected at runtime, not the sole proof of coverage.
_SAMPLE_ROUTES = [
    ("GET", "/api/players"),
    ("GET", "/api/rounds"),
    ("GET", "/api/tournaments"),
    ("GET", "/api/profile/golfer"),
    ("GET", "/api/courses/mapped"),
    ("GET", "/api/reviews/mine"),
    ("GET", "/api/courses"),
    ("GET", "/api/caddie/profile"),
    ("GET", "/api/memory/me"),
    ("GET", "/api/shots/stats"),
    ("GET", "/api/courses/authz-flip-course/pins"),
    ("GET", "/api/tee-times/bookings"),
]


class TestFlipRegression:
    async def test_owner_mode_non_owner_403_owner_passes(self, client, monkeypatch):
        """Freezes today's contract: APP_ACCESS_MODE unset/owner + a configured
        OWNER_CLERK_USER_ID -> everyone else 403s, the owner passes."""
        monkeypatch.delenv("APP_ACCESS_MODE", raising=False)
        _set_owner(monkeypatch, A)

        for method, path in _SAMPLE_ROUTES:
            set_auth(B, gate=True)
            r = await client.request(method, path)
            assert r.status_code == 403, (
                f"{method} {path}: expected 403 for non-owner B, got "
                f"{r.status_code}: {r.text}"
            )

            set_auth(A, gate=True)
            r2 = await client.request(method, path)
            assert r2.status_code != 403, (
                f"{method} {path}: owner A must pass the gate, got 403: {r2.text}"
            )

    async def test_open_mode_both_pass_and_rows_stay_isolated(self, client, monkeypatch):
        """APP_ACCESS_MODE=open -> both A and B pass auth on the same sample;
        row-scoping (not the gate) is what isolates their data."""
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        _set_owner(monkeypatch, A)

        for method, path in _SAMPLE_ROUTES:
            set_auth(A, gate=True)
            ra = await client.request(method, path)
            assert ra.status_code != 403, f"{method} {path}: A must pass in open mode"

            set_auth(B, gate=True)
            rb = await client.request(method, path)
            assert rb.status_code != 403, f"{method} {path}: B must pass in open mode"

        # Prove row isolation holds with the REAL gate active end-to-end (not
        # gate=False's bypassed-dependency belt-and-suspenders posture).
        set_auth(A, gate=True)
        r = await client.post("/api/rounds", json=_MINIMAL_ROUND)
        assert r.status_code == 200, r.text
        round_id = r.json()["id"]

        set_auth(B, gate=True)
        r2 = await client.get(f"/api/rounds/{round_id}")
        assert r2.status_code == 404, (
            "row-scoping must isolate A's round from B even with the real "
            "require_member gate active"
        )


# ─────────────────────────────────────────────────────────────────────────────
# 4. Carve-out negative tests — stay owner-only even in open mode
# ─────────────────────────────────────────────────────────────────────────────


class TestCarveOutsStayOwnerOnly:
    async def test_courses_mapped_writes_refused_for_non_owner_member(self, client, monkeypatch):
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        _set_owner(monkeypatch, A)
        set_auth(B, gate=True)

        # A real UUID — the courses table's id column is uuid-typed (see
        # supabase/migrations/001_course_mapping_schema.sql). A non-UUID id
        # would 500 on the DB cast before auth is even the interesting part
        # of what's under test here (courses_mapped.py now 404s cleanly on
        # that too, but this test is specifically about the auth gate).
        course_id = "11111111-1111-4111-8111-111111111111"
        body = {"id": course_id, "name": "Carve Out Links", "holes": [], "teeSets": []}
        assert (await client.post("/api/courses/mapped", json=body)).status_code in (401, 403)
        assert (await client.put(
            f"/api/courses/mapped/{course_id}", json=body
        )).status_code in (401, 403)
        assert (await client.delete(
            f"/api/courses/mapped/{course_id}"
        )).status_code in (401, 403)

        # Never created — geometry is unchanged.
        set_auth(A, gate=True)
        assert (await client.get(f"/api/courses/mapped/{course_id}")).status_code == 404

    async def test_courses_mapped_writes_reach_handler_for_owner(self, client, monkeypatch):
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        _set_owner(monkeypatch, A)
        set_auth(A, gate=True)
        course_id = "22222222-2222-4222-8222-222222222222"
        body = {"id": course_id, "name": "Owner Links", "holes": [], "teeSets": []}
        r = await client.post("/api/courses/mapped", json=body)
        assert r.status_code != 403, r.text

    async def test_availability_call_refused_for_non_owner_member(self, client, monkeypatch):
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        _set_owner(monkeypatch, A)
        _clear_voice_booking_env(monkeypatch)
        set_auth(B, gate=True)

        r = await client.post("/api/tee-times/availability-call", json={
            "courseId": "c1", "courseName": "Course", "date": "2026-08-01",
            "timeWindowStart": "07:00", "timeWindowEnd": "11:00", "partySize": 2,
        })
        assert r.status_code in (401, 403), r.text

    async def test_availability_call_reaches_handler_for_owner(self, client, monkeypatch):
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        _set_owner(monkeypatch, A)
        _clear_voice_booking_env(monkeypatch)
        set_auth(A, gate=True)

        r = await client.post("/api/tee-times/availability-call", json={
            "courseId": "c1", "courseName": "Course", "date": "2026-08-01",
            "timeWindowStart": "07:00", "timeWindowEnd": "11:00", "partySize": 2,
        })
        assert r.status_code != 403, r.text
        # Ships dark: no Twilio config -> an honest not_enabled, never a 5xx.
        assert r.json()["status"] == "not_enabled"

    async def test_caller_voice_and_rehearsal_refused_for_non_owner_member(
        self, client, monkeypatch
    ):
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        _set_owner(monkeypatch, A)
        _clear_voice_booking_env(monkeypatch)
        set_auth(B, gate=True)

        assert (await client.get("/api/tee-times/caller-voice")).status_code in (401, 403)
        assert (await client.put(
            "/api/tee-times/caller-voice", json={"voice": "verse"}
        )).status_code in (401, 403)
        assert (await client.post("/api/tee-times/rehearsal-call")).status_code in (401, 403)

    async def test_caller_voice_and_rehearsal_reach_handler_for_owner(self, client, monkeypatch):
        monkeypatch.setenv("APP_ACCESS_MODE", "open")
        _set_owner(monkeypatch, A)
        _clear_voice_booking_env(monkeypatch)
        set_auth(A, gate=True)

        r_get = await client.get("/api/tee-times/caller-voice")
        assert r_get.status_code != 403, r_get.text

        r_rehearsal = await client.post("/api/tee-times/rehearsal-call")
        assert r_rehearsal.status_code != 403, r_rehearsal.text
