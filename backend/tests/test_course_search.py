"""Tests for course search: name de-duplication + Google Places source +
OSM name-filter construction + course-search-v2 (Places/GolfAPI fan-out,
non-blocking OSM enrichment, leg-health observability, cache-poisoning fix)."""

import logging
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import BackgroundTasks

from app.routes import course_search
from app.services import course_finder
from app.services.osm import osm_name_filter

# Captured BEFORE any test's autouse fixture monkeypatches
# `course_search._search_golfapi` to a stub — TestSearchGolfapiMapping needs
# the REAL implementation to test its clubs→course-dicts mapping.
_real_search_golfapi = course_search._search_golfapi


def test_osm_name_filter_ands_significant_words_any_order():
    # Drops generic golf words, keeps significant words as ANDed Overpass filters
    # so "bethpage black golf course" matches OSM's "Bethpage Black".
    assert osm_name_filter("bethpage black golf course") == '["name"~"bethpage",i]["name"~"black",i]'
    # Word order doesn't matter — same two filters, just reordered.
    assert osm_name_filter("black bethpage") == '["name"~"black",i]["name"~"bethpage",i]'


def test_osm_name_filter_single_word():
    assert osm_name_filter("pebble") == '["name"~"pebble",i]'


def test_osm_name_filter_only_stopwords_falls_back_to_phrase():
    assert osm_name_filter("golf club") == '["name"~"golf club",i]'


def test_osm_name_filter_strips_quotes_and_backslashes():
    # Injected quotes/backslashes are removed before building the Overpass regex.
    assert osm_name_filter('be"th\\page') == '["name"~"bethpage",i]'


def test_dedupe_by_name_keeps_first_occurrence_and_drops_empty():
    courses = [
        {"name": "Bethpage Black Course", "source": "osm"},
        {"name": "bethpage black course", "source": "google_places"},  # dupe (case)
        {"name": "Bethpage Red Course", "source": "osm"},
        {"name": "", "source": "x"},  # dropped — no name
        {"source": "y"},              # dropped — missing name
    ]
    out = course_search._dedupe_by_name(courses)
    assert [c["name"] for c in out] == ["Bethpage Black Course", "Bethpage Red Course"]
    # First (geometry-rich OSM) result wins the case-insensitive tie.
    assert out[0]["source"] == "osm"


async def test_google_places_is_noop_without_key(monkeypatch):
    monkeypatch.setattr(course_search, "GOOGLE_PLACES_API_KEY", "")
    assert await course_search._search_google_places("bethpage black") == []


def test_mapbox_url_encodes_query_path_injection():
    # A query with path metacharacters must be percent-encoded so it can't alter
    # the Mapbox request path (path-injection guard).
    url = course_search._mapbox_geocode_url("foo/bar")
    assert "/mapbox.places/foo%2Fbar.json" in url
    # The traversal-critical "/" is encoded (dots are harmless without a slash),
    # and spaces are encoded too.
    assert course_search._mapbox_geocode_url("../x").endswith("..%2Fx.json")
    assert "%20" in course_search._mapbox_geocode_url("st andrews")


def test_mapbox_url_normal_query_unaffected():
    assert course_search._mapbox_geocode_url("pebble").endswith("/mapbox.places/pebble.json")


# ─────────────────────────────────────────────────────────────────────────────
# search_courses pipeline — local-first, relevance-gated, cached, write-through
#
# The route function is called directly (bypassing FastAPI's HTTP/DI layer —
# `_user_id` is passed as a plain string since Depends() is never resolved
# outside a real request). All DB/network seams (`_list_local_courses`,
# `search_golf_courses`, `_search_google_places`, `_search_golfapi`,
# `_search_mapbox`, `_write_through_courses`, `_search_cache`) are
# monkeypatched — no real I/O.
#
# BackgroundTasks: real requests get a fresh `BackgroundTasks` per request
# (FastAPI injects it) and Starlette runs it after the response is sent; the
# TestClient runs it synchronously. Calling the route function directly (as
# these tests do), a test only needs to construct its own `BackgroundTasks()`
# and `await bg()` when it cares about the scheduled enrichment/write-through
# side effect — tests that only check the interactive response can ignore it
# (the default `background_tasks=None` path builds a throwaway instance).
# ─────────────────────────────────────────────────────────────────────────────

class FakeCacheStore:
    """In-memory stand-in for course_search_cache.SearchCacheStore (no disk I/O,
    no TTL — tests here cover pipeline wiring, not TTL behavior)."""

    def __init__(self):
        self.data: dict[str, list[dict]] = {}
        self.set_calls: list[tuple[str, list[dict]]] = []

    def get(self, key):
        return self.data.get(key)

    def set(self, key, results):
        self.data[key] = results
        self.set_calls.append((key, results))


def _never_called(name):
    async def _fn(*args, **kwargs):
        raise AssertionError(f"{name} should not have been called")
    return _fn


async def _empty_list():
    return []


async def _noop():
    return None


@pytest.fixture(autouse=True)
def _fake_cache(monkeypatch):
    """Every pipeline test gets an isolated in-memory cache (never the real
    disk-backed FileSearchCacheStore — avoids cross-test pollution)."""
    cache = FakeCacheStore()
    monkeypatch.setattr(course_search, "_search_cache", cache)
    return cache


