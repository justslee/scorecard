"""Hazard extraction & formatting — grounds the caddie voice in real geometry.

Pure, unit-testable module: no DB, no network. Consumes a hole's stored GeoJSON
FeatureCollection (the curated bunker/water polygons in ``hole_features``, read
via ``courses_mapped.get_course``) and produces a capped ``Hazard`` list plus a
compact spoken-style line.

Owner escalation (2026-07-06): the realtime caddie said "260 to the left
bunker" on a hole with NO left bunker. This module is the fix — it never
invents a hazard; when tee/green geometry can't be derived it returns an
empty list, and ``HAZARD_GROUNDING_RULE`` tells the model to speak generally
instead of naming a feature that isn't in the data.

Math convention (pinned — see test_hazards.py::test_left_is_positive_cross):
  - Preferred frame: the hole's PLAYED line — the ``golf=hole`` way polyline
    (stored as a ``featureType == "hole"`` LineString, or passed via the
    ``polyline=`` arg). The hazard centroid is projected onto its nearest
    segment; carry is the CUMULATIVE along-path distance to that projection
    and side is the cross product against THAT segment's direction. On a
    dogleg, a bunker on the outside of the first leg is classified against
    the leg the player actually hits over — the tee→green chord mirrors it
    (Bethpage Black 4 incident, 2026-07-08: the hole doglegs LEFT; the 265y
    carry bunker is 32y LEFT of the played first leg but sits right of the
    straight chord, so the chord math emitted "bunker R 265y").
  - Chord fallback (no polyline available): û = unit vector along the
    tee→green direction; h = hazard centroid − tee (metres, equirectangular
    projection); carry = dot(h, û); side = sign of cross(û, h).
  - In both frames: carry_yards is converted to yards, rounded to the nearest
    5, negatives clamped to 0 (a hazard "behind" the tee never happens for a
    real bunker/water feature, but the clamp keeps the number sane).
    POSITIVE lateral = LEFT of the travel direction, negative = right. A
    10-yard lateral deadband collapses near-line hazards to "center" rather
    than reporting noisy left/right jitter.
  - Bend/dogleg (``extract_hole_bend``): the vertex with the largest
    perpendicular deviation off the tee→green chord (``dev_m = ux*vy -
    uy*vx``, positive = LEFT of the chord, same cross form as above) SELECTS
    the bend and drives the straight-hole threshold — but the SPOKEN
    direction is a different quantity: the turn cross between the tee→bend
    leg and the bend→green leg (``turn = u1x*u2y - u1y*u2x`` where u1, u2 are
    those two legs' unit vectors; turn > 0 = "left", turn < 0 = "right"). On
    a dogleg the outside corner sits on the OPPOSITE side of the straight
    chord from the way the hole actually turns (e.g. a dogleg-LEFT hole's
    corner sits right of the chord) — reporting the deviation sign instead
    of the turn cross says "right" on every dogleg-left hole, the sign-flip
    incident class this repo has been burned by twice. See
    test_hazards.py::TestExtractHoleBend for the pinned example.

Trees/woods (OSM ``featureType in {"tree", "woods"}``, gated into
``extract_hole_hazards`` 2026-07-09): a single centroid is the wrong shape for
tree data — hundreds of ``"tree"`` Points would be noise, and a ``"woods"``
polygon's centroid sits deep inside the stand (often 50-100+ y past the real
tree line, and on the wrong side of the played line for a stand wrapping a
dogleg corner). Instead tree/woods features are reduced to OBSERVATION
POINTS — each ``"tree"`` Point is one observation; each ``"woods"`` Polygon
contributes every OUTER-RING VERTEX as an observation (the OSM boundary
literally traces the tree line, so the ring IS the leading edge; the closing
duplicate vertex is deduped). Every observation is classified through the
EXACT SAME frame as a bunker/water centroid (the ``_classify`` closure below —
same played-polyline-or-chord math, same reversed-way exposure, same
dogleg/chord-mirror exposure). Two filters make woods handling near-EDGE by
construction rather than centroid: observations behind the tee are DROPPED
(not clamped to 0 like bunkers — with many observations per feature this
loses nothing and keeps a range's start meaningful), and observations more
than ``_TREE_MAX_LATERAL_YARDS`` (70y) from the line are dropped, which
discards a big stand's deep/far-side ring vertices and keeps only the edge
FACING the played line. Surviving observations are grouped by ``line_side``
(same 10y deadband); a side only SPEAKS with ``>= _TREE_MIN_OBS`` (3)
observations — the coverage guard that keeps 1-2 stray volunteer-mapped tree
points silent while any real mapped woods polygon (>=4 ring vertices)
qualifies on its own. A qualifying side with spread ``< _TREE_RANGE_MIN_
SPREAD_YARDS`` (30y) emits a single min-carry ``Hazard(type="trees")``.
Otherwise it emits a GAP-BOUNDED GREEDY CHAIN of REAL observations, not just
the min/max pair (Finding B fix, 2026-07-16 — the old two-entry near/far
collapse could silently drop a bracketing tree line's interior coverage: a
LEFT line spanning carry 145-360y collapsed to just {145, 360}, both outside
an ~80y drive window, while a sparse RIGHT cluster's near entry survived
inside it — the caddie confidently called "miss right" on a hole where LEFT
was equally in play). The chain starts at the near observation and
repeatedly jumps to the FARTHEST observation within ``_TREE_SPAN_MAX_GAP_
YDS`` (40y) of the current vertex; when no observation qualifies (a real
mapped gap wider than 40y), it jumps to the very next observation in sorted
order instead — the gap is preserved, NEVER interpolated — and always
terminates at the far observation. A per-side safety cap
(``_TREE_CHAIN_SAFETY_CAP``, 12) doubles the gap and rebuilds the chain if
exceeded, so entry count stays bounded while the near/far endpoints always
survive. ``format_hazards_line``'s existing (type, side) grouping renders
the resulting min...max spread as a single range (``trees R 220-300y``,
byte-identical for the common 2-entry case) with zero new formatter logic —
chain interior vertices only add MORE grounded carries within that same
rendered range, they never change the rendered min/max. Tree entries are
computed SEPARATELY from the bunker/water pass and appended AFTER it has
been sorted and capped — a tree line can structurally never evict a bunker
or water hazard from the extraction result. See test_tree_hazards.py for the
pinned observation-model tests (T1-T12) and
specs/caddie-hazard-side-reach-plan.md §3 for the gap-bounded chain
derivation.
"""

from __future__ import annotations

import math
from typing import Optional

from app.caddie.types import CorridorSample, Hazard, HoleBend
from app.services.course_spatial import _ring_centroid

# Metres per degree of latitude (WGS-84 mean) — mirrors the equirectangular
# idiom used throughout course_spatial.py (_deg_to_m et al).
_LAT_M_PER_DEG: float = 111_320.0

_YARDS_PER_METER: float = 1.09361
_LATERAL_DEADBAND_YARDS: float = 10.0
_DEFAULT_CAP: int = 5
# Below this chord deviation the hole is reported as measured-straight (see
# extract_hole_bend). 15y is comfortably above OSM digitization jitter and
# the 10y hazard lateral deadband, comfortably below any bend a caddie would
# actually name.
_BEND_MIN_DEVIATION_YARDS: float = 15.0

_HAZARD_FEATURE_TYPES: frozenset[str] = frozenset({"bunker", "water"})
_SEVERITY_BY_TYPE: dict[str, str] = {"water": "death", "bunker": "moderate", "trees": "moderate"}
_SIDE_ABBREV: dict[str, str] = {"left": "L", "right": "R", "center": "C"}
# bunker before water before trees; "center" sorts after left/right within the
# same type only insofar as it appears later in extract order — grouping is
# by (type, side) so ordering here just controls type precedence. Trees sort
# LAST so a tree line can never outrank a real water hazard in the spoken line.
_TYPE_ORDER: dict[str, int] = {"bunker": 0, "water": 1, "trees": 2}

