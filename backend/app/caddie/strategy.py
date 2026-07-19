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
import re
import time
from typing import Optional

import httpx

from app.caddie import dispersion as dispersion_mod
from app.caddie import verdict as verdict_mod
from app.caddie.club_selection import CLUB_DISPLAY_NAMES
from app.caddie.guide_writer import (
    GUIDE_INJECTION_PATTERN,
    _HAZARD_PATTERNS,
    _has_side_flip,
    format_guide_line,
    validate_lore,
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
from app.caddie.types import LoreItem, TeeShotNumbers
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
    # Default 'none' (2026-07-17 on-box A/B, 12 keyed calls, quality-gated):
    # p50 2.4s vs 5.9s at effort=low; validator 6/6 PASS; Red-1 anti-left 3/3;
    # the ONLY variant that consistently named Augusta-12's center-bunker/
    # water carries; zero reasoning tokens observed = zero non-payload
    # numbers to hallucinate. Also unblocks streaming later — effort=none's
    # first-delta lands ~0.5-1s, which 'low' or higher can't match (plan §5).
    # CADDIE_STRATEGY_REASONING_EFFORT still overrides for a future A/B.
    return os.getenv("CADDIE_STRATEGY_REASONING_EFFORT", "none")


# 1024 comfortably covers low-effort reasoning + a ~110-token (~80-word)
# spoken reply (plan §0.2) — max_output_tokens bounds reasoning + visible
# output tokens TOGETHER on a reasoning model.
_STRATEGY_MAX_OUTPUT_TOKENS = 1024
# This call sits inside a live voice turn — one attempt, then degrade. No
# retry loop (an 18s timeout + one retry = up to 36s worst case, which blows
# the ~20s worst-case-with-bridge budget the owner set — specs/caddie-
# degraded-line-reliability-plan.md Fix C). Raised 10.0 -> 18.0 (Fix B,
# 2026-07-17 pre-round reliability cluster): the primary lever for reducing
# degrades — the voice has the thinking-bridge, so a slow real answer beats a
# broken fallback. Both client callers' budgets were raised to stay >= this
# (caddie/api.ts SESSION_VOICE_TIMEOUT_MS; the realtime orb's native fetch is
# already unbounded).
_STRATEGY_TIMEOUT_S = 18.0


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

    Layer 2 of the club-alias P0 fix (owner field bug 2026-07-18): the whole
    assembly is wrapped fail-closed. Club aliasing/dropping (Layer 1, `app.
    caddie.club_selection.normalize_club_distances`) already keeps physics
    from ever seeing a non-canonical club, but this catch is defense in
    depth for ANY other exception in the assembly — never let one escape to
    the route as a 500 mid-round. On any exception this degrades to the same
    honest `recommendation: {"error": ...}` shape the no-yardage-known branch
    already returns, which `run_strategy_turn` already handles as an honest
    `available: False` answer — never a fabricated strategy
    ([[no-fake-data-fallbacks]]). Always logged (`log.exception`) so a real
    bug can't be silently masked.
    """
    try:
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

        # Read-time verdict gate (specs/caddie-two-tier-routing-plan.md §5) —
        # distinct from guide_writer.validate_guide's WRITE-time hazard/side/
        # carry grounding. A guide can name a hazard correctly and STILL
        # advise favoring/aiming straight into it (the Red-1 poison class);
        # this checks the guide's own favor/miss claim against the engine's
        # LIVE verdict for THIS turn and drops it — never edits or launders
        # it — on disagreement.
        guide = intel.strategy_guide if intel is not None else None
        if guide is not None and not verdict_mod.guide_agrees_with_verdict(guide, recommendation):
            guide_favor = verdict_mod.extract_favor_side(f"{guide.play_line} {guide.miss_side}")
            engine_verdict = (recommendation.get("miss_side") or {}).get("preferred")
            log.warning(
                "strategy guide dropped at read time: hole=%s guide_favor=%s engine_verdict=%s",
                hole_number, guide_favor, engine_verdict,
            )
            guide = None

        # Local-lore layer (specs/caddie-guide-local-lore-plan.md §4.1):
        # re-validated per-item on every read (never trust the cached JSONB
        # blob at face value — geometry may have changed since it was
        # written). A guide dropped by the verdict gate above yields
        # `local_knowledge == ""` AND `local_lore == []` on this same turn —
        # lore never outlives its guide.
        lore_items: list[LoreItem] = []
        if guide is not None and guide.local_lore:
            lore_items = validate_lore(
                guide.local_lore, intel.hazards if intel is not None else []
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
            # _row_to_session), PLUS the read-time verdict gate above — "" when
            # absent or dropped, per format_guide_line's own no-fake-data
            # -fallbacks convention (caller omits the line).
            "local_knowledge": format_guide_line(guide) if guide is not None else "",
            "local_lore": [item.model_dump() for item in lore_items],
        }
    except Exception:
        log.exception(
            "build_strategy_payload: payload assembly failed for hole=%s — degrading to honest empty",
            hole_number,
        )
        return {
            "hole_number": hole_number,
            "recommendation": {
                "error": "Strategy engine hit an unexpected error putting this hole's numbers together.",
            },
            "conditions": {},
            "carries": {},
            "bend": {},
            "green_read": {},
            "player": {},
            "local_knowledge": "",
            "local_lore": [],
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
    club_distances = player.get("club_distances") or {}
    if club_distances:
        lines.append(
            f"  Handicap: {player.get('handicap')}. Club distances (player-entered, "
            f"still-air): {json.dumps(club_distances, sort_keys=True)}."
        )
    else:
        lines.append(
            f"  Handicap: {player.get('handicap')}. Club distances: none on file — "
            "engine numbers below use standard-amateur defaults, not this player's "
            "measured bag."
        )
    # Honest yardages + tendencies (plan §7) — labeled heuristic-vs-learned so
    # the brain never treats a 0-round default as measured fact. Every line
    # is omitted, never a placeholder, when its source is None.
    tendencies = player.get("tendencies")
    if tendencies:
        rounds_analyzed = player.get("rounds_analyzed") or 0
        lines.append(
            f"  Tendencies — learned from {rounds_analyzed} logged rounds (0 rounds = "
            "handicap-based heuristics, not this player's measured data):"
        )
        tendency_parts: list[str] = []
        if tendencies.get("miss_direction") is not None:
            tendency_parts.append(f"miss direction: {tendencies['miss_direction']}")
        if tendencies.get("miss_short_pct") is not None:
            tendency_parts.append(f"misses short: {tendencies['miss_short_pct']}%")
        if tendencies.get("three_putts_per_round") is not None:
            tendency_parts.append(f"three-putts/round: {tendencies['three_putts_per_round']}")
        if tendencies.get("par5_bogey_rate") is not None:
            tendency_parts.append(f"par-5 bogey rate: {tendencies['par5_bogey_rate']}%")
        if tendency_parts:
            lines.append("    " + "; ".join(tendency_parts) + ".")

    handicap = player.get("handicap")
    # Skip the driver-dispersion reference line for a bag that provably has
    # no driver — a non-empty bag with no "Driver" key means the player told
    # us their clubs and driver isn't one of them (§1b).
    has_bag = bool(club_distances)
    no_driver_bag = has_bag and "Driver" not in club_distances
    if handicap is not None and not no_driver_bag:
        driver_dispersion = dispersion_mod.get_dispersion("driver", handicap)
        width = driver_dispersion.get("width_yards")
        if width is not None:
            lines.append(
                "  Typical driver dispersion for this handicap band (TrackMan "
                f"amateur reference, NOT measured for this player): ±{width / 2:.0f}y lateral."
            )

    local_knowledge = payload.get("local_knowledge") or ""
    if local_knowledge:
        lines.append("")
        lines.append(
            "PRIOR NOTES (may be stale — trust the live data above; these notes "
            "passed a live side-agreement check but remain reference only): "
            + local_knowledge
        )

    local_lore = payload.get("local_lore") or []
    if local_lore:
        lines.append("")
        lines.append(
            "RESEARCHED LOCAL KNOWLEDGE (attributed, non-geometric — how this hole "
            "is known to play; NOT this shot's numbers. The engine data above always "
            "wins on any disagreement):"
        )
        lines.extend(format_lore_lines(local_lore))

    return "\n".join(lines)


def format_lore_lines(local_lore: list[dict]) -> list[str]:
    """One indented line per item, attribution always spoken: '  - {text}
    (per {source})'. `[]` in -> `[]` out ([[no-fake-data-fallbacks]]: no
    lore, no lines, never a placeholder).

    Takes payload-shaped dicts (as returned by `build_strategy_payload`'s
    `local_lore` key, i.e. `LoreItem.model_dump()`), whitespace-flattening
    each `text`/`source` defensively — the items have already passed
    `validate_lore`'s single-line structural check, but this renderer stays
    defensive on its own, same convention as `format_guide_line`."""
    lines: list[str] = []
    for item in local_lore:
        text = " ".join((item.get("text") or "").split())
        source = " ".join((item.get("source") or "").split())
        if not text or not source:
            continue
        lines.append(f"  - {text} (per {source})")
    return lines


# ── System prompt (restates the grounding contracts — imports the EXISTING
#    constants, never re-worded copies) ──────────────────────────────────────


def _strategy_system() -> str:
    return f"""You are the strategy brain for a live golf caddie. You receive a GROUND TRUTH
