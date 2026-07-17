"""ONE brain, every mouth — `run_strategy_turn` (specs/caddie-two-tier-
routing-plan.md §2).

Extracted verbatim from the original body of `routes/caddie.py::
session_strategy` so BOTH the realtime `get_strategy` HTTP endpoint
(`POST /session/strategy`) AND the text mouth's ADVICE-class interception
(`session_voice` / `session_voice/stream`) call the exact SAME
implementation — one cache key (`app.caddie.strategy.format_strategy_ground_
truth` bytes), therefore one answer, never two mouths disagreeing mid-round.

Import direction (load-bearing): this module imports only `app.caddie.*`
(`strategy`, `session`, `types`, `voice_prompts`) — NEVER `app.routes.*` — so
`routes/caddie.py::session_strategy` stays a thin wrapper (auth + Pydantic
in/out), not the other way around.
"""

from __future__ import annotations

import logging
from typing import Optional

from app.caddie import strategy as strategy_mod
from app.caddie.session import RoundSession
from app.caddie.types import TeeShotNumbers
from app.caddie.voice_prompts import format_tee_numbers_line

log = logging.getLogger("looper.caddie.strategy_turn")


async def run_strategy_turn(
    session: RoundSession,
    round_id: str,
    user_id: str,
    hole: int,
    *,
    distance_to_green_yards: Optional[int] = None,
    hole_yards: Optional[int] = None,
    yardage_basis: Optional[str] = None,
) -> dict:
    """Frontier-reasoned tee-to-green strategy — the ONE implementation
    behind BOTH the `get_strategy` realtime tool's `/session/strategy`
    endpoint and the text mouth's ADVICE-class interception.

    Assembles the same grounded engine payloads every other tool reads
    (app/caddie/tools.py, app/caddie/strategy.py), frames them as a
    deterministic GROUND TRUTH block (with the cached guide gated at read
    time against the engine's live verdict — strategy.py §5), and makes ONE
    OpenAI reasoning-model call to synthesize an ~80-word spoken strategy.
    The reply is fail-closed validated (hazard-type + side-flip + injection
    + length + the verdict pin — strategy.py §6) before it is ever returned;
    on any reject, API error, timeout, or missing key, this degrades to a
    deterministic engine-numbers line — never a fabricated strategy, never a
    mid-round crash, when a recommendation exists
    ([[no-fake-data-fallbacks]]).

    Returns a plain dict matching `SessionStrategyResponse`'s field shape
    (available/hole_number/strategy/degraded/reason/numbers) — the route
    wraps it in the Pydantic model; this module never imports routes.
    """
    payload = await strategy_mod.build_strategy_payload(
        session, round_id, user_id, hole,
        distance_to_green_yards=distance_to_green_yards,
        hole_yards=hole_yards,
        yardage_basis=yardage_basis,
    )

    rec = payload.get("recommendation") or {}
    conditions = payload.get("conditions") or {}
    carries = payload.get("carries") or {}
    green_read = payload.get("green_read") or {}

    numbers = {
        "tee_shot_numbers": rec.get("tee_shot_numbers"),
        "plays_like": conditions.get("plays_like"),
        "hazards_line": conditions.get("hazards_line"),
        "carries": [
            {"type": c.get("type"), "side": c.get("side"), "carry_yards": c.get("carry_yards")}
            for c in (carries.get("carries") or [])
        ],
        "green_read": {
            "uphill_leave_side": green_read.get("uphill_leave_side"),
            "available": bool(green_read.get("available", False)),
        },
    }

    if rec.get("error"):
        # No recommendation available at all (e.g. no yardage known yet) —
        # honest empty, same discipline as every other tool's unmapped-hole
        # answer. Never a fabricated strategy.
        return {
            "available": False, "hole_number": hole, "strategy": None,
            "degraded": False, "reason": rec["error"], "numbers": numbers,
        }

    def _degraded_line() -> str:
        """Deterministic line composed purely from engine data — the honest
        fallback on any reject/error/missing-key."""
        tee_numbers = rec.get("tee_shot_numbers")
        aim = (rec.get("aim_point") or {}).get("description") or "the center of the green"
        miss = (rec.get("miss_side") or {}).get("preferred") or "unknown"
        club = rec.get("club") or "unknown"
        if tee_numbers:
            line = (
                f"{club}. {format_tee_numbers_line(TeeShotNumbers.model_validate(tee_numbers))} "
                f"Aim: {aim}. Miss: {miss}."
            )
        else:
            line = f"{club}. Aim: {aim}. Miss: {miss}."
        gr_side = green_read.get("uphill_leave_side")
        if green_read.get("available") and gr_side:
            line += f" Green: the uphill putt leaves from the {gr_side}."
        return line

    model = strategy_mod._strategy_model()
    ground_truth = strategy_mod.format_strategy_ground_truth(payload)
    key = strategy_mod.cache_key(ground_truth, model)
    cached = strategy_mod.cache_lookup(key)
    if cached is not None:
        return {
            "available": True, "hole_number": hole, "strategy": cached["strategy"],
            "degraded": cached["degraded"], "reason": None, "numbers": numbers,
        }

    try:
        raw_text, _usage = await strategy_mod.synthesize_strategy(ground_truth, model=model)
        validated = strategy_mod.validate_strategy_text(
            raw_text, conditions.get("hazards") or [], recommendation=rec,
        )
        if validated is None:
            flat = " ".join((raw_text or "").split())
            pin_reason = strategy_mod._verdict_pin_reject_reason(flat, rec)
            if pin_reason is not None:
                log.warning("session_strategy: verdict-pin reject (%s) hole=%s", pin_reason, hole)
            else:
                log.warning("session_strategy: validator rejected narrative for hole=%s", hole)
            strategy_text = _degraded_line()
            degraded = True
        else:
            strategy_text = validated
            degraded = False
    except Exception:
        # Missing key / network / API error / bad model id — never surfaced
        # to the client, and never a fabricated strategy. A recommendation
        # exists here (the honest-empty branch above already returned), so
        # the degraded line is always groundable.
        log.exception("session_strategy: synthesis failed for hole=%s", hole)
        strategy_text = _degraded_line()
        degraded = True

    if not degraded:
        # Only successful, validated syntheses are cached — a transient
        # failure must never calcify a degraded line for the full TTL.
        strategy_mod.cache_store(key, {"strategy": strategy_text, "degraded": degraded})

    return {
        "available": True, "hole_number": hole, "strategy": strategy_text,
        "degraded": degraded, "reason": None, "numbers": numbers,
    }
