"""Green-slope spatial reasoning — grounds the caddie's "which side leaves the
uphill putt" advice in real rotation math instead of a compass word.

Pure, unit-testable module: no DB, no network, stdlib-only + ``_xy_m`` reused
from ``app.caddie.hazards`` (same equirectangular local frame + the same
positive-cross-=-LEFT sign convention — this module does NOT reinvent either).

Owner escalation (2026-07-09, 4-screenshot session): the caddie had a green
slope stored as "slopes west," could not map that compass word onto the
player's own left/right, and butchered the slope -> miss-side -> uphill-putt
chain live on the course. 4th geometry-incident class in this project (after
dogleg side-mirroring, phantom left bunker, multi-tee anchor). Fix pattern
(proven twice — ``hazards.HAZARD_GROUNDING_RULE``, ``physics.
PHYSICS_GROUNDING_RULE``): a deterministic pure engine the model CITES and is
forbidden from re-deriving.

ASPECT PIN (critical — restated from ``app.services.elevation.
_compute_slope_from_grid``): ``GreenSlope.direction`` is the **downhill
azimuth** — the compass direction the surface FALLS TOWARD, i.e. the
direction water flows off the green. 0=N, 90=E, clockwise. It is NOT the
up-slope-facing direction. Source: ``direction = atan2(-dzdx, -dzdy) % 360``
(both raw gradients point uphill, so the downhill vector negates them); a
prior version of that function had the sign flipped and gave the wrong
quadrant for east/west slopes. Reading this as an up-slope aspect instead of
a downhill one flips every sided row in the test table below.

Sign convention (reused, pinned by
``test_hazards.py::test_left_is_positive_cross_convention``): for a travel
unit vector ``u`` and another unit vector ``d``, ``cross(u, d) = ux*dy -
uy*dx``; **positive = d points LEFT of travel, negative = RIGHT**.

Rotation math (every sign stated; see specs/caddie-green-slope-spatial-plan.md
Sec.2 for the full derivation):

    Compass bearing theta (deg, clockwise from north) -> unit vector
    v(theta) = (sin theta, cos theta)   [x=east, y=north; theta=0 -> north,
                                          theta=90 -> east]

    beta  = approach_bearing_deg   (tee -> green direction, unit vector u)
    alpha = slope direction_deg    (downhill-toward aspect, unit vector d)

    s = cross(u, d) = sin(beta - alpha)
    c = dot(u, d)   = cos(beta - alpha)   (+1 = falls away from the player,
                                            -1 = falls toward the player)

Sign chain (RESOLVED — see specs/caddie-green-slope-spatial-plan.md Sec.0;
the spec's original worked example in caddie-physics-engine.md Sec.P1 had the
last link of this chain inverted and has been corrected in the same commit
that added this module):

    1. s > 0  => d points LEFT of travel => the slope falls LEFT.
    2. Falls left => the LOW side is LEFT, the HIGH side is RIGHT.
    3. A ball on the LOW side sits BELOW the hole => the putt back up is
       UPHILL => ``uphill_leave_side = LEFT = fall_side``;
       ``downhill_leave_side = high_side = RIGHT``.
    4. s < 0 mirrors: falls RIGHT => high side LEFT => uphill leave RIGHT.
    5. ``|s| <= sin(DEADBAND_DEG)`` => the slope runs along the approach line
       (falls toward/away from the player, not to a side) => ``fall_side =
       "none"``; then ``c < 0`` (falls toward the player) =>
       ``uphill_leave_depth = "short"`` (below the hole is short of the pin);
       ``c > 0`` (falls away from the player) => ``"long"``.

Owner check (also pinned as the golden test): green "slopes west" (alpha =
270), approach due north (beta = 0): ``s = sin(0 - 270) = sin(90) = +1 > 0``
=> falls LEFT => high side RIGHT => **uphill leave LEFT**.

Equivalence with ``app.caddie.slope_advice`` (corroboration, not a second
source of truth — that module already encodes the same physically-correct
"leave it below the hole" rule for the front/back case): its
``rel = (alpha - beta) % 360`` gives ``s = -sin(rel)``, so ``rel ~= 90``
(slope drops to the golfer's right) => ``s = -1`` (falls right, high side
left) and ``rel ~= 270`` (drops left) => ``s = +1`` (falls left, high side
right) — the two modules never disagree on which side is high.

``green_read`` takes bearings, not coordinates, so it is table-testable in
isolation; ``approach_bearing_deg`` is the only coordinate-touching function
here (where a lat/lng swap bug would live).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

from app.caddie.hazards import _xy_m

# Half-width, in degrees, of the "along the approach line" band within which
# a slope is treated as falling toward/away from the player rather than to a
# side (no fabricated left/right jitter when the slope is nearly in line with
# the shot). sin(20 deg) ~= 0.342.
DEADBAND_DEG: float = 20.0
_DEADBAND_SIN: float = math.sin(math.radians(DEADBAND_DEG))

# Below this percent grade a green is treated as flat regardless of the
# computed direction — mirrors elevation.py's own "flat" severity threshold
# (< 1%) so a noisy near-zero gradient never produces a fabricated side.
_FLAT_GRADE_PCT: float = 1.0

_MIN_BASELINE_M: float = 1.0  # below this, tee==green is degenerate


def approach_bearing_deg(
    tee_lat: float, tee_lng: float, green_lat: float, green_lng: float,
) -> Optional[float]:
    """Compass bearing (0=N, 90=E, clockwise) of the tee->green direction.

    Reuses ``hazards._xy_m`` for the local east/north projection — the same
    frame ``green_read`` assumes bearings are measured in. Returns ``None``
    when tee and green are degenerately close (< 1m apart) rather than
    fabricate a travel direction.
    """
    x_east, y_north = _xy_m(tee_lat, tee_lng, green_lat, green_lng)
    if math.hypot(x_east, y_north) < _MIN_BASELINE_M:
        return None
    return math.degrees(math.atan2(x_east, y_north)) % 360.0


@dataclass(frozen=True)
class GreenRead:
    """Deterministic "which side leaves the uphill putt" read, in the
    player's own left/right frame relative to their approach direction."""

    fall_side: str  # "left" | "right" | "none" — the LOW side (falls toward)
    high_side: str  # opposite of fall_side; "none" when fall_side is "none"
    uphill_leave_side: str  # == fall_side (the low side / below the hole)
    downhill_leave_side: str  # == high_side (the high side / above the hole)
    uphill_leave_depth: Optional[str]  # "short" | "long", only when fall_side=="none"
    cross_grade_pct: float  # lateral (side-to-side) component of the grade
    along_grade_pct: float  # along-line (toward/away) component of the grade
    rel_angle_deg: float  # (alpha - beta) % 360 — diagnostics, matches slope_advice.rel
    severity: str  # flat | mild | moderate | severe (passed through)
    confidence: str  # "high" | "low" | "none"
    read_line: str  # one spoken-style sentence, player-frame


