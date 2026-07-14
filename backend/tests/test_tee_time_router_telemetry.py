"""
Tests for the S4f coverage-flywheel telemetry seam in
`RoutedTeeTimeProvider._slots_for_course` (specs/teetime-s4f-coverage
-flywheel-plan.md §1, §8).

Two invariants, proven independently of `search_telemetry.py`'s own store
tests (test_tee_time_search_telemetry.py):

  1. FIRE-AND-FORGET: a telemetry store that RAISES on every `.record()` call
     must yield EXACTLY the same slots as a no-op store, for every branch of
     `_slots_for_course`. If this ever fails, telemetry is no longer a pure
     side effect.
  2. CORRECT OUTCOME: a recording fake proves the exact `SearchOutcome`
     recorded at each branch (router_provider.py's fallback-order table),
     and that the `TEETIME_FOREUP_ENABLED=0` kill-switch path records
     nothing at all.

Scaffolding mirrors `test_tee_time_router.py` (fake finder / FakeForeUp /
capability fixtures) — duplicated locally per this test suite's existing
convention (see test_tee_time_router_teeitup.py, _clubprophet.py, etc.,
none of which cross-import test_tee_time_router.py either).
"""

from __future__ import annotations

from app.services.tee_times.base import TeeTimeQuery, TeeTimeSlot
from app.services.tee_times.capability_store import CourseBookingCapability
from app.services.tee_times.router_provider import RoutedTeeTimeProvider
from app.services.tee_times.search_telemetry import SearchTelemetryStore


def _query(**overrides) -> TeeTimeQuery:
    defaults = dict(
        date="2026-07-11",
        time_window_start="07:00",
        time_window_end="18:00",
        party_size=2,
        area="42.0,-73.0",
    )
    defaults.update(overrides)
    return TeeTimeQuery(**defaults)


_ORIGIN = (42.0, -73.0)

_MATCHED_COURSE = {
    "id": "gplaces-matched", "name": "Matched Golf Course", "address": "Town, NY",
    "center": {"lat": 42.001, "lng": -73.001}, "website": None, "phone": "(555) 000-0000",
    "rating": 4.0,
}

_PRIVATE_COURSE = {
    "id": "gplaces-private", "name": "Private National Club", "address": "Town, NY",
    "center": {"lat": 42.002, "lng": -73.002}, "website": "https://private.example.com",
    "rating": 5.0,
}

_NO_ADAPTER_COURSE = {
    "id": "gplaces-noadapter", "name": "No Adapter Course", "address": "Town, NY",
    "center": {"lat": 42.003, "lng": -73.003}, "website": "https://noadapter.example.com",
    "rating": 3.5,
}

_UNMATCHED_COURSE = {
    "id": "gplaces-unmatched", "name": "Unmatched Plain Course", "address": "Town, NY",
    "center": {"lat": 42.004, "lng": -73.004}, "website": "https://plain.example.com",
    "rating": 3.9,
}

_MATCHED_CAP = CourseBookingCapability(
    platform="foreup", course_id=None, foreup_booking_id="1", schedule_id="1",
    booking_url="https://example.com/booking", phone="(555) 000-0000", is_private=False,
    verified_at="2026-07-09T00:00:00Z", name="Matched Golf Course", lat=42.001, lng=-73.001,
)

_PRIVATE_CAP = CourseBookingCapability(
    platform="foreup", course_id=None, foreup_booking_id="2", schedule_id="2",
    booking_url="https://example.com/booking2", phone=None, is_private=True,
    verified_at="2026-07-09T00:00:00Z", name="Private National Club", lat=42.002, lng=-73.002,
)

_NO_ADAPTER_CAP = CourseBookingCapability(
    platform="unregistered_engine", course_id=None, foreup_booking_id=None, schedule_id=None,
    booking_url=None, phone=None, is_private=False,
    verified_at="2026-07-09T00:00:00Z", name="No Adapter Course", lat=42.003, lng=-73.003,
)

_ALL_CAPS = (_MATCHED_CAP, _PRIVATE_CAP, _NO_ADAPTER_CAP)


def _fake_finder(courses: list[dict]):
    async def find(_query):
        return courses, _ORIGIN
    return find


class FakeForeUp:
    """Scriptable fake ForeUpProvider — records calls, returns a fixed value."""

    def __init__(self, result=None):
        self.result = result
        self.calls: list[tuple] = []

    async def slots_for_capability(self, cap, query, *, distance_miles=0.0, course=None):
        self.calls.append((cap, query, distance_miles, course))
        if callable(self.result):
            return self.result(cap, query)
        return self.result

    async def book(self, slot, details):  # pragma: no cover - unused here
        raise NotImplementedError