@pytest.fixture(autouse=True)
def _default_golfapi_leg(monkeypatch):
    """Every pipeline test gets a clean (empty, no real I/O) GolfAPI leg by
    default; tests exercising GolfAPI specifically override this."""
    async def _empty(q):
        return []
    monkeypatch.setattr(course_search, "_search_golfapi", _empty)


class TestLocalFirstShortCircuit:
    async def test_three_or_more_local_hits_skips_all_external_calls(self, monkeypatch):
        local_hits = [
            {"id": "1", "name": "Bethpage Black Course", "address": None, "center": None, "source": "local"},
            {"id": "2", "name": "Bethpage Red Course", "address": None, "center": None, "source": "local"},
            {"id": "3", "name": "Bethpage Green Course", "address": None, "center": None, "source": "local"},
        ]

        async def fake_local(q):
            return local_hits

        monkeypatch.setattr(course_search, "_list_local_courses", fake_local)
        monkeypatch.setattr(course_search, "search_golf_courses", _never_called("search_golf_courses"))
        monkeypatch.setattr(course_search, "_search_google_places", _never_called("_search_google_places"))
        monkeypatch.setattr(course_search, "_search_golfapi", _never_called("_search_golfapi"))
        monkeypatch.setattr(course_search, "_search_mapbox", _never_called("_search_mapbox"))
        monkeypatch.setattr(course_search, "_write_through_courses", _never_called("_write_through_courses"))

        result = await course_search.search_courses(q="bethpage", _user_id="test-user")

        names = [c["name"] for c in result["courses"]]
        assert names == ["Bethpage Black Course", "Bethpage Green Course", "Bethpage Red Course"]

    async def test_fewer_than_three_local_hits_fans_out_and_merges(self, monkeypatch):
        """External contribution now comes from Places (the primary leg) —
        NOT the un-anchored OSM scan (killed in course-search-v2). The
        anchored OSM search only ever runs inside the background enrichment
        task, never synchronously."""
        local_hits = [
            {"id": "1", "name": "Bethpage Black Course", "address": None, "center": None, "source": "local"},
        ]

        async def fake_local(q):
            return local_hits

        async def fake_places(q):
            return [{"id": "gplaces-1", "name": "Bethpage Red Course", "address": None,
                      "center": {"lat": 40.75, "lng": -73.46}, "source": "google_places"}]

        async def fake_osm_anchored_only(*, name=None, lat=None, lng=None, radius_m=10000, interactive=False):
            assert lat is not None and lng is not None  # NEVER un-anchored
            return []  # no additional siblings in this test

        write_through_calls = []

        async def fake_write_through(rows):
            write_through_calls.append(rows)

        monkeypatch.setattr(course_search, "_list_local_courses", fake_local)
        monkeypatch.setattr(course_search, "_search_google_places", fake_places)
        monkeypatch.setattr(course_search, "search_golf_courses", fake_osm_anchored_only)
        monkeypatch.setattr(course_search, "_search_mapbox", _never_called("_search_mapbox"))
        monkeypatch.setattr(course_search, "_write_through_courses", fake_write_through)

        bg = BackgroundTasks()
        result = await course_search.search_courses(
            q="bethpage", background_tasks=bg, _user_id="test-user"
        )

        names = sorted(c["name"] for c in result["courses"])
        assert names == ["Bethpage Black Course", "Bethpage Red Course"]

        # Write-through is scheduled in the background, not called inline.
        assert write_through_calls == []
        await bg()  # Starlette runs BackgroundTasks after the response is sent

        # Only the NEW external hit is write-through'd — the local one is
        # already in the DB.
        assert len(write_through_calls) == 1
        written_names = [r["name"] for r in write_through_calls[0]]
        assert written_names == ["Bethpage Red Course"]

    async def test_golfapi_is_a_fallback_leg_only_when_places_is_empty(self, monkeypatch):
        """GolfAPI's 45-calls/month budget is shared with per-course golf-data
        fetches and each distinct typed prefix is a fresh discovery cache key,
        so the leg runs ONLY when Places found nothing."""

        async def fake_local(q):
            return []

        async def fake_places_empty(q):
            return []

        async def fake_golfapi(q):
            return [{"id": "golfapi-9", "name": "Pebble Beach Golf Links", "address": None,
                     "center": {"lat": 36.57, "lng": -121.95}, "source": "golfapi"}]

        monkeypatch.setattr(course_search, "_list_local_courses", fake_local)
        monkeypatch.setattr(course_search, "_search_google_places", fake_places_empty)
        monkeypatch.setattr(course_search, "_search_golfapi", fake_golfapi)
        monkeypatch.setattr(course_search, "search_golf_courses", _never_called("search_golf_courses"))
        monkeypatch.setattr(course_search, "_search_mapbox", _never_called("_search_mapbox"))
        monkeypatch.setattr(course_search, "_write_through_courses", lambda rows: _noop())

        result = await course_search.search_courses(q="pebble beach", _user_id="test-user")

        assert [c["name"] for c in result["courses"]] == ["Pebble Beach Golf Links"]
        health_by_source = {h["source"]: h for h in result["legHealth"]}
        assert health_by_source["golfapi"]["outcome"] == "ok"
        assert health_by_source["golfapi"]["count"] == 1


