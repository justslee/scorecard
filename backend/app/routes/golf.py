"""GolfAPI.io proxy routes (migrated from Next.js /api/golf).

Normalizes the v2.3 API response fields so the frontend types work
without modification.

Field mapping (v2.3 → frontend):
  Club:   clubID→id, clubName→name
  Course: courseID→id, courseName→name, parsMen[]→holeData[].par,
          indexesMen[]→holeData[].strokeIndex
  Tees:   teeID→id, teeName→name, teeColor→color,
          length1..length18→holeData[].yards
  Coords: poi/location/sideFW→green/tee/front/back per hole
"""

from collections import defaultdict

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


def _to_float(val) -> float | None:
    if val is None or val == "":
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def _to_int(val) -> int | None:
    if val is None or val == "":
        return None
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Normalization helpers
# ---------------------------------------------------------------------------

def _normalize_tee(t: dict, num_holes: int = 18) -> dict:
    """Normalize a tee object: extract length1..length18 into holeData."""
    holes = []
    for i in range(1, num_holes + 1):
        yards = _to_int(t.get(f"length{i}"))
        if yards is not None:
            holes.append({"hole": i, "yards": yards})

    return {
        "id": t.get("teeID") or t.get("id"),
        "name": t.get("teeName") or t.get("name"),
        "color": t.get("teeColor") or t.get("color"),
        "slope": _to_float(t.get("slopeMen")) or _to_float(t.get("slopeWomen")),
        "rating": _to_float(t.get("courseRatingMen")) or _to_float(t.get("courseRatingWomen")),
        "totalYards": sum(h["yards"] for h in holes) if holes else None,
        "holeData": holes,
    }


def _normalize_course(c: dict) -> dict:
    """Normalize a course object from GolfAPI v2.3 field names.

    Builds holeData from parsMen[]/indexesMen[] arrays and normalizes tees
    with per-hole yardages extracted from length1..length18 fields.
    """
    num_holes = c.get("numHoles") or c.get("holes", 18)
    # numHoles could come back as a list in some responses
    if isinstance(num_holes, list):
        num_holes = len(num_holes) or 18
    if not isinstance(num_holes, int):
        try:
            num_holes = int(num_holes)
        except (ValueError, TypeError):
            num_holes = 18

    # Build holeData from parsMen/indexesMen arrays
    pars = c.get("parsMen") or c.get("parsWomen") or []
    indexes = c.get("indexesMen") or c.get("indexesWomen") or []
    hole_data = []
    if pars:
        for i in range(len(pars)):
            hole_data.append({
                "hole": i + 1,
                "par": pars[i] if i < len(pars) else 4,
                "strokeIndex": indexes[i] if i < len(indexes) else i + 1,
            })

    # Normalize tees
    raw_tees = c.get("tees") or []
    tees = [_normalize_tee(t, num_holes) for t in raw_tees]

    return {
        "id": c.get("courseID") or c.get("id"),
        "name": c.get("courseName") or c.get("name"),
        "holes": num_holes,
        "hasGPS": c.get("hasGPS", 0),
        "par": sum(pars) if pars else c.get("par"),
        "tees": tees,
        "holeData": hole_data if hole_data else (c.get("holes_data") or c.get("holeData")),
    }


def _normalize_course_summary(c: dict) -> dict:
    """Lightweight normalization for courses in club search results.

    These don't have parsMen/tees — just courseID/courseName/numHoles.
    """
    return {
        "id": c.get("courseID") or c.get("id"),
        "name": c.get("courseName") or c.get("name"),
        "holes": c.get("numHoles") or c.get("holes", 18),
        "hasGPS": c.get("hasGPS", 0),
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
        "courses": [
            _normalize_course_summary(c) for c in (club.get("courses") or [])
        ],
    }


def _normalize_coordinates(raw: list) -> list:
    """Decode GolfAPI poi/location/sideFW coordinate system.

    poi meanings:
      "1"  = green  (location: "1"=back, "2"=center, "3"=front)
      "11" = front of tee box
      "12" = back of tee box
      "2"/"3"/etc = fairway/dogleg/hazard points (ignored for now)

    Returns list of {hole, green, tee, front, back} objects.
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
                # Fallback: any green poi without location becomes green center
                holes[hole_num]["green"] = coord
        elif poi in ("11", "12"):  # Tee box
            if location == "2" or "tee" not in holes[hole_num]:
                holes[hole_num]["tee"] = coord

    return [
        {
            "hole": h,
            "green": data.get("green"),
            "tee": data.get("tee"),
            "front": data.get("front"),
            "back": data.get("back"),
        }
        for h, data in sorted(holes.items())
        if data.get("green")
    ]


# ---------------------------------------------------------------------------
# Route handler
# ---------------------------------------------------------------------------

@router.get("")
async def golf_proxy(
    action: str = Query(..., description="search, club, course, or coordinates"),
    q: str = Query(None),
    id: str = Query(None),
):
    """Proxy GolfAPI.io requests, keeping API key server-side."""
    try:
        transport = httpx.AsyncHTTPTransport(local_address="0.0.0.0")
        async with httpx.AsyncClient(timeout=15, transport=transport) as client:
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
            # Full normalization: builds holeData from parsMen[], normalizes tees
            data = _normalize_course(data)
        elif action == "coordinates":
            # Decode poi/location/sideFW into per-hole {green, tee, front, back}
            raw = data.get("coordinates") or data.get("holes") or []
            if isinstance(raw, list):
                data = {"holeData": _normalize_coordinates(raw)}

        cache_time = 3600 if action == "search" else 86400
        return JSONResponse(
            content=data,
            headers={"Cache-Control": f"public, max-age={cache_time}"},
        )
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Golf API request failed: {e}")
