"""
Router ladder tests for the H1 Club Prophet (CPS) adapter registration
(specs/teetime-headless-scraper-plan.md §6/H1).

Mirrors test_tee_time_router_chronogolf.py: `ADAPTERS` resolves clubprophet, a
clubprophet-platform capability dispatches through its own adapter (never
through foreup/teeitup/chronogolf), verified-empty omits, "couldn't check"
degrades, and the other engines' paths stay unaffected when a clubprophet
adapter is ALSO wired into the same router instance.
"""

from __future__ import annotations

from app.services.tee_times.base import BookingDetails, TeeTimeQuery, TeeTimeSlot
from app.services.tee_times.capability_store import CourseBookingCapability
from app.services.tee_times.router_provider import ADAPTERS, RoutedTeeTimeProvider


def _query(**overrides) -> TeeTimeQuery:
    defaults = dict(
        date="2026-07-16",
        time_window_start="06:00",
        time_window_end="20:00",
        party_size=2,
        area="40.8267871,-73.6711179",
    )
    defaults.update(overrides)
    return TeeTimeQuery(**defaults)


_ORIGIN = (40.8267871, -73.6711179)

_CPS_MATCHED_COURSE = {
    "id": "gplaces-harborlinks",
    "name": "Harbor Links Golf Course",
    "address": "1 W Fairway Dr, Port Washington, NY",
    "center": {"lat": 40.8268, "lng": -73.6711},
    "website": None,
    "rating": 4.0,
}

_PLAIN_COURSE = {
    "id": "gplaces-plain",
    "name": "Plain Public Course",
    "address": "Somewhere, NY",
    "center": {"lat": 40.90, "lng": -73.60},
    "website": "https://plainpublic.example.com/",
    "rating": 3.8,
}

_ALL_COURSES = [_CPS_MATCHED_COURSE, _PLAIN_COURSE]

_CPS_CAP = CourseBookingCapability(
    platform="clubprophet", name="Harbor Links Golf Course",
    lat=40.8267871, lng=-73.6711179,
    channel="scrape_http",
    platform_ids={
        "host": "harborlinksgc.cps.golf",
        "authority_base_url": "https://harborlinksgc.cps.golf/identityapi",
        "online_api": "https://harborlinksgc.cps.golf/onlineres/onlineapi/api/v1/onlinereservation",
        "course_id": "1",
    },
    booking_url="https://harborlinksgc.cps.golf/onlineresweb/",
    phone="(516) 767-4816", is_private=False, verified_at="2026-07-10T21:00:00Z",
    probe_status="verified",
)


def _fake_finder(courses=None, origin=_ORIGIN):
    courses = courses if courses is not None else _ALL_COURSES

    async def find(_query):
        return courses, origin
    return find


class _FakeAdapter:
    """Scriptable fake provider — records calls, returns a fixed value."""

    def __init__(self, result=None):
        self.result = result
        self.calls: list[tuple] = []
        self.book_calls: list[tuple] = []

    async def slots_for_capability(self, cap, query, *, distance_miles=0.0, course=None):
        self.calls.append((cap, query, distance_miles, course))
        if callable(self.result):
            return self.result(cap, query)
        return self.result

    async def book(self, slot, details):
        self.book_calls.append((slot, details))
        from app.services.tee_times.base import BookingResult
        return BookingResult(status="needs_human", confirmation_number=None,
                             message="fake clubprophet book", booking_url=slot.booking_url)


def _real_cps_slot(cap: CourseBookingCapability, query: TeeTimeQuery, time: str, i: int = 0) -> TeeTimeSlot:
    host = cap.platform_ids["host"]
    cid = cap.platform_ids["course_id"]
    return TeeTimeSlot(
        id=f"clubprophet-{host}-{cid}-{query.date}-{time}-{i}",
        course_id=f"clubprophet-{host}-{cid}",
        course_name=cap.name, city="Port Washington, NY", date=query.date, time=time,
        players=query.party_size, price_usd=71.0, cart_included=False,
        distance_miles=0.1, rating=4.0, provider="clubprophet", holes=18,
        booking_url=cap.booking_url, route=None, phone=cap.phone,
    )


def _provider(*, clubprophet=None, caps=(_CPS_CAP,), courses=None) -> RoutedTeeTimeProvider:
    return RoutedTeeTimeProvider(
        find_courses=_fake_finder(courses),
        clubprophet=clubprophet or _FakeAdapter(result=[]),
        teeitup=_FakeAdapter(result=[]),
        foreup=_FakeAdapter(result=[]),
        chronogolf=_FakeAdapter(result=[]),
        capabilities=lambda: caps,
    )


def test_clubprophet_registered_in_adapters_registry():
    assert "clubprophet" in ADAPTERS
    from app.services.tee_times.adapters.clubprophet import ClubProphetProvider
    assert isinstance(ADAPTERS["clubprophet"], ClubProphetProvider)


