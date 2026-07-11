"""Course search routes (migrated from Next.js /api/courses/search and search-osm).

The Google Places / Mapbox / de-dupe / relevance-gate / ranking helpers live in
services/course_finder.py (shared with the tee-time AffiliateLinkProvider); the
aliases below preserve this module's private names for existing callers/tests.

course-search-v2 (2026-07-06): the un-anchored global OSM name scan is GONE —
it was a planet-wide Overpass regex with no location filter, always timed out
(~11s, 0 results, verified live), and never contributed a single result. OSM is
now used ONLY anchored (around a Google Places / Mapbox center), and even then
only as a non-blocking BackgroundTasks enrichment step so a multi-course
facility (Bethpage Black/Red/Green) fills in for the *next* identical search
without adding latency to this one. See specs/course-search-v2-plan.md.
"""

import asyncio
import logging
import math
import os
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query

from app.services import course_finder
from app.services import golfapi_cache
from app.services.clerk_auth import current_user_id
from app.services.course_search_cache import FileSearchCacheStore, SearchCacheStore
from app.services.osm import search_golf_courses, search_osm_with_geometry

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/courses", tags=["course-search"])

MAPBOX_TOKEN = course_finder.MAPBOX_TOKEN
# Kept as a module global so tests can monkeypatch it (see test_course_search.py);
# passed explicitly into the shared helper on every call.
GOOGLE_PLACES_API_KEY = os.getenv("GOOGLE_PLACES_API_KEY", "")

_dedupe_by_name = course_finder.dedupe_by_name
_mapbox_geocode_url = course_finder.mapbox_geocode_url
_search_mapbox = course_finder.search_mapbox

# Local-first short-circuit: fan out to external sources only when the local
# (our DB) relevance-passing hit count is below this.
_LOCAL_MIN_HITS = 3

# 24h positive / 5min negative TTL cache, keyed by the normalized query — course
# names don't churn, so a repeat search should be instant, not re-hit externals.
# Cache policy (A2): the route (not the store) decides WHEN to call `.set()` —
# see the "all_external_ok" gate in search_courses. An empty result is cached
# negative ONLY when every attempted external leg genuinely came up empty
# (ok/empty), never when one errored/timed out (that would poison a real
# course out of the cache for 5 minutes on a transient failure).
_search_cache: SearchCacheStore = FileSearchCacheStore()

# Positive-only quantized geo-cell cache for /api/courses/nearby's OSM leg
# (search-speed-and-golfapi-verify, latency half). Distinct file from
# `_search_cache` above — nearby is keyed by GPS cell + radius, not by a
# normalized name query, so the two must never share a JSON file.
_nearby_cache: SearchCacheStore = FileSearchCacheStore(
    path=Path(__file__).parent.parent.parent / "data" / "nearby_search_cache.json"
)

# ~1.1 km cell at mid-latitudes (2 decimal places of lat/lng).
NEARBY_CELL_DECIMALS = 2


def _nearby_cache_key(lat: float, lng: float, radius_m: int) -> str:
    """Quantize a GPS point + radius into a stable cache key so nearby opens
    from (roughly) the same spot hit the same cell, without needing an exact
    coordinate match. Pure/no I/O — unit-testable in isolation."""
    return f"nearby:{round(lat, NEARBY_CELL_DECIMALS)}:{round(lng, NEARBY_CELL_DECIMALS)}:{radius_m}"


# ── /api/courses/in-bounds (course-selection B1) ────────────────────────────
# Positive-only quantized geo-cell cache for the viewport-bbox OSM fill leg.
# DEDICATED file — never share a JSON namespace with `_search_cache` (keyed by
# normalized name query) or `_nearby_cache` (keyed by GPS point + radius);
# in-bounds is keyed by fixed ~0.05° geo-cell so overlapping/panned viewports
# reuse each other's warm cells.
_in_bounds_cache: SearchCacheStore = FileSearchCacheStore(
    path=Path(__file__).parent.parent.parent / "data" / "in_bounds_search_cache.json"
)

