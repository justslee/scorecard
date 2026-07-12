"""Canonical caddie tool registry + shared server-side resolution.

ONE source of truth for the caddie tools (specs/caddie-tool-loop-parity-plan.md
D1/D2), rendered two ways so the two mouths can never drift:

  - ``realtime_tools()``  → OpenAI Realtime shape
    ``{"type": "function", "name", "description", "parameters"}`` — consumed by
    ``app.services.realtime_relay.DEFAULT_TOOLS`` (the orb's mint payload).
  - ``anthropic_tools()`` → Anthropic shape ``{"name", "description",
    "input_schema"}`` — the module-level constant ``TEXT_TOOLS`` passed on every
    text-mouth model call (``app.caddie.tool_loop``).

The ``*_payload`` helpers below are the single implementation behind BOTH the
HTTP session endpoints in ``app.routes.caddie`` (the orb dispatches its tool
calls there from the browser) and the server-side text tool loop
(``resolve_tool``) — parity by construction, not by convention.

Prompt-cache guard (plan D7): ``CADDIE_TOOLS``/``TEXT_TOOLS`` are module-level
constants, sorted by name, and NEVER vary per request or mid-round — no
conditional tools. An unmapped course answers honestly through the resolver
(``available: false``), it does not drop ``get_carries`` from the schema.

Import direction: this module imports only ``app.caddie.*`` and ``app.db.*`` —
no route imports, no cycle.
"""

import time
from dataclasses import dataclass
from typing import Optional

from sqlalchemy import select, func as sqlfunc

from app.caddie import physics
from app.caddie.aim_point import generate_recommendation
from app.caddie.club_selection import CLUB_DISPLAY_NAMES, physics_plays_like
from app.caddie.green_geometry import green_read
from app.caddie.hazards import format_hazards_line
from app.caddie.session import RoundSession, ShotRecord, sessions
from app.caddie.types import HoleIntelligence
from app.caddie import memory as memory_mod
from app.db.engine import async_session
from app.db.models import Shot


# ── Canonical registry (order-stable: sorted by name; byte-stable at import) ──

