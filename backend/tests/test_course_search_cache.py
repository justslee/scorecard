"""Tests for the /api/courses/search TTL cache (course-search-fix-plan, item 3).

Mirrors the FakeClock + tmp_path pattern of test_tee_time_search_cache.py: zero
real I/O outside pytest's sandbox, deterministic TTL expiry.
"""

from app.services.course_search_cache import (
    NEGATIVE_TTL_SECONDS,
    POSITIVE_TTL_SECONDS,
    FileSearchCacheStore,
)


class FakeClock:
    def __init__(self, start: float = 1_000_000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


_HITS = [{"id": "x", "name": "Bethpage Black Course", "source": "osm"}]


class TestPositiveTtl:
    def test_hit_within_ttl(self, tmp_path):
        clock = FakeClock()
        store = FileSearchCacheStore(path=tmp_path / "c.json", now_fn=clock)
        store.set("bethpage", _HITS)
        clock.advance(POSITIVE_TTL_SECONDS - 1)
        assert store.get("bethpage") == _HITS

    def test_miss_after_positive_ttl(self, tmp_path):
        clock = FakeClock()
        store = FileSearchCacheStore(path=tmp_path / "c.json", now_fn=clock)
        store.set("bethpage", _HITS)
        clock.advance(POSITIVE_TTL_SECONDS)
        assert store.get("bethpage") is None


class TestNegativeTtl:
    def test_empty_result_uses_short_ttl(self, tmp_path):
        clock = FakeClock()
        store = FileSearchCacheStore(path=tmp_path / "c.json", now_fn=clock)
        store.set("nonexistent town", [])
        # Still fresh just before the (short) negative TTL elapses.
        clock.advance(NEGATIVE_TTL_SECONDS - 1)
        assert store.get("nonexistent town") == []

    def test_empty_result_expires_fast_not_24h(self, tmp_path):
        clock = FakeClock()
        store = FileSearchCacheStore(path=tmp_path / "c.json", now_fn=clock)
        store.set("nonexistent town", [])
        clock.advance(NEGATIVE_TTL_SECONDS)
        assert store.get("nonexistent town") is None
        # Sanity: negative TTL is meaningfully shorter than positive TTL.
        assert NEGATIVE_TTL_SECONDS < POSITIVE_TTL_SECONDS


class TestMissAndPersistence:
    def test_miss_when_never_set(self, tmp_path):
        store = FileSearchCacheStore(path=tmp_path / "c.json", now_fn=FakeClock())
        assert store.get("bethpage") is None

    def test_survives_new_store_instance_same_file(self, tmp_path):
        path = tmp_path / "c.json"
        clock = FakeClock()
        FileSearchCacheStore(path=path, now_fn=clock).set("bethpage", _HITS)
        # A fresh store instance (simulating a process restart) still reads it.
        reloaded = FileSearchCacheStore(path=path, now_fn=clock)
        assert reloaded.get("bethpage") == _HITS

    def test_distinct_keys_do_not_collide(self, tmp_path):
        store = FileSearchCacheStore(path=tmp_path / "c.json", now_fn=FakeClock())
        store.set("bethpage", _HITS)
        store.set("pebble beach", [{"id": "y", "name": "Pebble Beach"}])
        assert store.get("bethpage") == _HITS
        assert store.get("pebble beach") == [{"id": "y", "name": "Pebble Beach"}]