# ~5.5 km N–S per cell.
IN_BOUNDS_CELL_DEG = 0.05
# Per-request cap on COLD-cell OSM fetches (concurrent, via asyncio.gather).
# Bounds wall time (~one interactive OSM budget, not N×) and is polite to the
# public overpass-api.de mirror (a handful of parallel slots per IP). Skipped
# cold cells simply warm on a later pan — the DB leg keeps that area honest
# meanwhile via any previously write-through'd course.
IN_BOUNDS_MAX_COLD_CELLS = 4
# Cap on returned pins (spec §B.1 "Cap ~40 pins"), applied after merge/dedupe.
# DB pins are listed before OSM pins so truncation drops far OSM extras, never
# central DB courses.
IN_BOUNDS_MAX_PINS = 40
# Viewport area (sq degrees) above which pins are meaningless and every leg is
# skipped entirely — see the handler docstring for the derivation.
IN_BOUNDS_MAX_AREA_SQDEG = 0.25


def _in_bounds_cell_key(ilat: int, ilng: int) -> str:
    """Versioned per-cell cache key ("v1") so a future cell-scheme change
    can't silently collide with stale entries. Pure/no I/O."""
    return f"inbounds:v1:{ilat}:{ilng}"


def _cells_for_bbox(sw_lat: float, sw_lng: float, ne_lat: float, ne_lng: float) -> list[tuple[int, int]]:
    """Every integer ``(ilat, ilng)`` cell index intersecting the bbox, sorted
    by cell-center distance to the bbox center ascending — so the cold-cell
    fanout cap spends its budget on the middle of the viewport first. Integer
    floor-indices (not rounded floats) avoid float-formatting/`-0.0`
    collisions. Pure/no I/O — unit-testable in isolation."""
    ilat_min = math.floor(sw_lat / IN_BOUNDS_CELL_DEG)
    ilat_max = math.floor(ne_lat / IN_BOUNDS_CELL_DEG)
    ilng_min = math.floor(sw_lng / IN_BOUNDS_CELL_DEG)
    ilng_max = math.floor(ne_lng / IN_BOUNDS_CELL_DEG)
    c_lat = (sw_lat + ne_lat) / 2
    c_lng = (sw_lng + ne_lng) / 2

    scored: list[tuple[float, int, int]] = []
    for ilat in range(ilat_min, ilat_max + 1):
        for ilng in range(ilng_min, ilng_max + 1):
            cell_lat = (ilat + 0.5) * IN_BOUNDS_CELL_DEG
            cell_lng = (ilng + 0.5) * IN_BOUNDS_CELL_DEG
            dist_sq = (cell_lat - c_lat) ** 2 + (cell_lng - c_lng) ** 2
            scored.append((dist_sq, ilat, ilng))
    scored.sort(key=lambda t: t[0])
    return [(ilat, ilng) for _, ilat, ilng in scored]


def _validate_in_bounds_bbox(sw_lat: float, sw_lng: float, ne_lat: float, ne_lng: float) -> None:
    """Semantic bbox validation (FastAPI already coerced these to floats, but
    accepts ``nan``/``inf`` as valid floats — that's ours to reject)."""
    for v in (sw_lat, sw_lng, ne_lat, ne_lng):
        if not math.isfinite(v):
            raise HTTPException(400, "bbox values must be finite numbers")
    if sw_lat < -90 or ne_lat > 90 or sw_lng < -180 or ne_lng > 180:
        raise HTTPException(400, "bbox values out of range")
    if sw_lat >= ne_lat:
        raise HTTPException(400, "swLat must be < neLat")
    if sw_lng >= ne_lng:
        # Intentionally rejects antimeridian-crossing boxes — out of B1 scope,
        # see specs/course-selection-b1-plan.md §7.
        raise HTTPException(400, "swLng must be < neLng")


# ── Leg helpers ────────────────────────────────────────────────────────────────

async def _search_google_places(query: str) -> list[dict]:
    """Delegates to the shared helper with this module's (monkeypatchable) key,
    on the tight interactive latency budget (4s). ``raise_on_error=True`` so
    this route's ``_run_leg`` wrapper can classify a real API failure (e.g. a
    403 SERVICE_DISABLED on a key without "Places API (New)" enabled) as
    outcome "error" instead of an indistinguishable empty list."""
    return await course_finder.search_google_places(
        query, api_key=GOOGLE_PLACES_API_KEY, timeout_s=4.0, raise_on_error=True,
    )


