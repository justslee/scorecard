"""Aim point and miss-side analysis engine (DECADE-inspired)."""

import math
from typing import Optional
from app.caddie.types import (
    AimPoint,
    MissSide,
    Hazard,
    HoleIntelligence,
    PlayerStatistics,
    CaddieRecommendation,
    ShotAdjustment,
    WeatherConditions,
)
from app.caddie.dispersion import get_dispersion
from app.caddie.club_selection import (
    select_club,
    compute_adjustments,
    normalize_club_distances,
    CLUB_DISPLAY_NAMES,
)
from app.caddie.strokes_gained import expected_strokes


def classify_pin_position(
    hole: HoleIntelligence,
) -> str:
    """Classify pin position using DECADE traffic light system.

    green  = center, no trouble nearby -> go at it
    yellow = near edge, some trouble -> aim between pin and center
    red    = tucked behind hazard, sucker pin -> aim center of green

    Without pin coordinates, we classify based on hazard proximity.
    """
    if not hole.hazards:
        return "green"

    # Count severe hazards close to the green
    severe_close = [
        h for h in hole.hazards
        if h.penalty_severity in ("severe", "death")
        and h.distance_from_green <= 10
    ]

    if len(severe_close) >= 2:
        return "red"
    elif len(severe_close) == 1:
        return "yellow"

    # Any death hazards nearby
    death_hazards = [h for h in hole.hazards if h.penalty_severity == "death"]
    if death_hazards:
        return "yellow"

    return "green"


def compute_aim_point(
    hole: HoleIntelligence,
    player_stats: Optional[PlayerStatistics],
    handicap: float = 15.0,
) -> AimPoint:
    """Compute where to aim based on hazards, green shape, and player tendencies.

    DECADE principles:
    - Green light pin: aim at the flag
    - Yellow light pin: aim between flag and center
    - Red light pin: aim center of green, ignore the flag
    - Always shift aim away from the "death side"
    """
    pin_light = classify_pin_position(hole)
    miss_dir = player_stats.tendencies.miss_direction if player_stats else "balanced"

    if pin_light == "green":
        description = "Aim at the flag — green light, no trouble"
    elif pin_light == "yellow":
        description = "Aim between the pin and center of green"
    else:
        description = "Aim center of green — sucker pin, don't chase it"

    # Shift aim away from death side
    death_sides = [h.side for h in hole.hazards if h.penalty_severity == "death"]
    if "right" in death_sides and miss_dir in ("right", "balanced"):
        description += ". Favor the left side — penalty right"
    elif "left" in death_sides and miss_dir in ("left", "balanced"):
        description += ". Favor the right side — penalty left"

    return AimPoint(description=description)


def compute_miss_side(
    hole: HoleIntelligence,
    player_stats: Optional[PlayerStatistics],
) -> MissSide:
    """Determine the preferred miss side and what to avoid.

    DECADE principle: identify the "recovery side" vs "death side"
    """
    if not hole.hazards:
        return MissSide(
            preferred="short",
            description="No major trouble — miss short for an easy chip",
            avoid="Avoid going long — harder to get up and down",
        )

    # Classify each side's penalty
    side_severity: dict[str, list[str]] = {
        "left": [],
        "right": [],
        "front": [],
        "back": [],
    }

    for h in hole.hazards:
        if h.side in side_severity and h.distance_from_green <= 20:
            side_severity[h.side].append(h.penalty_severity)

    # Find worst and best sides
    def severity_score(severities: list[str]) -> float:
        scores = {"mild": 1, "moderate": 2, "severe": 3, "death": 5}
        if not severities:
            return 0
        return max(scores.get(s, 0) for s in severities)

    left_score = severity_score(side_severity["left"])
    right_score = severity_score(side_severity["right"])
    front_score = severity_score(side_severity["front"])
    back_score = severity_score(side_severity["back"])

    # Determine preferred miss direction (lowest penalty)
    lr_options = []
    if left_score <= right_score:
        lr_options.append(("left", left_score, right_score))
    else:
        lr_options.append(("right", right_score, left_score))

    fb_options = []
    if front_score <= back_score:
        fb_options.append(("short", front_score, back_score))
    else:
        fb_options.append(("long", back_score, front_score))

    # Pick the best option
    best_lr = lr_options[0]
    best_fb = fb_options[0]

    # Prefer left/right miss preference over short/long
    preferred = best_lr[0] if best_lr[2] > best_fb[2] else best_fb[0]

    # Avoid descriptions
    avoid_map = {
        "left": "right",
        "right": "left",
        "short": "long",
        "long": "short",
    }
    avoid_side = avoid_map.get(preferred, "right")

    # Build descriptions
    def side_hazard_desc(side: str) -> str:
        hazards_on_side = [
            h for h in hole.hazards
            if h.side == side and h.distance_from_green <= 20
        ]
        if not hazards_on_side:
            return "open"
        types = set(h.type for h in hazards_on_side)
        parts = []
        if "water" in types:
            parts.append("water")
        if "bunker" in types:
            parts.append("bunker")
        if "ob" in types:
            parts.append("OB")
        if "trees" in types:
            parts.append("trees")
        return ", ".join(parts) if parts else "trouble"

    preferred_desc_suffix = side_hazard_desc(
        {"short": "front", "long": "back"}.get(preferred, preferred)
    )
    avoid_desc_suffix = side_hazard_desc(
        {"short": "front", "long": "back"}.get(avoid_side, avoid_side)
    )

    pref_label = {"short": "Short", "long": "Long", "left": "Left", "right": "Right"}

    if preferred_desc_suffix == "open":
        pref_text = f"Miss {pref_label.get(preferred, preferred).lower()} — safe side, easy recovery"
    else:
        pref_text = f"Miss {pref_label.get(preferred, preferred).lower()} — {preferred_desc_suffix} but manageable"

    avoid_text = f"Don't miss {avoid_side} — {avoid_desc_suffix}"

    return MissSide(
        preferred=preferred,
        description=pref_text,
        avoid=avoid_text,
    )


