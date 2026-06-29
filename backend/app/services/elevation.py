"""Elevation data service.

`fetch_elevation_cached` checks the `elevation_cache` Postgres table before
calling USGS EPQS. Coordinates are quantized to ~1m (5 decimal places) so a
green-slope sample that's already been fetched once never round-trips again.

The raw `fetch_elevation` is still exported for code paths that don't have
DB access (tests, scripts).

3DEP batch sampler (I4)
-----------------------
``fetch_3dep_samples`` hits the USGS 3DEP ArcGIS ImageServer ``getSamples``
endpoint, which accepts a multipoint geometry and returns one elevation per
point in a **single HTTP round-trip** — far cheaper than N serial EPQS calls
when seeding a full 18-hole course.  Falls back to ``fetch_elevation_batch``
on any error so existing callers are unaffected.

``compute_hole_elevation_profile`` is a **pure, zero-I/O** function that
wraps two sampled elevations into the per-hole profile dict consumed by
``assemble_osm_course`` (I4 attachment) and ``course_intel`` (caddie side).
"""

import asyncio
import json
import httpx
import math
from typing import Optional
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.db.engine import async_session
from app.db.models import ElevationCache

# USGS Elevation Point Query Service (single-point, returns feet)
USGS_EPQS_URL = "https://epqs.nationalmap.gov/v1/json"

# USGS 3DEP ArcGIS ImageServer — batch ``getSamples`` (returns metres)
USGS_3DEP_IMAGESERVER_URL = (
    "https://elevation.nationalmap.gov/arcgis/rest/services/"
    "3DEPElevation/ImageServer/getSamples"
)

_M_TO_FT: float = 3.28084  # metres → feet (3DEP native unit is metres)

# 5 decimal places ≈ 1.1m at the equator. Plenty for green-slope sampling and
# stays well under int32. Multiple callers within the same green/tee/fairway
# share cache rows.
_CACHE_PRECISION = 100_000


def _quantize(lat: float, lng: float) -> tuple[int, int]:
    return int(round(lat * _CACHE_PRECISION)), int(round(lng * _CACHE_PRECISION))


async def fetch_elevation(lat: float, lng: float) -> Optional[float]:
    """Fetch elevation in feet for a single point from USGS EPQS (no cache)."""
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


async def fetch_elevation_cached(lat: float, lng: float) -> Optional[float]:
    """Cached elevation lookup. Checks Postgres first, falls back to USGS.

    Misses are persisted on success so the next caller hits the cache. Failures
    are not cached — we want to retry transient USGS errors.
    """
    lat_q, lng_q = _quantize(lat, lng)

    async with async_session() as db:
        result = await db.execute(
            select(ElevationCache.elevation_ft)
            .where(ElevationCache.lat_q == lat_q, ElevationCache.lng_q == lng_q)
        )
        row = result.first()
        if row is not None:
            return float(row[0])

    elev = await fetch_elevation(lat, lng)
    if elev is None:
        return None

    async with async_session() as db:
        try:
            db.add(ElevationCache(lat_q=lat_q, lng_q=lng_q, elevation_ft=elev))
            await db.commit()
        except IntegrityError:
            await db.rollback()  # concurrent insert won the race; that's fine

    return elev


async def fetch_elevation_batch(
    points: list[tuple[float, float]],
) -> list[Optional[float]]:
    """Fetch elevation for multiple points in parallel, cache-aware."""
    return await asyncio.gather(*[fetch_elevation_cached(lat, lng) for lat, lng in points])


async def fetch_3dep_samples(
    points: list[tuple[float, float]],
) -> list[Optional[float]]:
    """Fetch elevations for multiple points in a single 3DEP ImageServer call.

    Uses the USGS 3DEP ArcGIS ImageServer ``getSamples`` endpoint, which accepts
    a multipoint geometry and returns one elevation per point in a **single HTTP
    round-trip**.  This is more efficient than N parallel EPQS calls when sampling
    tee + green points across a full 18-hole course.

    The ImageServer returns elevations in **metres**; this function converts to
    **feet** to match the EPQS convention used everywhere else in this module.

    Falls back to ``fetch_elevation_batch`` (parallel per-point EPQS queries, with
    DB cache) on any HTTP or parse error so callers always receive a result.

    Args:
        points: ``(lat, lng)`` pairs in WGS-84 decimal degrees.

    Returns:
        List of elevations in **feet**, same length as *points*.  ``None`` where
        no sample was available (out-of-coverage, nodata, or parse failure).
    """
    if not points:
        return []

    # ArcGIS expects [lon, lat] (x, y) order in WKID 4326.
    pts_lonlat = [[lng, lat] for lat, lng in points]
    geometry_json = {
        "points": pts_lonlat,
        "spatialReference": {"wkid": 4326},
    }

    params = {
        "geometry": json.dumps(geometry_json, separators=(",", ":")),
        "geometryType": "esriGeometryMultipoint",
        "returnFirstValueOnly": "false",
        "f": "json",
    }

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(USGS_3DEP_IMAGESERVER_URL, params=params)
            resp.raise_for_status()
            data = resp.json()

        samples = data.get("samples") or []

        # Pre-fill with None; use locationId (0-indexed) for robust ordering.
        results: list[Optional[float]] = [None] * len(points)
        for sample in samples:
            try:
                idx = int(sample.get("locationId", -1))
            except (TypeError, ValueError):
                continue
            if idx < 0 or idx >= len(points):
                continue
            raw = sample.get("value")
            if raw is None or raw in ("", "NoData"):
                continue
            try:
                elev_m = float(raw)
            except (TypeError, ValueError):
                continue
            # 3DEP nodata sentinel is typically -999999 or similar large negative.
            if elev_m < -1000:
                continue
            results[idx] = round(elev_m * _M_TO_FT, 2)

        return results

    except Exception:
        # Network error, HTTP error, or unexpected response shape:
        # fall back to parallel per-point EPQS queries (cache-aware).
        return await fetch_elevation_batch(points)


def compute_hole_elevation_profile(
    tee_elevation_ft: float,
    green_elevation_ft: float,
    green_slope: Optional[dict] = None,
) -> dict:
    """Compute a per-hole elevation profile from sampled tee and green elevations.

    **Pure function** — no I/O, no network, no database.  Pass fixture values in
    unit tests; pass live-sampled elevations (from ``fetch_3dep_samples`` or
    ``fetch_elevation_batch``) in production.

    The ``net_change_ft`` sign convention matches ``course_intel.py``:
    positive = the green is **higher** than the tee (uphill approach shot);
    negative = the green is **lower** (downhill).

    Args:
        tee_elevation_ft:   Elevation at the tee in feet.
        green_elevation_ft: Elevation at the green center in feet.
        green_slope:        Optional dict from ``compute_green_slope`` (or a
                            fixture); passed through unchanged as-is.

    Returns:
        Dict with keys::

            {
                "tee_elevation_ft":   float,   # rounded to 1 dp
                "green_elevation_ft": float,   # rounded to 1 dp
                "net_change_ft":      float,   # green − tee, 1 dp; + = uphill
                "green_slope":        dict | None,
            }
    """
    net_change = round(green_elevation_ft - tee_elevation_ft, 1)
    return {
        "tee_elevation_ft":   round(tee_elevation_ft, 1),
        "green_elevation_ft": round(green_elevation_ft, 1),
        "net_change_ft":      net_change,
        "green_slope":        green_slope,
    }


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
