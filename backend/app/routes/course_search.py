"""Course search routes (migrated from Next.js /api/courses/search and search-osm)."""

from fastapi import APIRouter, HTTPException, Query
import httpx
import os
from typing import Optional
from urllib.parse import quote
from app.services.osm import search_golf_courses, search_osm_with_geometry

router = APIRouter(prefix="/api/courses", tags=["course-search"])

MAPBOX_TOKEN = os.getenv("NEXT_PUBLIC_MAPBOX_TOKEN", os.getenv("MAPBOX_TOKEN", ""))
# Server-side Google Places key (NOT the iOS-SDK bundle-restricted key — that
# won't work for the Places web service). Set GOOGLE_PLACES_API_KEY in the backend
# env / Secrets Manager to a key with the "Places API (New)" enabled.
GOOGLE_PLACES_API_KEY = os.getenv("GOOGLE_PLACES_API_KEY", "")


async def _search_google_places(query: str) -> list[dict]:
    """Robust text search for a golf course by name via Google Places API (New).

    "Bethpage Black" → "Bethpage Black Course" with a precise location, which the
    fragile OSM name-match + Mapbox geocoding chain misses. No-op (returns []) when
    the key is absent, so search still works without it."""
    if not GOOGLE_PLACES_API_KEY:
        return []
    url = "https://places.googleapis.com/v1/places:searchText"
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location",
    }
    body = {"textQuery": query, "includedType": "golf_course", "maxResultCount": 10}
    async with httpx.AsyncClient(timeout=8) as client:
        try:
            resp = await client.post(url, headers=headers, json=body)
            if not resp.is_success:
                return []
            data = resp.json()
            out: list[dict] = []
            for p in data.get("places", []):
                loc = p.get("location") or {}
                lat, lng = loc.get("latitude"), loc.get("longitude")
                if lat is None or lng is None:
                    continue
                out.append({
                    "id": f"gplaces-{p.get('id')}",
                    "name": (p.get("displayName") or {}).get("text") or query,
                    "address": p.get("formattedAddress"),
                    "center": {"lat": lat, "lng": lng},
                    "source": "google_places",
                })
            return out
        except Exception:
            return []


def _dedupe_by_name(courses: list[dict]) -> list[dict]:
    """First occurrence of each course name wins. Callers list geometry-rich OSM
    results before location-only ones, so geometry wins on a name tie."""
    seen: set[str] = set()
    out: list[dict] = []
    for c in courses:
        key = (c.get("name") or "").strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


def _mapbox_geocode_url(query: str) -> str:
    """Build the Mapbox geocoding URL for a user query.

    Mapbox puts the search term in the URL PATH, so the query must be encoded —
    `quote(safe="")` escapes "/", "?", "#", "." etc. so a query like "foo/bar"
    or "../x" can't manipulate the request path (path-injection guard)."""
    return f"https://api.mapbox.com/geocoding/v5/mapbox.places/{quote(query, safe='')}.json"


async def _search_mapbox(query: str) -> list[dict]:
    """Search Mapbox for places (fallback when OSM has no results)."""
    if not MAPBOX_TOKEN:
        return []
    url = _mapbox_geocode_url(query)
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
    """Search for golf courses by name.

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
