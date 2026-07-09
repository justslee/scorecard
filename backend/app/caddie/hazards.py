"""Hazard extraction & formatting — grounds the caddie voice in real geometry.

Pure, unit-testable module: no DB, no network. Consumes a hole's stored GeoJSON
FeatureCollection (the curated bunker/water polygons in ``hole_features``, read
via ``courses_mapped.get_course``) and produces a capped ``Hazard`` list plus a
compact spoken-style line.

Owner escalation (2026-07-06): the realtime caddie said "260 to the left
bunker" on a hole with NO left bunker. This module is the fix — it never
invents a hazard; when tee/green geometry can't be derived it returns an
empty list, and ``HAZARD_GROUNDING_RULE`` tells the model to speak generally
instead of naming a feature that isn't in the data.

Math convention (pinned — see test_hazards.py::test_left_is_positive_cross):
  - Preferred frame: the hole's PLAYED line — the ``golf=hole`` way polyline
    (stored as a ``featureType == "hole"`` LineString, or passed via the
    ``polyline=`` arg). The hazard centroid is projected onto its nearest
    segment; carry is the CUMULATIVE along-path distance to that projection
    and side is the cross product against THAT segment's direction. On a
    dogleg, a bunker on the outside of the first leg is classified against
    the leg the player actually hits over — the tee→green chord mirrors it
    (Bethpage Black 4 incident, 2026-07-08: the hole doglegs LEFT; the 265y
    carry bunker is 32y LEFT of the played first leg but sits right of the
    straight chord, so the chord math emitted "bunker R 265y").
  - Chord fallback (no polyline available): û = unit vector along the
    tee→green direction; h = hazard centroid − tee (metres, equirectangular
    projection); carry = dot(h, û); side = sign of cross(û, h).
  - In both frames: carry_yards is converted to yards, rounded to the nearest
    5, negatives clamped to 0 (a hazard "behind" the tee never happens for a
    real bunker/water feature, but the clamp keeps the number sane).
    POSITIVE lateral = LEFT of the travel direction, negative = right. A
    10-yard lateral deadband collapses near-line hazards to "center" rather
    than reporting noisy left/right jitter.
  - Bend/dogleg (``extract_hole_bend``): the vertex with the largest
    perpendicular deviation off the tee→green chord (``dev_m = ux*vy -
    uy*vx``, positive = LEFT of the chord, same cross form as above) SELECTS
    the bend and drives the straight-hole threshold — but the SPOKEN
    direction is a different quantity: the turn cross between the tee→bend
    leg and the bend→green leg (``turn = u1x*u2y - u1y*u2x`` where u1, u2 are
    those two legs' unit vectors; turn > 0 = "left", turn < 0 = "right"). On
    a dogleg the outside corner sits on the OPPOSITE side of the straight
    chord from the way the hole actually turns (e.g. a dogleg-LEFT hole's
    corner sits right of the chord) — reporting the deviation sign instead
    of the turn cross says "right" on every dogleg-left hole, the sign-flip
    incident class this repo has been burned by twice. See
    test_hazards.py::TestExtractHoleBend for the pinned example.
"""

from __future__ import annotations

import math
from typing import Optional

from app.caddie.types import Hazard, HoleBend
from app.services.course_spatial import _ring_centroid

# Metres per degree of latitude (WGS-84 mean) — mirrors the equirectangular
# idiom used throughout course_spatial.py (_deg_to_m et al).
_LAT_M_PER_DEG: float = 111_320.0

_YARDS_PER_METER: float = 1.09361
_LATERAL_DEADBAND_YARDS: float = 10.0
_DEFAULT_CAP: int = 5
# Below this chord deviation the hole is reported as measured-straight (see
# extract_hole_bend). 15y is comfortably above OSM digitization jitter and
# the 10y hazard lateral deadband, comfortably below any bend a caddie would
# actually name.
_BEND_MIN_DEVIATION_YARDS: float = 15.0

