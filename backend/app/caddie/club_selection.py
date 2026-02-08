"""Club selection engine with distance adjustments."""

from typing import Optional
from app.caddie.types import ShotAdjustment, WeatherConditions
from app.services.weather import compute_wind_adjustment


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


def normalize_club_distances(raw: dict[str, int]) -> dict[str, int]:
    """Normalize club distance keys from GolferProfile format."""
    result: dict[str, int] = {}
    for key, value in raw.items():
        if not value or value <= 0:
            continue
        normalized = _PROFILE_KEY_MAP.get(key, key)
        result[normalized] = value
    return result


def compute_adjustments(
    raw_distance: int,
    elevation_change_ft: float = 0.0,
    weather: Optional[WeatherConditions] = None,
    shot_bearing: float = 0.0,
) -> tuple[int, list[ShotAdjustment]]:
    """Compute all distance adjustments and return adjusted distance.

    Returns:
        (adjusted_distance, list of adjustments applied)
    """
    adjustments: list[ShotAdjustment] = []
    total_adj = 0

    # 1. Elevation: +1 yard per 3 feet uphill, -1 per 3 feet downhill
    if abs(elevation_change_ft) > 1:
        elev_adj = round(elevation_change_ft / 3)
        if elev_adj != 0:
            direction = "uphill" if elev_adj > 0 else "downhill"
            adjustments.append(ShotAdjustment(
                type="elevation",
                yards=elev_adj,
                description=f"{abs(elevation_change_ft):.0f}ft {direction} — {'adds' if elev_adj > 0 else 'saves'} {abs(elev_adj)} yds",
            ))
            total_adj += elev_adj

    if weather:
        # 2. Wind
        if weather.wind_speed_mph >= 3:
            wind = compute_wind_adjustment(
                weather.wind_speed_mph,
                weather.wind_direction,
                shot_bearing,
                raw_distance,
            )
            wind_adj = wind["distance_adjustment"]
            if wind_adj != 0:
                adjustments.append(ShotAdjustment(
                    type="wind",
                    yards=wind_adj,
                    description=wind["description"],
                ))
                total_adj += wind_adj

        # 3. Temperature: ~2 yards per 10°F from 70°F baseline
        temp_diff = weather.temperature_f - 70.0
        temp_adj = round(-temp_diff * 0.2)  # cold = longer distance needed
        if abs(temp_adj) >= 2:
            direction = "cold" if temp_adj > 0 else "warm"
            adjustments.append(ShotAdjustment(
                type="temperature",
                yards=temp_adj,
                description=f"{weather.temperature_f:.0f}°F ({direction}) — {'+' if temp_adj > 0 else ''}{temp_adj} yds",
            ))
            total_adj += temp_adj

        # 4. Altitude (air density): ~2% per 1000ft
        if weather.altitude_ft > 500:
            alt_pct = weather.altitude_ft / 1000 * 0.02
            alt_adj = round(-raw_distance * alt_pct)  # negative = ball goes farther
            if abs(alt_adj) >= 2:
                adjustments.append(ShotAdjustment(
                    type="altitude",
                    yards=alt_adj,
                    description=f"{weather.altitude_ft:.0f}ft elevation — ball carries {abs(alt_adj)} yds farther",
                ))
                total_adj += alt_adj

        # 5. Conditions
        if weather.conditions == "soft":
            cond_adj = round(raw_distance * 0.03)  # 3% more for soft conditions (less roll)
            if cond_adj >= 2:
                adjustments.append(ShotAdjustment(
                    type="conditions",
                    yards=cond_adj,
                    description=f"Soft conditions — less roll, plays {cond_adj} yds longer",
                ))
                total_adj += cond_adj
        elif weather.conditions == "firm":
            cond_adj = round(-raw_distance * 0.02)
            if cond_adj <= -2:
                adjustments.append(ShotAdjustment(
                    type="conditions",
                    yards=cond_adj,
                    description=f"Firm conditions — extra roll, plays {abs(cond_adj)} yds shorter",
                ))
                total_adj += cond_adj

    adjusted = raw_distance + total_adj
    return max(1, adjusted), adjustments


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
