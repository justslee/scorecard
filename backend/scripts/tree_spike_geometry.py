"""Pure-stdlib geometry for the tree-detection feasibility spike.

This module is intentionally dependency-free (no numpy/Pillow) so it imports under
the app venv and its unit tests run in CI with zero new dependencies. The heavy raster
work (numpy + Pillow) lives in the sibling ``tree_detect_spike.py`` harness, which runs
ONLY in an isolated spike venv — never under the app environment.

Coordinate conventions match the app's existing idioms:
- Slippy-map / Web-Mercator tile math (same scheme ESRI World Imagery serves).
- Equirectangular local metres using ``111_320 * cos(mid_lat)`` for lon, mirroring
  ``backend/app/caddie/hazards.py::_xy_m``.

Spike, 2026-07-09. See specs/tree-detection-cv-spike-plan.md and
specs/tree-detection-cv-findings.md.
"""

from __future__ import annotations

import math
from typing import List, Tuple

# ESRI World Imagery XYZ tiles (keyless): note y BEFORE x in the path.
ESRI_WORLD_IMAGERY = (
    "https://server.arcgisonline.com/ArcGIS/rest/services/"
    "World_Imagery/MapServer/tile/{z}/{y}/{x}"
)

_EARTH_CIRCUMFERENCE_M = 40_075_016.686  # Web-Mercator equatorial circumference
_METERS_PER_DEG_LAT = 111_320.0
_YARDS_PER_METER = 1.0936132983377078

LatLng = Tuple[float, float]


def latlng_to_tile(lat: float, lng: float, z: float) -> Tuple[int, int, float, float]:
    """Return (xtile, ytile, px, py): integer tile indices plus the 0-255 pixel offset
    within that tile for the given lat/lng at zoom ``z``."""
    n = 2.0 ** z
    xf = (lng + 180.0) / 360.0 * n
    lat_r = math.radians(lat)
    yf = (1.0 - math.asinh(math.tan(lat_r)) / math.pi) / 2.0 * n
    xtile, ytile = int(math.floor(xf)), int(math.floor(yf))
    px = (xf - xtile) * 256.0
    py = (yf - ytile) * 256.0
    return xtile, ytile, px, py


def tile_to_latlng(xtile: float, ytile: float, z: float) -> LatLng:
    """Return the (lat, lng) of the NW corner of tile (xtile, ytile) at zoom ``z``.
    Accepts fractional tile coordinates for sub-tile positions."""
    n = 2.0 ** z
    lng = xtile / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * ytile / n))))
    return lat, lng


def meters_per_pixel(lat: float, z: float) -> float:
    """Ground resolution (metres/pixel) of a 256-px Web-Mercator tile at ``lat``/``z``."""
    return _EARTH_CIRCUMFERENCE_M * math.cos(math.radians(lat)) / (256.0 * 2.0 ** z)


def corridor_bbox(
    tee: LatLng, green: LatLng, buffer_yd: float = 60.0
) -> Tuple[float, float, float, float]:
    """Bounding box (min_lat, min_lng, max_lat, max_lng) around the tee->green corridor,
    padded laterally by ``buffer_yd`` yards to include flanking trees."""
    lat_min = min(tee[0], green[0])
    lat_max = max(tee[0], green[0])
    lng_min = min(tee[1], green[1])
    lng_max = max(tee[1], green[1])
    buf_m = buffer_yd / _YARDS_PER_METER
    dlat = buf_m / _METERS_PER_DEG_LAT
    mid_lat = (lat_min + lat_max) / 2.0
    dlng = buf_m / (_METERS_PER_DEG_LAT * math.cos(math.radians(mid_lat)))
    return (lat_min - dlat, lng_min - dlng, lat_max + dlat, lng_max + dlng)


def carry_yards(origin: LatLng, point: LatLng) -> float:
    """Great-ish-circle distance in yards using the equirectangular approximation
    (same idiom as hazards.py::_xy_m). Fine for hole-scale distances."""
    mid_lat = math.radians((origin[0] + point[0]) / 2.0)
    dx = math.radians(point[1] - origin[1]) * math.cos(mid_lat) * 6_371_000.0
    dy = math.radians(point[0] - origin[0]) * 6_371_000.0
    return math.hypot(dx, dy) * _YARDS_PER_METER


def runs_from_bools(samples: List[bool], step_yd: float) -> List[Tuple[float, float]]:
    """Given a boolean sample along a line (index i is at distance i*step_yd from the
    start) return contiguous True runs as (start_yd, end_yd) intervals. This is the
    carry-to-clear interval math: a shot must fly to ``end_yd`` to clear that run."""
    runs: List[Tuple[float, float]] = []
    start: int | None = None
    for i, v in enumerate(samples):
        if v and start is None:
            start = i
        elif not v and start is not None:
            runs.append((start * step_yd, (i - 1) * step_yd))
            start = None
    if start is not None:
        runs.append((start * step_yd, (len(samples) - 1) * step_yd))
    return runs
