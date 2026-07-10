"""Caddie API routes - recommendation, course intelligence, voice, personalities, sessions."""

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import StreamingResponse
import anthropic
import json
import logging
import os
from typing import AsyncIterator, Optional
from pydantic import BaseModel, Field

from app.caddie.types import (
    CourseIntelRequest,
    RecommendationRequest,
    VoiceCaddieRequest,
    VoiceCaddieResponse,
    PlayerStatsRequest,
    HoleIntelligence,
)
from app.caddie.aim_point import generate_recommendation
from app.caddie.player_stats import analyze_player_stats
from app.caddie.course_intel import build_hole_intelligence, build_weather_conditions
from app.caddie.green_geometry import GREEN_GROUNDING_RULE
from app.caddie.hazards import (
    BEND_GROUNDING_RULE,
    HAZARD_GROUNDING_RULE,
    extract_hole_bend,
    extract_hole_hazards,
    format_bend_line,
    format_hazards_line,
)
from app.caddie.physics import PHYSICS_GROUNDING_RULE
from app.caddie.guide_writer import format_guide_line
from app.caddie.voice_prompts import INPUT_GROUNDING_RULE, OBSERVED_REALITY_RULE, TOOL_USE_RULE
from app.caddie import tools as caddie_tools
from app.caddie.tool_loop import run_caddie_turn
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.caddie.personalities import (
    load_personality,
    list_personalities,
    create_personality,
    personality_visible,
    DEFAULT_PERSONALITY_ID,
)
from app.caddie.club_selection import CLUB_DISPLAY_NAMES
from app.caddie.session import sessions, get_owned_session
from app.db.engine import async_session
from app.db.models import PlayerProfile
from app.caddie import memory as memory_mod
from app.caddie import learning as learning_mod
from app.caddie.types import PlayerStatistics, PlayerTendencies
from app.services import courses_mapped
from app.services.course_guides import _precompute_course_guides
from app.services.elevation import sample_course_elevations
from app.services.course_spatial import _ring_centroid
from app.services.clerk_auth import current_user_id, optional_user_id
from app.services.rate_limit import caddie_rate_limited_user

log = logging.getLogger("looper.caddie")

# The calm, in-character line the golfer sees when a caddie path fails for
# any reason. Internals go to the log (traceback), NEVER to the client.
_CADDIE_ERROR_DETAIL = "The caddie lost that one — give it another go."

# Bounded client timeout + one SDK-native retry on transient errors
# (408/409/429/5xx/connection) — worst-case wall clock ≈ timeout × (retries+1)
# ≈ 50s, a big improvement over the ~10-min SDK default that was starving the
# single worker on a stalled upstream call.
_CADDIE_TIMEOUT_S = 25.0
_CADDIE_MAX_RETRIES = 1


def _log_caddie_usage(usage, *, context: str, persona_id: Optional[str], call_index: int = 0) -> None:
    """One structured line proving prompt-cache engagement (or an honest
    below-floor no-op) — cache_read/cache_creation vs plain input tokens.
    `call_index` tags which model call of a (possibly multi-call) tool-loop
    turn this was. Logging must never break a reply, so this never raises."""
    try:
        log.info(
            "caddie_usage",
            extra={
                "caddie_context": context,
                "persona_id": persona_id,
                "call_index": call_index,
                "cache_read_input_tokens": getattr(usage, "cache_read_input_tokens", 0) or 0,
                "cache_creation_input_tokens": getattr(usage, "cache_creation_input_tokens", 0) or 0,
                "input_tokens": getattr(usage, "input_tokens", 0) or 0,
                "output_tokens": getattr(usage, "output_tokens", 0) or 0,
            },
        )
    except Exception:  # noqa: BLE001 — logging must never break a reply
        log.debug("caddie_usage log failed", exc_info=True)


def _safe_course_uuid(value) -> str | None:
    """The caddie_sessions.course_id column is a UUID — legacy rounds carry
    slug ids that must never reach the INSERT (asyncpg DataError)."""
    if not value:
        return None
    import uuid as _uuid

    try:
        return str(_uuid.UUID(str(value)))
    except (ValueError, AttributeError, TypeError):
        return None


async def _resolve_mapped_course_id(course_name: str) -> str | None:
    """Best-effort: a legacy round's course NAME → our mapped course UUID,
    only when the match is unambiguous. Never raises."""
    try:
        rows = await courses_mapped.list_courses(search=course_name)
        exact = [
            r for r in rows
            if str(r.get("name", "")).strip().lower() == course_name.strip().lower()
        ]
        candidates = exact or rows
        if len(candidates) == 1:
            return _safe_course_uuid(candidates[0].get("id"))
    except Exception:  # noqa: BLE001 — best-effort by design
        log.warning("mapped-course name resolution failed", exc_info=True)
    return None


def _green_persisted_elevation(stored_hole: Optional[dict]) -> Optional[dict]:
    """Pull the green feature's persisted elevation subset from a stored hole
    (as returned by `courses_mapped.get_course`), or None when absent."""
    if not stored_hole:
        return None
    feats = (stored_hole.get("features") or {}).get("features") or []
    for f in feats:
        props = f.get("properties") or {}
        if props.get("featureType") == "green" and props.get("tee_elevation_ft") is not None:
            return props  # full props dict; build_hole_intelligence reads only elevation keys
    return None


