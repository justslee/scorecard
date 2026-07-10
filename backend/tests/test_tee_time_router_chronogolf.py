"""
Router ladder tests for the S4c Chronogolf adapter registration
(specs/teetime-availability-everywhere-plan.md §3/§6).

`test_tee_time_router_teeitup.py` (untouched) already pins the teeitup ladder
legs; this file adds the analogous NEW legs for chronogolf: `ADAPTERS`
resolves it, a chronogolf-platform capability dispatches through its own
adapter (never through foreup/teeitup), verified-empty omits, "couldn't
check" degrades, and the foreup/teeitup paths stay unaffected when a
chronogolf adapter is ALSO wired into the same router instance.
"""

from __future__ import annotations

from app.services.tee_times.base import BookingDetails, TeeTimeQuery, TeeTimeSlot
from app.services.tee_times.capability_store import CourseBookingCapability
from app.services.tee_times.router_provider import ADAPTERS, RoutedTeeTimeProvider


def _query(**overrides) -> TeeTimeQuery:
    defaults = dict(
        date="2026-07-13",
        time_window_start="07:00",
        time_window_end="18:00",
        party_size=2,
        area="40.768991,-74.264034",
    )
    defaults.update(overrides)
    return TeeTimeQuery(**defaults)


_ORIGIN = (40.768991, -74.264034)

_CHRONOGOLF_MATCHED_COURSE = {
    "id": "gplaces-rockspring",
    "name": "Rock Spring Golf Club at West Orange",
    "address": "153 Old Turnpike Rd, West Orange, NJ",
    "center": {"lat": 40.7690, "lng": -74.2640},
    "website": None,
    "rating": 4.0,
}

_PLAIN_COURSE = {
    "id": "gplaces-plain",
    "name": "Plain Public Course",
    "address": "Somewhere, NJ",
    "center": {"lat": 40.80, "lng": -74.30},
    "website": "https://plainpublic.example.com/",
    "rating": 3.8,
}

_ALL_COURSES = [_CHRONOGOLF_MATCHED_COURSE, _PLAIN_COURSE]

_CHRONOGOLF_CAP = CourseBookingCapability(
    platform="chronogolf", name="Rock Spring Golf Club at West Orange",
    lat=40.768991, lng=-74.264034,
    channel="scrape_http",
    platform_ids={"club_id": "10038", "course_id": "11517", "affiliation_type_id": "40974"},
    booking_url="https://www.chronogolf.com/club/rock-spring-golf-club-at-west-orange",
    phone="(973) 731-6464", is_private=False, verified_at="2026-07-10T00:00:00Z",
    probe_status="verified",
)


def _fake_finder(courses=None, origin=_ORIGIN):
    courses = courses if courses is not None else _ALL_COURSES

    async def find(_query):
        return courses, origin
    return find


class FakeChronogolf:
    """Scriptable fake ChronogolfProvider — records calls, returns a fixed value."""

    def __init__(self, result=None):
        self.result = result   # list[TeeTimeSlot] | None | callable
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
                              message="fake chronogolf book", booking_url=slot.booking_url)


class FakeTeeItUp:
    def __init__(self, result=None):
        self.result = result
        self.calls: list[tuple] = []

    async def slots_for_capability(self, cap, query, *, distance_miles=0.0, course=None):
        self.calls.append((cap, query, distance_miles, course))
        if callable(self.result):
            return self.result(cap, query)
        return self.result

    async def book(self, slot, details):
        from app.services.tee_times.base import BookingResult
        return BookingResult(status="needs_human", booking_url=slot.booking_url)


class FakeForeUp:
    def __init__(self, result=None):
        self.result = result
        self.calls: list[tuple] = []

    async def slots_for_capability(self, cap, query, *, distance_miles=0.0, course=None):
        self.calls.append((cap, query, distance_miles, course))
        if callable(self.result):
            return self.result(cap, query)
        return self.result

    async def book(self, slot, details):
        from app.services.tee_times.base import BookingResult
        return BookingResult(status="needs_human", booking_url=slot.booking_url)


def _real_chronogolf_slot(cap: CourseBookingCapability, query: TeeTimeQuery, time: str, i: int = 0) -> TeeTimeSlot:
    club_id = cap.platform_ids["club_id"]
    course_id = cap.platform_ids["course_id"]
    return TeeTimeSlot(
        id=f"chronogolf-{club_id}-{course_id}-{query.date}-{time}-{i}",
        course_id=f"chronogolf-{club_id}-{course_id}",
        course_name=cap.name,
        city="West Orange, NJ",
        date=query.date,
        time=time,
        players=query.party_size,
        price_usd=109.0,
        cart_included=False,
        distance_miles=0.1,
        rating=4.0,
        provider="chronogolf",
        holes=18,
        booking_url=cap.booking_url,
        route=None,
        phone=cap.phone,
    )


def _provider(
    *, chronogolf=None, teeitup=None, foreup=None, caps=(_CHRONOGOLF_CAP,), courses=None,
) -> RoutedTeeTimeProvider:
    return RoutedTeeTimeProvider(
        find_courses=_fake_finder(courses),
        chronogolf=chronogolf or FakeChronogolf(result=[]),
        teeitup=teeitup or FakeTeeItUp(result=[]),
        foreup=foreup or FakeForeUp(result=[]),
        capabilities=lambda: caps,
    )


def test_chronogolf_registered_in_adapters_registry():
    assert "chronogolf" in ADAPTERS
    from app.services.tee_times.adapters.chronogolf import ChronogolfProvider
    assert isinstance(ADAPTERS["chronogolf"], ChronogolfProvider)


