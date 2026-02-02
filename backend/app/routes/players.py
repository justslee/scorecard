"""Players API routes."""

from fastapi import APIRouter, HTTPException
from datetime import datetime
import uuid

from app.models import SavedPlayer, PlayerCreate, PlayerUpdate
from app.storage import players_storage

router = APIRouter(prefix="/api/players", tags=["players"])


@router.get("", response_model=list[SavedPlayer])
async def get_players():
    """Get all players."""
    return players_storage.get_all()


@router.get("/{player_id}", response_model=SavedPlayer)
async def get_player(player_id: str):
    """Get a player by ID."""
    player = players_storage.get_by_id(player_id)
    if not player:
        raise HTTPException(status_code=404, detail="Player not found")
    return player


@router.post("", response_model=SavedPlayer)
async def create_player(data: PlayerCreate):
    """Create a new player."""
    now = datetime.now().isoformat()
    player = SavedPlayer(
        id=f"player-{uuid.uuid4().hex[:8]}",
        name=data.name,
        nickname=data.nickname,
        email=data.email,
        phone=data.phone,
        handicap=data.handicap,
        roundsPlayed=0,
        createdAt=now,
        updatedAt=now,
    )
    return players_storage.create(player)


@router.put("/{player_id}", response_model=SavedPlayer)
async def update_player(player_id: str, data: PlayerUpdate):
    """Update a player."""
    existing = players_storage.get_by_id(player_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Player not found")
    
    updated = existing.model_copy(update={
        **{k: v for k, v in data.model_dump().items() if v is not None},
        "updatedAt": datetime.now().isoformat(),
    })
    return players_storage.update(player_id, updated)


@router.delete("/{player_id}")
async def delete_player(player_id: str):
    """Delete a player."""
    if not players_storage.delete(player_id):
        raise HTTPException(status_code=404, detail="Player not found")
    return {"status": "deleted"}
