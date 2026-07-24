"""Fixture loader + position sampler — pure, offline (specs/caddie-bench-plan
.md §1 geometry.py). Reuses the production point-in-ring math
(`app.services.course_spatial._point_in_ring`) and the production hole-hazard
geometry (`app.caddie.hazards`) — NO shapely, not a dependency and not needed.

`sample_position` HARD-VERIFIES containment (a point is actually inside/outside
the polygon it claims) and RAISES `GeometrySamplingError` on failure — a
mislabeled lie is a hard error, never a silently wrong case (§5c anti-gaming).
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from app.caddie.hazards import (
    _feature_point,
    _hole_polyline,
    _xy_m,
    extract_corridor_profile,
    extract_hole_bend,
    extract_hole_hazards,
)
from app.caddie.green_geometry import approach_bearing_deg
from app.caddie.types import HoleIntelligence
from app.services.course_spatial import _point_in_ring, _ring_bbox

from tests.eval.caddie_bench.schema import LieCategory, PositionSpec, ResolvedPosition

_LAT_M_PER_DEG = 111_320.0
_M_PER_YARD = 0.9144


class GeometrySamplingError(RuntimeError):
    """Raised when a claimed lie's containment cannot be verified — a
    position sampled in the wrong lie is a hard error, never a silent
    mislabel (§5c)."""


# ── Fixture loading ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class HoleFixture:
    fixture_id: str          # filename stem, e.g. "bethpage_black_h4"
    hole_number: int         # parsed from "..._h<N>" suffix
    par: int
    yards: Optional[int]
    features: dict           # GeoJSON FeatureCollection
    provenance: str


_HOLE_NUM_RE = re.compile(r"_h(\d+)$")


def load_hole_fixture(path: Path) -> HoleFixture:
    """Load one committed `{_provenance, par, yards, features}` fixture.
    Raises loudly (never silently drops a bad fixture) on a missing required
    key or a filename that doesn't carry the `_h<N>` hole-number suffix."""
    blob = json.loads(path.read_text())
    for key in ("par", "features"):
        if key not in blob:
            raise ValueError(f"{path}: fixture missing required key {key!r}")
    stem = path.stem
    m = _HOLE_NUM_RE.search(stem)
    if not m:
        raise ValueError(f"{path}: filename must end in '_h<N>' (hole number) — got {stem!r}")
    return HoleFixture(
        fixture_id=stem,
        hole_number=int(m.group(1)),
        par=int(blob["par"]),
        yards=blob.get("yards"),
        features=blob["features"],
        provenance=blob.get("_provenance", ""),
    )


def hole_intel_from_fixture(fx: HoleFixture) -> HoleIntelligence:
    """Mirrors `test_corner_tree_forward_bound.py::_hole_intel_from_geometry_
    fixture` — offline geometry -> `HoleIntelligence`, zero DB."""
    fc = fx.features
    hazards = extract_hole_hazards(fc)
    bend = extract_hole_bend(fc)
    corridor = extract_corridor_profile(fc)
    tee, green = _tee_green_lonlat(fc)
    bearing = approach_bearing_deg(tee[1], tee[0], green[1], green[0]) if tee and green else None
    green_depth, green_width = _green_depth_width_yards(fc, bearing)
    return HoleIntelligence(
        hole_number=fx.hole_number, par=fx.par, yards=fx.yards, effective_yards=fx.yards,
        hazards=hazards, bend=bend, corridor=corridor, approach_bearing_deg=bearing,
        green_depth_yards=green_depth, green_width_yards=green_width,
    )


# ── Feature-collection helpers ───────────────────────────────────────────────


def _features_of_type(fc: dict, feature_type: str) -> list[dict]:
    return [
        f for f in fc.get("features", [])
        if (f.get("properties") or {}).get("featureType") == feature_type
    ]


def _tee_green_lonlat(fc: dict) -> tuple[Optional[tuple[float, float]], Optional[tuple[float, float]]]:
    """(tee, green) as (lon, lat) tuples. Green = first green polygon's
    centroid, falling back to the hole polyline's last vertex. Tee = the
    hole polyline's first vertex (OSM `golf=hole` is digitized tee->green —
    same convention `hazards._derive_tee_green` relies on), falling back to
    the nearest tee-polygon centroid."""
    polyline = _hole_polyline(fc.get("features", []))
    green_feats = _features_of_type(fc, "green")
    green = _feature_point(green_feats[0]) if green_feats else None
    if green is None and polyline:
        green = polyline[-1]
    tee = polyline[0] if polyline else None
    if tee is None:
        tee_feats = _features_of_type(fc, "tee")
        tee = _feature_point(tee_feats[0]) if tee_feats else None
    return tee, green


