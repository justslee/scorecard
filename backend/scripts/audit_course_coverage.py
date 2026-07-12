#!/usr/bin/env python3
"""Audit per-hole OSM geometry coverage for a golf course (read-only, no DB).

Answers, for one target sub-course at a shared facility, the exact question the
tee-shot yardage overlays care about: **does each hole have what it needs to
draw?** The v1.1.5 overlays (blue/white/red 200/150/100 plates + bunker carries)
and the hole centerline polyline draw ONLY from real geometry in
``CourseData.holes[i].features`` — a ``featureType:"hole"`` LineString (the
centerline -> plates + hole line) plus ``featureType:"bunker"`` Polygons (carries).
A hole with no upstream geometry is correctly overlay-less (honest absence).

This is the generalised sibling of ``diag_bethpage.py`` (which is hard-wired to
Bethpage Black and reports polygon counts only). It adds:
  * an arbitrary ``--target`` sub-course (Overpass ``golf:course:name`` tag),
  * explicit **centerline presence** per hole (the golf=hole LineString), which
    ``build_course_feature_collection`` does NOT surface (the centerline is only
    attached later, in ``assemble_osm_course``), and
  * an **overlay-ready** verdict per hole.

Pipeline (mirrors the ingest audit path -- no DB, no secrets, no GolfAPI):
  ``fetch_course_geometry`` (Overpass) -> ``build_course_feature_collection``
  (spatial join with cross-course rejection) -> per-hole coverage table.

It reflects what the ingest script *would write*, so it doubles as a
pre-backfill check ("does OSM have Red's geometry?") and a post-backfill
verification target ("did Red gain centerlines where OSM had them?").

Usage (from repo root or backend/):
    uv run backend/scripts/audit_course_coverage.py --target Red
    uv run backend/scripts/audit_course_coverage.py --target Black
    uv run backend/scripts/audit_course_coverage.py \\
        --lat 40.7445 --lng -73.4609 --radius 2500 --target Red
"""

from __future__ import annotations

import argparse
import asyncio
import sys

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))

from app.services.osm import fetch_course_geometry
from app.services.course_spatial import build_course_feature_collection

# Bethpage neighbourhood defaults (all six courses share one Overpass fetch;
# --target selects one via its golf:course:name tag).
_DEFAULT_LAT = 40.7445
_DEFAULT_LNG = -73.4609
_DEFAULT_RADIUS = 2500


async def audit(lat: float, lng: float, radius: int, target: str) -> int:
    """Print the per-hole coverage table. Returns the count of overlay-ready holes."""
    print(
        f"Fetching OSM geometry: center=({lat}, {lng})  radius={radius} m ...",
        flush=True,
    )
    geometry = await fetch_course_geometry(lat, lng, radius, course_name=None)
    all_holes = geometry.get("holes", [])

    # Raw centerline presence: golf=hole LineStrings tagged with this course +
    # a ref. This is what becomes the hole line + drives the distance plates.
    target_lower = target.lower()
    centerline_pts: dict[str, int] = {}
    for h in all_holes:
        props = h.get("properties") or {}
        if (props.get("course_name") or "").lower() == target_lower:
            ref = props.get("ref")
            geom = h.get("geometry") or {}
            if ref is not None and geom.get("type") == "LineString":
                centerline_pts[str(ref)] = len(geom.get("coordinates") or [])

    polygons = (
        geometry.get("greens", []) + geometry.get("fairways", [])
        + geometry.get("tees", []) + geometry.get("bunkers", [])
        + geometry.get("water", []) + geometry.get("rough", [])
        + geometry.get("woods", []) + geometry.get("trees", [])
    )
    # Spatial join: assigns each polygon to its nearest hole across ALL courses,
    # then keeps only those belonging to `target` (cross-course rejection). A
    # hole only survives here if it received >=1 polygon feature.
    hole_dicts = build_course_feature_collection(all_holes, polygons, target)
    assembled = {h["number"]: h for h in hole_dicts}

    print(f"\n===== TARGET COURSE: {target!r} =====", flush=True)
    print(f"raw golf=hole LineStrings tagged {target!r} with ref: {len(centerline_pts)}")
    print(f"holes surviving spatial join (>=1 polygon):          {len(hole_dicts)}")
    print(
        f"\n{'Hole':>4} {'centerline':>10} {'green':>5} {'fairway':>7} "
        f"{'bunker':>6} {'tee':>3} {'survives':>8} {'overlay?':>8}"
    )
    print("  " + "-" * 66)

    all_refs = sorted(
        set(list(centerline_pts) + [str(n) for n in assembled]),
        key=lambda r: int(r) if r.isdigit() else 999,
    )
    n_overlay_ready = 0
    for ref in all_refs:
        num = int(ref) if ref.isdigit() else -1
        hole = assembled.get(num)
        counts: dict[str, int] = {}
        if hole:
            for f in (hole.get("features") or {}).get("features") or []:
                ft = (f.get("properties") or {}).get("featureType", "?")
                counts[ft] = counts.get(ft, 0) + 1
        has_centerline = ref in centerline_pts
        survives = hole is not None
        # Overlay-ready = the hole survives assembly (gets a hole dict) AND a
        # centerline LineString exists (appended to that dict in the ingest's
        # assemble step). Plates need the centerline; bunker carries are a bonus
        # when polygons exist. No centerline -> no plates, no hole line.
        overlay_ready = survives and has_centerline
        if overlay_ready:
            n_overlay_ready += 1
        cl_str = f"{centerline_pts[ref]}pt" if has_centerline else "-"
        print(
            f"  H{ref:<3} {cl_str:>10} {counts.get('green', 0):>5} "
            f"{counts.get('fairway', 0):>7} {counts.get('bunker', 0):>6} "
            f"{counts.get('tee', 0):>3} {str(survives):>8} "
            f"{('YES' if overlay_ready else 'no'):>8}"
        )

    print(
        f"\n  Overlay-ready holes (centerline present): "
        f"{n_overlay_ready}/{len(all_refs)}",
        flush=True,
    )
    return n_overlay_ready


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--lat", type=float, default=_DEFAULT_LAT,
                        help=f"Centre latitude (default {_DEFAULT_LAT})")
    parser.add_argument("--lng", type=float, default=_DEFAULT_LNG,
                        help=f"Centre longitude (default {_DEFAULT_LNG})")
    parser.add_argument("--radius", type=int, default=_DEFAULT_RADIUS,
                        help=f"Search radius in metres (default {_DEFAULT_RADIUS})")
    parser.add_argument("--target", default="Black",
                        help="OSM golf:course:name to audit (default 'Black')")
    args = parser.parse_args()
    asyncio.run(audit(args.lat, args.lng, args.radius, args.target))


if __name__ == "__main__":
    main()
