"""Course intelligence engine - builds per-hole analysis from data sources."""

import math
from typing import Optional
from app.caddie.types import (
    HoleIntelligence,
    Hazard,
    GreenSlope,
    WeatherConditions,
)
from app.services.elevation import fetch_elevation, compute_green_slope
from app.services.weather import (
    fetch_weather,
    compute_air_density_factor,
    estimate_conditions,
)


async def build_hole_intelligence(
    hole_coords: dict,
    par: int = 4,
    yards: int = 400,
    handicap_rating: int = 9,
    osm_features: Optional[dict] = None,
) -> HoleIntelligence:
    """Build intelligence for a single hole from coordinates + data sources.

    Args:
        hole_coords: {holeNumber, green: {lat, lng}, tee?: {lat, lng}, front?, back?}
        par: Hole par
        yards: Hole yardage
        handicap_rating: Hole handicap index
        osm_features: Nearby OSM features (bunkers, water, etc.)

    Returns:
        HoleIntelligence with elevation, hazards, green slope, etc.
    """
    hole_number = hole_coords.get("holeNumber", 1)
    green = hole_coords.get("green", {})
    tee = hole_coords.get("tee")

    # Fetch elevations for tee and green
    elevation_change = 0.0
    if tee and green:
        tee_elev = await fetch_elevation(tee["lat"], tee["lng"])
        green_elev = await fetch_elevation(green["lat"], green["lng"])
        if tee_elev is not None and green_elev is not None:
            elevation_change = green_elev - tee_elev  # positive = uphill

    # Effective distance adjusted for elevation
    effective_yards = yards + round(elevation_change / 3)

    # Green slope
    green_slope_data = None
    if green:
        slope_result = await compute_green_slope(green)
        if slope_result:
            green_slope_data = GreenSlope(
                direction=slope_result["direction"],
                severity=slope_result["severity"],
                percent_grade=slope_result["percent_grade"],
                description=slope_result["description"],
            )

    # Classify hazards from OSM features
    hazards: list[Hazard] = []
    if osm_features and green:
        # Process bunkers
        for bunker in osm_features.get("bunkers", []):
            center = bunker.get("center", {})
            if not center:
                continue
            dist = _distance_yards(center, green)
            side = _classify_side(center, green, tee)
            severity = "moderate" if dist < 10 else "mild"
            hazards.append(Hazard(
                type="bunker",
                side=side,
                distance_from_green=round(dist),
                penalty_severity=severity,
                lat=center.get("lat"),
                lng=center.get("lng"),
            ))

        # Process water
        for water in osm_features.get("water", []):
            center = water.get("center", {})
            if not center:
                continue
            dist = _distance_yards(center, green)
            if dist > 100:
                continue  # too far to be relevant
            side = _classify_side(center, green, tee)
            hazards.append(Hazard(
                type="water",
                side=side,
                distance_from_green=round(dist),
                penalty_severity="death",
                lat=center.get("lat"),
                lng=center.get("lng"),
            ))

    return HoleIntelligence(
        hole_number=hole_number,
        par=par,
        yards=yards,
        handicap_rating=handicap_rating,
        elevation_change_ft=round(elevation_change, 1),
        effective_yards=effective_yards,
        green_slope=green_slope_data,
        hazards=hazards,
    )


async def build_weather_conditions(
    lat: float,
    lng: float,
) -> WeatherConditions:
    """Fetch and build weather conditions for a course location."""
    try:
        weather_data = await fetch_weather(lat, lng)
    except Exception:
        return WeatherConditions()

    # Get course elevation
    altitude = await fetch_elevation(lat, lng)
    altitude_ft = altitude if altitude is not None else 0.0

    # Air density
    density = compute_air_density_factor(
        weather_data["temperature_f"],
        weather_data["humidity"],
        weather_data["pressure_hpa"],
        altitude_ft,
    )

    # Conditions estimate
    conditions = estimate_conditions(
        weather_data["temperature_f"],
        weather_data["humidity"],
        weather_data["precipitation_mm"],
    )

    return WeatherConditions(
        temperature_f=weather_data["temperature_f"],
        humidity=weather_data["humidity"],
        wind_speed_mph=weather_data["wind_speed_mph"],
        wind_direction=int(weather_data["wind_direction"]),
        wind_gusts_mph=weather_data["wind_gusts_mph"],
        pressure_hpa=weather_data["pressure_hpa"],
        altitude_ft=altitude_ft,
        air_density_factor=round(density, 4),
        conditions=conditions,
    )


def _distance_yards(p1: dict, p2: dict) -> float:
    """Approximate distance between two lat/lng points in yards."""
    lat1, lng1 = math.radians(p1.get("lat", 0)), math.radians(p1.get("lng", 0))
    lat2, lng2 = math.radians(p2.get("lat", 0)), math.radians(p2.get("lng", 0))

    dlat = lat2 - lat1
    dlng = lng2 - lng1

    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    meters = 6371000 * c
    return meters * 1.09361  # meters to yards


def _classify_side(
    feature: dict,
    green: dict,
    tee: Optional[dict],
) -> str:
    """Classify which side of the green a feature is on (left/right/front/back)."""
    if not tee:
        return "center"

    # Vector from tee to green (the "hole direction")
    hole_bearing = math.atan2(
        green.get("lng", 0) - tee.get("lng", 0),
        green.get("lat", 0) - tee.get("lat", 0),
    )

    # Vector from green to feature
    feature_bearing = math.atan2(
        feature.get("lng", 0) - green.get("lng", 0),
        feature.get("lat", 0) - green.get("lat", 0),
    )

    # Angle difference
    angle_diff = math.degrees(feature_bearing - hole_bearing) % 360

    # Classify
    if angle_diff < 45 or angle_diff > 315:
        return "back"
    elif 45 <= angle_diff < 135:
        return "right"
    elif 135 <= angle_diff < 225:
        return "front"
    else:
        return "left"