_HAZARD_FEATURE_TYPES: frozenset[str] = frozenset({"bunker", "water"})
_SEVERITY_BY_TYPE: dict[str, str] = {"water": "death", "bunker": "moderate"}
_SIDE_ABBREV: dict[str, str] = {"left": "L", "right": "R", "center": "C"}
# bunker before water; "center" sorts after left/right within the same type
# only insofar as it appears later in extract order — grouping is by
# (type, side) so ordering here just controls type precedence.
_TYPE_ORDER: dict[str, int] = {"bunker": 0, "water": 1}


HAZARD_GROUNDING_RULE = (
    "Only name a specific hazard (bunker, water, trees) or a yardage to one if "
    "it appears in the hazard data provided for this hole. If no hazard data is "
    "given for the hole, do not invent one: speak generally about where to miss "
    '("trouble left", "keep it right-center", "bail out short") and never state '
    'a specific feature with a distance (e.g. never "a bunker at 260 on the '
    'left") unless it is in the data.'
)

BEND_GROUNDING_RULE = (
    "Only say the fairway bends or doglegs — or give a distance to a bend — if the "
    "hole-shape data for this hole or the get_bend tool provides it. If the data says "
    "the hole plays straight, say it plays straight. If no hole-shape data is given, "
    "never guess a dogleg direction or a distance to a bend."
)


def _xy_m(base_lat: float, base_lon: float, lat: float, lon: float) -> tuple[float, float]:
    """Project (lat, lon) into local (x=east, y=north) metres relative to base.

    Same equirectangular idiom as course_spatial._deg_to_m: longitude scaled by
    cos(mean latitude) so the projection stays accurate over golf-hole distances.
    """
    mid_lat_rad = math.radians((base_lat + lat) / 2.0)
    x = (lon - base_lon) * _LAT_M_PER_DEG * math.cos(mid_lat_rad)
    y = (lat - base_lat) * _LAT_M_PER_DEG
    return x, y


def _round_to_5(value: float) -> int:
    return int(round(value / 5.0)) * 5


def _feature_point(feature: dict) -> Optional[tuple[float, float]]:
    """Return the (lon, lat) representative point for a GeoJSON Feature.

    Points are used directly; Polygons use their outer-ring centroid
    (_ring_centroid — same helper the spatial-join step uses).
    """
    geom = feature.get("geometry") or {}
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if gtype == "Point" and coords and len(coords) >= 2:
        return float(coords[0]), float(coords[1])
    if gtype == "Polygon" and coords and coords[0]:
        return _ring_centroid(coords[0])
    return None


def _derive_tee_green(
    features: list[dict],
    tee: Optional[dict],
    green: Optional[dict],
) -> tuple[Optional[tuple[float, float]], Optional[tuple[float, float]]]:
    """Derive (tee_lonlat, green_lonlat) for the hole.

    Priority:
    1. ``tee``/``green`` Polygon centroids in the FeatureCollection.
    2. Fallback: a ``"hole"`` LineString's first vertex = tee, last = green.
       NOTE (tee-ordering dependency): this assumes the ``golf=hole`` way is
       digitized tee→green, which is the OSM convention. A way drawn
       green→tee would swap the derived endpoints AND reverse the polyline's
       travel direction (mirroring every side) — there is no independent
       signal here to detect that; the ingest-time yardage validation
       (test_bethpage_validation "GROSS REVERSED" check) is the guard.
    3. Last resort: the ``tee=``/``green=`` args ({"lat", "lng"} dicts).

    Never guesses a bearing — a side left `None` propagates to the caller,
    which returns `[]` rather than fabricate a travel direction.
    """
    tee_pt: Optional[tuple[float, float]] = None
    green_pt: Optional[tuple[float, float]] = None

    for f in features:
        props = f.get("properties") or {}
        ftype = props.get("featureType")
        if ftype == "tee" and tee_pt is None:
            tee_pt = _feature_point(f)
        elif ftype == "green" and green_pt is None:
            green_pt = _feature_point(f)

    if tee_pt is None or green_pt is None:
        for f in features:
            props = f.get("properties") or {}
            if props.get("featureType") != "hole":
                continue
            geom = f.get("geometry") or {}
            if geom.get("type") != "LineString":
                continue
            coords = geom.get("coordinates") or []
            if len(coords) < 2:
                continue
            if tee_pt is None:
                tee_pt = (float(coords[0][0]), float(coords[0][1]))
            if green_pt is None:
                last = coords[-1]
                green_pt = (float(last[0]), float(last[1]))
            break

    if tee_pt is None and tee:
        tee_pt = (tee.get("lng", 0.0), tee.get("lat", 0.0))
    if green_pt is None and green:
        green_pt = (green.get("lng", 0.0), green.get("lat", 0.0))

    return tee_pt, green_pt


