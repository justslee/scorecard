/**
 * Unit tests for the course-coordinates provider and helpers.
 *
 * Covers:
 *   1. getCourseCoordinates() returns correctly-shaped data for both Bethpage UUIDs.
 *   2. getCourseCoordinates() returns an empty array for unknown courses.
 *   3. Each hole entry has the required fields in the right shape.
 *   4. computeFCBDistances() — reasonable values and fallback when front/back absent.
 *   5. F < C < B ordering (front is closer to the tee than back).
 *   6. Backend-read path: uses backend data when returned; falls back to mock on
 *      empty response or network failure.
 *   7. Frontend NEVER calls GolfAPI directly (no requests to golfapi.io).
 *
 * Pure unit tests — no React, no browser, no live network.
 * Run via `cd frontend && npx vitest run`.
 *
 * Note: the existing Bethpage tests pass via the mock-fallback path because fetch
 * throws (no backend running in the test environment) → catch → MOCK_COORDS.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getCourseCoordinates,
  computeFCBDistances,
  BETHPAGE_BLACK_ID,
  BETHPAGE_RED_ID,
} from './course-coordinates';

// ── getCourseCoordinates ───────────────────────────────────────────────────────

describe('getCourseCoordinates — Bethpage Black', () => {
  it('returns 18 holes', async () => {
    const coords = await getCourseCoordinates(BETHPAGE_BLACK_ID);
    expect(coords).toHaveLength(18);
  });

  it('all holes have holeNumber, green, tee, front, back', async () => {
    const coords = await getCourseCoordinates(BETHPAGE_BLACK_ID);
    for (const c of coords) {
      expect(typeof c.holeNumber).toBe('number');
      expect(c.green).toBeDefined();
      expect(typeof c.green.lat).toBe('number');
      expect(typeof c.green.lng).toBe('number');
      expect(c.tee).toBeDefined();
      expect(c.front).toBeDefined();
      expect(c.back).toBeDefined();
    }
  });

  it('holeNumbers are 1..18 with no duplicates', async () => {
    const coords = await getCourseCoordinates(BETHPAGE_BLACK_ID);
    const nums = coords.map((c) => c.holeNumber).sort((a, b) => a - b);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });

  it('all coordinates are in the Bethpage geographic area (Long Island, NY)', async () => {
    const coords = await getCourseCoordinates(BETHPAGE_BLACK_ID);
    for (const c of coords) {
      // Bethpage is roughly 40.74–40.76°N, 73.46–73.43°W
      expect(c.green.lat).toBeGreaterThan(40.73);
      expect(c.green.lat).toBeLessThan(40.77);
      expect(c.green.lng).toBeLessThan(-73.42);
      expect(c.green.lng).toBeGreaterThan(-73.48);
    }
  });
});

describe('getCourseCoordinates — Bethpage Red', () => {
  it('returns 18 holes', async () => {
    const coords = await getCourseCoordinates(BETHPAGE_RED_ID);
    expect(coords).toHaveLength(18);
  });

  it('all holes have holeNumber, green, tee, front, back', async () => {
    const coords = await getCourseCoordinates(BETHPAGE_RED_ID);
    for (const c of coords) {
      expect(typeof c.holeNumber).toBe('number');
      expect(c.green).toBeDefined();
      expect(c.tee).toBeDefined();
      expect(c.front).toBeDefined();
      expect(c.back).toBeDefined();
    }
  });

  it('holeNumbers are 1..18 with no duplicates', async () => {
    const coords = await getCourseCoordinates(BETHPAGE_RED_ID);
    const nums = coords.map((c) => c.holeNumber).sort((a, b) => a - b);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });
});

describe('getCourseCoordinates — unknown course', () => {
  it('returns empty array for an unrecognised UUID', async () => {
    const coords = await getCourseCoordinates('00000000-0000-0000-0000-000000000000');
    expect(coords).toHaveLength(0);
  });

  it('returns empty array for an empty string', async () => {
    const coords = await getCourseCoordinates('');
    expect(coords).toHaveLength(0);
  });
});

// ── computeFCBDistances ────────────────────────────────────────────────────────

describe('computeFCBDistances — ordering', () => {
  it('front < center < back when front/back are toward-tee / past-green offsets', async () => {
    // Use Bethpage Black hole 1 as a concrete test case.
    const coords = await getCourseCoordinates(BETHPAGE_BLACK_ID);
    const h1 = coords.find((c) => c.holeNumber === 1)!;
    expect(h1).toBeDefined();

    // Measure from the tee position itself.
    const tee = h1.tee!;
    const fcb = computeFCBDistances(tee, h1);

    // Front is closest to the tee (smaller distance), back is farthest.
    expect(fcb.front).toBeLessThan(fcb.center);
    expect(fcb.center).toBeLessThan(fcb.back);
  });

  it('front and back differ from center by roughly 15 yards (the mock offset)', async () => {
    const coords = await getCourseCoordinates(BETHPAGE_BLACK_ID);
    const h5 = coords.find((c) => c.holeNumber === 5)!;
    expect(h5).toBeDefined();

    const tee = h5.tee!;
    const fcb = computeFCBDistances(tee, h5);

    // The mock generates ±15-yard offsets, so the delta should be ≈15 yds.
    // Allow a tolerance of 2 yds for integer rounding + flat-earth approx.
    expect(Math.abs(fcb.center - fcb.front)).toBeGreaterThan(12);
    expect(Math.abs(fcb.center - fcb.front)).toBeLessThan(18);
    expect(Math.abs(fcb.back - fcb.center)).toBeGreaterThan(12);
    expect(Math.abs(fcb.back - fcb.center)).toBeLessThan(18);
  });
});

describe('computeFCBDistances — fallback when front/back absent', () => {
  it('falls back to green center when front and back are missing', () => {
    const pos = { lat: 40.745, lng: -73.452 };
    const coords = {
      green: { lat: 40.746, lng: -73.451 },
      front: undefined,
      back: undefined,
    };
    const fcb = computeFCBDistances(pos, coords);
    // All three should equal the center distance
    expect(fcb.front).toBe(fcb.center);
    expect(fcb.back).toBe(fcb.center);
    expect(fcb.center).toBeGreaterThan(0);
  });
});

describe('computeFCBDistances — from a midpoint position', () => {
  it('all three distances are positive and center is between front and back', async () => {
    const coords = await getCourseCoordinates(BETHPAGE_RED_ID);
    const h9 = coords.find((c) => c.holeNumber === 9)!;
    expect(h9).toBeDefined();

    // Simulate player halfway between tee and green
    const midLat = (h9.tee!.lat + h9.green.lat) / 2;
    const midLng = (h9.tee!.lng + h9.green.lng) / 2;
    const pos = { lat: midLat, lng: midLng };

    const fcb = computeFCBDistances(pos, h9);
    expect(fcb.front).toBeGreaterThan(0);
    expect(fcb.center).toBeGreaterThan(0);
    expect(fcb.back).toBeGreaterThan(0);
    expect(fcb.front).toBeLessThan(fcb.center);
    expect(fcb.center).toBeLessThan(fcb.back);
  });
});

// ── Backend-read path ──────────────────────────────────────────────────────────
// These tests stub `global.fetch` to simulate backend responses without a real
// network connection.  afterEach restores the original fetch.

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Build a fake fetch that returns a 200 JSON response for the golf-coords
 * endpoint and throws for any other URL (including golfapi.io).
 */
