"""Shared course-finding helpers (Google Places + Mapbox + name de-dupe).

Extracted from routes/course_search.py so other services (e.g. the tee-time
AffiliateLinkProvider) can find real courses WITHOUT HTTP-calling our own API.
The route module keeps thin aliases to these functions, so its behavior and
its tests are unchanged.
"""

from __future__ import annotations

import os
from urllib.parse import quote

import httpx

MAPBOX_TOKEN = os.getenv("NEXT_PUBLIC_MAPBOX_TOKEN", os.getenv("MAPBOX_TOKEN", ""))
# Server-side Google Places key (NOT the iOS-SDK bundle-restricted key — that
# won't work for the Places web service). Set GOOGLE_PLACES_API_KEY in the backend
# env / Secrets Manager to a key with the "Places API (New)" enabled.
GOOGLE_PLACES_API_KEY = os.getenv("GOOGLE_PLACES_API_KEY", "")


async def search_google_places(query: str, *, api_key: str | None = None) -> list[dict]:
    """Robust text search for a golf course by name via Google Places API (New).

    "Bethpage Black" → "Bethpage Black Course" with a precise location, which the
    fragile OSM name-match + Mapbox geocoding chain misses. No-op (returns []) when
    the key is absent, so search still works without it.

    ``api_key`` overrides the module-level key (the route passes its own global
    so tests can monkeypatch it there)."""
    key = api_key if api_key is not None else GOOGLE_PLACES_API_KEY
    if not key:
        return []
    url = "https://places.googleapis.com/v1/places:searchText"
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": (
            "places.id,places.displayName,places.formattedAddress,"
            "places.location,places.websiteUri,places.rating"
        ),
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
                    "website": p.get("websiteUri"),
                    "rating": p.get("rating"),
                    "source": "google_places",
                })
            return out
        except Exception:
            return []


def dedupe_by_name(courses: list[dict]) -> list[dict]:
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


def mapbox_geocode_url(query: str) -> str:
    """Build the Mapbox geocoding URL for a user query.

    Mapbox puts the search term in the URL PATH, so the query must be encoded —
    `quote(safe="")` escapes "/", "?", "#", "." etc. so a query like "foo/bar"
    or "../x" can't manipulate the request path (path-injection guard)."""
    return f"https://api.mapbox.com/geocoding/v5/mapbox.places/{quote(query, safe='')}.json"


async def search_mapbox(query: str, *, token: str | None = None) -> list[dict]:
    """Search Mapbox for places (fallback when OSM has no results)."""
    tok = token if token is not None else MAPBOX_TOKEN
    if not tok:
        return []
    url = mapbox_geocode_url(query)
    async with httpx.AsyncClient(timeout=8) as client:
        try:
            resp = await client.get(url, params={"limit": 10, "access_token": tok})
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
