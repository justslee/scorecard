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
from app.caddie.club_selection import CLUB_DISPLAY_NAMES
from app.caddie.session import RoundSession
from app.caddie.types import TeeShotNumbers

log = logging.getLogger("looper.caddie.strategy_turn")


def compose_degraded_line(rec: dict, green_read: dict, carries: dict) -> str:
    """Deterministic degraded-line composer — built PURELY from engine
    FIELDS, never reused prose (specs/caddie-degraded-line-reliability-plan.md
    Fix A). The old closure this replaces reused `format_tee_numbers_line`
    (whose string carries prompt scaffold — "AUTHORITATIVE — they close" /
    "Speak ONLY these numbers" — that got TTS'd verbatim) and `*.description`
    free text (`aim_point.description` defaults to "Aim at the flag — green
    light, no trouble", which both aims an unreachable flag on a positioning
    shot and claims "no trouble" even when drive-zone hazards exist). Every
    clause here is composed from a structured field and omitted outright
    (never a placeholder, never "no trouble", never "at the flag/pin") when
    its source is empty/None/the literal string "none" — including the
    `uphill_leave_side == "none"` flat-green case that used to render the
    literal bug string "the none".

    Module-level + pure so it is directly unit-testable
    (`tests/eval/test_strategy_tool.py`) and the ONE implementation both the
    live degrade path and the route tests exercise — no hand-reconstructed
    duplicate to drift out of sync.
    """
    club_key = rec.get("club") or ""
    club_display = CLUB_DISPLAY_NAMES.get(club_key, club_key) or "your club"

    parts: list[str] = []

    # 1. Club + numbers.
    tee_numbers = rec.get("tee_shot_numbers")
    if tee_numbers:
        n = TeeShotNumbers.model_validate(tee_numbers)
        lead = f"{club_display} off the tee — {n.to_green_yards} to the green"
        if n.plays_like_yards != n.to_green_yards:
            lead += f", plays like {n.plays_like_yards}"
        if n.drive_carry_yards is not None:
            lead += f"; carries {n.drive_carry_yards}, totals {n.drive_total_yards}"
        else:
            lead += f"; {n.club_stored_yards} stored"
        if n.leave_exact_yards <= 0:
            lead += ", reaches the green"
        else:
            lead += f", leaves about {n.leave_yards} in"
        parts.append(lead + ".")
    elif rec.get("shot_kind") == "positioning":
        lead = f"{club_display} — position it, {rec.get('raw_yards')} to the green"
        if rec.get("leave_yards"):
            lead += f", leaves about {rec['leave_yards']} in"
        parts.append(lead + ".")
    else:
        raw_yards = rec.get("raw_yards")
        target_yards = rec.get("target_yards")
        lead = f"{club_display}, {raw_yards} to the green"
        if target_yards and target_yards != raw_yards:
            lead += f", plays like {target_yards}"
        parts.append(lead + ".")

    # 2. Favor-side.
    pref = (rec.get("miss_side") or {}).get("preferred")
    if pref in ("left", "right"):
        parts.append(f" Favor the {pref}.")
    elif pref == "short":
        parts.append(" Favor short.")
    elif pref == "long":
        parts.append(" Favor long.")
    # "center" / falsy -> omit (never "no trouble" / "no strong side").

    # 3. Hazard clause from the drive-zone/frame carries. Prefers the
    # player-relative `carry_from_you_yards` frame (approach-solve plan
    # §1.5) when the turn is approach-framed — the raw tee-anchored
    # `carry_yards` otherwise (tee turns: key absent, byte-identical).
    hz = [c for c in (carries.get("carries") or []) if c.get("carry_yards")]
    if hz:
        parts.append(
            " Watch "
            + ", ".join(
                (f"{c['type']} {c['side']} about {c['carry_from_you_yards']} from you"
                 if c.get("carry_from_you_yards") is not None
                 else f"{c['type']} {c['side']} at {c['carry_yards']}")
                for c in hz
            )
            + "."
        )
    # empty / carries unavailable -> omit (no "no trouble" ever).

    # 4. Green read.
    gr = green_read.get("uphill_leave_side")
    if green_read.get("available") and gr in ("left", "right"):
        parts.append(f" Green: a miss {gr} leaves the uphill putt.")
    elif green_read.get("available") and gr == "none":
        depth = green_read.get("uphill_leave_depth")
        if depth in ("short", "long"):
            parts.append(f" Green: leave it {depth} for the uphill putt.")
    # else -> omit. Never emit the substring "the none".

    return "".join(parts)


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
            {
                "type": c.get("type"), "side": c.get("side"), "carry_yards": c.get("carry_yards"),
                # Player-relative frame (approach-solve plan §1.5), additive —
                # `None` on every tee-framed turn, byte-identical there.
                "carry_from_you_yards": c.get("carry_from_you_yards"),
            }
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
            strategy_text = compose_degraded_line(rec, green_read, carries)
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
        strategy_text = compose_degraded_line(rec, green_read, carries)
        degraded = True

    if not degraded:
        # Only successful, validated syntheses are cached — a transient
        # failure must never calcify a degraded line for the full TTL.
        strategy_mod.cache_store(key, {"strategy": strategy_text, "degraded": degraded})

    return {
        "available": True, "hole_number": hole, "strategy": strategy_text,
        "degraded": degraded, "reason": None, "numbers": numbers,
    }
