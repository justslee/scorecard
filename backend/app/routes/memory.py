"""Caddie memory endpoints — what the caddie remembers about a player across rounds."""

from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.caddie import memory as memory_mod
from app.caddie.session import get_owned_session
from app.services.clerk_auth import current_user_id


router = APIRouter(prefix="/api/memory", tags=["memory"])


class MemoryEntry(BaseModel):
    id: int
    kind: str
    summary: str
    weight: float
    round_id: Optional[str] = None
    created_at: str


class AddMemoryRequest(BaseModel):
    kind: str
    summary: str
    weight: float = 1.0


@router.get("/me")
async def get_my_memories(user_id: str = Depends(current_user_id)) -> dict:
    """Return the caller's memories, ranked for prompt injection."""
    rows = await memory_mod.get_top_memories(user_id)
    return {
        "user_id": user_id,
        "memories": [
            MemoryEntry(
                id=m.id,
                kind=m.kind,
                summary=m.summary,
                weight=float(m.weight),
                round_id=m.round_id,
                created_at=m.created_at.isoformat() if m.created_at else "",
            ).model_dump()
            for m in rows
        ],
    }


@router.post("/me")
async def add_my_memory(
    request: AddMemoryRequest,
    user_id: str = Depends(current_user_id),
) -> dict:
    """Manually save a memory (e.g. user explicitly tells the caddie to remember something)."""
    try:
        await memory_mod.add_memory(
            user_id=user_id,
            kind=request.kind,
            summary=request.summary,
            weight=request.weight,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"status": "ok"}


@router.post("/summarize-round")
async def summarize_round(
    round_id: str,
    user_id: str = Depends(current_user_id),
) -> dict:
    """Run the post-round LLM summarizer for a finished round and persist memories.

    Caller must own the round. Idempotent: safe to call multiple times — each
    call produces fresh memories. Normally called automatically from
    /api/caddie/session/end.
    """
    session = await get_owned_session(round_id, user_id)
    saved = await memory_mod.summarize_round(session)
    return {
        "round_id": round_id,
        "memories_saved": len(saved),
        "summaries": [m.summary for m in saved],
    }
