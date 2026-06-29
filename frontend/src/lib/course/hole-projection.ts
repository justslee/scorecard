/**
 * Pure geometry: project hole GeoJSON features → SVG viewport coordinates.
 *
 * No browser APIs, no Mapbox, no GPS distances. Headless-testable in Node.
 *
 * Algorithm
 * ---------
 * 1. Collect all Polygon outer-ring coordinates from the hole's feature list.
 * 2. Compute the geographic bounding box; apply cosLat correction so the
 *    diagram is isometric (no east-west stretch at Bethpage's ~40.7° latitude).
 * 3. Project every point to a local flat-earth metre coordinate system
 *    (x = east, y = north — "math" orientation, y increases upward).
 * 4. Rotate the whole diagram around its centroid so the tee→green axis is
 *    vertical: green at top (low SVG y), tee at bottom (high SVG y) — exactly
 *    like a printed yardage book.
 * 5. Scale + translate to fit the requested SVG viewport with uniform padding,
 *    preserving aspect ratio. Flip y for SVG (SVG y increases downward).
 *
 * Units: the output coordinates are in SVG user-space pixels (0..viewport.width,
 * 0..viewport.height). The caller can use them directly as SVG attributes.
 */

import * as turf from '@turf/turf';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Metres per degree of latitude (WGS-84 mean). Module-level so the forward
 *  and inverse transform functions share the exact same value. */
const LAT_M = 111_320;

/**
 * Tight corridor filter thresholds — used by `isInHoleCorridor`.
 *
 * LATERAL_CAP_M: maximum perpendicular distance (metres) from the tee→green
 * axis for a polygon or tree to be kept.
 *
 * Choice: 60 m.
 *   • A standard golf fairway is 35–40 m wide, so the axis sits ≈18 m from
 *     either edge — every fairway vertex easily clears 60 m.
 *   • Greenside bunkers are typically 20–50 m off-centre — inner vertices clear
 *     60 m even for wide bunker complexes.
 *   • The strays we're removing (foreign greens, ponds, trailing tree rows) sit
 *     150–400 m to the side at Bethpage — comfortably outside the cap.
 *
 * LONGITUDINAL_MARGIN_M: metres to extend the corridor past the tee and green
 * endpoints so features BEHIND the tee (multiple tee boxes) and features in the
 * green surrounds (rear bunkers, backstop rough) are not clipped.
 *
 * Choice: 40 m.
 *   • Deep back tees are typically 20–30 m behind the nominal tee centroid.
 *   • Bunkers behind a green are rarely more than 30–40 m past the flag.
 */
export const CORRIDOR_LATERAL_M = 60;
export const CORRIDOR_LONGITUDINAL_MARGIN_M = 40;

// ── Public types ──────────────────────────────────────────────────────────────

/** A projected polygon (one per GeoJSON feature) in SVG coordinates. */
export interface ProjectedPolygon {
  /** Original featureType string (tee / fairway / green / bunker / water / …). */
  type: string;
  /** Outer-ring vertices in SVG pixel space, in order, NO closing duplicate. */
  points: [number, number][];
}

/**
 * All parameters that define the full lat/lng ↔ SVG coordinate transform.
 *
 * Exposed so callers can:
 *   - Invert the projection: SVG pixel → lat/lng  (see `unprojectPoint`)
 *   - Apply the forward transform to arbitrary lat/lng: e.g. a GPS fix
 *     (see `projectLatLng`)
 *   - Detect whether a GPS position is near this hole  (see `isOnHoleBbox`)
 */
export interface ProjectionParams {
  /** SW corner of the raw geographic bounding box (all polygon vertices). */
  minLng: number;
  minLat: number;
  /** NE corner. */
  maxLng: number;
  maxLat: number;
  /** Cosine of the mean latitude — used for the equirectangular x correction. */
  cosLat: number;
  /** Rotation angle in radians (positive = CCW in standard math orientation).
   *  Applied around (cx, cy) in metre-space to orient tee→green axis vertically. */
  angle: number;
  /** Rotation centre in pre-rotation metre space. */
  cx: number;
  cy: number;
  /** Metres-to-pixels scale factor (uniform). */
  scale: number;
  /** SVG pixel offsets (left/top of the scaled diagram within the viewport). */
  offsetX: number;
  offsetY: number;
  /** Post-rotation metre-space left edge and top edge (used in scale/offset math). */
  rxMin: number;
  ryMax: number;
}