function makeFakeFetch(holeData: unknown[]) {
  return vi.fn((url: string) => {
    if (typeof url === 'string' && url.includes('/golf-coords')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ holeData }),
      } as Response);
    }
    // Reject any direct GolfAPI call so tests catch it.
    return Promise.reject(new Error(`Unexpected fetch to: ${url}`));
  });
}

const BACKEND_HOLE_DATA = [
  {
    hole: 1,
    green: { lat: 40.9999, lng: -73.9999 },
    tee: { lat: 40.9998, lng: -73.9998 },
    front: { lat: 40.9997, lng: -73.9997 },
    back: { lat: 41.0000, lng: -74.0000 },
  },
  {
    hole: 2,
    green: { lat: 41.0001, lng: -74.0001 },
    tee: null,
    front: null,
    back: null,
  },
];

describe('getCourseCoordinates — backend-read path', () => {
  it('uses backend data when the endpoint returns holeData', async () => {
    vi.stubGlobal('fetch', makeFakeFetch(BACKEND_HOLE_DATA));

    const coords = await getCourseCoordinates(BETHPAGE_BLACK_ID);

    // Backend data has 2 holes at coordinates that differ from the mock
    expect(coords).toHaveLength(2);
    expect(coords[0].holeNumber).toBe(1);
    expect(coords[0].green.lat).toBeCloseTo(40.9999, 4);
    expect(coords[1].holeNumber).toBe(2);
  });

  it('maps optional tee/front/back to undefined when null in backend response', async () => {
    vi.stubGlobal('fetch', makeFakeFetch(BACKEND_HOLE_DATA));

    const coords = await getCourseCoordinates(BETHPAGE_BLACK_ID);
    const h2 = coords.find((c) => c.holeNumber === 2)!;

    expect(h2.tee).toBeUndefined();
    expect(h2.front).toBeUndefined();
    expect(h2.back).toBeUndefined();
  });

  it('falls back to mock when backend returns empty holeData', async () => {
    vi.stubGlobal('fetch', makeFakeFetch([]));  // empty list

    const coords = await getCourseCoordinates(BETHPAGE_BLACK_ID);

    // Should fall through to MOCK_BLACK (18 holes)
    expect(coords).toHaveLength(18);
    // Verify these are mock coordinates (Bethpage area)
    expect(coords[0].green.lat).toBeGreaterThan(40.73);
  });

  it('falls back to mock when backend fetch throws a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('connection refused'))));

    const coords = await getCourseCoordinates(BETHPAGE_BLACK_ID);

    // Should fall through to mock
    expect(coords).toHaveLength(18);
  });

  it('falls back to mock when backend returns a non-ok status', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({ ok: false, status: 404 } as Response)
    ));

    const coords = await getCourseCoordinates(BETHPAGE_BLACK_ID);

    // Should fall through to mock
    expect(coords).toHaveLength(18);
  });

  it('never calls GolfAPI directly (all requests go to our backend)', async () => {
    // Stub fetch to track all URLs called
    const calledUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      calledUrls.push(url);
      return Promise.reject(new Error('no network'));  // backend unavailable → mock fallback
    }));

    await getCourseCoordinates(BETHPAGE_BLACK_ID);

    // Verify no request went to golfapi.io
    const golfApiCalls = calledUrls.filter((u) => u.includes('golfapi.io'));
    expect(golfApiCalls).toHaveLength(0);

    // The only fetch attempted should be to our own backend
    if (calledUrls.length > 0) {
      expect(calledUrls[0]).toContain('/api/courses/mapped/');
    }
  });
});
