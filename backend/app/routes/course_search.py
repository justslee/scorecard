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
    if results:
        _nearby_cache.set(key, results)
    return {"courses": results}
