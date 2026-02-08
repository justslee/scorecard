"""Shot dispersion models by handicap level.

Based on TrackMan/DECADE research data on amateur shot patterns.
"""

from typing import Optional


# Dispersion data: (width_yards, depth_yards, short_bias_pct)
# width = total left-right spread (2 standard deviations)
# depth = total short-long spread (2 standard deviations)
# short_bias = % of misses that are short of target

_DISPERSION_BY_CLUB_AND_HANDICAP: dict[str, dict[int, tuple[float, float, float]]] = {
    "driver": {
        0: (42, 30, 40),
        5: (52, 35, 42),
        10: (65, 40, 45),
        15: (75, 48, 50),
        20: (85, 55, 52),
        25: (95, 60, 55),
        30: (110, 70, 58),
    },
    "3wood": {
        0: (36, 28, 45),
        5: (45, 33, 48),
        10: (55, 38, 50),
        15: (65, 44, 53),
        20: (75, 50, 55),
        25: (85, 56, 57),
        30: (98, 65, 60),
    },
    "5wood": {
        0: (34, 26, 48),
        5: (42, 30, 50),
        10: (52, 36, 52),
        15: (62, 42, 55),
        20: (72, 48, 57),
        25: (82, 54, 58),
        30: (94, 62, 60),
    },
    "hybrid": {
        0: (32, 24, 48),
        5: (40, 28, 50),
        10: (50, 34, 52),
        15: (60, 40, 55),
        20: (68, 46, 57),
        25: (78, 52, 58),
        30: (90, 60, 60),
    },
    "long_iron": {  # 4-5 iron
        0: (28, 22, 50),
        5: (36, 26, 52),
        10: (45, 32, 54),
        15: (56, 40, 56),
        20: (65, 46, 58),
        25: (74, 52, 60),
        30: (85, 60, 62),
    },
    "mid_iron": {  # 6-7 iron
        0: (24, 18, 52),
        5: (30, 22, 54),
        10: (38, 28, 56),
        15: (48, 36, 58),
        20: (58, 42, 60),
        25: (66, 48, 62),
        30: (76, 56, 64),
    },
    "short_iron": {  # 8-9 iron
        0: (18, 14, 54),
        5: (24, 18, 56),
        10: (32, 24, 58),
        15: (40, 30, 60),
        20: (48, 36, 62),
        25: (56, 42, 64),
        30: (66, 50, 66),
    },
    "wedge": {  # PW-LW
        0: (14, 10, 56),
        5: (18, 14, 58),
        10: (24, 18, 60),
        15: (30, 24, 62),
        20: (38, 30, 64),
        25: (44, 36, 66),
        30: (52, 42, 68),
    },
}

# Map club names to categories
_CLUB_CATEGORY = {
    "driver": "driver",
    "3wood": "3wood", "threeWood": "3wood",
    "5wood": "5wood", "fiveWood": "5wood",
    "hybrid": "hybrid",
    "4iron": "long_iron", "fourIron": "long_iron",
    "5iron": "long_iron", "fiveIron": "long_iron",
    "6iron": "mid_iron", "sixIron": "mid_iron",
    "7iron": "mid_iron", "sevenIron": "mid_iron",
    "8iron": "short_iron", "eightIron": "short_iron",
    "9iron": "short_iron", "nineIron": "short_iron",
    "pw": "wedge", "pitchingWedge": "wedge",
    "gw": "wedge", "gapWedge": "wedge",
    "sw": "wedge", "sandWedge": "wedge",
    "lw": "wedge", "lobWedge": "wedge",
}


def _interpolate_handicap(
    table: dict[int, tuple[float, float, float]],
    handicap: float,
) -> tuple[float, float, float]:
    """Interpolate dispersion values between handicap breakpoints."""
    hcp = max(0, min(30, handicap))
    keys = sorted(table.keys())

    if hcp <= keys[0]:
        return table[keys[0]]
    if hcp >= keys[-1]:
        return table[keys[-1]]

    for i in range(len(keys) - 1):
        k1, k2 = keys[i], keys[i + 1]
        if k1 <= hcp <= k2:
            t = (hcp - k1) / (k2 - k1)
            v1 = table[k1]
            v2 = table[k2]
            return (
                v1[0] + t * (v2[0] - v1[0]),
                v1[1] + t * (v2[1] - v1[1]),
                v1[2] + t * (v2[2] - v1[2]),
            )

    return table[keys[-1]]


def get_dispersion(
    club: str,
    handicap: Optional[float] = None,
) -> dict:
    """Get shot dispersion model for a club and handicap.

    Returns:
        width_yards: left-right spread (2 std dev)
        depth_yards: short-long spread (2 std dev)
        short_bias_pct: % of misses that fall short
        center_bias: 'left', 'right', or 'none' (without player-specific data)
    """
    if handicap is None:
        handicap = 15.0

    category = _CLUB_CATEGORY.get(club, "mid_iron")
    table = _DISPERSION_BY_CLUB_AND_HANDICAP.get(category, _DISPERSION_BY_CLUB_AND_HANDICAP["mid_iron"])

    width, depth, short_bias = _interpolate_handicap(table, handicap)

    return {
        "width_yards": round(width, 1),
        "depth_yards": round(depth, 1),
        "short_bias_pct": round(short_bias, 1),
        "center_bias": "none",
    }


def dispersion_covers_hazard(
    dispersion: dict,
    aim_offset_yards: float,
    hazard_offset_yards: float,
) -> bool:
    """Check if a shot's dispersion pattern could reach a hazard.

    Args:
        dispersion: from get_dispersion()
        aim_offset_yards: where you're aiming relative to center (+ = right)
        hazard_offset_yards: where the hazard is relative to center (+ = right)

    Returns:
        True if the hazard is within the dispersion ellipse
    """
    half_width = dispersion["width_yards"] / 2
    distance_to_hazard = abs(hazard_offset_yards - aim_offset_yards)
    return distance_to_hazard < half_width
