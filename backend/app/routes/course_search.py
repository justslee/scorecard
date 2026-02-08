"""Course search routes (migrated from Next.js /api/courses/search and search-osm)."""

from fastapi import APIRouter, HTTPException, Query
import httpx
import os
from typing import Optional
from app.services.osm import search_golf_courses, search_osm_with_geometry

router = APIRouter(prefix="/api/courses", tags=["course-search"])

MAPBOX_TOKEN = os.getenv("NEXT_PUBLIC_MAPBOX_TOKEN", os.getenv("MAPBOX_TOKEN", ""))


async def _search_mapbox(query: str) -> list[dict]:
    """Search Mapbox for places (fallback when OSM has no results)."""
    if not MAPBOX_TOKEN:
        return []
    url = f"https://api.mapbox.com/geocoding/v5/mapbox.places/{query}.json"
    async with httpx.AsyncClient(timeout=8) as client:
        try:
            resp = await client.get(url, params={"limit": 10, "access_token": MAPBOX_TOKEN})
            if not resp.is_success:
                return []
            data = resp.json()
            return [
                {
                    "id": f"mapbox-{f['id']}",
                    "name": f.get("text") or f.get("place_name", "").split(",")[0] or query,
                    "address": f.get("place_name"),
                    "center": {"lat": f["center"][1], "lng": f["center"][0]},
                    "source": "mapbox",
                }
                for f in data.get("features", [])
            ]
        except Exception:
            return []


@router.get("/search")
async def search_courses(q: str = Query(..., min_length=1)):
    """Search for golf courses by name (OSM primary, Mapbox fallback)."""
    # 1. Search OSM by name
    osm_results = await search_golf_courses(name=q)
    if osm_results:
        return {"courses": osm_results, "query": q}

    # 2. Fallback: Mapbox location search, then OSM nearby
    mapbox_results = await _search_mapbox(q)
    if mapbox_results:
        top = mapbox_results[0]
        nearby = await search_golf_courses(
            lat=top["center"]["lat"],
            lng=top["center"]["lng"],
            radius_m=20000,
        )
        if nearby:
            return {"courses": nearby, "query": q, "searchedNear": top["name"]}

    # 3. Last resort: return Mapbox results
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