async def _search_golfapi(query: str) -> list[dict]:
    """Internal GolfAPI leg (course-search-v2 A4) — reuses the cache-first,
    budget-guarded client in services/golfapi_cache.py so this costs at most
    ONE `/clubs?name=q` call per distinct query (0 calls on a cache hit, 0
    calls with no GOLF_API_KEY configured — see discover_golfapi_clubs).

    Maps each club's course(s) into this route's course-dict shape. A club's
    courses all share the club's lat/lng (GolfAPI doesn't return per-course
    coordinates from `/clubs`) — good enough for an anchor/ranking distance;
    the per-hole coordinate fetch (services/golfapi_cache.get_course_golf_data)
    is a separate, much later step once a course is actually opened.
    """
    area_key = course_finder.normalize_query(query)
    if not area_key:
        return []
    clubs = await golfapi_cache.discover_golfapi_clubs(area_key, query)
    if not clubs:
        return []

    out: list[dict] = []
    for club in clubs:
        lat = _to_float(club.get("latitude") or club.get("lat"))
        lng = _to_float(club.get("longitude") or club.get("lng"))
        center = {"lat": lat, "lng": lng} if lat is not None and lng is not None else None
        address = ", ".join(
            part for part in (club.get("address"), club.get("city"), club.get("state")) if part
        ) or None
        club_name = club.get("clubName") or club.get("name")
        for c in club.get("courses") or []:
            course_id = c.get("courseID") or c.get("id")
            name = c.get("courseName") or c.get("name") or club_name
            if not name:
                continue
            out.append({
                "id": f"golfapi-{course_id}" if course_id else None,
                "name": name,
                "address": address,
                "center": center,
                "source": "golfapi",
            })
    return out


def _to_float(val) -> Optional[float]:
    if val is None or val == "":
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


async def _run_leg(name: str, coro) -> tuple[list[dict], dict]:
    """Time + classify a single external leg. Never raises — one leg's failure
    can never fail the whole request. Returns ``(results, LegHealth)`` where
    LegHealth is ``{"source", "outcome", "count", "ms", "detail"?}`` and
    outcome is one of "ok" | "empty" | "error" | "timeout".

    A leg raising is logged at WARNING (so a prod key-not-enabled 403 or any
    other failure shows up in logs, not just a silent empty list) and recorded
    as outcome "error" so the cache-poisoning fix (A2) can tell a genuine
    no-match from a masked failure.
    """
    start = time.monotonic()
    try:
        result = await coro
    except asyncio.TimeoutError as exc:
        ms = int((time.monotonic() - start) * 1000)
        log.warning("course_search leg=%s outcome=timeout ms=%d", name, ms)
        return [], {"source": name, "outcome": "timeout", "count": 0, "ms": ms, "detail": str(exc)[:200]}
    except Exception as exc:
        ms = int((time.monotonic() - start) * 1000)
        log.warning("course_search leg=%s outcome=error ms=%d detail=%s", name, ms, exc)
        return [], {"source": name, "outcome": "error", "count": 0, "ms": ms, "detail": str(exc)[:200]}
    ms = int((time.monotonic() - start) * 1000)
    outcome = "ok" if result else "empty"
    return result, {"source": name, "outcome": outcome, "count": len(result), "ms": ms}


async def _list_local_courses(q: str) -> list[dict]:
    """Ranked local (our DB) name search — the LOCAL-FIRST step.

    Lazily imports services/courses_mapped so this route module (and its
    tests) can be collected/run WITHOUT a live DATABASE_URL; the import (and
    its DB round-trip) only happens when this function actually runs. Unit
    tests monkeypatch this function directly instead of hitting a real DB;
    integration tests exercise the real path end-to-end.
    """
    from app.services import courses_mapped

    rows = await courses_mapped.list_courses(search=q)
    return [
        {
            "id": r["id"],
            "name": r.get("name"),
            "address": r.get("address"),
            "center": r.get("location"),
            "source": "local",
        }
        for r in rows
    ]


async def _db_courses_in_bounds(sw_lat: float, sw_lng: float, ne_lat: float, ne_lng: float) -> list[dict]:
    """Ranked-by-center-proximity DB bbox lookup — the /in-bounds honesty
    floor. Lazily imports services/courses_mapped for the same reason as
    :func:`_list_local_courses`: the module (and its unit tests) stay
    collectible/runnable WITHOUT a live DATABASE_URL."""
    from app.services import courses_mapped

    rows = await courses_mapped.courses_in_bounds(sw_lat, sw_lng, ne_lat, ne_lng, limit=60)
    return [
        {
            "id": r["id"],
            "name": r.get("name"),
            "address": r.get("address"),
            "center": r.get("location"),
            "source": "local",
        }
        for r in rows
    ]


