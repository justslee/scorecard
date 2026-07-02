"""Course search routes (migrated from Next.js /api/courses/search and search-osm).

The Google Places / Mapbox / de-dupe / relevance-gate / ranking helpers live in
services/course_finder.py (shared with the tee-time AffiliateLinkProvider); the
aliases below preserve this module's private names for existing callers/tests.
"""

import asyncio
import os
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.services import course_finder
from app.services.clerk_auth import current_user_id
from app.services.course_search_cache import FileSearchCacheStore, SearchCacheStore
from app.services.osm import search_golf_courses, search_osm_with_geometry

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
_search_cache: SearchCacheStore = FileSearchCacheStore()


async def _search_google_places(query: str) -> list[dict]:
    """Delegates to the shared helper with this module's (monkeypatchable) key,
    on the tight interactive latency budget (4s)."""
    return await course_finder.search_google_places(
        query, api_key=GOOGLE_PLACES_API_KEY, timeout_s=4.0,
    )


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


@router.get("/search")
async def search_courses(
    q: str = Query(..., min_length=1),
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
      3. Fan out (only when local is thin) — OSM-by-name + Google Places run
         CONCURRENTLY (asyncio.gather) on tight interactive budgets. A Places
         hit's location seeds a NAME-FILTERED nearby OSM search (8km) so a
         multi-course facility (Bethpage) expands to its sibling courses
         without losing the name filter.
      4. Mapbox fallback (only when nothing else matched) — a geocode hit is
         used ONLY as a location anchor for a name-filtered OSM search near
         it; the geocoder place itself is NEVER returned as a course (that
         was the "Bethel Island" town-name bug).
      5. Relevance gate — EVERY candidate, from EVERY source, must pass
         ``matches_query_prefix`` before it can be returned. Ranked (exact >
         all-token-prefix > local source > distance-to-anchor > alpha).
      6. Write-through — new external hits are persisted into ``courses``
         (deterministic id, ON CONFLICT DO NOTHING) so the next identical
         search is local-fast.
    """
    cache_key = course_finder.normalize_query(q)
    if not cache_key:
        return {"courses": [], "query": q}

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
        return {"courses": ranked, "query": q}

    # 2. FAN OUT — independent external calls run concurrently.
    osm_named, places = await asyncio.gather(
        search_golf_courses(name=q, interactive=True),
        _search_google_places(q),
    )

    # Attach hole geometry to a Places hit via a NAME-FILTERED nearby OSM
    # search — the facility-expansion results still pass the relevance gate
    # below, so "bethpage" expands to Black/Red/Green while "bethpage black"
    # stays filtered to Black.
    nearby: list[dict] = []
    anchor: Optional[dict] = None
    if places:
        anchor = places[0]["center"]
        nearby = await search_golf_courses(
            name=q, lat=anchor["lat"], lng=anchor["lng"], radius_m=8000, interactive=True,
        )

    combined = _dedupe_by_name(local_passing + osm_named + nearby + places)
    searched_near: Optional[str] = None

    if not combined:
        # 3. Fallback: Mapbox geocode → LOCATION ANCHOR ONLY. The geocoder
        # place is never emitted as a course; it only seeds a name-filtered
        # OSM search near it (same 8km facility-expansion radius).
        mapbox_results = await _search_mapbox(q, timeout_s=4.0)
        if mapbox_results:
            top = mapbox_results[0]
            anchor = top["center"]
            searched_near = top["name"]
            combined = await search_golf_courses(
                name=q, lat=anchor["lat"], lng=anchor["lng"], radius_m=8000, interactive=True,
            )

    # 4. Relevance gate — applies to ALL sources, including Places/OSM hits
    # that made it this far without a name filter.
    gated = [
        c for c in combined if course_finder.matches_query_prefix(c.get("name") or "", q)
    ]
    ranked = course_finder.rank_courses(gated, q, anchor=anchor)

    # 5. Write-through: only NEW external (non-local) hits need persisting.
    external_hits = [c for c in ranked if c.get("source") not in course_finder.LOCAL_SOURCES]
    course_finder.attach_stable_ids(external_hits)
    await _write_through_courses(course_finder.external_course_rows(external_hits))

    _search_cache.set(cache_key, ranked)

    if searched_near and ranked:
        return {"courses": ranked, "query": q, "searchedNear": searched_near}
    return {"courses": ranked, "query": q}


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
    """Find courses near GPS coordinates using OSM."""
    results = await search_golf_courses(
        lat=lat,
        lng=lng,
        radius_m=radiusMeters or 50000,
    )
    return {"courses": results}
