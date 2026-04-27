"""Caddie API routes - recommendation, course intelligence, voice, personalities, sessions."""

from fastapi import APIRouter, Depends, HTTPException
import anthropic
import os
import time
from typing import Optional
from pydantic import BaseModel

from app.caddie.types import (
    CourseIntelRequest,
    RecommendationRequest,
    VoiceCaddieRequest,
    VoiceCaddieResponse,
    PlayerStatsRequest,
    CaddieRecommendation,
    WeatherConditions,
    HoleIntelligence,
)
from app.caddie.aim_point import generate_recommendation
from app.caddie.player_stats import analyze_player_stats
from app.caddie.course_intel import build_hole_intelligence, build_weather_conditions
from app.caddie.personalities import (
    load_personality,
    list_personalities,
    create_personality,
)
from app.caddie.club_selection import CLUB_DISPLAY_NAMES
from app.caddie.session import sessions, ShotRecord, get_owned_session
from app.caddie import memory as memory_mod
from app.caddie import learning as learning_mod
from app.caddie.types import PlayerStatistics, PlayerTendencies
from app.services.osm import fetch_course_features
from app.services.clerk_auth import current_user_id, optional_user_id

router = APIRouter(prefix="/api/caddie", tags=["caddie"])


# ── Session models ──


class StartSessionRequest(BaseModel):
    round_id: str
    course_id: Optional[str] = None
    club_distances: dict[str, int] = {}
    handicap: Optional[float] = None


class RecordShotRequest(BaseModel):
    round_id: str
    hole_number: int
    club: str
    distance_yards: int
    result: Optional[str] = None


class SessionRecommendRequest(BaseModel):
    """Recommendation request that leverages session state."""
    round_id: str
    hole_number: int
    distance_yards: Optional[int] = None
    par: int = 4
    yards: int = 400
    player_lat: Optional[float] = None
    player_lng: Optional[float] = None
    shot_bearing: Optional[float] = None  # degrees from north toward target


class SessionVoiceRequest(BaseModel):
    """Voice request that leverages session state."""
    round_id: str
    transcript: str
    personality_id: str = "classic"
    hole_number: int = 1


# ── Session endpoints ──


@router.post("/session/start")
async def start_session(
    request: StartSessionRequest,
    user_id: str = Depends(current_user_id),
):
    """Start or resume a round session. Hydrates the player's persistent memories
    so the caddie can reference them throughout the round."""
    session = await sessions.get_or_create(
        request.round_id, request.course_id, user_id=user_id,
    )
    if request.club_distances:
        session.club_distances = request.club_distances
    if request.handicap is not None:
        session.handicap = request.handicap

    memories = await memory_mod.get_top_memories(user_id)
    profile = await memory_mod.get_player_profile(user_id)

    # Hydrate player_stats from the persistent profile so /session/recommend
    # picks up personal_sg + tendencies without an extra round-trip.
    if profile is not None:
        tendencies = PlayerTendencies(
            miss_direction=profile.miss_direction or "balanced",
            miss_short_pct=float(profile.miss_short_pct or 55),
            three_putts_per_round=float(profile.three_putts_per_round or 2),
            par5_bogey_rate=float(profile.par5_bogey_rate or 20),
        )
        session.player_stats = PlayerStatistics(
            handicap=float(profile.handicap) if profile.handicap is not None else session.handicap,
            rounds_analyzed=profile.rounds_analyzed or 0,
            tendencies=tendencies,
            personal_sg=dict(profile.personal_sg or {}),
        )

    await sessions.update(session)

    return {
        "round_id": session.round_id,
        "user_id": user_id,
        "status": "active",
        "holes_with_intel": list(session.hole_intel.keys()),
        "has_weather": session.weather is not None,
        "shot_count": len(session.shot_history),
        "conversation_length": len(session.conversation_history),
        "memories": [
            {"kind": m.kind, "summary": m.summary, "weight": float(m.weight)}
            for m in memories
        ],
        "profile": {
            "handicap": float(profile.handicap) if profile and profile.handicap is not None else None,
            "preferred_personality_id": profile.preferred_personality_id if profile else None,
            "rounds_analyzed": profile.rounds_analyzed if profile else 0,
        } if profile else None,
    }