# ── Tree/woods observation model (module docstring "Trees/woods" paragraph) ──
_TREE_FEATURE_TYPES: frozenset[str] = frozenset({"tree", "woods"})
_TREE_MIN_OBS: int = 3
_TREE_MAX_LATERAL_YARDS: float = 70.0
_TREE_RANGE_MIN_SPREAD_YARDS: float = 30.0
# Gap-bounded chain step (Finding B fix, 2026-07-16): the drive window is 80y
# wide (DRIVE_ZONE_SHORT_YDS 50 + DRIVE_ZONE_LONG_YDS 30 in decade_advice.py).
# A <=40y step guarantees at least one emitted chain vertex inside any 80y
# window overlapping a densely-observed span, so a bracketing tree line can
# no longer be windowed away by the old near/far-only collapse (a real Red-1
# defect — see _extract_tree_line_hazards). Only a real observation gap
# wider than this can leave a window empty, and then exclusion is honest.
_TREE_SPAN_MAX_GAP_YDS: float = 40.0
# Safety cap on chain length per side — if exceeded (an unusually dense
# stand), the gap is doubled and the chain rebuilt (loop) so entry count
# stays bounded while near/far endpoints always survive.
_TREE_CHAIN_SAFETY_CAP: int = 12

# format_hazards_line's group cap (bunker/water/trees combined). Named
# constant (was a literal 5) so the trees-headroom decision is documented at
# the definition site — see module docstring "decision 6" in the plan.
_FORMAT_GROUP_CAP: int = 6

# ── Corridor profile (specs/corridor-width-club-selection-plan.md §2) ──────
_CORRIDOR_SAMPLE_START_YDS: int = 60      # below the shortest club total (~85y stored)
_CORRIDOR_SAMPLE_STEP_YDS: int = 10
_CORRIDOR_SAMPLE_MAX_YDS: int = 360       # past any real drive total
_CORRIDOR_EVIDENCE_WINDOW_YDS: float = 20.0  # ±20y along-path, per §4.4 contract
_CORRIDOR_MAX_CAST_YDS: float = 100.0     # perpendicular ray cap for fairway-edge cast
_CORRIDOR_WATER_MIN_OBS: int = 1


HAZARD_GROUNDING_RULE = (
    "Only name a specific hazard (bunker, water, trees) or a yardage to one if "
    "it appears in the hazard data provided for this hole. If no hazard data is "
    "given for the hole, do not invent one: speak generally about where to miss "
    '("trouble left", "keep it right-center", "bail out short") and never state '
    'a specific feature with a distance (e.g. never "a bunker at 260 on the '
    'left") unless it is in the data. Tree lines and woods appear in the '
    'hazard data as "trees" entries whose yardage is where the tree line runs '
    "along or across the hole. If the player asks about trees and no "
    '"trees" entry is in the hazard data for this hole, say the trees are '
    "not in your mapped data — never estimate a tree-line distance."
)

BEND_GROUNDING_RULE = (
    "Only say the fairway bends or doglegs — or give a distance to a bend — if the "
    "hole-shape data for this hole or the get_bend tool provides it. If the data says "
    "the hole plays straight, say it plays straight. If no hole-shape data is given, "
    "never guess a dogleg direction or a distance to a bend."
)


def _xy_m(base_lat: float, base_lon: float, lat: float, lon: float) -> tuple[float, float]:
    """Project (lat, lon) into local (x=east, y=north) metres relative to base.

    Same equirectangular idiom as course_spatial._deg_to_m: longitude scaled by
    cos(mean latitude) so the projection stays accurate over golf-hole distances.
    """
    mid_lat_rad = math.radians((base_lat + lat) / 2.0)
    x = (lon - base_lon) * _LAT_M_PER_DEG * math.cos(mid_lat_rad)
    y = (lat - base_lat) * _LAT_M_PER_DEG
    return x, y


def _round_to_5(value: float) -> int:
    return int(round(value / 5.0)) * 5


def _ring_shoelace_area(ring: list[list[float]]) -> float:
    """Unsigned planar shoelace "area" in raw lon/lat units — NOT a true
    geographic area (no projection), but a stable relative-size proxy for
    picking the largest member ring of a MultiPolygon. Good enough at
    golf-hole scale, where every member sits within a few hundred metres of
    the others, so degree-scale distortion is effectively uniform across
    members being compared."""
    vertices = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
    n = len(vertices)
    if n < 3:
        return 0.0
    total = 0.0
    for i in range(n):
        x1, y1 = vertices[i]
        x2, y2 = vertices[(i + 1) % n]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


def _feature_point(feature: dict) -> Optional[tuple[float, float]]:
    """Return the (lon, lat) representative point for a GeoJSON Feature.

    Points are used directly; Polygons use their outer-ring centroid
    (_ring_centroid — same helper the spatial-join step uses). MultiPolygons
    (v1.1.9 Item 2 — a golf=bunker/natural=sand relation, e.g. a waste-bunker
    complex, now flows through the ingest pipeline as a MultiPolygon) use the
    centroid of the LARGEST member's outer ring (by `_ring_shoelace_area`),
    so a small satellite patch in the same relation never overrides the main
    complex's location. Mirrors the frontend's MultiPolygon handling
    (tee-shot-overlays.ts `fairwayBunkerCarries`) — both surfaces must accept
    the same geometry shapes so the caddie and the map never disagree about
    which bunkers exist.
    """
    geom = feature.get("geometry") or {}
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if gtype == "Point" and coords and len(coords) >= 2:
        return float(coords[0]), float(coords[1])
    if gtype == "Polygon" and coords and coords[0]:
        return _ring_centroid(coords[0])
    if gtype == "MultiPolygon" and coords:
        best_ring: Optional[list[list[float]]] = None
        best_area = -1.0
        for member in coords:
            if not member or not member[0]:
                continue
            ring = member[0]
            area = _ring_shoelace_area(ring)
            if area > best_area:
                best_area = area
                best_ring = ring
        if best_ring:
            return _ring_centroid(best_ring)
    return None


def _point_dist_sq_m(base_lat: float, a: tuple[float, float], b: tuple[float, float]) -> float:
    """Squared metre distance between two (lon, lat) points via the
    equirectangular projection (``_xy_m``) — used for nearest/farthest tee
    selection below. Accurate enough at golf-hole scale (a few hundred
    metres), where raw lon/lat degree distance would be biased by the
    cos(latitude) longitude scaling this helper corrects for."""
    a_lon, a_lat = a
    b_lon, b_lat = b
    x, y = _xy_m(base_lat, a_lon, b_lat, b_lon)
    return x * x + y * y


