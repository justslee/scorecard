"""Caddie API routes - recommendation, course intelligence, voice, personalities, sessions."""

from fastapi import APIRouter, HTTPException
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
from app.caddie.personalities import get_personality, list_personalities
from app.caddie.club_selection import CLUB_DISPLAY_NAMES
from app.caddie.session import sessions, ShotRecord
from app.services.osm import fetch_course_features

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


class SessionVoiceRequest(BaseModel):
    """Voice request that leverages session state."""
    round_id: str
    transcript: str
    personality_id: str = "classic"
    hole_number: int = 1


# ── Session endpoints ──


@router.post("/session/start")
async def start_session(request: StartSessionRequest):
    """Start or resume a round session. Call this when a round begins."""
    session = sessions.get_or_create(request.round_id, request.course_id)
    if request.club_distances:
        session.club_distances = request.club_distances
    if request.handicap is not None:
        session.handicap = request.handicap
    sessions.update(session)
    return {
        "round_id": session.round_id,
        "status": "active",
        "holes_with_intel": list(session.hole_intel.keys()),
        "has_weather": session.weather is not None,
        "shot_count": len(session.shot_history),
        "conversation_length": len(session.conversation_history),
    }


@router.post("/session/end")
async def end_session(round_id: str):
    """End a round session. Returns summary stats."""
    session = sessions.end(round_id)
    if session is None:
        return {"status": "not_found"}
    return {
        "status": "ended",
        "round_id": round_id,
        "shots_recorded": len(session.shot_history),
        "holes_played": len(set(s.hole_number for s in session.shot_history)),
        "messages_exchanged": len(session.conversation_history),
    }


@router.get("/session/{round_id}")
async def get_session_status(round_id: str):
    """Check session status and cached data."""
    session = sessions.get(round_id)
    if session is None:
        return {"status": "not_found"}
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
async def record_shot(request: RecordShotRequest):
    """Record a shot to the round session history."""
    session = sessions.get(request.round_id)
    if session is None:
        raise HTTPException(404, "No active session for this round")
    session.shot_history.append(ShotRecord(
        hole_number=request.hole_number,
        club=request.club,
        distance_yards=request.distance_yards,
        result=request.result,
        timestamp=time.time(),
    ))
    sessions.update(session)
    return {"status": "recorded", "total_shots": len(session.shot_history)}


# ── Session-aware recommendation ──


@router.post("/session/recommend")
async def session_recommend(request: SessionRecommendRequest):
    """Get a recommendation using cached session state (weather, intel, stats, history)."""
    session = sessions.get(request.round_id)
    if session is None:
        raise HTTPException(404, "No active session — call /session/start first")

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
    )

    session.last_recommendation = rec
    sessions.update(session)
    return rec.model_dump()


# ── Session-aware voice ──


@router.post("/session/voice", response_model=VoiceCaddieResponse)
async def session_voice(request: SessionVoiceRequest):
    """Voice caddie using session state — remembers entire round conversation."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(500, "ANTHROPIC_API_KEY not configured")

    session = sessions.get(request.round_id)
    if session is None:
        raise HTTPException(404, "No active session — call /session/start first")

    personality = get_personality(request.personality_id)
    session.current_hole = request.hole_number

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

    system_prompt = f"""{personality.system_prompt}

--- CURRENT SITUATION ---
{context}

--- INSTRUCTIONS ---
You are caddying for this golfer right now, on the course. Respond to their question or comment.
Keep your response concise and in-character. If they ask about club selection, aim, or strategy,
use the context above to give specific, actionable advice. If they're just chatting, be personable
but keep it golf-focused. Never break character.
You have memory of the entire round conversation. Reference earlier holes/shots when relevant."""

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

        # Store in session conversation history
        from app.caddie.session import VoiceCaddieMessage as SessionMessage
        session.conversation_history.append(SessionMessage(role="user", content=request.transcript))
        session.conversation_history.append(SessionMessage(role="assistant", content=response_text))
        sessions.update(session)

        return VoiceCaddieResponse(response=response_text)
    except anthropic.AuthenticationError:
        raise HTTPException(401, "Invalid API key")
    except Exception as e:
        raise HTTPException(500, str(e))


# ── Original stateless endpoints (still available) ──


@router.get("/personalities")
async def get_personalities():
    """List all available caddie personalities."""
    return {"personalities": list_personalities()}


@router.post("/weather")
async def get_weather(lat: float, lng: float, round_id: Optional[str] = None):
    """Fetch weather conditions. Caches in session if round_id provided."""
    try:
        weather = await build_weather_conditions(lat, lng)

        # Cache in session if active
        if round_id:
            session = sessions.get(round_id)
            if session:
                session.weather = weather
                session.weather_fetched_at = time.time()
                sessions.update(session)

        return weather.model_dump()
    except Exception as e:
        raise HTTPException(500, f"Weather fetch failed: {e}")


@router.post("/course-intel")
async def get_course_intel(request: CourseIntelRequest, round_id: Optional[str] = None):
    """Build course intelligence. Caches in session if round_id provided."""
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

    # Cache everything in session
    if round_id:
        session = sessions.get(round_id)
        if session:
            session.weather = weather
            session.weather_fetched_at = time.time()
            session.hole_intel = hole_intel_map
            sessions.update(session)

    return {
        "weather": weather.model_dump(),
        "holes": holes,
        "conditions": weather.conditions,
    }


@router.post("/recommend")
async def get_recommendation(request: RecommendationRequest):
    """Stateless recommendation (use /session/recommend for session-aware)."""
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
    )
    return rec.model_dump()


@router.post("/player-stats")
async def compute_player_stats(request: PlayerStatsRequest):
    """Analyze player statistics from round history."""
    stats = analyze_player_stats(
        rounds=request.rounds,
        handicap=request.handicap,
        course_id=request.course_id,
    )
    return stats.model_dump()


@router.post("/voice", response_model=VoiceCaddieResponse)
async def voice_caddie(request: VoiceCaddieRequest):
    """Stateless voice caddie (use /session/voice for session-aware)."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(500, "ANTHROPIC_API_KEY not configured")

    personality = get_personality(request.personality_id)

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