def _green_persisted_guide(stored_hole: Optional[dict]) -> Optional[dict]:
    """Pull the green feature's persisted `strategy_guide` dict from a stored
    hole (as returned by `courses_mapped.get_course`), or None when absent."""
    if not stored_hole:
        return None
    feats = (stored_hole.get("features") or {}).get("features") or []
    for f in feats:
        props = f.get("properties") or {}
        if props.get("featureType") == "green" and props.get("strategy_guide") is not None:
            return props.get("strategy_guide")
    return None


def _feature_center(feats: list[dict], feature_type: str) -> Optional[tuple[float, float]]:
    """(lng, lat) centre of the first WELL-FORMED feature of `feature_type`.

    A malformed feature (missing/invalid geometry) must not blind the whole
    hole: skip it and keep scanning later same-type features rather than
    returning None on the first bad one.
    """
    for f in feats:
        if (f.get("properties") or {}).get("featureType") != feature_type:
            continue
        geom = f.get("geometry") or {}
        coords = geom.get("coordinates")
        gtype = geom.get("type")
        try:
            if gtype == "Point":
                return (coords[0], coords[1])
            if gtype == "Polygon":
                lon, lat = _ring_centroid(coords[0])
                return (lon, lat)
            if gtype == "MultiPolygon":
                lon, lat = _ring_centroid(coords[0][0])
                return (lon, lat)
        except (TypeError, IndexError, KeyError):
            continue  # malformed feature — keep scanning remaining same-type features
    return None


async def _precompute_course_elevations(course_id: str) -> None:
    """Seed per-hole elevation into green-feature properties so the 2nd
    course-intel open shows elevation instantly. Best-effort: never raises."""
    try:
        course = await courses_mapped.get_course(course_id)
        if not course:
            return

        # Build the minimal LineString hole list sample_course_elevations
        # expects (tee = coords[0], green = coords[-1]), deriving tee/green
        # centres from stored polygon features. Only holes MISSING persisted
        # elevation are sampled (idempotent + avoids re-hitting USGS).
        synth_holes: list[dict] = []
        SYNTH_NAME = "precompute"
        for h in course.get("holes", []):
            feats = (h.get("features") or {}).get("features") or []
            green_c = _feature_center(feats, "green")
            tee_c = _feature_center(feats, "tee")
            if green_c is None or tee_c is None:
                continue  # absent != zero — cannot sample; skip
            if _green_persisted_elevation(h) is not None:
                continue  # already persisted — idempotent skip
            synth_holes.append({
                "type": "Feature",
                "properties": {"course_name": SYNTH_NAME, "ref": h["number"]},
                "geometry": {
                    "type": "LineString",
                    "coordinates": [
                        [tee_c[0], tee_c[1]],      # [lng, lat] tee   -> coords[0]
                        [green_c[0], green_c[1]],  # [lng, lat] green -> coords[-1]
                    ],
                },
            })

        if not synth_holes:
            return  # nothing to do — zero USGS calls

        profiles = await sample_course_elevations(synth_holes, SYNTH_NAME)  # 2 batched calls
        for hole_number, profile in profiles.items():  # omit-on-missing already applied
            try:
                await courses_mapped.update_green_feature_properties(
                    course_id, hole_number, courses_mapped._elevation_patch(profile)
                )
            except Exception:
                log.warning("precompute write-back failed hole %s", hole_number, exc_info=True)
    except Exception:
        log.warning("elevation precompute failed course=%s", course_id, exc_info=True)


def _first_text(message) -> str:
    """The first text block of a Claude response, or '' when the model
    returned no text (rare but real — empty content was crashing session_voice
    with an IndexError that leaked 'list index out of range' to the sheet).

    The voice mouths now assemble their reply from the tool loop's streamed
    deltas (app/caddie/tool_loop.py), but this stays the canonical safe-read
    helper for one-shot Claude responses (pinned by test_voice_error_hygiene)."""
    for block in getattr(message, "content", None) or []:
        text = getattr(block, "text", None)
        if text:
            return text
    return ""


router = APIRouter(prefix="/api/caddie", tags=["caddie"])


# ── Session models ──


class StartSessionRequest(BaseModel):
    round_id: str
    course_id: Optional[str] = None
    # Course display name — lets the server resolve LEGACY slug ids to a
    # mapped-course UUID by unambiguous name match (see _resolve_mapped_course_id).
    course_name: Optional[str] = None
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
    competition_legal: bool = False  # True = USGA-conforming mode; zeroes all environmental distance adjustments


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
    background_tasks: BackgroundTasks = None,  # type: ignore[assignment]
    user_id: str = Depends(current_user_id),
):
    """Start or resume a round session. Hydrates the player's persistent memories
    so the caddie can reference them throughout the round."""
    # course_id lands in a UUID column. LEGACY rounds carry slug ids
    # ('bethpage-black') which crashed EVERY session start on those rounds
    # (owner's 2026-07-07 round: no session → no intel → no hazards/elev/
    # weather tiles, stateless voice only). Non-UUID ids: try resolving the
    # round's course by name against our mapped store; else start the session
    # WITHOUT a stored course (weather/memory still work) rather than crash.
    course_id = _safe_course_uuid(request.course_id)
    if course_id is None and request.course_id and request.course_name:
        course_id = await _resolve_mapped_course_id(request.course_name)
        if course_id:
            log.info(
                "session/start: legacy course id %r resolved by name to %s",
                request.course_id, course_id,
            )
    session = await sessions.get_or_create(
        request.round_id, course_id, user_id=user_id,
    )

    # Precompute per-hole elevation into the stored green features so the
    # next course-intel open shows it instantly (zero USGS calls). Resilient
    # + idempotent — fired after the response is sent, never blocks/fails
    # session start.
    if course_id:
        bg = background_tasks if background_tasks is not None else BackgroundTasks()
        bg.add_task(_precompute_course_elevations, course_id)
        # FALLBACK strategy-guide trigger — a cold course mapped before this
        # feature existed still gets guides seeded on first play. Idempotent
        # (skips any hole already guided), so on an already-guided course
        # this is a cheap all-skip pass with ZERO LLM calls.
        bg.add_task(_precompute_course_guides, course_id)

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
    return caddie_tools.session_status_payload(session)