/** The result of projectHole — everything the renderer needs. */
export interface ProjectedHole {
  /** All polygon features, sorted rough → woods → fairway → water → bunker → green → tee.
   *  Callers can override render order if desired. */
  polygons: ProjectedPolygon[];
  /** Two-point routing line [tee, green] in SVG coords for the dashed centreline. */
  line: [number, number][];
  /** Tee centroid in SVG coords. */
  teePt: [number, number];
  /** Green centroid in SVG coords. */
  greenPt: [number, number];
  /** Full coordinate-transform parameters (needed by unprojectPoint / projectLatLng). */
  params: ProjectionParams;
  /** Geographic lat/lng of the tee centroid (for distance calculations). */
  teeLatLng: { lat: number; lng: number } | null;
  /** Geographic lat/lng of the green centroid (for distance calculations). */
  greenLatLng: { lat: number; lng: number } | null;
  /** Projected tree positions in SVG coords (from natural=tree node Point features).
   *  Empty array when no tree points exist for this hole. */
  trees: [number, number][];
}

/** Target viewport dimensions for the projection. */
export interface Viewport {
  width: number;
  height: number;
  /** Uniform padding (px) on all four sides. */
  padding: number;
}

/**
 * Optional GolfAPI-verified anchor overrides for `projectHole`.
 *
 * When provided, these replace the OSM polygon centroids for the tee and/or
 * green anchor points used in rotation, corridor clip, and the flag/tee marker
 * SVG positions.  They also flow through to `teeLatLng` / `greenLatLng` on the
 * output, so tap-to-measure and GPS distances reference the verified GolfAPI
 * points rather than the OSM polygon centroids.
 */
export interface ProjectedHoleOverrides {
  /** GolfAPI tee lat/lng — overrides the OSM tee polygon centroid. */
  teeLngLat?: { lat: number; lng: number };
  /** GolfAPI green-center lat/lng — overrides the OSM green polygon centroid. */
  greenLngLat?: { lat: number; lng: number };
}

// ── Internal geometry helpers ──────────────────────────────────────────────────

/**
 * Arithmetic-mean centroid of a GeoJSON outer ring.
 * Excludes the closing duplicate vertex (ring[0] === ring[-1]) from the mean.
 * Returns null for empty or degenerate rings.
 */
export function ringCentroid(ring: number[][]): [number, number] | null {
  if (!ring || ring.length === 0) return null;
  // Detect and remove closing duplicate vertex
  const isClosedRing =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1];
  const verts = isClosedRing ? ring.slice(0, -1) : ring;
  if (verts.length === 0) return null;

  let sumLng = 0;
  let sumLat = 0;
  for (const [lng, lat] of verts) {
    sumLng += lng;
    sumLat += lat;
  }
  return [sumLng / verts.length, sumLat / verts.length];
}

/**
 * Rotate point (x, y) around centre (cx, cy) by angle radians
 * (positive = counter-clockwise in standard math orientation).
 */
export function rotatePoint(
  x: number,
  y: number,
  cx: number,
  cy: number,
  angle: number
): [number, number] {
  const dx = x - cx;
  const dy = y - cy;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

// ── Corridor helpers (pure, unit-testable) ────────────────────────────────────

/**
 * Distance in metres from point P to the nearest point on line segment A→B.
 *
 * All coordinates must be in a flat metre space (e.g. the equirectangular
 * projection used throughout this module).  Returns the perpendicular distance
 * when the foot of the perpendicular falls within [A, B]; otherwise returns the
 * distance to the nearer endpoint.
 *
 * Pure function — no side-effects, no DOM, headless-testable.
 */
export function pointToSegmentDistanceM(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-9) return Math.hypot(px - ax, py - ay);   // degenerate segment
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / len2));
  return Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
}

