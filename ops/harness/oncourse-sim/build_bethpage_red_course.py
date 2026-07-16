#!/usr/bin/env python3
"""build_bethpage_red_course.py — reconstruct a Bethpage Red mapped-course
JSON OFFLINE from the committed Overpass fixture (stdlib only, no network,
no auth). Matches the `CourseData` shape in
`frontend/src/lib/courses/types.ts` (read it before changing this script —
do not invent fields).

Prod GET /api/courses/mapped/{id} 401s anonymously (verified 2026-07-16),
so this script produces a standalone, committed fixture the sim harness (and
the diagnostic shim) can serve locally without hitting the network.

Assignment idea (mirrors backend/app/services/course_spatial.py, simplified
for an offline stdlib script): every green/fairway/tee/bunker polygon is
assigned to the hole whose golf=hole centerline is nearest to the polygon's
centroid, searched GLOBALLY across every course in the fixture (Red, Black,
Blue, Green, Yellow) so that a polygon nearer a neighbouring course's hole is
correctly excluded from Red instead of being misassigned by name alone.

Output: fixtures/bethpage-red-mapped.json (COMMITTED, reusable).

Usage:
    python3 build_bethpage_red_course.py
    python3 build_bethpage_red_course.py --overpass <path> --out <path>
"""

from __future__ import annotations

import argparse
import json
import math
import os
from typing import Optional

DEFAULT_OVERPASS = os.path.join(
    os.path.dirname(__file__), "..", "..", "..", "backend", "tests", "fixtures",
    "bethpage_overpass.json",
)
DEFAULT_OUT = os.path.join(os.path.dirname(__file__), "fixtures", "bethpage-red-mapped.json")

TARGET_COURSE = "Red"
COURSE_ID = "bethpage-red-offline-fixture"
COURSE_NAME = "Bethpage State Park (Red)"
TEE_COLOR = "#c0392b"  # matches OSM's "Red" naming; cosmetic only

_METERS_PER_YARD = 0.9144


# ── geometry helpers (pure, mirrors backend course_spatial.py's approach) ──────

def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _point_to_segment_dist_m(
    plat: float, plng: float, alat: float, alng: float, blat: float, blng: float
) -> float:
    """Approx min distance (meters) from point P to segment A-B using an
    equirectangular projection local to the segment (fine at fairway scale)."""
    # Project to a local planar approximation centered on A.
    lat0 = math.radians(alat)
    kx = 111320.0 * math.cos(lat0)
    ky = 110540.0

    ax, ay = 0.0, 0.0
    bx, by = (blng - alng) * kx, (blat - alat) * ky
    px, py = (plng - alng) * kx, (plat - alat) * ky

    dx, dy = bx - ax, by - ay
    seg_len2 = dx * dx + dy * dy
    if seg_len2 == 0:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / seg_len2
    t = max(0.0, min(1.0, t))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(px - cx, py - cy)


def _dist_to_polyline_m(plat: float, plng: float, points: list[tuple[float, float]]) -> float:
    if len(points) == 1:
        return _haversine_m(plat, plng, points[0][0], points[0][1])
    best = math.inf
    for i in range(len(points) - 1):
        a, b = points[i], points[i + 1]
        d = _point_to_segment_dist_m(plat, plng, a[0], a[1], b[0], b[1])
        best = min(best, d)
    return best


def _ring_centroid(ring: list[list[float]]) -> tuple[float, float]:
    """Arithmetic-mean centroid of a GeoJSON ring [[lng, lat], ...]. Mirrors
    frontend mapped-course-api.ts _polygonCentroid / backend _ring_centroid."""
    verts = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
    sum_lng = sum(v[0] for v in verts)
    sum_lat = sum(v[1] for v in verts)
    n = len(verts)
    return (sum_lat / n, sum_lng / n)  # (lat, lng)


def _parse_way_to_polygon(geom: list[dict]) -> Optional[dict]:
    if len(geom) < 4:
        return None
    ring = [[p["lon"], p["lat"]] for p in geom]
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    return {"type": "Polygon", "coordinates": [ring]}