def _derive_tee_green(
    features: list[dict],
    tee: Optional[dict],
    green: Optional[dict],
) -> tuple[Optional[tuple[float, float]], Optional[tuple[float, float]]]:
    """Derive (tee_lonlat, green_lonlat) for the hole.

    Green priority (unchanged):
    1. A ``"green"`` Polygon centroid in the FeatureCollection (first one
       found).
    2. Fallback: a ``"hole"`` LineString's last vertex.
       NOTE (tee-ordering dependency): this assumes the ``golf=hole`` way is
       digitized tee→green, which is the OSM convention. A way drawn
       green→tee would swap the derived endpoints AND reverse the polyline's
       travel direction (mirroring every side) — there is no independent
       signal here to detect that; the ingest-time yardage validation
       (test_bethpage_validation "GROSS REVERSED" check) is the guard.
    3. Last resort: the ``green=`` arg ({"lat", "lng"} dict).

    Tee priority (Finding A fix, 2026-07-16 — a multi-tee hole was picking
    the FIRST stored tee feature by file order, which silently anchored
    every carry/bend/corridor number to the wrong box the player was
    actually standing on):
    1. A VALID ``tee=`` arg — ``{"lat", "lng"}`` both present, non-None, and
       not the sloppy-default sentinel ``(0, 0)``:
       - Stored ``featureType == "tee"`` features exist: select the stored
         tee whose ``_feature_point`` is NEAREST the arg. The arg is itself
         a selector into curated geometry — the frontend already resolves
         and sends the player's own tee box (``applyTeeAnchors`` /
         ``ringCentroid``, see ``frontend/src/lib/course/tee-anchor.ts``) —
         so this is an exact match in practice, and it's tolerant of
         centroid-computation drift and a sloppy `legacy`-source marker.
       - No stored tee features: use the arg directly (today's last-resort
         path, promoted to first-class when a valid arg is supplied).
    2. No arg, MULTIPLE stored tee features, green derivable: the tee
       FARTHEST (straight-line) from the derived green — the back tee.
       Deterministic, replaces file-order "first" with the card convention
       and the frontend's own tie rule ("never hand the golfer a
       shorter-than-actual number"). Requires the green to already be known
       — the loop above collects tee/green together before this selection
       runs. No stored green yet at this point (only the linestring/arg
       fallbacks could supply one) → honest fallback to the first stored tee
       (order-independent tie; no way to define "back" without a green).
    3. No arg, a single stored tee feature: that tee (unchanged).
    4. Hole-LineString fallback: unchanged (first vertex).
    5. Last resort: the ``tee=`` arg's raw fields, even if incomplete/zeroed
       (mirrors the pre-fix "if tee_pt is None and tee" catch-all — only
       reachable when nothing above resolved a tee).

    Never guesses a bearing — a side left `None` propagates to the caller,
    which returns `[]` rather than fabricate a travel direction.
    """
    tee_feature_points: list[tuple[float, float]] = []
    green_pt: Optional[tuple[float, float]] = None

    for f in features:
        props = f.get("properties") or {}
        ftype = props.get("featureType")
        if ftype == "tee":
            pt = _feature_point(f)
            if pt is not None:
                tee_feature_points.append(pt)
        elif ftype == "green" and green_pt is None:
            green_pt = _feature_point(f)

    tee_arg_pt: Optional[tuple[float, float]] = None
    if tee is not None:
        arg_lat = tee.get("lat")
        arg_lng = tee.get("lng")
        if (
            arg_lat is not None
            and arg_lng is not None
            and not (float(arg_lat) == 0.0 and float(arg_lng) == 0.0)
        ):
            tee_arg_pt = (float(arg_lng), float(arg_lat))

    tee_pt: Optional[tuple[float, float]] = None
    if tee_arg_pt is not None:
        if tee_feature_points:
            base_lat = tee_arg_pt[1]
            tee_pt = min(
                tee_feature_points,
                key=lambda pt: _point_dist_sq_m(base_lat, tee_arg_pt, pt),
            )
        else:
            tee_pt = tee_arg_pt
    elif len(tee_feature_points) == 1:
        tee_pt = tee_feature_points[0]
    elif len(tee_feature_points) > 1:
        if green_pt is not None:
            base_lat = green_pt[1]
            tee_pt = max(
                tee_feature_points,
                key=lambda pt: _point_dist_sq_m(base_lat, green_pt, pt),
            )
        else:
            tee_pt = tee_feature_points[0]

    if tee_pt is None or green_pt is None:
        for f in features:
            props = f.get("properties") or {}
            if props.get("featureType") != "hole":
                continue
            geom = f.get("geometry") or {}
            if geom.get("type") != "LineString":
                continue
            coords = geom.get("coordinates") or []
            if len(coords) < 2:
                continue
            if tee_pt is None:
                tee_pt = (float(coords[0][0]), float(coords[0][1]))
            if green_pt is None:
                last = coords[-1]
                green_pt = (float(last[0]), float(last[1]))
            break

    if tee_pt is None and tee:
        tee_pt = (tee.get("lng", 0.0), tee.get("lat", 0.0))
    if green_pt is None and green:
        green_pt = (green.get("lng", 0.0), green.get("lat", 0.0))

    return tee_pt, green_pt


def _hole_polyline(feature_list: list[dict]) -> Optional[list[tuple[float, float]]]:
    """Return the hole's ``golf=hole`` way as ``[(lon, lat), ...]`` when the
    FeatureCollection stores it (``featureType == "hole"`` LineString with
    ≥2 vertices) — the PLAYED line hazards should be classified against.
    ``None`` when no usable polyline exists (chord fallback)."""
    for f in feature_list:
        props = f.get("properties") or {}
        if props.get("featureType") != "hole":
            continue
        geom = f.get("geometry") or {}
        if geom.get("type") != "LineString":
            continue
        coords = geom.get("coordinates") or []
        if len(coords) >= 2:
            return [(float(c[0]), float(c[1])) for c in coords]
    return None


def _project_onto_polyline(
    path_xy: list[tuple[float, float]], hx: float, hy: float
) -> Optional[tuple[float, float]]:
    """Project the hazard point (hx, hy) onto its nearest polyline segment.

    Returns ``(carry_m, lateral_m)``:
      - carry_m = CUMULATIVE along-path distance from the polyline start to
        the projection point (the played distance to reach the hazard, not
        the straight-line chord distance).
      - lateral_m = cross product of THAT segment's unit direction with the
        hazard offset from the segment start — same sign convention as the
        chord math (positive = LEFT of travel).

    The projection parameter is clamped to each interior segment, but the
    FIRST segment extrapolates behind the tee and the LAST extrapolates past
    the green, so a hazard beyond either end keeps its true carry instead of
    being clamped to the path length (mirrors the chord path's behavior; the
    caller's max(0, ...) clamp still floors behind-the-tee carries at 0).

    Returns ``None`` when the polyline has no non-degenerate segment.
    """
    best: Optional[tuple[float, float, float]] = None  # (dist², carry, lateral)
    cum_m = 0.0
    last_seg = len(path_xy) - 2
    for i in range(len(path_xy) - 1):
        ax, ay = path_xy[i]
        bx, by = path_xy[i + 1]
        dx, dy = bx - ax, by - ay
        seg_len = math.hypot(dx, dy)
        if seg_len == 0.0:
            continue
        t = ((hx - ax) * dx + (hy - ay) * dy) / (seg_len * seg_len)
        if i > 0:
            t = max(0.0, t)
        if i < last_seg:
            t = min(1.0, t)
        px, py = ax + t * dx, ay + t * dy
        dist_sq = (hx - px) ** 2 + (hy - py) ** 2
        ux, uy = dx / seg_len, dy / seg_len
        lateral = ux * (hy - ay) - uy * (hx - ax)  # positive = LEFT of this segment
        if best is None or dist_sq < best[0]:
            best = (dist_sq, cum_m + t * seg_len, lateral)
        cum_m += seg_len
    if best is None:
        return None
    return best[1], best[2]


