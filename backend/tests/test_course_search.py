"""Tests for course search: name de-duplication + Google Places source +
OSM name-filter construction."""

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
