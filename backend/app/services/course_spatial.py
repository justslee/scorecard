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
5.  A per-feature-type corridor distance cap drops features that are assigned to
    the correct course but are too far from the hole's centerline — belt-and-
    suspenders against stray polygons from tightly-packed multi-course venues.

Distance maths
--------------
The equirectangular (flat-earth) approximation is used throughout.  It is accurate
to ≲ 0.1 % over golf-course distances (< 5 km).  No new Python dependency is
required — only ``math`` from the standard library.
"""

from __future__ import annotations

import math
import re
from typing import Optional


# ── Constants ──────────────────────────────────────────────────────────────────

_LAT_M_PER_DEG: float = 111_320.0  # metres per degree of latitude (WGS-84 mean)


# ── Corridor distance caps ────────────────────────────────────────────────────

_CORRIDOR_CAPS_M: dict[str, float] = {
    # Distance (metres) beyond which a polygon is dropped even after it has been
    # assigned to the correct target-course hole.  Belt-and-suspenders against
    # stray polygons from neighbouring holes/courses at venues like Bethpage.
    #
    # Measurement mode (see _match_mode / assign_features_to_holes):
    #   green/tee  → "end"/"start": centroid ↔ hole endpoint/start vertex
    #   everything else → "nearest": centroid ↔ nearest point on centerline
    #
    # Cap rationale (tightened 2026-06-29 — corridor-tighten fix):
    #   • green/tee: legitimate centroid ≤ 50–80 m from endpoint; 120 m gives
    #     headroom for oddly-shaped greens/tees without pulling in strays.
    #   • fairway: hole centerline typically runs through the fairway polygon
    #     (Tier-1 overlap) so centroid-dist is small; 200 m catches offset strips.
    #   • bunker: greenside and fairway bunkers sit ≤ 120 m from the centerline.
    #   • water: ponds at Bethpage Black are at most ~100 m from the nearest
    #     centerline point; tightened from 250 → 130 m to stop stray cross-hole
    #     pond contamination while retaining genuine lateral water hazards.
    #   • woods/tree: individual tree rows and clusters that legitimately belong to
    #     a hole are ≤ 120 m from the centerline; the old 300–500 m caps allowed
    #     neighbouring-hole forest blocks to appear on the wrong diagram.
    #     Tightened from 500/300 → 150/120 m.  The large-polygon bbox filter
    #     (_WOODS_MAX_SPAN_M) handles campus-scale forest blobs separately.
    "green":   120.0,   # legitimate green centroid ≤ 50–80 m from hole endpoint
    "tee":     120.0,   # legitimate tee centroid ≤ 50–80 m from hole start
    "fairway": 200.0,   # fairway can be offset up to ~150 m laterally
    "bunker":  150.0,   # bunkers hug the corridor
    "water":   130.0,   # tightened from 250 m — stray cross-hole ponds excluded
    "rough":   500.0,   # rough strips can run the full length of the hole
    "woods":   150.0,   # tightened from 500 m — neighbouring-hole forests excluded
    "tree":    120.0,   # tightened from 300 m — stray tree nodes excluded
}
_CORRIDOR_CAP_DEFAULT_M: float = 200.0
"""Cap for feature types not in ``_CORRIDOR_CAPS_M``."""

_WOODS_MAX_SPAN_M: float = 450.0
"""Woods/rough polygons whose bbox diagonal exceeds this are dropped.

