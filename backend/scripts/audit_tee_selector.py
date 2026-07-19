#!/usr/bin/env python3
"""All-courses tee-club-selector audit (specs/caddie-yardage-selector-p0-plan.md
§3). READ-ONLY: only `courses_mapped.list_courses()`/`get_course(id)` (pure
SELECTs) plus pure in-process engine calls. NEVER calls
`build_hole_intelligence` (it has an elevation write-back,
`course_intel.py:169-181`) — `HoleIntelligence` is constructed directly from
each stored green feature's persisted properties. No weather/USGS/LLM calls
(`weather=None`, `shot_bearing=0.0` for determinism).

For every par-4/par-5 hole on every mapped course, runs `generate_recommendation`
THREE times per bag to attribute WHICH mechanism (if any) capped the club:
  (C) uncapped baseline — bend=None, corridor=None
  (B) bend-cap only     — corridor=None
  (A) full              — as assembled from stored geometry
`pick(C) != pick(B)` -> the v1 bend-cap fired. `pick(B) != pick(A)` -> the
corridor expected-strokes selector fired. Neither -> no cap on this hole/bag.

FLAG = the final (A) pick is an iron/wedge (4iron or shorter) off a par-4/5
tee — the sub-hybrid-class pick the owner's field report described.

Usage (from backend/):
    uv run python scripts/audit_tee_selector.py [--bag owner|default|both]
        [--course-id ID] [--handicap N]

No DB write, no network beyond the DB read.
"""

from __future__ import annotations

import argparse
import asyncio
import math
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.caddie import aim_point as aim_point_mod  # noqa: E402
from app.caddie import hazards as hazards_mod  # noqa: E402
from app.caddie import physics  # noqa: E402
from app.caddie.aim_point import generate_recommendation  # noqa: E402
from app.caddie.club_selection import DEFAULT_CLUB_DISTANCES  # noqa: E402
from app.caddie.types import HoleIntelligence  # noqa: E402
from app.services import courses_mapped  # noqa: E402
from app.db.engine import async_session  # noqa: E402
from sqlalchemy import text  # noqa: E402

# The owner's real 12-club bag — no hybrid/5wood, the reported amplifier
# (specs/caddie-yardage-selector-p0-plan.md §1/§3.2).
OWNER_CLUB_DISTANCES: dict[str, int] = {
    "driver": 300,
    "3wood": 270,
    "4iron": 230,
    "5iron": 215,
    "6iron": 195,
    "7iron": 180,
    "8iron": 170,
    "9iron": 155,
    "pw": 140,
    "gw": 127,
    "sw": 115,
    "lw": 90,
}

# Any club here is "sub-hybrid" — an iron or wedge, off a par-4/5 tee.
_SUB_HYBRID_CLUBS = frozenset({
    "4iron", "5iron", "6iron", "7iron", "8iron", "9iron", "pw", "gw", "sw", "lw",
})

_FALLBACK_HANDICAP = 15.0


async def _probe_owner_handicap() -> tuple[float, str]:
    """Best-effort READ-ONLY probe of the owner's real handicap
    (`golfer_profiles.handicap_index`) — the row with a real, populated
    `bag_clubs` (the only real user of this early-stage app). Falls back to
    15.0, labeled, per [[no-fake-data-fallbacks]] — never a guessed number
    presented as real."""
    try:
        async with async_session() as db:
            row = (
                await db.execute(
                    text(
                        """
                        select handicap_index
                        from public.golfer_profiles
                        where bag_clubs is not null and bag_clubs::text != '{}'
                        order by updated_at desc
                        limit 1
                        """
                    )
                )
            ).mappings().first()
        if row and row["handicap_index"] is not None:
            return float(row["handicap_index"]), "prod golfer_profiles.handicap_index"
    except Exception as exc:  # noqa: BLE001 — read-only best-effort probe
        print(f"  [warn] handicap probe failed ({exc!r}); using fallback", file=sys.stderr)
    return _FALLBACK_HANDICAP, "FALLBACK (no populated golfer_profiles row found)"


def _feature_list(features: Optional[dict]) -> list[dict]:
    return (features or {}).get("features") or []


def _green_persisted_elevation(features: Optional[dict]) -> Optional[dict]:
    """Mirrors `app.services.course_elevation._green_persisted_elevation` —
    pull the green feature's persisted elevation props, or None."""
    for f in _feature_list(features):
        props = f.get("properties") or {}
        if props.get("featureType") == "green" and props.get("tee_elevation_ft") is not None:
            return props
    return None