def _hole_polyline(feature_list: list[dict]) -> Optional[list[tuple[float, float]]]:
    """Return the hole's ``golf=hole`` way as ``[(lon, lat), ...]`` when the
    FeatureCollection stores it (``featureType == "hole"`` LineString with
    ≥2 vertices) — the PLAYED line hazards should be classified against.
    ``None`` when no usable polyline exists (chord fallback)."""
    for f in feature_list:
        props = f.get("properties") or {}
        if props.get("featureType") != "hole":
            continue
        geom = f.get("geometry") or {}
        if geom.get("type") != "LineString":
            continue
        coords = geom.get("coordinates") or []
        if len(coords) >= 2:
            return [(float(c[0]), float(c[1])) for c in coords]
    return None


def _project_onto_polyline(
    path_xy: list[tuple[float, float]], hx: float, hy: float
) -> Optional[tuple[float, float]]:
    """Project the hazard point (hx, hy) onto its nearest polyline segment.

    Returns ``(carry_m, lateral_m)``:
      - carry_m = CUMULATIVE along-path distance from the polyline start to
        the projection point (the played distance to reach the hazard, not
        the straight-line chord distance).
      - lateral_m = cross product of THAT segment's unit direction with the
        hazard offset from the segment start — same sign convention as the
        chord math (positive = LEFT of travel).

    The projection parameter is clamped to each interior segment, but the
    FIRST segment extrapolates behind the tee and the LAST extrapolates past
    the green, so a hazard beyond either end keeps its true carry instead of
    being clamped to the path length (mirrors the chord path's behavior; the
    caller's max(0, ...) clamp still floors behind-the-tee carries at 0).

    Returns ``None`` when the polyline has no non-degenerate segment.
    """
    best: Optional[tuple[float, float, float]] = None  # (dist², carry, lateral)
    cum_m = 0.0
    last_seg = len(path_xy) - 2
    for i in range(len(path_xy) - 1):
        ax, ay = path_xy[i]
        bx, by = path_xy[i + 1]
        dx, dy = bx - ax, by - ay
        seg_len = math.hypot(dx, dy)
        if seg_len == 0.0:
            continue
        t = ((hx - ax) * dx + (hy - ay) * dy) / (seg_len * seg_len)
        if i > 0:
            t = max(0.0, t)
        if i < last_seg:
            t = min(1.0, t)
        px, py = ax + t * dx, ay + t * dy
        dist_sq = (hx - px) ** 2 + (hy - py) ** 2
        ux, uy = dx / seg_len, dy / seg_len
        lateral = ux * (hy - ay) - uy * (hx - ax)  # positive = LEFT of this segment
        if best is None or dist_sq < best[0]:
            best = (dist_sq, cum_m + t * seg_len, lateral)
        cum_m += seg_len
    if best is None:
        return None
    return best[1], best[2]


