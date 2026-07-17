"""Aim point and miss-side analysis engine (DECADE-inspired)."""

from typing import NamedTuple, Optional
from app.caddie import physics
from app.caddie.types import (
    AimPoint,
    MissSide,
    CorridorSample,
    Hazard,
    HoleIntelligence,
    PlayerStatistics,
    CaddieRecommendation,
    TeeShotNumbers,
    WeatherConditions,
)
from app.caddie.club_selection import (
    select_club,
    compute_adjustments,
    normalize_club_distances,
    CLUB_DISPLAY_NAMES,
    DEFAULT_CLUB_DISTANCES,
)
from app.caddie.dispersion import get_dispersion
from app.caddie.hazards import corridor_sample_at
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

    Owner incident (Bethpage Black hole 1, specs/caddie-numbers-coherence-plan
    .md §1.4 / §3.1): trees mapped on BOTH sides of the drive zone, equal
    severity — a bare `<=` tie-break spoke a confident "favor the left side"
    when there was no good miss. A true both-sides tie now degrades honestly
    to `preferred="center"` / "no good miss, commit to the fairway" instead
    of picking a side to sound decisive. A clear winner that ALSO has mapped
    trouble says so, rather than a clean "favor X" that hides X's own risk.
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

    def types_desc(hzds: list[Hazard]) -> str:
        return ", ".join(sorted({h.type for h in hzds}))

    left = [h for h in zone if h.line_side.lower() == "left"]
    right = [h for h in zone if h.line_side.lower() == "right"]
    left_score = severity_score(left)
    right_score = severity_score(right)

    if left_score > 0 and right_score > 0 and left_score == right_score:
        # Honest both-sides degradation — the Bethpage-1 fix. Never a
        # one-sided preference when the data shows trouble on both sides.
        return MissSide(
            preferred="center",
            description=(
                f"Trouble both sides in the driving zone — {types_desc(left + right)} left "
                "and right. No good miss; commit to the fairway."
            ),
            avoid="Don't favor either side — the fairway is the only safe ground",
        )

    if left_score <= right_score:
        preferred, worst_side, worst_hazards, pref_hazards = "left", "right", right, left
    else:
        preferred, worst_side, worst_hazards, pref_hazards = "right", "left", left, right

    if worst_hazards:
        types_str = types_desc(worst_hazards)
        avoid = f"Don't miss {worst_side} — {types_str}"
        if pref_hazards:
            # The preferred side is the LESSER risk, but it isn't safe —
            # never a clean "favor X" that hides X's own mapped trouble.
            description = (
                f"Favor the {preferred} side — {worst_side} is worse ({types_str}), but "
                f"{types_desc(pref_hazards)} {preferred} are in play too."
            )
        else:
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


# ── Tee-shot numbers (specs/caddie-numbers-coherence-plan.md §2.2) ─────────
#
# Owner incident (2026-07, Bethpage Black hole 1, 466y par 4): the caddie
# spoke a leave of 125, a raw driver of 300, and a physics total of 280 —
# three numbers from three unconnected sources that never had to agree. This
# is the ONE place a positioning shot's numbers are computed, so every mouth
# speaks the same closing arithmetic.


def physics_drive_total(
    hole: HoleIntelligence,
    club: str,
    club_dist: int,
    weather: Optional[WeatherConditions],
    shot_bearing: float,
    competition_legal: bool,
) -> tuple[Optional[int], int]:
    """The physics-delivered drive for `club` in today's conditions.

    Returns `(drive_carry_yards, drive_total_yards)` through the EXACT SAME
    call shape as the `get_shot_distance` tool
    (`tools.py::shot_distance_payload`) — the single source of truth for a
    club's drive total. Every caller (reachability classification,
    `compute_tee_shot_numbers`) goes through THIS function so the numbers
    can never diverge from a second, independently-rounded physics call
    (specs/caddie-numbers-coherence-plan.md §2.2 — a downhill-short-hole
    frame mismatch between the reachability check and the drive-total
    calculation was the exact confabulation trigger this closes).
    """
    if competition_legal:
        # USGA-conforming: no environmental physics anywhere in the block —
        # the drive total IS the stored number, still closes exactly.
        return None, club_dist

    cond, _ = physics.conditions_from_weather(
        weather, shot_bearing,
        elevation_delta_ft=hole.elevation_change_ft,
        carry_hint_yards=float(club_dist),
    )
    result = physics.shot_distance_for_club(club, float(club_dist), cond)
    return round(result.carry_yards), round(result.total_yards)