class TestMatchedChronogolfCourseGetsRealSlots:
    async def test_matched_course_has_real_chronogolf_slots(self):
        fake = FakeChronogolf()
        fake.result = lambda cap, query: [
            _real_chronogolf_slot(cap, query, "07:30"), _real_chronogolf_slot(cap, query, "08:30", 1),
        ]
        provider = _provider(chronogolf=fake)
        slots = await provider.search_availability(_query())

        matched = [s for s in slots if s.course_name == "Rock Spring Golf Club at West Orange"]
        assert len(matched) == 2
        assert all(s.time != "" for s in matched)
        assert all(s.provider == "chronogolf" for s in matched)
        assert all(s.route is None for s in matched)
        assert fake.calls  # chronogolf WAS consulted

    async def test_unmatched_course_gets_exact_s0_entry(self):
        fake = FakeChronogolf()
        fake.result = lambda cap, query: [_real_chronogolf_slot(cap, query, "07:30")]
        provider = _provider(chronogolf=fake)
        slots = await provider.search_availability(_query())

        by_name = {s.course_name: s for s in slots}
        assert by_name["Plain Public Course"].time == ""
        assert by_name["Plain Public Course"].route == "book_on_site"
        assert by_name["Plain Public Course"].booking_url == "https://plainpublic.example.com/"


class TestChronogolfVerifiedEmptyOmits:
    async def test_empty_list_from_chronogolf_omits_the_course(self):
        fake = FakeChronogolf(result=[])
        provider = _provider(chronogolf=fake)
        slots = await provider.search_availability(_query())
        assert "Rock Spring Golf Club at West Orange" not in {s.course_name for s in slots}
        assert "Plain Public Course" in {s.course_name for s in slots}


class TestChronogolfCouldntCheckDegrades:
    async def test_none_from_chronogolf_yields_degraded_route_entry(self):
        fake = FakeChronogolf(result=None)
        provider = _provider(chronogolf=fake)
        slots = await provider.search_availability(_query())

        matched = [s for s in slots if s.course_name == "Rock Spring Golf Club at West Orange"]
        assert len(matched) == 1
        entry = matched[0]
        assert entry.time == ""
        assert entry.route == "book_on_site"
        assert entry.booking_url == _CHRONOGOLF_CAP.booking_url
        assert entry.phone == _CHRONOGOLF_CAP.phone


class TestForeupTeeitupPathsUnaffectedWithChronogolfAdapterPresent:
    """foreup/teeitup dispatch must be completely unaffected by chronogolf
    ALSO being wired into the same router instance."""

    _FOREUP_CAP = CourseBookingCapability(
        platform="foreup", course_id=None, name="18 Mile Creek Golf Course",
        lat=42.714304, lng=-78.813114,
        platform_ids={"booking_id": "20410", "schedule_id": "4467"},
        foreup_booking_id="20410", schedule_id="4467",
        booking_url="https://foreupsoftware.com/index.php/booking/20410/4467",
        phone="(716) 648-4410", is_private=False, verified_at="2026-07-09T00:00:00Z",
    )

    _FOREUP_COURSE = {
        "id": "gplaces-18mile",
        "name": "18 Mile Creek Golf Course",
        "address": "6374 Boston State Rd, Hamburg, NY",
        "center": {"lat": 42.7150, "lng": -78.8140},
        "website": None,
        "rating": 4.1,
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

    async def test_foreup_cap_still_dispatches_to_foreup_adapter_only(self):
        foreup_fake = FakeForeUp()
        foreup_fake.result = lambda cap, query: [self._real_foreup_slot(cap, query, "10:00")]
        chronogolf_fake = FakeChronogolf(result=[])
        teeitup_fake = FakeTeeItUp(result=[])

        provider = RoutedTeeTimeProvider(
            find_courses=_fake_finder([self._FOREUP_COURSE], origin=(42.7143, -78.8131)),
            foreup=foreup_fake, teeitup=teeitup_fake, chronogolf=chronogolf_fake,
            capabilities=lambda: (self._FOREUP_CAP,),
        )
        slots = await provider.search_availability(
            _query(area="42.7143,-78.8131"),
        )
        matched = [s for s in slots if s.course_name == "18 Mile Creek Golf Course"]
        assert len(matched) == 1
        assert matched[0].provider == "foreup"
        assert foreup_fake.calls
        assert chronogolf_fake.calls == []  # chronogolf never touched for a foreup capability
        assert teeitup_fake.calls == []


class TestChronogolfBookDispatch:
    async def test_chronogolf_slot_dispatches_to_fake_book(self):
        fake = FakeChronogolf(result=[])
        provider = _provider(chronogolf=fake)
        slot = _real_chronogolf_slot(_CHRONOGOLF_CAP, _query(), "07:30")
        result = await provider.book(slot, BookingDetails(name="Owner", party_size=2))
        assert len(fake.book_calls) == 1
        assert result.message == "fake chronogolf book"
        assert result.status == "needs_human"
        assert result.confirmation_number is None

    async def test_chronogolf_slot_never_confirms_with_the_real_chronogolf_provider(self):
        from app.services.tee_times.adapters.chronogolf import ChronogolfProvider

        provider = _provider(chronogolf=ChronogolfProvider(capabilities=lambda: (_CHRONOGOLF_CAP,)))
        slot = _real_chronogolf_slot(_CHRONOGOLF_CAP, _query(), "07:30")
        result = await provider.book(slot, BookingDetails(name="Owner", party_size=2))
        assert result.status == "needs_human"
        assert result.confirmation_number is None
        assert result.booking_url == _CHRONOGOLF_CAP.booking_url