/**
 * Returns true if the ring (pre-projected to metre space) lies within the
 * tee→green hole corridor.
 *
 * A ring "lies within" the corridor if its centroid OR any ring vertex satisfies
 * BOTH constraints:
 *   • lateral (perpendicular) distance from the tee→green axis ≤ latCapM
 *   • longitudinal projection along the axis in [-lonMarginM, segLen + lonMarginM]
 *
 * Rationale for the two-step (centroid + vertex) check:
 *   • Large terrain polygons that straddle the axis (rough, wide fairways) have
 *     their centroid on-axis — the centroid check keeps them with a single test.
 *   • Off-axis bunkers/water features have vertices that dip toward the fairway
 *     even when the centroid exceeds the cap — checking vertices catches them.
 *   • Stray foreign greens/ponds 150–400 m to the side have BOTH centroid and
 *     all vertices well outside the cap → correctly excluded.
 *
 * To test a single Point feature (e.g. a tree node), pass it as
 * `ringMeters = [[px, py]]`.
 *
 * Pure function — no side-effects, no DOM, headless-testable.
 *
 * @param ringMeters   Ring vertices in metre-space [[x, y], …] (may be closed)
 * @param teeM         Tee centroid in metre space [x, y]
 * @param greenM       Green centroid in metre space [x, y]
 * @param latCapM      Maximum lateral distance (metres) — corridor half-width
 * @param lonMarginM   Extension (metres) past each end of the tee→green segment
 */
export function isInHoleCorridor(
  ringMeters: [number, number][],
  teeM: [number, number],
  greenM: [number, number],
  latCapM: number,
  lonMarginM: number,
): boolean {
  if (ringMeters.length === 0) return false;

  const [ax, ay] = teeM;
  const [bx, by] = greenM;
  const abx = bx - ax;
  const aby = by - ay;
  const segLen = Math.hypot(abx, aby);

  if (segLen < 0.1) {
    // Degenerate hole (tee === green): use a simple radial test.
    return ringMeters.some(([px, py]) => Math.hypot(px - ax, py - ay) <= latCapM);
  }

  // Unit vector along the tee→green axis.
  const ux = abx / segLen;
  const uy = aby / segLen;

  /** True when point (px, py) satisfies both corridor constraints. */
  function inCorridor(px: number, py: number): boolean {
    const dx = px - ax;
    const dy = py - ay;
    const proj = dx * ux + dy * uy;          // longitudinal projection (metres along axis)
    const lat  = Math.abs(dx * uy - dy * ux); // lateral distance (cross-product magnitude)
    return proj >= -lonMarginM && proj <= segLen + lonMarginM && lat <= latCapM;
  }

  // 1. Centroid check — fast path for large polygons straddling the axis.
  //    Exclude the GeoJSON closing duplicate vertex if present.
  const verts: [number, number][] =
    ringMeters.length > 1 &&
    ringMeters[0][0] === ringMeters[ringMeters.length - 1][0] &&
    ringMeters[0][1] === ringMeters[ringMeters.length - 1][1]
      ? ringMeters.slice(0, -1)
      : ringMeters;
  let sumX = 0, sumY = 0;
  for (const [x, y] of verts) { sumX += x; sumY += y; }
  if (inCorridor(sumX / verts.length, sumY / verts.length)) return true;

  // 2. Vertex check — catches off-axis polygons with an inner edge in corridor.
  for (const [px, py] of ringMeters) {
    if (inCorridor(px, py)) return true;
  }

  return false;
}

// ── Forward & inverse coordinate transforms ───────────────────────────────────

/**
 * Forward: project a geographic lat/lng to SVG pixel coordinates using the
 * transform parameters returned by `projectHole`.
 *
 * This is the same math that `projectHole` applies internally; exposed here so
 * callers can plot arbitrary lat/lng points (e.g. a live GPS fix) onto the
 * diagram without re-running the full projection.
 */
export function projectLatLng(
  latlng: { lat: number; lng: number },
  params: ProjectionParams
): [number, number] {
  const { minLng, minLat, cosLat, angle, cx, cy, scale, offsetX, offsetY, rxMin, ryMax } = params;
  // 1. Flat-earth metre space (equirectangular, origin at SW corner of bbox)
  const xM = (latlng.lng - minLng) * LAT_M * cosLat;
  const yM = (latlng.lat - minLat) * LAT_M;
  // 2. Rotate around bbox centre to orient tee→green axis vertically
  const [xR, yR] = rotatePoint(xM, yM, cx, cy, angle);
  // 3. Scale + translate + y-flip (SVG y increases downward)
  return [
    offsetX + (xR - rxMin) * scale,
    offsetY + (ryMax - yR) * scale,
  ];
}

