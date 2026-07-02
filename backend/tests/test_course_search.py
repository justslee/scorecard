"""Tests for course search: name de-duplication + Google Places source +
OSM name-filter construction."""

import pytest

from app.routes import course_search
from app.services.osm import osm_name_filter


def test_osm_name_filter_ands_significant_words_any_order():
    # Drops generic golf words; keeps significant words as ANDed Overpass filters
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
# `search_golf_courses`, `_search_google_places`, `_search_mapbox`,
# `_write_through_courses`, `_search_cache`) are monkeypatched — no real I/O.
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


@pytest.fixture(autouse=True)
def _fake_cache(monkeypatch):
    """Every pipeline test gets an isolated in-memory cache (never the real
    disk-backed FileSearchCacheStore — avoids cross-test pollution)."""
    cache = FakeCacheStore()
    monkeypatch.setattr(course_search, "_search_cache", cache)
    return cache


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
        monkeypatch.setattr(course_search, "_search_mapbox", _never_called("_search_mapbox"))
        monkeypatch.setattr(course_search, "_write_through_courses", _never_called("_write_through_courses"))

        result = await course_search.search_courses(q="bethpage", _user_id="test-user")

        names = [c["name"] for c in result["courses"]]
        assert names == ["Bethpage Black Course", "Bethpage Green Course", "Bethpage Red Course"]

    async def test_fewer_than_three_local_hits_fans_out_and_merges(self, monkeypatch):
        local_hits = [
            {"id": "1", "name": "Bethpage Black Course", "address": None, "center": None, "source": "local"},
        ]

        async def fake_local(q):
            return local_hits

        async def fake_osm(*, name=None, lat=None, lng=None, radius_m=10000, interactive=False):
            assert name == "bethpage" and lat is None  # by-name leg, not anchored
            return [{"osm_id": "way/999", "name": "Bethpage Red Course",
                      "center": {"lat": 40.75, "lng": -73.46}, "source": "osm"}]

        write_through_calls = []

        async def fake_write_through(rows):
            write_through_calls.append(rows)

        monkeypatch.setattr(course_search, "_list_local_courses", fake_local)
        monkeypatch.setattr(course_search, "search_golf_courses", fake_osm)
        monkeypatch.setattr(course_search, "_search_google_places", lambda q: _empty_list())
        monkeypatch.setattr(course_search, "_search_mapbox", _never_called("_search_mapbox"))
        monkeypatch.setattr(course_search, "_write_through_courses", fake_write_through)

        result = await course_search.search_courses(q="bethpage", _user_id="test-user")

        names = sorted(c["name"] for c in result["courses"])
        assert names == ["Bethpage Black Course", "Bethpage Red Course"]
        # Only the NEW external hit is write-through'd — the local one is
        # already in the DB.
        assert len(write_through_calls) == 1
        written_names = [r["name"] for r in write_through_calls[0]]
        assert written_names == ["Bethpage Red Course"]


async def _empty_list():
    return []


class TestTownsNeverEmitted:
    async def test_mapbox_geocode_hit_never_returned_as_a_course(self, monkeypatch):
        """The owner's exact repro: "bethpa" -> Google/OSM miss -> Mapbox
        geocode finds the TOWN "Bethel Island" -> that town must NEVER be
        returned as a search result, only used as a location anchor."""

        async def fake_local(q):
            return []

        async def fake_osm(*, name=None, lat=None, lng=None, radius_m=10000, interactive=False):
            if lat is not None:
                # Anchored search near the geocoded town — no real course there.
                return []
            return []  # by-name leg — OSM has nothing for "bethpa" either

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

        result = await course_search.search_courses(q="bethpa", _user_id="test-user")

        assert result["courses"] == []
        assert "Bethel Island" not in str(result)
        assert write_through_calls == [[]]  # called with nothing to write

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


async def _noop():
    return None


class TestBethpageBlackEndToEnd:
    async def test_bethpage_black_query_returns_only_black(self, monkeypatch):
        async def fake_local(q):
            return []

        async def fake_osm(*, name=None, lat=None, lng=None, radius_m=10000, interactive=False):
            # Simulate an OSM name-filter edge case where Red also slips
            # through — the pure relevance gate must still filter it.
            return [
                {"osm_id": "way/1", "name": "Bethpage Black Course",
                 "center": {"lat": 40.75, "lng": -73.46}, "source": "osm"},
                {"osm_id": "way/2", "name": "Bethpage Red Course",
                 "center": {"lat": 40.75, "lng": -73.46}, "source": "osm"},
            ]

        monkeypatch.setattr(course_search, "_list_local_courses", fake_local)
        monkeypatch.setattr(course_search, "search_golf_courses", fake_osm)
        monkeypatch.setattr(course_search, "_search_google_places", lambda q: _empty_list())
        monkeypatch.setattr(course_search, "_search_mapbox", _never_called("_search_mapbox"))
        monkeypatch.setattr(course_search, "_write_through_courses", lambda rows: _noop())

        result = await course_search.search_courses(q="bethpage black", _user_id="test-user")

        names = [c["name"] for c in result["courses"]]
        assert names == ["Bethpage Black Course"]


class TestCacheHitShortCircuits:
    async def test_cache_hit_skips_local_and_external_and_write_through(self, monkeypatch, _fake_cache):
        cached_courses = [{"id": "cached-1", "name": "Bethpage Black Course", "source": "local"}]
        _fake_cache.data[course_search.course_finder.normalize_query("bethpage")] = cached_courses

        monkeypatch.setattr(course_search, "_list_local_courses", _never_called("_list_local_courses"))
        monkeypatch.setattr(course_search, "search_golf_courses", _never_called("search_golf_courses"))
        monkeypatch.setattr(course_search, "_search_google_places", _never_called("_search_google_places"))
        monkeypatch.setattr(course_search, "_search_mapbox", _never_called("_search_mapbox"))
        monkeypatch.setattr(course_search, "_write_through_courses", _never_called("_write_through_courses"))

        result = await course_search.search_courses(q="Bethpage", _user_id="test-user")

        assert result["courses"] == cached_courses