def extract_hole_bend(
    features: Optional[dict],
    *,
    tee: Optional[dict] = None,
    green: Optional[dict] = None,
    polyline: Optional[list] = None,
) -> Optional[HoleBend]:
    """Where/how far the fairway bends (the dogleg) on a hole, measured from
    the tee along the hole's mapped centerline.

    Identical inputs/frame to extract_hole_hazards — reuses
    _derive_tee_green/_xy_m/_hole_polyline/_project_onto_polyline so bend
    distance and hazard carry_yards are measured from the SAME tee-anchored
    origin by construction (module docstring's "bend / turn-cross" paragraph).

    Direction is the TURN CROSS (tee→bend x bend→green), NOT the sign of the
    bend vertex's chord deviation — see the module docstring and
    test_hazards.py::TestExtractHoleBend for why: the deviation sign only
    SELECTS the bend vertex (argmax |deviation|) and drives the straight-hole
    threshold; it is never the spoken direction.

    Returns:
      - None: cannot determine (no tee/green, no polyline at all, a
        degenerate polyline, or a zero-length chord) — honest unknown, never
        a guessed bearing. A hole with no mapped centerline has no interior
        vertices to define a bend, so "no polyline" can never mean "straight".
      - HoleBend(straight=True, deviation_yards=n): the max chord deviation
        among candidate vertices is below the 15y threshold.
      - HoleBend(straight=False, direction, distance_yards, deviation_yards,
        double_dogleg): a real, measured bend.

    Same reversed-way exposure as extract_hole_hazards (module docstring
    "Chord fallback" note + _derive_tee_green's tee-ordering dependency): a
    green→tee digitized way would mirror this bend's direction along with
    every hazard side, consistently — no new risk surface (guarded by the
    ingest-time "GROSS REVERSED" yardage validation, test_bethpage_validation).
    """
    feature_list: list[dict] = (features or {}).get("features") or []

    tee_pt, green_pt = _derive_tee_green(feature_list, tee, green)
    if tee_pt is None or green_pt is None:
        return None

    tee_lon, tee_lat = tee_pt
    green_lon, green_lat = green_pt

    gx, gy = _xy_m(tee_lat, tee_lon, green_lat, green_lon)
    length_m = math.hypot(gx, gy)
    if length_m == 0.0:
        return None
    ux, uy = gx / length_m, gy / length_m

    path = None
    if polyline and len(polyline) >= 2:
        path = [(float(c[0]), float(c[1])) for c in polyline]
    if path is None:
        path = _hole_polyline(feature_list)
    if path is None:
        # No interior vertices to define a bend — honest unknown, never a
        # fabricated "straight" (the chord fallback intentionally has no
        # equivalent here, unlike extract_hole_hazards).
        return None

    path_xy = [_xy_m(tee_lat, tee_lon, lat, lon) for lon, lat in path]
    tee_projected = _project_onto_polyline(path_xy, 0.0, 0.0)  # tee = frame origin
    if tee_projected is None:
        return None  # degenerate polyline (all zero-length segments)
    tee_along_m = tee_projected[0]

    if len(path_xy) < 3:
        # Only tee/green endpoints, no interior vertices at all — trivially
        # measured-straight (nothing to deviate).
        return HoleBend(straight=True, deviation_yards=0)

    # Cumulative along-path distance from the path's own start to each vertex.
    cum_m: list[float] = [0.0]
    for i in range(len(path_xy) - 1):
        ax, ay = path_xy[i]
        bx, by = path_xy[i + 1]
        cum_m.append(cum_m[-1] + math.hypot(bx - ax, by - ay))

    # Candidate interior vertices: real forward progress past the tee's own
    # projection (a kink behind the tee is back-tee routing jitter, not a
    # bend the player faces) and not coincident with the green (no outgoing
    # leg to define a turn from there).
    candidates: list[tuple[int, float, float]] = []  # (index, dev_m, along_m)
    for i in range(1, len(path_xy) - 1):
        vx, vy = path_xy[i]
        along_m = cum_m[i] - tee_along_m
        if along_m <= 0:
            continue
        if math.hypot(gx - vx, gy - vy) <= 1.0:
            continue
        dev_m = ux * vy - uy * vx  # positive = LEFT of the chord
        candidates.append((i, dev_m, along_m))

    if not candidates:
        return HoleBend(straight=True, deviation_yards=0)

    # argmax |dev_m|; exact tie -> earlier vertex (smaller along-path distance
    # sorts first — the first corner is the one the player faces).
    best_i, best_dev, best_along = max(candidates, key=lambda c: (abs(c[1]), -c[2]))
    max_dev_yards = abs(best_dev) * _YARDS_PER_METER

    if max_dev_yards < _BEND_MIN_DEVIATION_YARDS:
        return HoleBend(straight=True, deviation_yards=round(max_dev_yards))

    vx, vy = path_xy[best_i]
    v_mag = math.hypot(vx, vy)
    if v_mag == 0.0:
        # Bend vertex coincides with the tee frame origin — no tee->bend leg
        # to define a turn. Degenerate; treat as straight rather than divide
        # by zero (unreachable in practice: the along_m > 0 guard above
        # already requires real forward progress from the tee).
        return HoleBend(straight=True, deviation_yards=round(max_dev_yards))
    u1x, u1y = vx / v_mag, vy / v_mag

    dx, dy = gx - vx, gy - vy
    d_mag = math.hypot(dx, dy)  # > 1.0m, guaranteed by the candidate filter
    u2x, u2y = dx / d_mag, dy / d_mag

    # The correctness crux (module docstring): direction is the TURN cross
    # between the two legs, not the chord-deviation sign computed above.
    # turn == 0 is unreachable here — a vertex whose chord deviation is at or
    # above the threshold cannot be collinear with tee and green (collinear
    # implies dev_m == 0), so no straight-through branch is needed.
    turn = u1x * u2y - u1y * u2x
    direction = "left" if turn > 0 else "right"

    distance_yards = _round_to_5(best_along * _YARDS_PER_METER)

    # Double dogleg (honesty): any OTHER candidate with the opposite
    # deviation sign at/above the threshold means an S-shape — flag it so
    # neither mouth describes the hole as a simple single dogleg.
    double_dogleg = any(
        dev * best_dev < 0 and abs(dev) * _YARDS_PER_METER >= _BEND_MIN_DEVIATION_YARDS
        for _, dev, _ in candidates
    )

    return HoleBend(
        straight=False,
        direction=direction,
        distance_yards=distance_yards,
        deviation_yards=round(max_dev_yards),
        double_dogleg=double_dogleg,
    )


def format_bend_line(hole_number: int, bend: Optional[HoleBend]) -> str:
    """Compact spoken-style bend/dogleg line for a hole, e.g.:

        "Hole 4 shape: doglegs right at ~250y"
        "Hole 4 shape: plays straight — no significant bend"

    Returns "" when ``bend`` is None (unmapped centerline) — the line is
    simply omitted; BEND_GROUNDING_RULE tells the model never to guess a
    dogleg in that case rather than treating the omission as "straight".
    """
    if bend is None:
        return ""
    if bend.straight:
        return f"Hole {hole_number} shape: plays straight — no significant bend"
    suffix = " (double dogleg)" if bend.double_dogleg else ""
    return f"Hole {hole_number} shape: doglegs {bend.direction} at ~{bend.distance_yards}y{suffix}"