def compute_tee_shot_numbers(
    hole: HoleIntelligence,
    distance_yards: int,
    adjusted_yards: int,
    club: str,
    club_dist: int,
    weather: Optional[WeatherConditions],
    shot_bearing: float,
    competition_legal: bool,
    yardage_basis: Optional[str] = None,
    drive_yards: Optional[tuple[Optional[int], int]] = None,
) -> "TeeShotNumbers":
    """The one authoritative numbers block for a positioning/tee shot.

    Drive physics run through `physics_drive_total` — the EXACT SAME call
    shape as the `get_shot_distance` tool — physics parity by construction,
    not convention. `drive_yards`, when provided, is the ALREADY-COMPUTED
    `(carry, total)` pair from the reachability check upstream in
    `generate_recommendation` — reused verbatim rather than recomputed, so
    the drive numbers this block prints are byte-identical to the ones that
    decided reachability (never a second, independently-rounded call that
    could diverge). `leave_exact_yards` is the raw closing arithmetic
    (`to_green_yards - drive_total_yards`, SIGNED — may be <= 0 on a
    residual sub-boundary case); `leave_yards` is its round-to-5, floored-at-
    0 spoken form. `leave_plays_like_yards` keeps today's plays-like-frame
    number as a labeled extra, never the primary leave
    (specs/caddie-numbers-coherence-plan.md §2.2's documented leave-frame
    redefinition — the raw frame is what the golfer's own arithmetic checks,
    so it's the frame the caddie now speaks).
    """
    if drive_yards is not None:
        drive_carry_yards, drive_total_yards = drive_yards
    else:
        drive_carry_yards, drive_total_yards = physics_drive_total(
            hole, club, club_dist, weather, shot_bearing, competition_legal,
        )

    leave_exact_yards = distance_yards - drive_total_yards
    leave_yards = round(max(0, leave_exact_yards) / 5) * 5
    leave_plays_like_yards = round(max(0, adjusted_yards - club_dist) / 5) * 5

    return TeeShotNumbers(
        hole_number=hole.hole_number,
        to_green_yards=distance_yards,
        yardage_basis=yardage_basis,
        plays_like_yards=adjusted_yards,
        club=club,
        club_stored_yards=club_dist,
        drive_carry_yards=drive_carry_yards,
        drive_total_yards=drive_total_yards,
        leave_exact_yards=leave_exact_yards,
        leave_yards=leave_yards,
        leave_plays_like_yards=leave_plays_like_yards,
    )


# ── Corridor v1 — bend-aware club cap (specs/caddie-numbers-coherence-plan.md
# §4.1). Bend-cap ONLY: full corridor-width club selection (§4.4) is a
# fully-specified follow-up, not built here. Owner incident (Bethpage RED 3):
# "driver by default" flew through a mapped corner into trees the engine
# already knew about (HoleIntelligence.bend) but never consulted for club.

# Tolerance before a drive is judged to "overshoot" a mapped corner — small
# enough to still catch a real fly-through, generous enough that a drive
# landing essentially AT the corner doesn't false-positive.
CORNER_OVERSHOOT_TOLERANCE_YDS: int = 10

# A corridor cap never fires on a corner mapped closer than this — inside
# this range the whole "which club reaches the corner" question is moot
# (every club in a normal bag lands short of it anyway).
CORNER_MIN_DISTANCE_YDS: int = 120

# Tree evidence must sit within this many yards SHORT of the mapped corner to
# count as "guarding" it — a stand well short of the corner isn't the hazard
# that punishes flying through the bend itself.
CORNER_TREE_LOOKBACK_YDS: int = 20

_SEVERITY_RANK: dict[str, int] = {"mild": 1, "moderate": 2, "severe": 3, "death": 5}
_MODERATE_RANK: int = _SEVERITY_RANK["moderate"]


