"""Pure-geometry spatial join: assign unlabeled OSM golf polygons to their holes.

No database, no network, no new dependencies.  Works entirely on GeoJSON dicts
in memory.  This is the I1 Bethpage POC spatial-join step.

Algorithm overview
------------------
1.  For each polygon, derive a *representative point* (centroid of its outer ring).
2.  Find the nearest hole LineString across ALL supplied holes (not just the target
    course) so cross-course rejection is possible: a polygon closest to a non-target
    hole is excluded from the output.
    Feature-type-specific matching:
    - ``green``    → distance to the LineString **last** vertex (the pin end).
    - ``tee``      → distance to the LineString **first** vertex (the tee end).
    - everything else → minimum distance to **any point on any segment**.
3.  Tag each polygon with its nearest hole's ``ref`` and ``course_name``.
4.  ``build_course_feature_collection`` keeps only polygons whose nearest hole
    belongs to the target course, then groups them by hole number into the shape
    expected by ``courses_mapped.upsert_course``.

Distance maths
--------------
The equirectangular (flat-earth) approximation is used throughout.  It is accurate
to ≲ 0.1 % over golf-course distances (< 5 km).  No new Python dependency is
required — only ``math`` from the standard library.
"""

from __future__ import annotations

import math
from typing import Optional


# ── Constants ──────────────────────────────────────────────────────────────────

_LAT_M_PER_DEG: float = 111_320.0  # metres per degree of latitude (WGS-84 mean)


# ── Equirectangular distance helpers ──────────────────────────────────────────


