"""GET /api/courses/{course_id}/intel — course-discovery intel (Augusta-styled
description + honest stars/stats), course-discovery-intel.

Two-segment /api/courses/{course_id}/intel sub-resource: MUST be registered
BEFORE the catch-all courses.router (GET /api/courses/{course_id}) in
main.py — the same house convention documented in course_reviews.py.

Pure-DB read (app.services.course_intel.get_course_intel_payload) — never
calls Claude inline, never calls Places/GolfAPI (budget invariant, plan §4/§7).
Never 404s for a well-formed courses.id: an empty/missing row simply yields
all-null/zero fields (plan §0 decision 5). A malformed, non-UUID id still
404s before ever reaching SQL — the same pre-filter as
routes/courses_mapped.py's `_looks_like_uuid` (an unparseable id can never
match the uuid-typed `courses.id` column; without this guard asyncpg raises
a DataError -> an unhandled 500 instead of a clean 404).

Auth: the app-level member gate (main.py) plus `Depends(current_user_id)`
for stars scoping — identical to course_reviews.py's `list_reviews`.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException

from app.models import CourseIntel
from app.services.clerk_auth import current_user_id
from app.services.course_intel import get_course_intel_payload

router = APIRouter(prefix="/api/courses", tags=["course-intel"])


def _looks_like_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
        return True
    except (ValueError, AttributeError, TypeError):
        return False


@router.get("/{course_id}/intel", response_model=CourseIntel)
async def get_course_intel(
    course_id: str,
    owner_id: str = Depends(current_user_id),
) -> CourseIntel:
    """One `CourseIntel` fetch feeds BOTH the map tap-sheet and the course
    detail page (one shape, two renderers). Works for ANY courses row,
    mapped or write-through-only — stats fields are simply `null` when the
    course has no holes/tee_sets rows yet."""
    if not _looks_like_uuid(course_id):
        raise HTTPException(404, "Not found")
    return await get_course_intel_payload(course_id, owner_id)
