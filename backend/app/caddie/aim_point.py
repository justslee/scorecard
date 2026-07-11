"""Aim point and miss-side analysis engine (DECADE-inspired)."""

from typing import Optional
from app.caddie.types import (
    AimPoint,
    MissSide,
    Hazard,
    HoleIntelligence,
    PlayerStatistics,
    CaddieRecommendation,
    WeatherConditions,
)
from app.caddie.club_selection import (
    select_club,
    compute_adjustments,
    normalize_club_distances,
    CLUB_DISPLAY_NAMES,
    DEFAULT_CLUB_DISTANCES,
)
from app.caddie.strokes_gained import expected_strokes, personal_lookup
from app.caddie.slope_advice import slope_miss_advice
from app.caddie.shot_line_advice import shot_line_advice
from app.caddie.decade_advice import (
    decade_aim_advice,
    decade_landing_advice,
    drive_zone_hazards,
    cross_hazard_line,
)

# ── Reasoning priority cap ────────────────────────────────────────────────────
#
# The voice caddie reads reasoning lines aloud, so brevity matters.
# Priorities (lower = more important; always shown first):
#   P0 — club/distance fit line       ALWAYS kept, ALWAYS first
#   P1 — safety-critical              pin light (red/yellow), DECADE hazard-aim,
#                                     competition-legal note
#   P2 — slope miss-advice + miss     green-slope advice, player miss tendency
#   P3 — shot-line terrain advice     terrain shape (elevated green, ridge, swale…)
#   P4 — color                        player history, personal-stats note,
#                                     generic distance-adjustment summary
#
MAX_REASONING_ITEMS: int = 4


def prioritize_reasoning(
    items: list[tuple[int, str]],
    max_items: int = MAX_REASONING_ITEMS,
) -> list[str]:
    """Sort reasoning items by priority and cap to *max_items*.

    Args:
        items: Sequence of ``(priority, text)`` tuples.  Lower priority value
               means more important (P0 is always shown first).
        max_items: Maximum number of lines to return.  The P0 club/distance fit
                   line is never dropped even when *max_items* < total items.

    Returns:
        Ordered, trimmed list of text strings — priorities stripped.
    """
    # Stable sort: Python's sort is stable, so same-priority items keep
    # their original insertion order.
    sorted_items = sorted(items, key=lambda x: x[0])

    if len(sorted_items) <= max_items:
        return [text for _, text in sorted_items]

    # Always preserve P0 (the club line) regardless of the cap.
    p0_items = [(p, t) for p, t in sorted_items if p == 0]
    rest = [(p, t) for p, t in sorted_items if p > 0]

    remaining_slots = max_items - len(p0_items)
    trimmed = p0_items + rest[:remaining_slots]
    return [text for _, text in trimmed]


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


# ── Reachability classification (positioning shots) ────────────────────────
#
# specs/caddie-shot-context-reachability-plan.md §1 (owner incident
# 2026-07-06: "aim 9y left of the flag" on a 400y par-4 tee shot — the green
# was never in reach, so any pin-relative aim was wrong golf reasoning).
# When the best club in the bag can't reach the green (plus a front-edge
# margin), the shot is a POSITIONING shot: the flag doesn't exist for this
# swing — see compute_positioning_aim / compute_positioning_miss_side below.

# Distance-to-green is (nearly always) to the CENTER of the green; a ball
# finishing on the front edge has still reached it. Half a typical green
# depth; overridden by the hole's real measured depth when mapped.
GREEN_REACH_MARGIN_YDS: int = 15


def is_green_reachable(
    adjusted_yards: int,
    clubs: dict[str, int],
    green_depth_yards: Optional[float] = None,
) -> bool:
    """Can ANY club in the bag reach the green on this swing?

    `adjusted_yards` is already the physics plays-like distance
    (`compute_adjustments`, anchored to this player's bag) — the same number
    `select_club` compares against — so wind/elevation move the reachability
    verdict for free, and `get_recommendation` can never disagree with
    itself about it within a turn. Bag fallback is `DEFAULT_CLUB_DISTANCES`,
    the same fallback `select_club` has always used — never a fabricated
    number. Margin = front-edge allowance: `green_depth_yards / 2` when the
    green is mapped, else `GREEN_REACH_MARGIN_YDS`.
    """
    distances = clubs or DEFAULT_CLUB_DISTANCES
    max_reach = max(distances.values())
    margin = (green_depth_yards / 2.0) if green_depth_yards else GREEN_REACH_MARGIN_YDS
    return max_reach + margin >= adjusted_yards