async def _write_through_courses(rows: list[dict]) -> None:
    """Persist write-through rows — lazy import for the same reason as
    :func:`_list_local_courses`. No-op on an empty list (never touches the DB
    for a pure-cache-hit or all-local-hit request)."""
    if not rows:
        return
    from app.services import courses_mapped

    await courses_mapped.write_through_courses(rows)


async def _enrich_and_write_through(q: str, anchor: dict, ranked: list[dict]) -> None:
    """Non-blocking (BackgroundTasks) enrichment: an anchored 8km OSM search
    for sibling courses at the same facility (e.g. Bethpage Black/Red/Green)
    that the interactive Places/GolfAPI legs alone wouldn't surface, plus
    write-through of everything new. Runs AFTER the response has already been
    sent, so a slow/unreliable Overpass mirror never adds interactive latency
    — it just means the facility's siblings aren't complete until the *next*
    identical search (which is then local-fast, per the cache/local-first
    steps above)."""
    external_hits = [
        c for c in ranked if c.get("source") not in course_finder.LOCAL_SOURCES
    ]
    try:
        osm_hits = await search_golf_courses(
            name=q, lat=anchor["lat"], lng=anchor["lng"], radius_m=8000, interactive=True,
        )
    except Exception as exc:
        log.warning("course_search background OSM enrichment failed q=%r: %s", q, exc)
        osm_hits = []
    gated_osm = [
        c for c in osm_hits if course_finder.matches_query_prefix(c.get("name") or "", q)
    ]
    combined = course_finder.dedupe_by_name(external_hits + gated_osm)
    course_finder.attach_stable_ids(combined)
    await _write_through_courses(course_finder.external_course_rows(combined))


