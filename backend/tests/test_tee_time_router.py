"""
Tests for RoutedTeeTimeProvider (specs/teetime-s1-foreup-plan.md §8d).

An injected finder (S0 test style) returns a mix of: a course matching the 18
Mile Creek capability (name + nearby center), a plain public course with a
website, a website-less course, and Liberty National (private). A fake
ForeUpProvider records calls and returns a scriptable value so every leg of
§5c's fallback order can be exercised without any network.
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
        area="42.7143,-78.8131",
    )
    defaults.update(overrides)
    return TeeTimeQuery(**defaults)


_ORIGIN = (42.7143, -78.8131)

# Matches the capability below (name + within 1.0 mi).
_MATCHED_COURSE = {
    "id": "gplaces-18mile",
    "name": "18 Mile Creek Golf Course",
    "address": "6374 Boston State Rd, Hamburg, NY",
    "center": {"lat": 42.7150, "lng": -78.8140},
    "website": None,
    "rating": 4.1,
}

_PLAIN_COURSE = {
    "id": "gplaces-plain",
    "name": "Plain Public Course",
    "address": "Somewhere, NY",
    "center": {"lat": 42.72, "lng": -78.82},
    "website": "https://plainpublic.example.com/",
    "rating": 3.8,
}

_NO_WEBSITE_COURSE = {
    "osm_id": "way/999",
    "name": "No Website Municipal Course",
    "address": "Nowhere, NY",
    "center": {"lat": 42.73, "lng": -78.79},
    "phone": "+17165551212",
}

_LIBERTY_NATIONAL = {
    "id": "gplaces-liberty",
    "name": "Liberty National Golf Club",
    "address": "Jersey City, NJ",
    "center": {"lat": 40.7095, "lng": -74.0532},
    "website": "https://www.libertynationalgolfclub.com/",
    "rating": 4.9,
}

_ALL_COURSES = [_MATCHED_COURSE, _PLAIN_COURSE, _NO_WEBSITE_COURSE, _LIBERTY_NATIONAL]

_CAP = CourseBookingCapability(
    platform="foreup", course_id=None, foreup_booking_id="20410", schedule_id="4467",
    booking_url="https://foreupsoftware.com/index.php/booking/20410/4467",
    phone="(716) 648-4410", is_private=False, verified_at="2026-07-09T00:00:00Z",
    name="18 Mile Creek Golf Course", lat=42.714304, lng=-78.813114,
)

_PRIVATE_CAP = CourseBookingCapability(
    platform="foreup", course_id=None, foreup_booking_id="1", schedule_id="1",
    booking_url="https://foreupsoftware.com/index.php/booking/1/1",
    phone=None, is_private=True, verified_at="2026-07-09T00:00:00Z",
    name="18 Mile Creek Golf Course", lat=42.714304, lng=-78.813114,
)


def _fake_finder(courses=None, origin=_ORIGIN):
    courses = courses if courses is not None else _ALL_COURSES

    async def find(_query):
        return courses, origin
    return find


class FakeForeUp:
    """Scriptable fake ForeUpProvider — records calls, returns a fixed value."""

    def __init__(self, result=None):
        self.result = result   # list[TeeTimeSlot] | None | list-generator fn
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


def _real_slot(cap: CourseBookingCapability, query: TeeTimeQuery, time: str, i: int = 0) -> TeeTimeSlot:
    return TeeTimeSlot(
        id=f"foreup-{cap.foreup_booking_id}-{query.date}-{time}-{i}",
        course_id=f"foreup-{cap.foreup_booking_id}",
        course_name=cap.name,
        city="Hamburg, NY",
        date=query.date,
        time=time,
        players=query.party_size,
        price_usd=24.0,
        cart_included=False,
        distance_miles=0.1,
        rating=4.1,
        provider="foreup",
        holes=18,
        booking_url=cap.booking_url,
        route=None,
        phone=cap.phone,
    )


def _provider(*, foreup=None, caps=(_CAP,), courses=None, foreup_enabled=None) -> RoutedTeeTimeProvider:
    return RoutedTeeTimeProvider(
        find_courses=_fake_finder(courses),
        foreup=foreup or FakeForeUp(result=[]),
        capabilities=lambda: caps,
        foreup_enabled=foreup_enabled,
    )


class TestMatchedCourseGetsRealSlots:
    async def test_matched_course_has_real_foreup_slots(self):
        fake = FakeForeUp()
        fake.result = lambda cap, query: [_real_slot(cap, query, "10:00"), _real_slot(cap, query, "11:00", 1)]
        provider = _provider(foreup=fake)
        slots = await provider.search_availability(_query())

        matched = [s for s in slots if s.course_name == "18 Mile Creek Golf Course"]
        assert len(matched) == 2
        assert all(s.time != "" for s in matched)
        assert all(s.provider == "foreup" for s in matched)
        assert all(s.route is None for s in matched)

    async def test_unmatched_public_courses_get_exact_s0_entries(self):
        fake = FakeForeUp()
        fake.result = lambda cap, query: [_real_slot(cap, query, "10:00")]
        provider = _provider(foreup=fake)
        slots = await provider.search_availability(_query())

        by_name = {s.course_name: s for s in slots}
        assert by_name["Plain Public Course"].time == ""
        assert by_name["Plain Public Course"].route == "book_on_site"
        assert by_name["Plain Public Course"].booking_url == "https://plainpublic.example.com/"
        assert by_name["No Website Municipal Course"].time == ""
        assert by_name["No Website Municipal Course"].route == "call"
        assert by_name["No Website Municipal Course"].phone == "+17165551212"

    async def test_liberty_national_absent(self):
        fake = FakeForeUp()
        fake.result = lambda cap, query: [_real_slot(cap, query, "10:00")]
        provider = _provider(foreup=fake)
        slots = await provider.search_availability(_query())
        assert "Liberty National Golf Club" not in {s.course_name for s in slots}


class TestVerifiedEmptyOmitsCourse:
    async def test_empty_list_from_foreup_omits_the_course(self):
        fake = FakeForeUp(result=[])
        provider = _provider(foreup=fake)
        slots = await provider.search_availability(_query())
        assert "18 Mile Creek Golf Course" not in {s.course_name for s in slots}
        # Other public courses still present.
        assert "Plain Public Course" in {s.course_name for s in slots}


class TestCouldntCheckDegradesToRouteEntry:
    async def test_none_from_foreup_yields_degraded_route_entry(self):
        fake = FakeForeUp(result=None)
        provider = _provider(foreup=fake)
        slots = await provider.search_availability(_query())

        matched = [s for s in slots if s.course_name == "18 Mile Creek Golf Course"]
        assert len(matched) == 1
        entry = matched[0]
        assert entry.time == ""
        assert entry.route == "book_on_site"
        assert entry.booking_url == _CAP.booking_url
        assert entry.phone == _CAP.phone


class TestPrivateCapabilityExcludes:
    async def test_is_private_excludes_even_though_finder_returned_it(self):
        fake = FakeForeUp(result=[TeeTimeSlot(
            id="x", course_id="x", course_name="x", city="", date="2026-07-11",
            time="10:00", players=2, price_usd=None, cart_included=False,
            distance_miles=0.0, rating=0.0, provider="foreup", holes=18,
        )])
        provider = _provider(foreup=fake, caps=(_PRIVATE_CAP,))
        slots = await provider.search_availability(_query())
        assert "18 Mile Creek Golf Course" not in {s.course_name for s in slots}
        assert fake.calls == []  # never even called — is_private short-circuits


class TestKillSwitch:
    async def test_foreup_disabled_never_calls_fake_matches_plain_routing(self):
        fake = FakeForeUp(result=[_real_slot(_CAP, _query(), "10:00")])
        routed = _provider(foreup=fake, foreup_enabled=False)
        routed_slots = await routed.search_availability(_query())
        assert fake.calls == []

        from app.services.tee_times.routing import RoutingTeeTimeProvider
        plain = RoutingTeeTimeProvider(find_courses=_fake_finder())
        plain_slots = await plain.search_availability(_query())

        def _key(s: TeeTimeSlot):
            return (s.course_id, s.course_name, s.time, s.route, s.booking_url, s.phone)
        assert {_key(s) for s in routed_slots} == {_key(s) for s in plain_slots}


class TestOrdering:
    async def test_matched_course_slots_are_time_ascending(self):
        fake = FakeForeUp()
        fake.result = lambda cap, query: [
            _real_slot(cap, query, "14:00", 0),
            _real_slot(cap, query, "09:30", 1),
            _real_slot(cap, query, "11:15", 2),
        ]
        provider = _provider(foreup=fake)
        slots = await provider.search_availability(_query())
        matched_times = [s.time for s in slots if s.course_name == "18 Mile Creek Golf Course"]
        assert matched_times == sorted(matched_times)


class TestBookDispatch:
    async def test_foreup_slot_dispatches_to_fake_book(self):
        fake = FakeForeUp(result=[])
        provider = _provider(foreup=fake)
        slot = _real_slot(_CAP, _query(), "10:00")
        result = await provider.book(slot, BookingDetails(name="Owner", party_size=2))
        assert len(fake.book_calls) == 1
        assert result.message == "fake foreup book"
        # S2 guard (specs/teetime-s2-plan.md §3b.3): a foreup slot routed
        # through RoutedTeeTimeProvider must never yield a confirmed booking
        # or a fabricated confirmation number.
        assert result.status == "needs_human"
        assert result.status != "confirmed"
        assert result.confirmation_number is None

    async def test_foreup_slot_never_confirms_with_the_real_foreup_provider(self):
        """The same guard, but through the REAL ForeUpProvider (not the fake)
        — proves the actual production dispatch path, not just FakeForeUp's
        scripted return value."""
        from app.services.tee_times.foreup import ForeUpProvider

        provider = _provider(foreup=ForeUpProvider(capabilities=lambda: (_CAP,)))
        slot = _real_slot(_CAP, _query(), "10:00")
        result = await provider.book(slot, BookingDetails(name="Owner", party_size=2))
        assert result.status == "needs_human"
        assert result.confirmation_number is None
        assert result.booking_url == _CAP.booking_url

    async def test_routing_slot_dispatches_to_super_needs_human(self):
        fake = FakeForeUp(result=[])
        provider = _provider(foreup=fake)
        slot = TeeTimeSlot(
            id="gplaces-plain-2026-07-11-route", course_id="gplaces-plain",
            course_name="Plain Public Course", city="Somewhere, NY", date="2026-07-11",
            time="", players=2, price_usd=None, cart_included=False, distance_miles=1.0,
            rating=3.8, provider="routing", holes=18,
            booking_url="https://plainpublic.example.com/", route="book_on_site",
        )
        result = await provider.book(slot, BookingDetails(name="Owner", party_size=2))
        assert fake.book_calls == []
        assert result.status == "needs_human"
        assert result.booking_url == "https://plainpublic.example.com/"

    def test_name_is_router(self):
        assert _provider().name == "router"


class TestCourseSelectionFilter:
    """course_ids wiring through the router provider
    (specs/teetime-course-ids-wiring-plan.md §6): a selected capability
    course still gets real foreUP slots; an unselected one is filtered
    BEFORE `_slots_for_course` ever runs, so foreUP is never called for it
    (quota win)."""

    async def test_selected_capability_course_still_yields_foreup_slots(self):
        fake = FakeForeUp()
        fake.result = lambda cap, query: [_real_slot(cap, query, "10:00")]
        provider = _provider(foreup=fake)
        query = _query(course_ids=["gplaces-18mile"])
        slots = await provider.search_availability(query)

        matched = [s for s in slots if s.course_name == "18 Mile Creek Golf Course"]
        assert len(matched) == 1
        assert matched[0].provider == "foreup"
        assert fake.calls  # foreUP WAS consulted for the selected course

    async def test_unselected_capability_course_never_calls_foreup(self):
        fake = FakeForeUp()
        fake.result = lambda cap, query: [_real_slot(cap, query, "10:00")]
        provider = _provider(foreup=fake)
        # Select only the plain public course — 18 Mile Creek is filtered
        # out before the capability lookup ever runs.
        query = _query(course_ids=["gplaces-plain"])
        slots = await provider.search_availability(query)

        assert "18 Mile Creek Golf Course" not in {s.course_name for s in slots}
        assert "Plain Public Course" in {s.course_name for s in slots}
        assert fake.calls == []


class TestNeverRaises:
    async def test_finder_that_raises_returns_empty(self):
        async def boom(_query):
            raise RuntimeError("overpass down")
        provider = RoutedTeeTimeProvider(
            find_courses=boom, foreup=FakeForeUp(result=[]), capabilities=lambda: (_CAP,),
        )
        assert await provider.search_availability(_query()) == []

    async def test_capability_lookup_raising_falls_back_to_s0(self):
        def boom_caps():
            raise RuntimeError("capability store exploded")
        fake = FakeForeUp(result=[])
        provider = _provider(foreup=fake, caps=None)
        provider._capabilities = boom_caps  # type: ignore[assignment]
        slots = await provider.search_availability(_query())
        # Falls back to plain S0 entries for every course — never raises.
        assert {s.course_name for s in slots} == {
            "18 Mile Creek Golf Course", "Plain Public Course", "No Website Municipal Course",
        }
        assert fake.calls == []


# ─── S3: the AI phone-call booking route (specs/teetime-s3-caller-plan.md §2) ──


def _call_slot() -> TeeTimeSlot:
    """A phone-only routed slot: route=="call" + a known number, no website."""
    return TeeTimeSlot(
        id="way/999-2026-07-11-route", course_id="way/999",
        course_name="No Website Municipal Course", city="Nowhere, NY",
        date="2026-07-11", time="", players=2, price_usd=None, cart_included=False,
        distance_miles=1.0, rating=0.0, provider="routing", holes=18,
        booking_url=None, route="call", phone="+17165551212",
    )


class _ExplodingTransport:
    """A call transport that MUST NOT be reached — proves no dial happens."""

    async def run_call(self, ctx):  # pragma: no cover - asserts if invoked
        raise AssertionError("transport.run_call must never be reached (no dial)")


async def _boom_phone_lookup(*_a, **_k):  # pragma: no cover - asserts if invoked
    raise AssertionError("phone_lookup must not run — slot already carries a phone")


class TestVoiceCallRouteWiring:
    async def test_disabled_is_byte_identical_s0_handoff(self):
        """Voice disabled (the default) → a call-route slot books via the exact
        S0 honest handoff, unchanged. No voice provider is consulted."""
        from app.services.voice_booking.provider import VoiceCallProvider

        voice = VoiceCallProvider(transport=_ExplodingTransport())
        provider = RoutedTeeTimeProvider(
            find_courses=_fake_finder(), voice=voice, voice_enabled=False,
        )
        result = await provider.book(_call_slot(), BookingDetails(name="Owner", party_size=2))
        assert result.status == "needs_human"
        # Exact S0 message for a website-less course (no online booking link).
        assert result.message == (
            "Call or visit No Website Municipal Course to book — "
            "no online booking link is available."
        )

    async def test_enabled_empty_allowlist_needs_human_without_a_dial(self):
        """Voice enabled but no owner-verified line → compliance refuses BEFORE
        any transport is touched. Proves the wire AND the allowlist gate."""
        from app.services.voice_booking.provider import VoiceCallProvider

        voice = VoiceCallProvider(
            transport=_ExplodingTransport(),
            phone_lookup=_boom_phone_lookup,
            verified_lines=set(),          # nothing verified → refuse every number
        )
        provider = RoutedTeeTimeProvider(
            find_courses=_fake_finder(), voice=voice, voice_enabled=True,
        )
        details = BookingDetails(
            name="Owner", party_size=2,
            time_window_start="09:00", time_window_end="11:00",
        )
        result = await provider.book(_call_slot(), details)
        assert result.status == "needs_human"
        assert "not an owner-verified business landline" in (result.message or "")

    async def test_enabled_but_book_on_site_slot_uses_s0(self):
        """route=="book_on_site" is NOT a call route — even with voice enabled it
        still hands off to the site, never to the voice provider."""
        from app.services.voice_booking.provider import VoiceCallProvider

        voice = VoiceCallProvider(transport=_ExplodingTransport())
        provider = RoutedTeeTimeProvider(
            find_courses=_fake_finder(), voice=voice, voice_enabled=True,
        )
        slot = TeeTimeSlot(
            id="gplaces-plain-2026-07-11-route", course_id="gplaces-plain",
            course_name="Plain Public Course", city="Somewhere, NY", date="2026-07-11",
            time="", players=2, price_usd=None, cart_included=False, distance_miles=1.0,
            rating=3.8, provider="routing", holes=18,
            booking_url="https://plainpublic.example.com/", route="book_on_site",
        )
        result = await provider.book(slot, BookingDetails(name="Owner", party_size=2))
        assert result.status == "needs_human"
        assert result.booking_url == "https://plainpublic.example.com/"

    async def test_enabled_call_route_without_phone_uses_s0(self):
        """A call route with NO phone can't be dialed — falls through to S0."""
        from app.services.voice_booking.provider import VoiceCallProvider

        voice = VoiceCallProvider(transport=_ExplodingTransport())
        provider = RoutedTeeTimeProvider(
            find_courses=_fake_finder(), voice=voice, voice_enabled=True,
        )
        slot = _call_slot()
        slot.phone = None
        result = await provider.book(slot, BookingDetails(name="Owner", party_size=2))
        assert result.status == "needs_human"
        assert "Call or visit" in (result.message or "")

    async def test_foreup_slot_still_takes_precedence_over_voice(self):
        """Dispatch order: a foreup slot still books through foreUP even with
        voice enabled — the voice route never shadows a real-inventory slot."""
        from app.services.voice_booking.provider import VoiceCallProvider

        fake = FakeForeUp(result=[])
        voice = VoiceCallProvider(transport=_ExplodingTransport())
        provider = RoutedTeeTimeProvider(
            find_courses=_fake_finder(), foreup=fake, capabilities=lambda: (_CAP,),
            voice=voice, voice_enabled=True,
        )
        slot = _real_slot(_CAP, _query(), "10:00")
        result = await provider.book(slot, BookingDetails(name="Owner", party_size=2))
        assert len(fake.book_calls) == 1
        assert result.message == "fake foreup book"