def extract_hole_bend(
    features: Optional[dict],
    *,
    tee: Optional[dict] = None,
    green: Optional[dict] = None,
    polyline: Optional[list] = None,
) -> Optional[HoleBend]:
    """Where/how far the fairway bends (the dogleg) on a hole, measured from
    the tee along the hole's mapped centerline.

    Identical inputs/frame to extract_hole_hazards — reuses
    _derive_tee_green/_xy_m/_hole_polyline/_project_onto_polyline so bend
    distance and hazard carry_yards are measured from the SAME tee-anchored
    origin by construction (module docstring's "bend / turn-cross" paragraph).

    Direction is the TURN CROSS (tee→bend x bend→green), NOT the sign of the
    bend vertex's chord deviation — see the module docstring and
    test_hazards.py::TestExtractHoleBend for why: the deviation sign only
    SELECTS the bend vertex (argmax |deviation|) and drives the straight-hole
    threshold; it is never the spoken direction.

    Returns:
      - None: cannot determine (no tee/green, no polyline at all, a
        degenerate polyline, or a zero-length chord) — honest unknown, never
        a guessed bearing. A hole with no mapped centerline has no interior
        vertices to define a bend, so "no polyline" can never mean "straight".
      - HoleBend(straight=True, deviation_yards=n): the max chord deviation
        among candidate vertices is below the 15y threshold.
      - HoleBend(straight=False, direction, distance_yards, deviation_yards,
        double_dogleg): a real, measured bend.

    Same reversed-way exposure as extract_hole_hazards (module docstring
    "Chord fallback" note + _derive_tee_green's tee-ordering dependency): a
    green→tee digitized way would mirror this bend's direction along with
    every hazard side, consistently — no new risk surface (guarded by the
    ingest-time "GROSS REVERSED" yardage validation, test_bethpage_validation).
    """
    feature_list: list[dict] = (features or {}).get("features") or []

    tee_pt, green_pt = _derive_tee_green(feature_list, tee, green)
    if tee_pt is None or green_pt is None:
        return None

    tee_lon, tee_lat = tee_pt
    green_lon, green_lat = green_pt

    gx, gy = _xy_m(tee_lat, tee_lon, green_lat, green_lon)
    length_m = math.hypot(gx, gy)
    if length_m == 0.0:
        return None
    ux, uy = gx / length_m, gy / length_m

    path = None
    if polyline and len(polyline) >= 2:
        path = [(float(c[0]), float(c[1])) for c in polyline]
    if path is None:
        path = _hole_polyline(feature_list)
    if path is None:
        # No interior vertices to define a bend — honest unknown, never a
        # fabricated "straight" (the chord fallback intentionally has no
        # equivalent here, unlike extract_hole_hazards).
        return None

    path_xy = [_xy_m(tee_lat, tee_lon, lat, lon) for lon, lat in path]
    tee_projected = _project_onto_polyline(path_xy, 0.0, 0.0)  # tee = frame origin
    if tee_projected is None:
        return None  # degenerate polyline (all zero-length segments)
    tee_along_m = tee_projected[0]

    if len(path_xy) < 3:
        # Only tee/green endpoints, no interior vertices at all — trivially
        # measured-straight (nothing to deviate).
        return HoleBend(straight=True, deviation_yards=0)

    # Cumulative along-path distance from the path's own start to each vertex.
    cum_m: list[float] = [0.0]
    for i in range(len(path_xy) - 1):
        ax, ay = path_xy[i]
        bx, by = path_xy[i + 1]
        cum_m.append(cum_m[-1] + math.hypot(bx - ax, by - ay))

    # Candidate interior vertices: real forward progress past the tee's own
    # projection (a kink behind the tee is back-tee routing jitter, not a
    # bend the player faces) and not coincident with the green (no outgoing
    # leg to define a turn from there).
    candidates: list[tuple[int, float, float]] = []  # (index, dev_m, along_m)
    for i in range(1, len(path_xy) - 1):
        vx, vy = path_xy[i]
        along_m = cum_m[i] - tee_along_m
        if along_m <= 0:
            continue
        if math.hypot(gx - vx, gy - vy) <= 1.0:
            continue
        dev_m = ux * vy - uy * vx  # positive = LEFT of the chord
        candidates.append((i, dev_m, along_m))

    if not candidates:
        return HoleBend(straight=True, deviation_yards=0)

    # argmax |dev_m|; exact tie -> earlier vertex (smaller along-path distance
    # sorts first — the first corner is the one the player faces).
    best_i, best_dev, best_along = max(candidates, key=lambda c: (abs(c[1]), -c[2]))
    max_dev_yards = abs(best_dev) * _YARDS_PER_METER

    if max_dev_yards < _BEND_MIN_DEVIATION_YARDS:
        return HoleBend(straight=True, deviation_yards=round(max_dev_yards))

    vx, vy = path_xy[best_i]
    v_mag = math.hypot(vx, vy)
    if v_mag == 0.0:
        # Bend vertex coincides with the tee frame origin — no tee->bend leg
        # to define a turn. Degenerate; treat as straight rather than divide
        # by zero (unreachable in practice: the along_m > 0 guard above
        # already requires real forward progress from the tee).
        return HoleBend(straight=True, deviation_yards=round(max_dev_yards))
    u1x, u1y = vx / v_mag, vy / v_mag

    dx, dy = gx - vx, gy - vy
    d_mag = math.hypot(dx, dy)  # > 1.0m, guaranteed by the candidate filter
    u2x, u2y = dx / d_mag, dy / d_mag

    # The correctness crux (module docstring): direction is the TURN cross
    # between the two legs, not the chord-deviation sign computed above.
    # turn == 0 is unreachable here — a vertex whose chord deviation is at or
    # above the threshold cannot be collinear with tee and green (collinear
    # implies dev_m == 0), so no straight-through branch is needed.
    turn = u1x * u2y - u1y * u2x
    direction = "left" if turn > 0 else "right"

    distance_yards = _round_to_5(best_along * _YARDS_PER_METER)

    # Double dogleg (honesty): any OTHER candidate with the opposite
    # deviation sign at/above the threshold means an S-shape — flag it so
    # neither mouth describes the hole as a simple single dogleg.
    double_dogleg = any(
        dev * best_dev < 0 and abs(dev) * _YARDS_PER_METER >= _BEND_MIN_DEVIATION_YARDS
        for _, dev, _ in candidates
    )

    return HoleBend(
        straight=False,
        direction=direction,
        distance_yards=distance_yards,
        deviation_yards=round(max_dev_yards),
        double_dogleg=double_dogleg,
    )