@router.post("/session/shot")
async def record_shot(request: RecordShotRequest, user_id: str = Depends(current_user_id)):
    """Record a shot to the session history AND the durable `shots` table.

    Caller must own the round. The session JSONB history feeds the in-round
    conversation context (atomic `shot_history || :payload` append, so
    concurrent /session/shot and /session/recommend calls cannot lose-update
    each other); the durable Shot row feeds post-round learning
    (learning.recompute_player_aggregates) so voice-logged shots count from
    day one. Lat/lng are unknown on the voice path — left null.

    Idempotence: an identical (hole, club, distance, result) shot within
    tools.SHOT_RETRY_WINDOW_SECONDS of the last recorded one is a retry —
    neither store is written twice. Body lives in app/caddie/tools.py, shared
    with the text tool loop (parity by construction).
    """
    session = await get_owned_session(request.round_id, user_id)
    return await caddie_tools.record_shot_payload(
        session,
        request.round_id,
        user_id,
        request.hole_number,
        request.club,
        request.distance_yards,
        result=request.result,
    )


# ── Session-derived tool endpoints (Realtime tool surface v1) ──


@router.get("/session/{round_id}/conditions")
async def get_session_conditions(
    round_id: str,
    hole_number: Optional[int] = None,
    user_id: str = Depends(current_user_id),
):
    """Deterministic conditions read for the `get_conditions` voice tool.

    Weather comes from the session cache (Open-Meteo, refreshed by course-intel);
    the plays-like delta is the elevation-adjusted effective yardage already
    computed into hole_intel. Honest by design: holes without cached intel
    return plays_like=None rather than a guess — the model is instructed to
    never invent numbers a tool didn't return. Body lives in
    app/caddie/tools.py, shared with the text tool loop.
    """
    session = await get_owned_session(round_id, user_id)
    return caddie_tools.conditions_payload(session, hole_number)


@router.get("/session/{round_id}/player-profile")
async def get_session_player_profile(
    round_id: str,
    user_id: str = Depends(current_user_id),
):
    """Player numbers for the `get_player_profile` voice tool.

    Effective club distances are the session's (entered) distances for now —
    P4 blends in learned distances. Tendencies come from player_profiles.
    Body lives in app/caddie/tools.py, shared with the text tool loop.
    """
    session = await get_owned_session(round_id, user_id)
    return await caddie_tools.player_profile_payload(session, user_id)


@router.get("/session/{round_id}/carries")
async def get_session_carries(
    round_id: str,
    hole_number: Optional[int] = None,
    user_id: str = Depends(current_user_id),
):
    """Real along-path carries for the `get_carries` voice tool (both mouths).

    Combines the hole's mapped hazards' along-path carry_yards with the
    player's entered club distances. Honest empties per the no-fake-data
    rule: `available:false` when the hole has no cached intel, an explicit
    empty list + note when the hole genuinely has no in-play hazards — never
    an invented carry. Body lives in app/caddie/tools.py.
    """
    session = await get_owned_session(round_id, user_id)
    return caddie_tools.carries_payload(session, hole_number or session.current_hole)


@router.get("/session/{round_id}/bend")
async def get_session_bend(
    round_id: str,
    hole_number: Optional[int] = None,
    user_id: str = Depends(current_user_id),
):
    """Where/how far the fairway bends for the `get_bend` voice tool (both mouths).

    Fields come verbatim from the hole's cached `HoleIntelligence.bend`
    (app/caddie/hazards.py::extract_hole_bend at intel time) — never
    recomputed here. Honest matrix per the no-fake-data rule:
    `available:false` when the hole has no cached intel OR the centerline
    isn't mapped (two distinct reasons), `straight:true` + a note when the
    hole genuinely plays straight — never an invented dogleg. Body lives in
    app/caddie/tools.py.
    """
    session = await get_owned_session(round_id, user_id)
    return caddie_tools.bend_payload(session, hole_number or session.current_hole)


class ShotDistanceRequest(BaseModel):
    """One shot's physics numbers (the `get_shot_distance` voice tool).
    At least one of `club` / `target_yards` is required."""
    round_id: str
    hole_number: Optional[int] = None
    club: Optional[str] = None
    # gt=0: a zero/negative target is not a shot — reject it rather than
    # return a degenerate all-None payload as if valid (reviewer-caught
    # honesty gap; no fabricated precision).
    target_yards: Optional[int] = Field(default=None, gt=0)


@router.post("/session/shot-distance")
async def get_session_shot_distance(
    request: ShotDistanceRequest,
    user_id: str = Depends(current_user_id),
):
    """Physics-engine shot distances for the `get_shot_distance` voice tool
    (both mouths — the Realtime orb dispatches here; the text tool loop
    resolves the same body via tools.shot_distance_payload).

    Deterministic + pure of network: runs the RK4 ball-flight engine against
    the session's cached weather + hole elevation, anchored to the player's
    stored club distances. Honest degradation per [[no-fake-data-fallbacks]]:
    available:false when the needed club distance isn't on file; still-air /
    flat-ground assumptions are surfaced, never silently fabricated.
    """
    if not request.club and request.target_yards is None:
        raise HTTPException(422, "At least one of club / target_yards is required")
    session = await get_owned_session(request.round_id, user_id)
    return caddie_tools.shot_distance_payload(
        session,
        hole_number=request.hole_number,
        club=request.club,
        target_yards=request.target_yards,
    )