def compute_positioning_miss_side(zone: list[Hazard]) -> MissSide:
    """Sibling of `compute_miss_side`, but over the driving-zone hazards
    (`drive_zone_hazards` — the tee-anchored `carry_yards` frame) instead of
    green-side hazards. Prefers the lateral side with less risk in THIS
    shot's landing window; no in-zone hazard data degrades to an honest
    generic (nothing fabricated).
    """
    if not zone:
        return MissSide(
            preferred="short",
            description="No mapped trouble in the driving zone — worst case is a longer approach",
            avoid="Don't chase distance you don't need",
        )

    def severity_score(hzds: list[Hazard]) -> float:
        scores = {"mild": 1, "moderate": 2, "severe": 3, "death": 5}
        if not hzds:
            return 0
        return max(scores.get(h.penalty_severity, 0) for h in hzds)

    left = [h for h in zone if h.line_side.lower() == "left"]
    right = [h for h in zone if h.line_side.lower() == "right"]
    left_score = severity_score(left)
    right_score = severity_score(right)

    if left_score <= right_score:
        preferred, worst_side, worst_hazards = "left", "right", right
    else:
        preferred, worst_side, worst_hazards = "right", "left", left

    if worst_hazards:
        types_desc = ", ".join(sorted({h.type for h in worst_hazards}))
        avoid = f"Don't miss {worst_side} — {types_desc}"
        description = f"Favor the {preferred} side off the tee — {worst_side} has trouble in the driving zone"
    else:
        avoid = f"Don't miss {worst_side}"
        description = f"Favor the {preferred} side off the tee"

    return MissSide(preferred=preferred, description=description, avoid=avoid)


def compute_positioning_aim(
    leave_yards: int,
    landing_advice: Optional[str] = None,
) -> AimPoint:
    """Composes the positioning-shot AimPoint description shown in
    CaddiePanel and spoken via the "Last recommendation" prompt lines.

    `landing_advice` is the (already-computed, possibly `None`)
    `decade_landing_advice` string — passed in rather than recomputed so the
    optimizer runs exactly once per recommendation. Only the directional
    clause ("favor the right half of the fairway") is folded into the aim
    description; the hazard specifics ride along separately as their own
    P1 reasoning line. `lat`/`lng`/`bearing` stay `None`, same as today's
    reachable path.
    """
    if landing_advice:
        side_clause = landing_advice.split(" — ", 1)[0]
        side_clause = side_clause[0].lower() + side_clause[1:]
    else:
        side_clause = "middle of the fairway"
    description = f"Positioning shot — green's out of reach. {side_clause}; leaves about {leave_yards} in."
    return AimPoint(description=description)