def _real_slot(cap: CourseBookingCapability, query: TeeTimeQuery, time: str = "10:00") -> TeeTimeSlot:
    return TeeTimeSlot(
        id=f"foreup-{cap.foreup_booking_id}-{query.date}-{time}",
        course_id=f"foreup-{cap.foreup_booking_id}", course_name=cap.name, city="Town, NY",
        date=query.date, time=time, players=query.party_size, price_usd=24.0, cart_included=False,
        distance_miles=0.1, rating=4.0, provider="foreup", holes=18, booking_url=cap.booking_url,
        route=None, phone=cap.phone,
    )


# ── Telemetry fakes ─────────────────────────────────────────────────────────────

class NoopStore(SearchTelemetryStore):
    def record(self, course, outcome, *, platform=None):
        pass

    def all_records(self):
        return ()


class RaisingStore(SearchTelemetryStore):
    """Every call raises — proves `_record_outcome` is truly fire-and-forget."""

    def record(self, course, outcome, *, platform=None):
        raise RuntimeError("search_telemetry: store exploded (test)")

    def all_records(self):  # pragma: no cover - not exercised by the router
        raise RuntimeError("search_telemetry: store exploded (test)")


class RecordingStore(SearchTelemetryStore):
    def __init__(self):
        self.calls: list[tuple[str | None, str, str | None]] = []

    def record(self, course, outcome, *, platform=None):
        course_id = course.get("id") or course.get("osm_id")
        self.calls.append((course_id, outcome, platform))

    def all_records(self):
        return ()


def _provider(
    *, foreup=None, caps=_ALL_CAPS, courses, foreup_enabled=None, telemetry=None,
) -> RoutedTeeTimeProvider:
    return RoutedTeeTimeProvider(
        find_courses=_fake_finder(courses),
        foreup=foreup or FakeForeUp(result=[]),
        capabilities=lambda: caps,
        foreup_enabled=foreup_enabled,
        telemetry=telemetry if telemetry is not None else NoopStore(),
    )


def _slot_key(s: TeeTimeSlot) -> tuple:
    return (s.course_id, s.course_name, s.time, s.route, s.booking_url, s.phone, s.provider)


# ── 1. Fire-and-forget: RaisingStore == NoopStore, every branch ────────────────

class TestFireAndForgetInvariant:
    """A RaisingStore must never change what the golfer sees, in any branch."""

    async def _compare(
        self, *, courses, caps=_ALL_CAPS, foreup_result=(), foreup_enabled=None,
    ) -> None:
        noop_fake = FakeForeUp(result=foreup_result)
        noop_provider = _provider(
            foreup=noop_fake, caps=caps, courses=courses,
            foreup_enabled=foreup_enabled, telemetry=NoopStore(),
        )
        noop_slots = await noop_provider.search_availability(_query())

        raising_fake = FakeForeUp(result=foreup_result)
        raising_provider = _provider(
            foreup=raising_fake, caps=caps, courses=courses,
            foreup_enabled=foreup_enabled, telemetry=RaisingStore(),
        )
        raising_slots = await raising_provider.search_availability(_query())

        assert {_slot_key(s) for s in raising_slots} == {_slot_key(s) for s in noop_slots}
        assert len(raising_slots) == len(noop_slots)

    async def test_no_capability_branch(self):
        await self._compare(courses=[_UNMATCHED_COURSE], caps=_ALL_CAPS)

    async def test_no_adapter_branch(self):
        await self._compare(courses=[_NO_ADAPTER_COURSE], caps=(_NO_ADAPTER_CAP,))

    async def test_private_branch(self):
        await self._compare(courses=[_PRIVATE_COURSE], caps=(_PRIVATE_CAP,))

    async def test_real_availability_branch(self):
        await self._compare(
            courses=[_MATCHED_COURSE], caps=(_MATCHED_CAP,),
            foreup_result=lambda cap, query: [_real_slot(cap, query)],
        )

    async def test_verified_empty_branch(self):
        await self._compare(courses=[_MATCHED_COURSE], caps=(_MATCHED_CAP,), foreup_result=[])

    async def test_couldnt_check_branch(self):
        await self._compare(courses=[_MATCHED_COURSE], caps=(_MATCHED_CAP,), foreup_result=None)

    async def test_disabled_engine_kill_switch_branch(self):
        await self._compare(
            courses=[_MATCHED_COURSE, _UNMATCHED_COURSE], caps=_ALL_CAPS, foreup_enabled=False,
        )

    async def test_capability_lookup_raising_branch(self):
        """Mirrors test_tee_time_router.py's boom_caps case — the exception
        path inside `_slots_for_course`, not just the outcome branches."""
        def boom_caps():
            raise RuntimeError("capability store exploded")

        noop_fake = FakeForeUp(result=[])
        noop_provider = _provider(
            foreup=noop_fake, courses=[_MATCHED_COURSE], telemetry=NoopStore(),
        )
        noop_provider._capabilities = boom_caps  # type: ignore[assignment]
        noop_slots = await noop_provider.search_availability(_query())

        raising_fake = FakeForeUp(result=[])
        raising_provider = _provider(
            foreup=raising_fake, courses=[_MATCHED_COURSE], telemetry=RaisingStore(),
        )
        raising_provider._capabilities = boom_caps  # type: ignore[assignment]
        raising_slots = await raising_provider.search_availability(_query())

        assert {_slot_key(s) for s in raising_slots} == {_slot_key(s) for s in noop_slots}