class GreenReadRequest(BaseModel):
    """Which side of the green leaves the uphill putt (the `get_green_read` voice tool)."""
    round_id: str
    hole_number: Optional[int] = None


@router.post("/session/green-read")
async def get_session_green_read(
    request: GreenReadRequest,
    user_id: str = Depends(current_user_id),
):
    """Deterministic green-slope read for the `get_green_read` voice tool
    (both mouths — the Realtime orb dispatches here; the text tool loop
    resolves the same body via tools.green_read_payload).

    Rotates the hole's stored green-slope aspect into the player's own
    tee->green approach frame (app.caddie.green_geometry) — never a compass
    word the model would have to translate itself. Honest degradation per
    [[no-fake-data-fallbacks]]: available:false when no slope is mapped for
    the hole, or when the tee position (and so the approach bearing) isn't
    known. Body lives in app/caddie/tools.py, shared with the text tool loop.
    """
    session = await get_owned_session(request.round_id, user_id)
    return caddie_tools.green_read_payload(session, hole_number=request.hole_number)


# ── Shared conversation ledger append (voice mouth → caddie_messages) ──


_MESSAGE_MAX_CHARS = 4000


class AppendSessionMessageRequest(BaseModel):
    """A voice turn (pair) to append to the round's shared message ledger.

    Roles are fixed by field name — the client cannot write arbitrary roles
    (e.g. 'system') into the history that later renders into LLM prompts.
    """
    round_id: str
    user_content: Optional[str] = None
    assistant_content: Optional[str] = None
    hole_number: Optional[int] = None


@router.post("/session/message")
async def append_session_message(
    request: AppendSessionMessageRequest,
    user_id: str = Depends(current_user_id),
):
    """Append a Realtime voice turn to caddie_messages so the text mouth
    (/session/voice, Claude) shares one conversation history with the orb.

    Caller must own the round. A full pair appends atomically (either both
    rows or neither); a lone side (e.g. the caddie greeted first) appends one.
    """
    user_text = (request.user_content or "").strip()
    assistant_text = (request.assistant_content or "").strip()
    if not user_text and not assistant_text:
        raise HTTPException(422, "At least one of user_content / assistant_content is required")
    if len(user_text) > _MESSAGE_MAX_CHARS or len(assistant_text) > _MESSAGE_MAX_CHARS:
        raise HTTPException(422, f"Message content exceeds {_MESSAGE_MAX_CHARS} characters")

    await get_owned_session(request.round_id, user_id)

    if user_text and assistant_text:
        await sessions.append_message_pair(
            request.round_id,
            user_content=user_text,
            assistant_content=assistant_text,
            hole_number=request.hole_number,
        )
        appended = 2
    else:
        await sessions.append_message(
            request.round_id,
            role="user" if user_text else "assistant",
            content=user_text or assistant_text,
            hole_number=request.hole_number,
        )
        appended = 1

    return {"status": "recorded", "appended": appended}


# ── Session-aware recommendation ──


@router.post("/session/recommend")
async def session_recommend(request: SessionRecommendRequest, user_id: str = Depends(caddie_rate_limited_user)):
    """Get a recommendation using cached session state (weather, intel, stats, history).

    Caller must own the round. Body lives in app/caddie/tools.py, shared with
    the text tool loop (parity by construction).
    """
    session = await get_owned_session(request.round_id, user_id)
    return await caddie_tools.recommend_payload(
        session,
        request.round_id,
        request.hole_number,
        distance_yards=request.distance_yards,
        par=request.par,
        yards=request.yards,
        shot_bearing=request.shot_bearing,
        competition_legal=request.competition_legal,
    )


# ── Session-aware voice ──