def _elevation_change_ft(features: Optional[dict]) -> float:
    persisted = _green_persisted_elevation(features)
    if persisted is None:
        return 0.0
    delta = persisted.get("delta_ft")
    if delta is None:
        tee_e = persisted.get("tee_elevation_ft")
        green_e = persisted.get("green_elevation_ft")
        if tee_e is None or green_e is None:
            return 0.0
        delta = green_e - tee_e
    return float(delta)


def _resolve_yards(hole: dict) -> tuple[Optional[int], str]:
    """Longest tee-set yardage (card convention) -> (yards, 'card'). No
    yardage stored -> derived tee->green distance -> (yards, 'derived'),
    honestly labeled. Neither resolvable -> (None, 'unknown')."""
    yardages = hole.get("yardages") or {}
    if yardages:
        return max(int(y) for y in yardages.values() if y), "card"

    feature_list = _feature_list(hole.get("features"))
    tee_pt, green_pt = hazards_mod._derive_tee_green(feature_list, None, None)
    if tee_pt is None or green_pt is None:
        return None, "unknown"
    tee_lon, tee_lat = tee_pt
    green_lon, green_lat = green_pt
    gx, gy = hazards_mod._xy_m(tee_lat, tee_lon, green_lat, green_lon)
    dist_m = math.hypot(gx, gy)
    return round(dist_m * hazards_mod._YARDS_PER_METER), "derived"


# ── Evidence-sparsity introspection (Class B diagnostic) ───────────────────
# Re-derives the SAME danger-edge evidence `extract_corridor_profile` uses,
# but additionally tracks which STORED FEATURE each observation vertex came
# from — `_side_edge_at`'s own >=3-observation qualification counts ring
# VERTICES, so one small woods polygon (4-5 ring vertices) can trivially
# self-qualify a side even though it is really ONE mapped feature. Read-only
# introspection only; does not change any engine behavior.


def _tree_observations_with_feature_id(feature_list: list[dict]) -> list[tuple[float, float, int]]:
    out: list[tuple[float, float, int]] = []
    for idx, f in enumerate(feature_list):
        props = f.get("properties") or {}
        if props.get("featureType") not in hazards_mod._TREE_FEATURE_TYPES:
            continue
        geom = f.get("geometry") or {}
        gtype = geom.get("type")
        coords = geom.get("coordinates")
        if gtype == "Point" and coords and len(coords) >= 2:
            out.append((float(coords[0]), float(coords[1]), idx))
        elif gtype == "Polygon" and coords and coords[0]:
            ring = coords[0]
            vertices = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
            for c in vertices:
                if c and len(c) >= 2:
                    out.append((float(c[0]), float(c[1]), idx))
    return out


def _classify_with_feature_id(
    obs: list[tuple[float, float, int]], tee_lat: float, tee_lon: float,
    path_xy: list[tuple[float, float]], tee_along_m: float,
) -> list[tuple[float, float, int]]:
    """(carry_yds, lateral_yds, feature_idx) — mirrors
    `_classify_danger_observations` but keeps the source feature index."""
    out: list[tuple[float, float, int]] = []
    for lon, lat, idx in obs:
        hx, hy = hazards_mod._xy_m(tee_lat, tee_lon, lat, lon)
        projected = hazards_mod._project_onto_polyline(path_xy, hx, hy)
        if projected is None:
            continue
        carry_m, lateral_m = projected[0] - tee_along_m, projected[1]
        if carry_m < 0:
            continue
        lateral_yds = lateral_m * hazards_mod._YARDS_PER_METER
        if abs(lateral_yds) > hazards_mod._TREE_MAX_LATERAL_YARDS:
            continue
        out.append((carry_m * hazards_mod._YARDS_PER_METER, lateral_yds, idx))
    return out


