"""RoutedTeeTimeProvider — S4e rung-3 wiring: an availability_by_call cache
hit renders as real phone-confirmed slots; a miss (or an unresolved call)
leaves today's honest "call" route entry unchanged
(specs/teetime-availability-everywhere-plan.md §6). No network, no DB — the
cache is a fake in-memory store; nothing here can ever place a call.
"""

from __future__ import annotations

from app.services.tee_times.availability_call_cache import (
    AvailabilityCallCacheStore,
    AvailabilityCallRecord,
    SpokenSlotRecord,
    availability_cache_key,
)
from app.services.tee_times.base import TeeTimeQuery
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

# No `website` -> S0 gives this a route=="call" entry (phone known).
_NO_WEBSITE_COURSE = {
    "osm_id": "way/999",
    "name": "No Website Municipal Course",
    "address": "Nowhere, NY",
    "center": {"lat": 42.73, "lng": -78.79},
    "phone": "+17165551212",
}

# Has a website -> route=="book_on_site" — rung 3 must never touch this.
_PLAIN_COURSE = {
    "id": "gplaces-plain",
    "name": "Plain Public Course",
    "address": "Somewhere, NY",
    "center": {"lat": 42.72, "lng": -78.82},
    "website": "https://plainpublic.example.com/",
    "rating": 3.8,
}

# Matches a foreUP capability whose live fetch degrades (couldn't check) —
# the EXISTING degrade branch forces route=="book_on_site" always. Rung 3
# must NEVER touch this path (locked byte-identical by
# test_tee_time_router.py::TestCouldntCheckDegradesToRouteEntry).
_MATCHED_COURSE = {
    "id": "gplaces-18mile",
    "name": "18 Mile Creek Golf Course",
    "address": "6374 Boston State Rd, Hamburg, NY",
    "center": {"lat": 42.7150, "lng": -78.8140},
    "website": None,
    "rating": 4.1,
}
_CAP = CourseBookingCapability(
    platform="foreup", course_id=None, foreup_booking_id="20410", schedule_id="4467",
    booking_url="https://foreupsoftware.com/index.php/booking/20410/4467",
    phone="(716) 648-4410", is_private=False, verified_at="2026-07-09T00:00:00Z",
    name="18 Mile Creek Golf Course", lat=42.714304, lng=-78.813114,
)


def _fake_finder(courses):
    async def find(_query):
        return courses, _ORIGIN
    return find


class FakeForeUp:
    def __init__(self, result=None):
        self.result = result
        self.calls: list = []

    async def slots_for_capability(self, cap, query, *, distance_miles=0.0, course=None):
        self.calls.append((cap, query, distance_miles, course))
        return self.result

    async def book(self, slot, details):  # pragma: no cover - unused here
        raise AssertionError("book() not exercised in these tests")


class FakeAvailabilityCache(AvailabilityCallCacheStore):
    """In-memory fake — proves the router only ever READS, never writes."""

    def __init__(self, records: dict[str, AvailabilityCallRecord] | None = None) -> None:
        self.records = dict(records or {})
        self.get_calls: list[str] = []

    def get(self, key: str):
        self.get_calls.append(key)
        return self.records.get(key)

    def set(self, key: str, record: AvailabilityCallRecord) -> None:  # pragma: no cover
        raise AssertionError("the router must never WRITE to the availability cache")


def _provider(*, cache: FakeAvailabilityCache, courses, caps=(), foreup=None) -> RoutedTeeTimeProvider:
    return RoutedTeeTimeProvider(
        find_courses=_fake_finder(courses),
        foreup=foreup or FakeForeUp(result=[]),
        capabilities=lambda: caps,
        availability_cache=cache,
    )


class TestNoCacheHitLeavesCallEntryUnchanged:
    async def test_no_website_no_cache_record_yields_ordinary_call_entry(self):
        cache = FakeAvailabilityCache()
        provider = _provider(cache=cache, courses=[_NO_WEBSITE_COURSE])
        slots = await provider.search_availability(_query())
        assert len(slots) == 1
        entry = slots[0]
        assert entry.route == "call"
        assert entry.provider == "routing"
        assert entry.time == ""
        assert entry.phone == "+17165551212"
        # It DID check the cache (read-only, no dial).
        assert cache.get_calls

    async def test_book_on_site_entry_never_consults_the_cache(self):
        cache = FakeAvailabilityCache()
        provider = _provider(cache=cache, courses=[_PLAIN_COURSE])
        slots = await provider.search_availability(_query())
        assert len(slots) == 1
        assert slots[0].route == "book_on_site"
        assert cache.get_calls == []   # never even looked — not a "call" route