class TestTownsNeverEmitted:
    async def test_mapbox_geocode_hit_never_returned_as_a_course(self, monkeypatch):
        """The owner's exact repro: "bethpa" -> Google/GolfAPI miss -> Mapbox
        geocode finds the TOWN "Bethel Island" -> that town must NEVER be
        returned as a search result, only used as a location anchor."""

        async def fake_local(q):
            return []

        async def fake_osm(*, name=None, lat=None, lng=None, radius_m=10000, interactive=False):
            assert lat is not None  # only ever called anchored now
            return []  # no real course near the geocoded town

        async def fake_mapbox(query, *, timeout_s=8.0):
            return [{"id": "mapbox-1", "name": "Bethel Island",
                      "center": {"lat": 38.0, "lng": -121.6}, "source": "mapbox"}]

        write_through_calls = []

        async def fake_write_through(rows):
            write_through_calls.append(rows)

        monkeypatch.setattr(course_search, "_list_local_courses", fake_local)
        monkeypatch.setattr(course_search, "search_golf_courses", fake_osm)
        monkeypatch.setattr(course_search, "_search_google_places", lambda q: _empty_list())
        monkeypatch.setattr(course_search, "_search_mapbox", fake_mapbox)
        monkeypatch.setattr(course_search, "_write_through_courses", fake_write_through)

        bg = BackgroundTasks()
        result = await course_search.search_courses(
            q="bethpa", background_tasks=bg, _user_id="test-user"
        )

        assert result["courses"] == []
        assert "Bethel Island" not in str(result)

        await bg()
        assert write_through_calls == [[]]  # scheduled with nothing to write

    async def test_anchored_nearby_course_still_gated_by_relevance(self, monkeypatch):
        """Even when the anchored OSM search DOES find a real nearby course,
        it must still pass the prefix gate — an unrelated club near the
        geocoded town is not a "bethpa" match either."""

        async def fake_local(q):
            return []

        async def fake_osm(*, name=None, lat=None, lng=None, radius_m=10000, interactive=False):
            if lat is not None:
                return [{"osm_id": "way/1", "name": "Bethel Island Golf Club",
                          "center": {"lat": 38.0, "lng": -121.6}, "source": "osm"}]
            return []

        async def fake_mapbox(query, *, timeout_s=8.0):
            return [{"id": "mapbox-1", "name": "Bethel Island",
                      "center": {"lat": 38.0, "lng": -121.6}, "source": "mapbox"}]

        monkeypatch.setattr(course_search, "_list_local_courses", fake_local)
        monkeypatch.setattr(course_search, "search_golf_courses", fake_osm)
        monkeypatch.setattr(course_search, "_search_google_places", lambda q: _empty_list())
        monkeypatch.setattr(course_search, "_search_mapbox", fake_mapbox)
        monkeypatch.setattr(course_search, "_write_through_courses", lambda rows: _noop())

        result = await course_search.search_courses(q="bethpa", _user_id="test-user")

        assert result["courses"] == []


class TestBethpageBlackEndToEnd:
    async def test_bethpage_black_query_returns_only_black(self, monkeypatch):
        async def fake_local(q):
            return []

        async def fake_places(q):
            # Simulate loose Places matching where Red also slips through —
            # the pure relevance gate must still filter it, regardless of
            # source.
            return [
                {"id": "gplaces-1", "name": "Bethpage Black Course",
                 "center": {"lat": 40.75, "lng": -73.46}, "source": "google_places"},
                {"id": "gplaces-2", "name": "Bethpage Red Course",
                 "center": {"lat": 40.75, "lng": -73.46}, "source": "google_places"},
            ]

        monkeypatch.setattr(course_search, "_list_local_courses", fake_local)
        monkeypatch.setattr(course_search, "_search_google_places", fake_places)
        # Places matched, so neither the Mapbox fallback nor an un-anchored
        # OSM call should ever fire synchronously.
        monkeypatch.setattr(course_search, "search_golf_courses", _never_called("search_golf_courses"))
        monkeypatch.setattr(course_search, "_search_mapbox", _never_called("_search_mapbox"))
        monkeypatch.setattr(course_search, "_write_through_courses", lambda rows: _noop())

        result = await course_search.search_courses(q="bethpage black", _user_id="test-user")

        names = [c["name"] for c in result["courses"]]
        assert names == ["Bethpage Black Course"]


