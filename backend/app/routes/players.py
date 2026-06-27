"""Players API routes — Postgres-backed (migration 002_core_scoring).

Replaces the JSON-file players_storage. The camelCase Pydantic contract
(SavedPlayer / PlayerCreate / PlayerUpdate) is preserved unchanged so
the frontend api.ts layer needs no adjustment.

Owner scoping: every query filters by owner_id == current_user_id.
The require_owner gate is applied at the app level (main.py); here we
only need current_user_id to pull the caller's identity for row-level
filtering.
"""

from datetime import datetime, timezone
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select

from app.db.engine import async_session
from app.db.models import Player as PlayerORM
from app.models import SavedPlayer, PlayerCreate, PlayerUpdate
from app.services.clerk_auth import current_user_id

router = APIRouter(prefix="/api/players", tags=["players"])


def _orm_to_pydantic(row: PlayerORM) -> SavedPlayer:
    """Map a Player ORM row to the camelCase SavedPlayer response model."""
    return SavedPlayer(
        id=str(row.id),
        name=row.name,
        nickname=row.nickname,
        email=row.email,
        phone=row.phone,
        handicap=float(row.handicap) if row.handicap is not None else None,
        avatarUrl=row.avatar_url,
        clerkUserId=row.clerk_user_id,
        roundsPlayed=row.rounds_played,
        createdAt=row.created_at.isoformat() if row.created_at else "",
        updatedAt=row.updated_at.isoformat() if row.updated_at else "",
    )


@router.get("", response_model=list[SavedPlayer])
async def get_players(owner_id: str = Depends(current_user_id)):
    """List all players belonging to the calling owner."""
    async with async_session() as db:
        result = await db.execute(
            select(PlayerORM)
            .where(PlayerORM.owner_id == owner_id)
            .order_by(PlayerORM.created_at.desc())
        )
        return [_orm_to_pydantic(r) for r in result.scalars().all()]


@router.get("/{player_id}", response_model=SavedPlayer)
async def get_player(player_id: str, owner_id: str = Depends(current_user_id)):
    """Get a single player by id. Returns 404 if not owned by the caller."""
    async with async_session() as db:
        result = await db.execute(
            select(PlayerORM).where(
                PlayerORM.id == player_id,
                PlayerORM.owner_id == owner_id,
            )
        )
        row = result.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Player not found")
    return _orm_to_pydantic(row)


@router.post("", response_model=SavedPlayer)
async def create_player(data: PlayerCreate, owner_id: str = Depends(current_user_id)):
    """Create a new player owned by the calling user."""
    row = PlayerORM(
        id=str(uuid.uuid4()),
        owner_id=owner_id,
        name=data.name,
        nickname=data.nickname,
        email=data.email,
        phone=data.phone,
        handicap=data.handicap,
    )
    async with async_session() as db:
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return _orm_to_pydantic(row)


@router.put("/{player_id}", response_model=SavedPlayer)
async def update_player(
    player_id: str,
    data: PlayerUpdate,
    owner_id: str = Depends(current_user_id),
):
    """Update a player. Returns 404 if not owned by the caller."""
    async with async_session() as db:
        result = await db.execute(
            select(PlayerORM).where(
                PlayerORM.id == player_id,
                PlayerORM.owner_id == owner_id,
            )
        )
        row = result.scalar_one_or_none()
        if not row:
            raise HTTPException(status_code=404, detail="Player not found")

        # Only update fields that were explicitly provided (exclude_none).
        # PlayerUpdate field names match the ORM column names directly.
        for field, value in data.model_dump(exclude_none=True).items():
            setattr(row, field, value)
        row.updated_at = datetime.now(timezone.utc)

        await db.commit()
        await db.refresh(row)
    return _orm_to_pydantic(row)


@router.delete("/{player_id}")
async def delete_player(player_id: str, owner_id: str = Depends(current_user_id)):
    """Delete a player. Returns 404 if not owned by the caller."""
    async with async_session() as db:
        result = await db.execute(
            select(PlayerORM).where(
                PlayerORM.id == player_id,
                PlayerORM.owner_id == owner_id,
            )
        )
        row = result.scalar_one_or_none()
        if not row:
            raise HTTPException(status_code=404, detail="Player not found")
        await db.delete(row)
        await db.commit()
    return {"status": "deleted"}