@router.get("/search")
async def search_courses(
    q: str = Query(..., min_length=1),
    background_tasks: BackgroundTasks = None,  # type: ignore[assignment]
    _user_id: str = Depends(current_user_id),
):
    """Search for golf courses by name.

    Auth required: this endpoint calls the PAID Google Places API, so it is gated
    behind a verified Clerk session (like the caddie endpoints) to prevent
    anonymous abuse of the metered quota. The app already sends the owner Bearer
    via fetchAPI, so this is transparent for the real client.

    Pipeline (local-first, relevance-gated, ranked, cached):
      1. Cache — normalized-query TTL cache; instant on a hit.
      2. LOCAL FIRST — our DB (courses_mapped, pg_trgm-ranked) is the canonical
         index; external sources are skipped entirely when local already has
         >= 3 relevance-passing hits for this query.
      3. Fan out (only when local is thin) — Google Places (PRIMARY) and the
         internal GolfAPI leg run CONCURRENTLY (asyncio.gather), each wrapped
         in a timing/health guard (_run_leg) so one leg's failure never fails
         the whole request. NO un-anchored OSM — that leg was a planet-wide
         Overpass scan that always timed out and never contributed.
      4. Mapbox fallback (only when nothing else matched) — a geocode hit is
         used ONLY as a location anchor for a name-filtered OSM search near
         it; the geocoder place itself is NEVER returned as a course (that
         was the "Bethel Island" town-name bug).
      5. Relevance gate — EVERY candidate, from EVERY source, must pass
         ``matches_query_prefix`` before it can be returned. Ranked (exact >
         all-token-prefix > local source > distance-to-anchor > alpha).
      6. Enrichment + write-through — when an anchor exists and hasn't already
         been searched inline (the Mapbox-fallback path already ran the
         anchored OSM search synchronously), an 8km anchored OSM search for
         facility siblings + write-through runs in a FastAPI BackgroundTasks
         job — AFTER the response is sent, never adding to interactive
         latency. Otherwise (no anchor, or already searched inline) this
         search's own external hits are write-through'd in the background.
      7. Cache policy — positive results always cache (24h). An empty result
         caches negative (5min) ONLY when every attempted external leg was
         genuinely ok/empty; if any leg errored or timed out, the empty
         result is NOT cached, so the next identical search retries instead
         of being poisoned by a transient failure for 5 minutes.
    """
    bg = background_tasks if background_tasks is not None else BackgroundTasks()

    cache_key = course_finder.normalize_query(q)
    if not cache_key:
        return {"courses": [], "query": q, "legHealth": []}

    cached = _search_cache.get(cache_key)
    if cached is not None:
        return {"courses": cached, "query": q}

    # 1. LOCAL FIRST.
    local_results = await _list_local_courses(q)
    local_passing = [
        c for c in local_results if course_finder.matches_query_prefix(c.get("name") or "", q)
    ]

    if len(local_passing) >= _LOCAL_MIN_HITS:
        ranked = course_finder.rank_courses(local_passing, q)
        _search_cache.set(cache_key, ranked)
        return {"courses": ranked, "query": q, "legHealth": []}

    # 2. FAN OUT — Places is the PRIMARY external text search.
    places, places_health = await _run_leg("google_places", _search_google_places(q))
    leg_health: list[dict] = [places_health]

    # GolfAPI is a METERED fallback, not a parallel leg: its 45-calls/MONTH
    # budget is shared with the per-course golf-data fetches, and every
    # distinct typed prefix ("pe", "peb", …) is a fresh discovery cache key —
    # running it on every fan-out would burn the month's quota on keystrokes.
    # Attempt it only when Places found nothing (coverage backstop).
    golfapi: list[dict] = []
    if not places:
        golfapi, golfapi_health = await _run_leg("golfapi", _search_golfapi(q))
        leg_health.append(golfapi_health)

    combined = _dedupe_by_name(local_passing + places + golfapi)
    anchor: Optional[dict] = places[0]["center"] if places else None
    searched_near: Optional[str] = None
    # Set when the anchored OSM search already ran INLINE (Mapbox-fallback
    # path below) so the background enrichment step doesn't re-run it.
    osm_ran_inline = False

    if not combined:
        # 3. Fallback: Mapbox geocode → LOCATION ANCHOR ONLY. The geocoder
        # place is never emitted as a course; it only seeds a name-filtered
        # OSM search near it (same 8km facility-expansion radius). Nothing
        # else matched, so it's worth the wait — this leg runs inline.
        mapbox_results, mapbox_health = await _run_leg(
            "mapbox", _search_mapbox(q, timeout_s=4.0)
        )
        leg_health.append(mapbox_health)
        if mapbox_results:
            top = mapbox_results[0]
            anchor = top["center"]
            searched_near = top["name"]
            combined, osm_health = await _run_leg(
                "anchored_osm",
                search_golf_courses(
                    name=q, lat=anchor["lat"], lng=anchor["lng"], radius_m=8000, interactive=True,
                ),
            )
            leg_health.append(osm_health)
            osm_ran_inline = True

    # 4. Relevance gate — applies to ALL sources, including Places/OSM/GolfAPI
    # hits that made it this far without a name filter.
    gated = [
        c for c in combined if course_finder.matches_query_prefix(c.get("name") or "", q)
    ]
    ranked = course_finder.rank_courses(gated, q, anchor=anchor)

    # 5. Write-through: only NEW external (non-local) hits need persisting.
    external_hits = [c for c in ranked if c.get("source") not in course_finder.LOCAL_SOURCES]
    course_finder.attach_stable_ids(external_hits)

    # 6. Enrichment + write-through — non-blocking (BackgroundTasks). When an
    # anchor exists and the anchored OSM search hasn't already run inline
    # (Mapbox-fallback path), schedule the full enrichment; otherwise just
    # persist this search's own external hits.
    if anchor and not osm_ran_inline:
        bg.add_task(_enrich_and_write_through, q, anchor, ranked)
    else:
        bg.add_task(_write_through_courses, course_finder.external_course_rows(external_hits))

    # 7. Cache policy (A2) — never poison an empty result caused by a leg
    # error/timeout; a genuine empty (all attempted legs ok/empty) is safe to
    # negative-cache, same as a positive result is always safe to cache.
    all_external_ok = all(h["outcome"] in ("ok", "empty") for h in leg_health)
    if ranked or all_external_ok:
        _search_cache.set(cache_key, ranked)

    response = {"courses": ranked, "query": q, "legHealth": leg_health}
    if searched_near and ranked:
        response["searchedNear"] = searched_near
    return response


