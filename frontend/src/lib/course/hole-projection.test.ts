/**
 * Unit tests for hole-projection.ts
 *
 * Pure geometry — no browser APIs, no network, no Mapbox.
 * Runs headlessly in Node via Vitest.
 */

import { describe, it, expect } from 'vitest';
import {
  ringCentroid,
  rotatePoint,
  projectHole,
  projectLatLng,
  unprojectPoint,
  isOnHoleBbox,
  yardsDistance,
  holeLengthYards,
  describeHazards,
  pointToSegmentDistanceM,
  isInHoleCorridor,
  nearestGreenCentroid,
  CORRIDOR_LATERAL_M,
  CORRIDOR_LONGITUDINAL_MARGIN_M,
  type Viewport,
  type ProjectedHole,
  type ProjectionParams,
} from './hole-projection';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build a minimal GeoJSON Polygon feature. */
function makePolygon(
  featureType: string,
  ring: [number, number][]  // [lng, lat][]
): GeoJSON.Feature {
  // Close the ring if not already closed
  const closed: [number, number][] =
    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring
      : [...ring, ring[0]];
  return {
    type: 'Feature',
    properties: { featureType },
    geometry: { type: 'Polygon', coordinates: [closed] },
  };
}

/** Build a minimal GeoJSON LineString feature. */
function makeLineString(
  featureType: string,
  coords: [number, number][]  // [lng, lat][]
): GeoJSON.Feature {
  return {
    type: 'Feature',
    properties: { featureType },
    geometry: { type: 'LineString', coordinates: coords },
  };
}

// A simple north-south par-4 fairway-style layout (all coords near Bethpage lat ~40.7°)
// Tee is at the south end, green at the north end.
// Using roughly 400 yards = ~366 m ≈ 0.00329° of latitude.
const BASE_LNG = -73.461;
const TEE_LAT = 40.740;
const GREEN_LAT = 40.7433; // ~0.0033° ≈ 366 m ≈ 400 yds north of tee

const TEE_RING: [number, number][] = [
  [BASE_LNG - 0.0002, TEE_LAT],
  [BASE_LNG + 0.0002, TEE_LAT],
  [BASE_LNG + 0.0002, TEE_LAT + 0.0002],
  [BASE_LNG - 0.0002, TEE_LAT + 0.0002],
];

const GREEN_RING: [number, number][] = [
  [BASE_LNG - 0.0003, GREEN_LAT],
  [BASE_LNG + 0.0003, GREEN_LAT],
  [BASE_LNG + 0.0003, GREEN_LAT + 0.0003],
  [BASE_LNG - 0.0003, GREEN_LAT + 0.0003],
];

const FAIRWAY_RING: [number, number][] = [
  [BASE_LNG - 0.0006, TEE_LAT + 0.0002],
  [BASE_LNG + 0.0006, TEE_LAT + 0.0002],
  [BASE_LNG + 0.0006, GREEN_LAT],
  [BASE_LNG - 0.0006, GREEN_LAT],
];

const BUNKER_RING: [number, number][] = [
  [BASE_LNG + 0.0006, TEE_LAT + 0.002],
  [BASE_LNG + 0.0008, TEE_LAT + 0.002],
  [BASE_LNG + 0.0008, TEE_LAT + 0.003],
  [BASE_LNG + 0.0006, TEE_LAT + 0.003],
];

const WATER_RING: [number, number][] = [
  [BASE_LNG - 0.001, TEE_LAT + 0.001],
  [BASE_LNG - 0.0006, TEE_LAT + 0.001],
  [BASE_LNG - 0.0006, TEE_LAT + 0.003],
  [BASE_LNG - 0.001, TEE_LAT + 0.003],
];

const VIEWPORT: Viewport = { width: 1000, height: 1400, padding: 50 };

// ── ringCentroid ───────────────────────────────────────────────────────────────

describe('ringCentroid', () => {
  it('returns null for empty ring', () => {
    expect(ringCentroid([])).toBeNull();
  });

  it('returns null for null input', () => {
    expect(ringCentroid(null as unknown as number[][])).toBeNull();
  });

  it('returns the single point for a 1-vertex ring', () => {
    const c = ringCentroid([[-73.461, 40.74]]);
    expect(c).toEqual([-73.461, 40.74]);
  });

  it('returns correct centroid for an open square ring', () => {
    // Square at (0,0)..(2,0)..(2,2)..(0,2) → centroid (1, 1)
    const ring: number[][] = [[0, 0], [2, 0], [2, 2], [0, 2]];
    const c = ringCentroid(ring);
    expect(c).not.toBeNull();
    expect(c![0]).toBeCloseTo(1, 5);
    expect(c![1]).toBeCloseTo(1, 5);
  });

  it('excludes closing duplicate vertex from the mean', () => {
    // Closed ring: [A, B, C, A] → centroid should equal the open [A, B, C] centroid
    const open: number[][] = [[0, 0], [3, 0], [0, 3]];
    const closed: number[][] = [[0, 0], [3, 0], [0, 3], [0, 0]];
    const cOpen = ringCentroid(open);
    const cClosed = ringCentroid(closed);
    expect(cClosed).not.toBeNull();
    expect(cClosed![0]).toBeCloseTo(cOpen![0], 8);
    expect(cClosed![1]).toBeCloseTo(cOpen![1], 8);
  });
});

// ── rotatePoint ───────────────────────────────────────────────────────────────

describe('rotatePoint', () => {
  it('90° rotation: (1, 0) around origin → (0, 1)', () => {
    const [x, y] = rotatePoint(1, 0, 0, 0, Math.PI / 2);
    expect(x).toBeCloseTo(0, 5);
    expect(y).toBeCloseTo(1, 5);
  });

  it('180° rotation: (1, 0) around origin → (-1, 0)', () => {
    const [x, y] = rotatePoint(1, 0, 0, 0, Math.PI);
    expect(x).toBeCloseTo(-1, 5);
    expect(y).toBeCloseTo(0, 5);
  });

  it('0° rotation leaves point unchanged', () => {
    const [x, y] = rotatePoint(3, 4, 1, 1, 0);
    expect(x).toBeCloseTo(3, 8);
    expect(y).toBeCloseTo(4, 8);
  });

  it('rotation around non-origin centre', () => {
    // Rotate (2, 1) around (1, 1) by 90° → (1, 2)
    const [x, y] = rotatePoint(2, 1, 1, 1, Math.PI / 2);
    expect(x).toBeCloseTo(1, 5);
    expect(y).toBeCloseTo(2, 5);
  });
});