/**
 * Inverse: convert an SVG pixel coordinate to a geographic lat/lng by
 * applying each step of the forward transform in reverse.
 *
 * Accuracy: floating-point round-trip errors are <1e-9 degrees for points
 * within the hole bounding box.
 */
export function unprojectPoint(
  svg: { x: number; y: number },
  params: ProjectionParams
): { lat: number; lng: number } {
  const { minLng, minLat, cosLat, angle, cx, cy, scale, offsetX, offsetY, rxMin, ryMax } = params;
  // 1. Undo SVG y-flip and scale/translate → rotated metre space
  const xR = (svg.x - offsetX) / scale + rxMin;
  const yR = ryMax - (svg.y - offsetY) / scale;
  // 2. Undo the tee→green orientation rotation
  const [xM, yM] = rotatePoint(xR, yR, cx, cy, -angle);
  // 3. Undo the flat-earth projection → lat/lng
  const lat = yM / LAT_M + minLat;
  const lng = cosLat > 0 ? xM / (LAT_M * cosLat) + minLng : minLng;
  return { lat, lng };
}

// ── GPS / on-hole helpers ──────────────────────────────────────────────────────

/**
 * Returns true when a GPS position is within the hole's geographic bounding
 * box expanded by `marginDeg` on all four sides.
 *
 * Default margin ≈ 0.006° ≈ 660 m ≈ 720 yds — enough to include a player
 * who is anywhere near the hole (on the tee, in the fairway, or on the green)
 * while rejecting a position 28 miles away (the "50531 yds" absurdity).
 */
export function isOnHoleBbox(
  pos: { lat: number; lng: number },
  params: Pick<ProjectionParams, 'minLat' | 'maxLat' | 'minLng' | 'maxLng'>,
  marginDeg = 0.006
): boolean {
  return (
    pos.lat >= params.minLat - marginDeg &&
    pos.lat <= params.maxLat + marginDeg &&
    pos.lng >= params.minLng - marginDeg &&
    pos.lng <= params.maxLng + marginDeg
  );
}

/**
 * Compute the straight-line distance between two geographic coordinates in
 * yards (the standard golf unit).
 *
 * Uses the same turf haversine method as `holeLengthYards` for consistency.
 */
export function yardsDistance(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const m = turf.distance([a.lng, a.lat], [b.lng, b.lat], { units: 'meters' });
  return Math.round(m * 1.09361);
}

// ── GolfAPI anchor helper ──────────────────────────────────────────────────────

/**
 * Among all GeoJSON features with `featureType === "green"` (Polygon geometry),
 * return the lat/lng centroid of the one closest to `target`.
 *
 * Used as a belt-and-suspenders filter when multiple green polygons are present
 * (e.g. an OSM mapping artefact included an adjacent hole's green): we prefer
 * the one nearest the GolfAPI verified green point.
 *
 * Returns null when no green polygons exist.
 *
 * Pure function — no side-effects, no DOM, headless-testable.
 */
export function nearestGreenCentroid(
  features: GeoJSON.Feature[],
  target: { lat: number; lng: number }
): { lat: number; lng: number } | null {
  // Flat-earth cosLat for distance comparison (consistent with the projection).
  const cosLat = Math.cos((target.lat * Math.PI) / 180);

  let bestDist = Infinity;
  let bestCentroid: { lat: number; lng: number } | null = null;

  for (const feat of features) {
    const geom = feat.geometry;
    if (!geom || geom.type !== 'Polygon') continue;
    const type = (feat.properties?.featureType as string | undefined) ?? '';
    if (type !== 'green') continue;

    const ring = (geom as GeoJSON.Polygon).coordinates[0];
    if (!ring || ring.length < 3) continue;

    const c = ringCentroid(ring);
    if (!c) continue;
    const [cLng, cLat] = c;

    // Flat-earth squared distance (no sqrt needed for comparison)
    const dx = (cLng - target.lng) * LAT_M * cosLat;
    const dy = (cLat - target.lat) * LAT_M;
    const dist2 = dx * dx + dy * dy;

    if (dist2 < bestDist) {
      bestDist = dist2;
      bestCentroid = { lat: cLat, lng: cLng };
    }
  }

  return bestCentroid;
}

// ── Core projection ────────────────────────────────────────────────────────────