@router.post("/session/end")
async def end_session(round_id: str, user_id: str = Depends(current_user_id)):
    """End a round session, summarize memories, and refresh personal SG aggregates.

    Caller must own the round.
    """
    await get_owned_session(round_id, user_id)
    session = await sessions.end(round_id)
    if session is None:
        return {"status": "not_found"}
    saved = await memory_mod.summarize_round(session)

    # Refresh personal_sg + tendencies from the user's logged shots so the
    # next round picks up everything this round just added.
    learning_summary = {}
    if session.user_id:
        try:
            learning_summary = await learning_mod.recompute_player_aggregates(session.user_id)
        except Exception:
            learning_summary = {"error": "aggregation_failed"}

    return {
        "status": "ended",
        "round_id": round_id,
        "shots_recorded": len(session.shot_history),
        "holes_played": len(set(s.hole_number for s in session.shot_history)),
        "messages_exchanged": len(session.conversation_history),
        "memories_saved": len(saved),
        "learning": learning_summary,
    }


@router.get("/session/{round_id}")
async def get_session_status(round_id: str, user_id: str = Depends(current_user_id)):
    """Check session status and cached data. Caller must own the round."""
    session = await get_owned_session(round_id, user_id)
    return {
        "status": "active",
        "round_id": session.round_id,
        "current_hole": session.current_hole,
        "holes_with_intel": list(session.hole_intel.keys()),
        "has_weather": session.weather is not None,
        "shot_count": len(session.shot_history),
        "conversation_length": len(session.conversation_history),
        "last_recommendation": session.last_recommendation.model_dump() if session.last_recommendation else None,
    }


@router.post("/session/shot")
async def record_shot(request: RecordShotRequest, user_id: str = Depends(current_user_id)):
    """Record a shot to the round session history. Caller must own the round.

    Uses an atomic JSONB append (`shot_history || :payload`) so concurrent
    /session/shot and /session/recommend calls cannot lose-update each other.
    """
    session = await get_owned_session(request.round_id, user_id)
    shot = ShotRecord(
        hole_number=request.hole_number,
        club=request.club,
        distance_yards=request.distance_yards,
        result=request.result,
        timestamp=time.time(),
    )
    await sessions.append_shot(request.round_id, shot)
    return {"status": "recorded", "total_shots": len(session.shot_history) + 1}


# ── Session-aware recommendation ──


@router.post("/session/recommend")
async def session_recommend(request: SessionRecommendRequest, user_id: str = Depends(current_user_id)):
    """Get a recommendation using cached session state (weather, intel, stats, history).

    Caller must own the round.
    """
    session = await get_owned_session(request.round_id, user_id)

    session.current_hole = request.hole_number

    # Use cached hole intelligence
    hole_intel = session.hole_intel.get(request.hole_number)
    if hole_intel is None:
        hole_intel = HoleIntelligence(
            hole_number=request.hole_number,
            par=request.par,
            yards=request.yards,
            effective_yards=request.yards,
        )

    distance = request.distance_yards or request.yards
    club_distances = session.club_distances or {}

    rec = generate_recommendation(
        hole=hole_intel,
        distance_yards=distance,
        club_distances=club_distances,
        handicap=session.handicap or 15.0,
        weather=session.weather,
        player_stats=session.player_stats,
        shot_bearing=request.shot_bearing or 0.0,
    )

    # Targeted update: only writes last_recommendation + current_hole, so a
    # concurrent /session/shot append doesn't get clobbered.
    await sessions.set_recommendation(request.round_id, rec, request.hole_number)
    return rec.model_dump()


# ── Session-aware voice ──


