"""Daily pin sheet — user-marked + admin-overridable.

Most golf apps assume every recommendation aims at green-center. That's a lot
of DECADE precision left on the table; the actual pin moves day to day. This
route lets the player drop a pin on each green at round start, and lets ops
upload a daily sheet for premium courses.

Storage: `hole_pins` (migration 004), keyed by (course_id, hole_number, pin_date).
"""

from datetime import date as date_cls
from typing import Optional
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select, text

from app.db.engine import async_session
from app.db.models import HolePin
from app.services.clerk_auth import current_user_id


router = APIRouter(prefix="/api/courses", tags=["pins"])


class PinIn(BaseModel):
    hole_number: int
    pin_lat: float
    pin_lng: float
    pin_date: Optional[date_cls] = None  # defaults to today server-side
    # Note: `source` is set server-side. We force 'manual' for user-marked pins.
    # An admin override path (source='admin') will live behind a separate
    # role-gated endpoint when admin roles are introduced.


class PinOut(BaseModel):
    id: str
    course_id: str
    hole_number: int
    pin_date: str
    pin_lat: float
    pin_lng: float
    source: str
    marked_by_user_id: Optional[str]


def _row_to_out(row: HolePin) -> PinOut:
    return PinOut(
        id=str(row.id),
        course_id=row.course_id,
        hole_number=row.hole_number,
        pin_date=row.pin_date.isoformat() if row.pin_date else "",
        pin_lat=float(row.pin_lat),
        pin_lng=float(row.pin_lng),
        source=row.source,
        marked_by_user_id=row.marked_by_user_id,
    )


@router.get("/{course_id}/pins", response_model=list[PinOut])
async def list_pins(course_id: str, date: Optional[date_cls] = None):
    """List pins for a course on a given date (defaults to today)."""
    target = date or date_cls.today()
    async with async_session() as db:
        result = await db.execute(
            select(HolePin)
            .where(HolePin.course_id == course_id, HolePin.pin_date == target)
            .order_by(HolePin.hole_number)
        )
        return [_row_to_out(r) for r in result.scalars().all()]


@router.post("/{course_id}/pins", response_model=PinOut)
async def upsert_pin(
    course_id: str,
    pin: PinIn,
    user_id: str = Depends(current_user_id),
):
    """Upsert a pin for (course_id, hole_number, pin_date).

    Authentication required. Source is forced to 'manual' (admin overrides
    will have their own role-gated endpoint). Re-marking the same hole on the
    same day overwrites — the player can correct themselves. The most recent
    caller becomes `marked_by_user_id`.
    """
    target_date = pin.pin_date or date_cls.today()

    # PostGIS upsert with geography column populated atomically.
    async with async_session() as db:
        await db.execute(
            text("""
                insert into public.hole_pins (
                    course_id, hole_number, pin_date, pin_lat, pin_lng, pin_geom,
                    source, marked_by_user_id
                )
                values (
                    :course_id, :hole_number, :pin_date, :pin_lat, :pin_lng,
                    ST_SetSRID(ST_MakePoint(:pin_lng, :pin_lat), 4326)::geography,
                    'manual', :user_id
                )
                on conflict (course_id, hole_number, pin_date) do update set
                    pin_lat = excluded.pin_lat,
                    pin_lng = excluded.pin_lng,
                    pin_geom = excluded.pin_geom,
                    source = excluded.source,
                    marked_by_user_id = excluded.marked_by_user_id,
                    updated_at = now()
            """),
            {
                "course_id": course_id,
                "hole_number": pin.hole_number,
                "pin_date": target_date,
                "pin_lat": pin.pin_lat,
                "pin_lng": pin.pin_lng,
                "user_id": user_id,
            },
        )
        await db.commit()

        result = await db.execute(
            select(HolePin).where(
                HolePin.course_id == course_id,
                HolePin.hole_number == pin.hole_number,
                HolePin.pin_date == target_date,
            )
        )
        row = result.scalar_one()
        return _row_to_out(row)
