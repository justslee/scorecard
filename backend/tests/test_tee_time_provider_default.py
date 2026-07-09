"""Provider default + honest-empty semantics (S0 "kill fake data", 2026-07-xx).

The default provider is ROUTING (real nearby courses, no fabricated time,
booking routed to the course site or a phone call). TEETIME_PROVIDER=mock is
explicit opt-in; "affiliate" is a legacy alias for "routing"; any OTHER
unknown value ALSO falls to routing — never mock — so a prod env-var typo can
never silently serve demo data. When a real provider finds nothing, the
search route returns an honest empty list — the old mock-fallback substitution
is gone.
"""

import pytest

from app.routes import tee_times as route_mod
from app.routes.tee_times import _get_provider, search_tee_times
from app.services.tee_times.routing import RoutingTeeTimeProvider
from app.services.tee_times.base import TeeTimeProvider, TeeTimeQuery, TeeTimeSlot
from app.services.tee_times.mock import MockTeeTimeProvider


class _FakeCache:
    def get(self, key):  # always miss — force the provider path
        return None

    def set(self, key, results):
        self.last = (key, results)


class _EmptyRouting(TeeTimeProvider):
    name = "routing"

    async def search_availability(self, query: TeeTimeQuery) -> list[TeeTimeSlot]:
        return []

    async def book(self, slot, details):  # pragma: no cover — not exercised here
        raise NotImplementedError


class TestProviderDefault:
    def test_default_is_routing(self, monkeypatch):
        monkeypatch.delenv("TEETIME_PROVIDER", raising=False)
        assert isinstance(_get_provider(), RoutingTeeTimeProvider)

    def test_mock_opt_in_still_works(self, monkeypatch):
        monkeypatch.setenv("TEETIME_PROVIDER", "mock")
        assert isinstance(_get_provider(), MockTeeTimeProvider)

    def test_legacy_affiliate_alias_lands_on_routing(self, monkeypatch):
        monkeypatch.setenv("TEETIME_PROVIDER", "affiliate")
        assert isinstance(_get_provider(), RoutingTeeTimeProvider)

    def test_unknown_value_falls_to_routing_never_mock(self, monkeypatch):
        monkeypatch.setenv("TEETIME_PROVIDER", "definitely-not-real")
        assert isinstance(_get_provider(), RoutingTeeTimeProvider)


class TestEmptyResultIsHonest:
    @pytest.mark.asyncio
    async def test_routing_empty_returns_honest_empty_never_mock_fallback(self, monkeypatch):
        monkeypatch.setattr(route_mod, "_get_provider", lambda: _EmptyRouting())
        monkeypatch.setattr(route_mod, "_search_cache", _FakeCache())

        resp = await search_tee_times(
            date="2026-07-04",
            timeWindowStart="07:00",
            timeWindowEnd="10:00",
            partySize=4,
            area=None,
            courseIds=None,
            maxDistanceMiles=None,
            maxPriceUsd=None,
        )
        assert resp.results == []
        assert resp.provider == "routing"

    @pytest.mark.asyncio
    async def test_mock_provider_empty_stays_mock(self, monkeypatch):
        class _EmptyMock(MockTeeTimeProvider):
            async def search_availability(self, query):
                return []

        monkeypatch.setattr(route_mod, "_get_provider", lambda: _EmptyMock())
        monkeypatch.setattr(route_mod, "_search_cache", _FakeCache())

        resp = await search_tee_times(
            date="2026-07-04",
            timeWindowStart="07:00",
            timeWindowEnd="10:00",
            partySize=4,
            area=None,
            courseIds=None,
            maxDistanceMiles=None,
            maxPriceUsd=None,
        )
        assert resp.provider == "mock"
        assert resp.results == []


class TestNoMockFallbackStringExists:
    def test_mock_fallback_string_not_present_in_route_module(self):
        import inspect

        source = inspect.getsource(route_mod)
        assert "mock-fallback" not in source