def format_bend_line(hole_number: int, bend: Optional[HoleBend]) -> str:
    """Compact spoken-style bend/dogleg line for a hole, e.g.:

        "Hole 4 shape: doglegs right at ~250y"
        "Hole 4 shape: plays straight — no significant bend"

    Returns "" when ``bend`` is None (unmapped centerline) — the line is
    simply omitted; BEND_GROUNDING_RULE tells the model never to guess a
    dogleg in that case rather than treating the omission as "straight".
    """
    if bend is None:
        return ""
    if bend.straight:
        return f"Hole {hole_number} shape: plays straight — no significant bend"
    suffix = " (double dogleg)" if bend.double_dogleg else ""
    return f"Hole {hole_number} shape: doglegs {bend.direction} at ~{bend.distance_yards}y{suffix}"


def extract_hole_hazards(
    features: Optional[dict],
    *,
    tee: Optional[dict] = None,
    green: Optional[dict] = None,
    cap: int = _DEFAULT_CAP,
    polyline: Optional[list] = None,
) -> list[Hazard]:
    """Extract real bunker/water hazards from a hole's stored GeoJSON FeatureCollection.

    Carry/side are classified against the hole's PLAYED polyline (the
    ``golf=hole`` way) whenever one is available — either passed explicitly
    via ``polyline=`` or found in the FeatureCollection itself as a
    ``featureType == "hole"`` LineString (the shape ``assemble_osm_course``
    stores). Only when NO polyline exists does the tee→green straight chord
    fall back in — the chord mirrors sides on doglegs (see module docstring).

    Args:
        features: ``{"type": "FeatureCollection", "features": [...]}`` — the
            per-hole shape returned by ``courses_mapped.get_course()``.
        tee, green: optional ``{"lat", "lng"}`` fallback points, used only when
            the FeatureCollection itself has no derivable tee/green geometry.
        cap: max hazards returned (nearest-first).
        polyline: optional explicit played-line override — GeoJSON-style
            ``[[lon, lat], ...]`` (≥2 vertices). Defaults to the
            FeatureCollection's own hole LineString, then the chord.

    Returns:
        Hazard list sorted by carry_yards ascending, capped at `cap`. Empty
        when tee or green cannot be derived from any source.
    """
    feature_list: list[dict] = (features or {}).get("features") or []

    tee_pt, green_pt = _derive_tee_green(feature_list, tee, green)
    if tee_pt is None or green_pt is None:
        return []

    tee_lon, tee_lat = tee_pt
    green_lon, green_lat = green_pt

    gx, gy = _xy_m(tee_lat, tee_lon, green_lat, green_lon)
    length_m = math.hypot(gx, gy)
    if length_m == 0.0:
        return []
    ux, uy = gx / length_m, gy / length_m

    # Played line: explicit arg wins, else the stored hole LineString. All
    # points share the tee-based local east/north frame (_xy_m) so the
    # projection math and the chord fallback are in the same coordinates.
    # Carry is measured relative to the TEE's own projection onto the path
    # (not the way's first vertex) so polyline and chord carries agree — the
    # golf=hole way often starts at the back tee, behind the derived tee.
    path = None
    if polyline and len(polyline) >= 2:
        path = [(float(c[0]), float(c[1])) for c in polyline]
    if path is None:
        path = _hole_polyline(feature_list)
    path_xy: Optional[list[tuple[float, float]]] = None
    tee_along_m = 0.0
    if path is not None:
        path_xy = [_xy_m(tee_lat, tee_lon, lat, lon) for lon, lat in path]
        tee_projected = _project_onto_polyline(path_xy, 0.0, 0.0)  # tee = frame origin
        if tee_projected is None:
            path_xy = None  # degenerate polyline (all zero-length segments)
        else:
            tee_along_m = tee_projected[0]

    hazards: list[Hazard] = []
    for f in feature_list:
        props = f.get("properties") or {}
        ftype = props.get("featureType")
        if ftype not in _HAZARD_FEATURE_TYPES:
            continue
        pt = _feature_point(f)
        if pt is None:
            continue
        h_lon, h_lat = pt
        hx, hy = _xy_m(tee_lat, tee_lon, h_lat, h_lon)

        projected = _project_onto_polyline(path_xy, hx, hy) if path_xy else None
        if projected is not None:
            carry_m = projected[0] - tee_along_m
            lateral_m = projected[1]
        else:
            carry_m = ux * hx + uy * hy
            lateral_m = ux * hy - uy * hx  # positive = LEFT of tee→green travel

        carry_yards = max(0, _round_to_5(carry_m * _YARDS_PER_METER))
        lateral_yards = lateral_m * _YARDS_PER_METER
        if lateral_yards > _LATERAL_DEADBAND_YARDS:
            line_side = "left"
        elif lateral_yards < -_LATERAL_DEADBAND_YARDS:
            line_side = "right"
        else:
            line_side = "center"

        distance_from_green = math.hypot(hx - gx, hy - gy) * _YARDS_PER_METER

        hazards.append(
            Hazard(
                type=ftype,
                side=line_side,
                distance_from_green=round(distance_from_green),
                penalty_severity=_SEVERITY_BY_TYPE.get(ftype, "moderate"),
                lat=h_lat,
                lng=h_lon,
                carry_yards=carry_yards,
                line_side=line_side,
            )
        )

    hazards.sort(key=lambda hz: hz.carry_yards)
    return hazards[:cap]


