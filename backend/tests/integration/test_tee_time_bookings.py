"""Integration tests for tee-time booking persistence + search cache (S0).

Covers:
  1. POST /book persists the attempt (mock provider → confirmed row)
  2. needs_human attempts (routing provider) are persisted too
  3. GET /bookings is owner-scoped (cross-user isolation) + newest first
  4. Auth fails-closed on /book and /bookings
  5. Routing slots serialize honestly (route present, time="", estimated=False,
     priceUsd=null, no "Held" anywhere in the payload)
  6. /search TTL cache: second identical query returns cached=true
"""

from app.services.rate_limit import SlidingWindowLimiter
from app.services.tee_times.foreup import CircuitBreaker, ForeUpProvider
from app.services.tee_times.router_provider import RoutedTeeTimeProvider
from app.services.tee_times.routing import RoutingTeeTimeProvider
from app.services.tee_times.search_cache import FileSearchCacheStore

from .conftest import TEST_OWNER_ID, OTHER_OWNER_ID, set_auth
from ..test_tee_time_foreup import FIXTURE_DATE, FakeCacheStore, _cap, _fixture_transport

BASE = "/api/tee-times"

_MOCK_SLOT = {
    "id": "presidio-2026-07-04-07:36-1",
    "courseId": "presidio",
    "courseName": "Presidio Golf Course",
    "city": "San Francisco, CA",
    "date": "2026-07-04",
    "time": "07:36",
    "players": 4,
    "priceUsd": 86.5,
    "cartIncluded": False,
    "distanceMiles": 4.1,
    "rating": 4.3,
    "designer": "Robert Trent Jones Jr.",
    "bookingUrl": None,
    "provider": "mock",
    "holes": 18,
}

_ROUTING_SLOT = {
    **_MOCK_SLOT,
    "id": "gplaces-abc-2026-07-04-route",
    "courseId": "gplaces-abc",
    "time": "",
    "priceUsd": None,
    "bookingUrl": "https://www.presidiogolf.com/",
    "provider": "routing",
    "estimated": False,
    "route": "book_on_site",
}

_DETAILS = {"name": "Owner", "partySize": 4}


def _routing_courses():
    async def find(_query):
        return [
            {
                "id": "gplaces-abc",
                "name": "Presidio Golf Course",
                "address": "San Francisco, CA",
                "center": {"lat": 37.7936, "lng": -122.4636},
                "website": "https://www.presidiogolf.com/",
                "rating": 4.3,
            },
        ], (37.7936, -122.4636)
    return find


def _use_routing(monkeypatch) -> None:
    """Route uses a RoutingTeeTimeProvider with an injected (offline) finder."""
    from app.routes import tee_times as route_mod

    monkeypatch.setattr(
        route_mod, "_get_provider",
        lambda: RoutingTeeTimeProvider(find_courses=_routing_courses()),
    )


def _isolate_cache(monkeypatch, tmp_path) -> None:
    """Point the route's search cache at a tmp file (never backend/data)."""
    from app.routes import tee_times as route_mod

    monkeypatch.setattr(
        route_mod, "_search_cache", FileSearchCacheStore(path=tmp_path / "cache.json")
    )


# ─────────────────────────────────────────────────────────────────────────────
# 1 + 3. Booking persistence + owner-scoped list
# ─────────────────────────────────────────────────────────────────────────────