def extract_hole_hazards(
    features: Optional[dict],
    *,
    tee: Optional[dict] = None,
    green: Optional[dict] = None,
    cap: int = _DEFAULT_CAP,
    polyline: Optional[list] = None,
) -> list[Hazard]:
    """Extract real bunker/water/tree hazards from a hole's stored GeoJSON
    FeatureCollection.

    Carry/side are classified against the hole's PLAYED polyline (the
    ``golf=hole`` way) whenever one is available — either passed explicitly
    via ``polyline=`` or found in the FeatureCollection itself as a
    ``featureType == "hole"`` LineString (the shape ``assemble_osm_course``
    stores). Only when NO polyline exists does the tee→green straight chord
    fall back in — the chord mirrors sides on doglegs (see module docstring).

    Args:
        features: ``{"type": "FeatureCollection", "features": [...]}`` — the
            per-hole shape returned by ``courses_mapped.get_course()``.
        tee, green: optional ``{"lat", "lng"}`` fallback points, used only when
            the FeatureCollection itself has no derivable tee/green geometry.
        cap: max bunker/water hazards returned (nearest-first) — tree-line
            entries are computed separately and are NOT subject to this cap
            (see module docstring "Trees/woods" paragraph).
        polyline: optional explicit played-line override — GeoJSON-style
            ``[[lon, lat], ...]`` (≥2 vertices). Defaults to the
            FeatureCollection's own hole LineString, then the chord.

    Returns:
        Bunker/water sorted nearest-first and capped at `cap`, plus up to 6
        aggregated tree-line entries (``type="trees"``, at most 2 per side);
        the combined list is sorted by carry_yards ascending. Empty when tee
        or green cannot be derived from any source.
    """
    feature_list: list[dict] = (features or {}).get("features") or []

    tee_pt, green_pt = _derive_tee_green(feature_list, tee, green)
    if tee_pt is None or green_pt is None:
        return []

    tee_lon, tee_lat = tee_pt
    green_lon, green_lat = green_pt

    gx, gy = _xy_m(tee_lat, tee_lon, green_lat, green_lon)
    length_m = math.hypot(gx, gy)
    if length_m == 0.0:
        return []
    ux, uy = gx / length_m, gy / length_m

    # Played line: explicit arg wins, else the stored hole LineString. All
    # points share the tee-based local east/north frame (_xy_m) so the
    # projection math and the chord fallback are in the same coordinates.
    # Carry is measured relative to the TEE's own projection onto the path
    # (not the way's first vertex) so polyline and chord carries agree — the
    # golf=hole way often starts at the back tee, behind the derived tee.
    path = None
    if polyline and len(polyline) >= 2:
        path = [(float(c[0]), float(c[1])) for c in polyline]
    if path is None:
        path = _hole_polyline(feature_list)
    path_xy: Optional[list[tuple[float, float]]] = None
    tee_along_m = 0.0
    if path is not None:
        path_xy = [_xy_m(tee_lat, tee_lon, lat, lon) for lon, lat in path]
        tee_projected = _project_onto_polyline(path_xy, 0.0, 0.0)  # tee = frame origin
        if tee_projected is None:
            path_xy = None  # degenerate polyline (all zero-length segments)
        else:
            tee_along_m = tee_projected[0]

    # Shared per-point classifier — project-onto-polyline-else-chord, the
    # SAME frame for bunkers/water AND the tree observation pass below (module
    # docstring "Trees/woods" paragraph). Returns (carry_m, lateral_m) in the
    # tee-anchored local frame; carry_m is UNCLAMPED (behind-tee is negative)
    # so callers choose their own clamp/drop policy.
    def _classify(hx: float, hy: float) -> tuple[float, float]:
        projected = _project_onto_polyline(path_xy, hx, hy) if path_xy else None
        if projected is not None:
            return projected[0] - tee_along_m, projected[1]
        return ux * hx + uy * hy, ux * hy - uy * hx  # positive lateral = LEFT

    hazards: list[Hazard] = []
    for f in feature_list:
        props = f.get("properties") or {}
        ftype = props.get("featureType")
        if ftype not in _HAZARD_FEATURE_TYPES:
            continue
        pt = _feature_point(f)
        if pt is None:
            continue
        h_lon, h_lat = pt
        hx, hy = _xy_m(tee_lat, tee_lon, h_lat, h_lon)

        carry_m, lateral_m = _classify(hx, hy)

        carry_yards = max(0, _round_to_5(carry_m * _YARDS_PER_METER))
        lateral_yards = lateral_m * _YARDS_PER_METER
        if lateral_yards > _LATERAL_DEADBAND_YARDS:
            line_side = "left"
        elif lateral_yards < -_LATERAL_DEADBAND_YARDS:
            line_side = "right"
        else:
            line_side = "center"

        distance_from_green = math.hypot(hx - gx, hy - gy) * _YARDS_PER_METER

        hazards.append(
            Hazard(
                type=ftype,
                side=line_side,
                distance_from_green=round(distance_from_green),
                penalty_severity=_SEVERITY_BY_TYPE.get(ftype, "moderate"),
                lat=h_lat,
                lng=h_lon,
                carry_yards=carry_yards,
                line_side=line_side,
            )
        )

    hazards.sort(key=lambda hz: hz.carry_yards)
    hazards = hazards[:cap]

    # Tree/woods pass — computed SEPARATELY and appended AFTER the bunker/
    # water cap, so a tree line can never evict a bunker or water hazard
    # (module docstring "Trees/woods" paragraph; decision 6 in the plan).
    tree_hazards = _extract_tree_line_hazards(feature_list, tee_lat, tee_lon, gx, gy, _classify)
    combined = hazards + tree_hazards
    combined.sort(key=lambda hz: hz.carry_yards)
    return combined


def _tree_observations(feature_list: list[dict]) -> list[tuple[float, float]]:
    """Return ``(lon, lat)`` OBSERVATION points for tree/woods features.

    - ``featureType == "tree"`` (Point): the point itself is one observation.
    - ``featureType == "woods"`` (Polygon): every outer-ring vertex is an
      observation — the closing (repeated) vertex is deduped, matching
      ``course_spatial._ring_centroid``'s own dedupe convention.
    """
    observations: list[tuple[float, float]] = []
    for f in feature_list:
        props = f.get("properties") or {}
        if props.get("featureType") not in _TREE_FEATURE_TYPES:
            continue
        geom = f.get("geometry") or {}
        gtype = geom.get("type")
        coords = geom.get("coordinates")
        if gtype == "Point" and coords and len(coords) >= 2:
            observations.append((float(coords[0]), float(coords[1])))
        elif gtype == "Polygon" and coords and coords[0]:
            ring = coords[0]
            vertices = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
            for c in vertices:
                if c and len(c) >= 2:
                    observations.append((float(c[0]), float(c[1])))
    return observations


def _tree_hazard(
    side: str,
    obs: tuple[float, float, float, float, float, float],
    carry_yards: int,
    gx: float,
    gy: float,
) -> Hazard:
    """Build a single ``type="trees"`` Hazard from one observation tuple
    ``(carry_m, lateral_yards, hx, hy, lat, lon)`` — lat/lng/distance_from_green
    come from THIS observation (the min- or max-carry one), matching the
    bunker/water entries' per-point provenance."""
    _carry_m, _lateral_yards, hx, hy, lat, lon = obs
    distance_from_green = math.hypot(hx - gx, hy - gy) * _YARDS_PER_METER
    return Hazard(
        type="trees",
        side=side,
        distance_from_green=round(distance_from_green),
        penalty_severity=_SEVERITY_BY_TYPE.get("trees", "moderate"),
        lat=lat,
        lng=lon,
        carry_yards=carry_yards,
        line_side=side,
    )


