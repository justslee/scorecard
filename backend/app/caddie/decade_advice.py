"""DECADE aim advice for the caddie reasoning layer.

This module translates ``optimize_aim`` (from :mod:`decade`) into a single
plain-English insight: when the expected-strokes-optimal aim deviates
meaningfully from the flag, report *why* and *how much*.

It is **additive only** — it never changes the recommended club, target yards,
aim_point, or miss_side.  Wire it in as::

    advice = decade_aim_advice(hole.hazards, distance_yards)
    if advice:
        reasoning.append(advice)

Coordinate convention
---------------------
All computations use the same frame as ``decade.py``:

* ``(x, y)`` in yards, origin at the pin.
* ``+x`` = right of the shot line, ``−x`` = left.
* ``+y`` = long (past the pin, away from the player), ``−y`` = short.

Hazard → coordinate-plane approximation
-----------------------------------------
OSM hazards encode **side** (left / right / front / back / center) and
**distance_from_green** — not polygon geometry.  We approximate each hazard
as a half-plane in the pin-centred frame:

    side='left'   → all points with  x < −distance_from_green
    side='right'  → all points with  x >  distance_from_green
    side='front'  → all points with  y < −distance_from_green  (short of pin)
    side='back'   → all points with  y >  distance_from_green  (past pin)
    side='center' → all points within distance_from_green yards of the pin

This is a deliberate simplification: each hazard region extends the full
width (or depth) of the frame.  Real polygon geometry can be plugged into
``build_classify_point`` later without touching ``decade.py`` or the optimizer.

Hazard type → LandingArea mapping
-----------------------------------
    water  → WATER   (1-stroke penalty area)
    ob     → OB      (stroke-and-distance)
    bunker → SAND
    trees  → RECOVERY (punch-out or limited recovery)
    other  → depends on penalty_severity:
              death → OB,  severe → RECOVERY,  moderate/mild → ROUGH

Default area (no hazard matches):
    ≤ GREEN_RADIUS_YDS from pin → GREEN
    beyond                       → FAIRWAY

Dispersion defaults (fixed, mid-handicap)
------------------------------------------
Tuned to a mid-handicap (≈14) amateur; used when ``handicap`` is not supplied.
When ``handicap`` is provided, ``dispersion_for_handicap`` derives personalised
sigma values instead of these fixed fractions.

    SIGMA_LAT_FRACTION  = 0.06   σ_lat  = 6 % of distance (lateral spread)
    SIGMA_LONG_FRACTION = 0.04   σ_long = 4 % of distance (long/short spread)
    MIN_SIGMA_YDS       = 3.0    floor to prevent degenerate grids on short shots

Reference: Broadie (2014) "Every Shot Counts".  At 150 yards these give
σ_lat = 9 yds, σ_long = 6 yds — broadly consistent with a 14-handicap amateur.

Handicap-scaled dispersion
---------------------------
``dispersion_for_handicap(handicap, distance_yds)`` returns personalised
``(sigma_lat_yds, sigma_long_yds)`` using a piecewise-linear table derived
from DECADE / Broadie amateur data:

    Handicap +2  → σ_lat ≈ 5 % of distance   (scratch/plus-level)
    Handicap  15 → σ_lat ≈ 6.5 %             (mid-amateur)
    Handicap  25 → σ_lat ≈ 9 %               (high handicapper)
    Handicap  36 → σ_lat ≈ 11.8 % (upper clamp)

    σ_long = 2/3 × σ_lat   (long/short spread is consistently tighter)
    Both floored at MIN_SIGMA_YDS.

Handicap is clamped to [HCP_MIN=+2, HCP_MAX=36].  Better player → tighter
dispersion → aim closer to the flag (smaller or no recommended shift).
"""

from __future__ import annotations

import math
from typing import Callable, Optional

from app.caddie.decade import (
    Dispersion,
    LandingArea,
    optimize_aim,
)
from app.caddie.types import Hazard


# ── Dispersion constants (fixed / default path) ───────────────────────────────

SIGMA_LAT_FRACTION: float = 0.06    # σ_lat  = 6 % of shot distance (mid-hcp default)
SIGMA_LONG_FRACTION: float = 0.04   # σ_long = 4 % of shot distance (mid-hcp default)
MIN_SIGMA_YDS: float = 3.0          # floor — prevents degenerate grids for short shots

