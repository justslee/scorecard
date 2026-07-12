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
  /** Interpolated point ON the hole centerline. */
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
 * Walk the centerline from the green end, cumulative float meters; linear
 * lat/lng interpolation inside the segment containing each target distance.
 * A target beyond total path length is OMITTED (a 160y-line hole has no 200
 * plate). Distances measured from GREEN CENTER: the walk starts with an
 * offset = metersBetween(greenCenter, line[0]) so plates are true
 * to-green-CENTER numbers even though the way ends at the green edge/pin.
 */
export function distanceMarkersFromGreen(
  centerline: LatLng[],
  greenCenter: LatLng,
  distancesYds: readonly number[] = [100, 150, 200],
): DistanceMarker[] {
  if (!centerline || centerline.length < 2) return [];

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
        markers.push({
          yards: targetYd as 100 | 150 | 200,
          position: {
            lat: a.lat + t * (b.lat - a.lat),
            lng: a.lng + t * (b.lng - a.lng),
          },
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
}): BunkerCarry[] {
  const { features, tee, green } = args;

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
    if (frontYards < BUNKER_FLOOR_YARDS) continue;
    if (frontYards > BUNKER_CEILING_YARDS) continue;
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

  // Cap at 4: keep the 4 with smallest min|lateral| ("most in-play"), then
  // display sorted ascending by front carry.
  candidates.sort((a, b) => a.minAbsLateralYards - b.minAbsLateralYards);
  const capped = candidates.slice(0, BUNKER_CAP);
  capped.sort((a, b) => a.front - b.front);

  return capped.map(({ front, back, side, nearEdge }) => ({ front, back, side, nearEdge }));
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
}): TeeShotOverlays {
  const EMPTY: TeeShotOverlays = { markers: [], bunkers: [] };

  if (args.par === 3) return EMPTY;
  const features = args.features;
  if (!features) return EMPTY;

  const centerline = greenFirstCenterline(features, args.green);
  const markers = centerline ? distanceMarkersFromGreen(centerline, args.green) : [];

  const bunkers = args.tee
    ? fairwayBunkerCarries({ features, tee: args.tee, green: args.green })
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