def _gap_bounded_tree_chain(
    side_obs: list[tuple[float, float, float, float, float, float]],
    max_gap_m: float,
) -> list[tuple[float, float, float, float, float, float]]:
    """Greedy gap-bounded chain over ``side_obs`` (a side's observations,
    already sorted ascending by ``carry_m`` — tuple index 0). ALWAYS includes
    the first (near) and last (far) observation.

    From the current chain tip, jump to the FARTHEST observation whose carry
    is within ``max_gap_m`` of the tip's carry (side_obs is sorted, so this
    is the last observation satisfying the condition before it fails —
    monotonic, so the scan can stop at the first failure). When no
    observation qualifies — a real mapped gap wider than ``max_gap_m`` —
    jump to the very next observation in sorted order instead: the gap is
    preserved, never interpolated. Repeats until the chain reaches the far
    endpoint (see module docstring "Trees/woods" paragraph and
    specs/caddie-hazard-side-reach-plan.md §3).
    """
    n = len(side_obs)
    far = side_obs[-1]
    chain = [side_obs[0]]
    idx = 0
    while chain[-1] is not far:
        current_carry_m = chain[-1][0]
        best_j: Optional[int] = None
        for j in range(idx + 1, n):
            if side_obs[j][0] <= current_carry_m + max_gap_m:
                best_j = j
            else:
                break
        if best_j is None:
            best_j = idx + 1  # real gap wider than max_gap_m — preserve it
        chain.append(side_obs[best_j])
        idx = best_j
    return chain


def _extract_tree_line_hazards(
    feature_list: list[dict],
    tee_lat: float,
    tee_lon: float,
    gx: float,
    gy: float,
    classify,
) -> list[Hazard]:
    """Aggregate tree/woods OBSERVATIONS into a gap-bounded chain of "tree
    line" entries per qualifying side (module docstring "Trees/woods"
    paragraph, Finding B fix — specs/caddie-hazard-side-reach-plan.md §3):

    1. Collect observations (``_tree_observations``), classify each through
       the SAME ``classify`` closure as bunkers/water.
    2. Drop observations behind the tee (``carry_m < 0``) and observations
       more than ``_TREE_MAX_LATERAL_YARDS`` off the line — this is what
       makes woods handling near-EDGE rather than centroid.
    3. Group survivors by ``line_side`` (same 10y deadband). A side QUALIFIES
       iff it has ``>= _TREE_MIN_OBS`` observations — the coverage guard.
    4. Spread ``< _TREE_RANGE_MIN_SPREAD_YARDS``: emit the near entry only.
       Otherwise emit ``_gap_bounded_tree_chain``'s chain of REAL
       observations (never just the min/max pair) — capped at
       ``_TREE_CHAIN_SAFETY_CAP`` per side; if exceeded, the gap is doubled
       and the chain rebuilt until it fits, so near/far always survive.

    Returns an UNSORTED, UNCAPPED-at-the-hole-level list — the caller
    (``extract_hole_hazards``) appends it after the bunker/water cap and
    re-sorts the combined list by carry_yards.
    """
    observations: list[tuple[float, float, float, float, float, float]] = []
    # (carry_m, lateral_yards, hx, hy, lat, lon)
    for lon, lat in _tree_observations(feature_list):
        hx, hy = _xy_m(tee_lat, tee_lon, lat, lon)
        carry_m, lateral_m = classify(hx, hy)
        if carry_m < 0:
            continue  # behind the tee — dropped, not clamped (module docstring)
        lateral_yards = lateral_m * _YARDS_PER_METER
        if abs(lateral_yards) > _TREE_MAX_LATERAL_YARDS:
            continue
        observations.append((carry_m, lateral_yards, hx, hy, lat, lon))

    if not observations:
        return []

    groups: dict[str, list[tuple[float, float, float, float, float, float]]] = {
        "left": [], "right": [], "center": [],
    }
    for obs in observations:
        lateral_yards = obs[1]
        if lateral_yards > _LATERAL_DEADBAND_YARDS:
            side = "left"
        elif lateral_yards < -_LATERAL_DEADBAND_YARDS:
            side = "right"
        else:
            side = "center"
        groups[side].append(obs)

    hazards: list[Hazard] = []
    for side in ("left", "right", "center"):
        side_obs = groups[side]
        if len(side_obs) < _TREE_MIN_OBS:
            continue
        side_obs.sort(key=lambda o: o[0])
        near, far = side_obs[0], side_obs[-1]
        near_carry_yards = max(0, _round_to_5(near[0] * _YARDS_PER_METER))
        far_carry_yards = max(0, _round_to_5(far[0] * _YARDS_PER_METER))

        if far_carry_yards - near_carry_yards < _TREE_RANGE_MIN_SPREAD_YARDS:
            chain = [near]
        else:
            gap_m = _TREE_SPAN_MAX_GAP_YDS / _YARDS_PER_METER
            chain = _gap_bounded_tree_chain(side_obs, gap_m)
            while len(chain) > _TREE_CHAIN_SAFETY_CAP:
                gap_m *= 2.0
                chain = _gap_bounded_tree_chain(side_obs, gap_m)

        for obs in chain:
            carry_yards = max(0, _round_to_5(obs[0] * _YARDS_PER_METER))
            hazards.append(_tree_hazard(side, obs, carry_yards, gx, gy))

    return hazards


def format_hazards_line(hole_number: int, hazards: list[Hazard]) -> str:
    """Compact spoken-style hazard line for a hole, e.g.:

        "Hole 4 hazards: bunker L 245y, water R 190-230y, trees R 220-300y"

    Hazards sharing a (type, line_side) are merged into a single entry — a
    single hazard renders as ``bunker L 245y``, multiple as a range
    ``bunker L 230-260y`` (a tree line's min/max-carry pair renders the same
    way, no dedicated tree formatter). Groups sort bunker-before-water-
    before-trees, nearer-first, and are capped at ``_FORMAT_GROUP_CAP`` (6) —
    type order sorts first, so bunker/water groups always occupy the front;
    a tree group can only fill trailing slots and can never displace a
    bunker/water group. Returns "" for an empty hazard list — the caller
    should omit the line entirely, which triggers the generic-language
    directive in HAZARD_GROUNDING_RULE.
    """
    if not hazards:
        return ""

    groups: dict[tuple[str, str], list[int]] = {}
    order: list[tuple[str, str]] = []
    for hz in hazards:
        key = (hz.type, hz.line_side)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(hz.carry_yards)

    order.sort(key=lambda k: (_TYPE_ORDER.get(k[0], 99), min(groups[k])))
    order = order[:_FORMAT_GROUP_CAP]

    parts: list[str] = []
    for ftype, side in order:
        yards = sorted(groups[(ftype, side)])
        abbrev = _SIDE_ABBREV.get(side, side[:1].upper())
        if len(yards) == 1:
            parts.append(f"{ftype} {abbrev} {yards[0]}y")
        else:
            parts.append(f"{ftype} {abbrev} {yards[0]}-{yards[-1]}y")

    return f"Hole {hole_number} hazards: " + ", ".join(parts)


# ── Corridor profile (specs/corridor-width-club-selection-plan.md §2) ──────
#
# Follow-up to the bend-cap (extract_hole_bend above). Samples perpendicular
# cross-sections along the hole's mapped centerline every 10y and records,
# per side, the fairway edge (color only, never the fit constraint — see the
# plan's Honesty section for the arithmetic proof) AND the danger edge
# (nearest trees/woods/water evidence — the fit-rule constraint consumed by
# aim_point.py's corridor-width club selection). Reuses this module's tee/
# green/polyline/projection primitives so a sample's along-path distance is
# measured from the SAME tee-anchored origin as hazard carry_yards and the
# bend distance.


def _water_observations(feature_list: list[dict]) -> list[tuple[float, float]]:
    """Return ``(lon, lat)`` OBSERVATION points for water features — the same
    ring-vertex-as-observation model as ``_tree_observations`` (module
    docstring "Trees/woods" paragraph), applied to ``featureType == "water"``
    polygons (plus Points, on the rare chance a water hazard is ever mapped
    as one). A water polygon's ring literally traces the pond/hazard edge, so
    a single in-window vertex is real evidence — unlike trees, no coverage
    guard is needed here (the caller uses min-obs 1)."""
    observations: list[tuple[float, float]] = []
    for f in feature_list:
        props = f.get("properties") or {}
        if props.get("featureType") != "water":
            continue
        geom = f.get("geometry") or {}
        gtype = geom.get("type")
        coords = geom.get("coordinates")
        if gtype == "Point" and coords and len(coords) >= 2:
            observations.append((float(coords[0]), float(coords[1])))
        elif gtype == "Polygon" and coords and coords[0]:
            ring = coords[0]
            vertices = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
            for c in vertices:
                if c and len(c) >= 2:
                    observations.append((float(c[0]), float(c[1])))
    return observations


