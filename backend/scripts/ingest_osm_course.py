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

4. **GolfAPI cache-first** (optional, I5): if ``--golfapi-id`` is given, calls
   ``get_course_golf_data(course_id, golfapi_id, force=...)`` AFTER the DB write
   to populate ``backend/data/golfapi_cache.json``.  By default this is a
   cache-first call (0 GolfAPI API calls if already cached); pass
   ``--refresh-golfapi`` to force a re-fetch even when cached.  The JSON cache
   survives re-ingest — re-running without ``--refresh-golfapi`` never makes a
   new GolfAPI call for a course already in the cache.

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

GolfAPI cache-first (populates backend/data/golfapi_cache.json, reuses cache on re-run)::

    uv run backend/scripts/ingest_osm_course.py \\
        --golfapi-id 12345 --course-key osm-bethpage-black

Force GolfAPI re-fetch even when already cached::

    uv run backend/scripts/ingest_osm_course.py --golfapi-id 12345 --refresh-golfapi
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

# Make the backend package importable when run from the repo root or backend/.
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))

from app.services.osm import fetch_course_geometry  # noqa: E402
from app.services.osm_ingest import (  # noqa: E402
    _deterministic_uuid,
    _should_abort_empty,
    assemble_osm_course,
    embed_elevation_in_green_features,
)
from app.services.elevation import sample_course_elevations  # noqa: E402
from app.services.golfapi_cache import get_course_golf_data  # noqa: E402
from app.services.secrets import load_secrets_into_env  # noqa: E402

# Pull prod secrets (incl. GOLF_API_KEY) from AWS Secrets Manager (looper/prod)
# into the env, same as the API app does at boot. The standalone ingest sources
# backend/.env when run via SSM, but GOLF_API_KEY lives in Secrets Manager, not
# .env — without this the --golfapi-id cache fetch would never see the key.
# No-op locally (no AWS creds) and never overrides an explicit env var.
load_secrets_into_env()

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
    golfapi_id: str,
    refresh_golfapi: bool,
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

    # I4: Sample 3DEP / EPQS elevations for every tee + green on the target course.
    # Uses a single batch HTTP round-trip via fetch_3dep_samples → compute_hole_elevation_profile.
    # PLAYS_LIKE_YARD_PER_FT = 1/3 ≈ 1 yard per 3 ft of elevation change (USGA rule of thumb).
    print(f"Sampling tee + green elevations via USGS 3DEP (target: {target_course_name!r}) …", flush=True)
    hole_elevations = await sample_course_elevations(
        holes=geometry.get("holes", []),
        target_course_name=target_course_name,
    )
    print(
        f"Got elevations for {len(hole_elevations)} hole(s) "
        f"(holes with no USGS coverage are skipped — shows nothing in UI).",
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
        hole_elevations=hole_elevations,
    )

    # Persist elevation in green feature properties so upsert_course stores it in jsonb.
    # The hole["elevation"] key is NOT stored by upsert_course; only feature properties are.
    embed_elevation_in_green_features(course_data)

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

        # ── Per-hole elevation table ──────────────────────────────────────────
        if hole_elevations:
            print("\n  Hole  Tee(ft)  Green(ft)  Delta(ft)  Plays-like(yds)", flush=True)
            print("  " + "-" * 55, flush=True)
            for num in sorted(hole_elevations):
                e = hole_elevations[num]
                sign = "+" if e["net_change_ft"] >= 0 else ""
                pl_sign = "+" if e["plays_like_yards"] >= 0 else ""
                print(
                    f"  H{num:<4d}  {e['tee_elevation_ft']:<8.1f} "
                    f"{e['green_elevation_ft']:<10.1f} "
                    f"{sign}{e['net_change_ft']:<10.1f} "
                    f"{pl_sign}{e['plays_like_yards']:.1f}",
                    flush=True,
                )
            print("", flush=True)
        else:
            print("  (no elevation data — USGS 3DEP returned None for all points)", flush=True)

        # Print the first 2 000 chars of the payload for a quick sanity check.
        payload_str = json.dumps(course_data, indent=2)
        print(payload_str[:2000])
        if len(payload_str) > 2000:
            print("… (truncated)")
        return

    # Guard: refuse to write an empty course to the database.
    # This prevents a transient Overpass failure from silently overwriting a
    # previously-ingested good record with a blank one.
    if _should_abort_empty(n_assembled):
        print(
            f"ERROR: assembled 0 holes for target course {target_course_name!r}.  "
            "The Overpass fetch may have failed or the course-name filter matched "
            "nothing.  NOT writing to DB — re-run once the endpoint is healthy or "
            "verify --lat/--lng/--radius/--target-course.",
            file=sys.stderr,
        )
        sys.exit(1)

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

    # ── GolfAPI cache-first (I5) ─────────────────────────────────────────────────
    # If a golfapi_id is provided, populate the coordinate cache from GolfAPI.
    # Cache-first: if already cached and --refresh-golfapi is not set, this makes
    # ZERO GolfAPI API calls.  The JSON cache in backend/data/golfapi_cache.json
    # survives re-ingest so re-running never wastes quota on a cached course.
    if golfapi_id:
        print(
            f"GolfAPI cache-first: course_id={course_id} golfapi_id={golfapi_id} "
            f"force={refresh_golfapi} …",
            flush=True,
        )
        golf_coords = await get_course_golf_data(
            course_id,
            golfapi_id,
            force=refresh_golfapi,
        )
        if golf_coords:
            print(
                f"GolfAPI coords ready: {len(golf_coords)} hole(s) cached for "
                f"course={course_id}. Serve via GET /api/courses/mapped/{course_id}/golf-coords",
                flush=True,
            )
        else:
            print(
                "GolfAPI coords not available (no token, budget exceeded, or cache hit "
                "returned empty). Serve will fall back to OSM mock on the frontend.",
                flush=True,
            )


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
    parser.add_argument(
        "--golfapi-id", dest="golfapi_id",
        default="",
        help=(
            "GolfAPI numeric course ID (e.g. '12345').  When provided, the ingest "
            "script calls get_course_golf_data() after the DB write to populate "
            "backend/data/golfapi_cache.json.  Cache-first: no GolfAPI call is made "
            "if the course is already cached (see --refresh-golfapi)."
        ),
    )
    parser.add_argument(
        "--refresh-golfapi", dest="refresh_golfapi", action="store_true",
        help=(
            "Force a fresh GolfAPI fetch even when coords are already cached. "
            "Without this flag, re-ingest reuses the cache (0 extra GolfAPI calls)."
        ),
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
        golfapi_id=args.golfapi_id,
        refresh_golfapi=args.refresh_golfapi,
    ))


if __name__ == "__main__":
    main()