@router.get("/search-osm")
async def search_osm(
    q: Optional[str] = Query(None),
    lat: Optional[float] = Query(None),
    lng: Optional[float] = Query(None),
    radiusMeters: Optional[int] = Query(50000),
):
    """Direct OSM search with full geometry."""
    if not q and (lat is None or lng is None):
        raise HTTPException(400, "Provide q (name) or lat/lng for nearby search")

    radius = max(5000, min(100000, radiusMeters or 50000))
    results = await search_osm_with_geometry(
        name=q,
        lat=lat,
        lng=lng,
        radius_m=radius,
    )
    return {"courses": results}


@router.get("/nearby")
async def nearby_courses(
    lat: float = Query(...),
    lng: float = Query(...),
    radiusMeters: Optional[int] = Query(50000),
):
    """Find courses near GPS coordinates using OSM.

    Latency fix (search-speed-and-golfapi-verify): this leg used to run on
    OSM's generous non-interactive budget (up to ~12s, no cache) and blocked
    the whole `/api/courses/nearby` UI section behind it every single open.
    Now: (1) an interactive budget (~5.5s worst case, see
    ``services/osm.search_golf_courses``) and (2) a positive-only quantized
    geo-cell cache so a repeat open from (roughly) the same spot is instant.

    HONESTY (no-fake-data / no-error-empty law): ``search_golf_courses``
    returns ``[]`` for BOTH a genuine empty area AND a timeout/error — those
    are indistinguishable at this seam, so we cache POSITIVE results ONLY and
    never negative-cache nearby. A genuinely empty area simply re-queries on
    the next open (rare, safe, no user-visible cost).
    """
    radius = radiusMeters or 50000
    key = _nearby_cache_key(lat, lng, radius)
    cached = _nearby_cache.get(key)
    if cached is not None:
        return {"courses": cached}

    results = await search_golf_courses(
        lat=lat,
        lng=lng,
        radius_m=radius,
        interactive=True,
    )
    # Unify wire ids with /api/courses/search: OSM hits carry osm_id, not id,
    # so give them the deterministic write-through UUID (specs/teetime-
    # course-ids-wiring-plan.md §4.1) — otherwise a selection made here can
    # never be reconciled by the tee-time route's selection filter.
    results = course_finder.attach_stable_ids(results)
    if results:
        _nearby_cache.set(key, results)
    return {"courses": results}


async def _fetch_in_bounds_cell(ilat: int, ilng: int) -> tuple[int, int, Optional[list[dict]]]:
    """Fetch one cold geo-cell's OSM golf-course centers. Never raises to the
    caller — a failure is classified by returning ``None`` for ``hits`` so
    the handler can flag ``degraded`` without failing the whole request (the
    "honesty floor" — see the handler docstring)."""
    cell_lat = (ilat + 0.5) * IN_BOUNDS_CELL_DEG
    cell_lng = (ilng + 0.5) * IN_BOUNDS_CELL_DEG
    try:
        hits = await search_golf_courses(
            lat=cell_lat, lng=cell_lng, radius_m=4000, interactive=True,
        )
    except Exception as exc:
        log.warning(
            "in_bounds_courses: cold cell (%d,%d) OSM fetch failed: %s", ilat, ilng, exc,
        )
        return ilat, ilng, None
    return ilat, ilng, hits