CADDIE_TOOLS: list[dict] = [
    {
        "name": "get_bend",
        "description": (
            "Where and how far the fairway bends (the dogleg) on a hole, measured from "
            "the tee along the hole's mapped centerline. Call this when the player asks "
            "about the bend, corner, or dogleg. If it returns straight:true, the hole has "
            "no significant bend — say it plays straight. If available:false the hole's "
            "centerline isn't mapped — say you don't know the shape and NEVER invent a "
            "dogleg or a distance to one."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "hole_number": {
                    "type": "integer",
                    "description": "Hole to evaluate (1-18). Omit for the current hole.",
                },
            },
        },
    },
    {
        "name": "get_carries",
        "description": (
            "Carry distances needed to clear bunkers/water off the tee. If it "
            "returns available:false the course isn't mapped — say you don't "
            "have carries here and NEVER invent a carry number."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "hole_number": {"type": "integer", "description": "Hole the player is on (1-18)"},
            },
            "required": ["hole_number"],
        },
    },
    {
        "name": "get_conditions",
        "description": (
            "Current weather (wind, temperature) plus how the hole plays — the "
            "plays-like yardage delta from elevation. Also returns the hole's real "
            "bunker/water hazards (empty list if none are mapped) and the green's slope "
            "description, when mapped. Always call this before discussing wind, "
            "temperature, effective distance, green break, or any hazard — never name "
            "a hazard, or a yardage to one, that isn't in the returned list. For a "
            "SPECIFIC shot's numbers (what a club carries/totals here, or what a "
            "target distance plays like), call get_shot_distance instead — this "
            "tool's plays_like block is the hole-level elevation view only."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "hole_number": {
                    "type": "integer",
                    "description": "Hole to evaluate (1-18). Omit for the current hole.",
                },
            },
        },
    },
    {
        "name": "get_green_read",
        "description": (
            "Which side of the green leaves the uphill putt, from the deterministic "
            "green-slope engine in the player's own left/right frame. ALWAYS call this "
            "before discussing green slope, break, high/low side, or where to leave an "
            "approach — never convert a compass slope direction to left/right yourself. "
            "If available:false, say the green isn't mapped for slope — never invent a read."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "hole_number": {
                    "type": "integer",
                    "description": "Hole to evaluate (1-18). Omit for the current hole.",
                },
            },
        },
    },
    {
        "name": "get_player_profile",
        "description": (
            "The player's handicap, club distances, and miss tendencies. "
            "Always call this before referencing the player's own numbers."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "get_recommendation",
        "description": (
            "Get a DECADE-style club + aim recommendation for the current shot. "
            "Always call this before suggesting a club, distance, or aim line. "
            "If the result has shot_kind 'positioning', the green is out of "
            "reach on this swing — give landing-zone advice and state the "
            "leave_yards; never a pin-relative aim. The result's "
            "tee_shot_numbers block is the only source of yardages for a tee "
            "shot — its numbers close exactly; speak them verbatim."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "hole_number": {"type": "integer", "description": "Hole the player is on (1-18)"},
                "distance_yards": {
                    "type": "integer",
                    "description": "Distance to the pin in yards. Omit if unknown — backend will default to hole yardage.",
                },
            },
            "required": ["hole_number"],
        },
    },
    {
        "name": "get_session_status",
        "description": "Return the current round's cached state — useful to check what's already known.",
        "input_schema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "get_shot_distance",
        "description": (
            "What ONE shot does under the current conditions, from the ball-flight "
            "physics engine anchored to the player's own club distances. Pass club "
            "(e.g. 'driver', '7iron') for that club's carry, roll, and total here; "
            "pass target_yards for what that distance plays like and the club that "
            "covers it; pass both for both. ALWAYS call this before speaking any "
            "carry, roll, total, or plays-like number for a specific shot — never "
            "compute distance adjustments yourself. If it returns available:false, "
            "say the number isn't available instead of estimating one."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "hole_number": {
                    "type": "integer",
                    "description": "Hole context for elevation/conditions (1-18). Omit for the current hole.",
                },
                "club": {
                    "type": "string",
                    "description": "Club to simulate, e.g. 'driver', '7iron', 'pw'. Provide club and/or target_yards.",
                },
                "target_yards": {
                    "type": "integer",
                    "description": "Target distance to solve plays-like for. Provide club and/or target_yards.",
                },
            },
        },
    },
    {
        "name": "record_shot",
        "description": (
            "Log a shot to the round history once the player has hit it. "
            "Use this when the player tells you what they hit and the result."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "hole_number": {"type": "integer"},
                "club": {"type": "string", "description": "Club used, e.g. '7iron', 'pw', 'driver'."},
                "distance_yards": {"type": "integer", "description": "Approx carry/total distance hit."},
                "result": {
                    "type": "string",
                    "description": "Where it ended up (fairway | rough | green | bunker | water | ob).",
                },
            },
            "required": ["hole_number", "club", "distance_yards"],
        },
    },
]


def realtime_tools() -> list[dict]:
    """OpenAI Realtime rendering — exactly the relay's historical DEFAULT_TOOLS
    shape: ``{"type": "function", "name", "description", "parameters"}``."""
    return [
        {
            "type": "function",
            "name": t["name"],
            "description": t["description"],
            "parameters": t["input_schema"],
        }
        for t in CADDIE_TOOLS
    ]


def anthropic_tools() -> list[dict]:
    """Anthropic rendering — passed as ``tools=`` on every text-mouth call."""
    return [
        {
            "name": t["name"],
            "description": t["description"],
            "input_schema": t["input_schema"],
        }
        for t in CADDIE_TOOLS
    ]


# Module-level constant (plan D7): the text mouths' tool list never mutates
# mid-round, so it stays inside the cached prompt prefix after the first call.
TEXT_TOOLS: list[dict] = anthropic_tools()


# ── Shared payload helpers (one implementation behind both mouths) ───────────


# A byte-identical shot arriving this soon after the previous one is treated
# as a client retry (network flake / duplicate tap), not a second real shot.
SHOT_RETRY_WINDOW_SECONDS = 30.0