def format_hazards_line(hole_number: int, hazards: list[Hazard]) -> str:
    """Compact spoken-style hazard line for a hole, e.g.:

        "Hole 4 hazards: bunker L 245y, water R 190-230y"

    Hazards sharing a (type, line_side) are merged into a single entry — a
    single hazard renders as ``bunker L 245y``, multiple as a range
    ``bunker L 230-260y``. Groups sort bunker-before-water, nearer-first, and
    are capped at 5. Returns "" for an empty hazard list — the caller should
    omit the line entirely, which triggers the generic-language directive in
    HAZARD_GROUNDING_RULE.
    """
    if not hazards:
        return ""

    groups: dict[tuple[str, str], list[int]] = {}
    order: list[tuple[str, str]] = []
    for hz in hazards:
        key = (hz.type, hz.line_side)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(hz.carry_yards)

    order.sort(key=lambda k: (_TYPE_ORDER.get(k[0], 99), min(groups[k])))
    order = order[:5]

    parts: list[str] = []
    for ftype, side in order:
        yards = sorted(groups[(ftype, side)])
        abbrev = _SIDE_ABBREV.get(side, side[:1].upper())
        if len(yards) == 1:
            parts.append(f"{ftype} {abbrev} {yards[0]}y")
        else:
            parts.append(f"{ftype} {abbrev} {yards[0]}-{yards[-1]}y")

    return f"Hole {hole_number} hazards: " + ", ".join(parts)