class TestPebbleBeachRepro:
    """Owner escalation repro (course-search-v2): search couldn't find
    "Pebble Beach" at all under the old un-anchored-OSM-only pipeline. Places
    is now the primary leg, so this must resolve directly."""

    async def test_pebble_beach_query_returns_pebble_beach(self, monkeypatch):
        async def fake_local(q):
            return []

        async def fake_places(q):
            return [{"id": "gplaces-1", "name": "Pebble Beach Golf Links",
                      "center": {"lat": 36.5725, "lng": -121.9486}, "source": "google_places"}]

        monkeypatch.setattr(course_search, "_list_local_courses", fake_local)
        monkeypatch.setattr(course_search, "_search_google_places", fake_places)
        monkeypatch.setattr(course_search, "search_golf_courses", _never_called("search_golf_courses"))
        monkeypatch.setattr(course_search, "_search_mapbox", _never_called("_search_mapbox"))
        monkeypatch.setattr(course_search, "_write_through_courses", lambda rows: _noop())

        result = await course_search.search_courses(q="pebble beach", _user_id="test-user")

        assert [c["name"] for c in result["courses"]] == ["Pebble Beach Golf Links"]

    async def test_pebble_alone_returns_only_pebble_no_towns(self, monkeypatch):
        async def fake_local(q):
            return []

        async def fake_places(q):
            return [{"id": "gplaces-1", "name": "Pebble Beach Golf Links",
                      "center": {"lat": 36.5725, "lng": -121.9486}, "source": "google_places"}]

        monkeypatch.setattr(course_search, "_list_local_courses", fake_local)
        monkeypatch.setattr(course_search, "_search_google_places", fake_places)
        monkeypatch.setattr(course_search, "search_golf_courses", _never_called("search_golf_courses"))
        monkeypatch.setattr(course_search, "_search_mapbox", _never_called("_search_mapbox"))
        monkeypatch.setattr(course_search, "_write_through_courses", lambda rows: _noop())

        result = await course_search.search_courses(q="pebble", _user_id="test-user")

        names = [c["name"] for c in result["courses"]]
        assert names == ["Pebble Beach Golf Links"]
        assert "Pebble Beach" in str(result)  # sanity: not filtered away
        # No geocoder town name ever appears among the returned rows.
        for c in result["courses"]:
            assert "town" not in c["name"].lower()


class TestCacheHitShortCircuits:
    async def test_cache_hit_skips_local_and_external_and_write_through(self, monkeypatch, _fake_cache):
        cached_courses = [{"id": "cached-1", "name": "Bethpage Black Course", "source": "local"}]
        _fake_cache.data[course_search.course_finder.normalize_query("bethpage")] = cached_courses

        monkeypatch.setattr(course_search, "_list_local_courses", _never_called("_list_local_courses"))
        monkeypatch.setattr(course_search, "search_golf_courses", _never_called("search_golf_courses"))
        monkeypatch.setattr(course_search, "_search_google_places", _never_called("_search_google_places"))
        monkeypatch.setattr(course_search, "_search_golfapi", _never_called("_search_golfapi"))
        monkeypatch.setattr(course_search, "_search_mapbox", _never_called("_search_mapbox"))
        monkeypatch.setattr(course_search, "_write_through_courses", _never_called("_write_through_courses"))

        result = await course_search.search_courses(q="Bethpage", _user_id="test-user")

        assert result["courses"] == cached_courses


class TestCachePoisoningFix:
    """course-search-v2 A2: an empty result caused by a MASKED leg failure
    must never be negative-cached; only a genuine (all-legs-clean) empty
    result — or any positive result — is safe to cache."""

    async def test_leg_error_with_empty_result_is_not_cached(self, monkeypatch, _fake_cache):
        async def fake_local(q):
            return []

        async def fake_places_raises(q):
            raise RuntimeError("places 403 SERVICE_DISABLED")

        async def fake_mapbox_empty(q, *, timeout_s=8.0):
            return []

        monkeypatch.setattr(course_search, "_list_local_courses", fake_local)
        monkeypatch.setattr(course_search, "_search_google_places", fake_places_raises)
        monkeypatch.setattr(course_search, "_search_mapbox", fake_mapbox_empty)
        monkeypatch.setattr(course_search, "search_golf_courses", _never_called("search_golf_courses"))
        monkeypatch.setattr(course_search, "_write_through_courses", lambda rows: _noop())

        result = await course_search.search_courses(q="nonexistent xyz", _user_id="test-user")

        assert result["courses"] == []
        assert _fake_cache.set_calls == []  # NOT cached — a leg errored

    async def test_genuine_no_match_all_legs_clean_is_cached_negative(self, monkeypatch, _fake_cache):
        async def fake_local(q):
            return []

        async def fake_places_empty(q):
            return []

        async def fake_mapbox_empty(q, *, timeout_s=8.0):
            return []

        monkeypatch.setattr(course_search, "_list_local_courses", fake_local)
        monkeypatch.setattr(course_search, "_search_google_places", fake_places_empty)
        monkeypatch.setattr(course_search, "_search_mapbox", fake_mapbox_empty)
        monkeypatch.setattr(course_search, "search_golf_courses", _never_called("search_golf_courses"))
        monkeypatch.setattr(course_search, "_write_through_courses", lambda rows: _noop())

        result = await course_search.search_courses(q="totally not a course", _user_id="test-user")

        assert result["courses"] == []
        assert len(_fake_cache.set_calls) == 1
        _, cached_val = _fake_cache.set_calls[0]
        assert cached_val == []

    async def test_positive_result_is_cached(self, monkeypatch, _fake_cache):
        async def fake_local(q):
            return []

        async def fake_places(q):
            return [{"id": "gplaces-1", "name": "Pebble Beach Golf Links",
                      "center": {"lat": 36.5, "lng": -121.9}, "source": "google_places"}]

        monkeypatch.setattr(course_search, "_list_local_courses", fake_local)
        monkeypatch.setattr(course_search, "_search_google_places", fake_places)
        monkeypatch.setattr(course_search, "_write_through_courses", lambda rows: _noop())

        result = await course_search.search_courses(q="pebble beach", _user_id="test-user")

        assert [c["name"] for c in result["courses"]] == ["Pebble Beach Golf Links"]
        assert len(_fake_cache.set_calls) == 1
        _, cached_val = _fake_cache.set_calls[0]
        assert cached_val != []