@router.get("/in-bounds")
async def in_bounds_courses(
    swLat: float = Query(...),
    swLng: float = Query(...),
    neLat: float = Query(...),
    neLng: float = Query(...),
    background_tasks: BackgroundTasks = None,  # type: ignore[assignment]
):
    """Viewport bounding-box course PINS — course-selection B1 (backend-only
    slice of specs/course-selection-ux-plan.md §B.1; the map UI is a later
    B2 cycle). Real course centers only, cache-first and budget-safe.

    Auth: none — like ``/nearby`` and ``/search-osm``, this path NEVER calls a
    paid API (Google Places / GolfAPI), so it needs no Clerk gate.

    Three legs, in order:
      1. DB bbox (PostGIS ``ST_Intersects`` / ``ST_MakeEnvelope``) — ALWAYS
         runs; the honesty floor. Ordered center-proximity-first.
      2. OSM fill on ~0.05° geo-cells, COLD cells only (positive-only cache,
         dedicated ``in_bounds_search_cache.json``, write-through to the DB).
         A fully-warm viewport makes ZERO external calls. Cold-cell fanout is
         capped at ``IN_BOUNDS_MAX_COLD_CELLS`` (4) per request, run
         concurrently, closest-to-center cells first; cells beyond the cap
         are simply skipped this request and warm on a later pan.
      3. Merge (DB first, so a name tie keeps the canonical DB row) → dedupe
         by normalized (trimmed, lower-cased) name → attach stable ids → cap
         at ``IN_BOUNDS_MAX_PINS`` (40) → schedule a non-blocking write-through
         of this request's fresh OSM hits.

    BUDGET: this path NEVER calls Google Places, GolfAPI, or Mapbox — OSM
    only, geo-cell-cached. (Enforced by construction: no import of those
    legs is even reachable from this handler.)

    ``zoomIn: true`` — viewport area > ``IN_BOUNDS_MAX_AREA_SQDEG`` (0.25
    sq°, ~0.5°×0.5° ≈ a full metro area, the largest box where individual
    pins stay meaningful). Beyond it the box would span 100+ geo-cells
    (fanout explosion / hundreds of pins); the honest response is "zoom in"
    — ``courses: []`` and NO leg runs (not even the DB leg).

    ``degraded: true`` — a cold-cell OSM fetch RAISED (timeout/transport
    error) this request; DB pins are still returned, never an empty list.
    Documented residual limitation: ``search_golf_courses`` swallows most
    Overpass flakiness (timeout/429/5xx) into a plain ``[]`` inside
    ``_post_with_retry`` — indistinguishable from a genuinely empty cell at
    this seam, so most real flakiness will NOT raise and therefore will NOT
    set ``degraded``. Accepted for B1: the DB leg always returns real pins,
    empty cells are never cached (so they retry next request), and the
    write-through flywheel steadily shrinks OSM dependence. A cell that
    returns ``[]`` without raising is classified "empty", not "degraded",
    and is never cached (positive-only — the no-fake-data law: an empty
    result here is indistinguishable from a masked failure, so caching it
    would risk hiding a real course for the cache's TTL).

    Antimeridian-crossing boxes (``swLng > neLng``) are rejected with 400 by
    the ``swLng >= neLng`` validation check — out of B1 scope, no golf-market
    pressure there and splitting into two envelopes doubles every leg.
    """
    bg = background_tasks if background_tasks is not None else BackgroundTasks()

    _validate_in_bounds_bbox(swLat, swLng, neLat, neLng)

    area = (neLat - swLat) * (neLng - swLng)
    if area > IN_BOUNDS_MAX_AREA_SQDEG:
        return {"courses": [], "degraded": False, "zoomIn": True}

    db_pins = await _db_courses_in_bounds(swLat, swLng, neLat, neLng)

    warm_hits: list[dict] = []
    cold_cells: list[tuple[int, int]] = []
    for ilat, ilng in _cells_for_bbox(swLat, swLng, neLat, neLng):
        cached = _in_bounds_cache.get(_in_bounds_cell_key(ilat, ilng))
        if cached is not None:
            warm_hits.extend(cached)
        else:
            cold_cells.append((ilat, ilng))

    cold_cells = cold_cells[:IN_BOUNDS_MAX_COLD_CELLS]

    degraded = False
    fresh_hits: list[dict] = []
    if cold_cells:
        fetched = await asyncio.gather(
            *[_fetch_in_bounds_cell(ilat, ilng) for ilat, ilng in cold_cells]
        )
        for ilat, ilng, hits in fetched:
            if hits is None:
                degraded = True
                continue
            if not hits:
                continue
            hits = course_finder.attach_stable_ids(hits)
            _in_bounds_cache.set(_in_bounds_cell_key(ilat, ilng), hits)
            fresh_hits.extend(hits)

    merged = db_pins + warm_hits + fresh_hits
    deduped = course_finder.dedupe_by_name(merged)
    course_finder.attach_stable_ids(deduped)
    courses = deduped[:IN_BOUNDS_MAX_PINS]

    if fresh_hits:
        bg.add_task(_write_through_courses, course_finder.external_course_rows(fresh_hits))

    return {"courses": courses, "degraded": degraded, "zoomIn": False}