class TestCacheHitAvailabilityRendersRealSlots:
    async def test_hit_with_slots_becomes_real_phone_confirmed_slots(self):
        key = availability_cache_key(
            "way/999", "2026-07-11", "07:00", "18:00", 2,
        )
        record = AvailabilityCallRecord(
            course_id="way/999", course_name="No Website Municipal Course",
            date="2026-07-11", window_start="07:00", window_end="18:00", party_size=2,
            outcome="availability",
            slots_spoken=(
                SpokenSlotRecord(time="08:15", price_usd=45.0),
                SpokenSlotRecord(time="09:30", price_usd=None),
            ),
            transcript_ref="job-1", called_at="2026-07-10T14:02:00+00:00",
        )
        cache = FakeAvailabilityCache({key: record})
        provider = _provider(cache=cache, courses=[_NO_WEBSITE_COURSE])
        slots = await provider.search_availability(_query())

        assert len(slots) == 2
        times = sorted(s.time for s in slots)
        assert times == ["08:15", "09:30"]
        for s in slots:
            assert s.provider == "voice_call"
            assert s.route == "call"                 # retained for booking handoff
            assert s.status == "live"
            assert s.checked_via == "voice_call"
            assert s.checked_at == "2026-07-10T14:02:00+00:00"
            assert s.phone == "+17165551212"
        priced = {s.time: s.price_usd for s in slots}
        assert priced["08:15"] == 45.0
        assert priced["09:30"] is None                # never fabricated

    async def test_hit_key_is_scoped_to_exact_date_window_party(self):
        """A record for a DIFFERENT window must not leak into this search —
        the ask was for a different question."""
        key = availability_cache_key(
            "way/999", "2026-07-11", "13:00", "16:00", 2,   # afternoon ask
        )
        record = AvailabilityCallRecord(
            course_id="way/999", course_name="No Website Municipal Course",
            date="2026-07-11", window_start="13:00", window_end="16:00", party_size=2,
            outcome="availability",
            slots_spoken=(SpokenSlotRecord(time="14:00", price_usd=None),),
            called_at="2026-07-10T14:02:00+00:00",
        )
        cache = FakeAvailabilityCache({key: record})
        provider = _provider(cache=cache, courses=[_NO_WEBSITE_COURSE])
        # This search asks the MORNING window (07:00-18:00 default) — the key
        # differs (different start), so no hit.
        slots = await provider.search_availability(_query())
        assert len(slots) == 1
        assert slots[0].provider == "routing"          # unchanged call entry


class TestCacheHitNoAvailabilityOmitsCourse:
    async def test_no_availability_outcome_omits_the_course(self):
        key = availability_cache_key("way/999", "2026-07-11", "07:00", "18:00", 2)
        record = AvailabilityCallRecord(
            course_id="way/999", course_name="No Website Municipal Course",
            date="2026-07-11", window_start="07:00", window_end="18:00", party_size=2,
            outcome="no_availability", slots_spoken=(),
            called_at="2026-07-10T14:02:00+00:00",
        )
        cache = FakeAvailabilityCache({key: record})
        provider = _provider(cache=cache, courses=[_NO_WEBSITE_COURSE])
        slots = await provider.search_availability(_query())
        assert slots == []   # verified empty — never a fabricated "book on site" fallback


