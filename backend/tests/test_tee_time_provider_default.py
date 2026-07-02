"""Provider default + empty-result fallback (phase-1b flip, 2026-07-02).

The default provider became AFFILIATE when GOOGLE_PLACES_API_KEY went live in
prod; when a real provider finds nothing (no location / unmapped area) the
search route falls back to the mock catalogue, labeled `mock-fallback`, so the
tee-time screen never renders empty.
"""

import pytest

from app.routes import tee_times as route_mod
from app.routes.tee_times import _get_provider, search_tee_times
from app.services.tee_times.affiliate import AffiliateLinkProvider
from app.services.tee_times.base import TeeTimeProvider, TeeTimeQuery, TeeTimeSlot
from app.services.tee_times.mock import MockTeeTimeProvider


class _FakeCache:
    def get(self, key):  # always miss — force the provider path
        return None

    def set(self, key, results):
        self.last = (key, results)


class _EmptyAffiliate(TeeTimeProvider):
    name = "affiliate"

    async def search_availability(self, query: TeeTimeQuery) -> list[TeeTimeSlot]:
        return []

    async def book(self, slot, details):  # pragma: no cover — not exercised here
        raise NotImplementedError


class TestProviderDefault:
    def test_default_is_affiliate(self, monkeypatch):
        monkeypatch.delenv("TEETIME_PROVIDER", raising=False)
        assert isinstance(_get_provider(), AffiliateLinkProvider)

    def test_mock_opt_out_still_works(self, monkeypatch):
        monkeypatch.setenv("TEETIME_PROVIDER", "mock")
        assert isinstance(_get_provider(), MockTeeTimeProvider)

    def test_unknown_value_falls_back_to_mock(self, monkeypatch):
        monkeypatch.setenv("TEETIME_PROVIDER", "definitely-not-real")
        assert isinstance(_get_provider(), MockTeeTimeProvider)


class TestEmptyResultFallback:
    @pytest.mark.asyncio
    async def test_affiliate_empty_falls_back_to_mock_catalogue(self, monkeypatch):
        monkeypatch.setattr(route_mod, "_get_provider", lambda: _EmptyAffiliate())
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
        assert resp.provider == "mock-fallback"
        assert len(resp.results) > 0  # the screen never goes empty

    @pytest.mark.asyncio
    async def test_mock_provider_empty_does_not_double_fallback(self, monkeypatch):
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
