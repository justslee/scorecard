"""
Search telemetry — S4f coverage flywheel (specs/teetime-s4f-coverage-flywheel
-plan.md §1-3).

Every course `RoutedTeeTimeProvider._slots_for_course` classifies during a
real search (router_provider.py) is recorded here as a FIRE-AND-FORGET
side-effect: never raises into the search path, never slows it, never
changes what a golfer sees. The store answers two questions offline (never
in the request path, never a dashboard/API route):

  1. "% of searched courses returning real availability" — `coverage_summary`
     (pure, unit-testable metric math, no file needed).
  2. Which searched-but-uncovered courses are worth hand-probing next —
     read via `uv run backend/scripts/coverage_flywheel.py report`.

Same injectable-store pattern as `availability_call_cache.py` /
`search_cache.py` / `capability_store.py`: an abstract store, a real
file-backed implementation (JSON under `backend/data/`, gitignored —
runtime cache, not curated config), and fakes in tests.

**Dedup key** = `course_id` (discovery-namespaced id: `course["id"]` or
`course["osm_id"]`) — one record per DISTINCT course searched, counters
bumped in place. The file grows with distinct courses, never per-search.

**Bounded growth**: hard cap `MAX_COURSES` (LRU-by-`last_seen` eviction at
flush time) — 500 records x ~300 bytes is worst case ~150 KB. Flush also
prunes malformed entries (fail-soft load, same posture as every sibling
store in this package).

**No PII**: course id/name/geo/website/business phone only — all attributes
of a golf COURSE, never of the searcher. No query text, no user id, no
timestamp finer than first/last seen.

**Latest-outcome semantics**: a course that later gains a capability row
(the sweep, or a hand-probe) and starts returning real slots flips buckets
on its NEXT search — counts are cumulative, but `coverage_summary` reads
only `latest_outcome`.

**Risk — concurrent writers** (a multi-worker deploy): last-write-wins on
`search_telemetry.json` can drop a counter bump between two processes;
acceptable for an ops metric (same posture as every sibling file store in
this package). The >~100-rows -> DB escalation path is `capability_store.py`
§ "NO DB TABLE" reasoning, restated here: this file stays a bounded JSON
cache until real transactional needs appear.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Literal, Optional, Sequence

log = logging.getLogger(__name__)

_DATA_DIR = Path(__file__).parent.parent.parent.parent / "data"

# Bounded growth (module docstring) — one record per distinct searched course.
MAX_COURSES: int = 500

# Debounced flush window: at most one file write per this many seconds, PLUS
# an immediate flush whenever a NEW course key appears (the valuable
# probe-feed signal) — see router_provider.py §1b for the full rationale.
FLUSH_INTERVAL_S: float = 30.0

# Every per-course outcome `RoutedTeeTimeProvider._slots_for_course` can
# classify (router_provider.py's fallback-order table). "private" is excluded
# from the coverage denominator by design (see `coverage_summary` below) —
# it can never count for or against fetchability.
SearchOutcome = Literal[
    "real_availability", "verified_empty", "couldnt_check",
    "no_capability", "no_adapter", "private",
]

# "Coverage %" (primary metric, plan §3): a genuinely sold-out real answer
# counts the same as a real slot — the owner's ask is FETCHABILITY, not
# demand. "Strict %" (secondary) is real_availability alone.
_COVERAGE_OUTCOMES: frozenset[str] = frozenset({"real_availability", "verified_empty"})
_STRICT_OUTCOMES: frozenset[str] = frozenset({"real_availability"})


def _now_iso(now_fn: Callable[[], float]) -> str:
    return datetime.fromtimestamp(now_fn(), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass(frozen=True)
class SearchedCourseRecord:
    """One distinct searched course's cumulative telemetry (plan §2)."""

    course_id: str                       # dedup key: discovery-namespaced id
    name: str
    lat: float | None                    # from course["center"] when present
    lng: float | None
    website: str | None                  # course identity, so the sweep can
    phone: str | None                    #   fingerprint WITHOUT Google Places
    outcome_counts: dict[str, int] = field(default_factory=dict)
    latest_outcome: str = ""
    latest_platform: str | None = None
    first_seen: str = ""                 # ISO-8601 UTC
    last_seen: str = ""


def total_searches(record: SearchedCourseRecord) -> int:
    """Cumulative search count across every outcome — used to sort the
    probe-feed queue (highest-demand `no_capability` courses first)."""
    return sum(record.outcome_counts.values())


# ── Abstract store (injectable) ───────────────────────────────────────────────

