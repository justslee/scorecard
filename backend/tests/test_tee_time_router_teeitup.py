"""
Router ladder tests for the S4a ADAPTERS registry / TEETIME_ENGINES allowlist
(specs/teetime-availability-everywhere-plan.md §6).

`test_tee_time_router.py` (untouched) already pins the original S1 foreUP
ladder byte-identical — this file adds the NEW multi-platform legs: a
teeitup-platform capability dispatching through its own adapter, an unknown/
disabled platform degrading to the exact S0 entry, and the foreUP path
staying unchanged when a teeitup adapter is ALSO wired in (proving the two
engines don't interfere with each other).
"""

from __future__ import annotations

from app.services.tee_times.base import BookingDetails, TeeTimeQuery, TeeTimeSlot
from app.services.tee_times.capability_store import CourseBookingCapability
from app.services.tee_times.router_provider import RoutedTeeTimeProvider


def _query(**overrides) -> TeeTimeQuery:
    defaults = dict(
        date="2026-07-11",
        time_window_start="07:00",
        time_window_end="18:00",
        party_size=2,
        area="40.7594,-73.7359",
    )
    defaults.update(overrides)
    return TeeTimeQuery(**defaults)


_ORIGIN = (40.7594, -73.7359)

# Matches _TEEITUP_CAP below (name + within 1.0 mi).
_TEEITUP_MATCHED_COURSE = {
    "id": "gplaces-douglaston",
    "name": "Douglaston Golf Course",
    "address": "63-20 Marathon Pkwy, Little Neck, NY",
    "center": {"lat": 40.7595, "lng": -73.7360},
    "website": None,
    "rating": 3.9,
}

_PLAIN_COURSE = {
    "id": "gplaces-plain",
    "name": "Plain Public Course",
    "address": "Somewhere, NY",
    "center": {"lat": 40.77, "lng": -73.75},
    "website": "https://plainpublic.example.com/",
    "rating": 3.8,
}

_ALL_COURSES = [_TEEITUP_MATCHED_COURSE, _PLAIN_COURSE]

_TEEITUP_CAP = CourseBookingCapability(
    platform="teeitup", name="Douglaston Golf Course", lat=40.75944, lng=-73.73586,
    channel="api", platform_ids={"alias": "golf-nyc", "facility_id": "5044"},
    booking_url="https://golf-nyc.book.teeitup.com/", phone="(718) 224-6566",
    is_private=False, verified_at="2026-07-10T13:40:44Z", probe_status="verified",
)

_UNKNOWN_PLATFORM_CAP = CourseBookingCapability(
    platform="chronogolf", name="Douglaston Golf Course", lat=40.75944, lng=-73.73586,
    channel="scrape_http", platform_ids={"slug": "douglaston"},
)


def _fake_finder(courses=None, origin=_ORIGIN):
    courses = courses if courses is not None else _ALL_COURSES

    async def find(_query):
        return courses, origin
    return find


class FakeTeeItUp:
    """Scriptable fake TeeItUpProvider — records calls, returns a fixed value."""

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
                              message="fake teeitup book", booking_url=slot.booking_url)


class FakeForeUp:
    """Same shape as test_tee_time_router.py's — kept self-contained here so
    this file has zero import coupling to the pinned S1 test module."""

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
                              message="fake foreup book", booking_url=slot.booking_url)


def _real_teeitup_slot(cap: CourseBookingCapability, query: TeeTimeQuery, time: str, i: int = 0) -> TeeTimeSlot:
    return TeeTimeSlot(
        id=f"teeitup-{cap.platform_ids['alias']}-{cap.platform_ids['facility_id']}-{query.date}-{time}-{i}",
        course_id=f"teeitup-{cap.platform_ids['alias']}-{cap.platform_ids['facility_id']}",
        course_name=cap.name,
        city="Little Neck, NY",
        date=query.date,
        time=time,
        players=query.party_size,
        price_usd=45.0,
        cart_included=False,
        distance_miles=0.1,
        rating=3.9,
        provider="teeitup",
        holes=18,
        booking_url=cap.booking_url,
        route=None,
        phone=cap.phone,
    )


def _provider(
    *, teeitup=None, foreup=None, caps=(_TEEITUP_CAP,), courses=None,
    foreup_enabled=None, engines_enabled=None,
) -> RoutedTeeTimeProvider:
    return RoutedTeeTimeProvider(
        find_courses=_fake_finder(courses),
        teeitup=teeitup or FakeTeeItUp(result=[]),
        foreup=foreup or FakeForeUp(result=[]),
        capabilities=lambda: caps,
        foreup_enabled=foreup_enabled,
        engines_enabled=engines_enabled,
    )


class TestMatchedTeeItUpCourseGetsRealSlots:
    async def test_matched_course_has_real_teeitup_slots(self):
        fake = FakeTeeItUp()
        fake.result = lambda cap, query: [
            _real_teeitup_slot(cap, query, "10:15"), _real_teeitup_slot(cap, query, "11:00", 1),
        ]
        provider = _provider(teeitup=fake)
        slots = await provider.search_availability(_query())

        matched = [s for s in slots if s.course_name == "Douglaston Golf Course"]
        assert len(matched) == 2
        assert all(s.time != "" for s in matched)
        assert all(s.provider == "teeitup" for s in matched)
        assert all(s.route is None for s in matched)
        assert fake.calls  # teeitup WAS consulted

    async def test_unmatched_course_gets_exact_s0_entry(self):
        fake = FakeTeeItUp()
        fake.result = lambda cap, query: [_real_teeitup_slot(cap, query, "10:15")]
        provider = _provider(teeitup=fake)
        slots = await provider.search_availability(_query())

        by_name = {s.course_name: s for s in slots}
        assert by_name["Plain Public Course"].time == ""
        assert by_name["Plain Public Course"].route == "book_on_site"
        assert by_name["Plain Public Course"].booking_url == "https://plainpublic.example.com/"