# ── Handicap-scaled dispersion ─────────────────────────────────────────────────
#
# Piecewise-linear table: (handicap_index, sigma_lat_fraction_of_distance).
# Calibrated to DECADE / Broadie "Every Shot Counts" amateur approach data:
#
#   +2-hcp (scratch-level) ≈ 5 % lateral fraction
#   15-hcp (mid-amateur)   ≈ 6.5 %
#   25-hcp (high-hcp)      ≈ 9 %
#   36-hcp (upper bound)   ≈ 11.8 % (extrapolated linearly from 25-hcp segment)
#
# σ_long = SIGMA_LONG_FRACTION_OF_LAT × σ_lat, consistent with Broadie's
# finding that long/short spread is roughly 2/3 of lateral spread.

HCP_MIN: float = 2.0    # clamp floor — treat any better-than-+2 as +2
HCP_MAX: float = 36.0   # clamp ceiling — cap for beginners / high-hcp players

# Each entry: (handicap_breakpoint, lateral_sigma_fraction)
_LAT_FRACTION_BREAKPOINTS: list[tuple[float, float]] = [
    (HCP_MIN, 0.050),   # scratch-level: ~5 % of distance
    (15.0,    0.065),   # mid-amateur:   ~6.5 %
    (25.0,    0.090),   # high handicapper: ~9 %
    (HCP_MAX, 0.118),   # upper clamp:   ~11.8 % (extrapolated)
]

# Ratio of longitudinal to lateral sigma (Broadie: long/short is tighter than lateral).
SIGMA_LONG_FRACTION_OF_LAT: float = 2.0 / 3.0


def dispersion_for_handicap(
    handicap: float,
    distance_yds: float,
) -> tuple[float, float]:
    """Return ``(sigma_lat_yds, sigma_long_yds)`` personalised to *handicap* and distance.

    Better players have tighter dispersion; higher handicaps spread wider.
    Both values are floored at ``MIN_SIGMA_YDS`` to prevent degenerate grids on
    very short shots.

    The model uses piecewise-linear interpolation between four calibrated
    breakpoints derived from DECADE / Broadie amateur approach data (see module
    docstring for full table).  Handicap is clamped to ``[HCP_MIN, HCP_MAX]``.

    Args:
        handicap:     Player's handicap index.  Values outside ``[HCP_MIN, HCP_MAX]``
                      are clamped to that range before interpolation.
        distance_yds: Shot distance in yards.  Scales both sigma values linearly.

    Returns:
        ``(sigma_lat_yds, sigma_long_yds)`` — 1-sigma values in yards for the
        lateral (left/right) and longitudinal (long/short) spread, respectively.

    Example::

        # 150-yd approach, scratch player
        >>> dispersion_for_handicap(2, 150)
        (7.5, 5.0)

        # Same shot, 25-handicap
        >>> dispersion_for_handicap(25, 150)
        (13.5, 9.0)
    """
    # Clamp handicap to the defined range
    hcp = max(HCP_MIN, min(HCP_MAX, handicap))

    bps = _LAT_FRACTION_BREAKPOINTS
    lat_frac: float

    if hcp <= bps[0][0]:
        lat_frac = bps[0][1]
    elif hcp >= bps[-1][0]:
        lat_frac = bps[-1][1]
    else:
        # Piecewise-linear interpolation between adjacent breakpoints
        lat_frac = bps[-1][1]  # fallback; overwritten in the loop below
        for i in range(len(bps) - 1):
            h0, f0 = bps[i]
            h1, f1 = bps[i + 1]
            if h0 <= hcp <= h1:
                t = (hcp - h0) / (h1 - h0)
                lat_frac = f0 + t * (f1 - f0)
                break

    sigma_lat = max(lat_frac * distance_yds, MIN_SIGMA_YDS)
    sigma_long = max(SIGMA_LONG_FRACTION_OF_LAT * sigma_lat, MIN_SIGMA_YDS)

    return sigma_lat, sigma_long


# ── Candidate aims ────────────────────────────────────────────────────────────

# Lateral offsets evaluated around the pin (yards), in 3-yd steps from −12 to +12.
# 9 candidates: covers the "aim a club-width or two from the flag" range.
_CANDIDATE_OFFSETS_YDS: list[float] = [float(x) for x in range(-12, 13, 3)]

# ── Advice threshold ──────────────────────────────────────────────────────────