def _point_in_ring_xy(px: float, py: float, ring_xy: list[tuple[float, float]]) -> bool:
    """Even-odd ray-cast point-in-polygon test in the local tee-anchored
    (east, north) metre frame — mirrors ``course_spatial._point_in_ring``'s
    algorithm exactly, re-derived here because that function works in
    lon/lat + cos_lat (a different frame) rather than local metres.
    ``ring_xy`` must already have its closing vertex deduped."""
    n = len(ring_xy)
    if n < 3:
        return False
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = ring_xy[i]
        xj, yj = ring_xy[j]
        if (yi > py) != (yj > py):
            x_intersect = (xj - xi) * (py - yi) / (yj - yi) + xi
            if px < x_intersect:
                inside = not inside
        j = i
    return inside


def _ray_segment_distance(
    px: float, py: float, nx: float, ny: float, ax: float, ay: float, bx: float, by: float,
) -> Optional[float]:
    """Distance ``t`` (>0) along the ray ``p + t*(nx, ny)`` to its intersection
    with segment ``a->b``, or ``None`` when the ray and segment are parallel
    or the intersection falls outside the ray's forward half or the segment's
    span (``0 <= s < 1``). Solved via Cramer's rule on
    ``p + t*n = a + s*(b-a)``."""
    dx, dy = bx - ax, by - ay
    det = dx * ny - dy * nx
    if abs(det) < 1e-9:
        return None
    rx, ry = ax - px, ay - py
    t = (dx * ry - dy * rx) / det
    s = (nx * ry - ny * rx) / det
    if t > 0.0 and 0.0 <= s < 1.0:
        return t
    return None


def _cast_ray_to_ring(
    px: float, py: float, nx: float, ny: float,
    ring_xy: list[tuple[float, float]], max_t_m: float,
) -> Optional[float]:
    """Nearest intersection distance (metres, capped at ``max_t_m``) of the
    ray ``p + t*(nx, ny)``, ``t > 0``, against every (closed, wrap-around)
    edge of ``ring_xy``. ``None`` when no edge is hit within the cap."""
    n_verts = len(ring_xy)
    best_t: Optional[float] = None
    for i in range(n_verts):
        ax, ay = ring_xy[i]
        bx, by = ring_xy[(i + 1) % n_verts]
        t = _ray_segment_distance(px, py, nx, ny, ax, ay, bx, by)
        if t is not None and t <= max_t_m and (best_t is None or t < best_t):
            best_t = t
    return best_t


def _cumulative_lengths(path_xy: list[tuple[float, float]]) -> list[float]:
    """Cumulative along-path distance (metres) from ``path_xy[0]`` to each
    vertex — ``cum[i]`` is the arc length to reach ``path_xy[i]``."""
    cum = [0.0]
    for i in range(len(path_xy) - 1):
        ax, ay = path_xy[i]
        bx, by = path_xy[i + 1]
        cum.append(cum[-1] + math.hypot(bx - ax, by - ay))
    return cum


def _sample_point_and_heading(
    path_xy: list[tuple[float, float]], cum_m: list[float], s_m: float,
) -> Optional[tuple[float, float, float, float]]:
    """Point + local unit heading at arc length ``s_m`` from ``path_xy[0]``.

    Walks the path's OWN cumulative arc length (not a nearest-segment
    projection) so a sample past a dogleg corner lands on — and takes its
    heading from — the SECOND leg, never the tee->green chord (the module's
    documented sign/frame exposure — see the docstring and
    test_corridor_profile.py's dogleg case). Zero-length segments are
    skipped. Returns ``(px, py, ux, uy)``, or ``None`` when every segment is
    degenerate.
    """
    last_valid: Optional[tuple[int, float, float, float, float, float]] = None
    for i in range(len(path_xy) - 1):
        ax, ay = path_xy[i]
        bx, by = path_xy[i + 1]
        seg_len = cum_m[i + 1] - cum_m[i]
        if seg_len <= 0.0:
            continue
        last_valid = (i, ax, ay, bx, by, seg_len)
        if cum_m[i] <= s_m <= cum_m[i + 1]:
            t = (s_m - cum_m[i]) / seg_len
            px, py = ax + t * (bx - ax), ay + t * (by - ay)
            ux, uy = (bx - ax) / seg_len, (by - ay) / seg_len
            return px, py, ux, uy
    if last_valid is None:
        return None
    # s_m fell outside every segment's own span (e.g. rounding at the very
    # end of the path) — extrapolate on the last non-degenerate segment.
    i, ax, ay, bx, by, seg_len = last_valid
    t = (s_m - cum_m[i]) / seg_len
    px, py = ax + t * (bx - ax), ay + t * (by - ay)
    ux, uy = (bx - ax) / seg_len, (by - ay) / seg_len
    return px, py, ux, uy


def _classify_danger_observations(
    obs_lonlat: list[tuple[float, float]],
    tee_lat: float,
    tee_lon: float,
    path_xy: list[tuple[float, float]],
    tee_along_m: float,
) -> list[tuple[float, float]]:
    """Project raw ``(lon, lat)`` observation points into ``(carry_yds,
    lateral_yds)`` against the corridor's own polyline — same discipline as
    ``_extract_tree_line_hazards``'s tree pass: behind-tee observations are
    DROPPED (not clamped), and observations more than
    ``_TREE_MAX_LATERAL_YARDS`` off the line are dropped (keeps only the edge
    FACING the played line)."""
    out: list[tuple[float, float]] = []
    for lon, lat in obs_lonlat:
        hx, hy = _xy_m(tee_lat, tee_lon, lat, lon)
        projected = _project_onto_polyline(path_xy, hx, hy)
        if projected is None:
            continue
        carry_m, lateral_m = projected[0] - tee_along_m, projected[1]
        if carry_m < 0:
            continue
        lateral_yds = lateral_m * _YARDS_PER_METER
        if abs(lateral_yds) > _TREE_MAX_LATERAL_YARDS:
            continue
        out.append((carry_m * _YARDS_PER_METER, lateral_yds))
    return out


def _side_edge_at(
    obs: list[tuple[float, float]], d: float, min_obs: int,
) -> tuple[Optional[float], Optional[float]]:
    """``(left_edge, right_edge)`` at along-path distance ``d`` from a
    classified observation list: filter to the ``±_CORRIDOR_EVIDENCE_WINDOW_
    YDS`` window, group by RAW lateral sign (``lateral == 0`` counts toward
    BOTH sides — no 10y deadband; the deadband is a speech de-jitter, not
    geometry), and require ``>= min_obs`` qualifying observations on a side
    before it's known. Edge value = min |lateral| in the qualifying window."""
    left_vals = [
        abs(lat) for carry, lat in obs
        if abs(carry - d) <= _CORRIDOR_EVIDENCE_WINDOW_YDS and lat >= 0
    ]
    right_vals = [
        abs(lat) for carry, lat in obs
        if abs(carry - d) <= _CORRIDOR_EVIDENCE_WINDOW_YDS and lat <= 0
    ]
    left = min(left_vals) if len(left_vals) >= min_obs else None
    right = min(right_vals) if len(right_vals) >= min_obs else None
    return left, right