def generate_recommendation(
    hole: HoleIntelligence,
    distance_yards: int,
    club_distances: dict[str, int],
    handicap: float = 15.0,
    weather: Optional[WeatherConditions] = None,
    player_stats: Optional[PlayerStatistics] = None,
    shot_bearing: float = 0.0,
) -> CaddieRecommendation:
    """Generate a complete caddie recommendation for a shot.

    This is the main orchestrator that combines all engines.
    """
    # Normalize club distances
    clubs = normalize_club_distances(club_distances) if club_distances else {}

    # Compute adjusted distance
    adjusted_yards, adjustments = compute_adjustments(
        raw_distance=distance_yards,
        elevation_change_ft=hole.elevation_change_ft,
        weather=weather,
        shot_bearing=shot_bearing,
    )

    # Select club
    # DECADE bias: conservative for approach shots, moderate for tee shots
    is_tee_shot = distance_yards >= hole.yards * 0.85  # roughly tee shot distance
    bias = "moderate" if is_tee_shot else "conservative"
    club, club_dist = select_club(adjusted_yards, clubs, bias=bias)

    # Aim point
    aim = compute_aim_point(hole, player_stats, handicap)

    # Miss side
    miss = compute_miss_side(hole, player_stats)

    # Pin traffic light
    pin_light = classify_pin_position(hole)

    # Build reasoning
    reasoning: list[str] = []

    if adjustments:
        adj_summary = ", ".join(
            f"{a.type}: {'+' if a.yards > 0 else ''}{a.yards}y"
            for a in adjustments
        )
        reasoning.append(f"Distance adjustments: {adj_summary}")

    if adjusted_yards != distance_yards:
        reasoning.append(
            f"Plays {adjusted_yards} yards (raw {distance_yards})"
        )

    display_name = CLUB_DISPLAY_NAMES.get(club, club)
    reasoning.append(f"{display_name} ({club_dist}y) — best fit for {adjusted_yards}y")

    if pin_light == "red":
        reasoning.append("Red light pin — play to the center, don't short-side yourself")
    elif pin_light == "yellow":
        reasoning.append("Yellow light pin — aim between pin and center")

    if player_stats and player_stats.tendencies.miss_direction != "balanced":
        reasoning.append(
            f"Your miss tendency is {player_stats.tendencies.miss_direction} — aim point accounts for this"
        )

    if hole.player_history and hole.player_history.times_played >= 3:
        h = hole.player_history
        reasoning.append(
            f"Your history: avg {h.avg_score:.1f} (best {h.best_score}) in {h.times_played} rounds"
        )

    # Expected score
    exp_score = expected_strokes(distance_yards, "fairway", handicap)

    # Aggressiveness
    if pin_light == "red" or len([h for h in hole.hazards if h.penalty_severity == "death"]) >= 2:
        aggressiveness = "conservative"
    elif pin_light == "green" and not hole.hazards:
        aggressiveness = "aggressive"
    else:
        aggressiveness = "moderate"

    # Confidence based on data quality
    confidence = 0.5
    if weather:
        confidence += 0.15
    if hole.elevation_change_ft != 0:
        confidence += 0.1
    if player_stats and player_stats.rounds_analyzed > 5:
        confidence += 0.15
    if hole.hazards:
        confidence += 0.1
    confidence = min(confidence, 0.95)

    return CaddieRecommendation(
        club=club,
        target_yards=adjusted_yards,
        raw_yards=distance_yards,
        aim_point=aim,
        reasoning=reasoning,
        miss_side=miss,
        adjustments=adjustments,
        confidence=confidence,
        aggressiveness=aggressiveness,
        expected_score=round(exp_score, 2),
    )
