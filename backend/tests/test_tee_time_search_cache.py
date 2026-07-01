"""Tests for the tee-time search TTL cache (Phase 1b).

FileSearchCacheStore gets a fake clock + tmp_path so TTL expiry and file
persistence are tested deterministically with zero real I/O outside pytest's
sandbox — the injectable-store pattern from services/golfapi_cache.py.
"""

from app.services.tee_times.base import TeeTimeQuery
from app.services.tee_times.search_cache import (
    TTL_SECONDS,
    FileSearchCacheStore,
    query_cache_key,
)


class FakeClock:
    def __init__(self, start: float = 1_000_000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _query(**overrides) -> TeeTimeQuery:
    defaults = dict(
        date="2026-07-04",
        time_window_start="07:00",
        time_window_end="10:00",
        party_size=4,
        area="San Francisco",
    )
    defaults.update(overrides)
    return TeeTimeQuery(**defaults)


_SLOTS = [{"id": "presidio-2026-07-04-07:00-0", "courseName": "Presidio Golf Course"}]


class TestTtl:
    def test_hit_within_ttl(self, tmp_path):
        clock = FakeClock()
        store = FileSearchCacheStore(path=tmp_path / "c.json", now_fn=clock)
        store.set("k", _SLOTS)
        clock.advance(TTL_SECONDS - 1)
        assert store.get("k") == _SLOTS

    def test_miss_after_ttl(self, tmp_path):
        clock = FakeClock()
        store = FileSearchCacheStore(path=tmp_path / "c.json", now_fn=clock)
        store.set("k", _SLOTS)
        clock.advance(TTL_SECONDS)
        assert store.get("k") is None

    def test_miss_when_never_set(self, tmp_path):
        store = FileSearchCacheStore(path=tmp_path / "c.json", now_fn=FakeClock())
        assert store.get("k") is None

    def test_empty_result_list_is_a_valid_hit(self, tmp_path):
        """An empty search result is cached too — 'nothing found' costs quota."""
        clock = FakeClock()
        store = FileSearchCacheStore(path=tmp_path / "c.json", now_fn=clock)
        store.set("k", [])
        assert store.get("k") == []


class TestFilePersistence:
    def test_survives_new_store_instance(self, tmp_path):
        clock = FakeClock()
        path = tmp_path / "c.json"
        FileSearchCacheStore(path=path, now_fn=clock).set("k", _SLOTS)
        # Fresh instance, empty in-memory dict → must read from the file.
        assert FileSearchCacheStore(path=path, now_fn=clock).get("k") == _SLOTS

    def test_expired_entries_pruned_on_write(self, tmp_path):
        clock = FakeClock()
        path = tmp_path / "c.json"
        store = FileSearchCacheStore(path=path, now_fn=clock)
        store.set("old", _SLOTS)
        clock.advance(TTL_SECONDS + 1)
        store.set("new", _SLOTS)
        data = path.read_text()
        assert "new" in data and "old" not in data

    def test_corrupt_file_is_a_miss_not_a_crash(self, tmp_path):
        path = tmp_path / "c.json"
        path.write_text("{not json")
        store = FileSearchCacheStore(path=path, now_fn=FakeClock())
        assert store.get("k") is None
        store.set("k", _SLOTS)  # writes fine over the corrupt file
        assert store.get("k") == _SLOTS


class TestKeyNormalization:
    def test_area_case_and_whitespace_insensitive(self):
        a = query_cache_key("mock", _query(area="  San Francisco "))
        b = query_cache_key("mock", _query(area="san francisco"))
        assert a == b

    def test_course_ids_order_insensitive(self):
        a = query_cache_key("mock", _query(course_ids=["b", "a"]))
        b = query_cache_key("mock", _query(course_ids=["a", "b"]))
        assert a == b

    def test_provider_and_params_differentiate(self):
        base = _query()
        assert query_cache_key("mock", base) != query_cache_key("affiliate", base)
        assert query_cache_key("mock", base) != query_cache_key("mock", _query(party_size=2))
        assert query_cache_key("mock", base) != query_cache_key("mock", _query(date="2026-07-05"))
        assert query_cache_key("mock", base) != query_cache_key(
            "mock", _query(time_window_start="08:00")
        )
        assert query_cache_key("mock", base) != query_cache_key(
            "mock", _query(max_price_usd=80.0)
        )