# Minimum lateral deviation from the pin (yards) before advice is surfaced.
# Below this the optimizer is essentially saying "aim at the flag" — no noise.
# With 3-yd step size, the first reportable values are ±6 yds (next step above 4).
AIM_THRESHOLD_YDS: float = 4.0

# ── Green / fairway defaults ──────────────────────────────────────────────────

# Points within this radius of the pin are GREEN by default (hazards override).
GREEN_RADIUS_YDS: float = 20.0

# ── Severity ordering ─────────────────────────────────────────────────────────

_SEVERITY_ORDER: dict[str, int] = {
    "death": 4,
    "severe": 3,
    "moderate": 2,
    "mild": 1,
}


# ── Helpers ───────────────────────────────────────────────────────────────────


def _hazard_to_area(hazard: Hazard) -> LandingArea:
    """Map a Hazard object to the most appropriate LandingArea.

    Type takes precedence; unknown types fall back to penalty_severity.
    """
    t = hazard.type.lower()
    if t == "water":
        return LandingArea.WATER
    if t == "ob":
        return LandingArea.OB
    if t == "bunker":
        return LandingArea.SAND
    if t == "trees":
        return LandingArea.RECOVERY
    # Unknown / 'slope' / etc. — use severity as a proxy
    if hazard.penalty_severity == "death":
        return LandingArea.OB
    if hazard.penalty_severity == "severe":
        return LandingArea.RECOVERY
    return LandingArea.ROUGH


def _friendly_hazard_name(hazard: Hazard) -> str:
    """Return a concise, readable hazard noun phrase for the advice string."""
    names: dict[str, str] = {
        "water": "water",
        "ob": "OB",
        "bunker": "a bunker",
        "trees": "trees",
        "slope": "a steep slope",
    }
    return names.get(hazard.type.lower(), "trouble")


# ── Course-geometry classifier ────────────────────────────────────────────────


def build_classify_point(
    hazards: list[Hazard],
    pin: tuple[float, float] = (0.0, 0.0),
) -> Callable[[float, float], LandingArea]:
    """Build a ``ClassifyFn`` that approximates the hole as a coordinate plane.

    The plane is centred on ``pin`` (yards):
        +x = right of the shot line,  −x = left
        +y = long (past pin),          −y = short (before pin)

    Each hazard is mapped to the half-plane defined by its ``side`` and
    ``distance_from_green``.  More severe hazards take priority when regions
    overlap (sorted death > severe > moderate > mild).

    The resulting callable is suitable for passing directly to ``optimize_aim``
    or ``expected_strokes_for_aim`` from :mod:`decade`.

    Args:
        hazards: Hazard list from ``HoleIntelligence.hazards``.
        pin:     Pin coordinates, (x, y) in yards (default: origin).

    Returns:
        A pure ``ClassifyFn`` callable ``(x, y) → LandingArea``.
    """
    # Most-severe hazard wins when regions overlap.
    sorted_hazards = sorted(
        hazards,
        key=lambda h: _SEVERITY_ORDER.get(h.penalty_severity, 0),
        reverse=True,
    )

    # Pre-bake each entry so the closure captures plain tuples, not Hazard objects.
    _HazardEntry = tuple[LandingArea, str, float]
    entries: list[_HazardEntry] = []
    for h in sorted_hazards:
        area = _hazard_to_area(h)
        side = h.side.lower()
        # Guard against distance=0: treat as 1 yd to avoid degenerate half-planes
        dist = max(h.distance_from_green, 1.0)
        entries.append((area, side, dist))

    def classify_point(x: float, y: float) -> LandingArea:
        # Coordinates relative to pin
        px = x - pin[0]
        py = y - pin[1]

        for area, side, dist in entries:
            if side == "left" and px < -dist:
                return area
            if side == "right" and px > dist:
                return area
            if side == "front" and py < -dist:
                return area
            if side == "back" and py > dist:
                return area
            if side == "center" and math.hypot(px, py) <= dist:
                return area

        # Default: green near the pin, fairway further out
        if math.hypot(px, py) <= GREEN_RADIUS_YDS:
            return LandingArea.GREEN
        return LandingArea.FAIRWAY

    return classify_point


# ── Public API ────────────────────────────────────────────────────────────────


