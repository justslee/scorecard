"""Tournaments API routes."""

from fastapi import APIRouter, HTTPException
from datetime import datetime
import uuid

from app.models import Tournament, TournamentCreate, TournamentUpdate
from app.storage import tournaments_storage, rounds_storage

router = APIRouter(prefix="/api/tournaments", tags=["tournaments"])


@router.get("", response_model=list[Tournament])
async def get_tournaments():
    """Get all tournaments."""
    return tournaments_storage.get_all()


@router.get("/{tournament_id}", response_model=Tournament)
async def get_tournament(tournament_id: str):
    """Get a tournament by ID."""
    tournament = tournaments_storage.get_by_id(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")
    return tournament


@router.post("", response_model=Tournament)
async def create_tournament(data: TournamentCreate):
    """Create a new tournament."""
    now = datetime.now().isoformat()
    tournament = Tournament(
        id=f"tournament-{uuid.uuid4().hex[:8]}",
        name=data.name,
        numRounds=data.numRounds,
        roundIds=[],
        playerIds=data.playerIds,
        playerNamesById={},
        games=[],
        createdAt=now,
        updatedAt=now,
    )
    return tournaments_storage.create(tournament)


@router.put("/{tournament_id}", response_model=Tournament)
async def update_tournament(tournament_id: str, data: TournamentUpdate):
    """Update a tournament."""
    existing = tournaments_storage.get_by_id(tournament_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Tournament not found")
    
    update_data = {k: v for k, v in data.model_dump().items() if v is not None}
    update_data["updatedAt"] = datetime.now().isoformat()
    
    updated = existing.model_copy(update=update_data)
    return tournaments_storage.update(tournament_id, updated)


@router.delete("/{tournament_id}")
async def delete_tournament(tournament_id: str):
    """Delete a tournament."""
    existing = tournaments_storage.get_by_id(tournament_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Tournament not found")
    
    # Also delete associated rounds
    for round_id in existing.roundIds:
        rounds_storage.delete(round_id)
    
    tournaments_storage.delete(tournament_id)
    return {"status": "deleted"}


@router.post("/{tournament_id}/players/{player_id}")
async def add_player_to_tournament(tournament_id: str, player_id: str, player_name: str = ""):
    """Add a player to a tournament."""
    tournament = tournaments_storage.get_by_id(tournament_id)
    if not tournament:
        raise HTTPException(status_code=404, detail="Tournament not found")
    
    if player_id not in tournament.playerIds:
        tournament.playerIds.append(player_id)
    
    if player_name:
        if tournament.playerNamesById is None:
            tournament.playerNamesById = {}
        tournament.playerNamesById[player_id] = player_name
    
    tournament.updatedAt = datetime.now().isoformat()
    tournaments_storage.update(tournament_id, tournament)
    
    return {"status": "added"}