class TestLegHealth:
    async def test_response_includes_per_leg_outcome_count_ms(self, monkeypatch):
        async def fake_local(q):
            return []

        async def fake_places(q):
            return [{"id": "gplaces-1", "name": "Pebble Beach Golf Links",
                      "center": {"lat": 36.5, "lng": -121.9}, "source": "google_places"}]

        monkeypatch.setattr(course_search, "_list_local_courses", fake_local)
        monkeypatch.setattr(course_search, "_search_google_places", fake_places)
        monkeypatch.setattr(course_search, "_write_through_courses", lambda rows: _noop())

        result = await course_search.search_courses(q="pebble beach", _user_id="test-user")

        health_by_source = {h["source"]: h for h in result["legHealth"]}
        assert health_by_source["google_places"]["outcome"] == "ok"
        assert health_by_source["google_places"]["count"] == 1
        assert isinstance(health_by_source["google_places"]["ms"], int)
        # GolfAPI is a metered fallback — NOT attempted (and so absent from
        # legHealth) when Places already found something.
        assert "golfapi" not in health_by_source

    async def test_leg_raising_is_outcome_error_and_logs_warning(self, monkeypatch, caplog):
        async def fake_local(q):
            return []

        async def fake_places_raises(q):
            raise RuntimeError("boom")

        async def fake_mapbox_empty(q, *, timeout_s=8.0):
            return []

        monkeypatch.setattr(course_search, "_list_local_courses", fake_local)
        monkeypatch.setattr(course_search, "_search_google_places", fake_places_raises)
        monkeypatch.setattr(course_search, "_search_mapbox", fake_mapbox_empty)
        monkeypatch.setattr(course_search, "search_golf_courses", _never_called("search_golf_courses"))
        monkeypatch.setattr(course_search, "_write_through_courses", lambda rows: _noop())

        with caplog.at_level(logging.WARNING, logger="app.routes.course_search"):
            result = await course_search.search_courses(q="whatever golf", _user_id="test-user")

        health_by_source = {h["source"]: h for h in result["legHealth"]}
        assert health_by_source["google_places"]["outcome"] == "error"
        assert any(
            "leg=google_places" in rec.message and "outcome=error" in rec.message
            for rec in caplog.records
        )


class TestNonBlockingEnrichment:
    async def test_places_anchor_schedules_osm_enrichment_without_waiting(self, monkeypatch):
        async def fake_local(q):
            return []

        async def fake_places(q):
            return [{"id": "gplaces-1", "name": "Bethpage Black Course",
                      "center": {"lat": 40.75, "lng": -73.46}, "source": "google_places"}]

        osm_calls = []

        async def fake_osm_anchored(*, name=None, lat=None, lng=None, radius_m=10000, interactive=False):
            osm_calls.append((lat, lng))
            return [{"osm_id": "way/2", "name": "Bethpage Red Course",
                      "center": {"lat": 40.75, "lng": -73.46}, "source": "osm"}]

        write_through_calls = []

        async def fake_write_through(rows):
            write_through_calls.append(rows)

        monkeypatch.setattr(course_search, "_list_local_courses", fake_local)
        monkeypatch.setattr(course_search, "_search_google_places", fake_places)
        monkeypatch.setattr(course_search, "search_golf_courses", fake_osm_anchored)
        monkeypatch.setattr(course_search, "_write_through_courses", fake_write_through)

        bg = BackgroundTasks()
        result = await course_search.search_courses(
            q="bethpage", background_tasks=bg, _user_id="test-user"
        )

        # Response returns immediately with ONLY the Places row — OSM hasn't
        # been consulted yet (non-blocking).
        assert [c["name"] for c in result["courses"]] == ["Bethpage Black Course"]
        assert osm_calls == []
        assert write_through_calls == []

        await bg()  # simulate Starlette running BackgroundTasks post-response

        assert osm_calls == [(40.75, -73.46)]
        assert len(write_through_calls) == 1
        written_names = sorted(r["name"] for r in write_through_calls[0])
        assert written_names == ["Bethpage Black Course", "Bethpage Red Course"]


