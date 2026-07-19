"""Club selection engine with distance adjustments.

Distance adjustments are DELEGATED to the ball-flight physics engine
(app/caddie/physics.py, specs/caddie-shot-physics-engine-plan.md step 10):
the old stack of scalar rules of thumb (1yd/3ft elevation, %/mph wind,
2yd/10°F, 2%/1000ft altitude, ±2-3% firmness) could not distinguish carry
from roll and produced the 2026-07-09 "390-yard drive" incident. The total
adjusted distance now comes from ONE physics plays-like solve — the same
computation behind the `get_shot_distance` tool — so `get_recommendation`
and `get_shot_distance` can never disagree within a single caddie turn.
"""

import logging
from typing import Optional

from app.caddie import physics
from app.caddie.types import ShotAdjustment, WeatherConditions

log = logging.getLogger("looper.caddie.club_selection")


# Default club distances (fallback when user hasn't set up profile)
DEFAULT_CLUB_DISTANCES: dict[str, int] = {
    "driver": 250,
    "3wood": 230,
    "5wood": 215,
    "hybrid": 200,
    "4iron": 190,
    "5iron": 180,
    "6iron": 170,
    "7iron": 160,
    "8iron": 150,
    "9iron": 140,
    "pw": 130,
    "gw": 115,
    "sw": 100,
    "lw": 85,
}

# Club display names
CLUB_DISPLAY_NAMES: dict[str, str] = {
    "driver": "Driver",
    "3wood": "3 Wood",
    "5wood": "5 Wood",
    "hybrid": "Hybrid",
    "4iron": "4 Iron",
    "5iron": "5 Iron",
    "6iron": "6 Iron",
    "7iron": "7 Iron",
    "8iron": "8 Iron",
    "9iron": "9 Iron",
    "pw": "PW",
    "gw": "GW",
    "sw": "SW",
    "lw": "LW",
}

# Map GolferProfile keys to our keys
_PROFILE_KEY_MAP = {
    "driver": "driver",
    "threeWood": "3wood",
    "fiveWood": "5wood",
    "hybrid": "hybrid",
    "fourIron": "4iron",
    "fiveIron": "5iron",
    "sixIron": "6iron",
    "sevenIron": "7iron",
    "eightIron": "8iron",
    "nineIron": "9iron",
    "pitchingWedge": "pw",
    "gapWedge": "gw",
    "sandWedge": "sw",
    "lobWedge": "lw",
}

# Spoken/LLM-natural club shorthand → canonical CLUB_REFERENCE keys. ONE
# shared table (owner P0 field bug 2026-07-18: an un-normalized '7i' reached
# `physics._club_ref` and raised, 500ing the strategy endpoint mid-round) —
# every club ingress (the bag chokepoint below, `record_shot`, the
# `session.club_distances` assignment) resolves through `canonical_club()`,
# never a second, divergent vocabulary. Built from the display names
# ("7 Iron" → "7iron") plus the long wedge forms and the N-letter/hyphenated
# shorthands the model actually says. `canonical_club` lowercases and strips
# spaces/hyphens first, so "7 iron", "7-Iron", "sand wedge", and "7iron" all
# resolve to the same key.
#
# This is the wire's OTHER end from `frontend/src/lib/caddie/clubs.ts`'s
# `buildClubMap()`: the frontend now emits canonical keys directly (no more
# 'hy'/'3w'/'4i' short codes on the wire), so entries here exist for TWO
# reasons only — (1) legacy short-code rows already persisted in
# `caddie_sessions.club_distances` (some hybrid-carrying users' bags still
# say 'hy'), and (2) LLM/voice-spoken shorthand that never goes through
# `buildClubMap` at all. Aliases are therefore additive-only: never remove
# one, even after every client ships canonical keys (specs/
# caddie-yardage-selector-p0-plan.md §2.2/§5). `'hy'` (P0 2026-07-18:
# `buildClubMap` emitted 'hy' for hybrid, which had NO alias here and was
# silently dropped by `normalize_club_distances` for every hybrid-carrying
# golfer) joins `'3h'` — both alias to `hybrid`, neither is ever removed.
_CLUB_ALIASES: dict[str, str] = {
    **{display.lower().replace(" ", ""): key for key, display in CLUB_DISPLAY_NAMES.items()},
    "pitchingwedge": "pw",
    "gapwedge": "gw",
    "sandwedge": "sw",
    "lobwedge": "lw",
    **{f"{n}i": f"{n}iron" for n in range(4, 10)},
    "3w": "3wood",
    "5w": "5wood",
    "p": "pw",
    "lob": "lw",
    "d": "driver",
    "3h": "hybrid",
    "hy": "hybrid",
}