// ── projectHole ───────────────────────────────────────────────────────────────

describe('projectHole', () => {
  it('returns null for an empty feature list', () => {
    expect(projectHole([], VIEWPORT)).toBeNull();
  });

  it('returns null when all features are non-Polygon (e.g. only a LineString)', () => {
    const features = [makeLineString('hole', [[BASE_LNG, TEE_LAT], [BASE_LNG, GREEN_LAT]])];
    expect(projectHole(features, VIEWPORT)).toBeNull();
  });

  it('returns a ProjectedHole for valid tee + green + fairway', () => {
    const features = [
      makePolygon('tee', TEE_RING),
      makePolygon('green', GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
    ];
    const result = projectHole(features, VIEWPORT);
    expect(result).not.toBeNull();
    expect(result!.polygons.length).toBe(3);
    expect(result!.line.length).toBe(2);
  });

  it('all SVG points are within [0, viewport.width] × [0, viewport.height]', () => {
    const features = [
      makePolygon('tee', TEE_RING),
      makePolygon('green', GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
      makePolygon('bunker', BUNKER_RING),
      makePolygon('water', WATER_RING),
    ];
    const result = projectHole(features, VIEWPORT);
    expect(result).not.toBeNull();
    for (const poly of result!.polygons) {
      for (const [x, y] of poly.points) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(VIEWPORT.width);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(VIEWPORT.height);
      }
    }
  });

  it('respects padding: all SVG points are within padding bounds', () => {
    const P = VIEWPORT.padding;
    const features = [
      makePolygon('tee', TEE_RING),
      makePolygon('green', GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
    ];
    const result = projectHole(features, VIEWPORT);
    expect(result).not.toBeNull();
    for (const poly of result!.polygons) {
      for (const [x, y] of poly.points) {
        // Allow 1px tolerance for floating-point rounding
        expect(x).toBeGreaterThanOrEqual(P - 1);
        expect(x).toBeLessThanOrEqual(VIEWPORT.width - P + 1);
        expect(y).toBeGreaterThanOrEqual(P - 1);
        expect(y).toBeLessThanOrEqual(VIEWPORT.height - P + 1);
      }
    }
  });

  it('orients hole vertically: green SVG y < tee SVG y (green at top)', () => {
    // The hole goes roughly north: green is north of tee.
    // After orientation, green should be at the TOP of the SVG (lower y value).
    const features = [
      makePolygon('tee', TEE_RING),
      makePolygon('green', GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
    ];
    const result = projectHole(features, VIEWPORT);
    expect(result).not.toBeNull();
    expect(result!.greenPt[1]).toBeLessThan(result!.teePt[1]);
  });

  it('handles a diagonal hole (NE-running) and still orients vertically', () => {
    // Shift the green to the northeast (higher lng AND lat)
    const NE_GREEN_RING: [number, number][] = [
      [BASE_LNG + 0.002, GREEN_LAT],
      [BASE_LNG + 0.003, GREEN_LAT],
      [BASE_LNG + 0.003, GREEN_LAT + 0.0003],
      [BASE_LNG + 0.002, GREEN_LAT + 0.0003],
    ];
    const features = [
      makePolygon('tee', TEE_RING),
      makePolygon('green', NE_GREEN_RING),
    ];
    const result = projectHole(features, VIEWPORT);
    expect(result).not.toBeNull();
    // After rotation, green should still be above tee (lower SVG y)
    expect(result!.greenPt[1]).toBeLessThan(result!.teePt[1]);
    // And the diagram should fill the viewport within padding bounds
    const allX = result!.polygons.flatMap((p) => p.points.map(([x]) => x));
    const allY = result!.polygons.flatMap((p) => p.points.map(([, y]) => y));
    const P = VIEWPORT.padding;
    expect(Math.min(...allX)).toBeGreaterThanOrEqual(P - 1);
    expect(Math.max(...allX)).toBeLessThanOrEqual(VIEWPORT.width - P + 1);
    expect(Math.min(...allY)).toBeGreaterThanOrEqual(P - 1);
    expect(Math.max(...allY)).toBeLessThanOrEqual(VIEWPORT.height - P + 1);
  });

  it('produces polygons in back-to-front render order (fairway before green)', () => {
    const features = [
      makePolygon('green', GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
      makePolygon('tee', TEE_RING),
    ];
    const result = projectHole(features, VIEWPORT);
    expect(result).not.toBeNull();
    const types = result!.polygons.map((p) => p.type);
    const fairwayIdx = types.indexOf('fairway');
    const greenIdx = types.indexOf('green');
    expect(fairwayIdx).toBeLessThan(greenIdx);
  });

  it('line[0] (tee) is in the lower half of viewport, line[1] (green) in upper half', () => {
    const features = [
      makePolygon('tee', TEE_RING),
      makePolygon('green', GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
    ];
    const result = projectHole(features, VIEWPORT);
    expect(result).not.toBeNull();
    const midY = VIEWPORT.height / 2;
    // Tee should be in lower half (y > midY)
    expect(result!.line[0][1]).toBeGreaterThan(midY);
    // Green should be in upper half (y < midY)
    expect(result!.line[1][1]).toBeLessThan(midY);
  });
});

// ── holeLengthYards ────────────────────────────────────────────────────────────

describe('holeLengthYards', () => {
  it('returns 0 for an empty feature list', () => {
    expect(holeLengthYards([])).toBe(0);
  });

  it('returns 0 when no tee or green polygon exists', () => {
    const features = [makePolygon('fairway', FAIRWAY_RING)];
    expect(holeLengthYards(features)).toBe(0);
  });

  it('computes distance from tee centroid to green centroid (~400 yds for our fixture)', () => {
    const features = [
      makePolygon('tee', TEE_RING),
      makePolygon('green', GREEN_RING),
    ];
    const yards = holeLengthYards(features);
    // The tee and green are ~0.0033° of latitude apart ≈ 366 m ≈ 400 yds.
    // Allow ±60 yds tolerance (the centroids are not at the exact ring centres).
    expect(yards).toBeGreaterThan(300);
    expect(yards).toBeLessThan(460);
  });

  it('uses a LineString feature when one is present (preferred over centroid fallback)', () => {
    // A known-length LineString: ~100 m ≈ 109 yds
    const coords: [number, number][] = [
      [BASE_LNG, TEE_LAT],
      [BASE_LNG, TEE_LAT + 0.0009],  // 0.0009° lat ≈ 100 m
    ];
    const features: GeoJSON.Feature[] = [
      makeLineString('hole', coords),
      makePolygon('tee', TEE_RING),
      makePolygon('green', GREEN_RING),
    ];
    const yards = holeLengthYards(features);
    // Should use the LineString: ~109 yds, NOT the 400-yd tee→green distance
    expect(yards).toBeGreaterThan(80);
    expect(yards).toBeLessThan(140);
  });

  it('LineString with a single coordinate returns fallback (< 2 points → skip)', () => {
    const features: GeoJSON.Feature[] = [
      makeLineString('hole', [[BASE_LNG, TEE_LAT]]),
      makePolygon('tee', TEE_RING),
      makePolygon('green', GREEN_RING),
    ];
    const yards = holeLengthYards(features);
    // Should fall back to tee→green centroid (~400 yds)
    expect(yards).toBeGreaterThan(300);
    expect(yards).toBeLessThan(460);
  });

  it('multi-segment LineString: sums all segments', () => {
    // Two segments, each ~50 m → total ~100 m ≈ 109 yds
    const coords: [number, number][] = [
      [BASE_LNG, TEE_LAT],
      [BASE_LNG, TEE_LAT + 0.00045],
      [BASE_LNG, TEE_LAT + 0.0009],
    ];
    const features: GeoJSON.Feature[] = [
      makeLineString('hole', coords),
    ];
    const yards = holeLengthYards(features);
    expect(yards).toBeGreaterThan(80);
    expect(yards).toBeLessThan(140);
  });
});

// ── describeHazards ────────────────────────────────────────────────────────────

describe('describeHazards', () => {
  it('returns empty string for no hazards', () => {
    const features = [
      makePolygon('tee', TEE_RING),
      makePolygon('green', GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
    ];
    expect(describeHazards(features, null)).toBe('');
  });

  it('counts bunkers correctly', () => {
    const features = [
      makePolygon('bunker', BUNKER_RING),
      makePolygon('bunker', WATER_RING), // second bunker, wrong geom but that's OK
    ];
    const desc = describeHazards(features, null);
    expect(desc).toMatch(/2 bunkers/);
  });

  it('includes water in the description', () => {
    const features = [makePolygon('water', WATER_RING)];
    const desc = describeHazards(features, null);
    expect(desc).toMatch(/water/);
  });

  it('combines bunkers and water with ·', () => {
    const features = [
      makePolygon('bunker', BUNKER_RING),
      makePolygon('water', WATER_RING),
    ];
    const desc = describeHazards(features, null);
    expect(desc).toContain('bunker');
    expect(desc).toContain('water');
    expect(desc).toContain('·');
  });

  it('adds side qualifier when projected hole is supplied', () => {
    const features = [
      makePolygon('tee', TEE_RING),
      makePolygon('green', GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
      makePolygon('water', WATER_RING), // water is to the left (lower lng) of centreline
    ];
    const projected = projectHole(features, VIEWPORT) as ProjectedHole;
    expect(projected).not.toBeNull();
    const desc = describeHazards(features, projected);
    // Water should be described as "left" or "right"
    expect(desc).toMatch(/water (left|right)/);
  });

  it('reports singular bunker for exactly 1 bunker', () => {
    const features = [makePolygon('bunker', BUNKER_RING)];
    const desc = describeHazards(features, null);
    expect(desc).toBe('1 bunker');
  });
});

// ── projectLatLng / unprojectPoint round-trip ─────────────────────────────────

/**
 * Helper: build a projected hole and return the params.
 * Uses our standard VIEWPORT and the tee+green+fairway fixture.
 */
function getParams(): ProjectionParams {
  const features = [
    makePolygon('tee', TEE_RING),
    makePolygon('green', GREEN_RING),
    makePolygon('fairway', FAIRWAY_RING),
  ];
  const result = projectHole(features, VIEWPORT) as ProjectedHole;
  return result.params;
}

describe('projectLatLng / unprojectPoint round-trip', () => {
  const params = getParams();

  /** Round-trip a lat/lng through the forward then inverse transform. */
  function roundTrip(lat: number, lng: number): { lat: number; lng: number } {
    const svg = projectLatLng({ lat, lng }, params);
    return unprojectPoint({ x: svg[0], y: svg[1] }, params);
  }

  it('tee centroid round-trips within 1e-7 degrees', () => {
    // Tee centroid is the mean of TEE_RING vertices
    const lat = TEE_LAT + 0.0001;  // approx centroid lat
    const lng = BASE_LNG;
    const rt = roundTrip(lat, lng);
    expect(rt.lat).toBeCloseTo(lat, 7);
    expect(rt.lng).toBeCloseTo(lng, 7);
  });

  it('green centroid round-trips within 1e-7 degrees', () => {
    const lat = GREEN_LAT + 0.00015;
    const lng = BASE_LNG;
    const rt = roundTrip(lat, lng);
    expect(rt.lat).toBeCloseTo(lat, 7);
    expect(rt.lng).toBeCloseTo(lng, 7);
  });

  it('fairway midpoint round-trips within 1e-7 degrees', () => {
    const lat = (TEE_LAT + GREEN_LAT) / 2;
    const lng = BASE_LNG;
    const rt = roundTrip(lat, lng);
    expect(rt.lat).toBeCloseTo(lat, 7);
    expect(rt.lng).toBeCloseTo(lng, 7);
  });

  it('off-centre point (NE of fairway) round-trips within 1e-7 degrees', () => {
    const lat = TEE_LAT + 0.002;
    const lng = BASE_LNG + 0.001;
    const rt = roundTrip(lat, lng);
    expect(rt.lat).toBeCloseTo(lat, 7);
    expect(rt.lng).toBeCloseTo(lng, 7);
  });

  it('projectLatLng returns an SVG point within viewport bounds for an in-hole coord', () => {
    // Tee centroid should land inside the padded area
    const svg = projectLatLng({ lat: TEE_LAT + 0.0001, lng: BASE_LNG }, params);
    const P = VIEWPORT.padding;
    expect(svg[0]).toBeGreaterThanOrEqual(P - 1);
    expect(svg[0]).toBeLessThanOrEqual(VIEWPORT.width - P + 1);
    expect(svg[1]).toBeGreaterThanOrEqual(P - 1);
    expect(svg[1]).toBeLessThanOrEqual(VIEWPORT.height - P + 1);
  });

  it('teePt from projectHole matches projectLatLng applied to teeLatLng', () => {
    const features = [
      makePolygon('tee', TEE_RING),
      makePolygon('green', GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
    ];
    const result = projectHole(features, VIEWPORT) as ProjectedHole;
    expect(result.teeLatLng).not.toBeNull();
    const svg = projectLatLng(result.teeLatLng!, result.params);
    expect(svg[0]).toBeCloseTo(result.teePt[0], 3);
    expect(svg[1]).toBeCloseTo(result.teePt[1], 3);
  });
});

// ── isOnHoleBbox ──────────────────────────────────────────────────────────────

describe('isOnHoleBbox', () => {
  const params = getParams();

  it('a point at the tee centroid is on-hole', () => {
    // Tee centroid is inside the bbox
    expect(isOnHoleBbox({ lat: TEE_LAT + 0.0001, lng: BASE_LNG }, params)).toBe(true);
  });

  it('a point at the green centroid is on-hole', () => {
    expect(isOnHoleBbox({ lat: GREEN_LAT + 0.00015, lng: BASE_LNG }, params)).toBe(true);
  });

  it('a point 28 miles away is NOT on-hole', () => {
    // 28 miles ≈ 45 km ≈ 0.40° of latitude — clearly remote
    const remoteLat = TEE_LAT + 0.40;
    const remoteLng = BASE_LNG + 0.40;
    expect(isOnHoleBbox({ lat: remoteLat, lng: remoteLng }, params)).toBe(false);
  });

  it('a point just outside the margin is NOT on-hole', () => {
    // Default margin is 0.006° ≈ 720 yds; go 0.01° away
    const outsideLat = params.minLat - 0.01;
    expect(isOnHoleBbox({ lat: outsideLat, lng: BASE_LNG }, params)).toBe(false);
  });

  it('a point just within the margin IS on-hole', () => {
    // 0.003° inside the default 0.006° margin
    const nearLat = params.minLat - 0.003;
    expect(isOnHoleBbox({ lat: nearLat, lng: BASE_LNG }, params)).toBe(true);
  });

  it('respects a custom margin', () => {
    // With a tiny margin (0.0001°), a point 0.001° outside is NOT on-hole
    const slightlyOutside = params.minLat - 0.001;
    expect(isOnHoleBbox({ lat: slightlyOutside, lng: BASE_LNG }, params, 0.0001)).toBe(false);
    // But with the default 0.006° margin it IS on-hole
    expect(isOnHoleBbox({ lat: slightlyOutside, lng: BASE_LNG }, params)).toBe(true);
  });
});

// ── yardsDistance ─────────────────────────────────────────────────────────────

describe('yardsDistance', () => {
  it('returns 0 for the same point', () => {
    expect(yardsDistance({ lat: TEE_LAT, lng: BASE_LNG }, { lat: TEE_LAT, lng: BASE_LNG })).toBe(0);
  });

  it('tee → green is within expected range for our ~400-yd fixture', () => {
    const d = yardsDistance(
      { lat: TEE_LAT, lng: BASE_LNG },
      { lat: GREEN_LAT, lng: BASE_LNG }
    );
    expect(d).toBeGreaterThan(300);
    expect(d).toBeLessThan(460);
  });

  it('returns a positive integer', () => {
    const d = yardsDistance(
      { lat: TEE_LAT, lng: BASE_LNG },
      { lat: GREEN_LAT, lng: BASE_LNG }
    );
    expect(Number.isInteger(d)).toBe(true);
    expect(d).toBeGreaterThan(0);
  });

  it('is symmetric (d(A,B) ≈ d(B,A))', () => {
    const a = { lat: TEE_LAT, lng: BASE_LNG };
    const b = { lat: GREEN_LAT, lng: BASE_LNG };
    // Haversine is symmetric; integer rounding may differ by at most 1 yd
    expect(Math.abs(yardsDistance(a, b) - yardsDistance(b, a))).toBeLessThanOrEqual(1);
  });
});

// ── Tap-to-measure: distance computation via project+unproject ────────────────

describe('tap-to-measure distance computation', () => {
  it('tapping the tee centroid SVG point gives ~0 yds from tee', () => {
    const features = [
      makePolygon('tee', TEE_RING),
      makePolygon('green', GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
    ];
    const result = projectHole(features, VIEWPORT) as ProjectedHole;
    const { params, teeLatLng } = result;
    expect(teeLatLng).not.toBeNull();

    // Project the tee lat/lng to SVG and back — this is the round-trip the
    // tap handler performs when the user taps on the tee position.
    const svgTee = projectLatLng(teeLatLng!, params);
    const latlng = unprojectPoint({ x: svgTee[0], y: svgTee[1] }, params);
    const fromTee = yardsDistance(teeLatLng!, latlng);

    // Round-trip precision: the distance should be nearly zero (< 1 yd)
    expect(fromTee).toBeLessThanOrEqual(1);
  });

  it('tapping the green centroid SVG point gives ~0 yds to pin', () => {
    const features = [
      makePolygon('tee', TEE_RING),
      makePolygon('green', GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
    ];
    const result = projectHole(features, VIEWPORT) as ProjectedHole;
    const { params, greenLatLng } = result;
    expect(greenLatLng).not.toBeNull();

    const svgGreen = projectLatLng(greenLatLng!, params);
    const latlng = unprojectPoint({ x: svgGreen[0], y: svgGreen[1] }, params);
    const toPin = yardsDistance(latlng, greenLatLng!);

    expect(toPin).toBeLessThanOrEqual(1);
  });

  it('tapping the fairway midpoint gives plausible fromTee + toPin that sum close to hole length', () => {
    const features = [
      makePolygon('tee', TEE_RING),
      makePolygon('green', GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
    ];
    const result = projectHole(features, VIEWPORT) as ProjectedHole;
    const { params, teeLatLng, greenLatLng } = result;
    expect(teeLatLng).not.toBeNull();
    expect(greenLatLng).not.toBeNull();

    // Midpoint between tee and green (approx)
    const midLat = (TEE_LAT + GREEN_LAT) / 2;
    const svgMid = projectLatLng({ lat: midLat, lng: BASE_LNG }, params);
    const midLatLng = unprojectPoint({ x: svgMid[0], y: svgMid[1] }, params);

    const fromTee = yardsDistance(teeLatLng!, midLatLng);
    const toPin = yardsDistance(midLatLng, greenLatLng!);
    const total = fromTee + toPin;
    const holeLen = yardsDistance(teeLatLng!, greenLatLng!);

    // fromTee + toPin via a straight midpoint should equal the hole length
    // (triangle inequality with collinear points → equality).
    // Allow ±5 yds for rounding.
    expect(Math.abs(total - holeLen)).toBeLessThanOrEqual(5);
    // Each leg should be roughly half
    expect(fromTee).toBeGreaterThan(50);
    expect(toPin).toBeGreaterThan(50);
  });
});

// ── RENDER_ORDER: rough + woods at the back ───────────────────────────────────

// A rough ring surrounding the fairway (bigger, encloses it).
const ROUGH_RING: [number, number][] = [
  [BASE_LNG - 0.0015, TEE_LAT - 0.0005],
  [BASE_LNG + 0.0015, TEE_LAT - 0.0005],
  [BASE_LNG + 0.0015, GREEN_LAT + 0.0005],
  [BASE_LNG - 0.0015, GREEN_LAT + 0.0005],
];

// A woods ring bordering the hole close to the corridor.
// Updated from OLD [+0.0015 → +0.0025]° ≈ 126–210 m lateral (excluded by new
// 60 m corridor cap) to a realistic narrow tree row [+0.0003 → +0.0005]° ≈ 25–42 m
// lateral — within the 60 m cap.  The OLD ring represented a forest strip from
// a neighbouring hole; the NEW ring represents the actual tree boundary of THIS hole.
const WOODS_RING: [number, number][] = [
  [BASE_LNG + 0.0003, TEE_LAT],
  [BASE_LNG + 0.0005, TEE_LAT],
  [BASE_LNG + 0.0005, GREEN_LAT],
  [BASE_LNG + 0.0003, GREEN_LAT],
];

describe('RENDER_ORDER — rough and woods go first', () => {
  it('rough comes before fairway in the sorted polygon list', () => {
    const features = [
      makePolygon('tee',     TEE_RING),
      makePolygon('green',   GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
      makePolygon('rough',   ROUGH_RING),
    ];
    const result = projectHole(features, VIEWPORT);
    expect(result).not.toBeNull();
    const types = result!.polygons.map((p) => p.type);
    expect(types.indexOf('rough')).toBeLessThan(types.indexOf('fairway'));
  });

  it('woods comes before fairway in the sorted polygon list', () => {
    const features = [
      makePolygon('tee',     TEE_RING),
      makePolygon('green',   GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
      makePolygon('woods',   WOODS_RING),
    ];
    const result = projectHole(features, VIEWPORT);
    expect(result).not.toBeNull();
    const types = result!.polygons.map((p) => p.type);
    expect(types.indexOf('woods')).toBeLessThan(types.indexOf('fairway'));
  });

  it('rough comes before woods', () => {
    const features = [
      makePolygon('tee',     TEE_RING),
      makePolygon('green',   GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
      makePolygon('rough',   ROUGH_RING),
      makePolygon('woods',   WOODS_RING),
    ];
    const result = projectHole(features, VIEWPORT);
    expect(result).not.toBeNull();
    const types = result!.polygons.map((p) => p.type);
    expect(types.indexOf('rough')).toBeLessThan(types.indexOf('woods'));
  });

  it('rough is the first polygon when it is the outermost layer', () => {
    const features = [
      makePolygon('green',   GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
      makePolygon('tee',     TEE_RING),
      makePolygon('bunker',  BUNKER_RING),
      makePolygon('rough',   ROUGH_RING),
    ];
    const result = projectHole(features, VIEWPORT);
    expect(result).not.toBeNull();
    expect(result!.polygons[0].type).toBe('rough');
  });
});

// ── Tree Point projection ──────────────────────────────────────────────────────

/** Build a minimal GeoJSON Point feature (natural=tree node). */
function makeTreePoint(
  lng: number,
  lat: number
): GeoJSON.Feature {
  return {
    type: 'Feature',
    properties: { featureType: 'tree' },
    geometry: { type: 'Point', coordinates: [lng, lat] },
  };
}

describe('tree Point projection', () => {
  it('projectHole returns trees as an empty array when no Point features', () => {
    const features = [
      makePolygon('tee',     TEE_RING),
      makePolygon('green',   GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
    ];
    const result = projectHole(features, VIEWPORT);
    expect(result).not.toBeNull();
    expect(result!.trees).toEqual([]);
  });

  it('projectHole collects and projects tree Point features', () => {
    const treeLat = (TEE_LAT + GREEN_LAT) / 2;
    // Tree at +0.0005° east ≈ 42 m lateral — within the 60 m CORRIDOR_LATERAL_M cap.
    // (OLD: +0.001° ≈ 84 m — now excluded by the tighter corridor filter.)
    const features = [
      makePolygon('tee',     TEE_RING),
      makePolygon('green',   GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
      makeTreePoint(BASE_LNG + 0.0005, treeLat),
    ];
    const result = projectHole(features, VIEWPORT);
    expect(result).not.toBeNull();
    expect(result!.trees).toHaveLength(1);
    // The projected tree point should be within the viewport bounds.
    const [tx, ty] = result!.trees[0];
    expect(tx).toBeGreaterThanOrEqual(0);
    expect(tx).toBeLessThanOrEqual(VIEWPORT.width);
    expect(ty).toBeGreaterThanOrEqual(0);
    expect(ty).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it('projects multiple tree points within corridor', () => {
    // All three trees are within CORRIDOR_LATERAL_M (60 m) of the corridor axis:
    //   ±0.0004° lng ≈ ±34 m lateral — well within the 60 m cap.
    // OLD fixture used ±0.001–0.002° ≈ 84–168 m lateral, which are now
    // correctly excluded as neighbouring-hole tree strays.
    const features = [
      makePolygon('tee',     TEE_RING),
      makePolygon('green',   GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
      makeTreePoint(BASE_LNG + 0.0004, TEE_LAT + 0.001),
      makeTreePoint(BASE_LNG - 0.0004, TEE_LAT + 0.002),
      makeTreePoint(BASE_LNG + 0.0003, GREEN_LAT - 0.001),
    ];
    const result = projectHole(features, VIEWPORT);
    expect(result).not.toBeNull();
    expect(result!.trees).toHaveLength(3);
  });

  it('polygon count is unaffected by Point features', () => {
    const features = [
      makePolygon('tee',     TEE_RING),
      makePolygon('green',   GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
      makeTreePoint(BASE_LNG, TEE_LAT + 0.001),
    ];
    const result = projectHole(features, VIEWPORT);
    expect(result).not.toBeNull();
    // Only 3 polygons — the tree Point is not added to polygons.
    expect(result!.polygons).toHaveLength(3);
  });

  it('a feature list with only Point features returns null (no polygons)', () => {
    const features = [
      makeTreePoint(BASE_LNG, TEE_LAT),
      makeTreePoint(BASE_LNG, GREEN_LAT),
    ];
    // projectHole needs at least one Polygon to proceed.
    expect(projectHole(features, VIEWPORT)).toBeNull();
  });

  it('tree far off-corridor (80 m+ lateral) is excluded by the corridor filter', () => {
    // Tree at +0.001° east ≈ 84 m lateral — outside the 60 m CORRIDOR_LATERAL_M cap.
    // This simulates a tree row from a neighbouring hole (the original bug).
    const features = [
      makePolygon('tee',     TEE_RING),
      makePolygon('green',   GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
      makeTreePoint(BASE_LNG + 0.001, TEE_LAT + 0.001),   // ~84 m lateral
    ];
    const result = projectHole(features, VIEWPORT);
    expect(result).not.toBeNull();
    // Stray tree must be filtered out
    expect(result!.trees).toHaveLength(0);
  });

  it('tree on-corridor is kept; tree off-corridor is excluded (mixed)', () => {
    const midLat = (TEE_LAT + GREEN_LAT) / 2;
    const features = [
      makePolygon('tee',     TEE_RING),
      makePolygon('green',   GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
      makeTreePoint(BASE_LNG + 0.0004, midLat),   // ~34 m lateral — kept
      makeTreePoint(BASE_LNG + 0.001,  midLat),   // ~84 m lateral — excluded
    ];
    const result = projectHole(features, VIEWPORT);
    expect(result).not.toBeNull();
    // Only the close tree survives
    expect(result!.trees).toHaveLength(1);
  });
});

// ── pointToSegmentDistanceM ───────────────────────────────────────────────────

describe('pointToSegmentDistanceM', () => {
  it('returns 0 for a point on the segment', () => {
    // Midpoint of (0,0)→(0,100): point at (0,50)
    expect(pointToSegmentDistanceM(0, 50, 0, 0, 0, 100)).toBeCloseTo(0, 5);
  });

  it('perpendicular from midpoint: distance = perpendicular offset', () => {
    // N-S segment (0,0)→(0,100); point at (40, 50) → lateral = 40 m
    expect(pointToSegmentDistanceM(40, 50, 0, 0, 0, 100)).toBeCloseTo(40, 5);
  });

  it('point past end clamps to endpoint distance', () => {
    // Segment (0,0)→(0,100); point at (0, 150) → distance to (0,100) = 50 m
    expect(pointToSegmentDistanceM(0, 150, 0, 0, 0, 100)).toBeCloseTo(50, 5);
  });

  it('point before start clamps to start distance', () => {
    // Segment (0,0)→(0,100); point at (0,-30) → distance to (0,0) = 30 m
    expect(pointToSegmentDistanceM(0, -30, 0, 0, 0, 100)).toBeCloseTo(30, 5);
  });

  it('degenerate segment (zero length) returns point distance', () => {
    expect(pointToSegmentDistanceM(3, 4, 0, 0, 0, 0)).toBeCloseTo(5, 5);
  });
});

// ── isInHoleCorridor — the primary corridor guard (pure function) ──────────────

// Reference geometry for corridor tests: a simple N-S hole 400 m long.
// cosLat at 40.7° ≈ 0.7572.  Use raw metre coordinates so the test is
// independent of the lat/lng projection.
//
//   Tee  = (0, 0) m
//   Green = (0, 400) m
//   Corridor: lateral ≤ 60 m, longitudinal in [-40, 440] m
//
const TEE_M: [number, number]  = [0, 0];
const GREEN_M: [number, number] = [0, 400];
const LAT_CAP  = CORRIDOR_LATERAL_M;          // 60 m
const LON_MARGIN = CORRIDOR_LONGITUDINAL_MARGIN_M;  // 40 m

/** Tiny square ring centred at (cx, cy) with half-side s. */
function mRing(cx: number, cy: number, s = 5): [number, number][] {
  return [
    [cx - s, cy - s],
    [cx + s, cy - s],
    [cx + s, cy + s],
    [cx - s, cy + s],
  ];
}

describe('isInHoleCorridor', () => {
  // ── ON-CORRIDOR features (must be KEPT) ────────────────────────────────────

  it('fairway centred on corridor axis is kept', () => {
    // Ring centred at (0, 200) — dead centre of corridor, lateral = 0
    expect(isInHoleCorridor(mRing(0, 200), TEE_M, GREEN_M, LAT_CAP, LON_MARGIN)).toBe(true);
  });

  it('greenside bunker at 50 m lateral is kept', () => {
    // Centroid at (50, 380) — 50 m right of axis, near the green end
    expect(isInHoleCorridor(mRing(50, 380), TEE_M, GREEN_M, LAT_CAP, LON_MARGIN)).toBe(true);
  });

  it('tee-end bunker at 55 m lateral is kept', () => {
    // Centroid at (55, 20) — 55 m right of axis, near the tee (just within 60 m)
    expect(isInHoleCorridor(mRing(55, 20), TEE_M, GREEN_M, LAT_CAP, LON_MARGIN)).toBe(true);
  });

  it('features 35 m behind tee (inside lonMargin) are kept', () => {
    // Centroid at (0, -35) — 35 m south of tee, within the 40 m longitudinal margin
    expect(isInHoleCorridor(mRing(0, -35), TEE_M, GREEN_M, LAT_CAP, LON_MARGIN)).toBe(true);
  });

  it('features 35 m past green (inside lonMargin) are kept', () => {
    // Centroid at (0, 435) — 35 m north of green, within the 40 m margin
    expect(isInHoleCorridor(mRing(0, 435), TEE_M, GREEN_M, LAT_CAP, LON_MARGIN)).toBe(true);
  });

  it('large rough polygon straddling axis is kept (centroid on axis)', () => {
    // Wide ring spanning from -100 to +100 m laterally; centroid at (0,200) — lateral = 0
    const wideRing: [number, number][] = [
      [-100, 0], [100, 0], [100, 400], [-100, 400],
    ];
    expect(isInHoleCorridor(wideRing, TEE_M, GREEN_M, LAT_CAP, LON_MARGIN)).toBe(true);
  });

  // ── OFF-CORRIDOR strays (must be EXCLUDED) ─────────────────────────────────

  it('foreign green 200 m lateral is excluded', () => {
    // Centroid at (200, 200) — 200 m right of axis, beyond 60 m cap
    expect(isInHoleCorridor(mRing(200, 200), TEE_M, GREEN_M, LAT_CAP, LON_MARGIN)).toBe(false);
  });

  it('stray pond 150 m lateral is excluded', () => {
    // Centroid at (-150, 300) — 150 m left of axis
    expect(isInHoleCorridor(mRing(-150, 300), TEE_M, GREEN_M, LAT_CAP, LON_MARGIN)).toBe(false);
  });

  it('tree cluster 80 m lateral is excluded', () => {
    // Centroid at (80, 180) — 80 m lateral, just beyond 60 m cap
    expect(isInHoleCorridor(mRing(80, 180), TEE_M, GREEN_M, LAT_CAP, LON_MARGIN)).toBe(false);
  });

  it('polygon far past the green end (200 m) is excluded', () => {
    // Centroid at (0, 650) — 250 m north of green (way beyond 40 m margin)
    expect(isInHoleCorridor(mRing(0, 650), TEE_M, GREEN_M, LAT_CAP, LON_MARGIN)).toBe(false);
  });

  it('polygon far behind the tee (100 m) is excluded', () => {
    // Centroid at (0, -100) — 100 m south of tee (beyond 40 m margin)
    expect(isInHoleCorridor(mRing(0, -100), TEE_M, GREEN_M, LAT_CAP, LON_MARGIN)).toBe(false);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  it('returns false for an empty ring', () => {
    expect(isInHoleCorridor([], TEE_M, GREEN_M, LAT_CAP, LON_MARGIN)).toBe(false);
  });

  it('handles a single-point ring (tree node)', () => {
    // Tree exactly on the axis midpoint
    expect(isInHoleCorridor([[0, 200]], TEE_M, GREEN_M, LAT_CAP, LON_MARGIN)).toBe(true);
    // Tree 80 m to the side → excluded
    expect(isInHoleCorridor([[80, 200]], TEE_M, GREEN_M, LAT_CAP, LON_MARGIN)).toBe(false);
  });

  it('degenerate hole (tee === green) falls back to radial test', () => {
    const samePt: [number, number] = [0, 0];
    expect(isInHoleCorridor(mRing(0, 0), samePt, samePt, LAT_CAP, LON_MARGIN)).toBe(true);
    expect(isInHoleCorridor(mRing(80, 0), samePt, samePt, LAT_CAP, LON_MARGIN)).toBe(false);
  });

  it('diagonal hole: lateral distance measured perpendicularly, not cardinally', () => {
    // NE-running hole: tee at (0,0), green at (300, 300) ≈ 424 m (45° diagonal)
    // Point at (350, -50) — would be INSIDE a cardinal bbox but is actually
    // ~283 m lateral from the 45° axis → should be excluded.
    const diagTee: [number, number] = [0, 0];
    const diagGreen: [number, number] = [300, 300];
    expect(isInHoleCorridor([[350, -50]], diagTee, diagGreen, LAT_CAP, LON_MARGIN)).toBe(false);
    // Point at (150, 150) — right on the diagonal axis → should be kept
    expect(isInHoleCorridor([[150, 150]], diagTee, diagGreen, LAT_CAP, LON_MARGIN)).toBe(true);
  });
});

// ── Corridor guard: stray polygons outside tee→green corridor are excluded ──────

// A stray fairway far north of the tee→green corridor (longitudinally).
// Tee is at lat 40.740, green at 40.7433.  The stray centroid is at lat ~40.8005 —
// ~6.3 km north of green, well past the 40 m longitudinal margin.
const STRAY_LAT = 40.80;
const STRAY_RING: [number, number][] = [
  [BASE_LNG - 0.001, STRAY_LAT],
  [BASE_LNG + 0.001, STRAY_LAT],
  [BASE_LNG + 0.001, STRAY_LAT + 0.001],
  [BASE_LNG - 0.001, STRAY_LAT + 0.001],
];

describe('corridor guard', () => {
  it('stray fairway outside the corridor is excluded from projected polygons', () => {
    const features = [
      makePolygon('tee',     TEE_RING),
      makePolygon('green',   GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
      makePolygon('fairway', STRAY_RING),  // stray — far north
    ];
    const result = projectHole(features, VIEWPORT);
    expect(result).not.toBeNull();
    // Stray fairway must be excluded: only 3 polygons remain
    expect(result!.polygons).toHaveLength(3);
  });

  it('adding a stray polygon does not inflate the teePt/greenPt positions', () => {
    const normal = [
      makePolygon('tee',     TEE_RING),
      makePolygon('green',   GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
    ];
    const withStray = [
      ...normal,
      makePolygon('bunker', STRAY_RING),  // stray bunker far north
    ];
    const rNormal   = projectHole(normal,    VIEWPORT)!;
    const rWithStray = projectHole(withStray, VIEWPORT)!;
    expect(rNormal).not.toBeNull();
    expect(rWithStray).not.toBeNull();
    // The corridor guard removes the stray; the two projections should be equivalent
    expect(rWithStray.polygons).toHaveLength(rNormal.polygons.length);
    expect(rWithStray.teePt[0]).toBeCloseTo(rNormal.teePt[0], 1);
    expect(rWithStray.teePt[1]).toBeCloseTo(rNormal.teePt[1], 1);
    expect(rWithStray.greenPt[0]).toBeCloseTo(rNormal.greenPt[0], 1);
    expect(rWithStray.greenPt[1]).toBeCloseTo(rNormal.greenPt[1], 1);
  });

  it('a fairway close to the corridor is NOT excluded', () => {
    // This fairway is within the corridor (between tee and green)
    const inCorridor = [
      makePolygon('tee',     TEE_RING),
      makePolygon('green',   GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),  // centroid within corridor bounds
    ];
    const result = projectHole(inCorridor, VIEWPORT);
    expect(result).not.toBeNull();
    // All 3 must survive
    expect(result!.polygons).toHaveLength(3);
  });

  it('tee and green are always kept regardless of corridor filter', () => {
    // Even in a feature list with only tee + green, both survive
    const features = [
      makePolygon('tee',   TEE_RING),
      makePolygon('green', GREEN_RING),
    ];
    const result = projectHole(features, VIEWPORT);
    expect(result).not.toBeNull();
    expect(result!.polygons).toHaveLength(2);
  });
});

// ── nearestGreenCentroid ───────────────────────────────────────────────────────

describe('nearestGreenCentroid', () => {
  /** Build a green polygon centred at (lat, lng) with a small radius. */
  function greenAt(lat: number, lng: number): GeoJSON.Feature {
    const d = 0.0001; // ~11 m
    return {
      type: 'Feature',
      properties: { featureType: 'green' },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [lng - d, lat - d],
          [lng + d, lat - d],
          [lng + d, lat + d],
          [lng - d, lat + d],
          [lng - d, lat - d],
        ]],
      },
    };
  }

  it('returns null when no green features exist', () => {
    const features: GeoJSON.Feature[] = [
      { type: 'Feature', properties: { featureType: 'fairway' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
    ];
    expect(nearestGreenCentroid(features, { lat: 40.745, lng: -73.451 })).toBeNull();
  });

  it('returns the single green centroid when there is only one', () => {
    const target = { lat: 40.745, lng: -73.451 };
    const features = [greenAt(40.745, -73.451)];
    const result = nearestGreenCentroid(features, target);
    expect(result).not.toBeNull();
    // centroid ≈ target (within floating-point rounding of the tiny polygon)
    expect(Math.abs(result!.lat - 40.745)).toBeLessThan(0.001);
    expect(Math.abs(result!.lng - (-73.451))).toBeLessThan(0.001);
  });

  it('returns the closest green centroid when multiple greens exist', () => {
    const target = { lat: 40.745, lng: -73.451 };
    const nearGreen = greenAt(40.7452, -73.4511);   // ≈20 m from target
    const farGreen  = greenAt(40.7500, -73.4600);   // ≈800 m away
    const features  = [nearGreen, farGreen];
    const result = nearestGreenCentroid(features, target);
    expect(result).not.toBeNull();
    // Should pick the near one
    expect(Math.abs(result!.lat - 40.7452)).toBeLessThan(0.001);
  });

  it('ignores non-green polygon features', () => {
    const target = { lat: 40.745, lng: -73.451 };
    const features: GeoJSON.Feature[] = [
      { type: 'Feature', properties: { featureType: 'fairway' }, geometry: { type: 'Polygon', coordinates: [[[target.lng, target.lat], [target.lng + 0.001, target.lat], [target.lng, target.lat + 0.001], [target.lng, target.lat]]] } },
      greenAt(40.750, -73.460),
    ];
    const result = nearestGreenCentroid(features, target);
    expect(result).not.toBeNull();
    // Should return the far green (only green), not the nearby fairway
    expect(Math.abs(result!.lat - 40.750)).toBeLessThan(0.001);
  });
});

// ── projectHole with GolfAPI overrides ────────────────────────────────────────

describe('projectHole — GolfAPI tee/green overrides', () => {
  // Reuse the simple hole geometry (tee at south, green at north) from earlier
  // tests but override with GolfAPI points slightly offset from the OSM centroids.

  const TEE_RING: [number, number][] = [
    [-73.455, 40.743],
    [-73.454, 40.743],
    [-73.454, 40.744],
    [-73.455, 40.744],
  ];
  const GREEN_RING: [number, number][] = [
    [-73.455, 40.748],
    [-73.454, 40.748],
    [-73.454, 40.749],
    [-73.455, 40.749],
  ];
  const VIEWPORT: Viewport = { width: 300, height: 400, padding: 20 };

  function makeFeature(type: string, ring: [number, number][]): GeoJSON.Feature {
    const closed: [number, number][] = [...ring, ring[0]];
    return {
      type: 'Feature',
      properties: { featureType: type },
      geometry: { type: 'Polygon', coordinates: [closed] },
    };
  }

  const features = [
    makeFeature('tee',   TEE_RING),
    makeFeature('fairway', [[-73.455, 40.744], [-73.454, 40.744], [-73.454, 40.748], [-73.455, 40.748]]),
    makeFeature('green', GREEN_RING),
  ];

  it('without overrides: teeLatLng and greenLatLng come from OSM polygon centroids', () => {
    const result = projectHole(features, VIEWPORT);
    expect(result).not.toBeNull();
    // OSM tee centroid ≈ (-73.4545, 40.7435)
    expect(result!.teeLatLng).not.toBeNull();
    expect(result!.teeLatLng!.lat).toBeCloseTo(40.7435, 3);
    expect(result!.greenLatLng).not.toBeNull();
    expect(result!.greenLatLng!.lat).toBeCloseTo(40.7485, 3);
  });

  it('with overrides: teeLatLng and greenLatLng use the GolfAPI points', () => {
    const golfApiTee   = { lat: 40.7431, lng: -73.4548 };
    const golfApiGreen = { lat: 40.7488, lng: -73.4543 };
    const result = projectHole(features, VIEWPORT, {
      teeLngLat:   golfApiTee,
      greenLngLat: golfApiGreen,
    });
    expect(result).not.toBeNull();
    expect(result!.teeLatLng!.lat).toBeCloseTo(golfApiTee.lat, 5);
    expect(result!.teeLatLng!.lng).toBeCloseTo(golfApiTee.lng, 5);
    expect(result!.greenLatLng!.lat).toBeCloseTo(golfApiGreen.lat, 5);
    expect(result!.greenLatLng!.lng).toBeCloseTo(golfApiGreen.lng, 5);
  });

  it('with overrides: OSM polygon shapes are still present in the output', () => {
    const result = projectHole(features, VIEWPORT, {
      teeLngLat:   { lat: 40.7431, lng: -73.4548 },
      greenLngLat: { lat: 40.7488, lng: -73.4543 },
    });
    expect(result).not.toBeNull();
    // All three polygons (tee, fairway, green) should still be in the output
    const types = result!.polygons.map((p) => p.type);
    expect(types).toContain('tee');
    expect(types).toContain('fairway');
    expect(types).toContain('green');
  });

  it('green-only override: only greenLatLng changes, tee stays from OSM', () => {
    const golfApiGreen = { lat: 40.7488, lng: -73.4543 };
    const result = projectHole(features, VIEWPORT, { greenLngLat: golfApiGreen });
    expect(result).not.toBeNull();
    // Green override applied
    expect(result!.greenLatLng!.lat).toBeCloseTo(golfApiGreen.lat, 5);
    // Tee not overridden → OSM centroid
    expect(result!.teeLatLng!.lat).toBeCloseTo(40.7435, 3);
  });

  it('tee-only override: only teeLatLng changes, green stays from OSM', () => {
    const golfApiTee = { lat: 40.7431, lng: -73.4548 };
    const result = projectHole(features, VIEWPORT, { teeLngLat: golfApiTee });
    expect(result).not.toBeNull();
    // Tee override applied
    expect(result!.teeLatLng!.lat).toBeCloseTo(golfApiTee.lat, 5);
    // Green not overridden → OSM centroid
    expect(result!.greenLatLng!.lat).toBeCloseTo(40.7485, 3);
  });
});