def _evidence_sparsity(features: Optional[dict], target_distance_yds: float) -> Optional[str]:
    """For the tree evidence nearest `target_distance_yds` on whichever side
    won, report `(n_obs, n_distinct_features)` — the Class B smoking gun is
    n_obs >= 3 (qualifies) but n_distinct_features == 1 (one polygon's own
    ring vertices self-qualifying)."""
    feature_list = _feature_list(features)
    tee_pt, green_pt = hazards_mod._derive_tee_green(feature_list, None, None)
    if tee_pt is None or green_pt is None:
        return None
    tee_lon, tee_lat = tee_pt
    path = hazards_mod._hole_polyline(feature_list)
    if path is None:
        return None
    path_xy = [hazards_mod._xy_m(tee_lat, tee_lon, lat, lon) for lon, lat in path]
    tee_projected = hazards_mod._project_onto_polyline(path_xy, 0.0, 0.0)
    if tee_projected is None:
        return None
    tee_along_m = tee_projected[0]

    raw = _tree_observations_with_feature_id(feature_list)
    classified = _classify_with_feature_id(raw, tee_lat, tee_lon, path_xy, tee_along_m)

    window = hazards_mod._CORRIDOR_EVIDENCE_WINDOW_YDS
    left = [(lat, idx) for carry, lat, idx in classified if abs(carry - target_distance_yds) <= window and lat >= 0]
    right = [(lat, idx) for carry, lat, idx in classified if abs(carry - target_distance_yds) <= window and lat <= 0]

    parts = []
    for label, group in (("L", left), ("R", right)):
        n_obs = len(group)
        n_feat = len({idx for _, idx in group})
        qualifies = "Y" if n_obs >= hazards_mod._TREE_MIN_OBS else "n"
        parts.append(f"{label}:{n_obs}obs/{n_feat}feat/q={qualifies}")
    return " ".join(parts)


def _build_hole_intel(hole: dict, yards: Optional[int]) -> Optional[HoleIntelligence]:
    features = hole.get("features")
    feature_list = _feature_list(features)
    if not feature_list or yards is None:
        return None

    elevation_change_ft = _elevation_change_ft(features)
    effective_yards = (
        None if yards is None
        else physics.elevation_only_plays_like(yards, elevation_change_ft)
    )

    hazards_list = hazards_mod.extract_hole_hazards(features)
    bend = hazards_mod.extract_hole_bend(features)
    corridor = hazards_mod.extract_corridor_profile(features)

    return HoleIntelligence(
        hole_number=hole["number"],
        par=hole["par"],
        yards=yards,
        effective_yards=effective_yards,
        elevation_change_ft=elevation_change_ft,
        hazards=hazards_list,
        bend=bend,
        corridor=corridor,
    )


def _bend_cap_corner_trees_detail(intel: HoleIntelligence) -> str:
    """Reproduces the EXACT `corner_trees` filter aim_point.py's bend-cap
    gate uses (aim_point.py:988-993) — no independent reimplementation, the
    literal same predicate — so the audit shows PRECISELY what evidence
    justified (or didn't) each bend-cap firing. Deliberately surfaces the
    filter's own missing UPPER bound on `h.carry_yards` (only `>= bend.
    distance_yards - CORNER_TREE_LOOKBACK_YDS` is checked, no `<=` ceiling)
    — a tree hazard far past the corner (even near the green) currently
    qualifies as 'guarding' it."""
    bend = intel.bend
    if bend is None or bend.straight or bend.distance_yards is None:
        return "-"
    corner_trees = [
        h for h in intel.hazards
        if h.type == "trees"
        and h.carry_yards >= bend.distance_yards - aim_point_mod.CORNER_TREE_LOOKBACK_YDS
        and aim_point_mod._SEVERITY_RANK.get(h.penalty_severity, 0) >= aim_point_mod._MODERATE_RANK
    ]
    if not corner_trees:
        return "none"
    parts = []
    for h in corner_trees:
        past_corner = h.carry_yards - bend.distance_yards
        parts.append(f"{h.carry_yards}y({'+' if past_corner >= 0 else ''}{past_corner} vs corner)/{h.penalty_severity}/{h.line_side}")
    return "; ".join(parts)


def _mechanism_and_picks(
    intel: HoleIntelligence, yards: int, bag: dict[str, int], handicap: float,
) -> tuple[str, str, str, str]:
    """Runs (C) uncapped, (B) bend-cap-only, (A) full — returns
    (pick_c, pick_b, pick_a, mechanism)."""
    intel_c = intel.model_copy(update={"bend": None, "corridor": None})
    intel_b = intel.model_copy(update={"corridor": None})
    intel_a = intel

    rec_c = generate_recommendation(
        hole=intel_c, distance_yards=yards, club_distances=bag,
        handicap=handicap, weather=None, shot_bearing=0.0,
    )
    rec_b = generate_recommendation(
        hole=intel_b, distance_yards=yards, club_distances=bag,
        handicap=handicap, weather=None, shot_bearing=0.0,
    )
    rec_a = generate_recommendation(
        hole=intel_a, distance_yards=yards, club_distances=bag,
        handicap=handicap, weather=None, shot_bearing=0.0,
    )

    pick_c, pick_b, pick_a = rec_c.club, rec_b.club, rec_a.club
    if pick_c != pick_b:
        mechanism = f"bend-cap@{intel.bend.distance_yards if intel.bend else '?'}"
    elif pick_b != pick_a:
        mechanism = "corridor-cost"
    else:
        mechanism = "none"
    return pick_c, pick_b, pick_a, mechanism