def _parse_way_to_linestring(geom: list[dict]) -> Optional[dict]:
    if len(geom) < 2:
        return None
    return {"type": "LineString", "coordinates": [[p["lon"], p["lat"]] for p in geom]}


def _centerline_length_yards(points: list[tuple[float, float]]) -> float:
    total_m = sum(
        _haversine_m(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1])
        for i in range(len(points) - 1)
    )
    return total_m / _METERS_PER_YARD


# ── main build ──────────────────────────────────────────────────────────────

def build(overpass_path: str) -> dict:
    with open(overpass_path) as f:
        data = json.load(f)
    elements = data.get("elements", [])

    # 1) Every golf=hole centerline, across ALL courses, keyed by (course, ref).
    #    Needed so the global-nearest assignment can correctly exclude polygons
    #    that belong to a neighbouring course (Black/Blue/Green/Yellow).
    all_holes: list[dict] = []  # {course, ref, points, par, handicap}
    for el in elements:
        if el.get("type") != "way":
            continue
        tags = el.get("tags", {})
        if tags.get("golf") != "hole":
            continue
        ref = tags.get("ref")
        course = tags.get("golf:course:name")
        if not ref or not str(ref).isdigit() or not course:
            continue
        geom = el.get("geometry", [])
        if len(geom) < 2:
            continue
        points = [(p["lat"], p["lon"]) for p in geom]
        par_str = tags.get("par", "")
        hcp_str = tags.get("handicap", "")
        all_holes.append({
            "course": course,
            "ref": int(ref),
            "points": points,
            "par": int(par_str) if par_str.isdigit() else None,
            "handicap": int(hcp_str) if hcp_str.isdigit() else None,
            "geom": geom,
        })

    red_holes = [h for h in all_holes if h["course"] == TARGET_COURSE]
    if not red_holes:
        raise SystemExit(f"No golf:course:name={TARGET_COURSE!r} holes found in {overpass_path}")

    # 2) Every green/fairway/tee/bunker polygon in the whole fixture.
    polygons: list[dict] = []  # {feature_type, polygon, centroid, osm_id, tags}
    for el in elements:
        if el.get("type") != "way":
            continue
        tags = el.get("tags", {})
        golf_tag = tags.get("golf", "")
        if golf_tag not in ("green", "fairway", "tee", "bunker"):
            continue
        geom = el.get("geometry", [])
        polygon = _parse_way_to_polygon(geom)
        if polygon is None:
            continue
        centroid = _ring_centroid(polygon["coordinates"][0])
        polygons.append({
            "feature_type": golf_tag,
            "polygon": polygon,
            "centroid": centroid,  # (lat, lng)
            "osm_id": f"way/{el['id']}",
            "tags": tags,
        })

    # 3) Global-nearest assignment: each polygon -> the hole (any course) whose
    #    centerline is closest to the polygon's centroid.
    assigned_to_red: dict[int, list[dict]] = {h["ref"]: [] for h in red_holes}
    for poly in polygons:
        clat, clng = poly["centroid"]
        best_dist = math.inf
        best_hole: Optional[dict] = None
        for h in all_holes:
            d = _dist_to_polyline_m(clat, clng, h["points"])
            if d < best_dist:
                best_dist = d
                best_hole = h
        if best_hole is not None and best_hole["course"] == TARGET_COURSE:
            assigned_to_red[best_hole["ref"]].append(poly)

    # 4) Build CourseData holes.
    holes_out: list[dict] = []
    all_lats: list[float] = []
    all_lngs: list[float] = []

    for h in sorted(red_holes, key=lambda x: x["ref"]):
        n = h["ref"]
        features: list[dict] = []

        # The centerline itself, as a 'hole' LineString feature (mirrors the
        # backend's stored golf=hole feature; mapped-course-api.ts uses this
        # as the tee/green fallback when polygons are absent).
        centerline_geom = _parse_way_to_linestring(h["geom"])
        if centerline_geom is not None:
            features.append({
                "type": "Feature",
                "properties": {
                    "featureType": "hole",
                    "hole": n,
                    "osm_id": f"centerline/{n}",
                    "ref": str(n),
                    "par": h["par"],
                },
                "geometry": centerline_geom,
            })

        for poly in assigned_to_red[n]:
            features.append({
                "type": "Feature",
                "properties": {
                    "featureType": poly["feature_type"],
                    "hole": n,
                    "osm_id": poly["osm_id"],
                    "teeSet": TARGET_COURSE if poly["feature_type"] == "tee" else None,
                },
                "geometry": poly["polygon"],
            })

        # Yardage: straight-line-along-centerline length in yards (no `dist`
        # tag on the Red holes in this fixture — see README "Known gaps").
        yards = round(_centerline_length_yards(h["points"]))

        # Handicap (stroke index): the Red holes in this fixture carry no
        # `handicap` OSM tag (unlike Black). Fall back to the hole number as a
        # SYNTHETIC placeholder (documented in README) so the required field
        # is populated without fabricating a false stroke-index claim in the
        # app itself — this fixture is offline-sim-only.
        handicap = h["handicap"] if h["handicap"] is not None else n

        holes_out.append({
            "number": n,
            "par": h["par"] if h["par"] is not None else 4,
            "handicap": handicap,
            "yardages": {TARGET_COURSE: yards},
            "features": {"type": "FeatureCollection", "features": features},
        })

        for lat, lng in h["points"]:
            all_lats.append(lat)
            all_lngs.append(lng)

    course_center = {
        "lat": sum(all_lats) / len(all_lats),
        "lng": sum(all_lngs) / len(all_lngs),
    }

    return {
        "id": COURSE_ID,
        "name": COURSE_NAME,
        "location": course_center,
        "address": "99 Quaker Meeting House Rd, Farmingdale, NY 11735",
        "teeSets": [{"name": TARGET_COURSE, "color": TEE_COLOR}],
        "holes": holes_out,
    }


