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
  holeLengthYards,
  describeHazards,
  type Viewport,
  type ProjectedHole,
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
