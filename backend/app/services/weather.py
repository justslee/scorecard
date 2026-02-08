"""Weather data service using Open-Meteo (free, no API key)."""

import httpx
import math
from typing import Optional

# Open-Meteo API (free, no key required)
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"

# Standard conditions baseline
STANDARD_TEMP_F = 70.0
STANDARD_PRESSURE_HPA = 1013.25
STANDARD_ALTITUDE_FT = 0.0


async def fetch_weather(lat: float, lng: float) -> dict:
    """Fetch current weather conditions for a golf course location.

    Returns dict with:
        temperature_f, humidity, wind_speed_mph, wind_direction,
        wind_gusts_mph, pressure_hpa, precipitation_mm
    """
    params = {
        "latitude": lat,
        "longitude": lng,
        "current": ",".join([
            "temperature_2m",
            "relative_humidity_2m",
            "wind_speed_10m",
            "wind_direction_10m",
            "wind_gusts_10m",
            "surface_pressure",
            "precipitation",
        ]),
        "temperature_unit": "fahrenheit",
        "wind_speed_unit": "mph",
        "timezone": "auto",
    }

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(OPEN_METEO_URL, params=params)
        resp.raise_for_status()
        data = resp.json()

    current = data.get("current", {})
    return {
        "temperature_f": current.get("temperature_2m", 70.0),
        "humidity": current.get("relative_humidity_2m", 50.0),
        "wind_speed_mph": current.get("wind_speed_10m", 0.0),
        "wind_direction": current.get("wind_direction_10m", 0),
        "wind_gusts_mph": current.get("wind_gusts_10m", 0.0),
        "pressure_hpa": current.get("surface_pressure", 1013.25),
        "precipitation_mm": current.get("precipitation", 0.0),
    }


def compute_air_density_factor(
    temperature_f: float,
    humidity: float,
    pressure_hpa: float,
    altitude_ft: float,
) -> float:
    """Compute air density factor relative to standard conditions.

    Returns a multiplier where:
        1.0  = standard conditions (70F, sea level, 50% humidity)
        <1.0 = thinner air (ball goes farther) - high altitude, hot, humid
        >1.0 = denser air (ball goes shorter) - low altitude, cold, dry
    """
    temp_c = (temperature_f - 32) * 5 / 9
    std_temp_c = (STANDARD_TEMP_F - 32) * 5 / 9

    # Pressure decreases ~12 hPa per 100m altitude
    altitude_m = altitude_ft * 0.3048
    effective_pressure = pressure_hpa

    # Saturation vapor pressure (Magnus formula)
    def svp(t: float) -> float:
        return 6.1078 * math.exp((17.27 * t) / (t + 237.3))

    # Air density proportional to pressure / temperature, adjusted for humidity
    vapor_pressure = (humidity / 100.0) * svp(temp_c)
    dry_pressure = effective_pressure - vapor_pressure

    std_vapor = 0.5 * svp(std_temp_c)
    std_dry = STANDARD_PRESSURE_HPA - std_vapor

    # Density ratio (dry air is denser than moist air at same P and T)
    temp_k = temp_c + 273.15
    std_temp_k = std_temp_c + 273.15

    # rho = (Pd * Md + Pv * Mv) / (R * T)
    # Simplified ratio:
    density_ratio = (
        (dry_pressure * 28.97 + vapor_pressure * 18.02)
        / (std_dry * 28.97 + std_vapor * 18.02)
        * (std_temp_k / temp_k)
    )

    return density_ratio


def compute_wind_adjustment(
    wind_speed_mph: float,
    wind_direction_deg: float,
    shot_bearing_deg: float,
    shot_distance_yards: float,
) -> dict:
    """Compute wind effect on a golf shot.

    Returns dict with:
        distance_adjustment: +/- yards (positive = shot plays longer)
        lateral_adjustment: +/- yards (positive = pushed right)
        description: human-readable wind effect
    """
    if wind_speed_mph < 2:
        return {
            "distance_adjustment": 0,
            "lateral_adjustment": 0,
            "description": "Calm - no wind effect",
        }

    # Wind relative to shot direction
    # Wind direction is where it comes FROM (meteorological convention)
    # So headwind = wind_direction ~= shot_bearing (wind coming at you)
    relative_angle = math.radians(wind_direction_deg - shot_bearing_deg)

    # Headwind component (positive = into you)
    headwind = wind_speed_mph * math.cos(relative_angle)
    # Crosswind component (positive = from the left, pushing right)
    crosswind = wind_speed_mph * math.sin(relative_angle)

    # Distance adjustment rules of thumb:
    # Headwind: +1% per 1 mph (stronger effect)
    # Tailwind: -0.5% per 1 mph (weaker effect due to backspin)
    if headwind > 0:
        dist_pct = headwind * 0.01  # headwind adds distance needed
    else:
        dist_pct = headwind * 0.005  # tailwind (negative headwind)

    distance_adj = round(shot_distance_yards * dist_pct)

    # Lateral: ~1 yard per mph crosswind per 100 yards of carry
    lateral_adj = round(crosswind * (shot_distance_yards / 100))

    # Description
    if abs(headwind) > abs(crosswind):
        if headwind > 5:
            desc = f"Into wind ({wind_speed_mph:.0f} mph) — plays {abs(distance_adj)} yards longer"
        elif headwind < -5:
            desc = f"Downwind ({wind_speed_mph:.0f} mph) — plays {abs(distance_adj)} yards shorter"
        else:
            desc = f"Light {'head' if headwind > 0 else 'tail'}wind — minimal effect"
    else:
        direction = "left-to-right" if crosswind > 0 else "right-to-left"
        desc = f"Crosswind {direction} ({wind_speed_mph:.0f} mph) — aim {abs(lateral_adj)} yards {'left' if crosswind > 0 else 'right'}"

    return {
        "distance_adjustment": distance_adj,
        "lateral_adjustment": lateral_adj,
        "description": desc,
    }


def estimate_conditions(
    temperature_f: float,
    humidity: float,
    precipitation_mm: float,
) -> str:
    """Estimate course conditions from weather data.

    Returns: 'soft', 'medium', or 'firm'
    """
    if precipitation_mm > 2:
        return "soft"
    if precipitation_mm > 0.5:
        return "medium"

    # Hot + dry = firm, cool + humid = soft
    firmness_score = 0.0
    if temperature_f > 85:
        firmness_score += 1.0
    elif temperature_f > 75:
        firmness_score += 0.5
    elif temperature_f < 55:
        firmness_score -= 0.5

    if humidity < 40:
        firmness_score += 0.5
    elif humidity > 75:
        firmness_score -= 0.5

    if firmness_score >= 1.0:
        return "firm"
    elif firmness_score <= -0.5:
        return "soft"
    return "medium"