def decade_aim_advice(
    hazards: list[Hazard],
    shot_distance_yds: float,
    pin: tuple[float, float] = (0.0, 0.0),
    handicap: Optional[float] = None,
) -> Optional[str]:
    """Expected-strokes aim insight, surfaced as caddie advice text.

    Runs ``optimize_aim`` over a lateral grid of candidates (pin ± 12 yds in
    3-yd steps) with dispersion scaled to the shot distance.  When the optimal
    aim deviates from the flag by more than ``AIM_THRESHOLD_YDS`` yards, a
    concise advice string is returned.  Otherwise returns ``None`` (the flag
    aim is optimal or nearly so — no noise added).

    The function is **pure** (no I/O) and deterministic.

    Args:
        hazards:           Hazard list from ``HoleIntelligence.hazards``.
                           Empty list always returns ``None`` gracefully.
        shot_distance_yds: Distance to the pin in yards; scales the dispersion.
        pin:               Pin location in the coordinate plane (default: origin).
        handicap:          Player's handicap index.  When provided, dispersion is
                           personalised via ``dispersion_for_handicap`` — better
                           players get tighter dispersion, leading to more
                           aggressive (closer-to-flag) advice.  When ``None``,
                           the fixed ``SIGMA_LAT_FRACTION`` / ``SIGMA_LONG_FRACTION``
                           constants are used (mid-handicap defaults, preserving
                           prior behaviour).

    Returns:
        Advice string, e.g.::

            "The percentages favor aiming ~6y right of the flag — water guards the left."

        or ``None`` when the flag is optimal (or nearly so / no hazards).
    """
    if not hazards:
        return None

    # Derive dispersion: personalised when handicap is provided, fixed otherwise.
    if handicap is not None:
        sigma_lat, sigma_long = dispersion_for_handicap(handicap, shot_distance_yds)
    else:
        # Fixed mid-handicap defaults — backwards-compatible fallback path.
        sigma_lat = max(SIGMA_LAT_FRACTION * shot_distance_yds, MIN_SIGMA_YDS)
        sigma_long = max(SIGMA_LONG_FRACTION * shot_distance_yds, MIN_SIGMA_YDS)
    dispersion = Dispersion(sigma_long=sigma_long, sigma_lat=sigma_lat)

    # Candidate aims: lateral offsets around the pin, all at pin depth
    candidate_aims = [(pin[0] + dx, pin[1]) for dx in _CANDIDATE_OFFSETS_YDS]

    # Build course-geometry classifier from hazard data
    classify_point = build_classify_point(hazards, pin)

    # Find the aim that minimises expected strokes
    result = optimize_aim(candidate_aims, dispersion, classify_point, pin)

    # Lateral offset from pin (positive = right, negative = left)
    offset_x = result.aim[0] - pin[0]

    if abs(offset_x) < AIM_THRESHOLD_YDS:
        # Optimal aim is at or very near the flag — nothing worth saying
        return None

    # Direction and magnitude
    aim_direction = "right" if offset_x > 0 else "left"
    n_yards = abs(int(round(offset_x)))

    # Identify the most dangerous hazard on the side we're aiming away from
    dangerous_side = "left" if offset_x > 0 else "right"
    lateral_hazards = [h for h in hazards if h.side.lower() == dangerous_side]

    if lateral_hazards:
        worst = max(
            lateral_hazards,
            key=lambda h: _SEVERITY_ORDER.get(h.penalty_severity, 0),
        )
        hazard_desc = _friendly_hazard_name(worst)
        return (
            f"The percentages favor aiming about {n_yards} yards {aim_direction} of the flag"
            f" — {hazard_desc} guards the {dangerous_side}."
        )

    # Hazard present in model but not on a neatly named lateral side
    # (e.g. front/back/center hazard drove a y-shifted candidate — unusual
    # given our lateral-only grid, but handled gracefully).
    return (
        f"The percentages favor aiming about {n_yards} yards {aim_direction} of the flag"
        f" — the {dangerous_side} is the danger side."
    )


# ── Landing-zone DECADE engine (positioning shots — out-of-reach tee/layup) ───
#
# specs/caddie-shot-context-reachability-plan.md §2. When the green is out of
# reach on this swing, a pin-relative frame is meaningless — the relevant
# question is "what's in play at THIS shot's own landing distance". This
# section reuses the same optimizer/dispersion/LandingArea machinery as
# `decade_aim_advice` above, but centres the coordinate plane on the expected
# LANDING point (tee-anchored `carry_yards` frame from hazards.py) instead of
# the pin. The words "flag" and "pin" are structurally unreachable from this
# code path.

