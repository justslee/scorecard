/**
 * Unit tests for the course-coordinates provider and helpers.
 *
 * Covers:
 *   1. getCourseCoordinates() returns correctly-shaped data for both Bethpage UUIDs.
 *   2. getCourseCoordinates() returns an empty array for unknown courses.
 *   3. Each hole entry has the required fields in the right shape.
 *   4. computeFCBDistances() — reasonable values and fallback when front/back absent.
 *   5. F < C < B ordering (front is closer to the tee than back).
 *
 * Pure unit tests — no React, no browser, no network.
 * Run via `cd frontend && npx vitest run`.
 */

import { describe, it, expect } from 'vitest';
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
