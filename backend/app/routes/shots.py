"""Shot tracking — start/end coordinates, club, result, auto-detected lie.

Powers personal strokes-gained (PR #7) and the dispersion-cone overlay (Phase 3).
This is the relational replacement for the JSON `shot_history` we keep in
`caddie_sessions` for the in-round caddie context — both surfaces coexist for
now (session is volatile + cheap, shots table is durable + queryable).
"""

import math
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, delete, func as sqlfunc, text

from app.db.engine import async_session
from app.db.models import Shot
from app.caddie.session import get_owned_session
from app.services.clerk_auth import current_user_id
from app.services.lie_detection import classify_lie


router = APIRouter(prefix="/api/shots", tags=["shots"])


# ── Request/response models ──


class ShotIn(BaseModel):
    round_id: str
    hole_number: int
    hole_id: Optional[str] = None
    start_lat: Optional[float] = None
    start_lng: Optional[float] = None
    start_lie: Optional[str] = None
    end_lat: Optional[float] = None
    end_lng: Optional[float] = None
    end_lie: Optional[str] = None
    club: Optional[str] = None
    result: Optional[str] = None
    intended_target_lat: Optional[float] = None
    intended_target_lng: Optional[float] = None
    wind_speed_mph: Optional[float] = None
    wind_direction: Optional[int] = None
    notes: Optional[str] = None


class ShotOut(BaseModel):
    id: int
    round_id: str
    user_id: Optional[str]
    hole_id: Optional[str]
    hole_number: int
    shot_number: int
    start_lat: Optional[float]
    start_lng: Optional[float]
    start_lie: Optional[str]
    end_lat: Optional[float]
    end_lng: Optional[float]
    end_lie: Optional[str]
    distance_yards: Optional[float]
    club: Optional[str]
    result: Optional[str]
    created_at: str


# ── Helpers ──


_METERS_PER_DEG_LAT = 111_320.0


def _haversine_yards(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Approximate great-circle distance in yards. Good enough for in-round shot lengths."""
    rlat1 = math.radians(lat1)
    rlat2 = math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    meters = 2 * 6_371_000 * math.asin(min(1.0, math.sqrt(a)))
    return meters * 1.09361


def _row_to_out(row: Shot) -> ShotOut:
    return ShotOut(
        id=row.id,
        round_id=row.round_id,
        user_id=row.user_id,
        hole_id=row.hole_id,
        hole_number=row.hole_number,
        shot_number=row.shot_number,
        start_lat=float(row.start_lat) if row.start_lat is not None else None,
        start_lng=float(row.start_lng) if row.start_lng is not None else None,
        start_lie=row.start_lie,
        end_lat=float(row.end_lat) if row.end_lat is not None else None,
        end_lng=float(row.end_lng) if row.end_lng is not None else None,
        end_lie=row.end_lie,
        distance_yards=float(row.distance_yards) if row.distance_yards is not None else None,
        club=row.club,
        result=row.result,
        created_at=row.created_at.isoformat() if row.created_at else "",
    )


# ── Endpoints ──


@router.post("", response_model=ShotOut)
async def record_shot(
    shot: ShotIn,
    user_id: str = Depends(current_user_id),
):
    """Record a shot. Auto-detects lie via PostGIS when not provided.

    Requires authentication, and the round_id must belong to the calling user
    (enforced via the caddie_sessions ownership check). The shot_number is
    assigned server-side as the next index for (round_id, hole_number).
    """
    # Reject attempts to write shots into another user's round.
    await get_owned_session(shot.round_id, user_id)
    # Auto-detect lie when polygons exist for the hole
    start_lie = shot.start_lie
    if (
        start_lie is None
        and shot.hole_id
        and shot.start_lat is not None
        and shot.start_lng is not None
    ):
        try:
            start_lie = await classify_lie(shot.hole_id, shot.start_lat, shot.start_lng)
        except Exception:
            start_lie = None

    end_lie = shot.end_lie
    if (
        end_lie is None
        and shot.hole_id
        and shot.end_lat is not None
        and shot.end_lng is not None
    ):
        try:
            end_lie = await classify_lie(shot.hole_id, shot.end_lat, shot.end_lng)
        except Exception:
            end_lie = None

    distance_yards: Optional[float] = None
    if (
        shot.start_lat is not None and shot.start_lng is not None
        and shot.end_lat is not None and shot.end_lng is not None
    ):
        distance_yards = round(_haversine_yards(
            shot.start_lat, shot.start_lng, shot.end_lat, shot.end_lng,
        ), 1)

    async with async_session() as db:
        # Next shot_number on this hole within this round
        next_n = await db.execute(
            select(sqlfunc.coalesce(sqlfunc.max(Shot.shot_number), 0) + 1)
            .where(Shot.round_id == shot.round_id, Shot.hole_number == shot.hole_number)
        )
        shot_number = int(next_n.scalar_one())

        row = Shot(
            round_id=shot.round_id,
            user_id=user_id,
            hole_id=shot.hole_id,
            hole_number=shot.hole_number,
            shot_number=shot_number,
            start_lat=shot.start_lat,
            start_lng=shot.start_lng,
            start_lie=start_lie,
            end_lat=shot.end_lat,
            end_lng=shot.end_lng,
            end_lie=end_lie,
            distance_yards=distance_yards,
            club=shot.club,
            result=shot.result,
            intended_target_lat=shot.intended_target_lat,
            intended_target_lng=shot.intended_target_lng,
            wind_speed_mph=shot.wind_speed_mph,
            wind_direction=shot.wind_direction,
            notes=shot.notes,
        )
        db.add(row)

        # Populate the geography columns for spatial queries
        if shot.start_lat is not None and shot.start_lng is not None:
            await db.flush()  # need row.id
            await db.execute(
                text("""
                    update public.shots
                    set start_geom = ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography
                    where id = :id
                """),
                {"id": row.id, "lat": shot.start_lat, "lng": shot.start_lng},
            )
        if shot.end_lat is not None and shot.end_lng is not None:
            await db.flush()
            await db.execute(
                text("""
                    update public.shots
                    set end_geom = ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography
                    where id = :id
                """),
                {"id": row.id, "lat": shot.end_lat, "lng": shot.end_lng},
            )
        await db.commit()
        await db.refresh(row)
        return _row_to_out(row)


@router.get("/round/{round_id}", response_model=list[ShotOut])
async def list_shots_for_round(
    round_id: str,
    user_id: str = Depends(current_user_id),
):
    """Return shots for a round. Caller must own the round."""
    await get_owned_session(round_id, user_id)
    async with async_session() as db:
        result = await db.execute(
            select(Shot)
            .where(Shot.round_id == round_id, Shot.user_id == user_id)
            .order_by(Shot.hole_number, Shot.shot_number)
        )
        return [_row_to_out(r) for r in result.scalars().all()]


@router.delete("/{shot_id}")
async def delete_shot(
    shot_id: int,
    user_id: str = Depends(current_user_id),
):
    """Delete a shot owned by the calling user. Returns 404 if not found or not owned."""
    async with async_session() as db:
        result = await db.execute(
            delete(Shot).where(Shot.id == shot_id, Shot.user_id == user_id)
        )
        await db.commit()
        if result.rowcount == 0:
            raise HTTPException(404, "Shot not found")
    return {"status": "deleted", "id": shot_id}