async def recommend_payload(
    session: RoundSession,
    round_id: str,
    hole_number: int,
    distance_yards: Optional[int] = None,
    par: int = 4,
    yards: Optional[int] = None,
    shot_bearing: Optional[float] = None,
    competition_legal: bool = False,
    yardage_basis: Optional[str] = None,
) -> dict:
    """DECADE recommendation from cached session state — lifted verbatim from
    the ``/session/recommend`` route body. Persists via the targeted
    ``sessions.set_recommendation`` write (never a whole-row update).

    No-fake-data (specs/caddie-numbers-coherence-plan.md §2.1 — owner
    incident: the ``/session/recommend`` HTTP path the realtime orb dispatches
    through solved a 466y hole as the hardcoded ``yards=400`` default,
    producing the "leaves about 125" incident). Mirrors the text tool loop's
    ``resolve_tool`` ladder: the explicit ``distance_yards`` beats the
    caller-resolved ``yards`` beats the cached hole's own yardage — never a
    fabricated 400. All three absent is an honest error, not a solved guess.
    """
    session.current_hole = hole_number

    hole_intel = session.hole_intel.get(hole_number)
    if hole_intel is None:
        hole_intel = HoleIntelligence(
            hole_number=hole_number,
            par=par,
            yards=yards,
            effective_yards=yards,
        )

    distance = (
        distance_yards
        if distance_yards is not None
        else yards
        if yards is not None
        else (hole_intel.yards if hole_intel is not None else None)
    )
    if distance is None:
        return {
            "error": (
                "No distance known for this hole yet — ask the player how far they "
                "have, or call get_conditions first."
            ),
        }
    club_distances = session.club_distances or {}

    rec = generate_recommendation(
        hole=hole_intel,
        distance_yards=distance,
        club_distances=club_distances,
        handicap=session.handicap or 15.0,
        weather=session.weather,
        player_stats=session.player_stats,
        shot_bearing=shot_bearing or 0.0,
        competition_legal=competition_legal,
        yardage_basis=yardage_basis,
    )

    # Targeted update: only writes last_recommendation + current_hole, so a
    # concurrent /session/shot append doesn't get clobbered.
    await sessions.set_recommendation(round_id, rec, hole_number)
    return rec.model_dump()


async def record_shot_payload(
    session: RoundSession,
    round_id: str,
    user_id: str,
    hole_number: int,
    club: str,
    distance_yards: int,
    result: Optional[str] = None,
) -> dict:
    """Record a shot to the session history AND the durable ``shots`` table —
    lifted verbatim from the ``/session/shot`` route body (retry-window dedupe
    + best-effort durable dual-write)."""
    last = session.shot_history[-1] if session.shot_history else None
    if (
        last is not None
        and last.hole_number == hole_number
        and last.club == club
        and last.distance_yards == distance_yards
        and last.result == result
        and (time.time() - last.timestamp) < SHOT_RETRY_WINDOW_SECONDS
    ):
        return {
            "status": "recorded",
            "total_shots": len(session.shot_history),
            "duplicate": True,
        }

    shot = ShotRecord(
        hole_number=hole_number,
        club=club,
        distance_yards=distance_yards,
        result=result,
        timestamp=time.time(),
    )
    await sessions.append_shot(round_id, shot)

    # Durable dual-write. shot_number is assigned server-side as the next
    # index for (round_id, hole_number) — same contract as POST /api/shots.
    # Best-effort: the analytics write must never break in-round voice logging.
    try:
        async with async_session() as db:
            next_n = await db.execute(
                select(sqlfunc.coalesce(sqlfunc.max(Shot.shot_number), 0) + 1)
                .where(
                    Shot.round_id == round_id,
                    Shot.hole_number == hole_number,
                )
            )
            db.add(Shot(
                round_id=round_id,
                user_id=user_id,
                hole_number=hole_number,
                shot_number=int(next_n.scalar_one()),
                distance_yards=distance_yards,
                club=club,
                result=result,
            ))
            await db.commit()
    except Exception:
        # Session history still has the shot; learning just misses this one.
        pass

    return {"status": "recorded", "total_shots": len(session.shot_history) + 1}


def session_status_payload(session: RoundSession) -> dict:
    """Session status/cached-state read — pure; lifted from ``GET /session/{id}``."""
    return {
        "status": "active",
        "round_id": session.round_id,
        "current_hole": session.current_hole,
        "holes_with_intel": list(session.hole_intel.keys()),
        "has_weather": session.weather is not None,
        "shot_count": len(session.shot_history),
        "conversation_length": len(session.conversation_history),
        "last_recommendation": session.last_recommendation.model_dump() if session.last_recommendation else None,
        "recent_shots": [s.model_dump() for s in session.shot_history[-5:]],
    }


