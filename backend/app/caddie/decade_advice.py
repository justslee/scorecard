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

Dispersion defaults
-------------------
Tuned to a mid-handicap (≈14) amateur; swap the constants to personalise.

    SIGMA_LAT_FRACTION  = 0.06   σ_lat  = 6 % of distance (lateral spread)
    SIGMA_LONG_FRACTION = 0.04   σ_long = 4 % of distance (long/short spread)
    MIN_SIGMA_YDS       = 3.0    floor to prevent degenerate grids on short shots

Reference: Broadie (2014) "Every Shot Counts".  At 150 yards these give
σ_lat = 9 yds, σ_long = 6 yds — broadly consistent with a 14-handicap amateur.
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


# ── Dispersion constants ──────────────────────────────────────────────────────

SIGMA_LAT_FRACTION: float = 0.06    # σ_lat  = 6 % of shot distance
SIGMA_LONG_FRACTION: float = 0.04   # σ_long = 4 % of shot distance
MIN_SIGMA_YDS: float = 3.0          # floor — prevents degenerate grids for short shots

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

    Returns:
        Advice string, e.g.::

            "The percentages favor aiming ~6y right of the flag — water guards the left."

        or ``None`` when the flag is optimal (or nearly so / no hazards).
    """
    if not hazards:
        return None

    # Scale dispersion to shot distance; floor at MIN_SIGMA_YDS
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
            f"The percentages favor aiming ~{n_yards}y {aim_direction} of the flag"
            f" — {hazard_desc} guards the {dangerous_side}."
        )

    # Hazard present in model but not on a neatly named lateral side
    # (e.g. front/back/center hazard drove a y-shifted candidate — unusual
    # given our lateral-only grid, but handled gracefully).
    return (
        f"The percentages favor aiming ~{n_yards}y {aim_direction} of the flag"
        f" — the {dangerous_side} is the danger side."
    )
