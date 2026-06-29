#!/usr/bin/env python3
"""Headless diagnostic: count OSM features per hole for Bethpage Black.

Usage (from repo root or backend/):
    uv run backend/scripts/diag_bethpage.py

No DB, no docker — live Overpass fetch only.
"""

from __future__ import annotations

import asyncio
import sys

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))

from app.services.osm import fetch_course_geometry
from app.services.course_spatial import build_course_feature_collection

LAT = 40.7445
LNG = -73.4609
RADIUS = 2500
TARGET = "Black"


async def run() -> None:
    print(f"Fetching OSM geometry: center=({LAT}, {LNG})  radius={RADIUS} m ...", flush=True)
    geometry = await fetch_course_geometry(LAT, LNG, RADIUS, course_name=None)

    all_holes = geometry.get("holes", [])
    polygons = (
        geometry.get("greens",   [])
        + geometry.get("fairways", [])
        + geometry.get("tees",     [])
        + geometry.get("bunkers",  [])
        + geometry.get("water",    [])
        + geometry.get("rough",    [])
        + geometry.get("woods",    [])
        + geometry.get("trees",    [])
    )

    print(f"  hole LineStrings: {len(all_holes)}")
    print(f"  greens:   {len(geometry.get('greens', []))}")
    print(f"  fairways: {len(geometry.get('fairways', []))}")
    print(f"  tees:     {len(geometry.get('tees', []))}")
    print(f"  bunkers:  {len(geometry.get('bunkers', []))}")
    print(f"  water:    {len(geometry.get('water', []))}")
    print(f"  rough:    {len(geometry.get('rough', []))}")
    print(f"  woods:    {len(geometry.get('woods', []))}")
    print(f"  trees:    {len(geometry.get('trees', []))}")
    print(f"  total polygons: {len(polygons)}", flush=True)

    print(f"\nRunning spatial join → target: {TARGET!r} ...", flush=True)
    hole_dicts = build_course_feature_collection(all_holes, polygons, TARGET)

    # Print per-hole feature counts
    print(f"\n{'Hole':>4}  {'green':>5}  {'fairway':>7}  {'bunker':>6}  {'water':>5}  {'rough':>5}  {'woods':>5}  {'tee':>3}  {'tree':>4}  {'total':>5}")
    print("  " + "-" * 68)
    grand = 0
    for h in sorted(hole_dicts, key=lambda x: x["number"]):
        num = h["number"]
        feats = (h.get("features") or {}).get("features") or []
        counts: dict[str, int] = {}
        for f in feats:
            ft = (f.get("properties") or {}).get("featureType", "?")
            counts[ft] = counts.get(ft, 0) + 1
        total = len(feats)
        grand += total
        print(
            f"  H{num:<3d}  {counts.get('green', 0):>5}  "
            f"{counts.get('fairway', 0):>7}  {counts.get('bunker', 0):>6}  "
            f"{counts.get('water', 0):>5}  {counts.get('rough', 0):>5}  "
            f"{counts.get('woods', 0):>5}  {counts.get('tee', 0):>3}  "
            f"{counts.get('tree', 0):>4}  {total:>5}"
        )
    print(f"\n  Total features across all Black holes: {grand}")
    print(f"  Holes with features: {len(hole_dicts)}")

    # Sanity-check yardages (tee→green distance)
    print("\n  Hole yardage sanity (requires tee+green both present):")
    from app.services.course_spatial import _ring_centroid, _deg_to_m
    for h in sorted(hole_dicts, key=lambda x: x["number"]):
        num = h["number"]
        feats = (h.get("features") or {}).get("features") or []
        tee_centroid = None
        green_centroid = None
        for f in feats:
            ft = (f.get("properties") or {}).get("featureType", "")
            geom = f.get("geometry") or {}
            if geom.get("type") != "Polygon":
                continue
            rings = geom.get("coordinates") or []
            if not rings or not rings[0]:
                continue
            c = _ring_centroid(rings[0])
            if ft == "tee" and tee_centroid is None:
                tee_centroid = c
            elif ft == "green" and green_centroid is None:
                green_centroid = c
        if tee_centroid and green_centroid:
            dist_m = _deg_to_m(tee_centroid[1], tee_centroid[0], green_centroid[1], green_centroid[0])
            dist_yds = int(round(dist_m * 1.09361))
            sane = "OK" if 50 < dist_yds < 700 else "*** SUSPICIOUS ***"
            print(f"    H{num}: tee→green = {dist_yds} yds  {sane}")
        else:
            missing = []
            if not tee_centroid:
                missing.append("tee")
            if not green_centroid:
                missing.append("green")
            print(f"    H{num}: missing {', '.join(missing)} — can't compute yardage")


if __name__ == "__main__":
    asyncio.run(run())
