"""OpenAI Realtime session endpoints.

The browser hits POST /api/realtime/session to obtain a 60-second ephemeral
client_secret, then opens a WebRTC connection directly to OpenAI. The full
OPENAI_API_KEY never leaves the server.

Tool calls (e.g. `get_recommendation`) flow back from OpenAI over the data
channel; the frontend dispatches them to existing FastAPI endpoints. This keeps
EC2 stateless — no WebSocket bridge.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.caddie.session import sessions, get_owned_session
from app.caddie.personalities import load_personality, personality_visible
from app.caddie.voice_prompts import build_realtime_instructions
from app.caddie.setup_voice import SETUP_TOOLS, build_setup_instructions
from app.caddie import memory as memory_mod
from app.services.realtime_relay import mint_ephemeral_session, DEFAULT_TOOLS
from app.services.rate_limit import caddie_rate_limited_user


def _client_secret_from_mint(mint: dict) -> tuple[str, int]:
    """Extract (client_secret value, expires_at) from an OpenAI mint response.

    GA /v1/realtime/client_secrets returns the secret at top-level "value"; the
    legacy /sessions nested it under client_secret.value — handle both.
    """
    value = mint.get("value")
    expires = mint.get("expires_at")
    if not value:
        obj = mint.get("client_secret")
        if isinstance(obj, dict):
            value = obj.get("value")
            expires = obj.get("expires_at")
    if not value:
        raise HTTPException(502, f"OpenAI did not return a client_secret: {mint}")
    return value, int(expires) if expires else 0


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


class SetupSessionRequest(BaseModel):
    personality_id: str = "classic"


@router.post("/setup-session", response_model=StartRealtimeSessionResponse)
async def start_setup_session(
    request: SetupSessionRequest,
    user_id: str = Depends(caddie_rate_limited_user),
):
    """Mint a Realtime session for CONVERSATIONAL ROUND SETUP (no round yet).

    The caddie gathers course / players / tees over a natural back-and-forth and
    calls the set_round_setup tool; the frontend creates the round from that.
    Round-less by design — unlike /session it needs no existing caddie session.
    """
    personality = await load_personality(request.personality_id)
    instructions = build_setup_instructions()

    mint = await mint_ephemeral_session(
        instructions=instructions,
        voice_id=personality.voice_id,
        tools=SETUP_TOOLS,
    )
    client_secret, expires_at = _client_secret_from_mint(mint)

    return StartRealtimeSessionResponse(
        client_secret=client_secret,
        expires_at=expires_at,
        model=mint.get("model", ""),
        voice_id=personality.voice_id or mint.get("voice", ""),
        instructions=instructions,
        tools=SETUP_TOOLS,
        realtime_session_id=mint.get("id") or "",
    )


@router.post("/session", response_model=StartRealtimeSessionResponse)
async def start_realtime_session(
    request: StartRealtimeSessionRequest,
    user_id: str = Depends(caddie_rate_limited_user),
):
    """Mint an ephemeral OpenAI Realtime session for the given round.

    Caller must have already started a caddie session via /api/caddie/session/start
    AND must own that round (verified by get_owned_session).
    """
    session = await get_owned_session(request.round_id, user_id)

    # Visibility gate (matches session_voice / talk_to_caddie): never render
    # another user's private persona prompt into the returned instructions.
    persona_id = (
        request.personality_id
        if await personality_visible(request.personality_id, user_id)
        else "classic"
    )
    personality = await load_personality(persona_id)
    memories = await memory_mod.get_top_memories(user_id) if user_id else []
    instructions = build_realtime_instructions(personality, session=session, memories=memories)

    mint = await mint_ephemeral_session(
        instructions=instructions,
        voice_id=personality.voice_id,
        tools=DEFAULT_TOOLS,
    )

    client_secret, expires_at = _client_secret_from_mint(mint)

    realtime_session_id = mint.get("id") or ""

    # Targeted column update — won't clobber a concurrent /session/shot append.
    await sessions.set_realtime_session_id(
        request.round_id, realtime_session_id, personality_id=persona_id,
    )

    return StartRealtimeSessionResponse(
        client_secret=client_secret,
        expires_at=expires_at,
        model=mint.get("model", ""),
        voice_id=personality.voice_id or mint.get("voice", ""),
        instructions=instructions,
        tools=DEFAULT_TOOLS,
        realtime_session_id=realtime_session_id,
    )