def conditions_payload(session: RoundSession, hole_number: Optional[int] = None) -> dict:
    """Deterministic conditions read — pure; lifted from ``/conditions``.

    Honest by design: holes without cached intel return plays_like=None /
    empty hazards rather than a guess — the model is instructed to never
    invent numbers a tool didn't return.
    """
    hn = hole_number or session.current_hole
    intel = session.hole_intel.get(hn)
    plays_like = None
    if intel is not None and intel.effective_yards:
        plays_like = {
            "yards": intel.yards,
            "effective_yards": intel.effective_yards,
            "plays_like_delta": intel.effective_yards - intel.yards,
            "elevation_change_ft": intel.elevation_change_ft,
        }

    # Real bunker/water hazards for the hole, honest by design: empty (not
    # invented) when the hole has none mapped. HAZARD_GROUNDING_RULE tells the
    # model never to name a hazard absent from this list.
    hazards_payload: list[dict] = []
    hazards_line = None
    if intel is not None and intel.hazards:
        hazards_payload = [h.model_dump() for h in intel.hazards]
        hazards_line = format_hazards_line(hn, intel.hazards)

    # Honest by design, same discipline as hazards: no slope data mapped for
    # this hole → None, never a guessed break.
    green_slope = None
    if intel is not None and intel.green_slope:
        green_slope = {"description": intel.green_slope.description}

    # Honest by design: unmapped centerline (bend=None) is distinct from a
    # measured-straight hole (bend.straight=True) — both are True facts, but
    # a different kind of "no bend" (see bend_payload).
    bend = intel.bend.model_dump() if intel is not None and intel.bend is not None else None

    return {
        "round_id": session.round_id,
        "hole_number": hn,
        "weather": session.weather.model_dump() if session.weather else None,
        "plays_like": plays_like,
        "hazards": hazards_payload,
        "hazards_line": hazards_line,
        "green_slope": green_slope,
        "bend": bend,
    }


def green_read_payload(session: RoundSession, hole_number: Optional[int] = None) -> dict:
    """Which side of the green leaves the uphill putt — pure; the
    ``get_green_read`` tool. Rotates the hole's stored green-slope aspect
    (``HoleIntelligence.green_slope.direction``, a downhill-toward compass
    bearing) into the player's own tee->green approach frame via
    ``app.caddie.green_geometry.green_read`` — never a compass word the model
    would have to translate itself.

    Honest degradation ([[no-fake-data-fallbacks]]), same discipline as
    ``carries_payload``/``shot_distance_payload``:
      - no cached intel for the hole -> available:false, reason.
      - intel present but no green_slope mapped -> available:false, reason.
      - green_slope mapped but no approach bearing (no tee coords) ->
        available:false, reason — the compass description may still be
        surfaced, clearly labeled, so the model has *something* honest to
        say, but never asked to translate it to a side itself.
    """
    hn = hole_number or session.current_hole
    base = {"round_id": session.round_id, "hole_number": hn}
    intel = session.hole_intel.get(hn)

    if intel is None or intel.green_slope is None:
        return {**base, "available": False, "reason": "No green slope mapped for this hole."}

    gs = intel.green_slope
    if intel.approach_bearing_deg is None:
        return {
            **base,
            "available": False,
            "reason": "Tee position unknown — can't orient the slope to your line.",
            "slope_compass": gs.description,
        }

    read = green_read(gs.direction, gs.percent_grade, gs.severity, intel.approach_bearing_deg)

    return {
        **base,
        "available": True,
        "fall_side": read.fall_side,
        "high_side": read.high_side,
        "uphill_leave_side": read.uphill_leave_side,
        "downhill_leave_side": read.downhill_leave_side,
        "uphill_leave_depth": read.uphill_leave_depth,
        "cross_grade_pct": read.cross_grade_pct,
        "along_grade_pct": read.along_grade_pct,
        "severity": read.severity,
        "confidence": read.confidence,
        "read_line": read.read_line,
        "slope_compass": gs.description,
        "approach_bearing_deg": intel.approach_bearing_deg,
        "assumptions": [
            "approach frame is tee-to-green (no live ball position); "
            "a mid-round shot from a different spot may read differently"
        ],
    }


