"""OpenAI Realtime session endpoints.

The browser hits POST /api/realtime/session to obtain a 60-second ephemeral
client_secret, then opens a WebRTC connection directly to OpenAI. The full
OPENAI_API_KEY never leaves the server.

Tool calls (e.g. `get_recommendation`) flow back from OpenAI over the data
channel; the frontend dispatches them to existing FastAPI endpoints. This keeps
EC2 stateless — no WebSocket bridge.
"""

from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import update as sql_update

from app.caddie.session import sessions, get_owned_session
from app.caddie.personalities import load_personality
from app.caddie.voice_prompts import build_realtime_instructions
from app.caddie import memory as memory_mod
from app.services.realtime_relay import mint_ephemeral_session, DEFAULT_TOOLS
from app.services.clerk_auth import current_user_id


router = APIRouter(prefix="/api/realtime", tags=["realtime"])


class StartRealtimeSessionRequest(BaseModel):
    round_id: str
    personality_id: str = "classic"


class StartRealtimeSessionResponse(BaseModel):
    client_secret: str
    expires_at: int
    model: str
    voice_id: str
    instructions: str
    tools: list[dict]
    realtime_session_id: str


@router.post("/session", response_model=StartRealtimeSessionResponse)
async def start_realtime_session(
    request: StartRealtimeSessionRequest,
    user_id: str = Depends(current_user_id),
):
    """Mint an ephemeral OpenAI Realtime session for the given round.

    Caller must have already started a caddie session via /api/caddie/session/start
    AND must own that round (verified by get_owned_session).
    """
    session = await get_owned_session(request.round_id, user_id)

    personality = await load_personality(request.personality_id)
    memories = await memory_mod.get_top_memories(user_id) if user_id else []
    instructions = build_realtime_instructions(personality, session=session, memories=memories)

    mint = await mint_ephemeral_session(
        instructions=instructions,
        voice_id=personality.voice_id,
        tools=DEFAULT_TOOLS,
    )

    client_secret_obj = mint.get("client_secret") or {}
    client_secret = client_secret_obj.get("value") if isinstance(client_secret_obj, dict) else None
    expires_at = client_secret_obj.get("expires_at") if isinstance(client_secret_obj, dict) else None
    if not client_secret:
        raise HTTPException(502, f"OpenAI did not return a client_secret: {mint}")

    realtime_session_id = mint.get("id") or ""

    # Targeted column update — won't clobber a concurrent /session/shot append.
    await sessions.set_realtime_session_id(
        request.round_id, realtime_session_id, personality_id=request.personality_id,
    )

    return StartRealtimeSessionResponse(
        client_secret=client_secret,
        expires_at=int(expires_at) if expires_at else 0,
        model=mint.get("model", ""),
        voice_id=personality.voice_id or mint.get("voice", ""),
        instructions=instructions,
        tools=DEFAULT_TOOLS,
        realtime_session_id=realtime_session_id,
    )