@router.post("/session/voice", response_model=VoiceCaddieResponse)
async def session_voice(request: SessionVoiceRequest, user_id: str = Depends(current_user_id)):
    """Voice caddie using session state — remembers entire round conversation.

    Caller must own the round.
    """
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(500, "ANTHROPIC_API_KEY not configured")

    session = await get_owned_session(request.round_id, user_id)

    personality = await load_personality(request.personality_id)
    # Bump current_hole atomically (no read-modify-write of the whole row).
    await sessions.set_current_hole(request.round_id, request.hole_number)
    session.current_hole = request.hole_number

    memories_block = ""
    if session.user_id:
        memories = await memory_mod.get_top_memories(session.user_id)
        memories_block = memory_mod.render_memories_for_prompt(memories)

    # Build rich context from session state
    context_parts = [
        f"Current hole: #{request.hole_number}",
    ]

    hole_intel = session.hole_intel.get(request.hole_number)
    if hole_intel:
        context_parts.append(f"Par {hole_intel.par}, {hole_intel.yards} yards (effective: {hole_intel.effective_yards})")
        if hole_intel.hazards:
            hazard_strs = [f"{h.type} {h.side}" for h in hole_intel.hazards[:4]]
            context_parts.append(f"Hazards: {', '.join(hazard_strs)}")
        if hole_intel.green_slope:
            context_parts.append(f"Green slope: {hole_intel.green_slope.description}")

    if session.weather:
        w = session.weather
        context_parts.append(
            f"Weather: {w.temperature_f:.0f}°F, wind {w.wind_speed_mph:.0f}mph from {w.wind_direction}°, "
            f"humidity {w.humidity:.0f}%"
        )

    if session.handicap is not None:
        context_parts.append(f"Player handicap: {session.handicap}")

    if session.club_distances:
        clubs_str = ", ".join(
            f"{CLUB_DISPLAY_NAMES.get(k, k)}: {v}y"
            for k, v in sorted(session.club_distances.items(), key=lambda x: x[1], reverse=True)
            if v
        )
        if clubs_str:
            context_parts.append(f"Player's clubs: {clubs_str}")

    if session.last_recommendation:
        rec = session.last_recommendation
        context_parts.append(
            f"Last recommendation: {rec.club} to {rec.target_yards}y, "
            f"aim: {rec.aim_point.description}, miss: {rec.miss_side.preferred}"
        )

    # Recent shot history for context
    recent_shots = session.shot_history[-5:]
    if recent_shots:
        shots_str = "; ".join(
            f"Hole {s.hole_number}: {s.club} {s.distance_yards}y → {s.result or '?'}"
            for s in recent_shots
        )
        context_parts.append(f"Recent shots: {shots_str}")

    context = "\n".join(context_parts)

    # Use full round conversation history (not just last 10)
    messages = []
    for msg in session.conversation_history[-20:]:
        messages.append({"role": msg.role, "content": msg.content})
    messages.append({"role": "user", "content": request.transcript})

    memory_section = f"\n--- PLAYER MEMORY ---\n{memories_block}\n" if memories_block else ""
    system_prompt = f"""{personality.system_prompt}
{memory_section}
--- CURRENT SITUATION ---
{context}

--- INSTRUCTIONS ---
You are caddying for this golfer right now, on the course. Respond to their question or comment.
Keep your response concise and in-character. If they ask about club selection, aim, or strategy,
use the context above to give specific, actionable advice. If they're just chatting, be personable
but keep it golf-focused. Never break character.
You have memory of the entire round conversation and prior rounds. Reference earlier holes/shots
or known tendencies when relevant."""

    try:
        client = anthropic.Anthropic(api_key=api_key)
        model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-5-20250929")
        message = client.messages.create(
            model=model,
            max_tokens=300,
            temperature=0.7,
            system=system_prompt,
            messages=messages,
        )
        response_text = message.content[0].text

        # Atomic dual append — either both turns persist or neither, so the
        # round's conversation history can't wedge into a user-without-assistant
        # state if the second commit fails.
        await sessions.append_message_pair(
            request.round_id,
            user_content=request.transcript,
            assistant_content=response_text,
            hole_number=request.hole_number,
        )

        return VoiceCaddieResponse(response=response_text)
    except anthropic.AuthenticationError:
        raise HTTPException(401, "Invalid API key")
    except Exception as e:
        raise HTTPException(500, str(e))


# ── Original stateless endpoints (still available) ──


@router.get("/personalities")
async def get_personalities(user_id: Optional[str] = Depends(optional_user_id)):
    """List caddie personas — public + caller's own custom ones."""
    return {"personalities": await list_personalities(user_id=user_id)}