/**
 * Project a single hole's GeoJSON features to SVG viewport coordinates.
 *
 * Returns null when the feature list has no usable polygon geometry or lacks
 * both a tee and a green polygon (needed to establish orientation).
 *
 * @param features   Flat array of GeoJSON Feature objects from HoleData.features.features.
 *                   Only Polygon geometries are considered; others are silently skipped.
 * @param viewport   Target SVG dimensions + padding.
 * @param overrides  Optional GolfAPI-verified tee/green lat/lng.  When supplied, these
 *                   replace the OSM polygon centroids for orientation, corridor clip, and
 *                   the flag/tee SVG positions — giving more accurate anchoring than OSM.
 *                   All other geometry (fairway, bunker, water, trees) is still derived
 *                   from the OSM features so the visual shapes remain correct.
 */
export function projectHole(
  features: GeoJSON.Feature[],
  viewport: Viewport,
  overrides?: ProjectedHoleOverrides
): ProjectedHole | null {
  // ── Collect polygon rings and raw tree point coords ───────────────────────
  const rawPolygons: Array<{ type: string; ring: number[][] }> = [];
  const rawTreeLngLats: [number, number][] = [];  // [lng, lat] pairs from Point features
  let teeCentroid: [number, number] | null = null;
  let greenCentroid: [number, number] | null = null;

  for (const feat of features) {
    const geom = feat.geometry;
    if (!geom) continue;
    const type = (feat.properties?.featureType as string | undefined) ?? '';

    if (geom.type === 'Point') {
      // Collect tree point positions — projected after the transform is established.
      const coords = (geom as GeoJSON.Point).coordinates;
      if (coords && coords.length >= 2) {
        rawTreeLngLats.push([coords[0], coords[1]]);
      }
      continue;
    }

    if (geom.type !== 'Polygon') continue;
    const ring = (geom as GeoJSON.Polygon).coordinates[0];
    if (!ring || ring.length < 3) continue;

    rawPolygons.push({ type, ring });

    const c = ringCentroid(ring);
    if (c) {
      if (type === 'tee' && !teeCentroid) teeCentroid = c;
      if (type === 'green' && !greenCentroid) greenCentroid = c;
    }
  }

  if (rawPolygons.length === 0) return null;

  // ── Apply GolfAPI overrides (more accurate than OSM polygon centroids) ─────
  // When provided, override the OSM-derived centroids for the tee and/or green.
  // These drive: corridor clip axis, rotation orientation, and SVG marker positions.
  // The OSM polygon shapes (fairway, bunker, water, trees) are unchanged.
  if (overrides?.teeLngLat) {
    teeCentroid = [overrides.teeLngLat.lng, overrides.teeLngLat.lat];
  }
  if (overrides?.greenLngLat) {
    greenCentroid = [overrides.greenLngLat.lng, overrides.greenLngLat.lat];
  }

  // We need at least one orientation anchor — tee or green.
  // If only one is present, we still proceed; we just can't orient the hole.
  const canOrient = teeCentroid !== null && greenCentroid !== null;

  // ── Tight corridor guard (perpendicular-distance clip) ───────────────────
  //
  // Replaces the old rectangular bbox guard (CORRIDOR_LAT_DEG / CORRIDOR_LNG_DEG)
  // with a proper perpendicular-distance-from-segment test in metre space.
  //
  // Problem with the old bbox: a diagonal hole has a large axis-aligned bbox that
  // included features 300–400 m to the side (adjacent greens, ponds, tree rows)
  // even though the lateral (perpendicular) distance to the corridor was large.
  //
  // New approach: project each polygon's ring to flat-earth metre coordinates
  // and test whether its centroid OR any vertex lies within CORRIDOR_LATERAL_M
  // of the tee→green axis AND within CORRIDOR_LONGITUDINAL_MARGIN_M of each end.
  //
  // Tee and green polygons always pass (they define the corridor).
  // Tree Point features receive the same corridor test (see below).

  // cosLat for the corridor projection — derived from tee+green centroids
  // (before the full bbox is computed from filteredPolygons).
  const corridorMidLat = canOrient && teeCentroid && greenCentroid
    ? (teeCentroid[1] + greenCentroid[1]) / 2
    : 0;
  const corridorCosLat = Math.cos((corridorMidLat * Math.PI) / 180);

  /** Project a [lng, lat] pair to metre-space [x, y] for corridor testing. */
  function toCorridorM(lng: number, lat: number): [number, number] {
    return [lng * LAT_M * corridorCosLat, lat * LAT_M];
  }

  const teeCorM  = canOrient && teeCentroid  ? toCorridorM(teeCentroid[0],  teeCentroid[1])  : null;
  const greenCorM = canOrient && greenCentroid ? toCorridorM(greenCentroid[0], greenCentroid[1]) : null;

  const filteredPolygons: typeof rawPolygons =
    canOrient && teeCorM && greenCorM
      ? rawPolygons.filter(({ type, ring }) => {
          if (type === 'tee' || type === 'green') return true;  // always keep
          const ringM = ring.map(([lng, lat]) => toCorridorM(lng, lat)) as [number, number][];
          return isInHoleCorridor(ringM, teeCorM, greenCorM, CORRIDOR_LATERAL_M, CORRIDOR_LONGITUDINAL_MARGIN_M);
        })
      : rawPolygons;

  // Apply the same corridor test to tree Point features so trailing tree rows
  // from neighbouring holes (which show up as diagonally drifting dots) are removed.
  const filteredTreeLngLats: [number, number][] =
    canOrient && teeCorM && greenCorM
      ? rawTreeLngLats.filter(([lng, lat]) => {
          const ptM = toCorridorM(lng, lat);
          return isInHoleCorridor([ptM], teeCorM, greenCorM, CORRIDOR_LATERAL_M, CORRIDOR_LONGITUDINAL_MARGIN_M);
        })
      : rawTreeLngLats;

  // ── Geographic bounding box ────────────────────────────────────────────────
  let minLng = Infinity, maxLng = -Infinity;
  let minLat = Infinity, maxLat = -Infinity;
  for (const { ring } of filteredPolygons) {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }

  // ── Project to local metre space (equirectangular, x=east y=north) ────────
  // cosLat correction: at Bethpage (~40.7°) cos ≈ 0.757, so without correction
  // the hole would appear horizontally stretched by ~32 %.
  const midLat = (minLat + maxLat) / 2;
  const cosLat = Math.cos((midLat * Math.PI) / 180);

  function toMeters(coord: number[]): [number, number] {
    const [lng, lat] = coord;
    return [
      (lng - minLng) * LAT_M * cosLat, // x: eastward
      (lat - minLat) * LAT_M,          // y: northward (math coords, y up)
    ];
  }

  // Project all polygon rings (use filteredPolygons to exclude stray features)
  const mtrPolygons = filteredPolygons.map(({ type, ring }) => ({
    type,
    pts: ring.map(toMeters),
  }));

  // Project tee and green centroids (needed for orientation)
  const teeM = teeCentroid ? toMeters(teeCentroid) : null;
  const greenM = greenCentroid ? toMeters(greenCentroid) : null;

  // ── Compute metre-space bbox to find rotation centre ──────────────────────
  let mxMin = Infinity, mxMax = -Infinity;
  let myMin = Infinity, myMax = -Infinity;
  for (const { pts } of mtrPolygons) {
    for (const [x, y] of pts) {
      if (x < mxMin) mxMin = x;
      if (x > mxMax) mxMax = x;
      if (y < myMin) myMin = y;
      if (y > myMax) myMax = y;
    }
  }
  const cx = (mxMin + mxMax) / 2;
  const cy = (myMin + myMax) / 2;

  // ── Rotation: make tee→green axis point in +y direction (+y = north = up) ─
  // Current angle of the tee→green vector: θ = atan2(Δy, Δx)
  // Desired angle: +y direction = π/2
  // Rotation needed: r = π/2 − θ
  // If we can't orient (no tee+green pair), r = 0 (no rotation).
  let r = 0;
  if (canOrient && teeM && greenM) {
    const dx = greenM[0] - teeM[0];
    const dy = greenM[1] - teeM[1];
    // Guard against degenerate zero-length tee→green vector
    if (Math.hypot(dx, dy) > 0.1) {
      const θ = Math.atan2(dy, dx);
      r = Math.PI / 2 - θ;
    }
  }

  // ── Apply rotation around bbox centre ─────────────────────────────────────
  const rotPolygons = mtrPolygons.map(({ type, pts }) => ({
    type,
    pts: pts.map(([x, y]) => rotatePoint(x, y, cx, cy, r)),
  }));

  const teeR = teeM ? rotatePoint(teeM[0], teeM[1], cx, cy, r) : null;
  const greenR = greenM ? rotatePoint(greenM[0], greenM[1], cx, cy, r) : null;

  // ── Rotated bounding box ──────────────────────────────────────────────────
  let rxMin = Infinity, rxMax = -Infinity;
  let ryMin = Infinity, ryMax = -Infinity;
  for (const { pts } of rotPolygons) {
    for (const [x, y] of pts) {
      if (x < rxMin) rxMin = x;
      if (x > rxMax) rxMax = x;
      if (y < ryMin) ryMin = y;
      if (y > ryMax) ryMax = y;
    }
  }

  // ── Scale to SVG viewport (uniform, preserving aspect ratio) ──────────────
  const { width: W, height: H, padding: P } = viewport;
  const usableW = W - 2 * P;
  const usableH = H - 2 * P;
  const rW = rxMax - rxMin || 1;
  const rH = ryMax - ryMin || 1;
  const scale = Math.min(usableW / rW, usableH / rH);
  // Centre the diagram within the padded area
  const offsetX = P + (usableW - rW * scale) / 2;
  const offsetY = P + (usableH - rH * scale) / 2;

  /**
   * Convert a rotated metre-space point to SVG pixel coordinates.
   * Flips y so that "north up" in metre space becomes "up" in SVG space
   * (SVG y increases downward, so y_svg = max - y_geo).
   */
  function toSVG(pt: [number, number]): [number, number] {
    const [x, y] = pt;
    return [
      offsetX + (x - rxMin) * scale,
      offsetY + (ryMax - y) * scale, // y-flip: north = SVG top
    ];
  }

  // ── Assemble output ────────────────────────────────────────────────────────
  // Sort so rendering is back→front.  Terrain layers (rough, woods) go first so
  // they underlie the mown corridor; fairway, water, bunker, green, tee follow.
  const RENDER_ORDER = ['rough', 'woods', 'fairway', 'water', 'bunker', 'green', 'tee'];
  const svgPolygons: ProjectedPolygon[] = rotPolygons
    .sort((a, b) => {
      const ai = RENDER_ORDER.indexOf(a.type);
      const bi = RENDER_ORDER.indexOf(b.type);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    })
    .map(({ type, pts }) => ({
      type,
      // Remove the closing duplicate vertex if present (GeoJSON rings are closed)
      points: ((): [number, number][] => {
        const svgPts = pts.map(toSVG);
        // Drop closing duplicate
        if (
          svgPts.length > 1 &&
          Math.abs(svgPts[0][0] - svgPts[svgPts.length - 1][0]) < 0.01 &&
          Math.abs(svgPts[0][1] - svgPts[svgPts.length - 1][1]) < 0.01
        ) {
          return svgPts.slice(0, -1);
        }
        return svgPts;
      })(),
    }));

  const svgTee: [number, number] = teeR ? toSVG(teeR) : [W / 2, H - P];
  const svgGreen: [number, number] = greenR ? toSVG(greenR) : [W / 2, P];

  // ── Build projection params (for unproject / GPS plotting) ────────────────
  const params: ProjectionParams = {
    minLng,
    minLat,
    maxLng,
    maxLat,
    cosLat,
    angle: r,
    cx,
    cy,
    scale,
    offsetX,
    offsetY,
    rxMin,
    ryMax,
  };

  // ── Project tree point features ────────────────────────────────────────────
  // Tree points use the same full transform as polygon vertices, projected via
  // projectLatLng so they appear correctly on the oriented, scaled diagram.
  // filteredTreeLngLats has already had the tight corridor test applied, so
  // trailing tree rows from neighbouring holes are excluded.
  const svgTrees: [number, number][] = filteredTreeLngLats.map(([lng, lat]) =>
    projectLatLng({ lat, lng }, params)
  );

  return {
    polygons: svgPolygons,
    line: [svgTee, svgGreen],
    teePt: svgTee,
    greenPt: svgGreen,
    params,
    teeLatLng: teeCentroid
      ? { lat: teeCentroid[1], lng: teeCentroid[0] }
      : null,
    greenLatLng: greenCentroid
      ? { lat: greenCentroid[1], lng: greenCentroid[0] }
      : null,
    trees: svgTrees,
  };
}

