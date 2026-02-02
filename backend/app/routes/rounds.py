"""Rounds API routes."""

from fastapi import APIRouter, HTTPException
from datetime import datetime
import uuid

from app.models import Round, RoundCreate, RoundUpdate, Score
from app.storage import rounds_storage, tournaments_storage

router = APIRouter(prefix="/api/rounds", tags=["rounds"])


@router.get("", response_model=list[Round])
async def get_rounds():
    """Get all rounds."""
    return rounds_storage.get_all()


@router.get("/{round_id}", response_model=Round)
async def get_round(round_id: str):
    """Get a round by ID."""
    round = rounds_storage.get_by_id(round_id)
    if not round:
        raise HTTPException(status_code=404, detail="Round not found")
    return round


@router.post("", response_model=Round)
async def create_round(data: RoundCreate):
    """Create a new round."""
    now = datetime.now().isoformat()
    round = Round(
        id=f"round-{uuid.uuid4().hex[:8]}",
        courseId=data.courseId,
        courseName=data.courseName,
        teeId=data.teeId,
        teeName=data.teeName,
        date=now,
        players=data.players,
        scores=[],
        holes=data.holes,
        games=data.games,
        groups=data.groups,
        status="active",
        tournamentId=data.tournamentId,
        createdAt=now,
        updatedAt=now,
    )
    created = rounds_storage.create(round)
    
    # Add to tournament if specified
    if data.tournamentId:
        tournament = tournaments_storage.get_by_id(data.tournamentId)
        if tournament:
            tournament.roundIds.append(created.id)
            tournament.updatedAt = now
            tournaments_storage.update(data.tournamentId, tournament)
    
    return created


@router.put("/{round_id}", response_model=Round)
async def update_round(round_id: str, data: RoundUpdate):
    """Update a round."""
    existing = rounds_storage.get_by_id(round_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Round not found")
    
    update_data = {k: v for k, v in data.model_dump().items() if v is not None}
    update_data["updatedAt"] = datetime.now().isoformat()
    
    updated = existing.model_copy(update=update_data)
    return rounds_storage.update(round_id, updated)


@router.post("/{round_id}/scores", response_model=Round)
async def update_score(round_id: str, score: Score):
    """Update a single score in a round."""
    existing = rounds_storage.get_by_id(round_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Round not found")
    
    # Find and update or add the score
    scores = list(existing.scores)
    found = False
    for i, s in enumerate(scores):
        if s.playerId == score.playerId and s.holeNumber == score.holeNumber:
            if score.strokes is None:
                scores.pop(i)  # Remove score
            else:
                scores[i] = score  # Update score
            found = True
            break
    
    if not found and score.strokes is not None:
        scores.append(score)
    
    existing.scores = scores
    existing.updatedAt = datetime.now().isoformat()
    
    return rounds_storage.update(round_id, existing)


@router.delete("/{round_id}")
async def delete_round(round_id: str):
    """Delete a round."""
    existing = rounds_storage.get_by_id(round_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Round not found")
    
    # Remove from tournament if linked
    if existing.tournamentId:
        tournament = tournaments_storage.get_by_id(existing.tournamentId)
        if tournament and round_id in tournament.roundIds:
            tournament.roundIds.remove(round_id)
            tournament.updatedAt = datetime.now().isoformat()
            tournaments_storage.update(existing.tournamentId, tournament)
    
    rounds_storage.delete(round_id)
    return {"status": "deleted"}


@router.post("/{round_id}/complete", response_model=Round)
async def complete_round(round_id: str):
    """Mark a round as completed."""
    existing = rounds_storage.get_by_id(round_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Round not found")
    
    existing.status = "completed"
    existing.updatedAt = datetime.now().isoformat()
    
    return rounds_storage.update(round_id, existing)