class CreatePersonaRequest(BaseModel):
    name: str
    description: str
    avatar: str
    system_prompt: str
    realtime_instructions: Optional[str] = None
    voice_id: Optional[str] = None
    response_style: str = "conversational"
    traits: list[str] = []


def _slugify_persona_name(name: str) -> str:
    """Conservative slug for persona ids — alphanumeric + hyphen only, capped."""
    cleaned = "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-")
    cleaned = "-".join(filter(None, cleaned.split("-")))  # collapse repeats
    return (cleaned or "persona")[:40]


@router.post("/personalities")
async def create_persona(
    request: CreatePersonaRequest,
    user_id: str = Depends(current_user_id),
):
    """Create a custom persona, authored by the calling user.

    Security:
    - id is server-generated as `custom-<slug>-<uuid>`. The client cannot
      claim or shadow built-in persona ids (e.g. 'classic') or another
      user's persona id.
    - is_public is forced to False. Cross-user prompt injection — a malicious
      author publishing a persona whose system_prompt is loaded into another
      player's LLM context — requires admin review. A separate admin-gated
      endpoint will handle promoting personas to public when admin roles
      land.
    """
    import uuid

    persona_id = f"custom-{_slugify_persona_name(request.name)}-{uuid.uuid4().hex[:8]}"

    try:
        persona = await create_personality(
            persona_id=persona_id,
            name=request.name,
            description=request.description,
            avatar=request.avatar,
            system_prompt=request.system_prompt,
            realtime_instructions=request.realtime_instructions,
            voice_id=request.voice_id,
            response_style=request.response_style,
            traits=request.traits,
            is_public=False,
            author_user_id=user_id,
        )
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {
        "id": persona.id,
        "name": persona.name,
        "description": persona.description,
        "avatar": persona.avatar,
        "voice_id": persona.voice_id,
        "response_style": persona.response_style,
        "traits": persona.traits,
        "is_builtin": False,
        "is_public": False,
        "author_user_id": user_id,
    }


@router.post("/weather")
async def get_weather(
    lat: float,
    lng: float,
    round_id: Optional[str] = None,
    user_id: str = Depends(current_user_id),
):
    """Fetch weather conditions. Caches in session if the caller owns the round.

    Auth required — Open-Meteo is free but we still don't want anonymous polling."""
    try:
        weather = await build_weather_conditions(lat, lng)

        # Only write to a session when the caller is authenticated and owns it.
        if round_id and user_id:
            session = await sessions.get(round_id)
            if session and session.user_id == user_id:
                await sessions.set_weather(round_id, weather)

        return weather.model_dump()
    except Exception as e:
        raise HTTPException(500, f"Weather fetch failed: {e}")


@router.post("/course-intel")
async def get_course_intel(
    request: CourseIntelRequest,
    round_id: Optional[str] = None,
    user_id: str = Depends(current_user_id),
):
    """Build course intelligence. Caches in session only if caller owns the round.

    Auth required — fans out to USGS/Open-Meteo/OSM and Claude downstream."""
    if not request.hole_coordinates:
        raise HTTPException(400, "No hole coordinates provided")

    lat = request.course_lat
    lng = request.course_lng
    if lat is None or lng is None:
        first = request.hole_coordinates[0]
        green = first.get("green", {})
        lat = green.get("lat", 0)
        lng = green.get("lng", 0)

    weather = await build_weather_conditions(lat, lng)

    osm_features = None
    try:
        osm_features = await fetch_course_features(lat, lng, radius_m=2000)
    except Exception:
        pass

    holes: list[dict] = []
    hole_intel_map: dict[int, HoleIntelligence] = {}
    for hc in request.hole_coordinates:
        try:
            intel = await build_hole_intelligence(
                hole_coords=hc,
                par=hc.get("par", 4),
                yards=hc.get("yards", 400),
                handicap_rating=hc.get("handicap", 9),
                osm_features=osm_features,
            )
            holes.append(intel.model_dump())
            hole_intel_map[intel.hole_number] = intel
        except Exception as e:
            holes.append({"hole_number": hc.get("holeNumber", 0), "error": str(e)})

    # Cache everything in session — only when caller owns the round.
    if round_id and user_id:
        session = await sessions.get(round_id)
        if session and session.user_id == user_id:
            await sessions.set_hole_intel(round_id, hole_intel_map, weather=weather)

    return {
        "weather": weather.model_dump(),
        "holes": holes,
        "conditions": weather.conditions,
    }