class TestSearchGolfapiMapping:
    async def test_maps_clubs_and_courses_to_course_dicts(self, monkeypatch):
        async def fake_discover(area_key, query, **kwargs):
            return [
                {
                    "clubID": "c1", "clubName": "Bethpage State Park",
                    "address": "99 Quaker Meeting House Rd", "city": "Farmingdale", "state": "NY",
                    "latitude": "40.75", "longitude": "-73.46",
                    "courses": [
                        {"courseID": "101", "courseName": "Black Course"},
                        {"courseID": "102", "courseName": "Red Course"},
                    ],
                },
            ]

        monkeypatch.setattr(course_search.golfapi_cache, "discover_golfapi_clubs", fake_discover)

        rows = await _real_search_golfapi("bethpage")

        assert [r["name"] for r in rows] == ["Black Course", "Red Course"]
        assert all(r["source"] == "golfapi" for r in rows)
        assert all(r["center"] == {"lat": 40.75, "lng": -73.46} for r in rows)
        assert {r["id"] for r in rows} == {"golfapi-101", "golfapi-102"}
        assert rows[0]["address"] == "99 Quaker Meeting House Rd, Farmingdale, NY"

    async def test_returns_empty_when_discovery_returns_none(self, monkeypatch):
        async def fake_discover(area_key, query, **kwargs):
            return None

        monkeypatch.setattr(course_search.golfapi_cache, "discover_golfapi_clubs", fake_discover)
        assert await _real_search_golfapi("nonexistent") == []

    async def test_returns_empty_for_blank_query(self, monkeypatch):
        assert await _real_search_golfapi("   ") == []


# ─────────────────────────────────────────────────────────────────────────────
# /api/courses/nearby — search-speed-and-golfapi-verify (latency half): the
# route calls the module's own `search_golf_courses` name directly (imported
# at module top), so tests monkeypatch `course_search.search_golf_courses`
# rather than `app.services.osm.search_golf_courses`. The nearby cache is a
# SEPARATE instance (`course_search._nearby_cache`) from `_search_cache`
# (`/search`'s cache) — swapped for a `FakeCacheStore` here too so tests never
# touch the real disk-backed file.
# ─────────────────────────────────────────────────────────────────────────────

class TestNearbyCourses:
    async def test_hits_are_cached_and_requested_on_the_interactive_budget(self, monkeypatch):
        nearby_cache = FakeCacheStore()
        monkeypatch.setattr(course_search, "_nearby_cache", nearby_cache)

        calls = []

        async def fake_search_golf_courses(**kwargs):
            calls.append(kwargs)
            return [{"osm_id": "way/1", "name": "Bethpage Black", "source": "osm"}]

        monkeypatch.setattr(course_search, "search_golf_courses", fake_search_golf_courses)

        result = await course_search.nearby_courses(lat=40.7442, lng=-73.4593, radiusMeters=25000)

        # attach_stable_ids gives the id-less OSM hit the deterministic
        # write-through UUID (specs/teetime-course-ids-wiring-plan.md §4.1) —
        # unifies wire ids with /api/courses/search so a tee-time selection
        # made from this leg can be reconciled by the selection filter.
        expected_id = course_finder.deterministic_course_id("osm-way/1")
        expected_course = {
            "osm_id": "way/1", "name": "Bethpage Black", "source": "osm", "id": expected_id,
        }
        assert result == {"courses": [expected_course]}
        # Interactive budget requested — this is the latency fix (win b).
        assert len(calls) == 1
        assert calls[0]["interactive"] is True
        assert calls[0]["lat"] == 40.7442
        assert calls[0]["lng"] == -73.4593
        assert calls[0]["radius_m"] == 25000
        # Positive result is cached (post-attach_stable_ids shape).
        assert len(nearby_cache.set_calls) == 1
        cached_key, cached_val = nearby_cache.set_calls[0]
        assert cached_val == [expected_course]
        assert cached_key == course_search._nearby_cache_key(40.7442, -73.4593, 25000)

    async def test_empty_result_is_never_cached(self, monkeypatch):
        nearby_cache = FakeCacheStore()
        monkeypatch.setattr(course_search, "_nearby_cache", nearby_cache)

        async def fake_search_golf_courses(**kwargs):
            return []

        monkeypatch.setattr(course_search, "search_golf_courses", fake_search_golf_courses)

        result = await course_search.nearby_courses(lat=40.7442, lng=-73.4593, radiusMeters=25000)

        assert result == {"courses": []}
        # Honesty law: [] is indistinguishable from a masked timeout/error at
        # this seam, so nearby is positive-only — never negative-cached.
        assert nearby_cache.set_calls == []

    async def test_warmed_cache_short_circuits_the_osm_call(self, monkeypatch):
        nearby_cache = FakeCacheStore()
        key = course_search._nearby_cache_key(40.7442, -73.4593, 25000)
        cached_courses = [{"osm_id": "way/9", "name": "Cached Course", "source": "osm"}]
        nearby_cache.data[key] = cached_courses
        monkeypatch.setattr(course_search, "_nearby_cache", nearby_cache)
        monkeypatch.setattr(course_search, "search_golf_courses", _never_called("search_golf_courses"))

        result = await course_search.nearby_courses(lat=40.7442, lng=-73.4593, radiusMeters=25000)

        assert result == {"courses": cached_courses}

    async def test_default_radius_is_used_in_the_cache_key_when_omitted(self, monkeypatch):
        nearby_cache = FakeCacheStore()
        monkeypatch.setattr(course_search, "_nearby_cache", nearby_cache)

        async def fake_search_golf_courses(**kwargs):
            return [{"osm_id": "way/1", "name": "Bethpage Black", "source": "osm"}]

        monkeypatch.setattr(course_search, "search_golf_courses", fake_search_golf_courses)

        await course_search.nearby_courses(lat=40.7442, lng=-73.4593, radiusMeters=None)

        cached_key, _ = nearby_cache.set_calls[0]
        assert cached_key == course_search._nearby_cache_key(40.7442, -73.4593, 50000)