async def _build_session_voice_prompt(
    request: SessionVoiceRequest, user_id: str,
) -> tuple[list[dict], list[dict], str]:
    """Assemble the session-aware system prompt + messages for /session/voice
    AND its streaming twin — the one place this context logic lives, so the
    two mouths can't drift (audit #6). Runs ownership + persona-visibility
    gates and all session-state reads; the caller does the ANTHROPIC_API_KEY
    check separately (before this, so a missing key never touches DB reads).

    Caller must own the round (enforced here via get_owned_session — 404s).
    Returns (system_blocks, messages, persona_id). `system_blocks` is a
    two-block Anthropic `system` content list — a STABLE, per-round-stable
    prefix (persona + memory + instructions + hazard rule) carrying a prompt-
    cache breakpoint, followed by the VOLATILE per-hole CURRENT SITUATION
    block with no breakpoint (specs/caddie-prompt-caching-text-path-plan.md).
    Conversation history renders after both, in `messages` — not cached by
    this item, by design (see plan §1).
    """
    session = await get_owned_session(request.round_id, user_id)

    # Visibility gate: never load another user's private persona prompt —
    # invisible/unknown ids fall back to classic (calm, not a 404 mid-round).
    persona_id = (
        request.personality_id
        if await personality_visible(request.personality_id, user_id)
        else "classic"
    )
    personality = await load_personality(persona_id)
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
        if hole_intel.yards is not None:
            line = f"Par {hole_intel.par}, {hole_intel.yards} yards (effective: {hole_intel.effective_yards})"
            # Spell the elevation out so the caddie factors uphill/downhill
            # into advice (owner ask) — a bare 'effective' number gets ignored.
            elev = hole_intel.elevation_change_ft
            if elev and abs(elev) >= 5:
                direction = "uphill" if elev > 0 else "downhill"
                line += f" — plays {direction} {abs(round(elev))}ft, treat it as {hole_intel.effective_yards}"
            context_parts.append(line)
        else:
            context_parts.append(f"Par {hole_intel.par}")
        if hole_intel.hazards:
            hazards_line = format_hazards_line(request.hole_number, hole_intel.hazards)
            if hazards_line:
                context_parts.append(hazards_line)
        bend_line = format_bend_line(request.hole_number, hole_intel.bend)
        if bend_line:
            context_parts.append(bend_line)
        guide_line = format_guide_line(hole_intel.strategy_guide)
        if guide_line:
            context_parts.append(guide_line)
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

    # BLOCK 0 — STABLE (persona + memory + instructions + hazard rule):
    # per-round-stable, carries the prompt-cache breakpoint.
    memory_section = f"\n--- PLAYER MEMORY ---\n{memories_block}\n" if memories_block else ""
    stable_text = f"""{personality.system_prompt}
{memory_section}
--- INSTRUCTIONS ---
You are caddying for this golfer right now, on the course. Respond to their question or comment.
Your reply is SPOKEN ALOUD on the course: keep it to 2-3 short sentences max unless they ask for
more detail. Plain speech only — never use markdown, asterisks, bullet lists, headings, or emoji.
One clear recommendation beats a pep talk. If they ask about club selection, aim, or strategy,
use the CURRENT SITUATION section to give specific, actionable advice — and when the hole context shows an
uphill/downhill change or a plays-like distance, factor it in and SAY it briefly ("plays more
like 195 with the climb"). Any "Local knowledge" line is written for golfers in general — filter
it through THIS player's real distances before repeating it: a hazard beyond their reach off the
tee is irrelevant (don't mention it); talk about what's in play at THEIR landing zone. A 300-yard
driver doesn't care about a bunker at 370. If they're just chatting, be personable but keep it
golf-focused. Never break character.
You have memory of the entire round conversation and prior rounds. Reference earlier holes/shots
or known tendencies when relevant.

{HAZARD_GROUNDING_RULE}
{BEND_GROUNDING_RULE}
{PHYSICS_GROUNDING_RULE}
{GREEN_GROUNDING_RULE}
{TOOL_USE_RULE}
{INPUT_GROUNDING_RULE}
{OBSERVED_REALITY_RULE}"""

    # BLOCK 1 — VOLATILE (per-hole CURRENT SITUATION): no cache_control.
    volatile_text = f"--- CURRENT SITUATION ---\n{context}"

    system_blocks: list[dict] = [
        {"type": "text", "text": stable_text, "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": volatile_text},
    ]

    return system_blocks, messages, persona_id


@router.post("/session/voice", response_model=VoiceCaddieResponse)
async def session_voice(request: SessionVoiceRequest, user_id: str = Depends(caddie_rate_limited_user)):
    """Voice caddie using session state — remembers entire round conversation.

    Caller must own the round.
    """
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(500, "ANTHROPIC_API_KEY not configured")

    system_blocks, messages, persona_id = await _build_session_voice_prompt(request, user_id)
    # The tool loop resolves against the live session (same object the orb's
    # HTTP tool endpoints read) — ownership already enforced by the builder.
    session = await get_owned_session(request.round_id, user_id)
    ctx = caddie_tools.ToolContext(
        session=session, round_id=request.round_id,
        user_id=user_id, default_hole=request.hole_number,
    )

    try:
        client = anthropic.AsyncAnthropic(
            api_key=api_key, timeout=_CADDIE_TIMEOUT_S, max_retries=_CADDIE_MAX_RETRIES,
        )
        model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-5-20250929")
        response_text = ""
        async for kind, payload in run_caddie_turn(
            client, model, system_blocks, messages, ctx,
            on_usage=lambda usage, call_n: _log_caddie_usage(
                usage, context="session_voice", persona_id=persona_id, call_index=call_n,
            ),
        ):
            # token/status frames are streaming-only concerns — the JSON mouth
            # keeps just the final assembled text.
            if kind == "done":
                response_text = payload
        response_text = response_text or "Say that once more? I want to get this right."

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
    except HTTPException:
        raise
    except Exception:
        log.exception("session_voice failed")  # traceback to the journal
        raise HTTPException(500, _CADDIE_ERROR_DETAIL)


# ── Shared SSE generator (session + stateless streaming twins) ──


