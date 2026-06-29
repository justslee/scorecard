"""Course-reviews API routes (B2) — owner-scoped.

Sub-resource of /api/courses: two-segment paths /api/courses/{course_key}/reviews.
Registered BEFORE the catch-all courses.router in main.py (house convention, §0.1
of the plan).

Auth: the app-level _owner_only dependency (main.py) gates the router; the route
body only needs current_user_id for row-level filtering — identical to players.py.
Do NOT touch require_owner here.
"""

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import select

from app.db.engine import async_session
from app.db.models import CourseReview as CourseReviewORM
from app.models import CourseReview, CourseReviewCreate
from app.services.clerk_auth import current_user_id

router = APIRouter(prefix="/api/courses", tags=["course-reviews"])


def _orm_to_pydantic(row: CourseReviewORM) -> CourseReview:
    """Map a CourseReview ORM row to the camelCase CourseReview response model."""
    return CourseReview(
        id=str(row.id),
        ownerId=str(row.owner_id),
        courseKey=str(row.course_key),
        courseName=row.course_name,
        roundId=row.round_id,
        rating=int(row.rating),
        body=row.body,
        playedAt=row.played_at.isoformat() if row.played_at else None,
        createdAt=row.created_at.isoformat() if row.created_at else "",
    )


@router.post("/{course_key}/reviews", response_model=CourseReview)
async def create_review(
    course_key: str,
    data: CourseReviewCreate,
    owner_id: str = Depends(current_user_id),
) -> CourseReview:
    """Create a course review owned by the calling user.

    course_key comes from the path (GolfAPI id string, or name:<slug>).
    rating is validated 1-5 by the Pydantic model; body is capped at 2000 chars.
    """
    row = CourseReviewORM(
        id=str(uuid.uuid4()),
        owner_id=owner_id,
        course_key=course_key,
        course_name=data.courseName,
        round_id=data.roundId,
        rating=data.rating,
        body=data.body,
        played_at=data.playedAt,  # Optional[date] — already coerced by Pydantic
    )
    async with async_session() as db:
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return _orm_to_pydantic(row)


@router.get("/{course_key}/reviews", response_model=list[CourseReview])
async def list_reviews(
    course_key: str,
    owner_id: str = Depends(current_user_id),
) -> list[CourseReview]:
    """List reviews for a course_key scoped to the calling owner.

    B2: returns only the caller's own reviews (cross-user surfacing is B3).
    Ordered created_at desc.
    """
    async with async_session() as db:
        result = await db.execute(
            select(CourseReviewORM)
            .where(
                CourseReviewORM.course_key == course_key,
                CourseReviewORM.owner_id == owner_id,
            )
            .order_by(CourseReviewORM.created_at.desc())
        )
        return [_orm_to_pydantic(r) for r in result.scalars().all()]
