"""
Tests for the search telemetry store + coverage metric
(specs/teetime-s4f-coverage-flywheel-plan.md §2, §3, §8).

All DB-free, network-free: the store is a JSON file under a pytest `tmp_path`
(never `backend/data/` itself), and `coverage_summary` is a pure function
tested directly on hand-built records.
"""

from __future__ import annotations

import json

from app.services.tee_times.search_telemetry import (
    FileSearchTelemetryStore,
    SearchedCourseRecord,
    coverage_summary,
    total_searches,
)

_COURSE_A = {
    "id": "gplaces-a",
    "name": "Course A",
    "center": {"lat": 40.1, "lng": -73.1},
    "website": "https://a.example.com",
    "phone": "(555) 111-2222",
}

_COURSE_B = {
    "osm_id": "way/222",
    "name": "Course B",
    "center": {"lat": 40.2, "lng": -73.2},
    "website": None,
    "phone": None,
}


def _clock(start: float = 1_000_000.0):
    """Injectable now_fn: `.tick(n)` advances, calling the fn reads current."""
    state = {"t": start}

    def now_fn() -> float:
        return state["t"]

    def tick(n: float) -> None:
        state["t"] += n

    now_fn.tick = tick  # type: ignore[attr-defined]
    return now_fn


# ── Dedup + counter accumulation + latest-outcome ─────────────────────────────

class TestRecordAndDedup:
    def test_same_course_id_dedupes_into_one_record(self, tmp_path):
        store = FileSearchTelemetryStore(path=tmp_path / "t.json")
        store.record(_COURSE_A, "no_capability")
        store.record(_COURSE_A, "no_capability")
        store.record(_COURSE_B, "real_availability", platform="foreup")

        records = store.all_records()
        assert len(records) == 2
        by_id = {r.course_id: r for r in records}
        assert by_id["gplaces-a"].outcome_counts == {"no_capability": 2}
        assert by_id["way/222"].outcome_counts == {"real_availability": 1}

    def test_counter_accumulates_per_outcome(self, tmp_path):
        store = FileSearchTelemetryStore(path=tmp_path / "t.json")
        store.record(_COURSE_A, "no_capability")
        store.record(_COURSE_A, "no_capability")
        store.record(_COURSE_A, "real_availability", platform="foreup")

        rec = store.all_records()[0]
        assert rec.outcome_counts == {"no_capability": 2, "real_availability": 1}
        assert total_searches(rec) == 3

    def test_latest_outcome_flips_when_capability_appears(self, tmp_path):
        """A course that starts as no_capability and later gets a real hit
        (the flywheel closing) flips latest_outcome on its NEXT search —
        counts stay cumulative."""
        store = FileSearchTelemetryStore(path=tmp_path / "t.json")
        store.record(_COURSE_A, "no_capability")
        assert store.all_records()[0].latest_outcome == "no_capability"

        store.record(_COURSE_A, "real_availability", platform="foreup")
        rec = store.all_records()[0]
        assert rec.latest_outcome == "real_availability"
        assert rec.latest_platform == "foreup"
        assert rec.outcome_counts == {"no_capability": 1, "real_availability": 1}

    def test_record_with_no_id_is_a_noop(self, tmp_path):
        store = FileSearchTelemetryStore(path=tmp_path / "t.json")
        store.record({"name": "No id course"}, "no_capability")
        assert store.all_records() == ()

    def test_first_and_last_seen(self, tmp_path):
        clock = _clock()
        store = FileSearchTelemetryStore(path=tmp_path / "t.json", now_fn=clock)
        store.record(_COURSE_A, "no_capability")
        first = store.all_records()[0]
        clock.tick(3600)
        store.record(_COURSE_A, "no_capability")
        second = store.all_records()[0]

        assert first.first_seen == second.first_seen  # unchanged
        assert second.last_seen != first.last_seen
        assert second.first_seen < second.last_seen


# ── Bounded growth: MAX_COURSES eviction ───────────────────────────────────────