# Driving-zone window around the expected advance: ~±2-3 sigma_long of an
# amateur full shot plus roll variance. A hazard outside it isn't in play on
# THIS swing.
DRIVE_ZONE_SHORT_YDS: float = 50.0   # window behind the landing point
DRIVE_ZONE_LONG_YDS: float = 30.0    # window past it
_FAIRWAY_HALF_WIDTH_YDS: float = 16.0  # hazards.py's 10y deadband + fairway shoulder


def drive_zone_hazards(
    hazards: list[Hazard],
    expected_advance_yds: float,
    max_reach_yds: Optional[float] = None,
) -> list[Hazard]:
    """Hazards in play at THIS shot's distance — the `carry_yards` frame
    (the tee-anchored along-played-line number `hazards.py` computed), never
    `distance_from_green`. `carry_yards <= 0` entries (green-frame-only /
    degenerate, e.g. unmapped holes or course_intel-style hazards) are
    excluded, not guessed at.

    `max_reach_yds` (Finding C fix, specs/caddie-hazard-side-reach-plan.md
    §4): when provided, caps the long window edge at
    `min(expected_advance_yds, max_reach_yds) + DRIVE_ZONE_LONG_YDS` — a
    hazard the player physically cannot reach on this swing (e.g. a
    374y-carry greenside bunker against a 285y total) is excluded from the
    tee-shot window even if it happens to sit within the raw
    `expected_advance_yds`-relative range. `None` (default) preserves
    today's behavior — back-compat for direct callers/tests that don't pass
    a reach ceiling.
    """
    long_edge = expected_advance_yds + DRIVE_ZONE_LONG_YDS
    if max_reach_yds is not None:
        long_edge = min(expected_advance_yds, max_reach_yds) + DRIVE_ZONE_LONG_YDS
    return [
        h for h in hazards
        if h.carry_yards > 0
        and expected_advance_yds - DRIVE_ZONE_SHORT_YDS
            <= h.carry_yards <= long_edge
    ]


def _build_landing_classify(
    zone: list[Hazard],
    expected_advance_yds: float,
) -> Callable[[float, float], LandingArea]:
    """Build a ``ClassifyFn`` centred on the LANDING target, not the pin.

    Origin (0, 0) = the landing target on the hole line at
    `expected_advance_yds` (the `carry_yards` frame IS the played
    polyline/bend line from `hazards.py::_project_onto_polyline`, so "along
    the hole line" comes for free). `+x` = right of the shot line, `+y` =
    further along the hole line (toward the green).

    Left/right hazards (`line_side`) are half-planes at
    `|x| > _FAIRWAY_HALF_WIDTH_YDS`; center hazards are a band
    `|x| <= _FAIRWAY_HALF_WIDTH_YDS` and `|y - (carry - advance)| <= 15`.
    Default: FAIRWAY within the half-width, ROUGH outside — the same
    deliberate half-plane simplification `build_classify_point` documents
    above for the pin frame; more severe hazards win when regions overlap.
    """
    sorted_zone = sorted(
        zone,
        key=lambda h: _SEVERITY_ORDER.get(h.penalty_severity, 0),
        reverse=True,
    )

    _Entry = tuple[LandingArea, str, float]
    entries: list[_Entry] = []
    for h in sorted_zone:
        area = _hazard_to_area(h)
        side = h.line_side.lower()
        y_offset = h.carry_yards - expected_advance_yds
        entries.append((area, side, y_offset))

    def classify_point(x: float, y: float) -> LandingArea:
        for area, side, y_offset in entries:
            if side == "left" and x < -_FAIRWAY_HALF_WIDTH_YDS:
                return area
            if side == "right" and x > _FAIRWAY_HALF_WIDTH_YDS:
                return area
            if side == "center" and abs(x) <= _FAIRWAY_HALF_WIDTH_YDS and abs(y - y_offset) <= 15.0:
                return area

        if abs(x) <= _FAIRWAY_HALF_WIDTH_YDS:
            return LandingArea.FAIRWAY
        return LandingArea.ROUGH

    return classify_point