GREEN_GROUNDING_RULE = (
    "Never derive green break, slope side, or uphill/downhill putt direction yourself, "
    "and never translate a compass slope description (\"slopes west\") into the player's "
    "left or right on your own. Any statement about which side is high or low, which miss "
    "leaves an uphill putt, or how a putt breaks must come verbatim from the get_green_read "
    "tool. If it returns available:false or side \"none\", say the green read isn't mapped "
    "or the slope runs along your line — never fabricate a side."
)


def green_read(
    slope_direction_deg: float,
    percent_grade: float,
    severity: str,
    approach_bearing_deg: float,
) -> GreenRead:
    """Rotate a stored green-slope aspect into the player's approach frame.

    Pure trig on bearings (module docstring Sec. "Rotation math") — no
    coordinates, no DB, no network. ``slope_direction_deg`` is the downhill
    aspect (``GreenSlope.direction``); ``approach_bearing_deg`` is the
    tee->green compass bearing (this module's own ``approach_bearing_deg``
    helper, or any other caller-supplied bearing in the same 0=N/90=E frame).
    """
    alpha = float(slope_direction_deg) % 360.0
    beta = float(approach_bearing_deg) % 360.0
    rel = (alpha - beta) % 360.0

    diff_rad = math.radians(beta - alpha)
    s = math.sin(diff_rad)
    c = math.cos(diff_rad)

    cross_grade_pct = round(percent_grade * abs(s), 2)
    along_grade_pct = round(percent_grade * abs(c), 2)

    is_flat = severity == "flat" or percent_grade < _FLAT_GRADE_PCT
    confidence = "none" if is_flat else ("low" if severity == "mild" else "high")

    if is_flat:
        return GreenRead(
            fall_side="none",
            high_side="none",
            uphill_leave_side="none",
            downhill_leave_side="none",
            uphill_leave_depth=None,
            cross_grade_pct=cross_grade_pct,
            along_grade_pct=along_grade_pct,
            rel_angle_deg=round(rel, 1),
            severity=severity,
            confidence=confidence,
            read_line="Green is close to flat — no strong side.",
        )

    if abs(s) <= _DEADBAND_SIN:
        # Slope runs along the approach line — no side, but "below the hole"
        # still has a depth: falls toward the player (c<0) => short is low;
        # falls away (c>0) => long is low.
        depth = "short" if c < 0 else "long"
        if depth == "short":
            read_line = "Green runs back to front, toward you — short is below the hole."
        else:
            read_line = "Green runs front to back, away from you — long is below the hole."
        return GreenRead(
            fall_side="none",
            high_side="none",
            uphill_leave_side="none",
            downhill_leave_side="none",
            uphill_leave_depth=depth,
            cross_grade_pct=cross_grade_pct,
            along_grade_pct=along_grade_pct,
            rel_angle_deg=round(rel, 1),
            severity=severity,
            confidence=confidence,
            read_line=read_line,
        )

    fall_side = "left" if s > 0 else "right"
    high_side = "right" if fall_side == "left" else "left"
    read_line = (
        f"Green falls to your {fall_side} — {high_side} side is the high side; "
        f"a miss {fall_side} leaves the uphill putt."
    )
    return GreenRead(
        fall_side=fall_side,
        high_side=high_side,
        uphill_leave_side=fall_side,
        downhill_leave_side=high_side,
        uphill_leave_depth=None,
        cross_grade_pct=cross_grade_pct,
        along_grade_pct=along_grade_pct,
        rel_angle_deg=round(rel, 1),
        severity=severity,
        confidence=confidence,
        read_line=read_line,
    )
