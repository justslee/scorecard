"""GolfAPI.io proxy routes (migrated from Next.js /api/golf).

Normalizes the v2.3 API response fields (clubID -> id, clubName -> name, etc.)
so the frontend types work without modification.
"""

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
import httpx
import os

router = APIRouter(prefix="/api/golf", tags=["golf"])

GOLF_API_BASE = "https://www.golfapi.io/api/v2.3"


def _api_headers() -> dict:
    key = os.getenv("GOLF_API_KEY", "")
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return headers


def _normalize_course(c: dict) -> dict:
    """Normalize a course object from GolfAPI v2.3 field names."""
    return {
        "id": c.get("courseID") or c.get("id"),
        "name": c.get("courseName") or c.get("name"),
        "holes": c.get("numHoles") or c.get("holes", 18),
        "hasGPS": c.get("hasGPS", 0),
        # Pass through any other fields
        "par": c.get("par"),
        "slope": c.get("slope"),
        "rating": c.get("rating"),
        "tees": c.get("tees"),
        "holeData": c.get("holes_data") or c.get("holeData"),
    }


def _normalize_club(club: dict) -> dict:
    """Normalize a club object from GolfAPI v2.3 field names."""
    return {
        "id": club.get("clubID") or club.get("id"),
        "name": club.get("clubName") or club.get("name"),
        "address": club.get("address"),
        "city": club.get("city"),
        "state": club.get("state"),
        "country": club.get("country"),
        "latitude": _to_float(club.get("latitude") or club.get("lat")),
        "longitude": _to_float(club.get("longitude") or club.get("lng")),
        "courses": [_normalize_course(c) for c in (club.get("courses") or [])],
    }


def _normalize_hole(h: dict) -> dict:
    """Normalize a hole data object from GolfAPI v2.3."""
    result = {
        "hole": h.get("holeNumber") or h.get("hole"),
        "par": h.get("par"),
        "strokeIndex": h.get("strokeIndex") or h.get("handicap"),
        "yards": h.get("yards") or h.get("distance"),
    }
    # Coordinates
    coords = {}
    if h.get("greenLat") and h.get("greenLng"):
        coords["green"] = {"lat": float(h["greenLat"]), "lng": float(h["greenLng"])}
    if h.get("teeLat") and h.get("teeLng"):
        coords["tee"] = {"lat": float(h["teeLat"]), "lng": float(h["teeLng"])}
    if h.get("frontLat") and h.get("frontLng"):
        coords["front"] = {"lat": float(h["frontLat"]), "lng": float(h["frontLng"])}
    if h.get("backLat") and h.get("backLng"):
        coords["back"] = {"lat": float(h["backLat"]), "lng": float(h["backLng"])}
    if coords:
        result["coordinates"] = coords
    return result


def _to_float(val) -> float | None:
    if val is None or val == "":
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


@router.get("")
async def golf_proxy(
    action: str = Query(..., description="search, club, course, or coordinates"),
    q: str = Query(None),
    id: str = Query(None),
):
    """Proxy GolfAPI.io requests, keeping API key server-side."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            if action == "search":
                if not q:
                    raise HTTPException(400, "Missing q parameter")
                resp = await client.get(
                    f"{GOLF_API_BASE}/clubs",
                    params={"name": q},
                    headers=_api_headers(),
                )
            elif action == "club":
                if not id:
                    raise HTTPException(400, "Missing id parameter")
                resp = await client.get(
                    f"{GOLF_API_BASE}/clubs/{id}",
                    headers=_api_headers(),
                )
            elif action == "course":
                if not id:
                    raise HTTPException(400, "Missing id parameter")
                resp = await client.get(
                    f"{GOLF_API_BASE}/courses/{id}",
                    headers=_api_headers(),
                )
            elif action == "coordinates":
                if not id:
                    raise HTTPException(400, "Missing id parameter")
                resp = await client.get(
                    f"{GOLF_API_BASE}/coordinates/{id}",
                    headers=_api_headers(),
                )
            else:
                raise HTTPException(400, f"Unknown action: {action}")

        if not resp.is_success:
            raise HTTPException(resp.status_code, f"GolfAPI error: {resp.status_code}")

        data = resp.json()

        # Normalize response fields to match frontend types
        if action == "search":
            data = {
                "clubs": [_normalize_club(c) for c in (data.get("clubs") or [])],
                "apiRequestsLeft": data.get("apiRequestsLeft"),
            }
        elif action == "club":
            data = _normalize_club(data)
        elif action == "course":
            # Normalize course detail response
            if "holes_data" in data or "holeData" in data:
                holes = data.get("holes_data") or data.get("holeData") or []
                data["holeData"] = [_normalize_hole(h) for h in holes]
            data = _normalize_course(data)
        elif action == "coordinates":
            # Normalize coordinate data into holeData format
            holes_raw = data.get("holes") or data.get("coordinates") or []
            if isinstance(holes_raw, list):
                data["holeData"] = [_normalize_hole(h) for h in holes_raw]

        cache_time = 3600 if action == "search" else 86400
        return JSONResponse(
            content=data,
            headers={"Cache-Control": f"public, max-age={cache_time}"},
        )
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Golf API request failed: {e}")
