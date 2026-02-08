"""Caddie API routes - recommendation, course intelligence, voice, personalities."""

from fastapi import APIRouter, HTTPException
import anthropic
import os
import json
from typing import Optional

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
from app.services.osm import fetch_course_features

router = APIRouter(prefix="/api/caddie", tags=["caddie"])


@router.get("/personalities")
async def get_personalities():
    """List all available caddie personalities."""
    return {"personalities": list_personalities()}


@router.post("/weather")
async def get_weather(lat: float, lng: float):
    """Fetch weather conditions for a course location."""
    try:
        weather = await build_weather_conditions(lat, lng)
        return weather.model_dump()
    except Exception as e:
        raise HTTPException(500, f"Weather fetch failed: {e}")


@router.post("/course-intel")
async def get_course_intel(request: CourseIntelRequest):
    """Build course intelligence for all holes.

    Fetches elevation, green slope, weather, and OSM hazards.
    """
    if not request.hole_coordinates:
        raise HTTPException(400, "No hole coordinates provided")

    # Determine course center
    lat = request.course_lat
    lng = request.course_lng
    if lat is None or lng is None:
        # Use first hole's green as course center
        first = request.hole_coordinates[0]
        green = first.get("green", {})
        lat = green.get("lat", 0)
        lng = green.get("lng", 0)

    # Fetch weather
    weather = await build_weather_conditions(lat, lng)

    # Fetch OSM features for the course area
    osm_features = None
    try:
        osm_features = await fetch_course_features(lat, lng, radius_m=2000)
    except Exception:
        pass

    # Build intelligence for each hole
    holes: list[dict] = []
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
        except Exception as e:
            # Return partial data if one hole fails
            holes.append({"hole_number": hc.get("holeNumber", 0), "error": str(e)})

    return {
        "weather": weather.model_dump(),
        "holes": holes,
        "conditions": weather.conditions,
    }


@router.post("/recommend")
async def get_recommendation(request: RecommendationRequest):
    """Get a caddie recommendation for the current shot."""
    # Build minimal hole intelligence if not provided
    hole_intel = request.hole_intelligence
    if hole_intel is None:
        hole_intel = HoleIntelligence(
            hole_number=request.hole_number,
            par=request.par,
            yards=request.yards,
            effective_yards=request.yards,
        )

    distance = request.distance_yards or request.yards

    # Build weather if provided
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
    """Talk to your caddie — voice conversation powered by Claude."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(500, "ANTHROPIC_API_KEY not configured")

    personality = get_personality(request.personality_id)

    # Build context for the caddie
    context_parts = [
        f"Current hole: #{request.hole_number}, Par {request.par}, {request.yards} yards",
    ]
    if request.distance_yards:
        context_parts.append(f"Distance to pin: {request.distance_yards} yards")
    if request.wind_speed_mph > 0:
        context_parts.append(
            f"Wind: {request.wind_speed_mph} mph from {request.wind_direction}°"
        )
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

    # Build messages with conversation history
    messages = []
    for msg in request.conversation_history[-10:]:  # Keep last 10 messages
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

        return VoiceCaddieResponse(
            response=response_text,
        )
    except anthropic.AuthenticationError:
        raise HTTPException(401, "Invalid API key")
    except Exception as e:
        raise HTTPException(500, str(e))
