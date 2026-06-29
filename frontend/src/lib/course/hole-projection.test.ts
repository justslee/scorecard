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

// A woods ring to the side.
const WOODS_RING: [number, number][] = [
  [BASE_LNG + 0.0015, TEE_LAT],
  [BASE_LNG + 0.0025, TEE_LAT],
  [BASE_LNG + 0.0025, GREEN_LAT],
  [BASE_LNG + 0.0015, GREEN_LAT],
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
    const features = [
      makePolygon('tee',     TEE_RING),
      makePolygon('green',   GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
      makeTreePoint(BASE_LNG + 0.001, treeLat),
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

  it('projects multiple tree points', () => {
    const features = [
      makePolygon('tee',     TEE_RING),
      makePolygon('green',   GREEN_RING),
      makePolygon('fairway', FAIRWAY_RING),
      makeTreePoint(BASE_LNG + 0.001, TEE_LAT + 0.001),
      makeTreePoint(BASE_LNG - 0.001, TEE_LAT + 0.002),
      makeTreePoint(BASE_LNG + 0.002, GREEN_LAT - 0.001),
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
});