async def player_profile_payload(session: RoundSession, user_id: str) -> dict:
    """Player numbers for the ``get_player_profile`` tool — lifted from
    ``/player-profile``. Effective club distances are the session's (entered)
    distances for now — P4 blends in learned distances."""
    profile = await memory_mod.get_player_profile(user_id)
    handicap = session.handicap
    if handicap is None and profile is not None and profile.handicap is not None:
        handicap = float(profile.handicap)
    tendencies = None
    if profile is not None:
        tendencies = {
            "miss_direction": profile.miss_direction,
            "miss_short_pct": float(profile.miss_short_pct) if profile.miss_short_pct is not None else None,
            "three_putts_per_round": (
                float(profile.three_putts_per_round) if profile.three_putts_per_round is not None else None
            ),
            "par5_bogey_rate": float(profile.par5_bogey_rate) if profile.par5_bogey_rate is not None else None,
        }
    return {
        "round_id": session.round_id,
        "handicap": handicap,
        "club_distances": {
            CLUB_DISPLAY_NAMES.get(k, k): v for k, v in session.club_distances.items() if v
        },
        "tendencies": tendencies,
        "rounds_analyzed": profile.rounds_analyzed if profile else 0,
    }


def carries_payload(session: RoundSession, hole_number: int) -> dict:
    """Real along-path carries for a hole (plan D3) — pure.

    Combines the hole's mapped hazards' along-path ``carry_yards`` (computed
    against the played ``golf=hole`` polyline at intel time — hazards.py) with
    the player's entered club distances. Honest empties, never fabricated
    ([[no-fake-data-fallbacks]]):

      - no hole_intel for the hole (course unmapped / intel not fetched)
        → ``available: false`` + reason;
      - intel present but no in-play hazards → ``available: true``,
        ``carries: []`` + an explicit note (a TRUE statement, distinct from
        "unknown");
      - ``carry_yards == 0`` entries (degenerate chord/polyline projection)
        are filtered out — a zero carry is placeholder noise, not a number
        to speak.
    """
    base = {"round_id": session.round_id, "hole_number": hole_number}
    intel = session.hole_intel.get(hole_number)
    if intel is None:
        return {**base, "available": False, "reason": "No mapped hazard data for this hole."}

    # Display-named club distances, longest first (so clubs_short_of_it leads
    # with the nearest miss). Never inferred: absent distances stay absent.
    club_yards: list[tuple[str, int]] = sorted(
        ((CLUB_DISPLAY_NAMES.get(k, k), v) for k, v in session.club_distances.items() if v),
        key=lambda kv: kv[1],
        reverse=True,
    )

    carries: list[dict] = []
    for hz in sorted(intel.hazards, key=lambda h: h.carry_yards):
        if hz.carry_yards <= 0:
            continue  # degenerate projection — placeholder noise, never spoken
        if club_yards:
            clubs_that_clear = [name for name, dist in club_yards if dist >= hz.carry_yards]
            clubs_short_of_it = [name for name, dist in club_yards if dist < hz.carry_yards][:3]
        else:
            clubs_that_clear = None
            clubs_short_of_it = None
        carries.append({
            "type": hz.type,
            "side": hz.line_side,
            "carry_yards": hz.carry_yards,
            "clubs_that_clear": clubs_that_clear,
            "clubs_short_of_it": clubs_short_of_it,
        })

    return {
        **base,
        "available": True,
        "carries": carries,
        "club_distances": dict(club_yards),
        "note": "No mapped bunkers, water, or tree lines in play on this hole." if not carries else None,
    }


