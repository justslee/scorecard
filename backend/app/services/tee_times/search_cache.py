"""
TTL cache for tee-time availability searches.

Follows the injectable-store pattern of services/golfapi_cache.py: an abstract
store the route depends on, a real file-backed implementation (in-memory dict
+ JSON file under backend/data/ so it survives restarts), and fakes in tests.

Purpose: protect the Google Places / Overpass quota from repeated identical
searches. TTL is deliberately short (15 min) — availability freshness matters
more than hit rate.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Callable, Optional

from .base import TeeTimeQuery

log = logging.getLogger(__name__)

TTL_SECONDS: int = 15 * 60

_DATA_DIR = Path(__file__).parent.parent.parent.parent / "data"


def query_cache_key(provider_name: str, query: TeeTimeQuery) -> str:
    """Normalized, deterministic cache key for a search query.

    Includes the provider name (mock vs affiliate results differ); area is
    case/whitespace-insensitive and course_ids order-insensitive.
    """
    return json.dumps({
        "provider": provider_name,
        "date": query.date,
        "start": query.time_window_start,
        "end": query.time_window_end,
        "party": query.party_size,
        "area": (query.area or "").strip().lower() or None,
        "ids": sorted(query.course_ids),
        "maxDist": query.max_distance_miles,
        "maxPrice": query.max_price_usd,
    }, sort_keys=True)


# ── Abstract store (injectable) ───────────────────────────────────────────────

class SearchCacheStore:
    """Abstract TTL cache for serialized search results. Override in tests."""

    def get(self, key: str) -> Optional[list[dict]]:
        """Return cached slot dicts, or None on miss / expiry."""
        raise NotImplementedError

    def set(self, key: str, results: list[dict]) -> None:
        raise NotImplementedError


# ── Real file-backed implementation ───────────────────────────────────────────

class FileSearchCacheStore(SearchCacheStore):
    """JSON-file-backed TTL cache: ``backend/data/tee_time_search_cache.json``.

    In-memory dict answers hot-path reads; the file makes entries survive a
    process restart. Expired entries are pruned on every write. File structure::

        {"<key>": {"results": [...], "cached_at": 1751300000.0}}
    """

    def __init__(
        self,
        path: Optional[Path] = None,
        ttl_seconds: int = TTL_SECONDS,
        now_fn: Callable[[], float] = time.time,
    ) -> None:
        self._path = path or (_DATA_DIR / "tee_time_search_cache.json")
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

    def _fresh(self, entry: Optional[dict]) -> Optional[list[dict]]:
        if entry is None:
            return None
        cached_at = entry.get("cached_at")
        if not isinstance(cached_at, (int, float)):
            return None
        if self._now() - cached_at >= self._ttl:
            return None
        return entry.get("results")

    def get(self, key: str) -> Optional[list[dict]]:
        hit = self._fresh(self._mem.get(key))
        if hit is not None:
            return hit
        entry = self._load().get(key)
        results = self._fresh(entry)
        if results is not None and entry is not None:
            self._mem[key] = entry
        return results

    def set(self, key: str, results: list[dict]) -> None:
        entry = {"results": results, "cached_at": self._now()}
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
        log.info("tee_time_search_cache: stored %d slot(s) (ttl=%ds)", len(results), self._ttl)