async def _sse_reply(
    api_key: str,
    system: list[dict],
    messages: list[dict],
    *,
    log_context: str,
    round_id: Optional[str] = None,
    transcript: Optional[str] = None,
    hole_number: Optional[int] = None,
    persona_id: Optional[str] = None,
    ctx: Optional[caddie_tools.ToolContext] = None,
) -> AsyncIterator[str]:
    """Stream a Claude reply as SSE frames — the async twin of the tool-loop
    consumption in session_voice/voice_caddie, with IDENTICAL params (model,
    max_tokens, temperature, tools). Runs only AFTER the caller has done all
    auth/gate/prompt-assembly work and committed the 200 OK + streaming
    headers, so nothing here can turn into a JSON error response — failures
    become `event: error` frames instead.

    `system` accepts either a bare string or the two-block prompt-cache list
    built by `_build_session_voice_prompt` / `_build_voice_prompt` — the SDK
    forwards both forms unchanged. `ctx` is the tool-resolution context; None
    (or a session-less ctx) means every tool answers honestly that no live
    round data is available (the stateless mouth).

    Framing (internal contract, not a shared model — see
    specs/voice-streaming-replies-plan.md §1):
        event: token\\ndata: <json-encoded delta>\\n\\n   # zero or more
        event: status\\ndata: <json-encoded label>\\n\\n  # zero or more (tool rounds; watchdog keepalive)
        event: done\\ndata: {}\\n\\n                       # exactly one on success
        event: error\\ndata: <calm copy>\\n\\n              # exactly one on failure

    Persistence (session flavor only, round_id is not None): the FULL
    assembled text is persisted exactly once, at the very end, gated on
    `completed`. A client disconnect or a mid-stream Anthropic error means
    `completed` never flips True, so nothing persists — an abandoned or
    truncated turn is dropped from history entirely rather than wedging a
    partial reply into the round's conversation ledger. Tool blocks are never
    persisted — `caddie_messages` stays a plain role/content ledger.
    """
    client = anthropic.AsyncAnthropic(
        api_key=api_key, timeout=_CADDIE_TIMEOUT_S, max_retries=_CADDIE_MAX_RETRIES,
    )
    model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-5-20250929")
    tool_ctx = ctx or caddie_tools.ToolContext(
        session=None, round_id=None, user_id="", default_hole=hole_number,
    )
    parts: list[str] = []
    completed = False
    try:
        async for kind, payload in run_caddie_turn(
            client, model, system, messages, tool_ctx,
            on_usage=lambda usage, call_n: _log_caddie_usage(
                usage, context=log_context, persona_id=persona_id, call_index=call_n,
            ),
        ):
            if kind == "token":
                parts.append(payload)
                yield f"event: token\ndata: {json.dumps(payload)}\n\n"
            elif kind == "status":
                # Keepalive between tool rounds — the client re-arms its
                # watchdog so a legitimate tool turn isn't aborted as dead air.
                yield f"event: status\ndata: {json.dumps(payload)}\n\n"
        completed = True
    except anthropic.AuthenticationError:
        log.exception(f"{log_context} auth failed")
        yield f"event: error\ndata: {json.dumps(_CADDIE_ERROR_DETAIL)}\n\n"
        return
    except Exception:
        log.exception(f"{log_context} failed")  # traceback to the journal, never to the client
        yield f"event: error\ndata: {json.dumps(_CADDIE_ERROR_DETAIL)}\n\n"
        return

    # Empty-content guard preserved — mirrors `_first_text(...) or "Say that
    # once more?"` in the non-streaming twins.
    full = "".join(parts) or "Say that once more? I want to get this right."
    if round_id is not None and completed:
        # Atomic dual append — either both turns persist or neither.
        await sessions.append_message_pair(
            round_id,
            user_content=transcript,
            assistant_content=full,
            hole_number=hole_number,
        )
    yield "event: done\ndata: {}\n\n"


@router.post("/session/voice/stream")
async def session_voice_stream(request: SessionVoiceRequest, user_id: str = Depends(caddie_rate_limited_user)):
    """Streaming twin of /session/voice — same auth/gates/prompt assembly,
    a token-by-token SSE reply instead of one JSON blob (specs/voice-streaming-replies-plan.md).

    ALL gate + context work (ownership, persona visibility, prompt assembly)
    runs here, BEFORE the StreamingResponse is constructed — so any failure
    (missing API key, round not owned, etc.) is still a normal JSON
    HTTPException with headers not yet sent, identical to /session/voice.
    Only the Anthropic call itself runs inside the generator, after 200 OK.
    """
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(500, "ANTHROPIC_API_KEY not configured")

    system_blocks, messages, persona_id = await _build_session_voice_prompt(request, user_id)
    # Tool-resolution context — same live session the orb's HTTP tool
    # endpoints read (ownership already enforced by the builder above).
    session = await get_owned_session(request.round_id, user_id)
    ctx = caddie_tools.ToolContext(
        session=session, round_id=request.round_id,
        user_id=user_id, default_hole=request.hole_number,
    )

    return StreamingResponse(
        _sse_reply(
            api_key,
            system_blocks,
            messages,
            log_context="session_voice_stream",
            round_id=request.round_id,
            transcript=request.transcript,
            hole_number=request.hole_number,
            persona_id=persona_id,
            ctx=ctx,
        ),
        media_type="text/event-stream",
    )


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


# ── Player profile (what the caddie knows about you) ──


class CaddieProfileResponse(BaseModel):
    """Read-only surface of player_profiles. Learned club distances land in P4."""
    handicap: Optional[float] = None
    preferred_personality_id: str = DEFAULT_PERSONALITY_ID
    rounds_analyzed: int = 0
    miss_direction: Optional[str] = None
    miss_short_pct: Optional[float] = None
    three_putts_per_round: Optional[float] = None
    par5_bogey_rate: Optional[float] = None


class CaddieProfileUpdate(BaseModel):
    """The only writable field for now — persona preference."""
    preferred_personality_id: str


def _profile_response(profile: Optional[PlayerProfile]) -> CaddieProfileResponse:
    if profile is None:
        return CaddieProfileResponse()
    return CaddieProfileResponse(
        handicap=float(profile.handicap) if profile.handicap is not None else None,
        preferred_personality_id=profile.preferred_personality_id or DEFAULT_PERSONALITY_ID,
        rounds_analyzed=profile.rounds_analyzed or 0,
        miss_direction=profile.miss_direction,
        miss_short_pct=float(profile.miss_short_pct) if profile.miss_short_pct is not None else None,
        three_putts_per_round=(
            float(profile.three_putts_per_round) if profile.three_putts_per_round is not None else None
        ),
        par5_bogey_rate=float(profile.par5_bogey_rate) if profile.par5_bogey_rate is not None else None,
    )