def canonical_club(raw: object) -> Optional[str]:
    """Resolve a spoken/model club token to its canonical `CLUB_REFERENCE`
    key, or `None` if unrecognized. Coerces `raw` to `str` first so a
    model-supplied non-str arg (e.g. an int) can never raise here — the
    `expected string or bytes-like object, got 'int'` half of the P0."""
    key = str(raw).strip().lower().replace(" ", "").replace("-", "")
    if key in physics.CLUB_REFERENCE:
        return key
    return _CLUB_ALIASES.get(key)


def normalize_club_distances(raw: dict[str, int]) -> dict[str, int]:
    """Normalize club distance keys from GolferProfile format AND any
    spoken/model shorthand ('7i', '3w', 'sand wedge', ...) to canonical
    `CLUB_REFERENCE` keys.

    This is the ONE bag chokepoint every recommendation passes through
    (`generate_recommendation` -> `compute_adjustments`/`select_club`). A key
    still unrecognized after aliasing is DROPPED with a `log.warning` rather
    than passed to physics — physics must never see a non-canonical club
    again (owner P0 2026-07-18: `physics._club_ref('7i')` raised inside
    `build_strategy_payload`, escaping to a 500 mid-round;
    [[no-fake-data-fallbacks]] — dropped, not fabricated, and always logged).
    """
    result: dict[str, int] = {}
    for key, value in raw.items():
        if not value or value <= 0:
            continue
        mapped = _PROFILE_KEY_MAP.get(key, key)
        normalized = canonical_club(mapped)
        if normalized is None:
            log.warning("normalize_club_distances: dropping unrecognized club %r", key)
            continue
        result[normalized] = value
    return result


def physics_plays_like(
    target_yards: float,
    club_distances: dict[str, int],
    cond: "physics.ShotConditions",
) -> tuple[float, str, tuple[str, ...]]:
    """Neutral-baseline-corrected plays-like — the ONE number both
    `compute_adjustments` and the `get_shot_distance` tool speak.

    Two corrections on top of `physics.plays_like_target`:

    1. FINAL-CLUB RECOMPUTE. The core's club iteration can oscillate when the
       plays-like number crosses the wood/iron boundary (e.g. a 200y target on
       firm turf flips hybrid↔5iron), leaving a plays-like computed on a
       DIFFERENT basis than the returned club. Recompute the plays-like for
       the club it settled on, so number and club are always consistent.
    2. NEUTRAL-BASELINE CANCELLATION. The roll model does not perfectly
       round-trip a fitted-DOWN wood's stored total (a 210y 3-wood integrates
       to ~228 neutral total — flagged by the core builder), so the raw solve
       would report a phantom ~15y adjustment in dead-calm air. Subtracting
       the same club's NEUTRAL plays-like makes still-air an exact identity:
       corrected = target + (plays_under_conditions − plays_neutral). The
       systematic model bias cancels; only the CONDITIONS' effect remains —
       the same differential-use principle the reverse fit itself relies on.

    Returns (plays_like_yards, club_key, assumptions).
    """
    plays, club, assumptions = physics.plays_like_target(
        float(target_yards), club_distances, cond
    )
    stored = float(club_distances[club])

    def _plays_for(c: "physics.ShotConditions") -> float:
        result = physics.shot_distance_for_club(club, stored, c)
        achieved = (
            result.total_yards if club in physics.WOOD_CLUBS else result.carry_yards
        )
        if achieved <= 0:
            return float(target_yards)
        return float(target_yards) * stored / achieved

    corrected = float(target_yards) + (_plays_for(cond) - _plays_for(physics.NEUTRAL_CONDITIONS))
    return corrected, club, assumptions


