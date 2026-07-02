"""
TTL cache for /api/courses/search results.

Follows the injectable-store pattern of services/tee_times/search_cache.py
(itself following services/golfapi_cache.py): an abstract store the route
depends on, a real file-backed implementation (in-memory dict + JSON file
under backend/data/ so it survives restarts), and fakes in tests.

Course names don't churn day to day, so positive hits get a generous 24h TTL
(unlike the 15min tee-time availability cache — freshness matters much less
here). Empty results get a short 5min negative TTL so a transient external
outage doesn't wedge a real course out of the cache for a day.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Callable, Optional

log = logging.getLogger(__name__)

POSITIVE_TTL_SECONDS: int = 24 * 60 * 60
NEGATIVE_TTL_SECONDS: int = 5 * 60

_DATA_DIR = Path(__file__).parent.parent.parent / "data"


# ── Abstract store (injectable) ───────────────────────────────────────────────

class SearchCacheStore:
    """Abstract TTL cache for serialized course-search results. Override in tests."""

    def get(self, key: str) -> Optional[list[dict]]:
        """Return cached course dicts, or None on miss / expiry.

        An empty list ``[]`` is a valid (negative) cache hit, distinct from
        ``None`` (miss) — callers must check ``is None``, not falsiness."""
        raise NotImplementedError

    def set(self, key: str, results: list[dict]) -> None:
        raise NotImplementedError


# ── Real file-backed implementation ───────────────────────────────────────────

class FileSearchCacheStore(SearchCacheStore):
    """JSON-file-backed TTL cache: ``backend/data/course_search_cache.json``.

    In-memory dict answers hot-path reads; the file makes entries survive a
    process restart. Expired entries are pruned on every write. File structure::

        {"<key>": {"results": [...], "cached_at": 1751300000.0, "ttl": 86400}}
    """

    def __init__(
        self,
        path: Optional[Path] = None,
        positive_ttl_seconds: int = POSITIVE_TTL_SECONDS,
        negative_ttl_seconds: int = NEGATIVE_TTL_SECONDS,
        now_fn: Callable[[], float] = time.time,
    ) -> None:
        self._path = path or (_DATA_DIR / "course_search_cache.json")
        self._positive_ttl = positive_ttl_seconds
        self._negative_ttl = negative_ttl_seconds
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
        ttl = entry.get("ttl")
        if not isinstance(cached_at, (int, float)) or not isinstance(ttl, (int, float)):
            return None
        if self._now() - cached_at >= ttl:
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
        ttl = self._positive_ttl if results else self._negative_ttl
        entry = {"results": results, "cached_at": self._now(), "ttl": ttl}
        self._mem[key] = entry
        data = self._load()
        data[key] = entry
        # Prune expired entries so the file can't grow without bound.
        now = self._now()
        data = {
            k: v for k, v in data.items()
            if isinstance(v.get("cached_at"), (int, float))
            and isinstance(v.get("ttl"), (int, float))
            and now - v["cached_at"] < v["ttl"]
        }
        self._save(data)
        log.info(
            "course_search_cache: stored %d result(s) (ttl=%ds)", len(results), ttl
        )