@router.get("/profile", response_model=CaddieProfileResponse)
async def get_caddie_profile(user_id: str = Depends(current_user_id)):
    """What the caddie knows about the calling player. Defaults when no row yet."""
    profile = await memory_mod.get_player_profile(user_id)
    return _profile_response(profile)


@router.put("/profile", response_model=CaddieProfileResponse)
async def update_caddie_profile(
    request: CaddieProfileUpdate,
    user_id: str = Depends(current_user_id),
):
    """Persist the player's preferred caddie persona (owner-scoped upsert).

    404s on personas that don't exist or aren't visible to the caller, so a
    typo can't silently fall back to 'classic' at prompt-build time.
    """
    if not await personality_visible(request.preferred_personality_id, user_id):
        raise HTTPException(404, "Persona not found")

    async with async_session() as db:
        stmt = pg_insert(PlayerProfile).values(
            user_id=user_id,
            preferred_personality_id=request.preferred_personality_id,
        ).on_conflict_do_update(
            index_elements=["user_id"],
            set_={"preferred_personality_id": request.preferred_personality_id},
        )
        await db.execute(stmt)
        await db.commit()

    profile = await memory_mod.get_player_profile(user_id)
    return _profile_response(profile)


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
    user_id: str = Depends(caddie_rate_limited_user),
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

    # Resolve the owned session once (used both for the stored-course hazard
    # lookup below and the cache write at the end).
    owned_session = None
    if round_id and user_id:
        candidate = await sessions.get(round_id)
        if candidate and candidate.user_id == user_id:
            owned_session = candidate

    # Curated per-hole bunker/water geometry from our own PostGIS store, keyed
    # by hole number, when this round is mapped to a stored course. REPLACES
    # (never merges with) the fuzzy Overpass-derived hazards below — curated
    # data must not be polluted by Overpass strays (owner escalation 2026-07-06).
    stored_holes_by_number: dict[int, dict] = {}
    if owned_session is not None and owned_session.course_id:
        stored_course = await courses_mapped.get_course(owned_session.course_id)
        if stored_course:
            stored_holes_by_number = {h["number"]: h for h in stored_course.get("holes", [])}

    holes: list[dict] = []
    hole_intel_map: dict[int, HoleIntelligence] = {}
    for hc in request.hole_coordinates:
        try:
            stored_hole = stored_holes_by_number.get(hc.get("holeNumber"))
            persisted_elev = _green_persisted_elevation(stored_hole)
            persisted_guide = _green_persisted_guide(stored_hole)

            intel = await build_hole_intelligence(
                hole_coords=hc,
                par=hc.get("par"),
                yards=hc.get("yards"),
                handicap_rating=hc.get("handicap"),
                persisted_elevation=persisted_elev,
                course_id=owned_session.course_id if owned_session else None,
                persisted_guide=persisted_guide,
            )
            stored_hole = stored_holes_by_number.get(intel.hole_number)
            if stored_hole is not None:
                stored_features = stored_hole.get("features")
                if stored_features and stored_features.get("features"):
                    intel.hazards = extract_hole_hazards(
                        stored_features,
                        tee=hc.get("tee"),
                        green=hc.get("green"),
                    )
                    intel.bend = extract_hole_bend(
                        stored_features,
                        tee=hc.get("tee"),
                        green=hc.get("green"),
                    )
            holes.append(intel.model_dump())
            hole_intel_map[intel.hole_number] = intel
        except Exception as e:
            # Visible, never silent: a per-hole failure hides ALL intel for
            # that hole (the all-zero-elevation incident, 2026-07-07).
            log.exception("course-intel failed for hole %s", hc.get("holeNumber"))
            holes.append({"hole_number": hc.get("holeNumber", 0), "error": str(e)})

    # Cache everything in session — only when caller owns the round.
    if owned_session is not None:
        await sessions.set_hole_intel(round_id, hole_intel_map, weather=weather)

    return {
        "weather": weather.model_dump(),
        "holes": holes,
        "conditions": weather.conditions,
    }