# ─────────────────────────────────────────────────────────────────────────────
# Places junk-venue filter (search-places-junk-filter): golf_course type
# immunity, hard-drop of unambiguous non-course venues (pro shops, gift
# shops, lodging), downrank of name-only "ambiguous" venues.
# ─────────────────────────────────────────────────────────────────────────────

class TestClassifyPlaceVenue:
    def test_golf_course_type_is_immune_even_with_junk_name(self):
        # golf_course immunity is checked FIRST — a junky name never overrides it.
        assert course_finder.classify_place_venue(
            "Pebble Beach Pro Shop", ["golf_course", "point_of_interest"], "golf_course",
        ) == "course"

    def test_pro_shop_with_store_primary_type_is_hard_dropped(self):
        assert course_finder.classify_place_venue(
            "Pebble Beach Pro Shop", ["store", "point_of_interest"], "store",
        ) == "non_course"

    def test_standalone_gift_shop_is_hard_dropped(self):
        assert course_finder.classify_place_venue(
            "The Golf Gift Shop", ["gift_shop", "store"], "gift_shop",
        ) == "non_course"

    def test_academy_with_benign_primary_type_is_ambiguous(self):
        assert course_finder.classify_place_venue(
            "Pebble Beach Golf Academy", ["point_of_interest", "establishment"],
            "point_of_interest",
        ) == "ambiguous"

    def test_lodge_with_lodging_primary_type_is_hard_dropped(self):
        assert course_finder.classify_place_venue(
            "The Lodge at Pebble Beach", ["lodging", "point_of_interest"], "lodging",
        ) == "non_course"

    def test_lodge_with_benign_primary_type_is_ambiguous(self):
        assert course_finder.classify_place_venue(
            "The Lodge at Pebble Beach", ["point_of_interest", "establishment"],
            "point_of_interest",
        ) == "ambiguous"

    def test_clean_course_name_with_no_golf_course_type_still_classified_course(self):
        # Real course typed loosely by Google (no golf_course, no non-course
        # primaryType, no junk name substring) -> default to "course".
        assert course_finder.classify_place_venue(
            "Bethpage Black Course", ["point_of_interest", "establishment"],
            "point_of_interest",
        ) == "course"

    def test_whitespace_and_case_normalized_before_name_substring_check(self):
        assert course_finder.classify_place_venue(
            "PEBBLE BEACH PRO   SHOP", ["point_of_interest"], "point_of_interest",
        ) == "ambiguous"

    def test_missing_types_and_primary_type_default_to_course(self):
        assert course_finder.classify_place_venue("Some Club", None, None) == "course"

    def test_name_heuristics_are_word_anchored_not_substrings(self):
        # A real course name that merely CONTAINS a heuristic fragment must not
        # be downranked — the phrases match on word boundaries, not substrings.
        # "Spanish Bay" (a real Pebble Beach course) contains "spa"; "Grille"
        # contains "grill"; "Lodgepole" contains "lodge". None should fire.
        for real_name in (
            "The Links at Spanish Bay",   # contains "spa"
            "The Grille Golf Club",       # contains "grill"
            "Lodgepole Pines Golf Club",  # contains "lodge"
        ):
            assert course_finder.classify_place_venue(
                real_name, ["point_of_interest", "establishment"], "point_of_interest",
            ) == "course", real_name
        # The whole-word forms still fire (downrank), confirming the guard
        # didn't over-correct.
        assert course_finder.classify_place_venue(
            "Clubhouse Grill", ["point_of_interest"], "point_of_interest",
        ) == "ambiguous"


class _PlacesResp:
    """Minimal stand-in for httpx.Response, matching the seam used by the
    existing httpx.AsyncClient mocks in tests/test_osm_boundary_selection.py."""

    def __init__(self, data: dict) -> None:
        self.status_code = 200
        self.is_success = True
        self.text = ""
        self._data = data

    def json(self) -> dict:
        return self._data


def _mock_places_client(data: dict):
    """Return (mock_ctor_patch, mock_client) — mock_client.post captures the
    request so tests can assert on headers/body; the response is `data`."""
    mock_client = AsyncMock()
    mock_client.post.return_value = _PlacesResp(data)
    return mock_client


