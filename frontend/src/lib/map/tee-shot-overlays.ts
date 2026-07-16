/**
 * tee-shot-overlays — yardage-book plates (200/150/100) + fairway bunker
 * carries for the in-round satellite hole map, TEE-SHOT CONTEXT ONLY.
 *
 * Pure module: no React, no DOM, no @capacitor/google-maps import. Consumes
 * a hole's stored GeoJSON FeatureCollection (already client-side — see
 * specs/tee-shot-yardage-overlays-plan.md §1) and produces plate positions +
 * bunker carry numbers. Honest by construction: missing/degenerate geometry
 * silently omits a plate/bunker rather than fabricating a number — this repo
 * has been burned twice by invented/mirrored hazard geometry (see
 * backend/app/caddie/hazards.py's module docstring for the incident history);
 * this module follows the exact same math conventions so the two surfaces
 * never disagree.
 *
 * Math convention (pinned, matches backend/app/caddie/hazards.py):
 *   - Point-to-point distance (`metersBetween`): standard Haversine, UNROUNDED
 *     — same formula as `haversineYards` (google-map-helpers.ts:112) but
 *     without the final Math.round/yard conversion. Summing ROUNDED segment
 *     lengths over a 20-vertex centerline can accrue up to +/-10y of error;
 *     this module walks the centerline with float meters and rounds ONCE at
 *     the very end (see `distanceMarkersFromGreen`).
 *   - Tee-anchored projection frame (`fairwayBunkerCarries`): local
 *     equirectangular meters, origin at the tee — x = (lng-teeLng)*LAT_M*
 *     cos(midLat), y = (lat-teeLat)*LAT_M, LAT_M = 111_320,
 *     midLat = (tee.lat + green.lat)/2 — matching backend `_xy_m` /
 *     hole-projection.ts's `toMeters`. Carry = cumulative along-path
 *     projection onto the hole centerline when present (TS port of backend
 *     `_project_onto_polyline`), else chord `dot(v, u)`. Rounded to the
 *     nearest 5 (`round5`), matching backend `_round_to_5`.
 *
 * Do NOT use `hd.front`/`hd.back` anywhere in this module — they are
 * synthesized +/-15y offsets on tokenless installs (course-coordinates.ts).
 * Plates measure from `hd.green` (center, always real).
 */

// ── Public types ──────────────────────────────────────────────────────────────

export interface LatLng {
  lat: number;
  lng: number;
}

export interface DistanceMarker {
  yards: 100 | 150 | 200;
  /** At the plate's distance station — laterally centered in the fairway
   *  when fairway geometry allows it, else the interpolated point ON the
   *  hole centerline. */
  position: LatLng;
}

export interface BunkerCarry {
  /** Yards from the selected tee to the nearest bunker edge, rounded to 5. */
  front: number;
  /** Yards from the selected tee to the farthest bunker edge, rounded to 5. */
  back: number;
  /** |lateral| <= 10y deadband -> 'C' (matches backend deadband). */
  side: 'L' | 'R' | 'C';
  /** Ring vertex with min carry — anchor for the native dot. */
  nearEdge: LatLng;
  /** Legend key: 'A' for the smallest front carry, then 'B', 'C'… in the
   *  final ascending-front display order. '' when index exceeds the bundled
   *  asset range A-F (unreachable today: BUNKER_CAP = 4) — renders as the
   *  plain bean marker and a coin-less chip. */
  letter: string;
}