def _combine_edge(
    tree_val: Optional[float], water_val: Optional[float],
) -> tuple[Optional[float], Optional[str]]:
    """Winning danger edge + its source (``"trees"`` | ``"water"``) — the
    nearer (smaller) of the two when both exist, ``None`` when neither."""
    candidates: list[tuple[float, str]] = []
    if tree_val is not None:
        candidates.append((tree_val, "trees"))
    if water_val is not None:
        candidates.append((water_val, "water"))
    if not candidates:
        return None, None
    value, source = min(candidates, key=lambda c: c[0])
    return value, source


def extract_corridor_profile(
    features: Optional[dict],
    *,
    tee: Optional[dict] = None,
    green: Optional[dict] = None,
    polyline: Optional[list] = None,
) -> Optional[list[CorridorSample]]:
    """Sample the playing corridor's width every 10y along the hole's mapped
    centerline, from 60y to 360y (or the mapped path's own length, whichever
    is shorter) — specs/corridor-width-club-selection-plan.md §2.

    Frame setup mirrors ``extract_hole_bend`` exactly: same tee/green
    derivation, same tee-anchored local metre frame. UNLIKE
    ``extract_hole_hazards``, there is NO chord fallback — a chord has no
    bends and no local headings, so a corridor computed from one would be
    fabricated geometry. No usable polyline (explicit ``polyline=`` arg or a
    ``featureType == "hole"`` LineString) -> ``None``, honest unknown.

    Each sample records the fairway edge (color; NEVER the fit constraint —
    see the plan's Honesty section for the arithmetic proof that a fairway-
    edge rule would cap a 15-handicap driver to an 8-iron on nearly every
    tee) and the danger edge (nearest tree/woods/water evidence — the actual
    fit-rule constraint aim_point.py's corridor-width selection consumes).

    All-or-nothing gate: returns ``None`` unless at least one sample has
    ``width_yards`` (both sides' danger edge) known — a fairway-only profile
    (no danger evidence anywhere) cannot constrain the fit rule, so it is
    treated as absent, keeping "profile present <=> the decision may differ"
    crisp. Within a RETURNED profile, per-distance ``None`` samples are the
    honest partial-knowledge representation.
    """
    feature_list: list[dict] = (features or {}).get("features") or []

    tee_pt, green_pt = _derive_tee_green(feature_list, tee, green)
    if tee_pt is None or green_pt is None:
        return None

    tee_lon, tee_lat = tee_pt

    path = None
    if polyline and len(polyline) >= 2:
        path = [(float(c[0]), float(c[1])) for c in polyline]
    if path is None:
        path = _hole_polyline(feature_list)
    if path is None:
        # No mapped centerline -> no bends, no local headings -> never a
        # fabricated chord-frame corridor (unlike extract_hole_hazards).
        return None

    path_xy = [_xy_m(tee_lat, tee_lon, lat, lon) for lon, lat in path]
    tee_projected = _project_onto_polyline(path_xy, 0.0, 0.0)
    if tee_projected is None:
        return None  # degenerate polyline (all zero-length segments)
    tee_along_m = tee_projected[0]

    cum_m = _cumulative_lengths(path_xy)
    total_len_m = cum_m[-1]
    path_len_from_tee_yds = (total_len_m - tee_along_m) * _YARDS_PER_METER

    max_d = min(path_len_from_tee_yds, float(_CORRIDOR_SAMPLE_MAX_YDS))
    if max_d < _CORRIDOR_SAMPLE_START_YDS:
        return None  # hole too short to sample even one point

    # Fairway rings, projected into the tee-local frame — Polygon -> its
    # single outer ring; MultiPolygon -> each member's outer ring treated as
    # an independent polygon (a split fairway's gap naturally yields "not
    # inside any").
    fairway_rings: list[list[tuple[float, float]]] = []
    for f in feature_list:
        props = f.get("properties") or {}
        if props.get("featureType") != "fairway":
            continue
        geom = f.get("geometry") or {}
        gtype = geom.get("type")
        coords = geom.get("coordinates")
        rings_lonlat: list[list] = []
        if gtype == "Polygon" and coords and coords[0]:
            rings_lonlat.append(coords[0])
        elif gtype == "MultiPolygon" and coords:
            for member in coords:
                if member and member[0]:
                    rings_lonlat.append(member[0])
        for ring in rings_lonlat:
            verts = ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring
            ring_xy = [
                _xy_m(tee_lat, tee_lon, float(c[1]), float(c[0]))
                for c in verts if c and len(c) >= 2
            ]
            if len(ring_xy) >= 3:
                fairway_rings.append(ring_xy)

    tree_obs = _classify_danger_observations(
        _tree_observations(feature_list), tee_lat, tee_lon, path_xy, tee_along_m,
    )
    water_obs = _classify_danger_observations(
        _water_observations(feature_list), tee_lat, tee_lon, path_xy, tee_along_m,
    )

    max_cast_m = _CORRIDOR_MAX_CAST_YDS / _YARDS_PER_METER

    samples: list[CorridorSample] = []
    any_width_known = False
    d = _CORRIDOR_SAMPLE_START_YDS
    while d <= max_d:
        s_m = tee_along_m + d / _YARDS_PER_METER
        pt = _sample_point_and_heading(path_xy, cum_m, s_m)
        if pt is None:
            d += _CORRIDOR_SAMPLE_STEP_YDS
            continue
        px, py, ux, uy = pt
        nx, ny = -uy, ux  # LEFT normal (module-pinned convention)

        left_fairway: Optional[int] = None
        right_fairway: Optional[int] = None
        for ring_xy in fairway_rings:
            if _point_in_ring_xy(px, py, ring_xy):
                t_left = _cast_ray_to_ring(px, py, nx, ny, ring_xy, max_cast_m)
                t_right = _cast_ray_to_ring(px, py, -nx, -ny, ring_xy, max_cast_m)
                left_fairway = round(t_left * _YARDS_PER_METER) if t_left is not None else None
                right_fairway = round(t_right * _YARDS_PER_METER) if t_right is not None else None
                break

        tree_left, tree_right = _side_edge_at(tree_obs, float(d), _TREE_MIN_OBS)
        water_left, water_right = _side_edge_at(water_obs, float(d), _CORRIDOR_WATER_MIN_OBS)
        left_danger, left_source = _combine_edge(tree_left, water_left)
        right_danger, right_source = _combine_edge(tree_right, water_right)

        left_yards = round(left_danger) if left_danger is not None else None
        right_yards = round(right_danger) if right_danger is not None else None
        width_yards = (
            round(left_danger + right_danger)
            if left_danger is not None and right_danger is not None
            else None
        )
        if width_yards is not None:
            any_width_known = True

        samples.append(CorridorSample(
            distance_yards=d,
            left_yards=left_yards,
            right_yards=right_yards,
            width_yards=width_yards,
            left_fairway_yards=left_fairway,
            right_fairway_yards=right_fairway,
            left_source=left_source,
            right_source=right_source,
        ))
        d += _CORRIDOR_SAMPLE_STEP_YDS

    if not any_width_known:
        return None
    return samples


def corridor_sample_at(
    corridor: Optional[list[CorridorSample]], d: float,
) -> Optional[CorridorSample]:
    """Nearest ``CorridorSample`` to along-path distance ``d`` (yards), or
    ``None`` when ``corridor`` is empty/absent or the nearest sample is more
    than 5y away (``d`` outside the sampled range). No interpolation — the
    ±20y evidence window already smooths."""
    if not corridor:
        return None
    nearest = min(corridor, key=lambda s: abs(s.distance_yards - d))
    if abs(nearest.distance_yards - d) > 5:
        return None
    return nearest
