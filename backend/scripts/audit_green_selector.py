#!/usr/bin/env python3
"""All-courses green-anchor-selector audit
(specs/caddie-green-anchor-nearest-centerline-end-plan.md §3). READ-ONLY:
only `courses_mapped.list_courses()`/`get_course(id)` (pure SELECTs) plus
pure in-process geometry calls. NEVER calls `build_hole_intelligence` (it has
an elevation write-back, `course_intel.py:169-181`) — modeled EXACTLY on
`scripts/audit_tee_selector.py`'s own read-only contract. No weather/USGS/LLM
calls. Key-free (never prints DATABASE_URL or any other env var).

For every hole with more than one stored `featureType == "green"` feature,
reports the OLD (first-by-file-order) vs NEW
(`hazards._select_green_nearest_path_end`, the fix) green pick, each pick's
offset from the hole polyline's own last vertex, the OLD vs NEW no-arg
tee->green yardage (`_derive_tee_green`-derived tee, no args — mirrors the
live no-arg call sites: course_guides / course_intel_writer / this script),
the delta, whether the no-arg tee pick MOVED (the D3 regression surface a
changed green re-ranks "farthest tee from green"), and a FLAG when the NEW
selected green still sits > `hazards._GREEN_ANCHOR_WARN_YARDS` off the path
end (the same threshold that fires the module's own key-free warning).

Two modes:
  --course-id ID     Prod DB mode (pure SELECTs via courses_mapped). Requires
                      DATABASE_URL and owner-sanctioned prod access (plan §3.1
                      GATE) — do NOT run this against prod without that
                      sanction.
  --fixture [PATH]    Offline mode (plan §3.2, no DB needed): runs the SAME
                      old-vs-new comparison over the committed
                      `bethpage_overpass.json` (or an alternate Overpass JSON
                      fixture at PATH) via `_parse_course_geometry_response`
                      + `assemble_osm_course` — all 5 Bethpage courses (90
                      holes), reproducing specs section 0's table with no DB.

Usage (from backend/):
    uv run python scripts/audit_green_selector.py --fixture
    uv run python scripts/audit_green_selector.py --course-id ID   # prod, gated

No DB write, no network beyond the (optional) DB read.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.caddie import hazards as hazards_mod  # noqa: E402

_DEFAULT_FIXTURE_PATH = (
    Path(__file__).parent.parent / "tests" / "fixtures" / "bethpage_overpass.json"
)

_BETHPAGE_COURSES = ["Black", "Blue", "Green", "Yellow", "Red"]


# ── Shared old-vs-new comparison (feature-list in, one report row out) ──────


def _green_features(feature_list: list[dict]) -> list[dict]:
    return [f for f in feature_list if (f.get("properties") or {}).get("featureType") == "green"]


def _tee_and_green_candidates(
    feature_list: list[dict],
) -> tuple[list[tuple[float, float]], list[tuple[float, float]]]:
    tee_pts: list[tuple[float, float]] = []
    green_pts: list[tuple[float, float]] = []
    for f in feature_list:
        props = f.get("properties") or {}
        ftype = props.get("featureType")
        if ftype == "tee":
            pt = hazards_mod._feature_point(f)
            if pt is not None:
                tee_pts.append(pt)
        elif ftype == "green":
            pt = hazards_mod._feature_point(f)
            if pt is not None:
                green_pts.append(pt)
    return tee_pts, green_pts


def _select_tee_no_arg(
    tee_pts: list[tuple[float, float]], green_pt: Optional[tuple[float, float]]
) -> Optional[tuple[float, float]]:
    """Mirrors `hazards._derive_tee_green`'s no-arg tee-selection block
    EXACTLY (unchanged by this fix — D3's point is that only the `green_pt`
    fed into it changes): single stored tee -> that tee; multiple stored
    tees + a known green -> the tee FARTHEST from the green (the back tee);
    multiple tees, no green -> the first stored tee (order-independent tie)."""
    if len(tee_pts) == 1:
        return tee_pts[0]
    if len(tee_pts) > 1:
        if green_pt is not None:
            base_lat = green_pt[1]
            return max(
                tee_pts, key=lambda pt: hazards_mod._point_dist_sq_m(base_lat, green_pt, pt)
            )
        return tee_pts[0]
    return None


def _yards(a: Optional[tuple[float, float]], b: Optional[tuple[float, float]]) -> Optional[float]:
    if a is None or b is None:
        return None
    gx, gy = hazards_mod._xy_m(a[1], a[0], b[1], b[0])
    return math.hypot(gx, gy) * hazards_mod._YARDS_PER_METER


def _offset_yards(
    path: Optional[list[tuple[float, float]]], pt: Optional[tuple[float, float]]
) -> Optional[float]:
    if not path or pt is None:
        return None
    anchor = path[-1]
    return math.sqrt(hazards_mod._point_dist_sq_m(anchor[1], anchor, pt)) * hazards_mod._YARDS_PER_METER


def _audit_hole(course_name: str, hole_number: int, par: object, feature_list: list[dict]) -> Optional[dict]:
    """Returns a report row dict for one hole, or None when the hole has
    <=1 stored green feature (nothing to audit — OLD and NEW are
    structurally identical there, per the plan's zero-regression argument)."""
    greens = _green_features(feature_list)
    n_greens = len(greens)
    if n_greens <= 1:
        return None

    path = hazards_mod._hole_polyline(feature_list)
    tee_pts, green_pts = _tee_and_green_candidates(feature_list)

    old_green_pt = green_pts[0] if green_pts else None
    new_green_pt = hazards_mod._select_green_nearest_path_end(green_pts, path)

    old_end_offset = _offset_yards(path, old_green_pt)
    new_end_offset = _offset_yards(path, new_green_pt)

    old_tee_pt = _select_tee_no_arg(tee_pts, old_green_pt)
    new_tee_pt = _select_tee_no_arg(tee_pts, new_green_pt)

    old_tee_green_yards = _yards(old_tee_pt, old_green_pt)
    new_tee_green_yards = _yards(new_tee_pt, new_green_pt)

    delta = (
        None
        if old_tee_green_yards is None or new_tee_green_yards is None
        else new_tee_green_yards - old_tee_green_yards
    )

    tee_pick_moved = old_tee_pt is not None and new_tee_pt is not None and old_tee_pt != new_tee_pt

    flagged = new_end_offset is not None and new_end_offset > hazards_mod._GREEN_ANCHOR_WARN_YARDS

    return {
        "course": course_name,
        "hole": hole_number,
        "par": par,
        "n_greens": n_greens,
        "old_end": old_end_offset,
        "new_end": new_end_offset,
        "old_tee_green": old_tee_green_yards,
        "new_tee_green": new_tee_green_yards,
        "delta": delta,
        "tee_pick_moved": tee_pick_moved,
        "flag": flagged,
    }


def _fmt(v: Optional[float]) -> str:
    return "n/a" if v is None else f"{v:.1f}"


def _print_table(rows: list[dict], total_holes: int) -> None:
    print(
        "| course | hole | par | n_greens | old→end y | new→end y | "
        "old tee→green y | new tee→green y | Δy | tee pick moved | FLAG |"
    )
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    for r in rows:
        print(
            f"| {r['course']} | {r['hole']} | {r['par']} | {r['n_greens']} | "
            f"{_fmt(r['old_end'])} | {_fmt(r['new_end'])} | "
            f"{_fmt(r['old_tee_green'])} | {_fmt(r['new_tee_green'])} | "
            f"{_fmt(r['delta'])} | {'YES' if r['tee_pick_moved'] else 'no'} | "
            f"{'FLAG' if r['flag'] else ''} |"
        )
    n_multi = len(rows)
    n_flags = sum(1 for r in rows if r["flag"])
    n_moved = sum(1 for r in rows if r["tee_pick_moved"])
    deltas = [abs(r["delta"]) for r in rows if r["delta"] is not None]
    max_delta = f"{max(deltas):.1f}y" if deltas else "n/a"
    print(
        f"\n**Totals:** {total_holes} holes audited, {n_multi} multi-green holes, "
        f"{n_moved} no-arg tee picks moved, {n_flags} flagged (>{hazards_mod._GREEN_ANCHOR_WARN_YARDS:.0f}y "
        f"off the path end), max |Δy| = {max_delta}."
    )


# ── Offline fixture mode (plan §3.2 — no DB) ────────────────────────────────


def run_fixture(fixture_path: Path) -> None:
    from app.services.osm import _parse_course_geometry_response
    from app.services.osm_ingest import _deterministic_uuid, assemble_osm_course

    print(f"# Green-selector audit — OFFLINE fixture mode ({fixture_path.name})\n")

    raw = json.loads(fixture_path.read_text())
    geometry = _parse_course_geometry_response(raw, course_name_filter=None)

    rows: list[dict] = []
    total_holes = 0
    for course_name in _BETHPAGE_COURSES:
        course_id = _deterministic_uuid(f"osm-bethpage-{course_name.lower()}")
        assembled = assemble_osm_course(
            geometry=geometry,
            course_id=course_id,
            course_name=f"Bethpage {course_name}",
            target_course_name=course_name,
            address="99 Quaker Meeting House Rd, Farmingdale, NY 11735",
            location={"lat": 40.7445, "lng": -73.4609},
        )
        for hole in sorted(assembled["holes"], key=lambda h: h["number"]):
            total_holes += 1
            feature_list = hole["features"]["features"]
            row = _audit_hole(f"Bethpage {course_name}", hole["number"], hole.get("par"), feature_list)
            if row is not None:
                rows.append(row)

    _print_table(rows, total_holes)


# ── Prod DB mode (plan §3.1 — GATED, pure SELECTs only) ─────────────────────


async def run_prod(course_id_filter: Optional[str]) -> None:
    from app.services import courses_mapped

    print("# Green-selector audit — prod DB (SELECT-only)\n")

    courses = await courses_mapped.list_courses()
    if course_id_filter:
        courses = [c for c in courses if c["id"] == course_id_filter]

    rows: list[dict] = []
    total_holes = 0
    for course in courses:
        full = await courses_mapped.get_course(course["id"])
        if not full:
            continue
        course_name = full["name"]
        for hole in sorted(full["holes"], key=lambda h: h["number"]):
            total_holes += 1
            feature_list = (hole.get("features") or {}).get("features") or []
            row = _audit_hole(course_name, hole["number"], hole.get("par"), feature_list)
            if row is not None:
                rows.append(row)

    _print_table(rows, total_holes)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--fixture",
        nargs="?",
        const=str(_DEFAULT_FIXTURE_PATH),
        default=None,
        help="Offline mode: audit the committed Overpass fixture (or PATH, if given). No DB.",
    )
    parser.add_argument("--course-id", default=None, help="Prod DB mode: limit to one course id.")
    args = parser.parse_args()

    if args.fixture:
        run_fixture(Path(args.fixture))
    else:
        asyncio.run(run_prod(args.course_id))


if __name__ == "__main__":
    main()