export interface TeeShotOverlays {
  /** 0-3 plates. */
  markers: DistanceMarker[];
  /** 0-4 chips, sorted ascending by front carry. */
  bunkers: BunkerCarry[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Metres per degree of latitude (WGS-84 mean) — matches backend's
 *  `_LAT_M_PER_DEG` / hole-projection.ts's `LAT_M`. */
const LAT_M = 111_320;

/** Exact conversion factor: metres per yard (international yard, 1959) —
 *  matches google-map-helpers.ts's `METRES_PER_YARD`. Kept local so this
 *  module stays import-free. */
const METRES_PER_YARD = 0.9144;

const GREEN_END_MAX_YARDS = 60;
const LATERAL_DEADBAND_YARDS = 10;
const BUNKER_FLOOR_YARDS = 100;
const BUNKER_CEILING_YARDS = 330;
const GREENSIDE_MIN_YARDS = 45;
const CORRIDOR_MAX_LATERAL_YARDS = 45;
const BUNKER_CAP = 4;
const TEE_ZONE_RADIUS_YARDS = 40;
/** Mechanical honesty guard for plate placement (see
 *  `greenEndLateralOffsetMeters` / `distanceMarkersFromGreen`): ALL plates
 *  for a hole are OMITTED, not shown, when the way's green-end is more than
 *  this many yards off the line collinear with green center — tight enough
 *  to catch a laterally-offset way-end (still inside the 60y
 *  GREEN_END_MAX_YARDS guard) that would otherwise silently mislabel, loose
 *  enough to tolerate normal centerline curvature. */
const PLATE_HONESTY_TOLERANCE_YARDS = 7;

/** Perpendicular cast cap, each side — mirrors backend _CORRIDOR_MAX_CAST_YDS
 *  (hazards.py:128). Bounds work and degenerate-geometry runaway. */
const FAIRWAY_CAST_CAP_YARDS = 100;
/** Max gap between a plate's centerline station and the nearest fairway
 *  cross-section span before we refuse to re-center (honesty guard: a
 *  centerline >20y off the mapped fairway is suspect data — leave the plate
 *  where the honest centerline math put it). */
const FAIRWAY_SNAP_MAX_GAP_YARDS = 20;

// ── Internals (exported for tests) ─────────────────────────────────────────────

/**
 * UNROUNDED haversine distance in metres. CRITICAL: `yardsDistance`
 * (hole-projection.ts:382) and `haversineYards` (google-map-helpers.ts:112)
 * both Math.round — summing rounded segment lengths over a many-vertex
 * centerline accrues real error. This module walks with float meters and
 * rounds ONCE at the end.
 */
export function metersBetween(a: LatLng, b: LatLng): number {
  const R_M = 6_371_000; // Earth mean radius in metres
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * R_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function round5(yards: number): number {
  return Math.round(yards / 5) * 5;
}

/** True Feature[] geometry-type narrowing helper (loose GeoJSON typing). */
function featureType(f: GeoJSON.Feature): unknown {
  return (f.properties ?? {})['featureType'];
}

/**
 * Outer rings of every featureType==="fairway" Polygon/MultiPolygon —
 * mirrors backend `extract_corridor_profile`'s ring collection
 * (hazards.py:1056-1082): Polygon -> coordinates[0]; MultiPolygon -> each
 * member's outer ring as an independent polygon; closing vertex deduped;
 * rings with <3 vertices dropped.
 */
export function fairwayRingsFromFeatures(features: GeoJSON.Feature[]): LatLng[][] {
  const rings: LatLng[][] = [];

  for (const f of features) {
    if (featureType(f) !== 'fairway') continue;
    const geom = f.geometry;
    if (!geom) continue;

    const ringsLngLat: GeoJSON.Position[][] = [];
    if (geom.type === 'Polygon') {
      const coords = (geom as GeoJSON.Polygon).coordinates;
      if (coords && coords[0]) ringsLngLat.push(coords[0]);
    } else if (geom.type === 'MultiPolygon') {
      const coords = (geom as GeoJSON.MultiPolygon).coordinates;
      for (const member of coords ?? []) {
        if (member && member[0]) ringsLngLat.push(member[0]);
      }
    } else {
      continue;
    }

    for (const ring of ringsLngLat) {
      if (!ring || ring.length === 0) continue;
      const isClosed =
        ring.length > 1 &&
        ring[0][0] === ring[ring.length - 1][0] &&
        ring[0][1] === ring[ring.length - 1][1];
      const verts = isClosed ? ring.slice(0, -1) : ring;
      if (verts.length < 3) continue; // not a real polygon shape
      rings.push(verts.map(([lng, lat]) => ({ lat, lng })));
    }
  }

  return rings;
}

/**
 * Even-odd point-in-ring test on LatLng, evaluated in a local
 * equirectangular frame anchored at p (cosLat = cos(p.lat)) — TS port of
 * backend `_point_in_ring_xy` (hazards.py:816). Exported for tests and used
 * as the final "midpoint inside fairway" guard.
 */
export function latLngInRing(p: LatLng, ring: ReadonlyArray<LatLng>): boolean {
  const n = ring.length;
  if (n < 3) return false;

  const cosLat = Math.cos((p.lat * Math.PI) / 180);
  const toXY = (q: LatLng): [number, number] => [
    (q.lng - p.lng) * LAT_M * cosLat,
    (q.lat - p.lat) * LAT_M,
  ];

  let inside = false;
  let j = n - 1;
  for (let i = 0; i < n; i++) {
    const [xi, yi] = toXY(ring[i]);
    const [xj, yj] = toXY(ring[j]);
    if (yi > 0 !== yj > 0) {
      const xIntersect = ((xj - xi) * (0 - yi)) / (yj - yi) + xi;
      if (0 < xIntersect) inside = !inside;
    }
    j = i;
  }
  return inside;
}

/**
 * Lateral fairway midpoint on the perpendicular cross-section through
 * `station`, or null (caller falls back to `station`). segA->segB is the
 * centerline segment the station lies on — its direction is the LOCAL hole
 * heading (dogleg-correct, never a tee->green chord).
 */
export function fairwayCenterAtStation(
  station: LatLng,
  segA: LatLng,
  segB: LatLng,
  fairways: ReadonlyArray<ReadonlyArray<LatLng>>,
): LatLng | null {
  if (!fairways || fairways.length === 0) return null;

  const P = station;
  const cosLat = Math.cos((P.lat * Math.PI) / 180);
  const toXY = (q: LatLng): [number, number] => [
    (q.lng - P.lng) * LAT_M * cosLat,
    (q.lat - P.lat) * LAT_M,
  ];

  const [ax, ay] = toXY(segA);
  const [bx, by] = toXY(segB);
  const dx = bx - ax;
  const dy = by - ay;
  const L = Math.hypot(dx, dy);
  if (L <= 0) return null; // degenerate segment at the station

  const ux = dx / L;
  const uy = dy / L; // local hole heading (sign irrelevant: a line, not a ray)
  const nx = -uy;
  const ny = ux; // left-perpendicular (module-pinned convention, hazards.py:1105)

  const maxCastM = FAIRWAY_CAST_CAP_YARDS * METRES_PER_YARD;
  const maxGapM = FAIRWAY_SNAP_MAX_GAP_YARDS * METRES_PER_YARD;

  interface Span {
    tLo: number;
    tHi: number;
    ringIdx: number;
  }

  let containingSpan: Span | null = null;
  let bestGapSpan: Span | null = null;
  let bestGap = Infinity;

  for (let ringIdx = 0; ringIdx < fairways.length; ringIdx++) {
    const ring = fairways[ringIdx];
    const nVerts = ring.length;
    if (nVerts < 3) continue;
    const ringXY = ring.map(toXY);

    // Line-edge intersection (two-sided version of backend
    // `_ray_segment_distance`, hazards.py:838; Cramer's rule on
    // `P + t*n = a + s*(b-a)` with P at the origin), closed wrap-around.
    const ts: number[] = [];
    for (let i = 0; i < nVerts; i++) {
      const [ex0, ey0] = ringXY[i];
      const [ex1, ey1] = ringXY[(i + 1) % nVerts];
      const ex = ex1 - ex0;
      const ey = ey1 - ey0;
      const det = ex * ny - ey * nx;
      if (Math.abs(det) < 1e-9) continue; // parallel — skip
      const t = (ex * ey0 - ey * ex0) / det;
      const s = (nx * ey0 - ny * ex0) / det;
      // Half-open 0 <= s < 1 prevents double-counting shared vertices.
      if (s >= 0 && s < 1 && Math.abs(t) <= maxCastM) ts.push(t);
    }

    if (ts.length === 0) continue;
    if (ts.length % 2 !== 0) continue; // odd crossing count (tangency) — skip this ring

    ts.sort((a, b) => a - b);
    for (let i = 0; i + 1 < ts.length; i += 2) {
      const tLo = ts[i];
      const tHi = ts[i + 1];
      if (tLo <= 0 && 0 <= tHi) {
        // Station is INSIDE this fairway ring on this cross-section — wins
        // outright. First ring in array order wins over any other span.
        if (containingSpan === null) containingSpan = { tLo, tHi, ringIdx };
      } else {
        const gap = tLo > 0 ? tLo : -tHi;
        if (gap < bestGap) {
          bestGap = gap;
          bestGapSpan = { tLo, tHi, ringIdx };
        }
      }
    }

    if (containingSpan) break; // first-in-array-order containing ring wins
  }

  const selected =
    containingSpan ?? (bestGapSpan && bestGap <= maxGapM ? bestGapSpan : null);
  if (selected === null) return null;

  const m = (selected.tLo + selected.tHi) / 2;
  const Q: LatLng = {
    lat: P.lat + (m * ny) / LAT_M,
    lng: P.lng + (m * nx) / (LAT_M * cosLat),
  };

  // Final guard: numerical-edge insurance and the spec's explicit "never
  // outside the fairway" promise.
  if (!latLngInRing(Q, fairways[selected.ringIdx])) return null;

  return Q;
}

/**
 * Find the featureType==="hole" LineString (>=2 vertices; first match, like
 * backend `_hole_polyline`) and return it GREEN-FIRST: the endpoint nearer to
 * `greenCenter` becomes index 0. HONESTY GUARD: if the nearer endpoint is
 * > 60y from `greenCenter` the way is suspect (mis-tagged / wrong hole) ->
 * null.
 */
export function greenFirstCenterline(
  features: GeoJSON.Feature[],
  greenCenter: LatLng,
): LatLng[] | null {
  for (const f of features) {
    if (featureType(f) !== 'hole') continue;
    const geom = f.geometry;
    if (!geom || geom.type !== 'LineString') continue;
    const coords = (geom as GeoJSON.LineString).coordinates;
    if (!coords || coords.length < 2) continue;

    const line: LatLng[] = coords.map(([lng, lat]) => ({ lat, lng }));
    const first = line[0];
    const last = line[line.length - 1];
    const distFirst = metersBetween(first, greenCenter);
    const distLast = metersBetween(last, greenCenter);
    const nearerIsFirst = distFirst <= distLast;
    const orientedGreenFirst = nearerIsFirst ? line : [...line].reverse();

    const nearEnd = orientedGreenFirst[0];
    const nearDistYards = metersBetween(nearEnd, greenCenter) / METRES_PER_YARD;
    if (nearDistYards > GREEN_END_MAX_YARDS) return null;

    return orientedGreenFirst;
  }
  return null;
}

/**
 * Mechanical honesty guard for the green-center offset (see
 * `distanceMarkersFromGreen`): that offset is a scalar subtraction which
 * assumes the way's green-end (`centerline[0]`) is COLLINEAR with green
 * center — i.e. that green center lies on the line the path's first segment
 * travels, not off to the side of it. Checked once per hole (not per plate,
 * unlike a straight-line-to-label check on the final position, which would
 * also flag legitimate dogleg walking — see test 2, where a bend further
 * down a centerline whose green-end genuinely IS at green center is
 * correct, expected divergence from the straight-line chord). Returns the
 * perpendicular (lateral) distance in meters from `greenCenter` to the
 * infinite line through `centerline[0]`->`centerline[1]`.
 */
function greenEndLateralOffsetMeters(centerline: LatLng[], greenCenter: LatLng): number {
  const a = centerline[0];
  const b = centerline[1];
  const midLat = (a.lat + b.lat) / 2;
  const cosLat = Math.cos((midLat * Math.PI) / 180);
  const toXY = (p: LatLng): [number, number] => [
    (p.lng - a.lng) * LAT_M * cosLat,
    (p.lat - a.lat) * LAT_M,
  ];
  const [bx, by] = toXY(b);
  const [gx, gy] = toXY(greenCenter);
  const segLen = Math.hypot(bx, by);
  if (segLen <= 0) return 0; // degenerate first segment — can't judge, don't block
  return Math.abs(bx * gy - by * gx) / segLen;
}

/**
 * Walk the centerline from the green end, cumulative float meters; linear
 * lat/lng interpolation inside the segment containing each target distance.
 * A target beyond total path length is OMITTED (a 160y-line hole has no 200
 * plate). Distances measured from GREEN CENTER: the walk starts with an
 * offset = metersBetween(greenCenter, line[0]) so plates are true
 * to-green-CENTER numbers even though the way ends at the green edge/pin.
 *
 * Honesty guard (mechanical, R1): if `greenCenter` isn't collinear with the
 * way's green-end within `PLATE_HONESTY_TOLERANCE_YARDS`, the offset
 * subtraction below is untrustworthy for every target that shares it — omit
 * ALL plates for this hole rather than silently mislabel one.
 */
export function distanceMarkersFromGreen(
  centerline: LatLng[],
  greenCenter: LatLng,
  distancesYds: readonly number[] = [100, 150, 200],
  fairways?: ReadonlyArray<ReadonlyArray<LatLng>>,
): DistanceMarker[] {
  if (!centerline || centerline.length < 2) return [];

  const lateralOffsetYards = greenEndLateralOffsetMeters(centerline, greenCenter) / METRES_PER_YARD;
  if (lateralOffsetYards > PLATE_HONESTY_TOLERANCE_YARDS) return [];

  const offsetM = metersBetween(greenCenter, centerline[0]);
  const markers: DistanceMarker[] = [];

  for (const targetYd of distancesYds) {
    const targetM = targetYd * METRES_PER_YARD - offsetM;
    if (targetM <= 0) continue; // way starts past this target — omit

    let cum = 0;
    for (let i = 0; i < centerline.length - 1; i++) {
      const a = centerline[i];
      const b = centerline[i + 1];
      const segLen = metersBetween(a, b);
      if (segLen <= 0) continue; // degenerate (duplicate) vertex — skip

      if (cum + segLen >= targetM) {
        const t = (targetM - cum) / segLen;
        const position = {
          lat: a.lat + t * (b.lat - a.lat),
          lng: a.lng + t * (b.lng - a.lng),
        };
        const centered =
          fairways && fairways.length > 0
            ? fairwayCenterAtStation(position, a, b, fairways)
            : null;
        markers.push({
          yards: targetYd as 100 | 150 | 200,
          position: centered ?? position,
        });
        break;
      }
      cum += segLen;
    }
    // Falls through without pushing when the target is beyond total path
    // length — honest omission, no fabricated point.
  }

  return markers;
}

/**
 * TS port of backend `_project_onto_polyline` (hazards.py:253). Projects
 * point (hx, hy) onto its nearest polyline segment in a local XY frame.
 * Returns cumulative along-path carry + signed perpendicular lateral
 * (positive = LEFT of that segment's travel direction), or null when the
 * path has no non-degenerate segment.
 */
function projectOntoPolyline(
  pathXY: ReadonlyArray<readonly [number, number]>,
  hx: number,
  hy: number,
): { carryM: number; lateralM: number } | null {
  let best: { distSq: number; carry: number; lateral: number } | null = null;
  let cum = 0;
  const lastSeg = pathXY.length - 2;

  for (let i = 0; i < pathXY.length - 1; i++) {
    const [ax, ay] = pathXY[i];
    const [bx, by] = pathXY[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const segLen = Math.hypot(dx, dy);
    if (segLen === 0) continue;

    let t = ((hx - ax) * dx + (hy - ay) * dy) / (segLen * segLen);
    if (i > 0) t = Math.max(0, t);
    if (i < lastSeg) t = Math.min(1, t);

    const px = ax + t * dx;
    const py = ay + t * dy;
    const distSq = (hx - px) ** 2 + (hy - py) ** 2;
    const ux = dx / segLen;
    const uy = dy / segLen;
    const lateral = ux * (hy - ay) - uy * (hx - ax); // positive = LEFT

    if (best === null || distSq < best.distSq) {
      best = { distSq, carry: cum + t * segLen, lateral };
    }
    cum += segLen;
  }

  if (best === null) return null;
  return { carryM: best.carry, lateralM: best.lateral };
}

/**
 * Per-bunker carry + fairway classification. See specs/tee-shot-yardage-
 * overlays-plan.md §4 for the predicate table.
 */
export function fairwayBunkerCarries(args: {
  features: GeoJSON.Feature[];
  tee: LatLng;
  green: LatLng;
  /** Cap on how many bunkers to keep, e.g. a tighter inline-card display cap.
   *  Defaults to `BUNKER_CAP` (4, fullscreen). Applied at SELECTION time, so
   *  a lower cap still keeps the "smallest lateral" bunkers — the same
   *  most-in-play semantics as the default cap, just fewer of them. */
  maxBunkers?: number;
}): BunkerCarry[] {
  const { features, tee, green, maxBunkers = BUNKER_CAP } = args;

  // Tee-anchored equirectangular frame (pinned, matches backend `_xy_m`).
  const midLat = (tee.lat + green.lat) / 2;
  const cosLat = Math.cos((midLat * Math.PI) / 180);
  const toXY = (p: LatLng): [number, number] => [
    (p.lng - tee.lng) * LAT_M * cosLat,
    (p.lat - tee.lat) * LAT_M,
  ];

  // Centerline (if present) in the same tee-anchored XY frame; carry is
  // relative to the TEE's own projection onto the path (mirrors backend's
  // `tee_along_m` so polyline and chord carries agree on straight holes).
  // `greenFirstCenterline` orients GREEN-first (needed for plate placement)
  // — reverse back to TEE-first here so cumulative along-path distance grows
  // AWAY from the tee (toward the green), matching what "carry" means.
  // Reusing the green-first order directly would invert every carry number
  // (cumulative distance FROM the green, not from the tee) — caught by
  // tests 6/8/9/10/11 all returning empty during development.
  const centerline = greenFirstCenterline(features, green);
  let pathXY: Array<[number, number]> | null = null;
  let teeAlongM = 0;
  if (centerline) {
    const candidate = [...centerline].reverse().map(toXY);
    const teeProjected = projectOntoPolyline(candidate, 0, 0);
    if (teeProjected) {
      pathXY = candidate;
      teeAlongM = teeProjected.carryM;
    }
  }

  // Chord fallback: unit vector tee->green in the same frame.
  const [greenX, greenY] = toXY(green);
  const chordLen = Math.hypot(greenX, greenY);
  const hasChord = chordLen > 1e-6;
  const ux = hasChord ? greenX / chordLen : 0;
  const uy = hasChord ? greenY / chordLen : 0;

  const classify = (hx: number, hy: number): { carryM: number; lateralM: number } => {
    if (pathXY) {
      const projected = projectOntoPolyline(pathXY, hx, hy);
      if (projected) {
        return { carryM: projected.carryM - teeAlongM, lateralM: projected.lateralM };
      }
    }
    return { carryM: ux * hx + uy * hy, lateralM: ux * hy - uy * hx };
  };

  interface Candidate {
    front: number;
    back: number;
    side: 'L' | 'R' | 'C';
    nearEdge: LatLng;
    minAbsLateralYards: number;
  }
  const candidates: Candidate[] = [];

  for (const f of features) {
    if (featureType(f) !== 'bunker') continue;
    const geom = f.geometry;
    // Point-only (centroid) bunkers are SKIPPED entirely — a single centroid
    // cannot honestly answer "can I carry it" (honesty rule, §4).
    if (!geom || geom.type !== 'Polygon') continue;

    const ring = (geom as GeoJSON.Polygon).coordinates[0];
    if (!ring || ring.length === 0) continue;
    const isClosed =
      ring.length > 1 &&
      ring[0][0] === ring[ring.length - 1][0] &&
      ring[0][1] === ring[ring.length - 1][1];
    const verts = isClosed ? ring.slice(0, -1) : ring;
    if (verts.length < 3) continue; // not a real polygon shape

    let minCarryM = Infinity;
    let maxCarryM = -Infinity;
    let minCarryVertex: LatLng | null = null;
    let minCarryLateralYards = 0;
    let minGreenDistYards = Infinity;
    let minAbsLateralYards = Infinity;

    for (const [lng, lat] of verts) {
      const p: LatLng = { lat, lng };
      const [hx, hy] = toXY(p);
      const { carryM, lateralM } = classify(hx, hy);

      if (carryM < minCarryM) {
        minCarryM = carryM;
        minCarryVertex = p;
        minCarryLateralYards = lateralM / METRES_PER_YARD;
      }
      if (carryM > maxCarryM) maxCarryM = carryM;

      const greenDistYards = metersBetween(p, green) / METRES_PER_YARD;
      if (greenDistYards < minGreenDistYards) minGreenDistYards = greenDistYards;

      const absLatYards = Math.abs(lateralM / METRES_PER_YARD);
      if (absLatYards < minAbsLateralYards) minAbsLateralYards = absLatYards;
    }

    if (minCarryVertex === null) continue;

    // Round FIRST, then clamp — matches backend `_round_to_5` then `max(0, …)`.
    const frontYards = Math.max(0, round5(minCarryM / METRES_PER_YARD));
    const backYards = Math.max(0, round5(maxCarryM / METRES_PER_YARD));

    // ── Fairway / in-tee-shot-range predicate (§4) ──────────────────────
    // Applied to the RAW (unrounded) carry, not the rounded display value
    // above — a true front carry of 97.6y rounds to a 100y display but is
    // still genuinely short of the floor, and 332.4y rounds to a 330y
    // display but is still genuinely past the ceiling. Round only once, for
    // display, after this predicate has already decided in/out.
    const rawFrontYards = minCarryM / METRES_PER_YARD;
    if (rawFrontYards < BUNKER_FLOOR_YARDS) continue;
    if (rawFrontYards > BUNKER_CEILING_YARDS) continue;
    if (minGreenDistYards < GREENSIDE_MIN_YARDS) continue; // greenside
    if (minAbsLateralYards > CORRIDOR_MAX_LATERAL_YARDS) continue; // out of corridor

    const side: 'L' | 'R' | 'C' =
      minCarryLateralYards > LATERAL_DEADBAND_YARDS
        ? 'L'
        : minCarryLateralYards < -LATERAL_DEADBAND_YARDS
        ? 'R'
        : 'C';

    candidates.push({
      front: frontYards,
      back: backYards,
      side,
      nearEdge: minCarryVertex,
      minAbsLateralYards,
    });
  }

  // Cap: keep the `maxBunkers` with smallest min|lateral| ("most in-play"),
  // then display sorted ascending by front carry.
  candidates.sort((a, b) => a.minAbsLateralYards - b.minAbsLateralYards);
  const capped = candidates.slice(0, maxBunkers);
  capped.sort((a, b) => a.front - b.front);

  return capped.map(({ front, back, side, nearEdge }, i) => ({
    front,
    back,
    side,
    nearEdge,
    letter: i < 6 ? String.fromCharCode(65 + i) : '', // A-F bundled; '' = graceful fallback
  }));
}

/**
 * Orchestrator — the only function the component calls for geometry.
 * Suppresses everything on a par 3 (§6). `par == null` -> treated as
 * non-par-3 (geometry predicates still hold — drawing true geometry is
 * honest).
 */
export function computeTeeShotOverlays(args: {
  features: GeoJSON.Feature[] | null;
  tee: LatLng | null;
  green: LatLng;
  par: number | null;
  /** Passed straight through to `fairwayBunkerCarries` — see its docstring. */
  maxBunkers?: number;
}): TeeShotOverlays {
  const EMPTY: TeeShotOverlays = { markers: [], bunkers: [] };

  if (args.par === 3) return EMPTY;
  const features = args.features;
  if (!features) return EMPTY;

  const centerline = greenFirstCenterline(features, args.green);
  const markers = centerline
    ? distanceMarkersFromGreen(centerline, args.green, [100, 150, 200], fairwayRingsFromFeatures(features))
    : [];

  const bunkers = args.tee
    ? fairwayBunkerCarries({ features, tee: args.tee, green: args.green, maxBunkers: args.maxBunkers })
    : [];

  return { markers, bunkers };
}

/**
 * Pure visibility predicate — see specs/tee-shot-yardage-overlays-plan.md §5.
 * `tee == null` => hidden (no honest origin for carries). No fix yet, or a
 * fix far from the hole, means "reading the hole" — shown. Otherwise shown
 * only within the 40y tee-zone radius.
 */
export function teeShotOverlaysVisible(args: {
  position: LatLng | null;
  gpsOnHole: boolean;
  tee: LatLng | null;
}): boolean {
  const { position, gpsOnHole, tee } = args;
  if (tee == null) return false;
  if (position == null) return true;
  if (!gpsOnHole) return true;
  return metersBetween(position, tee) / METRES_PER_YARD <= TEE_ZONE_RADIUS_YARDS;
}
