"""Tests for RoutingTeeTimeProvider (S0 "kill fake data").

The course-finder is injected (no network): the provider must emit exactly one
route-tagged entry per PUBLIC course per requested window, with NO fabricated
time, never fabricate a price, carry the course website as booking_url (and
route="book_on_site") or route="call" without one, exclude private clubs
BEFORE the cap, and hand booking to a human (needs_human).
"""

import pytest

from app.services.tee_times.routing import (
    RoutingTeeTimeProvider,
    _haversine_miles,
    _parse_latlng,
)
from app.services.tee_times.base import BookingDetails, TeeTimeQuery, TeeTimeSlot
from app.services.tee_times.selection import CourseSelector
from app.services.course_finder import deterministic_course_id


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
        "phone": "+14155551234",
        # No website / rating — OSM results often lack both.
    },
]

# Liberty National (near its `near` anchor) — must never reach the output.
_LIBERTY = {
    "id": "gplaces-liberty",
    "name": "Liberty National Golf Club",
    "address": "Jersey City, NJ",
    "center": {"lat": 40.7095, "lng": -74.0532},
    "website": "https://www.libertynationalgolfclub.com/",
    "rating": 4.9,
}


def _fake_finder(courses, origin=_ORIGIN):
    async def find(_query):
        return courses, origin
    return find


class TestSearchAvailability:
    async def test_one_route_entry_per_public_course(self):
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder(_COURSES))
        slots = await provider.search_availability(_query())

        assert len(slots) == 2
        assert all(s.provider == "routing" for s in slots)
        assert {s.course_name for s in slots} == {
            "Presidio Golf Course", "Lincoln Park Golf Course",
        }

    async def test_honest_core_no_fabricated_time_price_or_estimate(self):
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder(_COURSES))
        slots = await provider.search_availability(_query())
        assert all(s.time == "" for s in slots), "a synthesized time slot is a test failure"
        assert all(s.estimated is False for s in slots)
        assert all(s.price_usd is None for s in slots)

    async def test_route_book_on_site_when_website_known(self):
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder(_COURSES))
        slots = await provider.search_availability(_query())
        by_name = {s.course_name: s for s in slots}
        assert by_name["Presidio Golf Course"].route == "book_on_site"
        assert by_name["Presidio Golf Course"].booking_url == "https://www.presidiogolf.com/"

    async def test_route_call_when_no_website(self):
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder(_COURSES))
        slots = await provider.search_availability(_query())
        by_name = {s.course_name: s for s in slots}
        assert by_name["Lincoln Park Golf Course"].route == "call"
        assert by_name["Lincoln Park Golf Course"].booking_url is None

    async def test_phone_flows_from_course_dict_to_slot(self):
        # A "call" route (no website) with a phone in the discovered course
        # dict must carry through — the frontend `tel:` CTA depends on it.
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder(_COURSES))
        slots = await provider.search_availability(_query())
        by_name = {s.course_name: s for s in slots}
        assert by_name["Lincoln Park Golf Course"].phone == "+14155551234"

    async def test_phone_none_when_course_has_none(self):
        # Presidio's fixture carries no "phone" key — must not be fabricated.
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder(_COURSES))
        slots = await provider.search_availability(_query())
        by_name = {s.course_name: s for s in slots}
        assert by_name["Presidio Golf Course"].phone is None

    async def test_distance_computed_from_origin_and_sorted(self):
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder(_COURSES))
        slots = await provider.search_availability(_query())
        assert slots[0].course_name == "Presidio Golf Course"
        assert slots[0].distance_miles == 0.0
        assert slots[1].distance_miles > 0.0

    async def test_max_distance_filter(self):
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder(_COURSES))
        slots = await provider.search_availability(_query(max_distance_miles=1.0))
        # Lincoln Park is ~1.8 mi from the origin — filtered out.
        assert [s.course_name for s in slots] == ["Presidio Golf Course"]

    async def test_empty_finder_returns_empty_list(self):
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder([], origin=None))
        assert await provider.search_availability(_query()) == []

    async def test_finder_error_returns_empty_list_never_raises(self):
        async def boom(_query):
            raise RuntimeError("overpass down")
        provider = RoutingTeeTimeProvider(find_courses=boom)
        assert await provider.search_availability(_query()) == []

    async def test_skips_courses_without_id_or_name(self):
        bad = [{"name": "No Id Course", "center": {"lat": 1, "lng": 1}},
               {"id": "x1", "name": "", "center": {"lat": 1, "lng": 1}}]
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder(bad))
        assert await provider.search_availability(_query()) == []

    async def test_caps_course_count(self):
        many = [
            {"id": f"c{i}", "name": f"Course {i}", "center": {"lat": 37.79, "lng": -122.46}}
            for i in range(20)
        ]
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder(many))
        slots = await provider.search_availability(_query())
        assert len(slots) == 8

    async def test_private_club_never_reaches_output(self):
        courses = [*_COURSES, _LIBERTY]
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder(courses))
        slots = await provider.search_availability(_query())
        assert "Liberty National Golf Club" not in {s.course_name for s in slots}
        assert len(slots) == 2  # filtered BEFORE the cap, not just excluded post-hoc

    async def test_private_club_filtered_even_when_it_would_fill_the_cap(self):
        # 8 privates + 2 publics: filter runs before the cap, so both publics
        # still make it through (a naive filter-after-cap would drop them).
        privates = [{**_LIBERTY, "id": f"gplaces-liberty-{i}"} for i in range(8)]
        courses = privates + _COURSES
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder(courses))
        slots = await provider.search_availability(_query())
        assert {s.course_name for s in slots} == {
            "Presidio Golf Course", "Lincoln Park Golf Course",
        }