def _select_club_capped_at(
    clubs: dict[str, int],
    max_total_yards: float,
    weather: Optional[WeatherConditions],
    shot_bearing: float,
    elevation_change_ft: float,
    competition_legal: bool,
) -> Optional[tuple[str, int]]:
    """Longest club in the bag whose CONDITIONS TOTAL lands short of
    `max_total_yards` — walks the bag descending, re-running
    `shot_distance_for_club` per candidate (competition_legal walks stored
    numbers, same USGA-conforming rule `compute_tee_shot_numbers` follows).
    `None` when even the shortest club in the bag overshoots — no club helps,
    so the caller keeps today's recommendation rather than fabricate a cap.
    """
    bag = clubs or DEFAULT_CLUB_DISTANCES
    for candidate, dist in sorted(bag.items(), key=lambda x: x[1], reverse=True):
        if competition_legal:
            total = float(dist)
        else:
            cond, _ = physics.conditions_from_weather(
                weather, shot_bearing,
                elevation_delta_ft=elevation_change_ft,
                carry_hint_yards=float(dist),
            )
            total = physics.shot_distance_for_club(candidate, float(dist), cond).total_yards
        if total <= max_total_yards:
            return candidate, dist
    return None


# ── Corridor-width club selection (specs/corridor-width-club-selection-plan.
# md §4.4/§6, follow-up to the bend-cap above). Owner complaint: "driver
# doesn't seem like the play at all and brings in the danger." Recommends the
# longest club whose dispersion-informed landing zone fits the effective
# corridor (danger-to-danger, NOT fairway edges — see hazards.py's
# extract_corridor_profile docstring / the plan's Honesty section for the
# arithmetic proof that a fairway-edge rule would cap a 15-handicap to an
# 8-iron on nearly every tee) at that club's landing distance.
#
# Precedence: runs AFTER the v1 bend-cap block, ceiling = the (possibly
# already-capped) club's drive_total_yards — it can only shorten further,
# never relax the bend-cap (take-the-shorter composition).


def _club_fit_window_yds(club: str, handicap: float) -> float:
    """±1.5σ landing-window half-... full-width, per §4.4's contract:
    `width_yards` from `get_dispersion` is the ±2σ (95%) lateral spread
    (σ = width/4), so ±1.5σ = 0.75 × width_yards. Demanding the full ±2σ cone
    would bench driver on virtually every tree-lined hole (a 15-hcp cone is
    75y — wider than most danger corridors); ±1.5σ (~87% of shots inside) is
    the calibrated line between "driver only when it genuinely fits" and
    over-clubbing-down everywhere."""
    return 0.75 * get_dispersion(club, handicap)["width_yards"]


def _pinch_word(sample: CorridorSample) -> str:
    """Feature word for the WHY note — justified by the SAME sample's own
    source fields, never a new claim: both sides trees -> "tree lines", both
    water -> "water", anything mixed -> the generic "trouble"."""
    if sample.left_source == "trees" and sample.right_source == "trees":
        return "tree lines"
    if sample.left_source == "water" and sample.right_source == "water":
        return "water"
    return "trouble"


class CorridorFit(NamedTuple):
    club: str
    dist: int
    chosen_sample: Optional[CorridorSample]
    rejected_club: Optional[str]
    rejected_total: Optional[int]
    rejected_sample: Optional[CorridorSample]


