"""Strokes gained lookup tables based on Broadie's research.

Adapted for amateur golfers with handicap multipliers.
"""

import math
from typing import Optional


# Expected strokes to hole out by distance (yards) and lie
# Based on PGA Tour averages (scratch baseline)
# Format: sorted list of (distance, expected_strokes)
_TEE_TABLE = [
    (600, 4.40), (550, 4.30), (500, 4.20), (480, 4.15),
    (460, 4.12), (440, 4.08), (420, 4.05), (400, 4.00),
    (380, 3.96), (360, 3.92), (340, 3.88), (320, 3.84),
    (300, 3.80), (280, 3.75), (260, 3.70), (240, 3.65),
    (220, 3.58), (200, 3.50), (180, 3.40), (160, 3.28),
    (140, 3.15), (120, 3.00), (100, 2.85),
]

_FAIRWAY_TABLE = [
    (260, 3.60), (240, 3.50), (220, 3.40), (200, 3.25),
    (190, 3.18), (180, 3.12), (175, 3.08), (170, 3.05),
    (160, 2.98), (150, 2.92), (140, 2.86), (130, 2.82),
    (125, 2.80), (120, 2.78), (110, 2.74), (100, 2.70),
    (90, 2.66), (80, 2.62), (70, 2.58), (60, 2.55),
    (50, 2.52), (40, 2.50), (30, 2.47),
]

_ROUGH_TABLE = [
    (200, 3.60), (180, 3.45), (160, 3.30), (150, 3.15),
    (140, 3.10), (130, 3.05), (120, 3.00), (100, 2.95),
    (80, 2.85), (60, 2.78), (50, 2.75), (40, 2.72),
    (30, 2.68), (20, 2.63),
]

_SAND_TABLE = [
    (60, 2.80), (50, 2.70), (40, 2.60), (30, 2.53),
    (20, 2.43), (10, 2.30),
]

_GREEN_TABLE = [
    (90, 2.60), (80, 2.55), (70, 2.50), (60, 2.40),
    (50, 2.30), (45, 2.25), (40, 2.20), (35, 2.14),
    (30, 2.10), (25, 2.02), (20, 1.94), (15, 1.80),
    (10, 1.63), (8, 1.50), (6, 1.38), (5, 1.28),
    (4, 1.20), (3, 1.13), (2, 1.06), (1, 1.02),
]

# Handicap multipliers for expected strokes
# Higher handicap = more strokes expected from same position
_HANDICAP_MULTIPLIERS = {
    0: 1.00,
    5: 1.06,
    10: 1.14,
    15: 1.22,
    20: 1.32,
    25: 1.42,
    30: 1.55,
    36: 1.70,
}


def _interpolate(table: list[tuple[int, float]], distance: float) -> float:
    """Interpolate expected strokes from a lookup table."""
    if not table:
        return 3.0
    if distance >= table[0][0]:
        return table[0][1]
    if distance <= table[-1][0]:
        return table[-1][1]

    for i in range(len(table) - 1):
        d1, s1 = table[i]
        d2, s2 = table[i + 1]
        if d2 <= distance <= d1:
            t = (distance - d2) / (d1 - d2) if d1 != d2 else 0
            return s2 + t * (s1 - s2)

    return table[-1][1]


def _handicap_multiplier(handicap: Optional[float]) -> float:
    """Get handicap multiplier by interpolating."""
    if handicap is None:
        handicap = 15.0

    hcp = max(0, min(36, handicap))
    keys = sorted(_HANDICAP_MULTIPLIERS.keys())

    if hcp <= keys[0]:
        return _HANDICAP_MULTIPLIERS[keys[0]]
    if hcp >= keys[-1]:
        return _HANDICAP_MULTIPLIERS[keys[-1]]

    for i in range(len(keys) - 1):
        k1, k2 = keys[i], keys[i + 1]
        if k1 <= hcp <= k2:
            t = (hcp - k1) / (k2 - k1)
            return _HANDICAP_MULTIPLIERS[k1] + t * (
                _HANDICAP_MULTIPLIERS[k2] - _HANDICAP_MULTIPLIERS[k1]
            )

    return 1.2


def expected_strokes(
    distance_yards: float,
    lie: str = "fairway",
    handicap: Optional[float] = None,
) -> float:
    """Get expected strokes to hole out from a given position.

    Args:
        distance_yards: Distance to hole in yards (or feet for putting)
        lie: 'tee', 'fairway', 'rough', 'sand', 'green'
        handicap: Player handicap (None = 15)

    Returns:
        Expected strokes to hole out
    """
    tables = {
        "tee": _TEE_TABLE,
        "fairway": _FAIRWAY_TABLE,
        "rough": _ROUGH_TABLE,
        "sand": _SAND_TABLE,
        "green": _GREEN_TABLE,
    }

    table = tables.get(lie, _FAIRWAY_TABLE)

    # For green, input should be in feet
    if lie == "green":
        base = _interpolate(table, distance_yards)  # already in feet
    else:
        base = _interpolate(table, distance_yards)

    return base * _handicap_multiplier(handicap)


def strokes_gained(
    strokes_taken: int,
    start_distance: float,
    start_lie: str,
    end_distance: float,
    end_lie: str,
    handicap: Optional[float] = None,
) -> float:
    """Calculate strokes gained for a single shot.

    SG = Expected(before) - Expected(after) - 1

    Positive = better than expected, Negative = worse than expected
    """
    expected_before = expected_strokes(start_distance, start_lie, handicap)

    if end_distance == 0 and end_lie == "hole":
        expected_after = 0.0
    else:
        expected_after = expected_strokes(end_distance, end_lie, handicap)

    return expected_before - expected_after - strokes_taken