def _isolated_delta(
    target_yards: int, bag: dict[str, int], cond: "physics.ShotConditions"
) -> int:
    """One factor's plays-like delta in whole yards (display breakdown)."""
    plays, _, _ = physics_plays_like(target_yards, bag, cond)
    return round(plays - target_yards)


def compute_adjustments(
    raw_distance: int,
    elevation_change_ft: float = 0.0,
    weather: Optional[WeatherConditions] = None,
    shot_bearing: float = 0.0,
    club_distances: Optional[dict[str, int]] = None,
) -> tuple[int, list[ShotAdjustment]]:
    """Physics-engine distance adjustments (plan step 10).

    The ADJUSTED TOTAL comes from one combined `physics_plays_like` solve of
    all conditions together — identical to the `get_shot_distance` tool's
    target mode, so the two can never disagree in one turn. The per-factor
    `ShotAdjustment` lines are display breakdowns: each factor re-solved in
    ISOLATION against neutral (they explain the total; small cross-factor
    interaction lives only in the combined number). Same output shape as
    before, so aim_point/recommendation-card contracts hold.

    ``club_distances``: the player's bag anchoring the solve; falls back to
    DEFAULT_CLUB_DISTANCES (same fallback select_club has always used).

    Returns:
        (adjusted_distance, list of adjustments applied)
    """
    has_weather_effect = weather is not None and (
        weather.wind_speed_mph >= 3
        or abs(weather.temperature_f - 70.0) >= 5
        or weather.altitude_ft > 500
        or weather.conditions in ("soft", "firm")
    )
    if abs(elevation_change_ft) <= 1 and not has_weather_effect:
        return raw_distance, []  # nothing to adjust — skip the solves

    bag = {
        c: int(d)
        for c, d in (club_distances or DEFAULT_CLUB_DISTANCES).items()
        if c in physics.CLUB_REFERENCE and d and d > 0
    } or dict(DEFAULT_CLUB_DISTANCES)

    adjustments: list[ShotAdjustment] = []

    # 1. Elevation — same club-aware Δh/tan(descent) number course_intel's
    # effective_yards speaks (physics.elevation_only_plays_like), so the
    # "treat it as X" context line and this breakdown never disagree.
    if abs(elevation_change_ft) > 1:
        elev_adj = physics.elevation_only_plays_like(raw_distance, elevation_change_ft) - raw_distance
        if elev_adj != 0:
            direction = "uphill" if elevation_change_ft > 0 else "downhill"
            adjustments.append(ShotAdjustment(
                type="elevation",
                yards=elev_adj,
                description=f"{abs(elevation_change_ft):.0f}ft {direction} — {'adds' if elev_adj > 0 else 'saves'} {abs(elev_adj)} yds",
            ))

    if weather:
        # Combined conditions once — wind vector, air density, landing grade.
        full_cond, _ = physics.conditions_from_weather(
            weather, shot_bearing,
            elevation_delta_ft=elevation_change_ft,
            carry_hint_yards=float(raw_distance),
        )

        # 2. Wind (isolated: the flight re-run with only the wind vector)
        if weather.wind_speed_mph >= 3:
            wind_adj = _isolated_delta(
                raw_distance, bag,
                physics.ShotConditions(head_mps=full_cond.head_mps, cross_mps=full_cond.cross_mps),
            )
            if wind_adj != 0:
                feel = "into/cross wind adds" if wind_adj > 0 else "helping wind saves"
                adjustments.append(ShotAdjustment(
                    type="wind",
                    yards=wind_adj,
                    description=f"{weather.wind_speed_mph:.0f}mph wind — {feel} {abs(wind_adj)} yds",
                ))

        # 3. Temperature (isolated: air density at this temp, sea-level pressure)
        if abs(weather.temperature_f - 70.0) >= 5:
            rho_temp = physics.air_density_kg_m3(weather.temperature_f, weather.humidity, 1013.25)
            temp_adj = _isolated_delta(raw_distance, bag, physics.ShotConditions(rho_kg_m3=rho_temp))
            if temp_adj != 0:
                direction = "cold" if temp_adj > 0 else "warm"
                adjustments.append(ShotAdjustment(
                    type="temperature",
                    yards=temp_adj,
                    description=f"{weather.temperature_f:.0f}°F ({direction}) — {'+' if temp_adj > 0 else ''}{temp_adj} yds",
                ))

        # 4. Altitude (isolated: barometric density at this elevation)
        if weather.altitude_ft > 500:
            rho_alt = physics.air_density_kg_m3(70.0, 50.0, None, altitude_ft=weather.altitude_ft)
            alt_adj = _isolated_delta(raw_distance, bag, physics.ShotConditions(rho_kg_m3=rho_alt))
            if alt_adj != 0:
                adjustments.append(ShotAdjustment(
                    type="altitude",
                    yards=alt_adj,
                    description=f"{weather.altitude_ft:.0f}ft elevation — ball carries {abs(alt_adj)} yds farther",
                ))

        # 5. Turf firmness (isolated: roll model only — physics says this only
        # moves shots judged by TOTAL, i.e. tee balls; an iron approach's
        # carry is untouched by firm/soft turf).
        if weather.conditions in ("soft", "firm"):
            cond_adj = _isolated_delta(
                raw_distance, bag, physics.ShotConditions(firmness=weather.conditions)
            )
            if cond_adj != 0:
                if weather.conditions == "soft":
                    desc = f"Soft conditions — less roll, plays {abs(cond_adj)} yds longer"
                else:
                    desc = f"Firm conditions — extra roll, plays {abs(cond_adj)} yds shorter"
                adjustments.append(ShotAdjustment(type="conditions", yards=cond_adj, description=desc))

        plays_like, _, _ = physics_plays_like(raw_distance, bag, full_cond)
    else:
        # Elevation-only: same combined solve, still air.
        cond, _ = physics.conditions_from_weather(
            None, shot_bearing,
            elevation_delta_ft=elevation_change_ft,
            carry_hint_yards=float(raw_distance),
        )
        plays_like, _, _ = physics_plays_like(raw_distance, bag, cond)

    return max(1, round(plays_like)), adjustments


def select_club(
    target_yards: int,
    club_distances: dict[str, int],
    bias: str = "moderate",
) -> tuple[str, int]:
    """Select the best club for a target distance.

    Args:
        target_yards: Adjusted distance to play
        club_distances: Player's club distances
        bias: 'conservative' (club up), 'moderate', 'aggressive' (club down)

    Returns:
        (club_name, club_distance)
    """
    distances = club_distances or DEFAULT_CLUB_DISTANCES

    # Sort clubs by distance descending
    clubs = sorted(distances.items(), key=lambda x: x[1], reverse=True)
    if not clubs:
        return ("7iron", 160)

    # DECADE principle: most amateurs miss short, so favor one more club
    bias_yards = 0
    if bias == "conservative":
        bias_yards = 5
    elif bias == "aggressive":
        bias_yards = -5

    target_with_bias = target_yards + bias_yards

    best_club = clubs[-1]  # shortest club as default
    for club, dist in clubs:
        if dist <= target_with_bias + 8:
            best_club = (club, dist)
            break

    return best_club
