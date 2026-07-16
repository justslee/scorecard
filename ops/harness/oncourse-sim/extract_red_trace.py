#!/usr/bin/env python3
"""extract_red_trace.py — build walking waypoints for Bethpage Red from the
committed Overpass fixture (offline, stdlib only, no network, no auth).

Reads backend/tests/fixtures/bethpage_overpass.json, finds every `golf=hole`
way tagged `golf:course:name=Red` (name "Red 1".."Red 18" — NOT hardcoded,
discovered from the fixture), and for each hole emits a station list walking
the centerline tee -> green, plus a short walk-to-next-tee leg:

  TEE -> FAIRWAY25 -> FAIRWAY50 -> FAIRWAY75 -> APPROACH90 -> GREEN
      -> WALK1 -> WALK2 (toward the next hole's tee, when a next hole exists)

Output: fixtures/red-trace-waypoints.json — a flat list of
  {"hole": int, "station": str, "lat": float, "lng": float}

Usage:
    python3 extract_red_trace.py
    python3 extract_red_trace.py --overpass <path> --out <path>

This script only reads the fixture and writes the waypoints file; it makes no
network calls and requires no auth. Re-run any time the fixture changes.
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
DEFAULT_OUT = os.path.join(os.path.dirname(__file__), "fixtures", "red-trace-waypoints.json")

TARGET_COURSE = "Red"

# Fraction of the way along the hole centerline (by cumulative arc length,
# not vertex index) for each named station.
_STATION_FRACTIONS: list[tuple[str, float]] = [
    ("tee", 0.0),
    ("fairway25", 0.25),
    ("fairway50", 0.50),
    ("fairway75", 0.75),
    ("approach90", 0.90),
    ("green", 1.0),
]

# Fractions of the green->next-tee leg for the "walking to the next tee" stations.
_WALK_FRACTIONS: list[tuple[str, float]] = [
    ("walk1", 0.5),
    ("walk2", 1.0),
]


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in meters (mirrors backend course_spatial._deg_to_m)."""
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _interpolate_along(points: list[tuple[float, float]], fraction: float) -> tuple[float, float]:
    """Return the (lat, lng) at `fraction` (0..1) of cumulative arc length along
    a polyline `points` (list of (lat, lng)). Clamped to [0, 1]."""
    fraction = max(0.0, min(1.0, fraction))
    if len(points) == 1:
        return points[0]

    seg_lens = [
        _haversine_m(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1])
        for i in range(len(points) - 1)
    ]
    total = sum(seg_lens)
    if total == 0:
        return points[0]

    target = fraction * total
    covered = 0.0
    for i, seg_len in enumerate(seg_lens):
        if covered + seg_len >= target or i == len(seg_lens) - 1:
            remaining = target - covered
            t = 0.0 if seg_len == 0 else remaining / seg_len
            t = max(0.0, min(1.0, t))
            lat = points[i][0] + t * (points[i + 1][0] - points[i][0])
            lng = points[i][1] + t * (points[i + 1][1] - points[i][1])
            return (lat, lng)
        covered += seg_len
    return points[-1]


def load_red_holes(overpass_path: str) -> dict[int, list[tuple[float, float]]]:
    """Parse the Overpass fixture -> {hole_number: [(lat, lng), ...centerline]}
    for every `golf=hole` way tagged `golf:course:name == TARGET_COURSE`.

    Does NOT hardcode which/how-many holes exist — reads whatever the fixture
    contains for the target course.
    """
    with open(overpass_path) as f:
        data = json.load(f)

    holes: dict[int, list[tuple[float, float]]] = {}
    for el in data.get("elements", []):
        if el.get("type") != "way":
            continue
        tags = el.get("tags", {})
        if tags.get("golf") != "hole":
            continue
        if tags.get("golf:course:name") != TARGET_COURSE:
            continue
        ref = tags.get("ref")
        if not ref or not str(ref).isdigit():
            continue
        geom = el.get("geometry", [])
        if len(geom) < 2:
            continue
        pts = [(p["lat"], p["lon"]) for p in geom]
        holes[int(ref)] = pts

    return holes


def build_waypoints(holes: dict[int, list[tuple[float, float]]]) -> list[dict]:
    """Build the flat waypoint list for every hole present in `holes`, ordered
    by hole number. Each hole's stations walk its own centerline; the final
    two stations ("walk1"/"walk2") interpolate from this hole's green toward
    the NEXT hole's tee (skipped for the last hole present, honestly)."""
    waypoints: list[dict] = []
    hole_numbers = sorted(holes.keys())

    for idx, n in enumerate(hole_numbers):
        centerline = holes[n]
        for station, frac in _STATION_FRACTIONS:
            lat, lng = _interpolate_along(centerline, frac)
            waypoints.append({"hole": n, "station": station, "lat": lat, "lng": lng})

        # Walk-to-next-tee: interpolate from THIS green to the NEXT hole's tee.
        next_n = hole_numbers[idx + 1] if idx + 1 < len(hole_numbers) else None
        if next_n is not None:
            green = centerline[-1]
            next_tee = holes[next_n][0]
            leg = [green, next_tee]
            for station, frac in _WALK_FRACTIONS:
                lat, lng = _interpolate_along(leg, frac)
                waypoints.append({"hole": n, "station": f"to-next-tee-{station}", "lat": lat, "lng": lng})

    return waypoints


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--overpass", default=DEFAULT_OVERPASS, help="path to bethpage_overpass.json")
    parser.add_argument("--out", default=DEFAULT_OUT, help="output waypoints JSON path")
    args = parser.parse_args()

    holes = load_red_holes(args.overpass)
    if not holes:
        raise SystemExit(f"No golf:course:name={TARGET_COURSE!r} golf=hole ways found in {args.overpass}")

    waypoints = build_waypoints(holes)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(waypoints, f, indent=2)
        f.write("\n")

    print(f"Read {len(holes)} Red holes: {sorted(holes.keys())}")
    print(f"Wrote {len(waypoints)} waypoints -> {args.out}")


if __name__ == "__main__":
    main()
