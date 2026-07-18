#!/usr/bin/env python3
"""Survey ALL Bethpage Red bunker/sand features: size, assigned hole, distance.
Flags large complexes and anything near hole 9. Live Overpass, no DB.
"""
from __future__ import annotations
import asyncio
import math
import sys
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))
from app.services.osm import fetch_course_geometry
from app.services import course_spatial as cs

LAT, LNG, RADIUS, TARGET = 40.7445, -73.4609, 2500, "Red"


def ring_diag(ring):
    b = cs._ring_bbox(ring)
    cl = (b[1] + b[3]) / 2
    w = (b[2] - b[0]) * cs._LAT_M_PER_DEG * math.cos(math.radians(cl))
    h = (b[3] - b[1]) * cs._LAT_M_PER_DEG
    return math.hypot(w, h)


async def run():
    geom = await fetch_course_geometry(LAT, LNG, RADIUS, course_name=None)
    holes = geom.get("holes", [])
    bunkers = geom.get("bunkers", [])
    red_holes = {(h.get("properties") or {}).get("ref"): h
                 for h in holes if ((h.get("properties") or {}).get("course_name") or "").lower() == TARGET.lower()}

    # Distance from a lon/lat to each red hole centerline (nearest mode)
    def dist_to(ref, lon, lat):
        h = red_holes.get(ref)
        if not h:
            return float("inf")
        hc = (h.get("geometry") or {}).get("coordinates") or []
        return cs._linestring_dist_m(lon, lat, hc, "nearest")

    assign = cs.assign_features_to_holes(holes, bunkers)

    print(f"{'osm_id':>22} | {'diag_m':>7} | {'assigned':>8} | {'d(assg)':>8} | {'d(h9)':>7} | {'d(h11)':>7}")
    print("-" * 80)
    rows = []
    for b in bunkers:
        p = b.get("properties") or {}
        oid = p.get("osm_id", "")
        g = b.get("geometry") or {}
        gt = g.get("type")
        coords = g.get("coordinates") or []
        if gt == "Polygon":
            ring = coords[0] if coords else None
        elif gt == "MultiPolygon":
            best, ba = None, -1
            for m in coords:
                if m and m[0] and len(m[0]) >= 4:
                    a = cs._ring_area(m[0])
                    if a > ba:
                        ba, best = a, m[0]
            ring = best
        else:
            ring = None
        if not ring:
            continue
        diag = ring_diag(ring)
        clon, clat = cs._ring_centroid(ring)
        ref, course, dist = assign.get(oid, (None, None, float("inf")))
        d9, d11 = dist_to("9", clon, clat), dist_to("11", clon, clat)
        rows.append((oid, diag, ref, course, dist, d9, d11, clon, clat, gt))

    # Sort by size desc, show largest 15 + any assigned to 9 or 11 or near 9
    rows.sort(key=lambda r: -r[1])
    seen = set()
    print("== Largest 15 bunker/sand features (Red target course only shown where course==Red) ==")
    for r in rows[:15]:
        oid, diag, ref, course, dist, d9, d11, clon, clat, gt = r
        tag = f"[{course}]" if course else "[none]"
        print(f"{oid:>22} | {diag:>7.0f} | {str(ref):>8} | {dist:>8.1f} | {d9:>7.0f} | {d11:>7.0f}  {tag} {gt}")
        seen.add(oid)

    print("\n== All features assigned to Red hole 9 OR hole 11, or within 120m of hole 9 ==")
    for r in rows:
        oid, diag, ref, course, dist, d9, d11, clon, clat, gt = r
        red = (course or "").lower() == "red"
        if red and (ref in ("9", "11")) or (d9 <= 120):
            print(f"{oid:>22} | {diag:>7.0f} | {str(ref):>8} | {dist:>8.1f} | {d9:>7.0f} | {d11:>7.0f}  [{course}] {gt}")


if __name__ == "__main__":
    asyncio.run(run())
