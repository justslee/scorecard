"""
GolfAPI cache-first service.

Guarantees ≤50 GolfAPI API calls per calendar month via:
  1. CACHE-FIRST — return stored data immediately (0 calls) on hit.
  2. BUDGET GUARD — hard-stop before HARD_STOP_AT calls in the current month.
  3. BATCH DISCOVERY — one ``/clubs?name=q`` call returns MANY course IDs at once
     (≈1 call per area/search, not 1 per course).  Cached so the same area is
     never re-queried.
  4. PER-COURSE COORDS — one ``/coordinates/{id}`` call per course (1 call/course).
     Does NOT pull ``/courses/{id}`` detail unless explicitly needed elsewhere;
     keeping per-course cost at 1 call maximises the ~50/mo budget.
  5. PERSIST — results live in ``backend/data/`` JSON files: never re-fetched after
     first successful store; survives process restarts and OSM re-ingest.
  6. NO-TOKEN SAFE — with no ``GOLF_API_KEY`` no call is ever made; the function
     returns cached data or ``None`` and logs clearly.

The ``GolfApiClient``, ``CacheStore``, ``DiscoveryStore``, and ``BudgetStore``
are injected via simple abstract base classes so unit tests can substitute
fakes without a real DB or network.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
from collections import defaultdict
from pathlib import Path
from typing import Any, Optional

import httpx

log = logging.getLogger(__name__)

GOLF_API_BASE = "https://www.golfapi.io/api/v2.3"

# Monthly hard-stop threshold.
MONTHLY_CAP: int = 50
HARD_STOP_AT: int = 45
# Each per-course fetch costs exactly 1 API call (/coordinates/{id}).
# Discovery (/clubs?name=q) also costs exactly 1 API call per area/query.
CALLS_PER_COURSE: int = 1
CALLS_PER_DISCOVERY: int = 1

_DATA_DIR = Path(__file__).parent.parent.parent / "data"


# ── Abstract base classes (injectable) ────────────────────────────────────────

class GolfApiClient:
    """Abstract GolfAPI HTTP client.  Override in unit tests to avoid network I/O."""

    @property
    def call_count(self) -> int:
        """Total ``fetch_coordinates`` + ``fetch_clubs`` invocations since construction."""
        raise NotImplementedError

    async def fetch_coordinates(self, golfapi_course_id: str) -> list[dict]:
        """GET /coordinates/{id} — 1 API call, returns raw poi/location list."""
        raise NotImplementedError

    async def fetch_clubs(self, query: str) -> list[dict]:
        """GET /clubs?name=q — 1 API call, returns list of club dicts
        each with ``courses`` list (id + name).  Used for area discovery."""
        raise NotImplementedError


class CacheStore:
    """Abstract per-course GolfAPI coordinate cache.  Override in unit tests."""

    def is_cached(self, our_course_id: str) -> bool:
        raise NotImplementedError

    def get_cached(self, our_course_id: str) -> Optional[list[dict]]:
        raise NotImplementedError

    def set_cached(self, our_course_id: str, coords: list[dict]) -> None:
        raise NotImplementedError


class DiscoveryStore:
    """Abstract cache for club/area discovery results.  Override in unit tests.

    Stores the result of a single ``/clubs?name=q`` call keyed by ``area_key``
    so the same area/query is never re-queried.
    """

    def is_cached(self, area_key: str) -> bool:
        raise NotImplementedError

    def get_cached(self, area_key: str) -> Optional[list[dict]]:
        raise NotImplementedError

    def set_cached(self, area_key: str, clubs: list[dict]) -> None:
        raise NotImplementedError


class BudgetStore:
    """Abstract persisted monthly API-call counter.  Override in unit tests."""

    def current_month_calls(self) -> int:
        raise NotImplementedError

    def add_calls(self, n: int) -> int:
        """Increment by ``n``; return the new running total."""
        raise NotImplementedError


# ── Real file-backed implementations ──────────────────────────────────────────

class FileCacheStore(CacheStore):
    """JSON-file-backed coordinate cache: ``backend/data/golfapi_cache.json``.

    File structure::

        {
          "<our_course_id>": {
            "coords": [{hole, green, tee, front, back}, ...],
            "fetched_at": "2026-06-29T12:00:00Z"
          }
        }
    """

    def __init__(self, path: Optional[Path] = None) -> None:
        self._path = path or (_DATA_DIR / "golfapi_cache.json")

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

    def is_cached(self, our_course_id: str) -> bool:
        return our_course_id in self._load()

    def get_cached(self, our_course_id: str) -> Optional[list[dict]]:
        entry = self._load().get(our_course_id)
        if entry is None:
            return None
        return entry.get("coords")

    def set_cached(self, our_course_id: str, coords: list[dict]) -> None:
        data = self._load()
        data[our_course_id] = {
            "coords": coords,
            "fetched_at": datetime.datetime.utcnow().isoformat() + "Z",
        }
        self._save(data)
        log.info(
            "golfapi_cache: persisted %d hole(s) for course=%s → %s",
            len(coords), our_course_id, self._path,
        )


class FileDiscoveryStore(DiscoveryStore):
    """JSON-file-backed area/club discovery: ``backend/data/golfapi_discovery.json``.

    File structure::

        {
          "<area_key>": {
            "clubs": [{id, name, courses: [{id, name}]}, ...],
            "query": "Bethpage",
            "fetched_at": "2026-06-29T12:00:00Z"
          }
        }
    """

    def __init__(self, path: Optional[Path] = None) -> None:
        self._path = path or (_DATA_DIR / "golfapi_discovery.json")

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

    def is_cached(self, area_key: str) -> bool:
        return area_key in self._load()

    def get_cached(self, area_key: str) -> Optional[list[dict]]:
        entry = self._load().get(area_key)
        if entry is None:
            return None
        return entry.get("clubs")

    def set_cached(self, area_key: str, clubs: list[dict]) -> None:
        data = self._load()
        data[area_key] = {
            "clubs": clubs,
            "fetched_at": datetime.datetime.utcnow().isoformat() + "Z",
        }
        self._save(data)
        log.info(
            "golfapi_discovery: cached %d club(s) for area=%s → %s",
            len(clubs), area_key, self._path,
        )


class FileBudgetStore(BudgetStore):
    """JSON-file-backed monthly counter: ``backend/data/golfapi_usage.json``.

    Resets automatically when the calendar month changes.  File structure::

        {"month": "2026-06", "calls": 4}
    """

    def __init__(self, path: Optional[Path] = None) -> None:
        self._path = path or (_DATA_DIR / "golfapi_usage.json")

    @staticmethod
    def _current_month() -> str:
        return datetime.datetime.utcnow().strftime("%Y-%m")

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

    def current_month_calls(self) -> int:
        data = self._load()
        if data.get("month") != self._current_month():
            return 0
        return int(data.get("calls", 0))

    def add_calls(self, n: int) -> int:
        data = self._load()
        month = self._current_month()
        if data.get("month") != month:
            data = {"month": month, "calls": 0}
        data["calls"] = int(data.get("calls", 0)) + n
        self._save(data)
        log.info(
            "golfapi_budget: +%d call(s) month=%s total=%d/%d",
            n, month, data["calls"], MONTHLY_CAP,
        )
        return data["calls"]


class HttpxGolfApiClient(GolfApiClient):
    """Real GolfAPI HTTP client using httpx.

    - ``fetch_coordinates(id)`` — 1 HTTP call.  Per-course coordinate fetch.
    - ``fetch_clubs(query)``    — 1 HTTP call.  Area/name discovery (many course IDs).
    """

    def __init__(self) -> None:
        self._calls: int = 0
        key = os.getenv("GOLF_API_KEY", "")
        self._headers: dict[str, str] = {"Content-Type": "application/json"}
        if key:
            self._headers["Authorization"] = f"Bearer {key}"

    @property
    def call_count(self) -> int:
        return self._calls

    async def fetch_coordinates(self, golfapi_course_id: str) -> list[dict]:
        """GET /coordinates/{id} — returns raw poi/location list (1 API call)."""
        self._calls += 1
        transport = httpx.AsyncHTTPTransport(local_address="0.0.0.0")
        async with httpx.AsyncClient(timeout=15, transport=transport) as client:
            resp = await client.get(
                f"{GOLF_API_BASE}/coordinates/{golfapi_course_id}",
                headers=self._headers,
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("coordinates") or data.get("holes") or []

    async def fetch_clubs(self, query: str) -> list[dict]:
        """GET /clubs?name=query — returns list of club dicts (1 API call).

        Each club dict includes ``clubID``, ``clubName``, and a ``courses``
        list with per-course ``courseID`` and ``courseName``.
        """
        self._calls += 1
        transport = httpx.AsyncHTTPTransport(local_address="0.0.0.0")
        async with httpx.AsyncClient(timeout=15, transport=transport) as client:
            resp = await client.get(
                f"{GOLF_API_BASE}/clubs",
                params={"name": query},
                headers=self._headers,
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("clubs") or []


# ── Coordinate normalizer ──────────────────────────────────────────────────────
# Mirrors routes/golf.py ``_normalize_coordinates`` — kept here to avoid a
# circular import between the services and routes layers.

def _to_float(val: Any) -> Optional[float]:
    if val is None or val == "":
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def _to_int(val: Any) -> Optional[int]:
    if val is None or val == "":
        return None
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return None


def normalize_golfapi_coordinates(raw: list[dict]) -> list[dict]:
    """Decode GolfAPI ``poi``/``location`` coordinates into per-hole dicts.

    poi meanings (mirrors routes/golf.py ``_normalize_coordinates``):
      ``"1"``  = green (location: ``"1"``=back, ``"2"``=center, ``"3"``=front)
      ``"11"`` = front of tee box
      ``"12"`` = back of tee box

    Returns sorted list of::

        {"hole": int, "green": {"lat": float, "lng": float},
         "tee": ...|None, "front": ...|None, "back": ...|None}

    Holes without a green center are omitted.
    """
    holes: dict[int, dict] = defaultdict(dict)

    for pt in raw:
        hole_num = _to_int(pt.get("hole"))
        poi = str(pt.get("poi", ""))
        location = str(pt.get("location", ""))
        lat = _to_float(pt.get("latitude"))
        lng = _to_float(pt.get("longitude"))
        if not hole_num or lat is None or lng is None:
            continue
        coord = {"lat": lat, "lng": lng}

        if poi == "1":  # Green
            if location == "2":
                holes[hole_num]["green"] = coord
            elif location == "3":
                holes[hole_num]["front"] = coord
            elif location == "1":
                holes[hole_num]["back"] = coord
            elif "green" not in holes[hole_num]:
                holes[hole_num]["green"] = coord
        elif poi in ("11", "12"):  # Tee box
            if location == "2" or "tee" not in holes[hole_num]:
                holes[hole_num]["tee"] = coord

    return [
        {
            "hole": h,
            "green": data["green"],
            "tee": data.get("tee"),
            "front": data.get("front"),
            "back": data.get("back"),
        }
        for h, data in sorted(holes.items())
        if "green" in data
    ]


# ── Discovery function ─────────────────────────────────────────────────────────

async def discover_golfapi_clubs(
    area_key: str,
    query: str,
    *,
    force: bool = False,
    client: Optional[GolfApiClient] = None,
    discovery_store: Optional[DiscoveryStore] = None,
    budget_store: Optional[BudgetStore] = None,
    cap: int = HARD_STOP_AT,
) -> Optional[list[dict]]:
    """Cache-first area discovery via a single ``/clubs?name=q`` call.

    One ``/clubs`` call returns ALL clubs + their course IDs for a name/area
    query — the cheap way to enumerate many courses without per-course calls.

    The result is persisted under ``area_key`` (e.g. ``"bethpage-ny"``) so
    the same area is never re-queried (0 API calls on subsequent calls).

    Parameters
    ----------
    area_key:
        Stable cache key for this area/search (e.g. ``"bethpage-ny"``).
    query:
        Search string passed to ``/clubs?name=q``.
    force:
        Bypass cache and re-fetch.
    client / discovery_store / budget_store:
        Injected; use real defaults when ``None``.
    cap:
        Monthly call budget hard-stop (default ``HARD_STOP_AT`` = 45).

    Returns
    -------
    list[dict] | None
        Raw GolfAPI club list (each entry has ``clubID``, ``clubName``,
        ``courses: [{courseID, courseName}]``), or ``None`` when unavailable.
    """
    _store = discovery_store if discovery_store is not None else FileDiscoveryStore()
    _budget = budget_store if budget_store is not None else FileBudgetStore()

    # 1. Cache-first
    if not force and _store.is_cached(area_key):
        log.info(
            "golfapi_discovery: cache-hit area=%s — 0 API calls", area_key
        )
        return _store.get_cached(area_key)

    # 2. No token
    if not os.getenv("GOLF_API_KEY"):
        log.info(
            "GolfAPI token not configured; no discovery for area=%s", area_key
        )
        return _store.get_cached(area_key)

    # 3. Budget guard
    current = _budget.current_month_calls()
    if current + CALLS_PER_DISCOVERY > cap:
        log.warning(
            "golfapi_budget: HARD-STOP — would exceed cap=%d (current=%d) "
            "for discovery area=%s.",
            cap, current, area_key,
        )
        return _store.get_cached(area_key)

    # 4. Single discovery call
    _client = client if client is not None else HttpxGolfApiClient()
    try:
        clubs = await _client.fetch_clubs(query)
        log.info(
            "golfapi_discovery: fetch_clubs done area=%s query=%r → %d club(s) "
            "(client.call_count=%d)",
            area_key, query, len(clubs), _client.call_count,
        )
    except Exception as exc:
        log.error("golfapi_discovery: fetch_clubs failed area=%s: %s", area_key, exc)
        return _store.get_cached(area_key)

    _budget.add_calls(CALLS_PER_DISCOVERY)
    _store.set_cached(area_key, clubs)
    return clubs


# ── Core per-course function ───────────────────────────────────────────────────

async def get_course_golf_data(
    our_course_id: str,
    golfapi_course_id: str,
    *,
    force: bool = False,
    client: Optional[GolfApiClient] = None,
    cache_store: Optional[CacheStore] = None,
    budget_store: Optional[BudgetStore] = None,
    cap: int = HARD_STOP_AT,
) -> Optional[list[dict]]:
    """Cache-first, budget-gated per-course coordinate fetch.

    Makes exactly **1 GolfAPI API call** on a cache miss (``/coordinates/{id}``).
    Does NOT pull ``/courses/{id}`` detail — use a separate call if detail is
    needed.  This keeps per-course cost at 1 call, allowing ~45 unique courses
    per month within the safety margin.

    Decision tree:

    1. **Cache hit** (not ``force``): return stored coords, 0 API calls.
    2. **No token**: log and return cached/None — no call, no crash.
    3. **No mapping**: ``golfapi_course_id`` is empty — return ``None``.
    4. **Budget exceeded**: log warning, return stale/None — no call.
    5. **Fetch coordinates**: call ``client.fetch_coordinates()`` once.
    6. **Normalize** raw response → per-hole dicts.
    7. **Persist** to ``cache_store``; return normalized coords.

    Parameters
    ----------
    our_course_id:
        Our internal course UUID (``_deterministic_uuid`` output).
    golfapi_course_id:
        GolfAPI numeric course ID.  Pass ``""`` when not yet known.
    force:
        Bypass the cache and re-fetch (still subject to budget guard).
    client:
        Injectable GolfAPI HTTP client.  Defaults to ``HttpxGolfApiClient``.
    cache_store:
        Injectable coordinate cache.  Defaults to ``FileCacheStore``.
    budget_store:
        Injectable budget counter.  Defaults to ``FileBudgetStore``.
    cap:
        Hard-stop threshold (default ``HARD_STOP_AT`` = 45 calls/month).

    Returns
    -------
    list[dict] | None
        Per-hole coordinate list or ``None`` when not yet available.
    """
    _cache = cache_store if cache_store is not None else FileCacheStore()
    _budget = budget_store if budget_store is not None else FileBudgetStore()

    # 1. CACHE-FIRST ──────────────────────────────────────────────────────────────
    if not force and _cache.is_cached(our_course_id):
        log.info(
            "golfapi_cache: cache-hit course=%s — 0 API calls", our_course_id
        )
        return _cache.get_cached(our_course_id)

    # 2. NO TOKEN ─────────────────────────────────────────────────────────────────
    if not os.getenv("GOLF_API_KEY"):
        log.info(
            "GolfAPI token not configured; using cache/mock for course=%s",
            our_course_id,
        )
        return _cache.get_cached(our_course_id)

    # 3. NO GOLFAPI COURSE ID MAPPING ─────────────────────────────────────────────
    if not golfapi_course_id:
        log.info(
            "golfapi_cache: no GolfAPI ID mapped for course=%s — skip",
            our_course_id,
        )
        return None

    # 4. BUDGET GUARD ─────────────────────────────────────────────────────────────
    current = _budget.current_month_calls()
    if current + CALLS_PER_COURSE > cap:
        log.warning(
            "golfapi_budget: HARD-STOP — would exceed cap=%d "
            "(current=%d, need=%d). Skipping fetch for course=%s.",
            cap, current, CALLS_PER_COURSE, our_course_id,
        )
        return _cache.get_cached(our_course_id)

    # 5. FETCH COORDINATES (1 API call) ──────────────────────────────────────────
    _client = client if client is not None else HttpxGolfApiClient()
    try:
        raw_coords = await _client.fetch_coordinates(golfapi_course_id)
        log.info(
            "golfapi_cache: fetch_coordinates done course=%s golfapi_id=%s "
            "(client.call_count=%d)",
            our_course_id, golfapi_course_id, _client.call_count,
        )
    except Exception as exc:
        log.error(
            "golfapi_cache: fetch_coordinates failed course=%s golfapi_id=%s: %s",
            our_course_id, golfapi_course_id, exc,
        )
        return _cache.get_cached(our_course_id)

    # Credit 1 real HTTP call against the monthly budget.
    _budget.add_calls(CALLS_PER_COURSE)

    # 6. NORMALIZE ────────────────────────────────────────────────────────────────
    normalized = normalize_golfapi_coordinates(raw_coords)

    # 7. PERSIST ──────────────────────────────────────────────────────────────────
    _cache.set_cached(our_course_id, normalized)

    return normalized
