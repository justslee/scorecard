"""Elevation data service using USGS EPQS (free, no API key)."""

import httpx
import math
from typing import Optional

# USGS Elevation Point Query Service
USGS_EPQS_URL = "https://epqs.nationalmap.gov/v1/json"


async def fetch_elevation(lat: float, lng: float) -> Optional[float]:
    """Fetch elevation in feet for a single point using USGS EPQS.

    Returns elevation in feet, or None if unavailable.
    """
    params = {
        "x": lng,
        "y": lat,
        "wkid": 4326,
        "units": "Feet",
    }

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(USGS_EPQS_URL, params=params)
            resp.raise_for_status()
            data = resp.json()

        value = data.get("value")
        if value is None:
            return None
        elev = float(value)
        # USGS returns -1000000 for points outside US
        if elev < -10000:
            return None
        return elev
    except Exception:
        return None


async def fetch_elevation_batch(
    points: list[tuple[float, float]],
) -> list[Optional[float]]:
    """Fetch elevation for multiple points in parallel.

    Args:
        points: List of (lat, lng) tuples

    Returns:
        List of elevation values in feet (None for failures)
    """
    import asyncio

    async def _fetch_one(lat: float, lng: float) -> Optional[float]:
        return await fetch_elevation(lat, lng)

    tasks = [_fetch_one(lat, lng) for lat, lng in points]
    return await asyncio.gather(*tasks)


async def compute_green_slope(
    green_center: dict,
    green_radius_yards: float = 15.0,
) -> Optional[dict]:
    """Estimate green slope by sampling elevation at a 3x3 grid.

    Args:
        green_center: {"lat": float, "lng": float}
        green_radius_yards: approximate green radius

    Returns dict with:
        direction: slope direction in degrees (0=N, 90=E, etc.)
        severity: 'flat', 'mild', 'moderate', 'severe'
        percent_grade: slope percentage
        description: human-readable description
    """
    lat = green_center["lat"]
    lng = green_center["lng"]

    # Convert yards to approximate degrees
    # 1 degree lat ≈ 69.17 miles ≈ 121,740 yards
    # 1 degree lng ≈ 69.17 * cos(lat) miles
    yard_to_lat = 1.0 / 121740.0
    yard_to_lng = 1.0 / (121740.0 * math.cos(math.radians(lat)))

    r = green_radius_yards * 0.7  # sample inside the green

    # 3x3 grid: NW, N, NE, W, C, E, SW, S, SE
    offsets = [
        (-r, r), (0, r), (r, r),       # top row (north)
        (-r, 0), (0, 0), (r, 0),       # middle row
        (-r, -r), (0, -r), (r, -r),    # bottom row (south)
    ]

    points = [
        (lat + dy * yard_to_lat, lng + dx * yard_to_lng)
        for dx, dy in offsets
    ]

    elevations = await fetch_elevation_batch(points)

    # Filter out None values
    valid = [(i, e) for i, e in enumerate(elevations) if e is not None]
    if len(valid) < 5:
        return None

    # Create elevation grid
    grid = [e if e is not None else 0.0 for e in elevations]

    # Compute slope using Sobel-like gradient
    # East-West gradient (dz/dx)
    dzdx = (
        (grid[2] + 2 * grid[5] + grid[8])
        - (grid[0] + 2 * grid[3] + grid[6])
    ) / (4 * r * 3)  # feet per yard (r is in yards, elevations in feet)

    # North-South gradient (dz/dy)
    dzdy = (
        (grid[0] + 2 * grid[1] + grid[2])
        - (grid[6] + 2 * grid[7] + grid[8])
    ) / (4 * r * 3)

    # Slope magnitude and direction
    slope_pct = math.sqrt(dzdx ** 2 + dzdy ** 2) * 100  # percent grade
    if slope_pct < 0.1:
        direction = 0
    else:
        # Direction the slope FALLS toward (downhill)
        direction = math.degrees(math.atan2(dzdx, -dzdy)) % 360

    # Classify severity
    if slope_pct < 1.0:
        severity = "flat"
    elif slope_pct < 2.5:
        severity = "mild"
    elif slope_pct < 5.0:
        severity = "moderate"
    else:
        severity = "severe"

    # Human-readable direction
    compass = [
        "north", "northeast", "east", "southeast",
        "south", "southwest", "west", "northwest",
    ]
    compass_idx = int((direction + 22.5) / 45) % 8
    dir_name = compass[compass_idx]

    if severity == "flat":
        description = "Relatively flat green"
    else:
        description = f"Green slopes {severity}ly toward the {dir_name}"

    return {
        "direction": round(direction, 1),
        "severity": severity,
        "percent_grade": round(slope_pct, 2),
        "description": description,
        "center_elevation_ft": grid[4],
    }