class TestBook:
    @pytest.fixture
    def slot(self) -> TeeTimeSlot:
        return TeeTimeSlot(
            id="gplaces-abc123-2026-07-04-route",
            course_id="gplaces-abc123",
            course_name="Presidio Golf Course",
            city="San Francisco, CA",
            date="2026-07-04",
            time="",
            players=4,
            price_usd=None,
            cart_included=False,
            distance_miles=0.0,
            rating=4.3,
            provider="routing",
            holes=18,
            booking_url="https://www.presidiogolf.com/",
            estimated=False,
            route="book_on_site",
        )

    async def test_book_returns_needs_human_with_url(self, slot):
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder(_COURSES))
        result = await provider.book(slot, BookingDetails(name="Owner", party_size=4))
        assert result.status == "needs_human"
        assert result.booking_url == "https://www.presidiogolf.com/"
        assert result.confirmation_number is None
        assert result.message and "Presidio Golf Course" in result.message

    async def test_book_without_url_still_needs_human(self, slot):
        slot.booking_url = None
        slot.route = "call"
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder(_COURSES))
        result = await provider.book(slot, BookingDetails(name="Owner", party_size=4))
        assert result.status == "needs_human"
        assert result.booking_url is None
        assert result.confirmation_number is None


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


class TestCourseSelectionFilter:
    """Wiring `TeeTimeQuery.course_ids` into the real provider loop
    (specs/teetime-course-ids-wiring-plan.md §6). The filter runs AFTER the
    private-club exclusion and BEFORE the MAX_COURSES cap."""

    async def test_selected_osm_id_keeps_only_that_course(self):
        # Realistic OSM-shaped dicts — NO "id" key, only "osm_id" (the actual
        # search_golf_courses shape). A naive `course_id in course_ids` filter
        # (built from `course.get("id") or course.get("osm_id")`) would work
        # here too, but this is the MANDATORY no-always-zero regression guard —
        # it must keep passing as candidate_ids grows more sources.
        courses = [
            {"osm_id": "way/101", "name": "Course One", "center": {"lat": 37.79, "lng": -122.46}},
            {"osm_id": "way/102", "name": "Course Two", "center": {"lat": 37.80, "lng": -122.47}},
            {"osm_id": "way/103", "name": "Course Three", "center": {"lat": 37.81, "lng": -122.48}},
        ]
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder(courses))
        slots = await provider.search_availability(_query(course_ids=["way/102"]))
        assert {s.course_name for s in slots} == {"Course Two"}

    async def test_empty_course_ids_returns_all(self):
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder(_COURSES))
        slots = await provider.search_availability(_query(course_ids=[]))
        assert len(slots) == 2

    async def test_mapped_only_uuid_selection_drops_honestly(self):
        import uuid

        unresolvable = str(uuid.uuid4())
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder(_COURSES))
        slots = await provider.search_availability(_query(course_ids=[unresolvable]))
        assert slots == []

    async def test_deterministic_uuid_selection_matches(self):
        courses = [{"osm_id": "way/102", "name": "Course Two", "center": {"lat": 37.80, "lng": -122.47}}]
        det_uuid = deterministic_course_id("osm-way/102")
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder(courses))
        slots = await provider.search_availability(_query(course_ids=[det_uuid]))
        assert {s.course_name for s in slots} == {"Course Two"}

    async def test_selector_name_and_proximity_matches(self):
        # Homegrown-mapped selection: the id the golfer selected (a slug-keyed
        # DB UUID) has no derivable relationship to the discovered course's
        # own id — only the resolved name+center selector rescues it.
        course = {"osm_id": "way/999", "name": "Homegrown Municipal", "center": {"lat": 40.745, "lng": -73.456}}
        near_selector = [CourseSelector(id="unrelated-uuid", name="Homegrown Municipal", lat=40.7451, lng=-73.4561)]
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder([course]))
        query = _query(course_ids=["unrelated-uuid"])
        query.course_selectors = near_selector
        slots = await provider.search_availability(query)
        assert {s.course_name for s in slots} == {"Homegrown Municipal"}

    async def test_selector_name_match_far_center_is_dropped(self):
        course = {"osm_id": "way/999", "name": "Homegrown Municipal", "center": {"lat": 40.745, "lng": -73.456}}
        far_selector = [CourseSelector(id="unrelated-uuid", name="Homegrown Municipal", lat=10.0, lng=10.0)]
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder([course]))
        query = _query(course_ids=["unrelated-uuid"])
        query.course_selectors = far_selector
        slots = await provider.search_availability(query)
        assert slots == []

    async def test_selection_filter_runs_before_cap(self):
        # 9 courses; select the farthest (index 8) — a filter-after-cap bug
        # would drop it since only 8 courses survive the cap.
        many = [
            {"id": f"c{i}", "name": f"Course {i}", "center": {"lat": 37.79 + i * 0.01, "lng": -122.46}}
            for i in range(9)
        ]
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder(many))
        slots = await provider.search_availability(_query(course_ids=["c8"]))
        assert {s.course_name for s in slots} == {"Course 8"}

    async def test_selected_private_course_still_excluded(self):
        courses = [*_COURSES, _LIBERTY]
        provider = RoutingTeeTimeProvider(find_courses=_fake_finder(courses))
        slots = await provider.search_availability(_query(course_ids=["gplaces-liberty"]))
        assert slots == []
