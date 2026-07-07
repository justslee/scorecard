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
  - û = unit vector along the tee→green travel direction.
  - h = hazard centroid − tee (metres, equirectangular projection).
  - carry_yards = dot(h, û), converted to yards, rounded to the nearest 5,
    negatives clamped to 0 (a hazard "behind" the tee never happens for a
    real bunker/water feature, but the clamp keeps the number sane).
  - line_side = sign of cross(û, h): POSITIVE = LEFT of the travel direction,
    negative = right. A 10-yard lateral deadband collapses near-line hazards
    to "center" rather than reporting noisy left/right jitter.
"""

from __future__ import annotations

import math
from typing import Optional

from app.caddie.types import Hazard
from app.services.course_spatial import _ring_centroid

# Metres per degree of latitude (WGS-84 mean) — mirrors the equirectangular
# idiom used throughout course_spatial.py (_deg_to_m et al).
_LAT_M_PER_DEG: float = 111_320.0

_YARDS_PER_METER: float = 1.09361
_LATERAL_DEADBAND_YARDS: float = 10.0
_DEFAULT_CAP: int = 5

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


def extract_hole_hazards(
    features: Optional[dict],
    *,
    tee: Optional[dict] = None,
    green: Optional[dict] = None,
    cap: int = _DEFAULT_CAP,
) -> list[Hazard]:
    """Extract real bunker/water hazards from a hole's stored GeoJSON FeatureCollection.

    Args:
        features: ``{"type": "FeatureCollection", "features": [...]}`` — the
            per-hole shape returned by ``courses_mapped.get_course()``.
        tee, green: optional ``{"lat", "lng"}`` fallback points, used only when
            the FeatureCollection itself has no derivable tee/green geometry.
        cap: max hazards returned (nearest-first).

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
