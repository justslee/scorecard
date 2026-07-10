"""
`availability_by_call` cache — S4e rung-3 (specs/teetime-availability-everywhere
-plan.md §5, §6).

Persists the result of ONE AI phone call that ASKED a pro shop what it has
open (as opposed to booking one) so the router can render it as real
TeeTimeSlots on the NEXT search without re-dialing. A call is the most
expensive fetch we have (cost + intrusiveness, unlike a free API poll) — per
`golfapi-budget-cache-first` it's cached the hardest: a same-day TTL keyed on
the exact (course, date, window, party size) ask, so an identical search
never re-dials within the same day. The search path only ever READS this
store via `RoutedTeeTimeProvider` — nothing in this module places a call.

Record shape (plan §5):
    {course_id, date, window: {start, end}, party_size, slots_spoken: [...],
     outcome, transcript_ref, called_at}

Same injectable-store pattern as search_cache.py / capability_store.py: an
abstract store, a real file-backed implementation (JSON under backend/data/,
survives restarts), and fakes in tests.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Literal, Optional

log = logging.getLogger(__name__)

# "A staffer's word is good for hours, not minutes" (plan §5) — a generous
# same-day TTL rather than a fixed short poll window like search_cache's 15min.
TTL_SECONDS: int = 12 * 60 * 60

_DATA_DIR = Path(__file__).parent.parent.parent.parent / "data"

# Mirrors voice_booking.types.CallResult plus "not_enabled" (the call never
# happened — dark/gated) so a cache record can honestly represent every
# terminal state the trigger endpoint can produce.
AvailabilityCallOutcome = Literal[
    "availability", "no_availability", "voicemail", "no_answer", "unclear", "not_enabled"
]


@dataclass(frozen=True)
class SpokenSlotRecord:
    time: str                        # "HH:MM" 24h, exactly as the staffer said it
    price_usd: float | None = None   # None = not stated — never fabricated


@dataclass(frozen=True)
class AvailabilityCallRecord:
    course_id: str
    course_name: str
    date: str                        # YYYY-MM-DD
    window_start: str                # "HH:MM" — the golfer's REQUESTED window
    window_end: str
    party_size: int
    outcome: AvailabilityCallOutcome
    slots_spoken: tuple[SpokenSlotRecord, ...] = ()
    transcript_ref: str | None = None    # opaque job/log ref — never raw audio
    called_at: str = ""                  # ISO-8601 UTC of the call


def availability_cache_key(
    course_id: str, date: str, window_start: str, window_end: str, party_size: int
) -> str:
    """Deterministic cache key for one (course, date, window, party) ask —
    identical to how a golfer would phrase the same question twice."""
    return json.dumps(
        {
            "course": course_id, "date": date,
            "start": window_start, "end": window_end, "party": party_size,
        },
        sort_keys=True,
    )


# ── Abstract store (injectable) ───────────────────────────────────────────────

class AvailabilityCallCacheStore:
    """Abstract same-day TTL cache for availability-by-call records."""

    def get(self, key: str) -> Optional[AvailabilityCallRecord]:
        """Return the cached record, or None on miss / expiry."""
        raise NotImplementedError

    def set(self, key: str, record: AvailabilityCallRecord) -> None:
        raise NotImplementedError


# ── Real file-backed implementation ───────────────────────────────────────────

class FileAvailabilityCallCacheStore(AvailabilityCallCacheStore):
    """JSON-file-backed same-day TTL cache:
    ``backend/data/availability_by_call_cache.json``.

    In-memory dict answers hot-path reads; the file makes entries survive a
    process restart. Expired entries are pruned on every write. File
    structure::

        {"<key>": {"record": {...}, "cached_at": 1751300000.0}}
    """

    def __init__(
        self,
        path: Optional[Path] = None,
        ttl_seconds: int = TTL_SECONDS,
        now_fn: Callable[[], float] = time.time,
    ) -> None:
        self._path = path or (_DATA_DIR / "availability_by_call_cache.json")
        self._ttl = ttl_seconds
        self._now = now_fn
        self._mem: dict[str, dict] = {}

    def _load(self) -> dict:
        if not self._path.exists():
            return {}
        try:
            return json.loads(self._path.read_text())
        except Exception:
            return {}

    def _save(self, data: dict) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(json.dumps(data, indent=2))

    def _fresh_raw(self, entry: Optional[dict]) -> Optional[dict]:
        if entry is None:
            return None
        cached_at = entry.get("cached_at")
        if not isinstance(cached_at, (int, float)):
            return None
        if self._now() - cached_at >= self._ttl:
            return None
        return entry.get("record")

    @staticmethod
    def _to_record(raw: dict) -> AvailabilityCallRecord:
        return AvailabilityCallRecord(
            course_id=raw["course_id"],
            course_name=raw.get("course_name", ""),
            date=raw["date"],
            window_start=raw["window_start"],
            window_end=raw["window_end"],
            party_size=int(raw["party_size"]),
            outcome=raw["outcome"],
            slots_spoken=tuple(
                SpokenSlotRecord(time=s["time"], price_usd=s.get("price_usd"))
                for s in raw.get("slots_spoken", [])
            ),
            transcript_ref=raw.get("transcript_ref"),
            called_at=raw.get("called_at", ""),
        )

    @staticmethod
    def _to_raw(record: AvailabilityCallRecord) -> dict:
        return {
            "course_id": record.course_id,
            "course_name": record.course_name,
            "date": record.date,
            "window_start": record.window_start,
            "window_end": record.window_end,
            "party_size": record.party_size,
            "outcome": record.outcome,
            "slots_spoken": [
                {"time": s.time, "price_usd": s.price_usd} for s in record.slots_spoken
            ],
            "transcript_ref": record.transcript_ref,
            "called_at": record.called_at,
        }

    def get(self, key: str) -> Optional[AvailabilityCallRecord]:
        raw = self._fresh_raw(self._mem.get(key))
        if raw is not None:
            return self._to_record(raw)
        entry = self._load().get(key)
        raw = self._fresh_raw(entry)
        if raw is not None and entry is not None:
            self._mem[key] = entry
            return self._to_record(raw)
        return None

    def set(self, key: str, record: AvailabilityCallRecord) -> None:
        entry = {"record": self._to_raw(record), "cached_at": self._now()}
        self._mem[key] = entry
        data = self._load()
        data[key] = entry
        # Prune expired entries so the file can't grow without bound.
        now = self._now()
        data = {
            k: v for k, v in data.items()
            if isinstance(v.get("cached_at"), (int, float)) and now - v["cached_at"] < self._ttl
        }
        self._save(data)
        log.info(
            "availability_by_call_cache: stored outcome=%s slots=%d (ttl=%ds)",
            record.outcome, len(record.slots_spoken), self._ttl,
        )
