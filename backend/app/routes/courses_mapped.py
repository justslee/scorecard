"""Mapped-course CRUD over RDS (migrated from Next.js /api/courses + /api/courses/[id]).

These are the hand-mapped courses authored in the course editor (PostGIS geometry
per hole), distinct from the scoring courses served by routes/courses.py. Mounted
at /api/courses/mapped so it does not collide with /api/courses/{course_id}.

Response shapes mirror the old Next routes so the UI is unchanged:
  list  -> {"courses": CourseListItem[]}
  one   -> {"course": CourseData}
  write -> {"course": CourseData}
  del   -> {"ok": true}

Also provides:
  GET /{course_id}/golf-coords -> {"holeData": [...]}  (stored GolfAPI coords, 0 API calls)
"""

from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.services import courses_mapped as store
from app.services.golfapi_cache import FileCacheStore

router = APIRouter(prefix="/api/courses/mapped", tags=["courses-mapped"])


class TeeSetIn(BaseModel):
    name: str
    color: Optional[str] = None


class HoleIn(BaseModel):
    number: int
    par: int = 4
    handicap: Optional[int] = None
    yardages: dict[str, int] = Field(default_factory=dict)
    features: dict[str, Any] = Field(default_factory=lambda: {"type": "FeatureCollection", "features": []})


class CourseIn(BaseModel):
    id: str
    name: str
    address: Optional[str] = None
    location: Optional[dict[str, float]] = None  # {lat, lng}
    teeSets: list[TeeSetIn] = Field(default_factory=list)
    holes: list[HoleIn] = Field(default_factory=list)


# NOTE: declare static sub-paths (/nearby, /{id}/golf-coords) BEFORE the dynamic
# /{course_id} route so they are not captured by the path parameter.
@router.get("")
async def list_mapped(search: Optional[str] = Query(None)):
    return {"courses": await store.list_courses(search)}


@router.get("/nearby")
async def nearby_mapped(
    lat: float = Query(...),
    lng: float = Query(...),
    radiusMeters: Optional[int] = Query(50000),
):
    return {"courses": await store.nearby_courses(lat, lng, radiusMeters or 50000)}


@router.post("")
async def create_mapped(body: CourseIn):
    if not body.id or not body.name:
        raise HTTPException(400, "Missing id or name")
    return {"course": await store.upsert_course(body.model_dump())}


@router.get("/{course_id}/golf-coords")
async def get_golf_coords(course_id: str):
    """Return stored GolfAPI coordinates for a course — ZERO GolfAPI API calls.

    Reads from ``backend/data/golfapi_cache.json`` (our own storage).  Returns
    ``{"holeData": [...]}`` with the same shape as the ``/api/golf`` coordinates
    proxy so the frontend can swap between them transparently.

    Returns an empty ``holeData`` list when the course has not yet been cached
    (owner has not supplied a GolfAPI token + course ID mapping).
    """
    cache = FileCacheStore()
    coords = cache.get_cached(course_id) or []
    return {"holeData": coords}


@router.get("/{course_id}")
async def get_mapped(course_id: str):
    course = await store.get_course(course_id)
    if not course:
        raise HTTPException(404, "Not found")
    return {"course": course}


@router.put("/{course_id}")
async def put_mapped(course_id: str, body: CourseIn):
    data = body.model_dump()
    data["id"] = course_id  # path id wins, mirroring the old route
    return {"course": await store.upsert_course(data)}


@router.delete("/{course_id}")
async def delete_mapped(course_id: str):
    await store.delete_course(course_id)
    return {"ok": True}