class TestMatchedCpsCourseGetsRealSlots:
    async def test_matched_course_has_real_cps_slots(self):
        fake = _FakeAdapter()
        fake.result = lambda cap, query: [
            _real_cps_slot(cap, query, "07:30"), _real_cps_slot(cap, query, "08:30", 1),
        ]
        provider = _provider(clubprophet=fake)
        slots = await provider.search_availability(_query())
        matched = [s for s in slots if s.course_name == "Harbor Links Golf Course"]
        assert len(matched) == 2
        assert all(s.time != "" for s in matched)
        assert all(s.provider == "clubprophet" for s in matched)
        assert all(s.route is None for s in matched)
        assert fake.calls  # clubprophet WAS consulted

    async def test_unmatched_course_gets_exact_s0_entry(self):
        fake = _FakeAdapter()
        fake.result = lambda cap, query: [_real_cps_slot(cap, query, "07:30")]
        provider = _provider(clubprophet=fake)
        slots = await provider.search_availability(_query())
        by_name = {s.course_name: s for s in slots}
        assert by_name["Plain Public Course"].time == ""
        assert by_name["Plain Public Course"].route == "book_on_site"
        assert by_name["Plain Public Course"].booking_url == "https://plainpublic.example.com/"


class TestCpsVerifiedEmptyOmits:
    async def test_empty_list_omits_the_course(self):
        provider = _provider(clubprophet=_FakeAdapter(result=[]))
        slots = await provider.search_availability(_query())
        assert "Harbor Links Golf Course" not in {s.course_name for s in slots}
        assert "Plain Public Course" in {s.course_name for s in slots}


class TestCpsCouldntCheckDegrades:
    async def test_none_yields_degraded_route_entry(self):
        provider = _provider(clubprophet=_FakeAdapter(result=None))
        slots = await provider.search_availability(_query())
        matched = [s for s in slots if s.course_name == "Harbor Links Golf Course"]
        assert len(matched) == 1
        entry = matched[0]
        assert entry.time == ""
        assert entry.route == "book_on_site"
        assert entry.booking_url == _CPS_CAP.booking_url
        assert entry.phone == _CPS_CAP.phone


class TestOtherEnginesUnaffected:
    _FOREUP_CAP = CourseBookingCapability(
        platform="foreup", course_id=None, name="18 Mile Creek Golf Course",
        lat=42.714304, lng=-78.813114,
        platform_ids={"booking_id": "20410", "schedule_id": "4467"},
        foreup_booking_id="20410", schedule_id="4467",
        booking_url="https://foreupsoftware.com/index.php/booking/20410/4467",
        phone="(716) 648-4410", is_private=False, verified_at="2026-07-09T00:00:00Z",
    )

    _FOREUP_COURSE = {
        "id": "gplaces-18mile", "name": "18 Mile Creek Golf Course",
        "address": "6374 Boston State Rd, Hamburg, NY",
        "center": {"lat": 42.7150, "lng": -78.8140}, "website": None, "rating": 4.1,
    }

    def _real_foreup_slot(self, cap, query, time, i=0) -> TeeTimeSlot:
        return TeeTimeSlot(
            id=f"foreup-{cap.foreup_booking_id}-{query.date}-{time}-{i}",
            course_id=f"foreup-{cap.foreup_booking_id}",
            course_name=cap.name, city="Hamburg, NY", date=query.date, time=time,
            players=query.party_size, price_usd=24.0, cart_included=False,
            distance_miles=0.1, rating=4.1, provider="foreup", holes=18,
            booking_url=cap.booking_url, route=None, phone=cap.phone,
        )

    async def test_foreup_cap_still_dispatches_to_foreup_only(self):
        foreup_fake = _FakeAdapter()
        foreup_fake.result = lambda cap, query: [self._real_foreup_slot(cap, query, "10:00")]
        cps_fake = _FakeAdapter(result=[])
        provider = RoutedTeeTimeProvider(
            find_courses=_fake_finder([self._FOREUP_COURSE], origin=(42.7143, -78.8131)),
            foreup=foreup_fake, teeitup=_FakeAdapter(result=[]),
            chronogolf=_FakeAdapter(result=[]), clubprophet=cps_fake,
            capabilities=lambda: (self._FOREUP_CAP,),
        )
        slots = await provider.search_availability(_query(area="42.7143,-78.8131"))
        matched = [s for s in slots if s.course_name == "18 Mile Creek Golf Course"]
        assert len(matched) == 1
        assert matched[0].provider == "foreup"
        assert foreup_fake.calls
        assert cps_fake.calls == []  # clubprophet never touched for a foreup capability


class TestCpsBookDispatch:
    async def test_cps_slot_dispatches_to_fake_book(self):
        fake = _FakeAdapter(result=[])
        provider = _provider(clubprophet=fake)
        slot = _real_cps_slot(_CPS_CAP, _query(), "07:30")
        result = await provider.book(slot, BookingDetails(name="Owner", party_size=2))
        assert len(fake.book_calls) == 1
        assert result.message == "fake clubprophet book"
        assert result.status == "needs_human"
        assert result.confirmation_number is None

    async def test_cps_slot_never_confirms_with_real_provider(self):
        from app.services.tee_times.adapters.clubprophet import ClubProphetProvider
        provider = _provider(clubprophet=ClubProphetProvider(capabilities=lambda: (_CPS_CAP,)))
        slot = _real_cps_slot(_CPS_CAP, _query(), "07:30")
        result = await provider.book(slot, BookingDetails(name="Owner", party_size=2))
        assert result.status == "needs_human"
        assert result.confirmation_number is None
        assert result.booking_url == _CPS_CAP.booking_url