def _select_club_fitting_corridor(
    clubs: dict[str, int],
    corridor: list[CorridorSample],
    handicap: float,
    weather: Optional[WeatherConditions],
    shot_bearing: float,
    elevation_change_ft: float,
    competition_legal: bool,
    ceiling_total_yards: float,
) -> Optional[CorridorFit]:
    """Longest club in the bag whose ±1.5σ fit window (`_club_fit_window_yds`)
    fits the corridor's danger-to-danger width at that candidate's OWN
    conditions total — same bag-descending walk, same per-candidate
    `physics.shot_distance_for_club` call shape as `_select_club_capped_at`.

    `ceiling_total_yards` is the current (possibly already bend-capped)
    club's `drive_total_yards` — candidates whose total exceeds it are
    skipped outright (never undoes the bend-cap; the two rules compose
    take-the-shorter). An unknown width at a candidate's landing distance
    (`corridor_sample_at` returns `None`, or a known sample with
    `width_yards is None`) NEVER rejects that candidate — the walk accepts
    immediately. `None` when nothing in the bag fits anywhere (including
    "everything exceeds the ceiling") — the caller keeps today's club, same
    "no club helps, don't fabricate a cap" philosophy as
    `_select_club_capped_at` returning `None`.
    """
    bag = clubs or DEFAULT_CLUB_DISTANCES
    first_rejection: Optional[tuple[str, int, CorridorSample]] = None
    for candidate, dist in sorted(bag.items(), key=lambda x: x[1], reverse=True):
        if competition_legal:
            total = float(dist)
        else:
            cond, _ = physics.conditions_from_weather(
                weather, shot_bearing,
                elevation_delta_ft=elevation_change_ft,
                carry_hint_yards=float(dist),
            )
            total = physics.shot_distance_for_club(candidate, float(dist), cond).total_yards
        # Round before the ceiling comparison — `ceiling_total_yards` is
        # itself a ROUNDED physics total (`physics_drive_total` rounds via
        # `round()`), so comparing an unrounded per-candidate total against
        # it can spuriously exclude the very club that produced the ceiling
        # (e.g. 283.4 > 283) on a straight sub-yard rounding boundary.
        total = round(total)
        if total > ceiling_total_yards:
            continue  # never undo the bend-cap — not a "rejection" for pinch reporting

        sample = corridor_sample_at(corridor, total)
        if sample is None or sample.width_yards is None:
            # Unknown width never rejects.
            return CorridorFit(
                club=candidate, dist=dist, chosen_sample=sample,
                rejected_club=first_rejection[0] if first_rejection else None,
                rejected_total=first_rejection[1] if first_rejection else None,
                rejected_sample=first_rejection[2] if first_rejection else None,
            )

        window = _club_fit_window_yds(candidate, handicap)
        if window <= sample.width_yards:
            return CorridorFit(
                club=candidate, dist=dist, chosen_sample=sample,
                rejected_club=first_rejection[0] if first_rejection else None,
                rejected_total=first_rejection[1] if first_rejection else None,
                rejected_sample=first_rejection[2] if first_rejection else None,
            )

        if first_rejection is None:
            first_rejection = (candidate, total, sample)

    return None


