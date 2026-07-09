"""Canonical caddie tool registry + shared server-side resolution.

ONE source of truth for the six caddie tools (specs/caddie-tool-loop-parity-plan.md
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

from app.caddie.aim_point import generate_recommendation
from app.caddie.club_selection import CLUB_DISPLAY_NAMES
from app.caddie.hazards import format_hazards_line
from app.caddie.session import RoundSession, ShotRecord, sessions
from app.caddie.types import HoleIntelligence
from app.caddie import memory as memory_mod
from app.db.engine import async_session
from app.db.models import Shot


# ── Canonical registry (order-stable: sorted by name; byte-stable at import) ──

CADDIE_TOOLS: list[dict] = [
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
            "a hazard, or a yardage to one, that isn't in the returned list."
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
            "Always call this before suggesting a club, distance, or aim line."
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
    yards: int = 400,
    shot_bearing: Optional[float] = None,
    competition_legal: bool = False,
) -> dict:
    """DECADE recommendation from cached session state — lifted verbatim from
    the ``/session/recommend`` route body. Persists via the targeted
    ``sessions.set_recommendation`` write (never a whole-row update)."""
    session.current_hole = hole_number

    hole_intel = session.hole_intel.get(hole_number)
    if hole_intel is None:
        hole_intel = HoleIntelligence(
            hole_number=hole_number,
            par=par,
            yards=yards,
            effective_yards=yards,
        )

    distance = distance_yards or yards
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

    return {
        "round_id": session.round_id,
        "hole_number": hn,
        "weather": session.weather.model_dump() if session.weather else None,
        "plays_like": plays_like,
        "hazards": hazards_payload,
        "hazards_line": hazards_line,
        "green_slope": green_slope,
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
        "note": "No mapped bunkers or water in play on this hole." if not carries else None,
    }


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
        return await recommend_payload(
            session,
            round_id,
            hn,
            distance_yards=_as_int(args.get("distance_yards")),
            par=intel.par if intel is not None else 4,
            yards=(intel.yards if intel is not None and intel.yards else 400),
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

    # name == "get_carries" (the registry is closed — see _TOOL_NAMES gate)
    hn = _as_int(args.get("hole_number")) or ctx.default_hole
    if hn is None:
        return {"error": "get_carries requires hole_number"}
    return carries_payload(session, hn)