class TestBookingPersistence:
    async def test_confirmed_booking_is_persisted(self, client, monkeypatch):
        # Pin the mock provider: this test asserts MOCK booking semantics
        # (confirmed + mock confirmation number); the product default flipped
        # to affiliate on 2026-07-02.
        monkeypatch.setenv("TEETIME_PROVIDER", "mock")
        set_auth(TEST_OWNER_ID)
        r = await client.post(f"{BASE}/book", json={"slot": _MOCK_SLOT, "details": _DETAILS})
        assert r.status_code == 200, r.text
        assert r.json()["result"]["status"] == "confirmed"

        r2 = await client.get(f"{BASE}/bookings")
        assert r2.status_code == 200, r2.text
        items = r2.json()
        assert len(items) == 1
        b = items[0]
        assert b["ownerId"] == TEST_OWNER_ID
        assert b["slotId"] == _MOCK_SLOT["id"]
        assert b["courseId"] == "presidio"
        assert b["courseName"] == "Presidio Golf Course"
        assert b["date"] == "2026-07-04"
        assert b["time"] == "07:36"
        assert b["partySize"] == 4
        assert b["priceUsd"] == 86.5
        assert b["status"] == "confirmed"
        assert b["provider"] == "mock"
        assert b["confirmationCode"], "mock booking must persist its confirmation"
        assert "createdAt" in b and "id" in b

    async def test_needs_human_attempt_is_persisted(self, client, monkeypatch):
        _use_routing(monkeypatch)
        set_auth(TEST_OWNER_ID)
        r = await client.post(
            f"{BASE}/book", json={"slot": _ROUTING_SLOT, "details": _DETAILS}
        )
        assert r.status_code == 200, r.text
        result = r.json()["result"]
        assert result["status"] == "needs_human"
        assert result["bookingUrl"] == "https://www.presidiogolf.com/"

        r2 = await client.get(f"{BASE}/bookings")
        items = r2.json()
        assert len(items) == 1
        assert items[0]["status"] == "needs_human"
        assert items[0]["priceUsd"] is None
        assert items[0]["bookingUrl"] == "https://www.presidiogolf.com/"
        assert items[0]["confirmationCode"] is None
        assert items[0]["provider"] == "routing"

    async def test_bookings_cross_user_isolation(self, client):
        set_auth(TEST_OWNER_ID)
        await client.post(f"{BASE}/book", json={"slot": _MOCK_SLOT, "details": _DETAILS})

        set_auth(OTHER_OWNER_ID)
        r = await client.get(f"{BASE}/bookings")
        assert r.status_code == 200, r.text
        assert r.json() == [], f"owner B must not see owner A's bookings, got {r.json()}"

    async def test_bookings_newest_first(self, client):
        set_auth(TEST_OWNER_ID)
        await client.post(f"{BASE}/book", json={"slot": _MOCK_SLOT, "details": _DETAILS})
        second = {**_MOCK_SLOT, "id": "harding-2026-07-04-08:00-0", "courseId": "harding"}
        await client.post(f"{BASE}/book", json={"slot": second, "details": _DETAILS})

        r = await client.get(f"{BASE}/bookings")
        items = r.json()
        assert len(items) == 2
        created = [it["createdAt"] for it in items]
        assert created == sorted(created, reverse=True)

    async def test_invalid_slot_is_422_and_not_persisted(self, client):
        set_auth(TEST_OWNER_ID)
        r = await client.post(f"{BASE}/book", json={"slot": {"id": "x"}, "details": _DETAILS})
        assert r.status_code == 422
        r2 = await client.get(f"{BASE}/bookings")
        assert r2.json() == []


# ─────────────────────────────────────────────────────────────────────────────
# 4. Auth fails-closed
# ─────────────────────────────────────────────────────────────────────────────


class TestAuthFailsClosed:
    async def test_book_without_auth(self, client):
        r = await client.post(f"{BASE}/book", json={"slot": _MOCK_SLOT, "details": _DETAILS})
        assert r.status_code in (401, 503), f"expected fail-closed, got {r.status_code}"

    async def test_bookings_without_auth(self, client):
        r = await client.get(f"{BASE}/bookings")
        assert r.status_code in (401, 503), f"expected fail-closed, got {r.status_code}"


# ─────────────────────────────────────────────────────────────────────────────
# 5. Routing slots serialize honestly
# ─────────────────────────────────────────────────────────────────────────────


