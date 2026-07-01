"""Tests for course search: name de-duplication + Google Places source."""

from app.routes import course_search


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