def bend_payload(session: RoundSession, hole_number: Optional[int] = None) -> dict:
    """Where/how far the fairway bends for the `get_bend` tool — pure.

    Fields come verbatim from `HoleIntelligence.bend` (app/caddie/hazards.py::
    extract_hole_bend at intel time), never recomputed here. Honest matrix
    ([[no-fake-data-fallbacks]]) — unmapped centerline is a DIFFERENT fact
    than a measured-straight hole, never conflated:

      - no hole_intel for the hole → available:false + reason;
      - intel present but `bend is None` (centerline unmapped) →
        available:false + reason — distinct from "straight";
      - `bend.straight` → available:true, straight:true, a TRUE note (the
        `carries_payload` note pattern), direction/distance both None;
      - a real bend → available:true, straight:false, direction/
        distance_yards/deviation_yards/double_dogleg verbatim, plus the
        tee-anchored assumption (v1 has no GPS composition — §3).
    """
    hn = hole_number or session.current_hole
    base = {"round_id": session.round_id, "hole_number": hn}
    intel = session.hole_intel.get(hn)

    if intel is None:
        return {**base, "available": False, "reason": "No mapped course data for this hole."}
    if intel.bend is None:
        return {**base, "available": False, "reason": "Hole centerline not mapped — can't measure the bend."}

    bend = intel.bend
    if bend.straight:
        return {
            **base,
            "available": True,
            "straight": True,
            "direction": None,
            "distance_yards": None,
            "note": "No significant bend — this hole plays straight.",
        }

    return {
        **base,
        "available": True,
        "straight": False,
        "direction": bend.direction,
        "distance_yards": bend.distance_yards,
        "deviation_yards": bend.deviation_yards,
        "double_dogleg": bend.double_dogleg,
        "assumptions": [
            "distance measured from the tee along the hole centerline; from "
            "mid-hole the bend is closer than this"
        ],
    }


# Spoken/model club names → canonical CLUB_REFERENCE keys. Built from the
# display names ("7 Iron" → "7iron") plus the long wedge forms and N-letter
# shorthands the model actually says. Lookup lowercases and strips spaces/
# hyphens first, so "7 iron", "7-Iron", and "7iron" all resolve.
_CLUB_ALIASES: dict[str, str] = {
    **{display.lower().replace(" ", ""): key for key, display in CLUB_DISPLAY_NAMES.items()},
    "pitchingwedge": "pw",
    "gapwedge": "gw",
    "sandwedge": "sw",
    "lobwedge": "lw",
    **{f"{n}i": f"{n}iron" for n in range(4, 10)},
    "3w": "3wood",
    "5w": "5wood",
}


def _canonical_club(raw: str) -> Optional[str]:
    key = raw.strip().lower().replace(" ", "").replace("-", "")
    if key in physics.CLUB_REFERENCE:
        return key
    return _CLUB_ALIASES.get(key)


