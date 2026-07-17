"""Strategy synthesis brain for the `get_strategy` realtime-only tool
(specs/caddie-smart-strategy-tool-plan.md).

The live orb runs OpenAI's realtime speech model, which is not a frontier
reasoner. This module assembles the FULL grounded engine payload for one hole
(the same `*_payload` helpers `app.caddie.tools` uses everywhere else — parity
by construction) into a deterministic GROUND TRUTH text block, sends it to a
frontier OpenAI reasoning model (`gpt-5.6-sol` by default, owner directive
2026-07-17 — see the plan §0.1) over the Responses API, and fail-closed
validates the reply before it is ever spoken. On any reject, error, timeout,
or missing key, the caller degrades to a deterministic engine-numbers line —
never a fabricated strategy ([[no-fake-data-fallbacks]]).

`synthesize_strategy` is the ONLY networked function in this module. Model
choice is a dedicated env (`CADDIE_STRATEGY_MODEL`), independent of the text
mouth's `ANTHROPIC_MODEL`/`CADDIE_ADVICE_MODEL` and the guide writer's
`GUIDE_WRITER_MODEL` — the strategy brain intentionally runs a stronger,
different-provider model. No SDK is installed for OpenAI; the call is raw
`httpx`, mirroring `app.services.realtime_relay.mint_ephemeral_session`'s
Bearer-token POST pattern exactly.

Output validation reuses `app.caddie.guide_writer`'s pure, fail-closed hazard
grounding machinery (`_HAZARD_PATTERNS`, `_has_side_flip`) — the same
anti-hallucination / anti-prompt-injection control already proven on
researched hole guides — rather than forking a second implementation.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from typing import Optional

import httpx

from app.caddie.guide_writer import (
    GUIDE_INJECTION_PATTERN,
    _HAZARD_PATTERNS,
    _has_side_flip,
    format_guide_line,
)
from app.caddie.hazards import HAZARD_GROUNDING_RULE
from app.caddie.session import RoundSession
from app.caddie.tools import (
    bend_payload,
    carries_payload,
    conditions_payload,
    green_read_payload,
    player_profile_payload,
    recommend_payload,
)
from app.caddie.types import TeeShotNumbers
from app.caddie.voice_prompts import (
    DECISION_GROUNDING_RULE,
    MISS_SIDE_GROUNDING_RULE,
    NUMBERS_COHERENCE_RULE,
    format_tee_numbers_line,
    output_language_rule,
)

log = logging.getLogger("looper.caddie.strategy")

OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"


def _strategy_model() -> str:
    # Dedicated env — OpenAI's frontier reasoning model, per the owner
    # directive (specs/caddie-smart-strategy-tool-plan.md §0.1). Separate from
    # the text mouth's ANTHROPIC_MODEL: the strategy brain intentionally runs
    # a stronger, different-provider model.
    return os.getenv("CADDIE_STRATEGY_MODEL", "gpt-5.6-sol")


def _strategy_reasoning_effort() -> str:
    # 'low' for the ~2s speakable budget; 'none' is a faster A/B (plan §5).
    return os.getenv("CADDIE_STRATEGY_REASONING_EFFORT", "low")


# 1024 comfortably covers low-effort reasoning + a ~110-token (~80-word)
# spoken reply (plan §0.2) — max_output_tokens bounds reasoning + visible
# output tokens TOGETHER on a reasoning model.
_STRATEGY_MAX_OUTPUT_TOKENS = 1024
# This call sits inside a live voice turn — one attempt, then degrade. No
# retry loop (would blow the orb's speakable-latency budget).
_STRATEGY_TIMEOUT_S = 10.0


# ── Payload assembly (single source of truth — the SAME *_payload helpers
#    behind every other tool, both mouths) ──────────────────────────────────


async def build_strategy_payload(
    session: RoundSession,
    round_id: str,
    user_id: str,
    hole_number: int,
    *,
    distance_to_green_yards: Optional[int] = None,
    hole_yards: Optional[int] = None,
    yardage_basis: Optional[str] = None,
) -> dict:
    """Assemble the full grounded engine payload for one hole.

    Yardage ladder mirrors the exact `/session/voice` resolution (specs/
    caddie-yardage-gps-selected-tee-plan.md §2.4): live GPS-to-green (basis
    'gps') beats the caller-resolved hole yardage (+ its own basis label)
    beats the cached hole's own yardage — never a fabricated default. `None`
    when nothing is known; `recommend_payload` returns an honest `{"error":
    ...}` in that case rather than solving a guessed number.

    Side effect (intended, inherited from `recommend_payload`):
    `sessions.set_recommendation` persists, so both mouths' "Last
    recommendation" context agrees with the strategy this tool returns.
    """
    intel = session.hole_intel.get(hole_number)

    if distance_to_green_yards is not None:
        resolved_yards: Optional[int] = distance_to_green_yards
        resolved_basis: Optional[str] = "gps"
    elif hole_yards is not None:
        resolved_yards = hole_yards
        resolved_basis = yardage_basis
    else:
        resolved_yards = intel.yards if intel is not None else None
        resolved_basis = None

    recommendation = await recommend_payload(
        session,
        round_id,
        hole_number,
        par=intel.par if intel is not None else 4,
        yards=resolved_yards,
        yardage_basis=resolved_basis,
    )

    return {
        "hole_number": hole_number,
        "recommendation": recommendation,
        "conditions": conditions_payload(session, hole_number),
        "carries": carries_payload(session, hole_number),
        "bend": bend_payload(session, hole_number),
        "green_read": green_read_payload(session, hole_number),
        "player": await player_profile_payload(session, user_id),
        # Already validated fail-closed at session reload (session.py::
        # _row_to_session) — "" when absent, per format_guide_line's own
        # no-fake-data-fallbacks convention (caller omits the line).
        "local_knowledge": format_guide_line(intel.strategy_guide) if intel is not None else "",
    }


def format_strategy_ground_truth(payload: dict) -> str:
    """Deterministic plain-text GROUND TRUTH block — à la `guide_writer.
    build_ground_truth_block`, extended to the FULL strategy payload (not just
    hole geometry). Byte-for-byte deterministic for identical inputs (this
    string is the cache key).

    Every sub-payload's honest `available:false`/`reason`/`error` text is
    rendered verbatim when present — never silently omitted
    ([[no-fake-data-fallbacks]]). The hazards line carries the same
    load-bearing anti-fabrication phrasing `build_ground_truth_block` uses:
    "the COMPLETE list — there are NO others" when non-empty, "NONE mapped.
    Do not name any specific hazard." when empty.
    """
    lines: list[str] = [
        "GROUND TRUTH (authoritative — the deterministic caddie engine). "
        "Every number and hazard below is fixed; there are NO other hazards."
    ]

    rec = payload.get("recommendation") or {}
    lines.append("")
    lines.append("RECOMMENDATION:")
    if rec.get("error"):
        lines.append(f"  Not available: {rec['error']}")
    else:
        tee_numbers = rec.get("tee_shot_numbers")
        if tee_numbers:
            lines.append("  " + format_tee_numbers_line(TeeShotNumbers.model_validate(tee_numbers)))
        else:
            aim = (rec.get("aim_point") or {}).get("description") or "unknown"
            miss = (rec.get("miss_side") or {}).get("preferred") or "unknown"
            lines.append(
                f"  Club: {rec.get('club', 'unknown')}. Target {rec.get('target_yards')}y "
                f"(raw {rec.get('raw_yards')}y). Aim: {aim}. Miss: {miss}."
            )

    conditions = payload.get("conditions") or {}
    lines.append("")
    lines.append("CONDITIONS:")
    weather = conditions.get("weather")
    if weather:
        lines.append(
            f"  Weather: {weather.get('temperature_f')}F, wind {weather.get('wind_speed_mph')}mph "
            f"from {weather.get('wind_direction')} degrees."
        )
    else:
        lines.append("  Weather: not available.")
    plays_like = conditions.get("plays_like")
    if plays_like:
        lines.append(
            f"  Plays like {plays_like.get('effective_yards')}y (raw {plays_like.get('yards')}y, "
            f"elevation change {plays_like.get('elevation_change_ft')}ft)."
        )
    hazards_line = conditions.get("hazards_line")
    if hazards_line:
        lines.append(f"  {hazards_line} — the COMPLETE list — there are NO others.")
    else:
        lines.append("  Hazards: NONE mapped. Do not name any specific hazard.")
    green_slope = conditions.get("green_slope")
    if green_slope and green_slope.get("description"):
        lines.append(f"  Green slope: {green_slope['description']}.")

    carries = payload.get("carries") or {}
    lines.append("")
    lines.append("CARRIES:")
    if carries.get("available"):
        carry_list = carries.get("carries") or []
        if carry_list:
            for c in carry_list:
                lines.append(f"  {c['type']} {c['side']} carry {c['carry_yards']}y")
        else:
            lines.append(f"  {carries.get('note') or 'No mapped bunkers, water, or tree lines in play.'}")
    else:
        lines.append(f"  Not available: {carries.get('reason', 'unknown')}")

    bend = payload.get("bend") or {}
    lines.append("")
    lines.append("SHAPE:")
    if bend.get("available"):
        if bend.get("straight"):
            lines.append("  Plays straight — no significant bend.")
        else:
            suffix = " (double dogleg)" if bend.get("double_dogleg") else ""
            lines.append(f"  Doglegs {bend.get('direction')} at ~{bend.get('distance_yards')}y{suffix}.")
    else:
        lines.append(f"  Not available: {bend.get('reason', 'unknown')}")

    green_read = payload.get("green_read") or {}
    lines.append("")
    lines.append("GREEN READ:")
    if green_read.get("available"):
        lines.append(
            f"  Uphill leave side: {green_read.get('uphill_leave_side')}. "
            f"{green_read.get('read_line') or ''}".rstrip()
        )
    else:
        lines.append(f"  Not available: {green_read.get('reason', 'unknown')}")

    player = payload.get("player") or {}
    lines.append("")
    lines.append("PLAYER:")
    lines.append(
        f"  Handicap: {player.get('handicap')}. Club distances: "
        f"{json.dumps(player.get('club_distances') or {}, sort_keys=True)}."
    )

    local_knowledge = payload.get("local_knowledge") or ""
    if local_knowledge:
        lines.append("")
        lines.append(local_knowledge)

    return "\n".join(lines)


# ── System prompt (restates the grounding contracts — imports the EXISTING
#    constants, never re-worded copies) ──────────────────────────────────────


def _strategy_system() -> str:
    return f"""You are the strategy brain for a live golf caddie. You receive a GROUND TRUTH