class TestSearchGooglePlacesVenueFilter:
    async def test_hard_drops_junk_and_keeps_real_course_unpenalized(self):
        data = {
            "places": [
                {
                    "id": "abc123", "displayName": {"text": "Pebble Beach Golf Links"},
                    "formattedAddress": "1700 17 Mile Dr, Pebble Beach, CA",
                    "location": {"latitude": 36.5725, "longitude": -121.9486},
                    "types": ["golf_course", "point_of_interest"],
                    "primaryType": "golf_course",
                },
                {
                    "id": "def456", "displayName": {"text": "Pebble Beach Pro Shop"},
                    "formattedAddress": "1700 17 Mile Dr, Pebble Beach, CA",
                    "location": {"latitude": 36.5726, "longitude": -121.9487},
                    "types": ["store", "point_of_interest"],
                    "primaryType": "store",
                },
                {
                    "id": "ghi789", "displayName": {"text": "The Gift Shop"},
                    "formattedAddress": "1700 17 Mile Dr, Pebble Beach, CA",
                    "location": {"latitude": 36.5724, "longitude": -121.9485},
                    "types": ["gift_shop", "store"],
                    "primaryType": "gift_shop",
                },
            ],
        }
        mock_client = _mock_places_client(data)
        with patch("httpx.AsyncClient") as mock_ctor:
            mock_ctor.return_value.__aenter__.return_value = mock_client
            out = await course_finder.search_google_places("pebble beach", api_key="test-key")

        assert [c["name"] for c in out] == ["Pebble Beach Golf Links"]
        assert out[0]["venue_penalty"] == 0

    async def test_ambiguous_academy_kept_and_penalized_real_course_sorts_first(self):
        data = {
            "places": [
                {
                    "id": "abc123", "displayName": {"text": "Pebble Beach Golf Links"},
                    "formattedAddress": "1700 17 Mile Dr, Pebble Beach, CA",
                    "location": {"latitude": 36.5725, "longitude": -121.9486},
                    "types": ["golf_course", "point_of_interest"],
                    "primaryType": "golf_course",
                },
                {
                    "id": "def456", "displayName": {"text": "Pebble Beach Golf Academy"},
                    "formattedAddress": "1700 17 Mile Dr, Pebble Beach, CA",
                    "location": {"latitude": 36.5726, "longitude": -121.9487},
                    "types": ["point_of_interest", "establishment"],
                    "primaryType": "point_of_interest",
                },
            ],
        }
        mock_client = _mock_places_client(data)
        with patch("httpx.AsyncClient") as mock_ctor:
            mock_ctor.return_value.__aenter__.return_value = mock_client
            out = await course_finder.search_google_places("pebble beach", api_key="test-key")

        assert [c["name"] for c in out] == ["Pebble Beach Golf Links", "Pebble Beach Golf Academy"]
        by_name = {c["name"]: c for c in out}
        assert by_name["Pebble Beach Golf Links"]["venue_penalty"] == 0
        assert by_name["Pebble Beach Golf Academy"]["venue_penalty"] == 1

        ranked = course_finder.rank_courses(out, "pebble beach")
        assert [c["name"] for c in ranked] == ["Pebble Beach Golf Links", "Pebble Beach Golf Academy"]

    async def test_field_mask_requests_types_and_primary_type(self):
        data = {"places": []}
        mock_client = _mock_places_client(data)
        with patch("httpx.AsyncClient") as mock_ctor:
            mock_ctor.return_value.__aenter__.return_value = mock_client
            await course_finder.search_google_places("pebble beach", api_key="test-key")

        _, kwargs = mock_client.post.call_args
        field_mask = kwargs["headers"]["X-Goog-FieldMask"]
        assert "places.types" in field_mask
        assert "places.primaryType" in field_mask


class TestRankCoursesVenuePenalty:
    def test_local_first_clean_external_second_ambiguous_external_last(self):
        # None of these three names reduce to an EXACT significant-token match
        # against "pebble beach" (each carries an extra non-stopword token), so
        # the tier is decided by local-source, then venue_penalty.
        courses = [
            {"name": "Pebble Beach Golf Academy", "source": "google_places",
             "venue_penalty": 1, "center": None},
            {"name": "Pebble Beach Executive Course", "source": "local", "center": None},
            {"name": "Pebble Beach Public Course", "source": "google_places",
             "venue_penalty": 0, "center": None},
        ]
        ranked = course_finder.rank_courses(courses, "pebble beach")
        assert [c["name"] for c in ranked] == [
            "Pebble Beach Executive Course", "Pebble Beach Public Course", "Pebble Beach Golf Academy",
        ]

    def test_exact_match_still_leads_regardless_of_penalty(self):
        # An exact-name match with a penalty still outranks a non-exact,
        # unpenalized hit — exact/prefix/local always dominate the penalty.
        courses = [
            {"name": "Pebble Beach Golf Links Nearby Course", "source": "google_places",
             "venue_penalty": 0, "center": None},
            {"name": "Pebble Beach", "source": "google_places",
             "venue_penalty": 1, "center": None},
        ]
        ranked = course_finder.rank_courses(courses, "pebble beach")
        assert ranked[0]["name"] == "Pebble Beach"

    def test_venue_penalty_defaults_to_zero_when_unset(self):
        courses = [
            {"name": "Bethpage Black Course", "source": "osm", "center": None},
        ]
        ranked = course_finder.rank_courses(courses, "bethpage black")
        assert ranked[0]["name"] == "Bethpage Black Course"
