"""Courses API routes."""

from fastapi import APIRouter, HTTPException
from datetime import datetime
import uuid

from app.models import Course, CourseCreate, HoleInfo
from app.storage import courses_storage

router = APIRouter(prefix="/api/courses", tags=["courses"])


@router.get("", response_model=list[Course])
async def get_courses():
    """Get all courses."""
    return courses_storage.get_all()


@router.get("/{course_id}", response_model=Course)
async def get_course(course_id: str):
    """Get a course by ID."""
    course = courses_storage.get_by_id(course_id)
    if not course:
        raise HTTPException(status_code=404, detail="Course not found")
    return course


@router.post("", response_model=Course)
async def create_course(data: CourseCreate):
    """Create a new course."""
    course = Course(
        id=f"course-{uuid.uuid4().hex[:8]}",
        name=data.name,
        holes=data.holes,
        tees=data.tees,
        location=data.location,
    )
    return courses_storage.create(course)


@router.post("/default", response_model=Course)
async def create_default_course(name: str, location: str = None):
    """Create a course with default 18-hole layout."""
    default_pars = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 4, 3, 5, 4, 4, 3, 4, 5]
    holes = [HoleInfo(number=i+1, par=default_pars[i]) for i in range(18)]
    
    course = Course(
        id=f"course-{uuid.uuid4().hex[:8]}",
        name=name,
        holes=holes,
        location=location,
    )
    return courses_storage.create(course)


@router.delete("/{course_id}")
async def delete_course(course_id: str):
    """Delete a course."""
    if not courses_storage.delete(course_id):
        raise HTTPException(status_code=404, detail="Course not found")
    return {"status": "deleted"}
