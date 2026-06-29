#!/usr/bin/env python3
"""Ingest an OSM golf course into the PostGIS mapped-course store (I2 Bethpage Black POC).

Pipeline
--------
1. ``fetch_course_geometry(lat, lng, radius, course_name=None)``   [I0 — Overpass]
   Fetches ALL courses' hole LineStrings + unlabeled polygon features.
   ``course_name=None`` is critical so the spatial join (I1) has every hole
   for cross-course rejection.

2. ``assemble_osm_course(geometry, …, target_course_name="Black")`` [I1+I2 assembly]
   Runs the spatial join to assign each polygon to its nearest Black hole
   (cross-course rejection rejects polygons physically closer to Red/Blue/…).
   Merges par / handicap from the OSM hole tags.

3. ``upsert_course(course_data)``                                    [I2 — DB write]
   Writes the assembled course into the ``courses / tee_sets / holes /
   hole_yardages / hole_features`` tables via PostGIS (requires ASYNC_DATABASE_URL).

Course identity
---------------
Stored under ``_deterministic_uuid("osm-bethpage-black")`` — a UUID v5-style hash
of ``"golfapi:osm-bethpage-black"`` using the same SHA-1 algorithm as the frontend's
``deterministicUUID()`` in ``golf-api.ts``.  If the GolfAPI course ID for Bethpage
Black is later discovered (say ``12345``), re-run with
``--course-key golfapi-12345`` to land on the same row UUID the frontend import
stores — no migration needed.

What is NOT done here
---------------------
- **Yardages (I3):** come from the physical scorecard; hole_yardages stays empty.
  Merge via a second ``upsert_course`` call once card data is available.
- **Elevation (I4):** 3DEP AOI GeoTIFF sampling (separate script / track).

Usage
-----
Dry-run (Overpass fetch + assembly + JSON preview; no DB write)::

    uv run backend/scripts/ingest_osm_course.py --dry-run

Write to DB (requires ASYNC_DATABASE_URL env var)::

    uv run backend/scripts/ingest_osm_course.py

Custom centre / target course::

    uv run backend/scripts/ingest_osm_course.py \\
        --lat 40.7445 --lng -73.4609 --radius 2500 \\
        --target-course Black --course-key osm-bethpage-black \\
        --course-name "Bethpage Black"
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

# Make the backend package importable when run from the repo root or backend/.
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))

from app.services.osm import fetch_course_geometry  # noqa: E402
from app.services.osm_ingest import _deterministic_uuid, assemble_osm_course  # noqa: E402

# ── Bethpage Black defaults ────────────────────────────────────────────────────

_DEFAULT_LAT: float = 40.7445
_DEFAULT_LNG: float = -73.4609
_DEFAULT_RADIUS: int = 2500
_DEFAULT_TARGET_COURSE: str = "Black"
_DEFAULT_COURSE_KEY: str = "osm-bethpage-black"
_DEFAULT_COURSE_NAME: str = "Bethpage Black"
_DEFAULT_ADDRESS: str = "99 Quaker Meeting House Rd, Farmingdale, NY 11735"


async def _ingest(
    *,
    lat: float,
    lng: float,
    radius: int,
    target_course_name: str,
    course_key: str,
    course_name: str,
    address: str | None,
    dry_run: bool,
) -> None:
    course_id = _deterministic_uuid(course_key)
    location = {"lat": lat, "lng": lng}

    print(
        f"Fetching OSM geometry: center=({lat}, {lng})  radius={radius} m …",
        flush=True,
    )
    # Fetch ALL courses' holes (no course_name filter) so the spatial join can
    # reject polygons that are physically closest to a non-Black hole.
    geometry = await fetch_course_geometry(lat, lng, radius, course_name=None)

    n_holes = len(geometry.get("holes", []))
    n_polys = sum(
        len(geometry.get(k, []))
        for k in ("greens", "fairways", "tees", "bunkers", "water")
    )
    print(f"Fetched {n_holes} hole LineStrings, {n_polys} polygon features.", flush=True)

    if n_holes == 0:
        print(
            "WARNING: no hole features returned.  Check lat/lng/radius or Overpass availability.",
            flush=True,
        )

    print(f"Running spatial join → target course: {target_course_name!r} …", flush=True)
    course_data = assemble_osm_course(
        geometry=geometry,
        course_id=course_id,
        course_name=course_name,
        target_course_name=target_course_name,
        address=address,
        location=location,
    )

    n_assembled = len(course_data.get("holes", []))
    n_features  = sum(
        len((h.get("features") or {}).get("features") or [])
        for h in course_data.get("holes", [])
    )
    print(
        f"Assembled {n_assembled} holes with {n_features} polygon features total.",
        flush=True,
    )
    print(f"Course UUID: {course_id}", flush=True)

    if dry_run:
        print(
            "\n─── DRY RUN (--dry-run): payload preview — NOT writing to DB ───\n",
            flush=True,
        )
        if course_data["holes"]:
            sample = course_data["holes"][0]
            n_feats = len((sample.get("features") or {}).get("features") or [])
            print(
                f"  Hole 1: par={sample['par']}  handicap={sample['handicap']}  "
                f"polygon features={n_feats}",
                flush=True,
            )
        # Print the first 2 000 chars of the payload for a quick sanity check.
        payload_str = json.dumps(course_data, indent=2)
        print(payload_str[:2000])
        if len(payload_str) > 2000:
            print("… (truncated)")
        return

    # Late import keeps DB engine initialisation out of dry-run paths.
    from app.services.courses_mapped import upsert_course  # noqa: PLC0415

    print("Writing to DB via upsert_course …", flush=True)
    result = await upsert_course(course_data)
    if result:
        print(
            f"Done.  Course '{result['name']}' stored under id={result['id']}.",
            flush=True,
        )
    else:
        print("upsert_course returned None — check ASYNC_DATABASE_URL.", file=sys.stderr)
        sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--lat",    type=float, default=_DEFAULT_LAT,
        help=f"Centre latitude  (default: {_DEFAULT_LAT})",
    )
    parser.add_argument(
        "--lng",    type=float, default=_DEFAULT_LNG,
        help=f"Centre longitude (default: {_DEFAULT_LNG})",
    )
    parser.add_argument(
        "--radius", type=int,   default=_DEFAULT_RADIUS,
        help=f"Search radius in metres (default {_DEFAULT_RADIUS})",
    )
    parser.add_argument(
        "--target-course", dest="target_course",
        default=_DEFAULT_TARGET_COURSE,
        help=f"OSM golf:course:name to select (default '{_DEFAULT_TARGET_COURSE}')",
    )
    parser.add_argument(
        "--course-key", dest="course_key",
        default=_DEFAULT_COURSE_KEY,
        help=(
            f"Stable key for deterministic UUID (default '{_DEFAULT_COURSE_KEY}'). "
            "Pass 'golfapi-<id>' once the GolfAPI course ID is known."
        ),
    )
    parser.add_argument(
        "--course-name", dest="course_name",
        default=_DEFAULT_COURSE_NAME,
        help=f"Human-readable course name (default '{_DEFAULT_COURSE_NAME}')",
    )
    parser.add_argument(
        "--address", default=_DEFAULT_ADDRESS,
        help="Course address string",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print the assembled payload without writing to DB",
    )

    args = parser.parse_args()
    asyncio.run(_ingest(
        lat=args.lat,
        lng=args.lng,
        radius=args.radius,
        target_course_name=args.target_course,
        course_key=args.course_key,
        course_name=args.course_name,
        address=args.address,
        dry_run=args.dry_run,
    ))


if __name__ == "__main__":
    main()