def generate_recommendation(
    hole: HoleIntelligence,
    distance_yards: int,
    club_distances: dict[str, int],
    handicap: float = 15.0,
    weather: Optional[WeatherConditions] = None,
    player_stats: Optional[PlayerStatistics] = None,
    shot_bearing: float = 0.0,
    competition_legal: bool = False,
    yardage_basis: Optional[str] = None,
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

    # Reachability classification (specs/caddie-shot-context-reachability-plan.md,
    # specs/caddie-numbers-coherence-plan.md §2.2 frame-alignment fix).
    # Reachable → today's flag-relative path, byte-identical. Not reachable →
    # positioning shot: the flag doesn't exist for this swing, landing-zone
    # advice instead (owner incident 2026-07-06: pin-relative aim on an
    # unreachable 400y tee shot).
    #
    # A drive whose PHYSICS total reaches the raw to-green distance is
    # reachable even when the still-air plays-like frame (`is_green_reachable`)
    # says otherwise — e.g. a steep-downhill short hole where the physics
    # elevation boost carries the selected club's drive past the green while
    # the still-air check (which never sees elevation) still fails it. The
    # physics frame is the truthful one: it's the same number the drive-total
    # equation prints, so the two can never disagree about whether the hole
    # is drivable (the exact confabulation trigger this closes — a drive
    # total >= the hole with a printed "leaves 0" positioning block).
    # Computed ONCE here and reused verbatim in `compute_tee_shot_numbers`
    # below so the drive numbers stay parity-identical — never a second,
    # independently-rounded physics call that could diverge.
    selected_drive_yards = physics_drive_total(
        hole, club, club_dist, weather, shot_bearing, competition_legal,
    )
    reachable = (
        is_green_reachable(adjusted_yards, clubs, hole.green_depth_yards)
        or selected_drive_yards[1] >= distance_yards
    )
    max_reach = max((clubs or DEFAULT_CLUB_DISTANCES).values())
    leave_yards: Optional[int] = None
    tee_shot_numbers: Optional[TeeShotNumbers] = None
    corridor_note: Optional[str] = None

    # Aim point / miss side / pin light — branch on reachability.
    zone: list[Hazard] = []
    landing_advice: Optional[str] = None
    pin_light: Optional[str] = None
    if reachable:
        aim = compute_aim_point(hole, player_stats, handicap)
        miss = compute_miss_side(hole, player_stats)
        pin_light = classify_pin_position(hole)
    else:
        # ONE authoritative numbers block (specs/caddie-numbers-coherence-plan
        # .md §2.2) — everything downstream (leave, aim, landing advice, the
        # P0/P1 reasoning lines) speaks THIS block's leave, never a
        # separately-derived number. `drive_yards` reuses the exact physics
        # call that decided reachability above — same club, same conditions.
        tee_shot_numbers = compute_tee_shot_numbers(
            hole, distance_yards, adjusted_yards, club, club_dist,
            weather, shot_bearing, competition_legal, yardage_basis,
            drive_yards=selected_drive_yards,
        )

        # Corridor v1 — bend-aware club cap (§4.1, bend-cap only; the full
        # corridor-width follow-up is §4.4, not built here). A mapped corner
        # with tree evidence guarding it, that this club's drive would fly
        # through, caps the club to one that lands short of the corner —
        # "driver by default" dies structurally for mapped corners.
        bend = hole.bend
        if (
            bend is not None
            and not bend.straight
            and bend.distance_yards is not None
            and bend.distance_yards >= CORNER_MIN_DISTANCE_YDS
            and tee_shot_numbers.drive_total_yards > bend.distance_yards + CORNER_OVERSHOOT_TOLERANCE_YDS
        ):
            corner_trees = [
                h for h in hole.hazards
                if h.type == "trees"
                and h.carry_yards >= bend.distance_yards - CORNER_TREE_LOOKBACK_YDS
                and _SEVERITY_RANK.get(h.penalty_severity, 0) >= _MODERATE_RANK
            ]
            if corner_trees:
                capped = _select_club_capped_at(
                    clubs, float(bend.distance_yards - 5),
                    weather, shot_bearing, hole.elevation_change_ft, competition_legal,
                )
                if capped is not None and capped[0] != club:
                    old_club_display = CLUB_DISPLAY_NAMES.get(club, club)
                    club, club_dist = capped
                    new_club_display = CLUB_DISPLAY_NAMES.get(club, club)
                    tee_shot_numbers = compute_tee_shot_numbers(
                        hole, distance_yards, adjusted_yards, club, club_dist,
                        weather, shot_bearing, competition_legal, yardage_basis,
                    )
                    corridor_note = (
                        f"{old_club_display} runs through the corner at ~{bend.distance_yards} "
                        f"into the trees — {new_club_display} keeps you short of it, leaves "
                        f"about {tee_shot_numbers.leave_yards}."
                    )

        # Corridor-width club selection (§4.4 follow-up) — runs AFTER v1
        # bend-cap, ceiling = the (possibly already bend-capped) club's
        # drive_total_yards, so it can only shorten further (take-the-
        # shorter composition, plan §1). `hole.corridor` falsy (None or `[]`)
        # -> this entire block is skipped -> byte-identical v1 payload
        # (the only difference: the new corridor_* keys stay `None`).
        if hole.corridor:
            fit = _select_club_fitting_corridor(
                clubs, hole.corridor, handicap, weather, shot_bearing,
                hole.elevation_change_ft, competition_legal,
                ceiling_total_yards=tee_shot_numbers.drive_total_yards,
            )
            if fit is not None:
                # A rounding-tie candidate (`fit.club != club` but
                # `fit.rejected_club is None`) is NOT a corridor decision —
                # the ceiling-skip above never records a rejection, so
                # nothing was actually width-rejected. Swapping the club
                # here with no width reason would leave a stale v1 bend-cap
                # `corridor_note` naming the old club/leave while the club
                # silently changed. Guard: only swap on a genuine width
                # rejection.
                if fit.club != club and fit.rejected_club is not None:
                    old_club_display = CLUB_DISPLAY_NAMES.get(club, club)
                    club, club_dist = fit.club, fit.dist
                    new_club_display = CLUB_DISPLAY_NAMES.get(club, club)
                    tee_shot_numbers = compute_tee_shot_numbers(
                        hole, distance_yards, adjusted_yards, club, club_dist,
                        weather, shot_bearing, competition_legal, yardage_basis,
                    )
                    if fit.rejected_club is not None and fit.rejected_sample is not None:
                        pinch_word = _pinch_word(fit.rejected_sample)
                        tee_shot_numbers.corridor_pinch_width_yards = fit.rejected_sample.width_yards
                        tee_shot_numbers.corridor_pinch_distance_yards = fit.rejected_sample.distance_yards
                        tee_shot_numbers.corridor_capped_from_club = fit.rejected_club
                        tee_shot_numbers.corridor_capped_from_window_yards = round(
                            _club_fit_window_yds(fit.rejected_club, handicap)
                        )
                        tee_shot_numbers.corridor_club_window_yards = round(
                            _club_fit_window_yds(club, handicap)
                        )
                        # Width note REPLACES the v1 note (it explains the
                        # final club) — only reached when the width cap
                        # actually changed the club (§7).
                        corridor_note = (
                            f"{old_club_display}'s shot zone needs ~{tee_shot_numbers.corridor_capped_from_window_yards} "
                            f"yards but the {pinch_word} pinches the corridor to "
                            f"~{tee_shot_numbers.corridor_pinch_width_yards} at "
                            f"{tee_shot_numbers.corridor_pinch_distance_yards} — {new_club_display}'s "
                            f"~{tee_shot_numbers.corridor_club_window_yards}-yard zone fits at "
                            f"{tee_shot_numbers.drive_total_yards}, leaves about {tee_shot_numbers.leave_yards}."
                        )
                if (
                    fit.club == club
                    and fit.chosen_sample is not None
                    and fit.chosen_sample.width_yards is not None
                ):
                    # Grounding numbers for the CHOSEN club, even on the
                    # no-change path (plan §6) — never fabricated, only
                    # populated when the width at this landing distance is
                    # actually known. `fit.club == club` guards against the
                    # rounding-tie case above: when the swap was blocked
                    # (no genuine width rejection), `fit.chosen_sample`
                    # describes a DIFFERENT club than the one we kept — must
                    # not attribute its width to `tee_shot_numbers`.
                    tee_shot_numbers.corridor_width_yards = fit.chosen_sample.width_yards
                    tee_shot_numbers.corridor_club_window_yards = round(
                        _club_fit_window_yds(club, handicap)
                    )

        leave_yards = tee_shot_numbers.leave_yards

        # Driving-zone window around THIS shot's expected advance — not the
        # green-side frame. classify_pin_position is skipped: pin light is a
        # green concept and doesn't apply when the green isn't in play.
        # max_reach_yds caps the window at the player's own one-solve drive
        # total (`tee_shot_numbers.drive_total_yards`, computed once above
        # and already reused for reachability/the printed numbers — parity
        # by construction) so an out-of-reach hazard (e.g. a greenside
        # bunker) can never enter the tee-shot window (Finding C fix,
        # specs/caddie-hazard-side-reach-plan.md §4).
        max_reach_yds = float(tee_shot_numbers.drive_total_yards)
        zone = drive_zone_hazards(hole.hazards, float(club_dist), max_reach_yds=max_reach_yds)
        miss = compute_positioning_miss_side(zone)
        landing_advice = decade_landing_advice(
            hole.hazards, float(club_dist), float(leave_yards), handicap=handicap,
            max_reach_yds=max_reach_yds,
        )
        # Aim/miss coherence guard (§3.1): a "no good miss, commit to the
        # fairway" verdict can never be undercut by a lateral landing-advice
        # clause pointing to one side — aim and miss must never disagree.
        if miss.preferred == "center":
            landing_advice = None
        aim = compute_positioning_aim(leave_yards, landing_advice)

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
        # P1 — corridor v1 bend-cap explanation (§4.1) — the club change and
        # WHY, so the caddie never just silently plays a shorter club.
        if corridor_note:
            _r.append((1, corridor_note))
        # P1 — driving-zone DECADE landing advice + any dead-ahead cross hazard.
        if landing_advice:
            _r.append((1, landing_advice))
        cross_line = cross_hazard_line(zone, float(club_dist))
        if cross_line:
            _r.append((1, cross_line))
        # P2 — fairway-bend-in-window line (honest reuse of HoleBend; omitted
        # when bend is None, per the unmapped-vs-straight discipline in
        # hazards.py — and omitted when the corridor note above already named
        # this exact corner, so the two lines don't repeat each other).
        bend = hole.bend
        if (
            corridor_note is None
            and bend is not None
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
        tee_shot_numbers=tee_shot_numbers,
    )