def decade_landing_advice(
    hazards: list[Hazard],
    expected_advance_yds: float,
    leave_yds: float,
    handicap: Optional[float] = None,
    max_reach_yds: Optional[float] = None,
) -> Optional[str]:
    """Expected-strokes landing-zone insight for a positioning (out-of-reach)
    shot — the driving-zone analogue of `decade_aim_advice`.

    Runs `optimize_aim` over a lateral grid of candidates (landing target
    ± 12 yds in 3-yd steps) with dispersion scaled to the drive distance,
    against a landing-frame classifier (`_build_landing_classify`). The pin
    is placed at ``(0, leave_yds)`` so `expected_strokes_from` prices the
    resulting approach correctly (fairway-at-leave vs rough-at-leave vs
    water+drop). When the optimal lateral offset deviates from center by
    more than `AIM_THRESHOLD_YDS`, a concise advice string is returned;
    otherwise `None` (the driving zone has no in-play hazard worth calling
    out — the caller falls back to "middle of the fairway"). The words
    "flag" and "pin" are unreachable from this function.

    `max_reach_yds` passes through to `drive_zone_hazards` (Finding C fix,
    specs/caddie-hazard-side-reach-plan.md §4) — an out-of-reach hazard
    (e.g. a greenside bunker beyond the player's total) never drives this
    advice string either.
    """
    zone = drive_zone_hazards(hazards, expected_advance_yds, max_reach_yds=max_reach_yds)
    if not zone:
        return None

    if handicap is not None:
        sigma_lat, sigma_long = dispersion_for_handicap(handicap, expected_advance_yds)
    else:
        sigma_lat = max(SIGMA_LAT_FRACTION * expected_advance_yds, MIN_SIGMA_YDS)
        sigma_long = max(SIGMA_LONG_FRACTION * expected_advance_yds, MIN_SIGMA_YDS)
    dispersion = Dispersion(sigma_long=sigma_long, sigma_lat=sigma_lat)

    candidate_aims = [(dx, 0.0) for dx in _CANDIDATE_OFFSETS_YDS]
    classify_point = _build_landing_classify(zone, expected_advance_yds)
    pin = (0.0, leave_yds)

    result = optimize_aim(candidate_aims, dispersion, classify_point, pin)
    offset_x = result.aim[0]

    if abs(offset_x) < AIM_THRESHOLD_YDS:
        return None

    aim_direction = "right" if offset_x > 0 else "left"
    dangerous_side = "left" if offset_x > 0 else "right"
    lateral_hazards = [h for h in zone if h.line_side.lower() == dangerous_side]

    if lateral_hazards:
        worst = max(
            lateral_hazards,
            key=lambda h: _SEVERITY_ORDER.get(h.penalty_severity, 0),
        )
        hazard_desc = _friendly_hazard_name(worst)
        # `~N` notation kept as-is (register-consistency plan §2.7): it
        # matches the FROZEN numbers-block notation in
        # `voice_prompts.format_tee_numbers_line` ("plays like ~X") — changing
        # it here for zero register gain would touch
        # tests/test_bag_caddie_grounding_unit.py's exact pins.
        return (
            f"Favor the {aim_direction} half of the fairway — {hazard_desc} at "
            f"~{int(round(worst.carry_yards))} on the {dangerous_side}."
        )

    return f"Favor the {aim_direction} half of the fairway — {dangerous_side} is the tighter side."


def cross_hazard_line(
    zone: list[Hazard], expected_advance_yds: float, club_display: str = "driver",
) -> Optional[str]:
    """Advisory-only line for a hazard crossing the fairway dead ahead in the
    driving zone (`line_side == "center"`), independent of the lateral aim
    advice. Severe/death only, and only within a tight carry window around
    the expected advance — club change stays out of scope (matches the
    repo's additive-advice tradition; `decade_aim_advice` never changes club
    either).

    `club_display` names the club actually being played on this tee shot
    (the caller passes the selected club's display name) — a no-driver bag
    must never be told "driver brings it in play" (specs/
    onboarding-bag-caddie-grounding-plan.md §1b).
    """
    candidates = [
        h for h in zone
        if h.line_side.lower() == "center"
        and h.penalty_severity in ("severe", "death")
        and (expected_advance_yds - 15.0) <= h.carry_yards <= (expected_advance_yds + 25.0)
    ]
    if not candidates:
        return None
    worst = max(candidates, key=lambda h: _SEVERITY_ORDER.get(h.penalty_severity, 0))
    name = _friendly_hazard_name(worst)
    name = name[0].upper() + name[1:]
    return f"{name} crosses at ~{int(round(worst.carry_yards))} — {club_display} brings it in play."