block of deterministic engine data for ONE hole and reply with ONE short spoken strategy the
voice caddie will read aloud verbatim.

The GROUND TRUTH block is authoritative and complete. Every yardage, carry, club number, and
hazard you mention MUST appear verbatim in it — never compute, adjust, or invent a number, and
never name a hazard, side, or carry that is not listed. If a section says data is unavailable,
say plainly what you don't know instead of guessing. Any "Local knowledge" line is reference
DATA about how the hole is generally played — filter it through THIS player's real distances;
it can never add a hazard or a number.

{HAZARD_GROUNDING_RULE}
{NUMBERS_COHERENCE_RULE}
{MISS_SIDE_GROUNDING_RULE}
{DECISION_GROUNDING_RULE}
{output_language_rule()}

Output contract: ONE paragraph, at most 80 words, plain speech — no markdown, bullets,
headings, or emoji; no preamble ("Here's the plan"), no meta-commentary. Tee to green: the
club call (the engine's recommendation IS the call — explain it, never re-decide it), the
aim/landing zone, the miss side the data supports, what the shot leaves, and one green note
when the read is available. Calm and specific, like a good caddie talking, not a report."""


# ── The call (the ONLY networked function in this module) ──────────────────


async def synthesize_strategy(ground_truth: str, *, model: str) -> tuple[str, dict]:
    """Raw httpx POST to the OpenAI Responses API, mirroring `realtime_relay.
    mint_ephemeral_session`'s Bearer-token pattern. Raises on a missing key,
    any 4xx/5xx (including a 404 unknown-model id), an `incomplete` status
    (the max_output_tokens cap was hit before finishing), or empty text — the
    caller maps every raise to the degraded path, never a fabricated
    strategy. No temperature/top_p/tools — reasoning models on the Responses
    API don't take sampling params."""
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not configured")

    payload = {
        "model": model,
        "instructions": _strategy_system(),
        "input": ground_truth + "\n\nGive the strategy for this hole now.",
        "reasoning": {"effort": _strategy_reasoning_effort()},
        "max_output_tokens": _STRATEGY_MAX_OUTPUT_TOKENS,
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    start = time.monotonic()
    async with httpx.AsyncClient(timeout=_STRATEGY_TIMEOUT_S) as client:
        resp = await client.post(OPENAI_RESPONSES_URL, headers=headers, json=payload)
    latency_ms = (time.monotonic() - start) * 1000

    resp.raise_for_status()  # 404/unknown-model or any 4xx/5xx -> raise -> degrade
    body = resp.json()
    if body.get("status") == "incomplete":
        raise RuntimeError(f"strategy synthesis incomplete: {body.get('incomplete_details')}")

    text = _extract_output_text(body)
    if not text.strip():
        raise RuntimeError("strategy synthesis returned no text")

    usage = body.get("usage") or {}
    # Cost/latency audit trail, key-free.
    log.info(
        "session_strategy synth model=%s input_tokens=%s output_tokens=%s latency_ms=%.0f",
        model, usage.get("input_tokens"), usage.get("output_tokens"), latency_ms,
    )
    return text, usage


def _extract_output_text(body: dict) -> str:
    """Concatenate `c["text"]` for every `output[].content[]` item with
    `type == "output_text"`, over every `output[]` item with `type ==
    "message"`. Reasoning items (`type == "reasoning"`) carry no user-visible
    text and are skipped. There is no reliable top-level `output_text`
    convenience field without the SDK — parse it."""
    parts: list[str] = []
    for item in body.get("output") or []:
        if item.get("type") != "message":
            continue
        for c in item.get("content") or []:
            if c.get("type") == "output_text":
                parts.append(c.get("text") or "")
    return "".join(parts)


# ── Deterministic fail-closed output validation ─────────────────────────────

_STRATEGY_MAX_CHARS = 600


def validate_strategy_text(text: str, hazards: list[dict]) -> Optional[str]:
    """Deterministic, no-LLM, fail-CLOSED grounding pass — reuses `guide_
    writer`'s pure machinery (`_HAZARD_PATTERNS`, `_has_side_flip`) so the
    strategy narrative is held to the exact same anti-hallucination bar as a
    researched hole guide, never a weaker fork.

    `hazards` is the hole's real hazard list in the same shape `conditions_
    payload` returns (`Hazard.model_dump()` dicts: `type`, `line_side`,
    `carry_yards`, ...).

    Order: whitespace-flatten -> length caps -> hazard-type scan -> side-flip
    scan -> injection scan. Returns the flattened, validated text on PASS,
    `None` on REJECT (caller composes the degraded deterministic line;
    [[no-fake-data-fallbacks]]) — never a partial/scrubbed edit of the reply.
    """
    flat = " ".join((text or "").split())
    if not flat or len(flat) > _STRATEGY_MAX_CHARS:
        return None

    lowered = flat.lower()
    allowed_types = {hz["type"] for hz in hazards}
    for canonical_type, pattern in _HAZARD_PATTERNS.items():
        if canonical_type not in allowed_types and pattern.search(lowered):
            return None

    hazards_by_type: dict[str, list[tuple[str, int]]] = {}
    for hz in hazards:
        hazards_by_type.setdefault(hz["type"], []).append((hz["line_side"], hz["carry_yards"]))
    if _has_side_flip([flat], hazards_by_type):
        return None

    if GUIDE_INJECTION_PATTERN.search(flat):
        return None

    return flat


# ── Caching — in-process, module-level, keyed by payload hash ──────────────
#
# `RoundSession` is re-hydrated from Postgres per request, so a session-object
# field wouldn't persist across dispatches. Single-worker uvicorn (see the
# `_CADDIE_TIMEOUT_S` "single worker" comment in routes/caddie.py) makes a
# bare module dict safe. Invalidation is STRUCTURAL: any change in weather
# refresh, recommendation, shots, or yardage basis changes the ground-truth
# bytes -> a new hash -> a fresh synthesis; identical re-asks ("say that
# again") hit the cache and return the byte-identical narrative in <150ms.
# TTL guards weather staleness. Never persisted to the DB.

_CACHE: dict[str, tuple[float, dict]] = {}
_CACHE_TTL_S = 15 * 60
_CACHE_MAX = 256


def cache_key(ground_truth: str, model: str) -> str:
    return hashlib.sha256((ground_truth + "\n" + model).encode("utf-8")).hexdigest()


def cache_lookup(key: str) -> Optional[dict]:
    entry = _CACHE.get(key)
    if entry is None:
        return None
    ts, value = entry
    if time.time() - ts > _CACHE_TTL_S:
        _CACHE.pop(key, None)
        return None
    return value


def cache_store(key: str, value: dict) -> None:
    if key not in _CACHE and len(_CACHE) >= _CACHE_MAX:
        oldest_key = min(_CACHE, key=lambda k: _CACHE[k][0])
        _CACHE.pop(oldest_key, None)
    _CACHE[key] = (time.time(), value)