class TestEviction:
    def test_oldest_last_seen_evicted_at_cap(self, tmp_path):
        clock = _clock()
        store = FileSearchTelemetryStore(path=tmp_path / "t.json", now_fn=clock, max_courses=3)

        def course(i: int) -> dict:
            return {"id": f"course-{i}", "name": f"Course {i}", "center": {"lat": 40.0, "lng": -73.0}}

        for i in range(3):
            store.record(course(i), "no_capability")
            clock.tick(1)

        # The 4th distinct course pushes total to 4 -> evict the smallest
        # last_seen (course-0).
        store.record(course(3), "no_capability")

        ids = {r.course_id for r in store.all_records()}
        assert ids == {"course-1", "course-2", "course-3"}
        assert "course-0" not in ids

    def test_never_exceeds_max_courses_over_many_writes(self, tmp_path):
        clock = _clock()
        store = FileSearchTelemetryStore(path=tmp_path / "t.json", now_fn=clock, max_courses=5)
        for i in range(20):
            store.record(
                {"id": f"course-{i}", "name": f"Course {i}", "center": {"lat": 40.0, "lng": -73.0}},
                "no_capability",
            )
            clock.tick(1)
        assert len(store.all_records()) <= 5


# ── Debounced flush ─────────────────────────────────────────────────────────────

class TestDebouncedFlush:
    def test_two_records_same_course_inside_window_flush_once(self, tmp_path, monkeypatch):
        clock = _clock()
        store = FileSearchTelemetryStore(
            path=tmp_path / "t.json", now_fn=clock, flush_interval_s=30.0
        )
        saves = []
        monkeypatch.setattr(store, "_save", lambda: saves.append(1))

        store.record(_COURSE_A, "no_capability")   # new course -> immediate flush
        clock.tick(5)                                # well inside the 30s window
        store.record(_COURSE_A, "no_capability")   # existing course, no new flush

        assert saves == [1]

    def test_new_course_key_flushes_immediately_even_inside_window(self, tmp_path, monkeypatch):
        clock = _clock()
        store = FileSearchTelemetryStore(
            path=tmp_path / "t.json", now_fn=clock, flush_interval_s=30.0
        )
        saves = []
        monkeypatch.setattr(store, "_save", lambda: saves.append(1))

        store.record(_COURSE_A, "no_capability")
        clock.tick(1)
        store.record(_COURSE_B, "no_capability")   # different course -> new key
        assert saves == [1, 1]

    def test_flush_happens_after_window_elapses(self, tmp_path, monkeypatch):
        clock = _clock()
        store = FileSearchTelemetryStore(
            path=tmp_path / "t.json", now_fn=clock, flush_interval_s=30.0
        )
        saves = []
        monkeypatch.setattr(store, "_save", lambda: saves.append(1))

        store.record(_COURSE_A, "no_capability")
        clock.tick(31)
        store.record(_COURSE_A, "no_capability")
        assert saves == [1, 1]


# ── File round-trip + fail-soft ─────────────────────────────────────────────────

class TestFileRoundTrip:
    def test_round_trips_through_a_fresh_store_instance(self, tmp_path):
        path = tmp_path / "t.json"
        # flush_interval_s=0 -> every record() call flushes, so the
        # cross-process read below sees both writes (proves the round trip,
        # independent of the debounce timing tested separately above).
        store1 = FileSearchTelemetryStore(path=path, flush_interval_s=0.0)
        store1.record(_COURSE_A, "no_capability")
        store1.record(_COURSE_A, "real_availability", platform="foreup")

        # A fresh instance (simulating the report script's own process) reads
        # exactly what got flushed to disk.
        store2 = FileSearchTelemetryStore(path=path)
        records = store2.all_records()
        assert len(records) == 1
        assert records[0].course_id == "gplaces-a"
        assert records[0].latest_outcome == "real_availability"
        assert records[0].website == "https://a.example.com"
        assert records[0].phone == "(555) 111-2222"
        assert records[0].lat == 40.1 and records[0].lng == -73.1

    def test_fail_soft_on_malformed_file(self, tmp_path):
        path = tmp_path / "t.json"
        path.write_text("{ not valid json ]")
        store = FileSearchTelemetryStore(path=path)
        assert store.all_records() == ()   # never raises

    def test_fail_soft_prunes_malformed_entries_on_load(self, tmp_path):
        path = tmp_path / "t.json"
        path.write_text(json.dumps({
            "courses": {
                "good": {
                    "course_id": "good", "name": "Good", "lat": None, "lng": None,
                    "website": None, "phone": None, "outcome_counts": {"no_capability": 1},
                    "latest_outcome": "no_capability", "latest_platform": None,
                    "first_seen": "2026-01-01T00:00:00Z", "last_seen": "2026-01-01T00:00:00Z",
                },
                # Value is not a dict at all -> dropped at load time.
                "bad_entry": "not-a-dict",
                # A well-formed dict entry, but `outcome_counts` can't be
                # coerced into a dict -> dropped when building the record.
                "bad_counts": {
                    "course_id": "bad_counts", "name": "Bad Counts",
                    "outcome_counts": "not-a-dict", "latest_outcome": "no_capability",
                },
            }
        }))
        store = FileSearchTelemetryStore(path=path)
        records = store.all_records()
        assert len(records) == 1
        assert records[0].course_id == "good"

    def test_missing_file_is_empty(self, tmp_path):
        store = FileSearchTelemetryStore(path=tmp_path / "does_not_exist.json")
        assert store.all_records() == ()