# ── 2. Correct outcome recorded per branch ──────────────────────────────────────

class TestRecordedOutcomes:
    async def test_no_capability_records_no_capability(self):
        store = RecordingStore()
        provider = _provider(courses=[_UNMATCHED_COURSE], caps=_ALL_CAPS, telemetry=store)
        await provider.search_availability(_query())
        assert store.calls == [("gplaces-unmatched", "no_capability", None)]

    async def test_no_adapter_records_no_adapter_with_platform(self):
        store = RecordingStore()
        provider = _provider(courses=[_NO_ADAPTER_COURSE], caps=(_NO_ADAPTER_CAP,), telemetry=store)
        await provider.search_availability(_query())
        assert store.calls == [("gplaces-noadapter", "no_adapter", "unregistered_engine")]

    async def test_private_records_private_with_platform(self):
        store = RecordingStore()
        provider = _provider(courses=[_PRIVATE_COURSE], caps=(_PRIVATE_CAP,), telemetry=store)
        await provider.search_availability(_query())
        assert store.calls == [("gplaces-private", "private", "foreup")]

    async def test_real_availability_records_real_availability(self):
        store = RecordingStore()
        fake = FakeForeUp(result=lambda cap, query: [_real_slot(cap, query)])
        provider = _provider(
            foreup=fake, courses=[_MATCHED_COURSE], caps=(_MATCHED_CAP,), telemetry=store,
        )
        await provider.search_availability(_query())
        assert store.calls == [("gplaces-matched", "real_availability", "foreup")]

    async def test_verified_empty_records_verified_empty(self):
        store = RecordingStore()
        fake = FakeForeUp(result=[])
        provider = _provider(
            foreup=fake, courses=[_MATCHED_COURSE], caps=(_MATCHED_CAP,), telemetry=store,
        )
        await provider.search_availability(_query())
        assert store.calls == [("gplaces-matched", "verified_empty", "foreup")]

    async def test_couldnt_check_records_couldnt_check(self):
        store = RecordingStore()
        fake = FakeForeUp(result=None)
        provider = _provider(
            foreup=fake, courses=[_MATCHED_COURSE], caps=(_MATCHED_CAP,), telemetry=store,
        )
        await provider.search_availability(_query())
        assert store.calls == [("gplaces-matched", "couldnt_check", "foreup")]

    async def test_kill_switch_records_nothing(self):
        store = RecordingStore()
        provider = _provider(
            courses=[_MATCHED_COURSE, _UNMATCHED_COURSE, _PRIVATE_COURSE],
            caps=_ALL_CAPS, foreup_enabled=False, telemetry=store,
        )
        await provider.search_availability(_query())
        assert store.calls == []

    async def test_capability_lookup_exception_records_nothing(self):
        """The internal-failure fallback (cap=None via exception) is NOT the
        same fact as a genuine no_capability match — records nothing."""
        def boom_caps():
            raise RuntimeError("capability store exploded")

        store = RecordingStore()
        provider = _provider(courses=[_MATCHED_COURSE], telemetry=store)
        provider._capabilities = boom_caps  # type: ignore[assignment]
        await provider.search_availability(_query())
        assert store.calls == []

    async def test_multiple_courses_each_recorded_once(self):
        store = RecordingStore()
        fake = FakeForeUp(result=lambda cap, query: [_real_slot(cap, query)])
        provider = _provider(
            foreup=fake,
            courses=[_MATCHED_COURSE, _UNMATCHED_COURSE, _PRIVATE_COURSE, _NO_ADAPTER_COURSE],
            caps=_ALL_CAPS, telemetry=store,
        )
        await provider.search_availability(_query())
        by_course = {c: (o, p) for c, o, p in store.calls}
        assert by_course["gplaces-matched"] == ("real_availability", "foreup")
        assert by_course["gplaces-unmatched"] == ("no_capability", None)
        assert by_course["gplaces-private"] == ("private", "foreup")
        assert by_course["gplaces-noadapter"] == ("no_adapter", "unregistered_engine")