class TestTeeItUpVerifiedEmptyOmits:
    async def test_empty_list_from_teeitup_omits_the_course(self):
        fake = FakeTeeItUp(result=[])
        provider = _provider(teeitup=fake)
        slots = await provider.search_availability(_query())
        assert "Douglaston Golf Course" not in {s.course_name for s in slots}
        assert "Plain Public Course" in {s.course_name for s in slots}


class TestTeeItUpCouldntCheckDegrades:
    async def test_none_from_teeitup_yields_degraded_route_entry(self):
        fake = FakeTeeItUp(result=None)
        provider = _provider(teeitup=fake)
        slots = await provider.search_availability(_query())

        matched = [s for s in slots if s.course_name == "Douglaston Golf Course"]
        assert len(matched) == 1
        entry = matched[0]
        assert entry.time == ""
        assert entry.route == "book_on_site"
        assert entry.booking_url == _TEEITUP_CAP.booking_url
        assert entry.phone == _TEEITUP_CAP.phone


class TestUnknownPlatformFallsBackToS0:
    async def test_no_registered_adapter_behaves_like_no_capability_match(self):
        fake = FakeTeeItUp(result=[_real_teeitup_slot(_TEEITUP_CAP, _query(), "10:15")])
        provider = _provider(teeitup=fake, caps=(_UNKNOWN_PLATFORM_CAP,))
        slots = await provider.search_availability(_query())

        by_name = {s.course_name: s for s in slots}
        # "Douglaston Golf Course" course dict isn't in _ALL_COURSES for this
        # cap, but the point stands generically: an unmatched platform never
        # calls any adapter.
        assert fake.calls == []
        assert by_name["Plain Public Course"].route == "book_on_site"


class TestEnginesAllowlist:
    async def test_teeitup_excluded_from_allowlist_degrades_to_s0(self):
        fake = FakeTeeItUp(result=[_real_teeitup_slot(_TEEITUP_CAP, _query(), "10:15")])
        provider = _provider(teeitup=fake, engines_enabled={"foreup"})
        slots = await provider.search_availability(_query())

        assert fake.calls == []  # teeitup adapter never consulted — not in the allowlist
        matched = [s for s in slots if s.course_name == "Douglaston Golf Course"]
        assert len(matched) == 1
        # Exact S0 shape (build_route_entry on the discovered course dict,
        # which has no website) — NOT the cap-aware "couldn't check" override
        # (that only fires when an adapter was actually consulted and timed
        # out/errored; "engine disabled" is treated identically to "no
        # capability match at all").
        assert matched[0].route == "call"
        assert matched[0].booking_url is None
        assert matched[0].provider == "routing"

    async def test_allowlist_including_teeitup_still_dispatches(self):
        fake = FakeTeeItUp()
        fake.result = lambda cap, query: [_real_teeitup_slot(cap, query, "10:15")]
        provider = _provider(teeitup=fake, engines_enabled={"foreup", "teeitup"})
        slots = await provider.search_availability(_query())
        matched = [s for s in slots if s.course_name == "Douglaston Golf Course"]
        assert len(matched) == 1
        assert matched[0].provider == "teeitup"
        assert fake.calls


class TestForeupPathUnchangedWithTeeitupAdapterPresent:
    """foreUP dispatch must be completely unaffected by teeitup ALSO being
    wired into the same router instance — proves the two engines don't
    shadow or interfere with each other."""

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
        teeitup_fake = FakeTeeItUp(result=[])

        provider = RoutedTeeTimeProvider(
            find_courses=_fake_finder([self._FOREUP_COURSE], origin=(42.7143, -78.8131)),
            foreup=foreup_fake, teeitup=teeitup_fake,
            capabilities=lambda: (self._FOREUP_CAP,),
        )
        slots = await provider.search_availability(
            _query(area="42.7143,-78.8131"),
        )
        matched = [s for s in slots if s.course_name == "18 Mile Creek Golf Course"]
        assert len(matched) == 1
        assert matched[0].provider == "foreup"
        assert foreup_fake.calls
        assert teeitup_fake.calls == []  # teeitup never touched for a foreup capability


class TestTeeItUpBookDispatch:
    async def test_teeitup_slot_dispatches_to_fake_book(self):
        fake = FakeTeeItUp(result=[])
        provider = _provider(teeitup=fake)
        slot = _real_teeitup_slot(_TEEITUP_CAP, _query(), "10:15")
        result = await provider.book(slot, BookingDetails(name="Owner", party_size=2))
        assert len(fake.book_calls) == 1
        assert result.message == "fake teeitup book"
        assert result.status == "needs_human"
        assert result.confirmation_number is None

    async def test_teeitup_slot_never_confirms_with_the_real_teeitup_provider(self):
        from app.services.tee_times.adapters.teeitup import TeeItUpProvider

        provider = _provider(teeitup=TeeItUpProvider(capabilities=lambda: (_TEEITUP_CAP,)))
        slot = _real_teeitup_slot(_TEEITUP_CAP, _query(), "10:15")
        result = await provider.book(slot, BookingDetails(name="Owner", party_size=2))
        assert result.status == "needs_human"
        assert result.confirmation_number is None
        assert result.booking_url == _TEEITUP_CAP.booking_url