# ── coverage_summary metric math (pure — no file needed) ───────────────────────

def _rec(course_id: str, latest_outcome: str, *, platform: str | None = None, counts=None) -> SearchedCourseRecord:
    return SearchedCourseRecord(
        course_id=course_id, name=course_id, lat=None, lng=None, website=None, phone=None,
        outcome_counts=counts or {latest_outcome: 1}, latest_outcome=latest_outcome,
        latest_platform=platform, first_seen="2026-01-01T00:00:00Z", last_seen="2026-01-01T00:00:00Z",
    )


class TestCoverageSummary:
    def test_empty_records_never_divides_by_zero(self):
        summary = coverage_summary(())
        assert summary.total_courses == 0
        assert summary.denominator == 0
        assert summary.coverage_pct is None
        assert summary.strict_pct is None

    def test_private_excluded_from_denominator(self):
        records = [
            _rec("a", "real_availability"),
            _rec("b", "private"),
        ]
        summary = coverage_summary(records)
        assert summary.total_courses == 2
        assert summary.denominator == 1   # private excluded
        assert summary.coverage_count == 1
        assert summary.coverage_pct == 100.0

    def test_coverage_counts_verified_empty_as_covered_strict_does_not(self):
        records = [
            _rec("a", "real_availability"),
            _rec("b", "verified_empty"),
            _rec("c", "no_capability"),
            _rec("d", "couldnt_check"),
        ]
        summary = coverage_summary(records)
        assert summary.denominator == 4
        # coverage (primary): real_availability + verified_empty = 2/4
        assert summary.coverage_count == 2
        assert summary.coverage_pct == 50.0
        # strict (secondary): real_availability only = 1/4
        assert summary.strict_count == 1
        assert summary.strict_pct == 25.0

    def test_no_adapter_is_not_coverage_and_not_a_probe_target(self):
        records = [_rec("a", "no_adapter", platform="ezlinks")]
        summary = coverage_summary(records)
        assert summary.coverage_count == 0
        assert summary.no_capability_courses == ()   # no_adapter != no_capability

    def test_outcome_breakdown_includes_private(self):
        records = [_rec("a", "real_availability"), _rec("b", "private")]
        summary = coverage_summary(records)
        assert summary.outcome_breakdown == {"real_availability": 1, "private": 1}

    def test_couldnt_check_broken_down_by_platform(self):
        records = [
            _rec("a", "couldnt_check", platform="foreup"),
            _rec("b", "couldnt_check", platform="foreup"),
            _rec("c", "couldnt_check", platform="teeitup"),
            _rec("d", "couldnt_check", platform=None),
        ]
        summary = coverage_summary(records)
        assert summary.couldnt_check_by_platform == {"foreup": 2, "teeitup": 1, "unknown": 1}

    def test_no_capability_queue_sorted_by_search_count_desc(self):
        records = [
            _rec("low", "no_capability", counts={"no_capability": 1}),
            _rec("high", "no_capability", counts={"no_capability": 5}),
            _rec("mid", "no_capability", counts={"no_capability": 3}),
        ]
        summary = coverage_summary(records)
        assert [r.course_id for r in summary.no_capability_courses] == ["high", "mid", "low"]