@router.post("/recommend")
async def get_recommendation(
    request: RecommendationRequest,
    user_id: str = Depends(current_user_id),
):
    """Stateless recommendation (use /session/recommend for session-aware).

    Auth required — protects against anonymous abuse of the paid LLM/APIs."""
    hole_intel = request.hole_intelligence
    if hole_intel is None:
        hole_intel = HoleIntelligence(
            hole_number=request.hole_number,
            par=request.par,
            yards=request.yards,
            effective_yards=request.yards,
        )

    distance = request.distance_yards or request.yards
    weather = request.weather

    rec = generate_recommendation(
        hole=hole_intel,
        distance_yards=distance,
        club_distances=request.club_distances,
        handicap=request.handicap or 15.0,
        weather=weather,
        player_stats=request.player_stats,
        shot_bearing=request.shot_bearing or 0.0,
    )
    return rec.model_dump()


@router.post("/player-stats")
async def compute_player_stats(
    request: PlayerStatsRequest,
    user_id: str = Depends(current_user_id),
):
    """Analyze player statistics from round history. Auth required."""
    stats = analyze_player_stats(
        rounds=request.rounds,
        handicap=request.handicap,
        course_id=request.course_id,
    )
    return stats.model_dump()


@router.post("/voice", response_model=VoiceCaddieResponse)
async def voice_caddie(
    request: VoiceCaddieRequest,
    user_id: str = Depends(current_user_id),
):
    """Stateless voice caddie (use /session/voice for session-aware).

    Auth required — Anthropic spend is metered against our project keys."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(500, "ANTHROPIC_API_KEY not configured")

    personality = await load_personality(request.personality_id)

    context_parts = [
        f"Current hole: #{request.hole_number}, Par {request.par}, {request.yards} yards",
    ]
    if request.distance_yards:
        context_parts.append(f"Distance to pin: {request.distance_yards} yards")
    if request.wind_speed_mph > 0:
        context_parts.append(f"Wind: {request.wind_speed_mph} mph from {request.wind_direction}°")
    if request.handicap is not None:
        context_parts.append(f"Player handicap: {request.handicap}")

    if request.club_distances:
        clubs_str = ", ".join(
            f"{CLUB_DISPLAY_NAMES.get(k, k)}: {v}y"
            for k, v in sorted(request.club_distances.items(), key=lambda x: x[1], reverse=True)
            if v
        )
        if clubs_str:
            context_parts.append(f"Player's clubs: {clubs_str}")

    if request.current_recommendation:
        rec = request.current_recommendation
        context_parts.append(
            f"Current recommendation: {rec.get('club', '?')} to {rec.get('target_yards', '?')} yards"
        )
        if rec.get("aim_point", {}).get("description"):
            context_parts.append(f"Aim: {rec['aim_point']['description']}")
        if rec.get("miss_side", {}).get("description"):
            context_parts.append(f"Miss side: {rec['miss_side']['description']}")

    context = "\n".join(context_parts)

    messages = []
    for msg in request.conversation_history[-10:]:
        messages.append({
            "role": msg.get("role", "user"),
            "content": msg.get("content", ""),
        })
    messages.append({"role": "user", "content": request.transcript})

    system_prompt = f"""{personality.system_prompt}

--- CURRENT SITUATION ---
{context}

--- INSTRUCTIONS ---
You are caddying for this golfer right now, on the course. Respond to their question or comment.
Keep your response concise and in-character. If they ask about club selection, aim, or strategy,
use the context above to give specific, actionable advice. If they're just chatting, be personable
but keep it golf-focused. Never break character."""

    try:
        client = anthropic.Anthropic(api_key=api_key)
        model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-5-20250929")
        message = client.messages.create(
            model=model,
            max_tokens=300,
            temperature=0.7,
            system=system_prompt,
            messages=messages,
        )
        response_text = message.content[0].text
        return VoiceCaddieResponse(response=response_text)
    except anthropic.AuthenticationError:
        raise HTTPException(401, "Invalid API key")
    except Exception as e:
        raise HTTPException(500, str(e))