A single forest blob whose extent spans more than ~500 m (≈ multiple holes)
is almost certainly noise — it would appear to cover the entire hole and flood
the feature count.  Individual tree-cluster polygons comfortably fit within
450 m; campus-scale forest boundary polygons are excluded.
"""


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


def _linestring_length_m(coords: list[list[float]]) -> float:
    """Return the total length (metres) of a GeoJSON LineString's coordinates.

    Sums the equirectangular distance (:func:`_deg_to_m`) between each pair
    of consecutive ``[lon, lat]`` vertices.  Used to break ties between two
    hole ways that share the same ``ref`` at a single club boundary (e.g. a
    championship course + an executive/short course) — the played-length
    way is kept, the short/practice one is dropped.  See
    ``osm_ingest.apply_boundary_hole_selection``'s "Duplicate-ref dedupe"
    section.

    Args:
        coords: ``[[lon, lat], ...]`` vertex list.

    Returns:
        Total length in metres.  ``0.0`` for fewer than 2 vertices.
    """
    if len(coords) < 2:
        return 0.0
    total = 0.0
    for i in range(len(coords) - 1):
        lon1, lat1 = coords[i][0], coords[i][1]
        lon2, lat2 = coords[i + 1][0], coords[i + 1][1]
        total += _deg_to_m(lat1, lon1, lat2, lon2)
    return total


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


# ── Polygon interior tests ────────────────────────────────────────────────────


def _ring_bbox(ring: list[list[float]]) -> tuple[float, float, float, float]:
    """Return (min_lon, min_lat, max_lon, max_lat) bounding box of a GeoJSON ring."""
    lons = [c[0] for c in ring]
    lats = [c[1] for c in ring]
    return min(lons), min(lats), max(lons), max(lats)


def _point_in_ring(
    lon: float,
    lat: float,
    ring: list[list[float]],
    cos_lat: float,
    bbox: tuple[float, float, float, float] | None = None,
) -> bool:
    """Ray-casting point-in-polygon test in equirectangular metre space.

    Projects both the query point and every ring vertex into metres using the
    supplied ``cos_lat`` so that the ray-casting arithmetic is scale-correct
    (avoids the longitude-compression artefact that raw degrees would introduce
    for near-horizontal edges at high latitudes).

    Args:
        lon, lat:  Query point in decimal degrees.
        ring:      GeoJSON outer ring — list of ``[lon, lat]`` pairs.
        cos_lat:   ``cos(mean_latitude)`` for the polygon, used for projection.
        bbox:      Optional pre-computed bounding box for fast rejection.

    Returns:
        ``True`` if the point is strictly inside the ring.
    """
    # Fast bbox rejection.
    if bbox is not None:
        min_lon, min_lat, max_lon, max_lat = bbox
        if not (min_lon <= lon <= max_lon and min_lat <= lat <= max_lat):
            return False

    m_per_lon = _LAT_M_PER_DEG * cos_lat
    px = lon * m_per_lon
    py = lat * _LAT_M_PER_DEG

    # Exclude the closing duplicate vertex.
    verts = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
    n = len(verts)
    if n < 3:
        return False

    inside = False
    j = n - 1
    for i in range(n):
        xi = verts[i][0] * m_per_lon
        yi = verts[i][1] * _LAT_M_PER_DEG
        xj = verts[j][0] * m_per_lon
        yj = verts[j][1] * _LAT_M_PER_DEG
        # Standard ray-casting crossing test.
        if (yi > py) != (yj > py):
            x_intersect = (xj - xi) * (py - yi) / (yj - yi) + xi
            if px < x_intersect:
                inside = not inside
        j = i
    return inside


def _linestring_intersection_m(
    ls_coords: list[list[float]],
    ring: list[list[float]],
    cos_lat: float,
    bbox: tuple[float, float, float, float] | None = None,
    step_m: float = 15.0,
) -> float:
    """Approximate length (metres) of *ls_coords* that passes inside *ring*.

    Densifies the LineString to ~``step_m`` intervals, tests each sample point
    with :func:`_point_in_ring`, and sums the sub-segment lengths of samples
    that fall inside.  This is the primary signal for the improved spatial join:
    a fairway's own hole line runs longitudinally through it; a neighbour's line
    at best clips a corner, giving a much smaller (usually zero) score.

    Args:
        ls_coords: LineString coordinates — list of ``[lon, lat]`` pairs.
        ring:      GeoJSON outer ring of the polygon.
        cos_lat:   Cosine of mean polygon latitude for projection.
        bbox:      Pre-computed ring bounding box for fast inner rejection.
        step_m:    Sampling interval in metres (default 15 m).

    Returns:
        Approximate intersection length in metres (≥ 0).
    """
    if not ls_coords or len(ls_coords) < 2 or not ring:
        return 0.0

    total = 0.0
    for i in range(len(ls_coords) - 1):
        ax, ay = ls_coords[i][0], ls_coords[i][1]
        bx, by = ls_coords[i + 1][0], ls_coords[i + 1][1]
        seg_len = _deg_to_m(ay, ax, by, bx)
        if seg_len == 0.0:
            continue
        n_steps = max(1, int(math.ceil(seg_len / step_m)))
        chunk = seg_len / n_steps
        for k in range(n_steps + 1):
            t = k / n_steps
            slon = ax + t * (bx - ax)
            slat = ay + t * (by - ay)
            if _point_in_ring(slon, slat, ring, cos_lat, bbox):
                total += chunk
    return total


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


def _ring_area(ring: list[list[float]]) -> float:
    """Return the absolute planar (shoelace) area magnitude of a GeoJSON ring.

    Uses raw lon/lat degrees with NO latitude scaling.  This is only used to
    *rank* the member polygons of a single ``MultiPolygon`` complex against
    each other — those members share the same latitude, so an unscaled
    magnitude orders them correctly.  Do not "fix" this to scale by
    ``cos(lat)``; it is unnecessary for ranking and would just add cost.

    Args:
        ring: List of ``[lon, lat]`` pairs as in GeoJSON ``coordinates[0]``.

    Returns:
        Non-negative shoelace magnitude in degrees².
    """
    vertices = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
    if len(vertices) < 3:
        return 0.0
    total = 0.0
    n = len(vertices)
    for i in range(n):
        x1, y1 = vertices[i][0], vertices[i][1]
        x2, y2 = vertices[(i + 1) % n][0], vertices[(i + 1) % n][1]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


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
                  ``geometry.type == "Polygon"`` or ``"MultiPolygon"`` and
                  ``properties.featureType``
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
        geom_type: str = geom.get("type", "")
        coords_raw = geom.get("coordinates") or []

        # ── Extract centroid and outer ring ───────────────────────────────────

        outer_ring: Optional[list[list[float]]] = None

        if geom_type == "Point":
            # Individual tree/pin nodes — use coordinates directly as centroid.
            if len(coords_raw) < 2:
                assignments[osm_id] = (None, None, float("inf"))
                continue
            clon, clat = float(coords_raw[0]), float(coords_raw[1])
        elif geom_type == "Polygon":
            rings = coords_raw
            if not rings or not rings[0]:
                assignments[osm_id] = (None, None, float("inf"))
                continue
            outer_ring = rings[0]
            clon, clat = _ring_centroid(outer_ring)
        elif geom_type == "MultiPolygon":
            # Relation-sourced complex bunkers/sand areas (e.g. OSM
            # relation[golf=bunker]) arrive as ONE Feature with a list of member
            # polygons.  Pick the largest usable member as the representative
            # polygon and fall through into the same Tier 1/2/3 logic below —
            # do not duplicate it here.
            members = coords_raw
            best_member_ring: Optional[list[list[float]]] = None
            best_member_area = -1.0
            for member in members:
                if not member or not member[0] or len(member[0]) < 4:
                    continue
                area = _ring_area(member[0])
                if area > best_member_area:
                    best_member_area = area
                    best_member_ring = member[0]
            if best_member_ring is None:
                assignments[osm_id] = (None, None, float("inf"))
                continue
            outer_ring = best_member_ring
            clon, clat = _ring_centroid(outer_ring)
        else:
            # Unsupported geometry type (e.g. LineString, missing) — skip.
            assignments[osm_id] = (None, None, float("inf"))
            continue

        mode = _match_mode(feature_type)
        cos_lat = math.cos(math.radians(clat))

        # ── Tier 1 (Polygon / MultiPolygon representative ring): ──────────────
        # centerline-through-polygon overlap
        #
        # Assign to the hole whose centerline (golf=hole LineString) has the
        # greatest length of intersection running THROUGH the polygon.  A
        # fairway's own hole line runs longitudinally down it; a parallel
        # neighbour's line clips at most a corner — giving a much smaller score.
        # This resolves the Bethpage parallel-hole mis-attribution bug.

        if outer_ring is not None:
            bbox = _ring_bbox(outer_ring)
            best_overlap = 0.0
            best_overlap_ref: Optional[str] = None
            best_overlap_course: Optional[str] = None
            best_overlap_dist = float("inf")

            for hole in holes:
                h_props = hole.get("properties") or {}
                h_coords = (hole.get("geometry") or {}).get("coordinates") or []
                if not h_coords:
                    continue
                overlap = _linestring_intersection_m(h_coords, outer_ring, cos_lat, bbox)
                if overlap > best_overlap:
                    best_overlap = overlap
                    best_overlap_ref = h_props.get("ref")
                    best_overlap_course = h_props.get("course_name")
                    best_overlap_dist = _linestring_dist_m(clon, clat, h_coords, mode)

            if best_overlap > 0.0:
                assignments[osm_id] = (best_overlap_ref, best_overlap_course, best_overlap_dist)
                continue

            # ── Tier 2: ring-vertex voting ────────────────────────────────────
            #
            # No centerline passes through the polygon (e.g. a corner bunker, a
            # rough strip between holes).  Vote: each ring vertex picks its nearest
            # hole; the hole with the most votes wins.  This is more robust than
            # centroid-to-line because an elongated polygon's centroid may drift
            # close to a parallel neighbour even when most of its boundary is near
            # the intended hole.

            sample_verts = (
                outer_ring[:-1]
                if len(outer_ring) > 1 and outer_ring[0] == outer_ring[-1]
                else outer_ring
            )
            vote_count: dict[str, int] = {}
            vote_course_map: dict[str, Optional[str]] = {}
            vote_best_dist: dict[str, float] = {}

            for vcoord in sample_verts:
                vlon, vlat = vcoord[0], vcoord[1]
                v_best_ref: Optional[str] = None
                v_best_course: Optional[str] = None
                v_best_dist = float("inf")
                for hole in holes:
                    h_props = hole.get("properties") or {}
                    h_coords = (hole.get("geometry") or {}).get("coordinates") or []
                    if not h_coords:
                        continue
                    d = _linestring_dist_m(vlon, vlat, h_coords, mode)
                    if d < v_best_dist:
                        v_best_dist = d
                        v_best_ref = h_props.get("ref")
                        v_best_course = h_props.get("course_name")
                if v_best_ref is not None:
                    vote_count[v_best_ref] = vote_count.get(v_best_ref, 0) + 1
                    vote_course_map[v_best_ref] = v_best_course
                    if v_best_ref not in vote_best_dist or v_best_dist < vote_best_dist[v_best_ref]:
                        vote_best_dist[v_best_ref] = v_best_dist

            if vote_count:
                winner = max(vote_count, key=lambda r: vote_count[r])
                assignments[osm_id] = (
                    winner,
                    vote_course_map[winner],
                    vote_best_dist.get(winner, float("inf")),
                )
                continue

        # ── Tier 3 (fallback for Points and degenerate Polygons): ─────────────
        # Original centroid-to-nearest-line distance.

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


def parse_leading_int_ref(ref: Optional[str]) -> Optional[int]:
    """Parse the leading run of decimal digits from an OSM hole ``ref`` tag.

    Handles the composite / annotated ``ref`` formats seen in the wild —
    e.g. Pinehurst's dual-course convention ``"1 - #2"`` or a split-tee
    ``"12A"`` — by taking only the digits at the very START of the
    (whitespace-trimmed) string.  A ref that doesn't *start* with a digit
    (e.g. ``"#3"``, where the identifying number comes after a non-digit
    prefix) can't be honestly resolved to a hole number, so this returns
    ``None`` rather than guessing.

    This is the shared, honest replacement for two separate bugs found
    during the 2026-07-17 championship-course ingest: plain ``int(ref)``
    raising on composite refs, and ``_ref_to_int``'s bare ``except``
    silently minting a fake ``0`` — which, written out as a hole
    ``"number"``, collapsed multiple real holes onto a nonexistent hole 0.
    Callers that need a real hole number MUST treat ``None`` as "skip this
    ref", never substitute ``0``.

    Examples:
        ``"7"``       -> ``7``
        ``"1 - #2"``  -> ``1``    (leading int before the dash)
        ``"12A"``     -> ``12``   (leading int before the letter)
        ``"#3"``      -> ``None`` (no digit at the START of the string)
        ``""`` / ``None`` / other junk -> ``None``

    Args:
        ref: Raw OSM ``ref`` tag value, or ``None``.

    Returns:
        The leading integer, or ``None`` if *ref* is falsy or doesn't start
        with a digit.
    """
    if not ref:
        return None
    match = re.match(r"\s*(\d+)", ref)
    if match is None:
        return None
    return int(match.group(1))


def build_course_feature_collection(
    holes: list[dict],
    polygons: list[dict],
    target_course_name: str,
) -> list[dict]:
    """Group polygons into per-hole dicts compatible with ``upsert_course``.

    Runs the full spatial join over ALL supplied holes (cross-course rejection
    is automatic), then keeps only polygons whose nearest hole belongs to
    *target_course_name*.  Two additional guards are applied before the feature
    is accepted into the output:

    1. **Corridor distance cap** — even for polygons already assigned to the
       correct course, those whose assignment distance exceeds a per-type cap
       (see :data:`_CORRIDOR_CAPS_M`) are dropped.  Belt-and-suspenders against
       stray polygons at multi-course venues like Bethpage State Park.

    2. **Large terrain polygon filter** — woods/rough polygons whose geographic
       bounding-box diagonal exceeds :data:`_WOODS_MAX_SPAN_M` are dropped.
       Campus-scale forest boundaries that span multiple holes are noise.

    The reclaim heuristic that was previously in this function (re-attributing
    non-target polygons within a fixed radius to the target course) was removed
    because it caused severe cross-course contamination at tightly-packed venues
    (e.g. Bethpage's 5 courses within 2.5 km): the 200 m reclaim radius
    captured greens/fairways/bunkers from neighbouring courses and assigned them
    to the wrong Black hole, producing 4–5 greens and 22 bunkers per hole.
    The correct fix is strict global nearest-hole rejection (already in place
    via Tiers 1–3 in :func:`assign_features_to_holes`) plus the corridor cap.

    The result is a list of hole dicts — one entry per hole that received at
    least one feature — ordered by hole number.

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

    # Group features by hole ref, keeping only target-course assignments that
    # also pass the corridor distance cap and (for woods/rough) the size filter.
    hole_features: dict[str, list[dict]] = {}
    for osm_id, (hole_ref, course_name, dist) in assignments.items():
        # ── Cross-course rejection ──────────────────────────────────────────
        # The global nearest-hole assignment (Tiers 1–3) already handles this:
        # if the nearest hole is on a non-target course the polygon is excluded.
        if course_name is None or course_name.lower() != target_lower:
            continue
        if hole_ref is None:
            continue

        poly = poly_by_id.get(osm_id)
        if poly is None:
            continue

        props = poly.get("properties") or {}
        feature_type: str = props.get("featureType", "")

        # ── Corridor distance cap ───────────────────────────────────────────
        # Drop the feature if its assignment distance exceeds the type-specific
        # cap.  This catches strays that the Tier-1/2/3 logic still assigned
        # to a target hole but that are physically far from the hole axis.
        cap = _CORRIDOR_CAPS_M.get(feature_type, _CORRIDOR_CAP_DEFAULT_M)
        if dist > cap:
            continue

        # ── Large terrain polygon filter (woods/rough only) ─────────────────
        # Giant forest/scrub polygons that span multiple holes are dropped.
        if feature_type in ("woods", "rough"):
            geom = poly.get("geometry") or {}
            rings = geom.get("coordinates") or []
            if rings and rings[0]:
                ring = rings[0]
                bbox = _ring_bbox(ring)
                mid_lat = (bbox[1] + bbox[3]) / 2
                cos_lat_poly = math.cos(math.radians(mid_lat))
                lat_span_m = (bbox[3] - bbox[1]) * _LAT_M_PER_DEG
                lon_span_m = (bbox[2] - bbox[0]) * _LAT_M_PER_DEG * cos_lat_poly
                diagonal_m = math.hypot(lat_span_m, lon_span_m)
                if diagonal_m > _WOODS_MAX_SPAN_M:
                    continue  # campus-scale polygon — drop it

        hole_features.setdefault(hole_ref, []).append(poly)

    # Emit one hole dict per ref, sorted by numeric hole number.  A ref that
    # doesn't parse to a real leading int (see parse_leading_int_ref) is
    # skipped entirely — never minted as a fake "hole 0", which used to
    # silently collapse several real holes together (2026-07-17 incident).
    result: list[dict] = []
    for ref, features in hole_features.items():
        number = parse_leading_int_ref(ref)
        if number is None:
            continue
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
                "number": number,
                "par": None,
                "handicap": None,
                "yardages": {},
                "features": {"type": "FeatureCollection", "features": feature_list},
            }
        )
    result.sort(key=lambda h: h["number"])
    return result