async def run(bag_arg: str, course_id_filter: Optional[str], handicap_override: Optional[float]) -> None:
    if handicap_override is not None:
        handicap, handicap_source = handicap_override, "CLI override"
    else:
        handicap, handicap_source = await _probe_owner_handicap()

    bags: list[tuple[str, dict[str, int]]] = []
    if bag_arg in ("owner", "both"):
        bags.append(("owner", OWNER_CLUB_DISTANCES))
    if bag_arg in ("default", "both"):
        bags.append(("default", dict(DEFAULT_CLUB_DISTANCES)))

    print(f"# Tee-selector audit — handicap={handicap} ({handicap_source})\n")
    print(
        "| course | hole | par | yards | pick(owner) | pick(default) | mechanism | "
        "bend dist/dev | bend-cap corner trees (aim_point's own filter) | "
        "corridor evidence @uncapped total | FLAG |"
    )
    print("|---|---|---|---|---|---|---|---|---|---|---|")

    courses = await courses_mapped.list_courses()
    if course_id_filter:
        courses = [c for c in courses if c["id"] == course_id_filter]

    total_holes = 0
    total_flags = 0

    for course in courses:
        full = await courses_mapped.get_course(course["id"])
        if not full:
            continue
        course_name = full["name"]
        for hole in sorted(full["holes"], key=lambda h: h["number"]):
            if hole["par"] not in (4, 5):
                continue
            yards, yardage_basis = _resolve_yards(hole)
            if yards is None:
                continue
            intel = _build_hole_intel(hole, yards)
            if intel is None:
                continue  # no mapped geometry for this hole — nothing to audit

            total_holes += 1

            picks: dict[str, str] = {}
            mechanisms: dict[str, str] = {}
            for bag_name, bag in bags:
                pick_c, pick_b, pick_a, mechanism = _mechanism_and_picks(intel, yards, bag, handicap)
                picks[bag_name] = pick_a
                mechanisms[bag_name] = mechanism

            pick_owner = picks.get("owner", "-")
            pick_default = picks.get("default", "-")
            mech = mechanisms.get("owner", mechanisms.get("default", "none"))

            bend = intel.bend
            bend_str = (
                f"{bend.direction}@{bend.distance_yards}/{bend.deviation_yards}y"
                if bend and not bend.straight else
                (f"straight/{bend.deviation_yards}y" if bend else "none")
            )

            # Corridor evidence at the UNCAPPED (C-run) driver/longest-club
            # total for the owner bag (falls back to default bag if owner
            # bag not run).
            uncapped_bag = bags[0][1]
            rec_uncapped = generate_recommendation(
                hole=intel.model_copy(update={"bend": None, "corridor": None}),
                distance_yards=yards, club_distances=uncapped_bag,
                handicap=handicap, weather=None, shot_bearing=0.0,
            )
            uncapped_total = (
                rec_uncapped.tee_shot_numbers.drive_total_yards
                if rec_uncapped.tee_shot_numbers else rec_uncapped.target_yards
            )
            evidence = _evidence_sparsity(hole.get("features"), float(uncapped_total)) or "-"
            corner_trees_detail = _bend_cap_corner_trees_detail(intel)

            flagged = any(p in _SUB_HYBRID_CLUBS for p in picks.values())
            if flagged:
                total_flags += 1

            yards_label = f"{yards}" if yardage_basis == "card" else f"{yards}(derived)"
            print(
                f"| {course_name} | {hole['number']} | {hole['par']} | {yards_label} | "
                f"{pick_owner} | {pick_default} | {mech} | {bend_str} | {corner_trees_detail} | "
                f"{evidence} | {'FLAG' if flagged else ''} |"
            )

    print(f"\n**Totals:** {total_holes} par-4/5 holes audited, {total_flags} flagged.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bag", choices=["owner", "default", "both"], default="both")
    parser.add_argument("--course-id", default=None)
    parser.add_argument("--handicap", type=float, default=None)
    args = parser.parse_args()
    asyncio.run(run(args.bag, args.course_id, args.handicap))


if __name__ == "__main__":
    main()