def _green_depth_width_yards(fc: dict, bearing: Optional[float]) -> tuple[Optional[float], Optional[float]]:
    """Rough green depth (along the approach bearing) / width (perpendicular),
    in yards, from the green polygon's extent — a bounding-box approximation
    in the approach frame (good enough for the aim-point margin it feeds;
    not a precision green-contour measurement)."""
    green_feats = _features_of_type(fc, "green")
    if not green_feats or bearing is None:
        return None, None
    geom = green_feats[0].get("geometry") or {}
    if geom.get("type") != "Polygon" or not geom.get("coordinates"):
        return None, None
    ring = geom["coordinates"][0]
    base_lon, base_lat = ring[0]
    beta = math.radians(bearing)
    # Unit vectors: forward (along approach bearing), right (perpendicular).
    fwd = (math.sin(beta), math.cos(beta))
    right = (math.cos(beta), -math.sin(beta))
    fwd_vals, right_vals = [], []
    for lon, lat in ring:
        x, y = _xy_m(base_lat, base_lon, lat, lon)
        fwd_vals.append(x * fwd[0] + y * fwd[1])
        right_vals.append(x * right[0] + y * right[1])
    depth_m = max(fwd_vals) - min(fwd_vals)
    width_m = max(right_vals) - min(right_vals)
    return depth_m / _M_PER_YARD, width_m / _M_PER_YARD


def _point_in_polygon_feature(lon: float, lat: float, feature: dict) -> bool:
    geom = feature.get("geometry") or {}
    gtype = geom.get("type")
    cos_lat = math.cos(math.radians(lat))
    if gtype == "Polygon":
        coords = geom.get("coordinates") or []
        if not coords or not coords[0]:
            return False
        ring = coords[0]
        return _point_in_ring(lon, lat, ring, cos_lat, _ring_bbox(ring))
    if gtype == "MultiPolygon":
        for member in geom.get("coordinates") or []:
            if not member or not member[0]:
                continue
            ring = member[0]
            if _point_in_ring(lon, lat, ring, cos_lat, _ring_bbox(ring)):
                return True
        return False
    return False


def _in_any(lon: float, lat: float, features: list[dict]) -> bool:
    return any(_point_in_polygon_feature(lon, lat, f) for f in features)


def _interior_point_of_feature(feature: dict) -> Optional[tuple[float, float]]:
    """A point HARD-VERIFIED inside `feature`'s own polygon. `_feature_point`'s
    ring centroid is the first try, but a concave bunker/green polygon's
    centroid can fall OUTSIDE its own ring — this falls back to a bounding-box
    grid search (first grid point that verifies) rather than ever returning an
    unverified point."""
    centroid = _feature_point(feature)
    if centroid is not None and _point_in_polygon_feature(centroid[0], centroid[1], feature):
        return centroid
    geom = feature.get("geometry") or {}
    if geom.get("type") != "Polygon" or not geom.get("coordinates") or not geom["coordinates"][0]:
        return None
    ring = geom["coordinates"][0]
    min_lon, min_lat, max_lon, max_lat = _ring_bbox(ring)
    grid_n = 12
    for i in range(1, grid_n):
        for j in range(1, grid_n):
            lon = min_lon + (max_lon - min_lon) * i / grid_n
            lat = min_lat + (max_lat - min_lat) * j / grid_n
            if _point_in_polygon_feature(lon, lat, feature):
                return lon, lat
    return None


# ── Local metre-frame projection helpers ─────────────────────────────────────


def _to_xy(base_lat: float, base_lon: float, lon: float, lat: float) -> tuple[float, float]:
    return _xy_m(base_lat, base_lon, lat, lon)


def _from_xy(base_lat: float, base_lon: float, x: float, y: float) -> tuple[float, float]:
    """Inverse of `_to_xy` — returns (lon, lat)."""
    lat = base_lat + y / _LAT_M_PER_DEG
    lon = base_lon + x / (_LAT_M_PER_DEG * math.cos(math.radians(base_lat)))
    return lon, lat