class SearchTelemetryStore:
    """Abstract per-course search telemetry store."""

    def record(self, course: dict, outcome: SearchOutcome, *, platform: str | None = None) -> None:
        raise NotImplementedError

    def all_records(self) -> tuple[SearchedCourseRecord, ...]:
        raise NotImplementedError


# ── Real file-backed implementation ───────────────────────────────────────────

class FileSearchTelemetryStore(SearchTelemetryStore):
    """JSON-file-backed telemetry store: ``backend/data/search_telemetry.json``
    (gitignored — runtime cache, not curated config; see `backend/.gitignore`'s
    ``backend/data/*`` rule).

    In-memory dict answers hot-path writes; a debounced, opportunistic flush
    (module docstring) persists to disk. File structure::

        {"courses": {"<course_id>": {record fields...}}}

    Never raises: every file op is wrapped and a failure is logged + swallowed
    (`_load` fails soft to `{}`, `_save` failures are swallowed) — belt-and-
    suspenders under the router's own `_record_outcome` catch-all.
    """

    def __init__(
        self,
        path: Optional[Path] = None,
        now_fn: Callable[[], float] = time.time,
        flush_interval_s: float = FLUSH_INTERVAL_S,
        max_courses: int = MAX_COURSES,
    ) -> None:
        self._path = path or (_DATA_DIR / "search_telemetry.json")
        self._now = now_fn
        self._flush_interval = flush_interval_s
        self._max_courses = max_courses
        self._mem: dict[str, dict] | None = None   # lazy-loaded on first record()
        self._last_flush: float = 0.0

    def _ensure_loaded(self) -> dict[str, dict]:
        if self._mem is None:
            self._mem = self._load()
        return self._mem

    def _load(self) -> dict[str, dict]:
        """Fail-soft: missing file -> {}; malformed file/entries -> logged,
        pruned. Never raises."""
        if not self._path.exists():
            return {}
        try:
            raw = json.loads(self._path.read_text())
            courses = raw.get("courses")
            if not isinstance(courses, dict):
                return {}
            return {
                course_id: entry
                for course_id, entry in courses.items()
                if isinstance(course_id, str) and isinstance(entry, dict)
            }
        except Exception:
            log.warning("search_telemetry: file malformed — starting fresh", exc_info=True)
            return {}

    def _save(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text(json.dumps({"courses": self._mem}, indent=2))
        except Exception:
            log.warning("search_telemetry: save failed (ignored)", exc_info=True)

    def _evict_if_needed(self, mem: dict[str, dict]) -> None:
        """Hard cap MAX_COURSES: evict smallest `last_seen` first (LRU) so the
        file can't grow without bound (module docstring)."""
        if len(mem) <= self._max_courses:
            return
        overflow = len(mem) - self._max_courses
        ordered = sorted(mem.items(), key=lambda kv: kv[1].get("last_seen") or "")
        for course_id, _ in ordered[:overflow]:
            del mem[course_id]

    def record(self, course: dict, outcome: SearchOutcome, *, platform: str | None = None) -> None:
        course_id = str(course.get("id") or course.get("osm_id") or "")
        if not course_id:
            return  # no stable dedup key — nothing to record

        mem = self._ensure_loaded()
        is_new = course_id not in mem
        now_iso = _now_iso(self._now)

        entry = mem.get(course_id)
        if entry is None:
            center = course.get("center") or {}
            entry = {
                "course_id": course_id,
                "name": course.get("name") or "",
                "lat": center.get("lat"),
                "lng": center.get("lng"),
                "website": course.get("website"),
                "phone": course.get("phone"),
                "outcome_counts": {},
                "first_seen": now_iso,
            }
        entry["outcome_counts"][outcome] = entry["outcome_counts"].get(outcome, 0) + 1
        entry["latest_outcome"] = outcome
        entry["latest_platform"] = platform
        entry["last_seen"] = now_iso
        mem[course_id] = entry

        # Debounced flush (module docstring): immediate on a NEW course key,
        # else at most once per `flush_interval_s`.
        now = self._now()
        if is_new or (now - self._last_flush) >= self._flush_interval:
            self._evict_if_needed(mem)
            self._save()
            self._last_flush = now

    def all_records(self) -> tuple[SearchedCourseRecord, ...]:
        """Re-reads the file (a report/sweep script runs in a DIFFERENT
        process — it reads what the server flushed) and overlays this
        instance's own in-memory state on top (more recent than any pending
        un-flushed write)."""
        on_disk = self._load()
        mem = self._mem or {}
        merged = {**on_disk, **mem}
        out: list[SearchedCourseRecord] = []
        for course_id, raw in merged.items():
            rec = _to_record(course_id, raw)
            if rec is not None:
                out.append(rec)
        return tuple(out)


def _to_record(course_id: str, raw: dict) -> SearchedCourseRecord | None:
    """Fail-soft: a malformed entry is skipped (logged), never fatal."""
    try:
        return SearchedCourseRecord(
            course_id=raw.get("course_id") or course_id,
            name=raw.get("name") or "",
            lat=raw.get("lat"),
            lng=raw.get("lng"),
            website=raw.get("website"),
            phone=raw.get("phone"),
            outcome_counts=dict(raw.get("outcome_counts") or {}),
            latest_outcome=raw.get("latest_outcome") or "",
            latest_platform=raw.get("latest_platform"),
            first_seen=raw.get("first_seen") or "",
            last_seen=raw.get("last_seen") or "",
        )
    except Exception:
        log.warning("search_telemetry: skipping malformed record course_id=%r", course_id, exc_info=True)
        return None


# ── Module singleton (router_provider.py §1a) ─────────────────────────────────
#
# `routes/tee_times.py:_get_provider()` constructs `RoutedTeeTimeProvider()`
# per request, so a per-instance store would defeat in-memory dedup/debounce
# — the module singleton is the same pattern as `_limiter`/`_breaker` in
# adapters/teeitup.py and `_search_cache` in routes/tee_times.py.

_default_store: FileSearchTelemetryStore | None = None


def default_search_telemetry_store() -> FileSearchTelemetryStore:
    global _default_store
    if _default_store is None:
        _default_store = FileSearchTelemetryStore()
    return _default_store


# ── Coverage metric — pure, unit-testable, no file needed (plan §3) ───────────

@dataclass(frozen=True)
class CoverageSummary:
    total_courses: int                          # distinct recorded courses (incl. private)
    denominator: int                             # excludes latest_outcome == "private"
    coverage_count: int                          # real_availability + verified_empty
    coverage_pct: float | None                   # None when denominator == 0 (never fake 0%)
    strict_count: int                             # real_availability only
    strict_pct: float | None
    outcome_breakdown: dict[str, int] = field(default_factory=dict)          # latest_outcome -> count (incl. private)
    couldnt_check_by_platform: dict[str, int] = field(default_factory=dict)  # latest_platform -> count, couldnt_check rows only
    no_capability_courses: tuple[SearchedCourseRecord, ...] = ()             # probe-feed queue, sorted desc by search count


def coverage_summary(records: Sequence[SearchedCourseRecord]) -> CoverageSummary:
    """Precise metric definition (plan §3):

    - denominator = distinct recorded courses with `latest_outcome !=
      "private"` (private courses can never count for or against coverage).
    - coverage % (primary) = |latest_outcome in {real_availability,
      verified_empty}| / denominator — a genuinely sold-out day is a
      successfully FETCHED real answer, not a miss.
    - strict % (secondary) = |latest_outcome == real_availability| /
      denominator.

    Pure function — no file I/O, so metric math is unit-testable on
    hand-built record sets.
    """
    total_courses = len(records)
    non_private = [r for r in records if r.latest_outcome != "private"]
    denominator = len(non_private)

    coverage_count = sum(1 for r in non_private if r.latest_outcome in _COVERAGE_OUTCOMES)
    strict_count = sum(1 for r in non_private if r.latest_outcome in _STRICT_OUTCOMES)

    coverage_pct = (coverage_count / denominator * 100.0) if denominator else None
    strict_pct = (strict_count / denominator * 100.0) if denominator else None

    breakdown: dict[str, int] = {}
    for r in records:
        breakdown[r.latest_outcome] = breakdown.get(r.latest_outcome, 0) + 1

    couldnt_check_by_platform: dict[str, int] = {}
    for r in records:
        if r.latest_outcome == "couldnt_check":
            key = r.latest_platform or "unknown"
            couldnt_check_by_platform[key] = couldnt_check_by_platform.get(key, 0) + 1

    no_capability = sorted(
        (r for r in records if r.latest_outcome == "no_capability"),
        key=lambda r: (-total_searches(r), r.name),
    )

    return CoverageSummary(
        total_courses=total_courses,
        denominator=denominator,
        coverage_count=coverage_count,
        coverage_pct=coverage_pct,
        strict_count=strict_count,
        strict_pct=strict_pct,
        outcome_breakdown=breakdown,
        couldnt_check_by_platform=couldnt_check_by_platform,
        no_capability_courses=tuple(no_capability),
    )