def verify(course: dict) -> None:
    """Sanity-check the built CourseData before it's trusted as a fixture."""
    assert course["id"] and course["name"], "missing id/name"
    assert isinstance(course["location"], dict) and "lat" in course["location"], "missing location"
    assert isinstance(course["teeSets"], list) and len(course["teeSets"]) >= 1, "missing teeSets"
    holes = course["holes"]
    assert len(holes) == 18, f"expected 18 holes, got {len(holes)}"

    numbers = sorted(h["number"] for h in holes)
    assert numbers == list(range(1, 19)), f"hole numbers not 1..18: {numbers}"

    for h in holes:
        feats = h["features"]["features"]
        assert len(feats) >= 1, f"hole {h['number']} has no features"
        greens = [f for f in feats if f["properties"]["featureType"] == "green"]
        assert len(greens) >= 1, f"hole {h['number']} has no green feature"
        assert TARGET_COURSE in h["yardages"], f"hole {h['number']} missing {TARGET_COURSE} yardage"

    print("VERIFY OK:")
    print(f"  holes: {len(holes)} (1..18 present)")
    total_features = sum(len(h["features"]["features"]) for h in holes)
    print(f"  total features across holes: {total_features}")
    by_type: dict[str, int] = {}
    for h in holes:
        for f in h["features"]["features"]:
            ft = f["properties"]["featureType"]
            by_type[ft] = by_type.get(ft, 0) + 1
    print(f"  feature type counts: {by_type}")
    print(f"  every hole has >=1 green: True")
    yardages = [h["yardages"][TARGET_COURSE] for h in holes]
    print(f"  yardages (straight-line centerline, yds): {yardages}")
    print(f"  total (sum of hole centerline yardages): {sum(yardages)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--overpass", default=DEFAULT_OVERPASS, help="path to bethpage_overpass.json")
    parser.add_argument("--out", default=DEFAULT_OUT, help="output CourseData JSON path")
    args = parser.parse_args()

    course = build(args.overpass)
    verify(course)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(course, f, indent=2)
        f.write("\n")
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