class TestCacheHitCouldntCheckLeavesHonestEmpty:
    async def test_voicemail_outcome_leaves_the_ordinary_call_entry(self):
        key = availability_cache_key("way/999", "2026-07-11", "07:00", "18:00", 2)
        record = AvailabilityCallRecord(
            course_id="way/999", course_name="No Website Municipal Course",
            date="2026-07-11", window_start="07:00", window_end="18:00", party_size=2,
            outcome="voicemail", slots_spoken=(),
            called_at="2026-07-10T14:02:00+00:00",
        )
        cache = FakeAvailabilityCache({key: record})
        provider = _provider(cache=cache, courses=[_NO_WEBSITE_COURSE])
        slots = await provider.search_availability(_query())
        assert len(slots) == 1
        assert slots[0].route == "call"
        assert slots[0].provider == "routing"           # NOT voice_call — never confirmed
        assert slots[0].time == ""

    async def test_availability_outcome_with_zero_slots_leaves_honest_empty(self):
        """A resolved ask-mode call that ended without a single spoken time
        (e.g. it hit the bounded-retry safety valve) must not be treated as
        "confirmed nothing" — the shop was never heard saying "no
        availability" outright, so this stays an honest "couldn't confirm"
        call entry, not a verified-empty omission."""
        key = availability_cache_key("way/999", "2026-07-11", "07:00", "18:00", 2)
        record = AvailabilityCallRecord(
            course_id="way/999", course_name="No Website Municipal Course",
            date="2026-07-11", window_start="07:00", window_end="18:00", party_size=2,
            outcome="availability", slots_spoken=(),
            called_at="2026-07-10T14:02:00+00:00",
        )
        cache = FakeAvailabilityCache({key: record})
        provider = _provider(cache=cache, courses=[_NO_WEBSITE_COURSE])
        slots = await provider.search_availability(_query())
        assert len(slots) == 1
        assert slots[0].route == "call"
        assert slots[0].provider == "routing"


class TestDegradePathNeverConsultsCache:
    """The cap-matched-but-live-fetch-failed degrade branch (foreUP known,
    breaker/timeout) is LOCKED byte-identical by
    test_tee_time_router.py::TestCouldntCheckDegradesToRouteEntry — it must
    stay route=="book_on_site" and never even look at the availability cache,
    even if a (nonsensical here) cache record exists."""

    async def test_foreup_degrade_ignores_availability_cache_entirely(self):
        key = availability_cache_key(
            "gplaces-18mile", "2026-07-11", "07:00", "18:00", 2,
        )
        record = AvailabilityCallRecord(
            course_id="gplaces-18mile", course_name="18 Mile Creek Golf Course",
            date="2026-07-11", window_start="07:00", window_end="18:00", party_size=2,
            outcome="availability",
            slots_spoken=(SpokenSlotRecord(time="09:00", price_usd=30.0),),
            called_at="2026-07-10T14:02:00+00:00",
        )
        cache = FakeAvailabilityCache({key: record})
        fake = FakeForeUp(result=None)   # couldn't check -> degrade branch
        provider = _provider(cache=cache, courses=[_MATCHED_COURSE], caps=(_CAP,), foreup=fake)
        slots = await provider.search_availability(_query())

        assert len(slots) == 1
        entry = slots[0]
        assert entry.route == "book_on_site"     # unchanged, per the locked test
        assert entry.provider == "routing"        # NOT voice_call — cache was never applied
        assert entry.booking_url == _CAP.booking_url
        assert cache.get_calls == []              # proves it was never even read


class TestKillSwitchSkipsCacheEntirely:
    async def test_foreup_disabled_ignores_availability_cache(self):
        key = availability_cache_key("way/999", "2026-07-11", "07:00", "18:00", 2)
        record = AvailabilityCallRecord(
            course_id="way/999", course_name="No Website Municipal Course",
            date="2026-07-11", window_start="07:00", window_end="18:00", party_size=2,
            outcome="availability",
            slots_spoken=(SpokenSlotRecord(time="08:15", price_usd=45.0),),
            called_at="2026-07-10T14:02:00+00:00",
        )
        cache = FakeAvailabilityCache({key: record})
        provider = RoutedTeeTimeProvider(
            find_courses=_fake_finder([_NO_WEBSITE_COURSE]),
            foreup=FakeForeUp(result=[]),
            capabilities=lambda: (),
            foreup_enabled=False,
            availability_cache=cache,
        )
        slots = await provider.search_availability(_query())
        assert len(slots) == 1
        assert slots[0].provider == "routing"     # unchanged S0 entry
        assert cache.get_calls == []              # the kill switch reverts to EXACT S0
