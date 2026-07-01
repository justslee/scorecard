"""Tests for the AffiliateLinkProvider (Phase 1b) — real courses, honest slots.

The course-finder is injected (no network): the provider must emit exactly one
estimated slot per course per requested window, never fabricate a price, carry
the course website as booking_url, and hand booking to a human (needs_human).
"""

import pytest

from app.services.tee_times.affiliate import (
    AffiliateLinkProvider,
    _haversine_miles,
    _parse_latlng,
)
from app.services.tee_times.base import BookingDetails, TeeTimeQuery, TeeTimeSlot


def _query(**overrides) -> TeeTimeQuery:
    defaults = dict(
        date="2026-07-04",
        time_window_start="07:00",
        time_window_end="10:00",
        party_size=4,
        area="37.7936,-122.4636",
    )
    defaults.update(overrides)
    return TeeTimeQuery(**defaults)


# Presidio-ish fixture courses. `origin` sits on the first course so distances
# are deterministic (0.0 for presidio, >0 for the others).
_ORIGIN = (37.7936, -122.4636)
_COURSES = [
    {
        "id": "gplaces-abc123",
        "name": "Presidio Golf Course",
        "address": "300 Finley Rd, San Francisco, CA",
        "center": {"lat": 37.7936, "lng": -122.4636},
        "website": "https://www.presidiogolf.com/",
        "rating": 4.3,
    },
    {
        "osm_id": "way/555",
        "name": "Lincoln Park Golf Course",
        "address": "San Francisco, CA",
        "center": {"lat": 37.7817, "lng": -122.4948},
        # No website / rating — OSM results often lack both.
    },
]


def _fake_finder(courses, origin=_ORIGIN):
    async def find(_query):
        return courses, origin
    return find


class TestSearchAvailability:
    async def test_one_estimated_slot_per_course(self):
        provider = AffiliateLinkProvider(find_courses=_fake_finder(_COURSES))
        slots = await provider.search_availability(_query())

        assert len(slots) == 2
        assert all(s.estimated is True for s in slots)
        assert all(s.provider == "affiliate" for s in slots)
        # One slot per course — the window start, clearly an estimate.
        assert all(s.time == "07:00" for s in slots)
        assert {s.course_name for s in slots} == {
            "Presidio Golf Course", "Lincoln Park Golf Course",
        }

    async def test_never_fabricates_price(self):
        provider = AffiliateLinkProvider(find_courses=_fake_finder(_COURSES))
        slots = await provider.search_availability(_query())
        assert all(s.price_usd is None for s in slots)

    async def test_booking_url_from_places_website_when_available(self):
        provider = AffiliateLinkProvider(find_courses=_fake_finder(_COURSES))
        slots = await provider.search_availability(_query())
        by_name = {s.course_name: s for s in slots}
        assert by_name["Presidio Golf Course"].booking_url == "https://www.presidiogolf.com/"
        # No website known → no URL. Never a fabricated link.
        assert by_name["Lincoln Park Golf Course"].booking_url is None

    async def test_distance_computed_from_origin_and_sorted(self):
        provider = AffiliateLinkProvider(find_courses=_fake_finder(_COURSES))
        slots = await provider.search_availability(_query())
        assert slots[0].course_name == "Presidio Golf Course"
        assert slots[0].distance_miles == 0.0
        assert slots[1].distance_miles > 0.0

    async def test_max_distance_filter(self):
        provider = AffiliateLinkProvider(find_courses=_fake_finder(_COURSES))
        slots = await provider.search_availability(_query(max_distance_miles=1.0))
        # Lincoln Park is ~1.8 mi from the origin — filtered out.
        assert [s.course_name for s in slots] == ["Presidio Golf Course"]

    async def test_empty_finder_returns_empty_list(self):
        provider = AffiliateLinkProvider(find_courses=_fake_finder([], origin=None))
        assert await provider.search_availability(_query()) == []

    async def test_finder_error_returns_empty_list_never_raises(self):
        async def boom(_query):
            raise RuntimeError("overpass down")
        provider = AffiliateLinkProvider(find_courses=boom)
        assert await provider.search_availability(_query()) == []

    async def test_skips_courses_without_id_or_name(self):
        bad = [{"name": "No Id Course", "center": {"lat": 1, "lng": 1}},
               {"id": "x1", "name": "", "center": {"lat": 1, "lng": 1}}]
        provider = AffiliateLinkProvider(find_courses=_fake_finder(bad))
        assert await provider.search_availability(_query()) == []

    async def test_caps_course_count(self):
        many = [
            {"id": f"c{i}", "name": f"Course {i}", "center": {"lat": 37.79, "lng": -122.46}}
            for i in range(20)
        ]
        provider = AffiliateLinkProvider(find_courses=_fake_finder(many))
        slots = await provider.search_availability(_query())
        assert len(slots) == 8


class TestBook:
    @pytest.fixture
    def slot(self) -> TeeTimeSlot:
        return TeeTimeSlot(
            id="gplaces-abc123-2026-07-04-07:00-0",
            course_id="gplaces-abc123",
            course_name="Presidio Golf Course",
            city="San Francisco, CA",
            date="2026-07-04",
            time="07:00",
            players=4,
            price_usd=None,
            cart_included=False,
            distance_miles=0.0,
            rating=4.3,
            provider="affiliate",
            holes=18,
            booking_url="https://www.presidiogolf.com/",
            estimated=True,
        )

    async def test_book_returns_needs_human_with_url(self, slot):
        provider = AffiliateLinkProvider(find_courses=_fake_finder(_COURSES))
        result = await provider.book(slot, BookingDetails(name="Owner", party_size=4))
        assert result.status == "needs_human"
        assert result.booking_url == "https://www.presidiogolf.com/"
        assert result.confirmation_number is None
        assert result.message and "Presidio Golf Course" in result.message

    async def test_book_without_url_still_needs_human(self, slot):
        slot.booking_url = None
        provider = AffiliateLinkProvider(find_courses=_fake_finder(_COURSES))
        result = await provider.book(slot, BookingDetails(name="Owner", party_size=4))
        assert result.status == "needs_human"
        assert result.booking_url is None


class TestHelpers:
    def test_parse_latlng(self):
        assert _parse_latlng("37.79,-122.46") == (37.79, -122.46)
        assert _parse_latlng(" 37.79 , -122.46 ") == (37.79, -122.46)
        assert _parse_latlng("San Francisco") is None
        assert _parse_latlng("999,0") is None      # out of range
        assert _parse_latlng(None) is None
        assert _parse_latlng("") is None

    def test_haversine_sf_to_la_roughly_right(self):
        d = _haversine_miles(37.7749, -122.4194, 34.0522, -118.2437)
        assert 330 < d < 360
