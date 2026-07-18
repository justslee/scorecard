#!/usr/bin/env python3
"""Diagnostic: why did OSM relation 19545022 (Red-9 waste complex) get assigned
to hole 11 instead of hole 9?  Live Overpass fetch, no DB.

Usage:  uv run backend/scripts/diag_red9_waste.py
"""
from __future__ import annotations

import asyncio
import math
import sys

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))

from app.services.osm import fetch_course_geometry
from app.services import course_spatial as cs

LAT = 40.7445
LNG = -73.4609
RADIUS = 2500
TARGET = "Red"
REL_ID = "relation/19545022"


async def run() -> None:
    print(f"Fetching OSM geometry center=({LAT},{LNG}) r={RADIUS} ...", flush=True)
    geom = await fetch_course_geometry(LAT, LNG, RADIUS, course_name=None)
    holes = geom.get("holes", [])
    bunkers = geom.get("bunkers", [])

    rel = None
    for b in bunkers:
        if (b.get("properties") or {}).get("osm_id") == REL_ID:
            rel = b
            break
    if rel is None:
        print(f"!! {REL_ID} NOT in bunkers. bunker osm_ids sample:")
        for b in bunkers[:40]:
            print("   ", (b.get("properties") or {}).get("osm_id"))
        return

    g = rel["geometry"]
    print(f"\nFound {REL_ID}: geom.type={g['type']}")
    members = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    print(f"  members: {len(members)}")

    member_rings = []
    for i, m in enumerate(members):
        if not m or not m[0] or len(m[0]) < 4:
            continue
        ring = m[0]
        area = cs._ring_area(ring)
        clon, clat = cs._ring_centroid(ring)
        member_rings.append((i, ring, area, clon, clat))
    member_rings.sort(key=lambda x: -x[2])
    print(f"  usable member rings: {len(member_rings)} (sorted by area desc)")
    for idx, ring, area, clon, clat in member_rings:
        bbox = cs._ring_bbox(ring)
        diag = math.hypot(
            (bbox[3] - bbox[1]) * cs._LAT_M_PER_DEG,
            (bbox[2] - bbox[0]) * cs._LAT_M_PER_DEG * math.cos(math.radians(clat)),
        )
        print(f"    member#{idx}: area={area:.3e} deg^2  centroid=({clon:.5f},{clat:.5f})  bbox-diag={diag:.0f}m")

    largest_ring = member_rings[0][1]
    lclon, lclat = member_rings[0][3], member_rings[0][4]
    cos_lat = math.cos(math.radians(lclat))

    red_holes = {}
    for h in holes:
        hp = h.get("properties") or {}
        if (hp.get("course_name") or "").lower() == TARGET.lower():
            red_holes[hp.get("ref")] = h

    print(f"\nRed holes found: {sorted(red_holes.keys(), key=lambda r: int(r) if r and r.isdigit() else 99)}")

    def overlap_all_members(hole_coords):
        tot = 0.0
        for _, ring, _, _, clat_m in member_rings:
            bbox = cs._ring_bbox(ring)
            tot += cs._linestring_intersection_m(
                hole_coords, ring, math.cos(math.radians(clat_m)), bbox
            )
        return tot

    print(f"\n{'hole':>4} | {'ovlap(LARGEST)[current]':>24} | {'ovlap(ALL members)':>20} | {'centroid->line':>16}")
    print("-" * 78)
    largest_bbox = cs._ring_bbox(largest_ring)
    scored = []
    for ref in sorted(red_holes.keys(), key=lambda r: int(r) if r and r.isdigit() else 99):
        h = red_holes[ref]
        hc = (h.get("geometry") or {}).get("coordinates") or []
        ov_largest = cs._linestring_intersection_m(hc, largest_ring, cos_lat, largest_bbox)
        ov_all = overlap_all_members(hc)
        dist = cs._linestring_dist_m(lclon, lclat, hc, "nearest")
        scored.append((ref, ov_largest, ov_all, dist))
        print(f"{ref:>4} | {ov_largest:>24.1f} | {ov_all:>20.1f} | {dist:>14.1f}m")

    cur_winner = max(scored, key=lambda x: x[1])
    all_winner = max(scored, key=lambda x: x[2])
    print(f"\n>> CURRENT (largest-member overlap) winner: hole {cur_winner[0]}  (overlap {cur_winner[1]:.1f}m)")
    print(f">> ALL-MEMBER overlap winner:               hole {all_winner[0]}  (overlap {all_winner[2]:.1f}m)")

    assign = cs.assign_features_to_holes(holes, [rel])
    print(f"\n>> assign_features_to_holes({REL_ID}) => {assign.get(REL_ID)}")

    coll = cs.build_course_feature_collection(holes, bunkers, TARGET)
    for hd in coll:
        for f in hd["features"]:
            if (f.get("properties") or {}).get("osm_id") == REL_ID:
                print(f">> In final collection: {REL_ID} landed on hole {hd['number']}")


if __name__ == "__main__":
    asyncio.run(run())