@router.post("/recommend")
async def get_recommendation(
    request: RecommendationRequest,
    user_id: str = Depends(caddie_rate_limited_user),
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
        competition_legal=request.competition_legal,
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


async def _build_voice_prompt(
    request: VoiceCaddieRequest, user_id: str,
) -> tuple[list[dict], list[dict], str]:
    """Assemble the stateless system prompt + messages for /voice AND its
    streaming twin — mirrors _build_session_voice_prompt so the two mouths
    stay identical (audit #6). Runs the persona-visibility gate; the caller
    does the ANTHROPIC_API_KEY check separately. Returns
    (system_blocks, messages, persona_id) — see _build_session_voice_prompt
    for the two-block prompt-cache shape.
    """
    # Same visibility gate as session_voice — private personas stay private.
    persona_id = (
        request.personality_id
        if await personality_visible(request.personality_id, user_id)
        else "classic"
    )
    personality = await load_personality(persona_id)

    # Personal grounding — mirror _build_session_voice_prompt so the orb's
    # off-course answers (and the stateless in-round fallback) carry the same
    # cross-round memory + handicap the session caddie has. Defensive: a DB
    # hiccup here must never break the voice reply — degrade to no grounding.
    memories_block = ""
    profile = None
    try:
        memories = await memory_mod.get_top_memories(user_id)
        memories_block = memory_mod.render_memories_for_prompt(memories)
        profile = await memory_mod.get_player_profile(user_id)
    except Exception:
        log.exception("voice grounding fetch failed; continuing without it")
        memories_block = ""
        profile = None

    # hole_number None = off-course general chat (the Looper orb outside a
    # round): no hole context line — the caddie must not pretend to be on one.
    context_parts = (
        [f"Current hole: #{request.hole_number}, Par {request.par}, {request.yards} yards"]
        if request.hole_number is not None
        else ["Off-course chat — the player is not currently on a hole."]
    )
    if request.distance_yards:
        context_parts.append(f"Distance to pin: {request.distance_yards} yards")
    if request.wind_speed_mph > 0:
        context_parts.append(f"Wind: {request.wind_speed_mph} mph from {request.wind_direction}°")
    effective_handicap = request.handicap
    if effective_handicap is None and profile is not None and profile.handicap is not None:
        effective_handicap = float(profile.handicap)
    if effective_handicap is not None:
        context_parts.append(f"Player handicap: {effective_handicap}")

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

    # BLOCK 0 — STABLE (persona + memory + instructions + hazard rule):
    # per-round-stable, carries the prompt-cache breakpoint.
    memory_section = f"\n--- PLAYER MEMORY ---\n{memories_block}\n" if memories_block else ""
    stable_text = f"""{personality.system_prompt}
{memory_section}
--- INSTRUCTIONS ---
You are caddying for this golfer right now, on the course. Respond to their question or comment.
Your reply is SPOKEN ALOUD on the course: keep it to 2-3 short sentences max unless they ask for
more detail. Plain speech only — never use markdown, asterisks, bullet lists, headings, or emoji.
One clear recommendation beats a pep talk. If they ask about club selection, aim, or strategy,
use the CURRENT SITUATION section to give specific, actionable advice — and when the hole context shows an
uphill/downhill change or a plays-like distance, factor it in and SAY it briefly ("plays more
like 195 with the climb"). Any "Local knowledge" line is written for golfers in general — filter
it through THIS player's real distances before repeating it: a hazard beyond their reach off the
tee is irrelevant (don't mention it); talk about what's in play at THEIR landing zone. A 300-yard
driver doesn't care about a bunker at 370. If they're just chatting, be personable but keep it
golf-focused. Never break character.

{HAZARD_GROUNDING_RULE}
{BEND_GROUNDING_RULE}
{PHYSICS_GROUNDING_RULE}
{GREEN_GROUNDING_RULE}
{TOOL_USE_RULE}
{INPUT_GROUNDING_RULE}
{OBSERVED_REALITY_RULE}"""

    # BLOCK 1 — VOLATILE (per-hole CURRENT SITUATION): no cache_control.
    volatile_text = f"--- CURRENT SITUATION ---\n{context}"

    system_blocks: list[dict] = [
        {"type": "text", "text": stable_text, "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": volatile_text},
    ]

    return system_blocks, messages, persona_id


@router.post("/voice", response_model=VoiceCaddieResponse)
async def voice_caddie(
    request: VoiceCaddieRequest,
    user_id: str = Depends(caddie_rate_limited_user),
):
    """Stateless voice caddie (use /session/voice for session-aware).

    Auth required — Anthropic spend is metered against our project keys.
    Carries the same TEXT_TOOLS schema as the session mouth (parity), but a
    session-less ToolContext — every tool resolution answers honestly that no
    live round data is available, so the model says so instead of guessing."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(500, "ANTHROPIC_API_KEY not configured")

    system_blocks, messages, persona_id = await _build_voice_prompt(request, user_id)
    ctx = caddie_tools.ToolContext(
        session=None, round_id=None, user_id=user_id, default_hole=request.hole_number,
    )

    try:
        client = anthropic.AsyncAnthropic(
            api_key=api_key, timeout=_CADDIE_TIMEOUT_S, max_retries=_CADDIE_MAX_RETRIES,
        )
        model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-5-20250929")
        response_text = ""
        async for kind, payload in run_caddie_turn(
            client, model, system_blocks, messages, ctx,
            on_usage=lambda usage, call_n: _log_caddie_usage(
                usage, context="voice_caddie", persona_id=persona_id, call_index=call_n,
            ),
        ):
            if kind == "done":
                response_text = payload
        response_text = response_text or "Say that once more? I want to get this right."
        return VoiceCaddieResponse(response=response_text)
    except anthropic.AuthenticationError:
        raise HTTPException(401, "Invalid API key")
    except HTTPException:
        raise
    except Exception:
        log.exception("voice_caddie failed")
        raise HTTPException(500, _CADDIE_ERROR_DETAIL)


@router.post("/voice/stream")
async def voice_caddie_stream(
    request: VoiceCaddieRequest,
    user_id: str = Depends(caddie_rate_limited_user),
):
    """Streaming twin of /voice (stateless) — same gate + prompt assembly,
    a token-by-token SSE reply instead of one JSON blob
    (specs/voice-streaming-replies-plan.md). No round_id, so nothing is
    persisted — the stateless path has never kept server-side history.
    """
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(500, "ANTHROPIC_API_KEY not configured")

    system_blocks, messages, persona_id = await _build_voice_prompt(request, user_id)
    # Session-less tool context (parity): tools are offered, and every
    # resolution answers honestly that no live round data is available.
    ctx = caddie_tools.ToolContext(
        session=None, round_id=None, user_id=user_id, default_hole=request.hole_number,
    )

    return StreamingResponse(
        _sse_reply(
            api_key, system_blocks, messages,
            log_context="voice_caddie_stream", persona_id=persona_id, ctx=ctx,
        ),
        media_type="text/event-stream",
    )
