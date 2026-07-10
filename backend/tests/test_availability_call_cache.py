"""`availability_by_call` cache — S4e rung 3
(specs/teetime-availability-everywhere-plan.md §5). No network, no DB.
"""

from __future__ import annotations

from app.services.tee_times.availability_call_cache import (
    AvailabilityCallRecord,
    FileAvailabilityCallCacheStore,
    SpokenSlotRecord,
    availability_cache_key,
)


def _record(**overrides) -> AvailabilityCallRecord:
    defaults = dict(
        course_id="way/999",
        course_name="No Website Municipal Course",
        date="2026-07-11",
        window_start="07:00",
        window_end="10:00",
        party_size=2,
        outcome="availability",
        slots_spoken=(SpokenSlotRecord(time="08:15", price_usd=45.0),),
        transcript_ref="job-1",
        called_at="2026-07-10T14:02:00+00:00",
    )
    defaults.update(overrides)
    return AvailabilityCallRecord(**defaults)


class TestCacheKey:
    def test_key_is_deterministic(self):
        k1 = availability_cache_key("way/999", "2026-07-11", "07:00", "10:00", 2)
        k2 = availability_cache_key("way/999", "2026-07-11", "07:00", "10:00", 2)
        assert k1 == k2

    def test_key_differs_on_any_field(self):
        base = availability_cache_key("way/999", "2026-07-11", "07:00", "10:00", 2)
        assert base != availability_cache_key("way/1000", "2026-07-11", "07:00", "10:00", 2)
        assert base != availability_cache_key("way/999", "2026-07-12", "07:00", "10:00", 2)
        assert base != availability_cache_key("way/999", "2026-07-11", "08:00", "10:00", 2)
        assert base != availability_cache_key("way/999", "2026-07-11", "07:00", "10:00", 4)


class TestFileStoreRoundTrip:
    def test_miss_returns_none(self, tmp_path):
        store = FileAvailabilityCallCacheStore(path=tmp_path / "cache.json", now_fn=lambda: 1000.0)
        assert store.get("nope") is None

    def test_set_then_get_round_trips(self, tmp_path):
        store = FileAvailabilityCallCacheStore(path=tmp_path / "cache.json", now_fn=lambda: 1000.0)
        key = availability_cache_key("way/999", "2026-07-11", "07:00", "10:00", 2)
        store.set(key, _record())
        got = store.get(key)
        assert got is not None
        assert got.course_id == "way/999"
        assert got.outcome == "availability"
        assert got.slots_spoken == (SpokenSlotRecord(time="08:15", price_usd=45.0),)
        assert got.called_at == "2026-07-10T14:02:00+00:00"

    def test_survives_a_fresh_store_instance_same_file(self, tmp_path):
        """Proves file persistence — a NEW store instance (as the route
        handler and the router provider each construct independently) still
        sees a record written by another instance, as long as they share a
        path (the production default)."""
        path = tmp_path / "cache.json"
        now = {"t": 1000.0}
        writer = FileAvailabilityCallCacheStore(path=path, now_fn=lambda: now["t"])
        key = availability_cache_key("way/999", "2026-07-11", "07:00", "10:00", 2)
        writer.set(key, _record())

        reader = FileAvailabilityCallCacheStore(path=path, now_fn=lambda: now["t"])
        got = reader.get(key)
        assert got is not None and got.outcome == "availability"

    def test_same_day_ttl_expires(self, tmp_path):
        now = {"t": 1000.0}
        store = FileAvailabilityCallCacheStore(
            path=tmp_path / "cache.json", ttl_seconds=12 * 60 * 60, now_fn=lambda: now["t"]
        )
        key = availability_cache_key("way/999", "2026-07-11", "07:00", "10:00", 2)
        store.set(key, _record())
        assert store.get(key) is not None

        now["t"] += 11 * 60 * 60          # 11h later — still same-day-ish, fresh
        assert store.get(key) is not None

        now["t"] += 2 * 60 * 60           # now 13h later — past the 12h TTL
        assert store.get(key) is None

    def test_no_availability_outcome_round_trips_with_zero_slots(self, tmp_path):
        store = FileAvailabilityCallCacheStore(path=tmp_path / "cache.json", now_fn=lambda: 1000.0)
        key = availability_cache_key("way/999", "2026-07-11", "07:00", "10:00", 2)
        store.set(key, _record(outcome="no_availability", slots_spoken=()))
        got = store.get(key)
        assert got is not None
        assert got.outcome == "no_availability"
        assert got.slots_spoken == ()

    def test_price_is_never_fabricated_when_unstated(self, tmp_path):
        store = FileAvailabilityCallCacheStore(path=tmp_path / "cache.json", now_fn=lambda: 1000.0)
        key = availability_cache_key("way/999", "2026-07-11", "07:00", "10:00", 2)
        store.set(key, _record(slots_spoken=(SpokenSlotRecord(time="09:00", price_usd=None),)))
        got = store.get(key)
        assert got.slots_spoken[0].price_usd is None
