"""
Tactical "where to miss" advice derived from green slope.

Sign conventions
----------------
``GreenSlope.direction``
    Compass degrees of the **downhill** direction — the direction water flows off
    the green surface.  0° = north is downhill, 90° = east is downhill, etc.

``approach_bearing_deg``
    Compass degrees the golfer is shooting **toward** the green (the shot direction).
    0° = shooting north, 90° = shooting east, etc.

Relative angle
--------------
    rel = (slope_direction - approach_bearing) % 360

This gives the direction the slope descends *from the golfer's frame of reference*:

    rel ≈   0° (rel ≤ 45° or rel > 315°)
        Slope drops toward the **back** of the green (away from golfer).
        Front is HIGH, back is LOW.
        The low / "below the hole" side is the back (long).

    rel ≈  90° (45° < rel ≤ 135°)
        Slope drops toward the golfer's **right**.
        Left side is HIGH, right side is LOW.

    rel ≈ 180° (135° < rel ≤ 225°)
        Slope drops toward the **front** / near side (toward the golfer).
        Back is HIGH, front is LOW.
        The low / "below the hole" side is the front (short).

    rel ≈ 270° (225° < rel ≤ 315°)
        Slope drops toward the golfer's **left**.
        Right side is HIGH, left side is LOW.

Severity gating
---------------
Only ``moderate`` and ``severe`` slopes produce advice; ``flat`` and ``mild``
return ``None`` to avoid noise.

Framing contract
----------------
The lateral (left-to-right / right-to-left) strings deliberately reuse
``green_geometry.GreenRead``'s vocabulary: the HIGH side is where to AIM the
approach (safer margin, feeds above the hole), the LOW / fall side is where a
MISS leaves the uphill putt. Same physical tilt, two purposes (approach vs.
putt), one shared naming — so the two modules never sound like they disagree.
This pairing is pinned by ``tests/test_green_geometry.py`` Sec.6d.
"""

from typing import Optional
from app.caddie.types import GreenSlope

# Severity values that warrant tactical advice (flat/mild = no noise)
_ADVICE_SEVERITIES = frozenset({"moderate", "severe"})


def slope_miss_advice(
    green_slope: Optional[GreenSlope],
    approach_bearing_deg: float,
) -> Optional[str]:
    """Return concise tactical miss advice for a green slope, relative to approach.

    Args:
        green_slope: The green's slope data (from HoleIntelligence.green_slope).
                     ``None`` → return ``None`` gracefully.
        approach_bearing_deg: Compass bearing the golfer is shooting toward the
                              green (0° = north, 90° = east, clockwise).

    Returns:
        A short tactical string (e.g. "Green slopes back-to-front — leave it
        below the hole; miss short"), or ``None`` when the slope is absent, flat,
        or mild (no advice added = no noise).
    """
    if green_slope is None:
        return None
    if green_slope.severity not in _ADVICE_SEVERITIES:
        return None  # flat or mild — nothing worth saying

    # Direction the slope descends relative to the golfer's facing direction.
    rel = (green_slope.direction - approach_bearing_deg) % 360

    # Qualifier word scales with severity.
    qualifier = "hard" if green_slope.severity == "severe" else "moderately"

    if rel <= 45 or rel > 315:
        # Slope drops toward the BACK (away from golfer).
        # Front is high, back is low → "below the hole" side is long/back.
        return (
            f"Green slopes {qualifier} front-to-back — "
            "the back edge is lower; playing to pin depth keeps you below the hole"
        )
    elif rel <= 135:
        # Drops toward the golfer's RIGHT.
        # Left side is high, right side is low.
        # framing contract: aim = high side; uphill-putt leave = fall/low side
        return (
            f"Green tilts {qualifier} left to right — "
            "aim left, the high side; a miss right sits below the hole and leaves the uphill putt"
        )
    elif rel <= 225:
        # Drops toward the FRONT (near side, toward the golfer).
        # Back is high, front is low → "below the hole" side is short/front.
        return (
            f"Green slopes {qualifier} back-to-front — "
            "leave it below the hole; miss short"
        )
    else:
        # Drops toward the golfer's LEFT (225° < rel ≤ 315°).
        # Right side is high, left side is low.
        # framing contract: aim = high side; uphill-putt leave = fall/low side
        return (
            f"Green tilts {qualifier} right to left — "
            "aim right, the high side; a miss left sits below the hole and leaves the uphill putt"
        )