def shot_distance_payload(
    session: RoundSession,
    hole_number: Optional[int] = None,
    club: Optional[str] = None,
    target_yards: Optional[int] = None,
) -> dict:
    """One shot's physics numbers for the `get_shot_distance` tool — pure.

    The structural fix for the 2026-07-09 incident (the caddie told the owner
    a 300y drive with 4mph downwind and 38ft downhill "totals around 390"):
    the model had no tool that answers "what does MY shot do here", so it
    improvised arithmetic on the pin distance. This payload runs the real
    ball-flight engine (app/caddie/physics.py) against the session's live
    weather + the hole's elevation, anchored to the player's stored distances.

    Honest degradation ([[no-fake-data-fallbacks]]):
      - unknown/missing club distance → available:false + reason, never a
        tour-average stand-in for the PLAYER's number;
      - no cached weather → still air, surfaced in assumptions;
      - no hole intel → flat ground, surfaced in assumptions;
      - the shot's compass bearing is not known to the session → wind is
        still applied (a golfer asking "150 into 10mph" wants the wind in
        the number), resolved against an assumed due-north shot line, and
        that assumption is surfaced honestly rather than silently dropping
        a real, intended wind to still air.
    """
    hn = hole_number or session.current_hole
    base = {"round_id": session.round_id, "hole_number": hn}

    club_key: Optional[str] = None
    if club:
        club_key = _canonical_club(club)
        if club_key is None:
            return {**base, "available": False, "reason": f"Unknown club {club!r}."}

    assumptions: list[str] = []

    intel = session.hole_intel.get(hn)
    elevation_ft = float(intel.elevation_change_ft) if intel is not None else 0.0
    if intel is None:
        assumptions.append("no hole elevation data — treated the shot as flat")

    bearing = intel.approach_bearing_deg if intel is not None else None

    weather = session.weather
    has_wind = weather is not None and (weather.wind_speed_mph or 0) >= 1
    if weather is None:
        assumptions.append("no live weather cached — still air assumed")
    elif has_wind:
        if bearing is not None:
            # Server-side bearing parity ([[physics-tiles-coherence]]): the
            # session's own tee→green geometry resolves the wind vector —
            # the same bearing get_green_read uses — instead of guessing.
            assumptions.append("wind resolved along the hole (tee→green line)")
        else:
            # The session does not know the shot's compass bearing. A real,
            # intended wind must still count in the number — dropping it to
            # still air silently understates the shot (the same wrong-
            # direction class as the incident this tool was built to fix).
            # Resolve it against an assumed due-north shot line and say so,
            # rather than fabricating a false "no wind" answer.
            assumptions.append(
                "shot direction unknown — wind applied relative to due north"
            )

    wind_applied = has_wind

    stored = session.club_distances.get(club_key, 0) if club_key else 0
    carry_hint = float(stored or target_yards or 0) or None
    cond, cond_assumptions = physics.conditions_from_weather(
        weather, shot_bearing_deg=bearing if bearing is not None else 0.0,
        elevation_delta_ft=elevation_ft,
        carry_hint_yards=carry_hint,
    )
    assumptions.extend(cond_assumptions)

    payload: dict = {
        **base,
        "available": True,
        "mode": "both" if (club_key and target_yards) else ("club" if club_key else "target"),
        "club": club_key,
        "carry_yards": None,
        "roll_yards": None,
        "total_yards": None,
        "target_yards": target_yards,
        "plays_like_yards": None,
        "suggested_club": None,
        "breakdown": None,
        "conditions_used": {
            "weather_available": weather is not None,
            "temperature_f": weather.temperature_f if weather else None,
            "wind_speed_mph": weather.wind_speed_mph if weather else None,
            "wind_direction": weather.wind_direction if weather else None,
            "firmness": cond.firmness,
            "elevation_change_ft": elevation_ft,
            "air_density_kg_m3": round(cond.rho_kg_m3, 4),
            "shot_bearing_deg": bearing,
            "wind_applied": wind_applied,
        },
    }

    if club_key:
        if not stored or stored <= 0:
            return {
                **base,
                "available": False,
                "reason": (
                    f"No stored distance for {CLUB_DISPLAY_NAMES.get(club_key, club_key)} — "
                    "ask the player how far they hit it."
                ),
            }
        result = physics.shot_distance_for_club(club_key, float(stored), cond)
        payload.update(
            carry_yards=round(result.carry_yards),
            roll_yards=round(result.roll_yards),
            total_yards=round(result.total_yards),
            breakdown={
                "neutral_carry_yards": round(result.neutral_carry_yards),
                "apex_ft": round(result.apex_ft),
                "descent_deg": round(result.descent_deg, 1),
                "flight_time_s": round(result.flight_time_s, 1),
                "lateral_drift_yards": round(result.lateral_yards, 1),
            },
        )
        assumptions.extend(result.assumptions)

    if target_yards:
        known = {
            c: d for c, d in session.club_distances.items()
            if c in physics.CLUB_REFERENCE and d and d > 0
        }
        if not known:
            return {
                **base,
                "available": False,
                "reason": "No club distances on file — plays-like needs at least one.",
            }
        plays_like, suggested, pl_assumptions = physics_plays_like(
            float(target_yards), known, cond
        )
        payload.update(
            plays_like_yards=round(plays_like),
            suggested_club=suggested,
        )
        for a in pl_assumptions:
            if a not in assumptions:
                assumptions.append(a)

    payload["assumptions"] = assumptions
    return payload


# ── Server-side dispatcher (text tool loop) ──────────────────────────────────


@dataclass
class ToolContext:
    """What a tool resolution runs against. ``session is None`` = the
    stateless mouth (/voice) — every tool answers honestly that no live
    round data is available, instead of hallucinating it."""

    session: Optional[RoundSession]
    round_id: Optional[str]
    user_id: str
    default_hole: Optional[int] = None
    # This turn's resolved yardage (frontend lib/caddie/hole-yardage.ts —
    # GPS-to-green else the golfer's selected tee else honest None), stashed
    # by the route handler per request (specs/caddie-yardage-gps-selected-tee
    # -plan.md §2.4). `get_recommendation` reads this instead of the old fake
    # `intel.yards or 400` default when the model calls it without an
    # explicit distance.
    current_yardage: Optional[int] = None
    # Provenance of `current_yardage` — 'gps' | 'tee-card' | 'tee-geom' |
    # 'card' | None (specs/caddie-numbers-coherence-plan.md §2.2). Plumbed
    # into TeeShotNumbers.yardage_basis so the text mouth's tee-shot numbers
    # block labels its source the same way the realtime mouth does.
    current_yardage_basis: Optional[str] = None