def generate_recommendation(
    hole: HoleIntelligence,
    distance_yards: int,
    club_distances: dict[str, int],
    handicap: float = 15.0,
    weather: Optional[WeatherConditions] = None,
    player_stats: Optional[PlayerStatistics] = None,
    shot_bearing: float = 0.0,
    competition_legal: bool = False,
) -> CaddieRecommendation:
    """Generate a complete caddie recommendation for a shot.

    This is the main orchestrator that combines all engines.

    When ``competition_legal`` is True the recommendation is USGA-conforming:
    no environmental distance adjustments are applied (target_yards == raw_yards,
    adjustments list is empty).  Aim/miss-side/strategy logic is unchanged —
    only the yardage calculation is locked to raw geometric distance.
    """
    # Normalize club distances
    clubs = normalize_club_distances(club_distances) if club_distances else {}

    # Compute adjusted distance.
    # Competition-legal mode: skip ALL environmental adjustments so the yardage
    # the golfer uses is pure geometric distance — the only number permitted by
    # the USGA for distance-measuring devices in competition.
    if competition_legal:
        adjusted_yards = distance_yards
        adjustments = []
    else:
        adjusted_yards, adjustments = compute_adjustments(
            raw_distance=distance_yards,
            elevation_change_ft=hole.elevation_change_ft,
            weather=weather,
            shot_bearing=shot_bearing,
            club_distances=clubs,  # anchors the physics solve to the player's bag
        )

    # Select club
    # DECADE bias: conservative for approach shots, moderate for tee shots.
    # hole.yards is None when yardage is unknown (no fake fallback) — treat
    # as an approach shot (conservative) rather than crashing on None * 0.85.
    is_tee_shot = hole.yards is not None and distance_yards >= hole.yards * 0.85
    bias = "moderate" if is_tee_shot else "conservative"
    club, club_dist = select_club(adjusted_yards, clubs, bias=bias)

    # Reachability classification (specs/caddie-shot-context-reachability-plan.md).
    # Reachable → today's flag-relative path, byte-identical. Not reachable →
    # positioning shot: the flag doesn't exist for this swing, landing-zone
    # advice instead (owner incident 2026-07-06: pin-relative aim on an
    # unreachable 400y tee shot).
    reachable = is_green_reachable(adjusted_yards, clubs, hole.green_depth_yards)
    max_reach = max((clubs or DEFAULT_CLUB_DISTANCES).values())
    leave_yards: Optional[int] = None
    if not reachable:
        leave_yards = round(max(0, adjusted_yards - club_dist) / 5) * 5

    # Aim point / miss side / pin light — branch on reachability.
    zone: list[Hazard] = []
    landing_advice: Optional[str] = None
    pin_light: Optional[str] = None
    if reachable:
        aim = compute_aim_point(hole, player_stats, handicap)
        miss = compute_miss_side(hole, player_stats)
        pin_light = classify_pin_position(hole)
    else:
        # Driving-zone window around THIS shot's expected advance — not the
        # green-side frame. classify_pin_position is skipped: pin light is a
        # green concept and doesn't apply when the green isn't in play.
        zone = drive_zone_hazards(hole.hazards, float(club_dist))
        landing_advice = decade_landing_advice(
            hole.hazards, float(club_dist), float(leave_yards), handicap=handicap,
        )
        aim = compute_positioning_aim(leave_yards, landing_advice)
        miss = compute_positioning_miss_side(zone)

    # Build reasoning as (priority, text) tuples; see prioritize_reasoning for
    # the full priority scheme.  Order of appends within a priority is preserved
    # (stable sort), so add items in the order you want them to appear when two
    # items share a priority level.
    _r: list[tuple[int, str]] = []

    # Distance context: P1 for competition-legal (safety-critical), P4 otherwise (color)
    if competition_legal:
        _r.append((1, "Competition-legal mode: distance adjustments disabled (USGA conforming)"))
    elif adjustments:
        adj_summary = ", ".join(
            f"{a.type}: {'+' if a.yards > 0 else ''}{a.yards}y"
            for a in adjustments
        )
        _r.append((4, f"Distance adjustments: {adj_summary}"))

    # P4 — adjusted distance note (color; the club line already shows the adjusted yards)
    if adjusted_yards != distance_yards:
        _r.append((4, f"Plays {adjusted_yards} yards (raw {distance_yards})"))

    # P0 — club/distance fit line (ALWAYS kept, ALWAYS first)
    display_name = CLUB_DISPLAY_NAMES.get(club, club)
    _r.append((0, f"{display_name} ({club_dist}y) — best fit for {adjusted_yards}y"))

    if reachable:
        # P1 — safety-critical: pin traffic-light warning
        if pin_light == "red":
            _r.append((1, "Red light pin — play to the center, don't short-side yourself"))
        elif pin_light == "yellow":
            _r.append((1, "Yellow light pin — aim between pin and center"))
    else:
        # P1 — positioning-shot call-out (the fix for the incident: never a
        # pin-relative aim when the green is out of reach on this swing).
        _r.append((
            1,
            f"Green's out of reach ({adjusted_yards}y; your longest club is {max_reach}y)"
            f" — positioning shot, leaves about {leave_yards} in",
        ))
        # P1 — driving-zone DECADE landing advice + any dead-ahead cross hazard.
        if landing_advice:
            _r.append((1, landing_advice))
        cross_line = cross_hazard_line(zone, float(club_dist))
        if cross_line:
            _r.append((1, cross_line))
        # P2 — fairway-bend-in-window line (honest reuse of HoleBend; omitted
        # when bend is None, per the unmapped-vs-straight discipline in hazards.py).
        bend = hole.bend
        if (
            bend is not None
            and not bend.straight
            and bend.distance_yards is not None
            and (club_dist - 60) <= bend.distance_yards <= (club_dist + 60)
        ):
            _r.append((
                2,
                f"Fairway bends {bend.direction} at ~{bend.distance_yards}"
                " — that corner is your landing zone",
            ))

    # P2 — miss-tendency note (directly affects where to aim)
    if player_stats and player_stats.tendencies.miss_direction != "balanced":
        _r.append((
            2,
            f"Your miss tendency is {player_stats.tendencies.miss_direction}"
            " — aim point accounts for this",
        ))

    # P4 — player history on this hole (color / motivational)
    if hole.player_history and hole.player_history.times_played >= 3:
        h = hole.player_history
        _r.append((
            4,
            f"Your history: avg {h.avg_score:.1f} (best {h.best_score})"
            f" in {h.times_played} rounds",
        ))

    if reachable:
        # P2 — green-slope tactical advice (affects where to miss). Slope is a
        # green-frame concept — skipped on the positioning path.
        # Additive only; does NOT affect club, target, or miss_side.
        slope_advice = slope_miss_advice(hole.green_slope, shot_bearing)
        if slope_advice:
            _r.append((2, slope_advice))

        # P3 — shot-line terrain advice (terrain SHAPE color)
        # Fires only when a pre-sampled elevation profile is attached (via
        # hole.shot_line_profile_ft, populated by the route handler). Terminal
        # terrain/green color — skipped on the positioning path so the
        # "zero flag/green-frame reference" gate stays clean.
        # Additive only; does NOT affect club, target, or miss_side.
        sl_advice = shot_line_advice(hole.shot_line_profile_ft or [], distance_yards)
        if sl_advice:
            _r.append((3, sl_advice))

        # P1 — DECADE expected-strokes aim advice (safety-critical lateral shift)
        # Additive only; does NOT affect club, target, aim_point, or miss_side.
        # Handicap forwarded so dispersion is personalised. This is the
        # incident sentence class ("aim ~9y left of the flag") — never fires
        # on the positioning path (the landing-zone advice above replaces it).
        d_advice = decade_aim_advice(hole.hazards, float(distance_yards), handicap=handicap)
        if d_advice:
            _r.append((1, d_advice))

    # Expected score — pulls from personal_sg first, falls back to PGA baseline.
    # Gate the reasoning text on the actual lookup outcome rather than the
    # dict shape, so we don't claim "personal stats" when the personal table
    # has empty buckets or no `mean_strokes` and the value silently came from
    # the PGA fallback.
    personal_sg = player_stats.personal_sg if player_stats else None
    personal_value = personal_lookup(distance_yards, "fairway", personal_sg)
    if personal_value is not None:
        exp_score = personal_value
        sample_count = sum(
            b.get("samples", 0)
            for b in (personal_sg.get("fairway") or {}).values()
            if isinstance(b, dict) and b.get("mean_strokes") is not None
        )
        if sample_count > 0:
            # P4 — personal-stats note (color; useful but not safety-critical)
            _r.append((
                4,
                f"Expected score uses your personal stats ({sample_count} fairway shots logged)",
            ))
    else:
        exp_score = expected_strokes(distance_yards, "fairway", handicap)

    # Apply priority sort + cap → final reasoning list (calm, voice-readable)
    reasoning = prioritize_reasoning(_r)

    # Aggressiveness
    if reachable:
        if pin_light == "red" or len([h for h in hole.hazards if h.penalty_severity == "death"]) >= 2:
            aggressiveness = "conservative"
        elif pin_light == "green" and not hole.hazards:
            aggressiveness = "aggressive"
        else:
            aggressiveness = "moderate"
    else:
        aggressiveness = "conservative" if any(h.penalty_severity == "death" for h in zone) else "moderate"

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
        competition_legal=competition_legal,
        shot_kind="positioning" if not reachable else "approach",
        leave_yards=leave_yards if not reachable else None,
    )