def _point_on_centerline(centerline: list[tuple[float, float]], pct: float) -> tuple[float, float]:
    """(lon, lat) at fraction `pct` (0=tee, 1=green) along the tee->green
    centerline polyline, by cumulative arc length."""
    base_lon, base_lat = centerline[0]
    xy = [_to_xy(base_lat, base_lon, lon, lat) for lon, lat in centerline]
    seg_lens = [math.dist(xy[i], xy[i + 1]) for i in range(len(xy) - 1)]
    total = sum(seg_lens)
    target = max(0.0, min(1.0, pct)) * total
    if total == 0.0:
        return centerline[0]
    cum = 0.0
    for i, seg_len in enumerate(seg_lens):
        if cum + seg_len >= target or i == len(seg_lens) - 1:
            t = 0.0 if seg_len == 0 else (target - cum) / seg_len
            x = xy[i][0] + t * (xy[i + 1][0] - xy[i][0])
            y = xy[i][1] + t * (xy[i + 1][1] - xy[i][1])
            return _from_xy(base_lat, base_lon, x, y)
        cum += seg_len
    return centerline[-1]


def haversine_yards(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle-ish distance (equirectangular projection, accurate at
    golf-hole scale) between two (lon, lat) points, in yards."""
    lon1, lat1 = a
    lon2, lat2 = b
    x, y = _xy_m(lat1, lon1, lat2, lon2)
    return math.hypot(x, y) / _M_PER_YARD


def bearing_deg(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Compass bearing (0=N, 90=E, clockwise) from point a to point b."""
    lon1, lat1 = a
    lon2, lat2 = b
    x, y = _xy_m(lat1, lon1, lat2, lon2)
    if math.hypot(x, y) < 0.5:
        return 0.0
    return math.degrees(math.atan2(x, y)) % 360.0


# ── Availability probe (used by questions.py::build_cases to avoid asking
#    for a lie the fixture simply doesn't map) ───────────────────────────────


def available_lies(fx: HoleFixture) -> set[LieCategory]:
    fc = fx.features
    lies = {LieCategory.TEE, LieCategory.GREENSIDE}  # tee + centerline-anchored greenside always derivable
    polyline = _hole_polyline(fc.get("features", []))
    if polyline and len(polyline) >= 2:
        lies.add(LieCategory.FAIRWAY)
        lies.add(LieCategory.ROUGH)
    if _features_of_type(fc, "bunker"):
        lies.add(LieCategory.BUNKER)
    if _features_of_type(fc, "tree") or _features_of_type(fc, "woods"):
        lies.add(LieCategory.RECOVERY_TREES)
    return lies


# ── The sampler ───────────────────────────────────────────────────────────


def sample_position(fx: HoleFixture, spec: PositionSpec) -> ResolvedPosition:
    """Deterministic (seeded from `spec.seed`, but every candidate point this
    module tries is a closed-form function of the fixture geometry — no RNG
    is actually consumed by the geometry itself, `seed` is reserved for
    future randomized search) position sampler. RAISES `GeometrySamplingError`
    when the claimed lie's containment can't be verified."""
    fc = fx.features
    tee_lonlat, green_lonlat = _tee_green_lonlat(fc)
    if tee_lonlat is None or green_lonlat is None:
        raise GeometrySamplingError(f"{fx.fixture_id}: fixture has no resolvable tee/green coordinates")

    polyline = _hole_polyline(fc.get("features", [])) or [tee_lonlat, green_lonlat]
    fairway_feats = _features_of_type(fc, "fairway")
    bunker_feats = _features_of_type(fc, "bunker")
    water_feats = _features_of_type(fc, "water")
    green_feats = _features_of_type(fc, "green")
    tree_feats = _features_of_type(fc, "tree") + _features_of_type(fc, "woods")

    lie = spec.lie
    if lie == LieCategory.TEE:
        lon, lat = tee_lonlat

    elif lie == LieCategory.FAIRWAY:
        pct = spec.along_pct if spec.along_pct is not None else 0.5
        lon, lat = _resolve_fairway_point(polyline, pct, fairway_feats, bunker_feats, water_feats, green_feats)

    elif lie == LieCategory.ROUGH:
        pct = spec.along_pct if spec.along_pct is not None else 0.5
        lon, lat = _resolve_rough_point(polyline, pct, fairway_feats, bunker_feats, water_feats, green_feats)

    elif lie == LieCategory.BUNKER:
        if not bunker_feats:
            raise GeometrySamplingError(f"{fx.fixture_id}: no mapped bunkers — cannot sample a BUNKER position")
        pct = spec.along_pct if spec.along_pct is not None else 0.7
        anchor = _point_on_centerline(polyline, pct)
        nearest = min(
            bunker_feats,
            key=lambda f: haversine_yards(anchor, _feature_point(f) or anchor),
        )
        pt = _interior_point_of_feature(nearest)
        if pt is None:
            raise GeometrySamplingError(
                f"{fx.fixture_id}: nearest bunker feature has no point that verifies inside its own polygon"
            )
        lon, lat = pt

    elif lie == LieCategory.RECOVERY_TREES:
        if not tree_feats:
            raise GeometrySamplingError(f"{fx.fixture_id}: no mapped trees/woods — cannot sample a RECOVERY_TREES position")
        pct = spec.along_pct if spec.along_pct is not None else 0.5
        anchor = _point_on_centerline(polyline, pct)
        nearest = min(tree_feats, key=lambda f: haversine_yards(anchor, _feature_point(f) or anchor))
        pt = _feature_point(nearest)
        if pt is None:
            raise GeometrySamplingError(f"{fx.fixture_id}: nearest tree feature has no resolvable point")
        lon, lat = pt
        if _in_any(lon, lat, fairway_feats) or _in_any(lon, lat, green_feats):
            raise GeometrySamplingError(
                f"{fx.fixture_id}: RECOVERY_TREES point resolved inside fairway/green — mislabeled lie"
            )

    elif lie == LieCategory.GREENSIDE:
        if not green_feats:
            raise GeometrySamplingError(f"{fx.fixture_id}: no mapped green — cannot sample a GREENSIDE position")
        lon, lat = _resolve_greenside_point(green_feats[0], green_lonlat, tee_lonlat, bunker_feats, water_feats)

    else:
        raise AssertionError(f"unhandled LieCategory {lie!r}")

    distance = haversine_yards((lon, lat), green_lonlat)
    bearing = bearing_deg((lon, lat), green_lonlat)
    return ResolvedPosition(lat=lat, lng=lon, lie=lie, distance_to_green_yards=distance, shot_bearing_deg=bearing)


def _radial_search(
    base_lon: float, base_lat: float, predicate,
    *, min_radius_m: float = 0.0, max_radius_m: float = 200.0, radius_step_m: float = 5.0, angle_step_deg: int = 10,
) -> Optional[tuple[float, float]]:
    """Expanding radial sweep around (base_lon, base_lat) for the first point
    satisfying `predicate(lon, lat) -> bool`. Far more robust than a single
    perpendicular probe to an irregular/offset/disjoint polygon (a real
    fairway landing area is rarely centered exactly on the tee->green
    centerline). `None` if nothing satisfies within `max_radius_m`."""
    radius = max(radius_step_m, min_radius_m)
    while radius <= max_radius_m:
        for angle_deg in range(0, 360, angle_step_deg):
            theta = math.radians(angle_deg)
            x, y = radius * math.cos(theta), radius * math.sin(theta)
            lon, lat = _from_xy(base_lat, base_lon, x, y)
            if predicate(lon, lat):
                return lon, lat
        radius += radius_step_m
    return None


_FAIRWAY_FALLBACK_BAND = 0.05    # +/- fraction of the tee->green centerline searched around `pct`
_FAIRWAY_FALLBACK_STEP = 0.005   # search step, same units as `pct`/`along_pct`


def _resolve_fairway_point(
    polyline: list[tuple[float, float]], pct: float, fairway_feats: list[dict],
    bunker_feats: list[dict] = (), water_feats: list[dict] = (), green_feats: list[dict] = (),
) -> tuple[float, float]:
    centerline_pt = _point_on_centerline(polyline, pct)
    if not fairway_feats:
        # Documented fallback (fixture data gap, e.g. Bethpage Black hole 7
        # has no mapped fairway polygon in the committed Overpass fixture):
        # the OSM `golf=hole` polyline IS the played line by definition, so a
        # point ON it is honestly "fairway" even with no polygon to verify
        # against — BUT (B3 fix) that's only honest if the point isn't
        # actually inside a mapped bunker/water/green (Black-7's centerline
        # at pct ~0.23-0.28 IS inside a mapped bunker — a latent mislabel
        # this negative-verify catches). If the exact `pct` point is
        # trouble, nudge along the centerline within a small slot band
        # before giving up; NEVER silently return a hazard-covered point.
        danger = list(bunker_feats) + list(water_feats) + list(green_feats)
        lon, lat = centerline_pt
        if not _in_any(lon, lat, danger):
            return centerline_pt
        offset = _FAIRWAY_FALLBACK_STEP
        while offset <= _FAIRWAY_FALLBACK_BAND:
            for direction in (1, -1):
                candidate_pct = min(1.0, max(0.0, pct + direction * offset))
                cand_lon, cand_lat = _point_on_centerline(polyline, candidate_pct)
                if not _in_any(cand_lon, cand_lat, danger):
                    return cand_lon, cand_lat
            offset += _FAIRWAY_FALLBACK_STEP
        raise GeometrySamplingError(
            f"no-fairway-polygon centerline fallback at pct={pct} (and its +/-{_FAIRWAY_FALLBACK_BAND} slot-band "
            "neighbors) all fall inside a mapped bunker/water/green — refusing to mislabel a hazard point as FAIRWAY"
        )
    lon, lat = centerline_pt
    if _in_any(lon, lat, fairway_feats):
        return lon, lat
    found = _radial_search(lon, lat, lambda lo, la: _in_any(lo, la, fairway_feats), min_radius_m=1.0, max_radius_m=200.0)
    if found is None:
        raise GeometrySamplingError("fairway polygon present but no in-bounds point found within 200m of the centerline")
    return found


def _resolve_rough_point(
    polyline: list[tuple[float, float]], pct: float, fairway_feats: list[dict],
    bunker_feats: list[dict], water_feats: list[dict], green_feats: list[dict],
) -> tuple[float, float]:
    centerline_pt = _point_on_centerline(polyline, pct)
    danger = bunker_feats + water_feats + green_feats

    def _is_rough(lon: float, lat: float) -> bool:
        return not _in_any(lon, lat, fairway_feats) and not _in_any(lon, lat, danger)

    # Start 5m out (never claim the exact centerline is "rough") and sweep
    # outward — first point that clears fairway/bunker/water/green wins.
    found = _radial_search(*centerline_pt, _is_rough, min_radius_m=5.0, max_radius_m=150.0)
    if found is None:
        raise GeometrySamplingError("could not find a point outside fairway/bunker/water/green within 150m")
    return found


def _resolve_greenside_point(
    green_feature: dict, green_lonlat: tuple[float, float], tee_lonlat: tuple[float, float],
    bunker_feats: list[dict] = (), water_feats: list[dict] = (),
) -> tuple[float, float]:
    """Ring 10-25y around the green polygon, verified NOT inside it AND (B3
    fix, non-blocking #9) NOT inside any mapped greenside bunker/water —
    walks outward from the green centroid, along the tee->green line
    extended, in 5y steps starting at 10y past the green edge. Never returns
    a point mislabeled GREENSIDE that's actually in a bunker/water hazard."""
    base_lon, base_lat = green_lonlat
    tx, ty = _to_xy(base_lat, base_lon, *tee_lonlat)
    length = math.hypot(tx, ty) or 1.0
    dx, dy = -tx / length, -ty / length  # unit vector AWAY from the tee (green -> beyond)
    danger = list(bunker_feats) + list(water_feats)
    for offset_yd in (12, 15, 18, 20, 25):
        offset_m = offset_yd * _M_PER_YARD
        for angle_deg in (0, 45, 90, 135, 180, -45, -90, -135):
            theta = math.radians(angle_deg)
            rx = dx * math.cos(theta) - dy * math.sin(theta)
            ry = dx * math.sin(theta) + dy * math.cos(theta)
            x, y = rx * offset_m, ry * offset_m
            lon, lat = _from_xy(base_lat, base_lon, x, y)
            if not _point_in_polygon_feature(lon, lat, green_feature) and not _in_any(lon, lat, danger):
                return lon, lat
    raise GeometrySamplingError("could not find a greenside point outside the green polygon and clear of mapped bunker/water")