block of deterministic engine data for ONE hole and reply with ONE short spoken strategy the
voice caddie will read aloud verbatim.

The GROUND TRUTH block is authoritative and complete. Every yardage, carry, club number, and
hazard you mention MUST appear verbatim in it — never compute, adjust, or invent a number, and
never name a hazard, side, or carry that is not listed. If a section says data is unavailable,
say plainly what you don't know instead of guessing. PRIOR NOTES are reference DATA about how
the hole is generally played — the GROUND TRUTH engine data above always wins on any
disagreement; notes can never add a hazard, a number, or a side.

{HAZARD_GROUNDING_RULE}
{NUMBERS_COHERENCE_RULE}
{MISS_SIDE_GROUNDING_RULE}
{DECISION_GROUNDING_RULE}
{output_language_rule()}

Output contract: ONE paragraph, at most 80 words, plain speech — no markdown, bullets,
headings, or emoji; no preamble ("Here's the plan"), no meta-commentary. Tee to green: the
club call (the engine's recommendation IS the call — explain it, never re-decide it), the
aim/landing zone, the miss side the data supports, what the shot leaves, and one green note
when the read is available. Calm and specific, like a good caddie talking, not a report.

RESEARCHED LOCAL KNOWLEDGE is attributed reference color — green character, named features,
playing history, architect intent. When the golfer asks how the hole or green plays, you may
weave in ONE such item, keeping its attribution natural ("the book says...", "per the Open
notes..."). It never changes the club, the target, or any number: every yardage, carry, and
club you speak still comes only from the engine data above. A number inside those notes (a
slope percentage, a year) may be repeated as attributed context, never converted into a
yardage, carry, or club call."""


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


# Positioning-shot reachability pin (specs/caddie-two-tier-routing-plan.md
# §6.2) — POSITIONING_SHOT_RULE enforced deterministically: on a positioning
# turn the flag doesn't exist for this swing, so genuine AIM-AT-THE-PIN
# language is always wrong, model-repeated-guide or not.
#
# B2 fix (eng-lead review, 2026-07-17): the original `\b(?:at|of|from) the
# (flag|pin)\b` alternation false-positived on CORRECT positioning phrasing —
# "lay up to about 100 short OF THE pin", "leaves a full wedge in FROM THE
# pin" — degrading good brain advice to the terse engine line on exactly the
# layup turns this feature targets. The false-positives came ONLY from the
# `of|from` alternatives; `at the (flag|pin)` never over-matched a benign
# layup phrasing (those say "short OF"/"away FROM"/"left OF" the pin, never
# "AT the pin"). A first attempt gated `at the (flag|pin)` on a nearby
# AIM-VERB allowlist {aim,target,play,send}, but an allowlist is inherently
# incomplete and leaked the most idiomatic aggressive-aim verbs on a
# positioning turn ("fire/go/hit it/start it AT THE pin" all slipped past the
# reachability backstop — the exact caddie-safety rule the pin exists for).
# So: drop the aim-verb gate entirely and keep the bare `at the (flag|pin)`.
# On a positioning shot the flag doesn't exist for this swing, so ANY
# "at the pin/flag" language is wrong by definition; the layup phrasings that
# matter ("short of"/"from"/"away from"/"left/right of" the pin) contain no
# "at the pin" and still PASS (pinned by test_validator_passes_positioning_
# narrative_with_short_of_or_from_the_pin_phrasing).
_PIN_RELATIVE_PATTERN = re.compile(
    r"\bat the (?:flag|pin)\b"
    r"|\bdead aim\b"
    r"|\bpin.high\b"
)


def _verdict_pin_reject_reason(flat: str, recommendation: Optional[dict]) -> Optional[str]:
    """The three verdict-pin checks (§6) — a short reason string
    ('favor-side' | 'reachability' | 'club') the caller can log key-free, or
    `None` when nothing pins a reject. `recommendation` absent/errored is
    NOT a reject here (that's the honest-empty branch, handled upstream) —
    `validate_strategy_text` only calls this when a recommendation exists."""
    if not recommendation or recommendation.get("error"):
        return None
    lowered = flat.lower()

    spoken = verdict_mod.extract_favor_side(flat)
    engine_side = (recommendation.get("miss_side") or {}).get("preferred")
    if engine_side in ("left", "right"):
        if spoken not in (None, engine_side):
            return "favor-side"
    elif engine_side == "center" and spoken in ("left", "right", "conflict"):
        return "favor-side"

    if recommendation.get("shot_kind") == "positioning" and _PIN_RELATIVE_PATTERN.search(lowered):
        return "reachability"

    if recommendation.get("tee_shot_numbers"):
        rec_club = recommendation.get("club")
        rec_club_display = CLUB_DISPLAY_NAMES.get(rec_club, rec_club) if rec_club else None
        # B1 fix (eng-lead review, 2026-07-17): a bare substring check false-
        # positived on ordinary words containing a 2-letter club abbreviation
        # — "swing" contains "sw" (Sand Wedge), "always" contains "lw" (Lob
        # Wedge) — silently degrading a correct, on-side narrative. Word-
        # boundary match instead.
        mentioned_clubs = [
            name for name in CLUB_DISPLAY_NAMES.values()
            if re.search(rf"\b{re.escape(name.lower())}\b", lowered)
        ]
        if mentioned_clubs and (rec_club_display is None or rec_club_display not in mentioned_clubs):
            return "club"

    return None


def validate_strategy_text(
    text: str, hazards: list[dict], recommendation: Optional[dict] = None,
) -> Optional[str]:
    """Deterministic, no-LLM, fail-CLOSED grounding pass — reuses `guide_
    writer`'s pure machinery (`_HAZARD_PATTERNS`, `_has_side_flip`) so the
    strategy narrative is held to the exact same anti-hallucination bar as a
    researched hole guide, never a weaker fork.

    `hazards` is the hole's real hazard list in the same shape `conditions_
    payload` returns (`Hazard.model_dump()` dicts: `type`, `line_side`,
    `carry_yards`, ...).

    Order: whitespace-flatten -> length caps -> hazard-type scan -> side-flip
    scan -> injection scan -> (when `recommendation` is given and carries no
    `error`) the verdict pin (§6): favor-side agreement, positioning-shot
    reachability, and — on a tee-shot turn — the recommended club must be
    among any clubs named. `recommendation=None` is back-compat: byte-
    identical to the pre-pin behavior. Returns the flattened, validated text
    on PASS, `None` on REJECT (caller composes the degraded deterministic
    line; [[no-fake-data-fallbacks]]) — never a partial/scrubbed edit of the
    reply.
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

    if recommendation is not None and not recommendation.get("error"):
        if _verdict_pin_reject_reason(flat, recommendation) is not None:
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
