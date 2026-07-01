"""Course search routes (migrated from Next.js /api/courses/search and search-osm).

The Google Places / Mapbox / de-dupe helpers live in services/course_finder.py
(shared with the tee-time AffiliateLinkProvider); the aliases below preserve this
module's private names for existing callers and tests.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
import os
from typing import Optional
from app.services import course_finder
from app.services.clerk_auth import current_user_id
from app.services.osm import search_golf_courses, search_osm_with_geometry

router = APIRouter(prefix="/api/courses", tags=["course-search"])

MAPBOX_TOKEN = course_finder.MAPBOX_TOKEN
# Kept as a module global so tests can monkeypatch it (see test_course_search.py);
# passed explicitly into the shared helper on every call.
GOOGLE_PLACES_API_KEY = os.getenv("GOOGLE_PLACES_API_KEY", "")

_dedupe_by_name = course_finder.dedupe_by_name
_mapbox_geocode_url = course_finder.mapbox_geocode_url
_search_mapbox = course_finder.search_mapbox


async def _search_google_places(query: str) -> list[dict]:
    """Delegates to the shared helper with this module's (monkeypatchable) key."""
    return await course_finder.search_google_places(query, api_key=GOOGLE_PLACES_API_KEY)


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

    Sources, merged best-first (geometry-rich results before location-only):
      1. OSM by name — full hole geometry when the name matches.
      2. Google Places (New) text search — robust name → course + precise
         location — then OSM courses NEAR that location to attach geometry.
      3. Mapbox geocoding — legacy fallback.
    De-duplicated by course name.
    """
    osm_named = await search_golf_courses(name=q)
    places = await _search_google_places(q)

    # Attach hole geometry to a Places hit by pulling OSM courses near it.
    nearby: list[dict] = []
    if places:
        top = places[0]
        nearby = await search_golf_courses(
            lat=top["center"]["lat"], lng=top["center"]["lng"], radius_m=8000,
        )

    combined = _dedupe_by_name(osm_named + nearby + places)
    if combined:
        return {"courses": combined, "query": q}

    # Fallback: legacy Mapbox geocoding → OSM nearby.
    mapbox_results = await _search_mapbox(q)
    if mapbox_results:
        top = mapbox_results[0]
        near = await search_golf_courses(
            lat=top["center"]["lat"], lng=top["center"]["lng"], radius_m=20000,
        )
        if near:
            return {"courses": near, "query": q, "searchedNear": top["name"]}
    return {"courses": mapbox_results[:15], "query": q}


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