def _deg_to_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Return the equirectangular (flat-earth) distance in metres.

    The longitude scaling uses the average latitude of the two points, which is
    accurate to ≲ 0.1 % for the distances encountered on a single golf course.

    Args:
        lat1, lon1: First WGS-84 coordinate (decimal degrees).
        lat2, lon2: Second WGS-84 coordinate (decimal degrees).
    """
    mid_lat_rad = math.radians((lat1 + lat2) / 2.0)
    dx = (lon2 - lon1) * _LAT_M_PER_DEG * math.cos(mid_lat_rad)
    dy = (lat2 - lat1) * _LAT_M_PER_DEG
    return math.hypot(dx, dy)


def _point_to_segment_dist_m(
    px: float,
    py: float,
    ax: float,
    ay: float,
    bx: float,
    by: float,
) -> float:
    """Distance in metres from point P(lon, lat) to line-segment A→B.

    All inputs are decimal degrees (``x`` = longitude, ``y`` = latitude).
    Uses the equirectangular approximation to project into a flat metre-space
    centred near the segment before computing the perpendicular distance.

    If the foot of the perpendicular falls outside [A, B], the distance to the
    nearer endpoint is returned instead.

    Args:
        px, py: Query point (lon, lat).
        ax, ay: Segment start (lon, lat).
        bx, by: Segment end (lon, lat).
    """
    # Project everything into a flat metric space whose y-scale is fixed at the
    # mean latitude of the two segment endpoints.
    mid_lat_rad = math.radians((ay + by) / 2.0)
    cos_lat = math.cos(mid_lat_rad)
    m_per_lon = _LAT_M_PER_DEG * cos_lat

    px_m = px * m_per_lon
    py_m = py * _LAT_M_PER_DEG
    ax_m = ax * m_per_lon
    ay_m = ay * _LAT_M_PER_DEG
    bx_m = bx * m_per_lon
    by_m = by * _LAT_M_PER_DEG

    abx = bx_m - ax_m
    aby = by_m - ay_m
    seg_len2 = abx * abx + aby * aby

    if seg_len2 == 0.0:
        # Degenerate zero-length segment: fall back to point-to-point.
        return math.hypot(px_m - ax_m, py_m - ay_m)

    # Scalar projection of AP onto AB, clamped to [0, 1].
    t = ((px_m - ax_m) * abx + (py_m - ay_m) * aby) / seg_len2
    t = max(0.0, min(1.0, t))

    # Closest point on segment in metre-space.
    cx_m = ax_m + t * abx
    cy_m = ay_m + t * aby

    return math.hypot(px_m - cx_m, py_m - cy_m)


# ── Polygon centroid ──────────────────────────────────────────────────────────


def _ring_centroid(ring: list[list[float]]) -> tuple[float, float]:
    """Return the (lon, lat) centroid of a GeoJSON ring.

    Uses the simple arithmetic mean of unique vertices (the duplicate closing
    vertex is excluded when ``ring[0] == ring[-1]``).  Accurate enough for
    convex-ish golf-feature polygons.

    Args:
        ring: List of ``[lon, lat]`` pairs as in GeoJSON ``coordinates[0]``.

    Returns:
        ``(centroid_lon, centroid_lat)``
    """
    # Exclude the closing duplicate vertex so it does not bias the mean.
    vertices = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
    lons = [c[0] for c in vertices]
    lats = [c[1] for c in vertices]
    return sum(lons) / len(lons), sum(lats) / len(lats)


# ── LineString distance with matching mode ────────────────────────────────────


def _match_mode(feature_type: str) -> str:
    """Return the distance-matching mode for a given polygon feature type.

    - ``"green"``  → ``"end"``     (greens sit at the hole's pin end).
    - ``"tee"``    → ``"start"``   (tee boxes are at the start of the hole).
    - anything else → ``"nearest"`` (minimum distance to any point on the line).
    """
    if feature_type == "green":
        return "end"
    if feature_type == "tee":
        return "start"
    return "nearest"


def _linestring_dist_m(
    lon: float,
    lat: float,
    coords: list[list[float]],
    mode: str,
) -> float:
    """Distance in metres from ``(lon, lat)`` to a LineString, given a matching mode.

    Args:
        lon, lat: Representative point (centroid) of the polygon.
        coords:   ``LineString.coordinates`` — list of ``[lon, lat]`` pairs.
        mode:     ``"nearest"`` — minimum distance to any segment.
                  ``"end"``     — distance to the **last** vertex (green rule).
                  ``"start"``   — distance to the **first** vertex (tee rule).

    Returns:
        Distance in metres, or ``float("inf")`` for an empty coordinate list.
    """
    if not coords:
        return float("inf")

    if mode == "end":
        end = coords[-1]
        return _deg_to_m(lat, lon, end[1], end[0])

    if mode == "start":
        start = coords[0]
        return _deg_to_m(lat, lon, start[1], start[0])

    # mode == "nearest": minimum perpendicular distance over all segments.
    if len(coords) == 1:
        return _deg_to_m(lat, lon, coords[0][1], coords[0][0])

    min_dist = float("inf")
    for i in range(len(coords) - 1):
        ax, ay = coords[i][0], coords[i][1]
        bx, by = coords[i + 1][0], coords[i + 1][1]
        d = _point_to_segment_dist_m(lon, lat, ax, ay, bx, by)
        if d < min_dist:
            min_dist = d
    return min_dist


# ── Core spatial join ─────────────────────────────────────────────────────────


def assign_features_to_holes(
    holes: list[dict],
    polygons: list[dict],
) -> dict[str, tuple[Optional[str], Optional[str], float]]:
    """Assign each polygon to its nearest hole LineString.

    ALL holes from ALL courses must be supplied so cross-course rejection works:
    a polygon nearest a non-target hole will carry that course's name in the
    return value and will be filtered out by
    :func:`build_course_feature_collection`.

    Args:
        holes:    GeoJSON Feature list where each feature has
                  ``geometry.type == "LineString"`` and ``properties`` containing
                  at minimum ``course_name`` (from the OSM ``golf:course:name``
                  tag, added to hole Features by ``_parse_course_geometry_response``)
                  and ``ref`` (hole number string).
        polygons: GeoJSON Feature list where each feature has
                  ``geometry.type == "Polygon"`` and ``properties.featureType``
                  (``"green" | "tee" | "fairway" | "bunker" | "water"``).

    Returns:
        Mapping ``{osm_id: (hole_ref, course_name, distance_m)}`` for every
        polygon.  Entries with no holes available will have
        ``(None, None, float("inf"))``.
    """
    assignments: dict[str, tuple[Optional[str], Optional[str], float]] = {}

    for poly in polygons:
        props = poly.get("properties") or {}
        osm_id: str = props.get("osm_id", "")
        feature_type: str = props.get("featureType", "")
        geom = poly.get("geometry") or {}
        rings = geom.get("coordinates") or []

        if not rings or not rings[0]:
            assignments[osm_id] = (None, None, float("inf"))
            continue

        clon, clat = _ring_centroid(rings[0])
        mode = _match_mode(feature_type)

        best_ref: Optional[str] = None
        best_course: Optional[str] = None
        best_dist = float("inf")

        for hole in holes:
            h_props = hole.get("properties") or {}
            h_coords = (hole.get("geometry") or {}).get("coordinates") or []
            if not h_coords:
                continue
            dist = _linestring_dist_m(clon, clat, h_coords, mode)
            if dist < best_dist:
                best_dist = dist
                best_ref = h_props.get("ref")
                best_course = h_props.get("course_name")

        assignments[osm_id] = (best_ref, best_course, best_dist)

    return assignments


# ── Build per-hole GeoJSON for upsert_course ──────────────────────────────────


def _ref_to_int(ref: Optional[str]) -> int:
    """Convert a hole ref string (``"1"``–``"18"``) to int for sorting."""
    try:
        return int(ref or "0")
    except ValueError:
        return 0


def build_course_feature_collection(
    holes: list[dict],
    polygons: list[dict],
    target_course_name: str,
) -> list[dict]:
    """Group polygons into per-hole dicts compatible with ``upsert_course``.

    Runs the full spatial join over ALL supplied holes (cross-course rejection
    is automatic), then keeps only polygons whose nearest hole belongs to
    *target_course_name*.  The result is a list of hole dicts — one entry per
    hole that received at least one feature — ordered by hole number.

    Each hole dict has the structure expected by
    :func:`~app.services.courses_mapped.upsert_course`:

    .. code-block:: python

        {
            "number":   <int>,   # from OSM ref tag
            "par":      None,    # callers merge in card data before upsert
            "handicap": None,
            "yardages": {},
            "features": {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"featureType": "green", ...},
                        "geometry": {...},
                    },
                    ...
                ],
            },
        }

    Args:
        holes:              All hole LineString features (all courses).
        polygons:           All unlabeled polygon features.
        target_course_name: The course to keep; compared case-insensitively
                            against ``properties.course_name``.

    Returns:
        List of hole dicts, sorted ascending by hole number.  Empty list when
        no polygons could be assigned to the target course.
    """
    assignments = assign_features_to_holes(holes, polygons)
    target_lower = target_course_name.lower()

    # Index polygons by osm_id for O(1) lookup.
    poly_by_id: dict[str, dict] = {
        (p.get("properties") or {}).get("osm_id", ""): p
        for p in polygons
    }

    # Group features by hole ref, keeping only target-course assignments.
    hole_features: dict[str, list[dict]] = {}
    for osm_id, (hole_ref, course_name, _dist) in assignments.items():
        if course_name is None or course_name.lower() != target_lower:
            continue
        if hole_ref is None:
            continue
        poly = poly_by_id.get(osm_id)
        if poly is None:
            continue
        hole_features.setdefault(hole_ref, []).append(poly)

    # Emit one hole dict per ref, sorted by numeric hole number.
    result: list[dict] = []
    for ref, features in sorted(hole_features.items(), key=lambda kv: _ref_to_int(kv[0])):
        feature_list = [
            {
                "type": "Feature",
                "properties": (f.get("properties") or {}),
                "geometry": f.get("geometry"),
            }
            for f in features
        ]
        result.append(
            {
                "number": _ref_to_int(ref),
                "par": None,
                "handicap": None,
                "yardages": {},
                "features": {"type": "FeatureCollection", "features": feature_list},
            }
        )
    return result