// ── Hole length ────────────────────────────────────────────────────────────────

/**
 * Compute the playing length of a hole in yards from its GeoJSON features.
 *
 * Priority:
 * 1. LineString feature (any featureType with LineString geometry) — sum of
 *    segment haversine distances in yards.  This covers the case where the OSM
 *    hole LineString is stored alongside the polygon features.
 * 2. Tee-polygon centroid → green-polygon centroid crow-flies distance.
 *    At a par-4 this gives a reasonable estimate of the direct length.
 * 3. Returns 0 when neither tee nor green polygon can be found.
 */
export function holeLengthYards(features: GeoJSON.Feature[]): number {
  // ── 1. LineString route (most accurate, future-proof) ─────────────────────
  for (const feat of features) {
    const geom = feat.geometry;
    if (!geom || geom.type !== 'LineString') continue;
    const coords = (geom as GeoJSON.LineString).coordinates;
    if (coords.length < 2) continue;

    let totalMeters = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const [lng1, lat1] = coords[i];
      const [lng2, lat2] = coords[i + 1];
      totalMeters += turf.distance([lng1, lat1], [lng2, lat2], { units: 'meters' });
    }
    return Math.round(totalMeters * 1.09361);
  }

  // ── 2. Tee centroid → green centroid crow-flies distance ──────────────────
  let teeCentroid: [number, number] | null = null;
  let greenCentroid: [number, number] | null = null;

  for (const feat of features) {
    const geom = feat.geometry;
    if (!geom || geom.type !== 'Polygon') continue;
    const type = (feat.properties?.featureType as string | undefined) ?? '';
    const ring = (geom as GeoJSON.Polygon).coordinates[0];
    if (!ring || ring.length === 0) continue;

    const c = ringCentroid(ring);
    if (!c) continue;
    if (type === 'tee' && !teeCentroid) teeCentroid = c;
    if (type === 'green' && !greenCentroid) greenCentroid = c;
  }

  if (teeCentroid && greenCentroid) {
    const [tLng, tLat] = teeCentroid;
    const [gLng, gLat] = greenCentroid;
    const meters = turf.distance([tLng, tLat], [gLng, gLat], { units: 'meters' });
    return Math.round(meters * 1.09361);
  }

  return 0;
}