class TestRoutingSlotSerialization:
    async def test_search_returns_routing_slots_with_honest_shape(
        self, client, monkeypatch, tmp_path
    ):
        _use_routing(monkeypatch)
        _isolate_cache(monkeypatch, tmp_path)
        set_auth(TEST_OWNER_ID)
        r = await client.get(
            f"{BASE}/search",
            params={
                "date": "2026-07-04",
                "timeWindowStart": "07:00",
                "timeWindowEnd": "10:00",
                "partySize": 4,
                "area": "37.7936,-122.4636",
            },
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["provider"] == "routing"
        assert len(data["results"]) == 1
        slot = data["results"][0]
        assert slot["route"] == "book_on_site"
        assert slot["time"] == ""
        assert slot["estimated"] is False
        assert slot["priceUsd"] is None
        assert slot["bookingUrl"] == "https://www.presidiogolf.com/"
        assert slot["courseName"] == "Presidio Golf Course"
        assert "Held" not in r.text, "no fabricated-slot 'Held' framing anywhere in the payload"

    async def test_mock_slots_are_not_estimated(self, client, monkeypatch, tmp_path):
        # Pin the mock provider (product default is affiliate since 2026-07-02);
        # this test asserts the MOCK catalogue's slot shape.
        monkeypatch.setenv("TEETIME_PROVIDER", "mock")
        _isolate_cache(monkeypatch, tmp_path)
        set_auth(TEST_OWNER_ID)
        r = await client.get(
            f"{BASE}/search",
            params={
                "date": "2026-07-04",
                "timeWindowStart": "07:00",
                "timeWindowEnd": "10:00",
                "partySize": 4,
            },
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["provider"] == "mock"
        assert len(data["results"]) > 0
        assert all(s["estimated"] is False for s in data["results"])
        assert all(s["priceUsd"] is not None for s in data["results"])


# ─────────────────────────────────────────────────────────────────────────────
# 6. Search TTL cache
# ─────────────────────────────────────────────────────────────────────────────


class TestSearchCache:
    async def test_second_identical_search_is_cached(self, client, monkeypatch, tmp_path):
        # Cache semantics are provider-agnostic — pin mock so this doesn't
        # depend on the routing provider's Places/Mapbox legs (no keys in CI;
        # a no-op result is still cacheable but shouldn't be what this pins).
        monkeypatch.setenv("TEETIME_PROVIDER", "mock")
        _isolate_cache(monkeypatch, tmp_path)
        set_auth(TEST_OWNER_ID)
        params = {
            "date": "2026-07-04",
            "timeWindowStart": "07:00",
            "timeWindowEnd": "10:00",
            "partySize": 4,
            "area": "San Francisco",
        }
        r1 = await client.get(f"{BASE}/search", params=params)
        assert r1.status_code == 200, r1.text
        assert r1.json()["cached"] is False

        r2 = await client.get(f"{BASE}/search", params=params)
        assert r2.status_code == 200, r2.text
        assert r2.json()["cached"] is True
        assert r2.json()["results"] == r1.json()["results"]

    async def test_different_query_is_not_cached(self, client, monkeypatch, tmp_path):
        monkeypatch.setenv("TEETIME_PROVIDER", "mock")
        _isolate_cache(monkeypatch, tmp_path)
        set_auth(TEST_OWNER_ID)
        params = {
            "date": "2026-07-04",
            "timeWindowStart": "07:00",
            "timeWindowEnd": "10:00",
            "partySize": 4,
        }
        r1 = await client.get(f"{BASE}/search", params=params)
        assert r1.json()["cached"] is False
        r2 = await client.get(f"{BASE}/search", params={**params, "partySize": 2})
        assert r2.json()["cached"] is False


# ─────────────────────────────────────────────────────────────────────────────
# 7. foreUP-provider handoff persisted end-to-end (specs/teetime-s2-plan.md §3a)
# ─────────────────────────────────────────────────────────────────────────────

FOREUP_BOOKING_URL = "https://foreupsoftware.com/index.php/booking/20410/4467"


class TestForeUpHandoffPersistence:
    """Proves the full HTTP path — search -> real foreUP slot -> POST /book ->
    persisted row — carries the course's own foreupsoftware.com deep-link (NOT
    a generic website), never fabricates a confirmation, and is honestly
    persisted as needs_human. `TestBookingPersistence.test_needs_human_...`
    covers the same shape via the ROUTING provider's generic-website slot;
    this class is the foreUP-specific counterpart. No live network — the
    ForeUpProvider is wired to an httpx.MockTransport over the same fixture
    (backend/tests/fixtures/foreup_18mile_times.json) test_tee_time_foreup.py
    uses."""

    def _use_foreup_router(self, monkeypatch):
        """Route uses a RoutedTeeTimeProvider with an injected (offline)
        finder + a ForeUpProvider wired to the fixture transport — no live
        network, ever."""
        from app.routes import tee_times as route_mod

        cap = _cap()

        async def find(_query):
            return [
                {
                    "id": "gplaces-18mile",
                    "name": cap.name,
                    "address": "6374 Boston State Rd, Hamburg, NY",
                    "center": {"lat": cap.lat, "lng": cap.lng},
                    "website": None,
                    "rating": 4.1,
                },
            ], (cap.lat, cap.lng)

        provider = RoutedTeeTimeProvider(
            find_courses=find,
            foreup=ForeUpProvider(
                capabilities=lambda: (cap,),
                transport=_fixture_transport(),
                cache=FakeCacheStore(),
                limiter=SlidingWindowLimiter(rpm=1000, window_s=60),
                breaker=CircuitBreaker(),
            ),
            capabilities=lambda: (cap,),
            foreup_enabled=True,
        )
        monkeypatch.setattr(route_mod, "_get_provider", lambda: provider)
        return cap

    async def test_search_book_persist_end_to_end_with_the_foreup_deep_link(
        self, client, monkeypatch, tmp_path
    ):
        cap = self._use_foreup_router(monkeypatch)
        _isolate_cache(monkeypatch, tmp_path)
        set_auth(TEST_OWNER_ID)

        # 1. GET /search -> a real foreUP slot, real time, real deep-link.
        r = await client.get(
            f"{BASE}/search",
            params={
                "date": FIXTURE_DATE,
                "timeWindowStart": "00:00",
                "timeWindowEnd": "23:59",
                "partySize": 1,
                "area": f"{cap.lat},{cap.lng}",
            },
        )
        assert r.status_code == 200, r.text
        results = r.json()["results"]
        assert results, "sanity: the fixture must yield at least one foreup slot"
        slot = next(s for s in results if s["provider"] == "foreup")
        assert slot["time"] != ""
        assert slot["bookingUrl"] == FOREUP_BOOKING_URL
        assert slot["estimated"] is False
        assert slot["route"] is None

        # 2. POST /book with that exact serialized slot -> needs_human, the
        #    SAME deep-link, no fabricated confirmation.
        r2 = await client.post(
            f"{BASE}/book",
            json={"slot": slot, "details": {"name": "Owner", "partySize": 1}},
        )
        assert r2.status_code == 200, r2.text
        result = r2.json()["result"]
        assert result["status"] == "needs_human"
        assert result["bookingUrl"] == FOREUP_BOOKING_URL
        assert result["confirmationNumber"] is None
        assert "Held" not in r2.text

        # 3. GET /bookings -> the attempt is durably persisted, honestly.
        r3 = await client.get(f"{BASE}/bookings")
        assert r3.status_code == 200, r3.text
        items = r3.json()
        assert len(items) == 1
        b = items[0]
        assert b["status"] == "needs_human"
        assert b["confirmationCode"] is None
        assert b["bookingUrl"] == FOREUP_BOOKING_URL
        assert b["provider"] == "foreup"
        assert b["time"] == slot["time"]
