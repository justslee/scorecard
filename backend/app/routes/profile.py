"""Profile API routes — Postgres-backed (migration 002_core_scoring + 007_golfer_profile_fields).

One profile per Clerk user. The table is keyed on user_id (UNIQUE) so the
caller's identity is the natural look-up key — no {id} path parameter needed.

Endpoints
─────────
  GET  /api/profile/golfer        → GolferProfile | null (200 with body or 204)
  POST /api/profile/golfer        → GolferProfile  (create; 409 if already exists)
  PUT  /api/profile/golfer        → GolferProfile  (upsert: create or replace)

Owner scoping: user_id == current_user_id (require_owner gate at main.py level).

ORM↔camelCase mapping
─────────────────────
  ORM name           → Pydantic field
  ──────────────────────────────────
  id                 → id
  name               → name
  handicap_index     → handicap
  home_course        → homeCourse
  bag_clubs          → clubDistances
"""

from datetime import datetime, timezone
import uuid

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select

from app.db.engine import async_session
from app.db.models import GolferProfile as GolferProfileORM
from app.models import GolferProfile, GolferProfileCreate, GolferProfileUpdate
from app.services.clerk_auth import current_user_id

router = APIRouter(prefix="/api/profile", tags=["profile"])


def _orm_to_pydantic(row: GolferProfileORM) -> GolferProfile:
    """Map a GolferProfile ORM row to the camelCase response model."""
    return GolferProfile(
        id=str(row.id),
        name=row.name,
        handicap=float(row.handicap_index) if row.handicap_index is not None else None,
        homeCourse=row.home_course,
        clubDistances=row.bag_clubs if row.bag_clubs else {},
    )


@router.get("/golfer")
async def get_golfer_profile(
    response: Response,
    user_id: str = Depends(current_user_id),
):
    """Return the calling user's golfer profile, or 204 No Content if none exists.

    Returns 204 (not 404) so the frontend can cleanly distinguish
    'no profile yet' from 'request error' — the hook treats null as
    'show the create-profile flow'.
    """
    async with async_session() as db:
        result = await db.execute(
            select(GolferProfileORM).where(GolferProfileORM.user_id == user_id)
        )
        row = result.scalar_one_or_none()

    if not row:
        response.status_code = 204
        return None

    return _orm_to_pydantic(row)


@router.post("/golfer", response_model=GolferProfile, status_code=201)
async def create_golfer_profile(
    data: GolferProfileCreate,
    user_id: str = Depends(current_user_id),
):
    """Create a new golfer profile for the calling user.

    Returns 409 if a profile already exists — use PUT /api/profile/golfer for
    upsert semantics.
    """
    async with async_session() as db:
        # Check for existing row
        result = await db.execute(
            select(GolferProfileORM).where(GolferProfileORM.user_id == user_id)
        )
        existing = result.scalar_one_or_none()
        if existing:
            raise HTTPException(status_code=409, detail="Profile already exists; use PUT to update.")

        row = GolferProfileORM(
            id=str(uuid.uuid4()),
            user_id=user_id,
            owner_id=user_id,
            name=data.name,
            handicap_index=data.handicap,
            home_course=data.homeCourse,
            bag_clubs=data.clubDistances,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)

    return _orm_to_pydantic(row)


@router.put("/golfer", response_model=GolferProfile)
async def upsert_golfer_profile(
    data: GolferProfileUpdate,
    user_id: str = Depends(current_user_id),
):
    """Upsert the calling user's golfer profile.

    Creates the row if it doesn't exist; updates only the supplied fields if it
    does (partial update — None fields are ignored, matching the other domain
    routes).
    """
    async with async_session() as db:
        result = await db.execute(
            select(GolferProfileORM).where(GolferProfileORM.user_id == user_id)
        )
        row = result.scalar_one_or_none()

        if not row:
            # Create on first upsert
            row = GolferProfileORM(
                id=str(uuid.uuid4()),
                user_id=user_id,
                owner_id=user_id,
                name=data.name,
                handicap_index=data.handicap,
                home_course=data.homeCourse,
                bag_clubs=data.clubDistances if data.clubDistances is not None else {},
            )
            db.add(row)
        else:
            # Partial update — only touch fields the caller supplied.
            if data.name is not None:
                row.name = data.name
            if data.handicap is not None:
                row.handicap_index = data.handicap
            if data.homeCourse is not None:
                row.home_course = data.homeCourse
            if data.clubDistances is not None:
                row.bag_clubs = data.clubDistances
            row.updated_at = datetime.now(timezone.utc)

        await db.commit()
        await db.refresh(row)

    return _orm_to_pydantic(row)