// ── Hazard description ─────────────────────────────────────────────────────────

/**
 * Build a compact hazard description for the info strip, e.g. "3 bunkers · water".
 *
 * When `projected` is supplied, water position relative to the tee→green
 * centreline is used to add a "left" or "right" qualifier.
 *
 * Returns an empty string when the hole has no hazards.
 */
export function describeHazards(
  features: GeoJSON.Feature[],
  projected: ProjectedHole | null
): string {
  let bunkerCount = 0;
  let hasWater = false;

  for (const feat of features) {
    const t = (feat.properties?.featureType as string | undefined) ?? '';
    if (t === 'bunker') bunkerCount++;
    if (t === 'water') hasWater = true;
  }

  const parts: string[] = [];
  if (bunkerCount > 0) {
    parts.push(`${bunkerCount} bunker${bunkerCount !== 1 ? 's' : ''}`);
  }

  if (hasWater) {
    let waterLabel = 'water';
    if (projected) {
      // Determine whether the water centre-of-mass is left or right of the
      // tee→green centreline in SVG coordinates.
      // After rotation, the centreline is approximately vertical.
      // Player at tee looks UP (toward low SVG y → green).
      // Player's left = their left hand = SVG left (low x) ONLY if the page
      // is drawn so the player faces up — which our diagram guarantees.
      const centerX = (projected.teePt[0] + projected.greenPt[0]) / 2;
      const waterPolys = projected.polygons.filter((p) => p.type === 'water');
      if (waterPolys.length > 0) {
        let sumX = 0;
        let count = 0;
        for (const wp of waterPolys) {
          for (const [x] of wp.points) {
            sumX += x;
            count++;
          }
        }
        const avgX = sumX / (count || 1);
        waterLabel = avgX < centerX ? 'water left' : 'water right';
      }
    }
    parts.push(waterLabel);
  }

  return parts.join(' · ');
}