_TOOL_NAMES = {t["name"] for t in CADDIE_TOOLS}

# Honest stateless answer — the model says it can't pull live numbers.
_NO_SESSION_PAYLOAD = {
    "available": False,
    "reason": "No active round session — live numbers unavailable.",
}


def _as_int(value) -> Optional[int]:
    """Best-effort int coercion for model-supplied args; None on junk."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


async def resolve_tool(name: str, args: dict, ctx: ToolContext) -> dict:
    """Resolve one tool call server-side — same semantics as the frontend
    ``dispatchTool`` switch (realtime.ts), because both funnel into the same
    ``*_payload`` helpers. Returns a plain dict; ``{"error": ...}`` marks a
    failed call (rendered as an ``is_error`` tool_result by the loop)."""
    if name not in _TOOL_NAMES:
        # Mirror the frontend's unknown-tool contract (realtime.ts).
        return {"error": f"Unknown tool: {name}"}
    if ctx.session is None or not ctx.round_id:
        return dict(_NO_SESSION_PAYLOAD)

    session, round_id = ctx.session, ctx.round_id
    args = args or {}

    if name == "get_recommendation":
        hn = _as_int(args.get("hole_number")) or ctx.default_hole
        if hn is None:
            return {"error": "get_recommendation requires hole_number"}
        intel = session.hole_intel.get(hn)
        explicit_distance = _as_int(args.get("distance_yards"))
        # No-fake-data (specs/caddie-yardage-gps-selected-tee-plan.md §2.4):
        # the request-carried resolved yardage (this turn's GPS/selected-tee
        # number, stashed on ctx by the route handler) beats cached
        # hole_intel.yards, which may be stale/mock-derived on an older
        # session — NEVER the old fake `400` default.
        resolved_yards = (
            explicit_distance
            if explicit_distance is not None
            else ctx.current_yardage
            if ctx.current_yardage is not None
            else (intel.yards if intel is not None else None)
        )
        if resolved_yards is None:
            return {
                "error": (
                    "No distance known for this hole yet — ask the player how far they "
                    "have, or call get_conditions first."
                ),
            }
        return await recommend_payload(
            session,
            round_id,
            hn,
            distance_yards=explicit_distance,
            par=intel.par if intel is not None else 4,
            yards=resolved_yards,
            yardage_basis=ctx.current_yardage_basis,
        )

    if name == "record_shot":
        hn = _as_int(args.get("hole_number")) or ctx.default_hole
        club = str(args.get("club") or "").strip()
        distance = _as_int(args.get("distance_yards"))
        if hn is None or not club or distance is None:
            return {"error": "record_shot requires hole_number, club, and distance_yards"}
        result = args.get("result")
        return await record_shot_payload(
            session, round_id, ctx.user_id, hn, club, distance,
            result=str(result) if result is not None else None,
        )

    if name == "get_session_status":
        return session_status_payload(session)

    if name == "get_conditions":
        return conditions_payload(session, _as_int(args.get("hole_number")))

    if name == "get_player_profile":
        return await player_profile_payload(session, ctx.user_id)

    if name == "get_shot_distance":
        club = args.get("club")
        target = _as_int(args.get("target_yards"))
        if not club and target is None:
            return {"error": "get_shot_distance requires club and/or target_yards"}
        return shot_distance_payload(
            session,
            hole_number=_as_int(args.get("hole_number")) or ctx.default_hole,
            club=str(club) if club else None,
            target_yards=target,
        )

    if name == "get_green_read":
        return green_read_payload(
            session, hole_number=_as_int(args.get("hole_number")) or ctx.default_hole
        )

    if name == "get_bend":
        return bend_payload(session, _as_int(args.get("hole_number")) or ctx.default_hole)

    # name == "get_carries" (the registry is closed — see _TOOL_NAMES gate)
    hn = _as_int(args.get("hole_number")) or ctx.default_hole
    if hn is None:
        return {"error": "get_carries requires hole_number"}
    return carries_payload(session, hn)
