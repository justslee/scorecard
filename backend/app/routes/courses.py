"""Scoring-courses API routes — Postgres-backed (migration 006_scoring_courses).

Replaces the JSON-file courses_storage. The camelCase Pydantic contract
(Course / CourseCreate / HoleInfo / TeeOption) is preserved unchanged so
the frontend api.ts / round-setup picker needs no adjustment.

Owner scoping: every query filters by owner_id == current_user_id.
The require_owner gate is applied at the app level (main.py); here we only
need current_user_id to pull the caller's identity for row-level filtering.

This router handles ONLY scoring-courses (the round-setup picker).  The
PostGIS-backed mapped-courses (caddie/import) live in courses_mapped.py and
are intentionally left untouched.

Follow-up (future): unify scoring_courses with the mapped courses table
— tracked in specs/real-data-wiring-plan.md "Review follow-ups".
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select

from app.db.engine import async_session
from app.db.models import ScoringCourse as ScoringCourseORM
from app.models import Course, CourseCreate, HoleInfo, TeeOption
from app.services.clerk_auth import current_user_id

router = APIRouter(prefix="/api/courses", tags=["courses"])


def _orm_to_pydantic(row: ScoringCourseORM) -> Course:
    """Map a ScoringCourse ORM row to the camelCase Course response model."""
    holes = [HoleInfo(**h) for h in (row.holes or [])]
    tees = None
    if row.tees is not None:
        tees = [TeeOption(**t) for t in row.tees]
    return Course(
        id=str(row.id),
        name=row.name,
        holes=holes,
        tees=tees,
        location=row.location,
    )


@router.get("", response_model=list[Course])
async def get_courses(owner_id: str = Depends(current_user_id)):
    """List all scoring courses belonging to the calling owner."""
    async with async_session() as db:
        result = await db.execute(
            select(ScoringCourseORM)
            .where(ScoringCourseORM.owner_id == owner_id)
            .order_by(ScoringCourseORM.created_at.desc())
        )
        return [_orm_to_pydantic(r) for r in result.scalars().all()]


@router.get("/{course_id}", response_model=Course)
async def get_course(course_id: str, owner_id: str = Depends(current_user_id)):
    """Get a single scoring course by id. Returns 404 if not owned by the caller."""
    async with async_session() as db:
        result = await db.execute(
            select(ScoringCourseORM).where(
                ScoringCourseORM.id == course_id,
                ScoringCourseORM.owner_id == owner_id,
            )
        )
        row = result.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Course not found")
    return _orm_to_pydantic(row)


@router.post("", response_model=Course)
async def create_course(data: CourseCreate, owner_id: str = Depends(current_user_id)):
    """Create a new scoring course owned by the calling user."""
    row = ScoringCourseORM(
        id=str(uuid.uuid4()),
        owner_id=owner_id,
        name=data.name,
        location=data.location,
        holes=[h.model_dump() for h in data.holes],
        tees=[t.model_dump() for t in data.tees] if data.tees is not None else None,
    )
    async with async_session() as db:
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return _orm_to_pydantic(row)


@router.post("/default", response_model=Course)
async def create_default_course(
    name: str,
    location: str = None,
    owner_id: str = Depends(current_user_id),
):
    """Create a scoring course with a standard 18-hole par layout."""
    default_pars = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 4, 3, 5, 4, 4, 3, 4, 5]
    holes = [HoleInfo(number=i + 1, par=default_pars[i]) for i in range(18)]
    row = ScoringCourseORM(
        id=str(uuid.uuid4()),
        owner_id=owner_id,
        name=name,
        location=location,
        holes=[h.model_dump() for h in holes],
        tees=None,
    )
    async with async_session() as db:
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return _orm_to_pydantic(row)


@router.delete("/{course_id}")
async def delete_course(course_id: str, owner_id: str = Depends(current_user_id)):
    """Delete a scoring course. Returns 404 if not owned by the caller."""
    async with async_session() as db:
        result = await db.execute(
            select(ScoringCourseORM).where(
                ScoringCourseORM.id == course_id,
                ScoringCourseORM.owner_id == owner_id,
            )
        )
        row = result.scalar_one_or_none()
        if not row:
            raise HTTPException(status_code=404, detail="Course not found")
        await db.delete(row)
        await db.commit()
    return {"status": "deleted"}
