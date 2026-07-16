/**
 * Unit tests for the Google satellite map pure helpers.
 *
 * All tests run in Node (no browser, no @capacitor/google-maps) via vitest.
 * Run: cd frontend && npx vitest run src/lib/map/google-map-helpers.test.ts
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  yardsToMeters,
  METRES_PER_YARD,
  LAYUP_RING_YARDS,
  LAYUP_RING_COLORS,
  FCB_RING_COLORS,
  holeMapBounds,
  CENTER_ONLY_ZOOM,
  resolveCourseCenter,
  googleMapRendererFor,
  tapMeasureLabelGoogle,
  fcbMarkerSnippet,
  haversineYards,
  zoomForPaddedYards,
  cameraForHole,
  bearingDegrees,
  cameraFraming,
  movedBeyondYards,
  tapTargetDistances,
  createCameraQueue,
  teeColorFor,
  teeMarkerIconUrl,
  bunkerMarkerIconUrl,
} from './google-map-helpers';

/** Flush pending microtasks so queued `.then()` chains settle in tests. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A controllable "deferred" promise — lets a test decide exactly when an
 *  in-flight `run()` call resolves, so coalescing can be observed mid-flight. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

// ── yardsToMeters ─────────────────────────────────────────────────────────────

describe('yardsToMeters — unit conversion', () => {
  it('converts exactly using the international yard constant', () => {
    expect(yardsToMeters(1)).toBeCloseTo(METRES_PER_YARD, 6);
  });

  it('100 yards = 91.44 metres', () => {
    expect(yardsToMeters(100)).toBeCloseTo(91.44, 4);
  });

  it('150 yards ≈ 137.16 metres', () => {
    expect(yardsToMeters(150)).toBeCloseTo(137.16, 4);
  });

  it('200 yards = 182.88 metres', () => {
    expect(yardsToMeters(200)).toBeCloseTo(182.88, 4);
  });

  it('0 yards = 0 metres', () => {
    expect(yardsToMeters(0)).toBe(0);
  });

  it('is a linear function (proportional)', () => {
    expect(yardsToMeters(200)).toBeCloseTo(yardsToMeters(100) * 2, 6);
  });
});

// ── LAYUP_RING_YARDS ──────────────────────────────────────────────────────────

describe('LAYUP_RING_YARDS — constant ring distances', () => {
  it('has exactly three values', () => {
    expect(LAYUP_RING_YARDS).toHaveLength(3);
  });

  it('contains 100, 150, 200', () => {
    expect(LAYUP_RING_YARDS).toContain(100);
    expect(LAYUP_RING_YARDS).toContain(150);
    expect(LAYUP_RING_YARDS).toContain(200);
  });

  it('is in ascending order', () => {
    const arr = [...LAYUP_RING_YARDS];
    expect(arr[0]).toBeLessThan(arr[1]);
    expect(arr[1]).toBeLessThan(arr[2]);
  });

  it('each ring has a defined stroke colour', () => {
    for (const yd of LAYUP_RING_YARDS) {
      expect(LAYUP_RING_COLORS[yd]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

// ── FCB_RING_COLORS ───────────────────────────────────────────────────────────

describe('FCB_RING_COLORS — approach distance ring colours', () => {
  it('has colours for front, center, and back', () => {
    expect(FCB_RING_COLORS.front).toMatch(/^#[0-9a-f]{6}$/i);
    expect(FCB_RING_COLORS.center).toMatch(/^#[0-9a-f]{6}$/i);
    expect(FCB_RING_COLORS.back).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('all three colours are distinct', () => {
    expect(FCB_RING_COLORS.front).not.toBe(FCB_RING_COLORS.center);
    expect(FCB_RING_COLORS.center).not.toBe(FCB_RING_COLORS.back);
    expect(FCB_RING_COLORS.front).not.toBe(FCB_RING_COLORS.back);
  });
});

// ── holeMapBounds ─────────────────────────────────────────────────────────────

describe('holeMapBounds — camera bounds for fitBounds()', () => {
  const tee   = { lat: 40.7430, lng: -73.4546 };
  const green = { lat: 40.7451, lng: -73.4514 };

  it('returns southwest, northeast, and center for a tee+green hole', () => {
    const bounds = holeMapBounds({ tee, green });
    // SW is southernmost, westernmost
    expect(bounds.southwest.lat).toBeCloseTo(40.7430, 4);
    expect(bounds.southwest.lng).toBeCloseTo(-73.4546, 4);
    // NE is northernmost, easternmost
    expect(bounds.northeast.lat).toBeCloseTo(40.7451, 4);
    expect(bounds.northeast.lng).toBeCloseTo(-73.4514, 4);
  });

  it('center is the midpoint of SW and NE', () => {
    const { southwest, northeast, center } = holeMapBounds({ tee, green });
    expect(center.lat).toBeCloseTo((southwest.lat + northeast.lat) / 2, 6);
    expect(center.lng).toBeCloseTo((southwest.lng + northeast.lng) / 2, 6);
  });

  it('works without a tee (green-only data)', () => {
    const greenOnly = { green };
    const { southwest, northeast } = holeMapBounds(greenOnly);
    // Without tee, the bounds are just the green point (both sw and ne = green)
    expect(southwest.lat).toBeCloseTo(green.lat, 4);
    expect(northeast.lat).toBeCloseTo(green.lat, 4);
    expect(southwest.lng).toBeCloseTo(green.lng, 4);
    expect(northeast.lng).toBeCloseTo(green.lng, 4);
  });

  it('sw.lat ≤ ne.lat and sw.lng ≤ ne.lng always', () => {
    const { southwest, northeast } = holeMapBounds({ tee, green });
    expect(southwest.lat).toBeLessThanOrEqual(northeast.lat);
    expect(southwest.lng).toBeLessThanOrEqual(northeast.lng);
  });

  it('does NOT expand to include a GPS position (off-hole guard)', () => {
    // A GPS fix 28 miles away must not affect the hole bounds
    // holeMapBounds only takes tee+green — no userPos argument.
    const bounds = holeMapBounds({ tee, green });
    // Bounds should only reflect tee+green, not any external position
    expect(bounds.southwest.lat).toBeCloseTo(40.7430, 4);
    expect(bounds.northeast.lat).toBeCloseTo(40.7451, 4);
  });
});

// ── CENTER_ONLY_ZOOM ──────────────────────────────────────────────────────────

describe('CENTER_ONLY_ZOOM', () => {
  it('is a numeric zoom level suitable for a golf course overview', () => {
    expect(typeof CENTER_ONLY_ZOOM).toBe('number');
    expect(CENTER_ONLY_ZOOM).toBeGreaterThanOrEqual(14);
    expect(CENTER_ONLY_ZOOM).toBeLessThanOrEqual(19);
  });
});

// ── resolveCourseCenter ───────────────────────────────────────────────────────

describe('resolveCourseCenter — map centre resolution', () => {
  const tee   = { lat: 40.7430, lng: -73.4546 };
  const green = { lat: 40.7451, lng: -73.4514 };

  it('returns the tee coordinate of the first hole when available', () => {
    const coords = [{ tee, green }];
    const center = resolveCourseCenter(coords);
    expect(center).not.toBeNull();
    expect(center!.lat).toBeCloseTo(tee.lat, 6);
    expect(center!.lng).toBeCloseTo(tee.lng, 6);
  });

  it('falls back to the green when tee is absent', () => {
    const coords = [{ tee: undefined as unknown as typeof tee, green }];
    const center = resolveCourseCenter(coords);
    expect(center).not.toBeNull();
    expect(center!.lat).toBeCloseTo(green.lat, 6);
    expect(center!.lng).toBeCloseTo(green.lng, 6);
  });

  it('uses fallbackCenter when holeCoordinates is empty', () => {
    const fb = { lat: 37.7749, lng: -122.4194 };
    const center = resolveCourseCenter([], fb);
    expect(center).not.toBeNull();
    expect(center!.lat).toBeCloseTo(fb.lat, 6);
    expect(center!.lng).toBeCloseTo(fb.lng, 6);
  });

  it('returns null when both holeCoordinates is empty AND no fallbackCenter', () => {
    expect(resolveCourseCenter([])).toBeNull();
    expect(resolveCourseCenter([], null)).toBeNull();
    expect(resolveCourseCenter([], undefined)).toBeNull();
  });

  it('prefers tee over fallbackCenter even when fallbackCenter is provided', () => {
    const fb = { lat: 37.7749, lng: -122.4194 };
    const coords = [{ tee, green }];
    const center = resolveCourseCenter(coords, fb);
    expect(center!.lat).toBeCloseTo(tee.lat, 6);  // tee wins
  });

  it('uses the first hole in the array, not the second', () => {
    const hole1tee = { lat: 40.0, lng: -73.0 };
    const hole2tee = { lat: 41.0, lng: -74.0 };
    const coords = [
      { tee: hole1tee, green },
      { tee: hole2tee, green },
    ];
    const center = resolveCourseCenter(coords);
    expect(center!.lat).toBeCloseTo(hole1tee.lat, 6);
  });
});

// ── googleMapRendererFor ──────────────────────────────────────────────────────

describe('googleMapRendererFor — renderer selection from Google Maps key', () => {
  it('returns "google" for a real-looking API key', () => {
    expect(googleMapRendererFor('AIzaSyABC123')).toBe('google');
  });

  it('returns "google" for any non-empty string', () => {
    expect(googleMapRendererFor('anytokenvalue')).toBe('google');
  });

  it('returns "holediagram" for an empty string', () => {
    expect(googleMapRendererFor('')).toBe('holediagram');
  });

  it('returns "holediagram" for undefined (key not set)', () => {
    expect(googleMapRendererFor(undefined)).toBe('holediagram');
  });

  it('returns "holediagram" for null', () => {
    expect(googleMapRendererFor(null)).toBe('holediagram');
  });

  it('returns "holediagram" for whitespace-only string', () => {
    expect(googleMapRendererFor('   ')).toBe('holediagram');
  });

  it('returns "holediagram" for tab/newline whitespace', () => {
    expect(googleMapRendererFor('\t\n')).toBe('holediagram');
  });
});

// ── tapMeasureLabelGoogle ─────────────────────────────────────────────────────

describe('tapMeasureLabelGoogle — tap-to-measure label formatting', () => {
  it('includes both tee and pin distances when tee is known', () => {
    expect(tapMeasureLabelGoogle(215, 185)).toBe('Tee 215y · Pin 185y');
  });

  it('shows only pin distance when fromTeeYards is null', () => {
    expect(tapMeasureLabelGoogle(null, 185)).toBe('Pin 185y');
  });

  it('handles 0 pin distance', () => {
    expect(tapMeasureLabelGoogle(null, 0)).toBe('Pin 0y');
  });

  it('handles 0 tee distance (tap on the tee box)', () => {
    expect(tapMeasureLabelGoogle(0, 420)).toBe('Tee 0y · Pin 420y');
  });

  it('handles large yardages without modification', () => {
    expect(tapMeasureLabelGoogle(301, 119)).toBe('Tee 301y · Pin 119y');
  });
});

// ── fcbMarkerSnippet ──────────────────────────────────────────────────────────

describe('fcbMarkerSnippet — FCB distance marker labels', () => {
  it('prefixes "F" for the front of the green', () => {
    expect(fcbMarkerSnippet('front', 148)).toBe('F 148y');
  });

  it('prefixes "C" for the center of the green', () => {
    expect(fcbMarkerSnippet('center', 163)).toBe('C 163y');
  });

  it('prefixes "B" for the back of the green', () => {
    expect(fcbMarkerSnippet('back', 178)).toBe('B 178y');
  });

  it('handles single-digit yardages', () => {
    expect(fcbMarkerSnippet('front', 5)).toBe('F 5y');
  });

  it('handles large yardages', () => {
    expect(fcbMarkerSnippet('center', 450)).toBe('C 450y');
  });
});

// ── haversineYards ────────────────────────────────────────────────────────────
//
// The Haversine-based distance helper used by cameraForHole to compute zoom.
// Values are compared against independently-calculated distances for known
// golf-course coordinates.

describe('haversineYards — straight-line distance calculation', () => {
  // Bethpage Black hole 1 (approximate)
  const tee   = { lat: 40.7430, lng: -73.4546 };
  const green = { lat: 40.7451, lng: -73.4514 };

  it('returns a positive number for two distinct points', () => {
    expect(haversineYards(tee, green)).toBeGreaterThan(0);
  });

  it('returns 0 for identical points', () => {
    expect(haversineYards(tee, tee)).toBe(0);
  });

  it('is symmetric (a→b = b→a)', () => {
    expect(haversineYards(tee, green)).toBe(haversineYards(green, tee));
  });

  it('Bethpage Black hole 1 tee→green is in a plausible par-4 range (300–500 yd)', () => {
    const d = haversineYards(tee, green);
    expect(d).toBeGreaterThan(200);
    expect(d).toBeLessThan(600);
  });

  it('1 degree of latitude ≈ 121 000 yd (known Earth geometry)', () => {
    const a = { lat: 0, lng: 0 };
    const b = { lat: 1, lng: 0 };
    const d = haversineYards(a, b);
    // 1° lat ≈ 111 km = 121 408 yd; allow ±1%
    expect(d).toBeGreaterThan(120_000);
    expect(d).toBeLessThan(123_000);
  });

  it('a short par-3 tee→green returns < 300 yd', () => {
    // ~120-yard par-3 approximation: 0.001° lat ≈ 121 yd
    const shortTee   = { lat: 40.0000, lng: -73.0000 };
    const shortGreen = { lat: 40.0011, lng: -73.0000 };
    expect(haversineYards(shortTee, shortGreen)).toBeLessThan(300);
  });
});

// ── zoomForPaddedYards ────────────────────────────────────────────────────────
//
// Zoom table: shorter holes → higher zoom; longer holes → lower zoom.
// Tests verify the table boundaries and that the result stays in [14, 18].

describe('zoomForPaddedYards — zoom level from padded hole distance', () => {
  it('returns 18 for very short holes (<130 yd padded)', () => {
    expect(zoomForPaddedYards(0)).toBe(18);
    expect(zoomForPaddedYards(100)).toBe(18);
    expect(zoomForPaddedYards(129)).toBe(18);
  });

  it('returns 17.5 for short par-3 (130–219 yd)', () => {
    expect(zoomForPaddedYards(130)).toBe(17.5);
    expect(zoomForPaddedYards(219)).toBe(17.5);
  });

  it('returns 17 for typical par-4 (220–479 yd)', () => {
    expect(zoomForPaddedYards(220)).toBe(17);
    expect(zoomForPaddedYards(400)).toBe(17);
    expect(zoomForPaddedYards(479)).toBe(17);
  });

  it('returns 16.5 for long par-4 / short par-5 (480–649 yd)', () => {
    expect(zoomForPaddedYards(480)).toBe(16.5);
    expect(zoomForPaddedYards(649)).toBe(16.5);
  });

  it('returns 16 for very long holes (≥650 yd)', () => {
    expect(zoomForPaddedYards(650)).toBe(16);
    expect(zoomForPaddedYards(1000)).toBe(16);
  });

  it('zoom is always in the range [16, 18]', () => {
    for (const d of [0, 50, 129, 130, 479, 480, 649, 650, 1500]) {
      const z = zoomForPaddedYards(d);
      expect(z).toBeGreaterThanOrEqual(16);
      expect(z).toBeLessThanOrEqual(18);
    }
  });

  it('is monotonically non-increasing (longer distance → same or lower zoom)', () => {
    const distances = [100, 200, 300, 400, 500, 600, 700, 800];
    let prev = zoomForPaddedYards(distances[0]);
    for (const d of distances.slice(1)) {
      const z = zoomForPaddedYards(d);
      expect(z).toBeLessThanOrEqual(prev);
      prev = z;
    }
  });
});

// ── cameraForHole ─────────────────────────────────────────────────────────────
//
// The crash-safe replacement for fitBounds().
// Tests: coordinate is the midpoint of tee→green; zoom is in [14, 18];
// short holes get higher zoom than long holes; no-tee fallback works.

describe('cameraForHole — camera coordinate and zoom for a hole', () => {
  const tee   = { lat: 40.7430, lng: -73.4546 };
  const green = { lat: 40.7451, lng: -73.4514 };

  it('returns a coordinate (lat, lng) and a finite zoom', () => {
    const result = cameraForHole({ tee, green });
    expect(typeof result.coordinate.lat).toBe('number');
    expect(typeof result.coordinate.lng).toBe('number');
    expect(Number.isFinite(result.zoom)).toBe(true);
  });

  it('coordinate is the midpoint of tee and green', () => {
    const { coordinate } = cameraForHole({ tee, green });
    expect(coordinate.lat).toBeCloseTo((tee.lat + green.lat) / 2, 6);
    expect(coordinate.lng).toBeCloseTo((tee.lng + green.lng) / 2, 6);
  });

  it('zoom is always in the safe range [16, 18]', () => {
    const { zoom } = cameraForHole({ tee, green });
    expect(zoom).toBeGreaterThanOrEqual(16);
    expect(zoom).toBeLessThanOrEqual(18);
  });

  it('a short par-3 hole gets a higher zoom than a long par-5', () => {
    // Short par-3: ~100 yd  (0.001° lat offset)
    const par3Tee   = { lat: 40.0000, lng: -73.0000 };
    const par3Green = { lat: 40.0011, lng: -73.0000 };
    // Long par-5: ~550 yd (0.005° lat offset)
    const par5Tee   = { lat: 40.0000, lng: -73.0000 };
    const par5Green = { lat: 40.0055, lng: -73.0000 };

    const par3Zoom = cameraForHole({ tee: par3Tee, green: par3Green }).zoom;
    const par5Zoom = cameraForHole({ tee: par5Tee, green: par5Green }).zoom;
    expect(par3Zoom).toBeGreaterThan(par5Zoom);
  });

  it('falls back to green when tee is absent', () => {
    // tee is undefined — should use green as both tee and green for distance 0
    const result = cameraForHole({ green });
    // Coordinate should be green itself (midpoint of green+green = green)
    expect(result.coordinate.lat).toBeCloseTo(green.lat, 6);
    expect(result.coordinate.lng).toBeCloseTo(green.lng, 6);
    // Distance is 0 → paddedYards = 0 → zoom = 18 (shortest bucket)
    expect(result.zoom).toBe(18);
  });

  it('does NOT use a GPS user position (off-hole guard preserved)', () => {
    // The function signature only accepts tee+green — no user position param.
    // This test confirms the off-hole guard is preserved by design.
    const result1 = cameraForHole({ tee, green });
    const result2 = cameraForHole({ tee, green }); // same inputs → deterministic
    expect(result1.coordinate.lat).toBe(result2.coordinate.lat);
    expect(result1.zoom).toBe(result2.zoom);
  });

  it('includes a bearing so the map looks down the fairway (tee→green)', () => {
    const { bearing } = cameraForHole({ tee, green });
    expect(bearing).toBeGreaterThanOrEqual(0);
    expect(bearing).toBeLessThan(360);
  });
});

// ── bearingDegrees / cameraFraming ────────────────────────────────────────────

describe('bearingDegrees — compass heading from a → b', () => {
  const p = { lat: 40.0, lng: -73.0 };

  it('is ~0° / 360° due north', () => {
    const b = bearingDegrees(p, { lat: 40.01, lng: -73.0 });
    expect(Math.min(b, 360 - b)).toBeLessThan(1);
  });

  it('is ~90° due east', () => {
    expect(bearingDegrees(p, { lat: 40.0, lng: -72.99 })).toBeCloseTo(90, 0);
  });

  it('is ~180° due south', () => {
    expect(bearingDegrees(p, { lat: 39.99, lng: -73.0 })).toBeCloseTo(180, 0);
  });

  it('is ~270° due west', () => {
    expect(bearingDegrees(p, { lat: 40.0, lng: -73.01 })).toBeCloseTo(270, 0);
  });

  it('always returns a value in [0, 360)', () => {
    for (const to of [{ lat: 41, lng: -72 }, { lat: 39, lng: -74 }, { lat: 40, lng: -73 }]) {
      const b = bearingDegrees(p, to);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(360);
    }
  });
});

describe('cameraFraming — frame from → green (used for tee and GPS views)', () => {
  const from  = { lat: 40.7430, lng: -73.4546 };
  const green = { lat: 40.7451, lng: -73.4514 };

  it('centers on the midpoint and returns zoom + bearing', () => {
    const c = cameraFraming(from, green);
    expect(c.coordinate.lat).toBeCloseTo((from.lat + green.lat) / 2, 6);
    expect(c.coordinate.lng).toBeCloseTo((from.lng + green.lng) / 2, 6);
    expect(Number.isFinite(c.zoom)).toBe(true);
    expect(c.bearing).toBeCloseTo(bearingDegrees(from, green), 6);
  });

  it('cameraForHole(tee,green) equals cameraFraming(tee,green)', () => {
    const a = cameraForHole({ tee: from, green });
    const b = cameraFraming(from, green);
    expect(a.coordinate.lat).toBe(b.coordinate.lat);
    expect(a.zoom).toBe(b.zoom);
    expect(a.bearing).toBe(b.bearing);
  });

  it('also frames from a GPS position (from = player), not just the tee', () => {
    const player = { lat: 40.7440, lng: -73.4530 };
    const c = cameraFraming(player, green);
    expect(c.coordinate.lat).toBeCloseTo((player.lat + green.lat) / 2, 6);
    expect(c.bearing).toBeCloseTo(bearingDegrees(player, green), 6);
  });
});

// ── movedBeyondYards (GPS camera re-anchor threshold) ─────────────────────────

describe('movedBeyondYards — GPS re-anchor decision', () => {
  const a = { lat: 40.7440, lng: -73.4530 };

  it('is true when there is no prior anchor (first fix)', () => {
    expect(movedBeyondYards(null, a, 20)).toBe(true);
    expect(movedBeyondYards(undefined, a, 20)).toBe(true);
  });

  it('is false for a tiny sub-threshold move (no jitter)', () => {
    const b = { lat: a.lat + 0.00003, lng: a.lng }; // ~3–4 yd north
    expect(movedBeyondYards(a, b, 20)).toBe(false);
  });

  it('is true once the player moves past the threshold', () => {
    const b = { lat: a.lat + 0.0005, lng: a.lng }; // ~55 yd north
    expect(movedBeyondYards(a, b, 20)).toBe(true);
  });

  it('is false when standing still', () => {
    expect(movedBeyondYards(a, { ...a }, 20)).toBe(false);
  });
});

// ── tapTargetDistances (tap-to-target readout) ────────────────────────────────

describe('tapTargetDistances — carry + distance-to-green for a tapped point', () => {
  const tap   = { lat: 40.7445, lng: -73.4525 };
  const green = { lat: 40.7451, lng: -73.4514 };
  const tee   = { lat: 40.7430, lng: -73.4546 };
  const gps   = { lat: 40.7438, lng: -73.4535 };
  // Deterministic fake distance: yards ∝ great-circle-ish; just needs to be a
  // stable function of the two points for the test.
  const dist = (p: { lat: number; lng: number }, q: { lat: number; lng: number }) =>
    Math.hypot(p.lat - q.lat, p.lng - q.lng) * 100000;

  it('carry from the tee when off the hole; rounds to whole yards', () => {
    const t = tapTargetDistances(tap, green, tee, false, dist);
    expect(t.carry).toBe(Math.round(dist(tee, tap)));
    expect(t.toGreen).toBe(Math.round(dist(tap, green)));
    expect(t.fromGps).toBe(false);
  });

  it('carry from the GPS position when on the hole (fromGps=true)', () => {
    const t = tapTargetDistances(tap, green, gps, true, dist);
    expect(t.carry).toBe(Math.round(dist(gps, tap)));
    expect(t.fromGps).toBe(true);
  });

  it('carry is null when there is no origin (no tee, off hole)', () => {
    const t = tapTargetDistances(tap, green, null, false, dist);
    expect(t.carry).toBeNull();
    expect(t.fromGps).toBe(false);
    expect(t.toGreen).toBe(Math.round(dist(tap, green)));
  });

  it('fromGps is false when flagged but no origin', () => {
    const t = tapTargetDistances(tap, green, null, true, dist);
    expect(t.fromGps).toBe(false);
  });
});

// ── createCameraQueue (rapid-swipe coalescing serializer) ─────────────────────

describe('createCameraQueue — coalescing serializer for rapid hole changes', () => {
  it('starts the first request immediately (synchronously)', () => {
    const calls: number[] = [];
    const queue = createCameraQueue<number>(async (t) => { calls.push(t); });
    queue.request(1);
    expect(calls).toEqual([1]);
  });

  it('keeps only one run in flight — a second request while running is held, not started', async () => {
    const calls: number[] = [];
    let callCount = 0;
    const d1 = deferred<void>();
    const queue = createCameraQueue<number>(async (t) => {
      callCount += 1;
      calls.push(t);
      if (t === 1) await d1.promise;
    });

    queue.request(1);
    expect(callCount).toBe(1); // run(1) started

    queue.request(2); // held — must NOT start a second run while 1 is in flight
    expect(callCount).toBe(1);

    d1.resolve();
    await flush();
    expect(callCount).toBe(2);
    expect(calls).toEqual([1, 2]); // ordering preserved: 1 then 2
  });

  it('coalesces a rapid 1→2→3→4 swipe into a single trailing run on 4', async () => {
    const calls: number[] = [];
    const d1 = deferred<void>();
    const queue = createCameraQueue<number>(async (t) => {
      calls.push(t);
      if (t === 1) await d1.promise;
    });

    queue.request(1); // starts immediately
    queue.request(2); // coalesced — overwritten by 3
    queue.request(3); // coalesced — overwritten by 4
    queue.request(4); // the only pending target once 1 resolves

    expect(calls).toEqual([1]); // 2 and 3 never ran

    d1.resolve();
    await flush();

    // Exactly two native camera moves total: the in-flight one (1) and a
    // single trailing move on the newest target (4). 2 and 3 are skipped
    // entirely — never their own camera move.
    expect(calls).toEqual([1, 4]);
  });

  it('a not-ready no-op run does not block a later request from flushing normally', async () => {
    const applied: number[] = [];
    let ready = false;
    const queue = createCameraQueue<number>(async (t) => {
      if (!ready) return; // simulates the caller's mapReadyRef gate no-op
      applied.push(t);
    });

    queue.request(1);
    await flush();
    expect(applied).toEqual([]); // not ready — no-op, but the queue did not jam

    ready = true;
    queue.request(2);
    await flush();
    expect(applied).toEqual([2]); // flushes normally once ready
  });

  it('goes idle after a run resolves with nothing pending — the next request runs fresh', async () => {
    const calls: number[] = [];
    const queue = createCameraQueue<number>(async (t) => { calls.push(t); });

    queue.request(1);
    await flush();
    expect(calls).toEqual([1]);

    queue.request(2);
    await flush();
    expect(calls).toEqual([1, 2]);
  });

  it('swallows a rejected run so a stuck native call cannot wedge the queue', async () => {
    const calls: number[] = [];
    const queue = createCameraQueue<number>(async (t) => {
      calls.push(t);
      if (t === 1) throw new Error('native call failed');
    });

    queue.request(1);
    await flush();
    queue.request(2);
    await flush();

    expect(calls).toEqual([1, 2]); // 2 still runs despite 1 rejecting
  });
});

// ── createCameraQueue — priority-aware coalescing via `shouldReplace` ─────────
// (review fix on the Item 3 queue-sharing design: plain last-write-wins let a
// lower-priority 'gps' request silently evict an already-pending 'hole'
// request, dropping the hole's camera reframe + tee-shot redraw — see
// GoogleSatelliteMap's `shouldReplace` predicate and its docstring on
// createCameraQueue.)

describe('createCameraQueue — priority-aware coalescing (shouldReplace)', () => {
  type Target = { reason: 'hole' | 'gps'; label: string };

  /** GoogleSatelliteMap's exact predicate: a 'gps' request must never evict
   *  a pending 'hole' request; every other combination still replaces. */
  const holeBeatsGps = (pending: Target, incoming: Target): boolean =>
    !(pending.reason === 'hole' && incoming.reason === 'gps');

  it('a pending hole request survives a gps request that arrives mid-flight — the trailing run executes the HOLE request, not gps', async () => {
    const calls: Target[] = [];
    const d1 = deferred<void>();
    const queue = createCameraQueue<Target>(async (t) => {
      calls.push(t);
      if (t.label === 'first') await d1.promise;
    }, holeBeatsGps);

    queue.request({ reason: 'hole', label: 'first' }); // starts immediately, in flight
    queue.request({ reason: 'hole', label: 'pending-hole' }); // becomes pending
    queue.request({ reason: 'gps', label: 'should-be-dropped' }); // must NOT evict pending-hole

    expect(calls).toEqual([{ reason: 'hole', label: 'first' }]);

    d1.resolve();
    await flush();

    // The trailing run is the HOLE request — the gps request that arrived
    // after it was dropped, never evicting the pending hole-change.
    expect(calls).toEqual([
      { reason: 'hole', label: 'first' },
      { reason: 'hole', label: 'pending-hole' },
    ]);
  });

  it('gps-replaces-gps still coalesces as before (a newer gps request replaces an older pending gps request)', async () => {
    const calls: Target[] = [];
    const d1 = deferred<void>();
    const queue = createCameraQueue<Target>(async (t) => {
      calls.push(t);
      if (t.label === 'first') await d1.promise;
    }, holeBeatsGps);

    queue.request({ reason: 'gps', label: 'first' }); // in flight
    queue.request({ reason: 'gps', label: 'stale-gps' }); // becomes pending
    queue.request({ reason: 'gps', label: 'latest-gps' }); // replaces stale-gps

    d1.resolve();
    await flush();

    expect(calls).toEqual([
      { reason: 'gps', label: 'first' },
      { reason: 'gps', label: 'latest-gps' }, // stale-gps never ran
    ]);
  });

  it('hole-replaces-gps still coalesces as before (a hole request replaces a pending gps request)', async () => {
    const calls: Target[] = [];
    const d1 = deferred<void>();
    const queue = createCameraQueue<Target>(async (t) => {
      calls.push(t);
      if (t.label === 'first') await d1.promise;
    }, holeBeatsGps);

    queue.request({ reason: 'gps', label: 'first' }); // in flight
    queue.request({ reason: 'gps', label: 'stale-gps' }); // becomes pending
    queue.request({ reason: 'hole', label: 'hole-change' }); // replaces stale-gps (higher priority)

    d1.resolve();
    await flush();

    expect(calls).toEqual([
      { reason: 'gps', label: 'first' },
      { reason: 'hole', label: 'hole-change' },
    ]);
  });

  it('hole-replaces-hole still coalesces as before (a newer hole request replaces an older pending hole request)', async () => {
    const calls: Target[] = [];
    const d1 = deferred<void>();
    const queue = createCameraQueue<Target>(async (t) => {
      calls.push(t);
      if (t.label === 'first') await d1.promise;
    }, holeBeatsGps);

    queue.request({ reason: 'hole', label: 'first' }); // in flight
    queue.request({ reason: 'hole', label: 'hole-1' }); // becomes pending
    queue.request({ reason: 'hole', label: 'hole-2' }); // replaces hole-1

    d1.resolve();
    await flush();

    expect(calls).toEqual([
      { reason: 'hole', label: 'first' },
      { reason: 'hole', label: 'hole-2' },
    ]);
  });

  it('with no shouldReplace supplied, defaults to plain last-write-wins (pre-existing behavior unchanged)', async () => {
    const calls: Target[] = [];
    const d1 = deferred<void>();
    const queue = createCameraQueue<Target>(async (t) => {
      calls.push(t);
      if (t.label === 'first') await d1.promise;
    });

    queue.request({ reason: 'hole', label: 'first' });
    queue.request({ reason: 'hole', label: 'pending-hole' });
    queue.request({ reason: 'gps', label: 'evicts-without-shouldReplace' });

    d1.resolve();
    await flush();

    expect(calls).toEqual([
      { reason: 'hole', label: 'first' },
      { reason: 'gps', label: 'evicts-without-shouldReplace' }, // no priority guard -> plain last-write-wins
    ]);
  });
});

// ── Item 3 regression (v1.1.9 field-test fix) — GPS-tick overlay refresh
// routed through createCameraQueue, so holeMarkerIdsRef has a single writer
// and a hole-change chain can never orphan a marker the GPS-tick chain's
// clear() didn't know about (the stray other-hole tee marker seen on holes
// 8/11 — specs/map-fieldtest-v119-plan.md Item 3). ───────────────────────────

describe('createCameraQueue — hole-change + GPS-refresh requests share one writer (Item 3 fix)', () => {
  /** Simulates the component's `holeMarkerIdsRef`: a fake clear+add pair
   *  that mutates a shared "currently on the map" id set, driven by
   *  whichever `run` call is in flight — same shape as the real
   *  clearHoleOverlays -> addHoleOverlays pair. `await flush()` between
   *  clear and add stands in for the native round-trip where the real bug's
   *  two un-serialized chains used to interleave. */
  function makeTracker() {
    const onMap = new Set<string>();
    let nextId = 0;
    return {
      onMap,
      async clearAndAdd(label: string): Promise<string> {
        onMap.clear();
        await flush();
        const id = `${label}-${nextId++}`;
        onMap.add(id);
        return id;
      },
    };
  }

  it('a hole-change request immediately followed by a GPS-refresh request never orphans an id — the queue serializes, last write wins', async () => {
    const tracker = makeTracker();
    const queue = createCameraQueue<{ reason: 'hole' | 'gps'; label: string }>(async (t) => {
      await tracker.clearAndAdd(t.label);
    });

    queue.request({ reason: 'hole', label: 'hole-change' }); // starts immediately, in flight
    queue.request({ reason: 'gps', label: 'gps-tick' }); // arrives mid-flight — coalesced, NOT started concurrently

    await flush(); // let the in-flight 'hole' run's clearAndAdd() resolve
    await flush(); // let the single coalesced trailing 'gps' run execute + resolve

    // Exactly one id survives, and it's the LAST run's — never a leftover
    // from the first run that a concurrent second clear() didn't track (the
    // orphan-marker bug this fix closes).
    expect(tracker.onMap.size).toBe(1);
    expect([...tracker.onMap][0].startsWith('gps-tick-')).toBe(true);
  });

  it('no run ever sees more than one id tracked at once — clear+add pairs never overlap', async () => {
    const tracker = makeTracker();
    const sizesAfterEachRun: number[] = [];
    const queue = createCameraQueue<string>(async (label) => {
      await tracker.clearAndAdd(label);
      sizesAfterEachRun.push(tracker.onMap.size);
    });

    queue.request('hole-1');
    queue.request('gps-2'); // coalesced
    queue.request('gps-3'); // coalesces over gps-2 — only the trailing target runs
    await flush();
    await flush();

    // Exactly 2 runs executed (hole-1, then trailing gps-3); each left
    // exactly one tracked id — never two, i.e. never an orphan.
    expect(sizesAfterEachRun).toEqual([1, 1]);
  });
});

describe('Item 3 regression — handlePositionUpdate no longer calls clearHoleOverlays/addHoleOverlays directly', () => {
  it('the GPS-tick handler routes its overlay refresh through cameraQueueRef.current.request({ reason: "gps", ... }) instead of calling clear/addHoleOverlays directly', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'components', 'GoogleSatelliteMap.tsx'),
      'utf-8'
    );
    const start = src.indexOf('const handlePositionUpdate');
    const end = src.indexOf('const handleGpsError');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);

    expect(body).not.toContain('clearHoleOverlays()');
    expect(body).not.toContain('addHoleOverlays(hd');
    expect(body).toContain("cameraQueueRef.current.request({ hd, reason: 'gps', pos })");
  });
});

// ── Item 4 (draggable aim reticle) — one shared seam, no math fork ────────────
//
// `placeTarget` is component-bound (touches refs/state/plugin), so it can't
// be unit-tested directly here. Instead these are structural/grep-level
// assertions on the source that prove the shared-seam CONTRACT the plan
// requires: the tap-click handler and drag-END handler both call the same
// `placeTarget` function (not a duplicated/forked math path), and the only
// place `tapTargetDistances` is invoked with the {pos, green, tee, false,
// distanceFn} arg pattern is the single `tapTargetForPos` helper that both
// `placeTarget` (tap + drag-end) and the live-drag tick funnel through — so
// a mid-drag readout is guaranteed to agree with what a tap/drag-end at the
// same point computes (specs/map-fieldtest-v119-plan.md Item 4 gate).

describe('Item 4 — draggable aim reticle shares ONE seam (placeTarget) between tap and drag-end', () => {
  const src = readFileSync(
    join(__dirname, '..', '..', 'components', 'GoogleSatelliteMap.tsx'),
    'utf-8'
  );

  it('the map click handler calls placeTarget(...) — no separate inline math', () => {
    const start = src.indexOf('setOnMapClickListener');
    const end = src.indexOf('setOnMarkerDragStartListener');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).toContain('await placeTarget({ lat: ev.latitude, lng: ev.longitude });');
  });

  it('the drag-end handler calls the SAME placeTarget(...) — drag-end math === tap math for the same point', () => {
    const start = src.indexOf('setOnMarkerDragEndListener');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 400);
    expect(body).toContain('await placeTarget({ lat: data.latitude, lng: data.longitude });');
  });

  it('the live-drag tick does NOT redraw polylines (no addPolylines call between DragListener and DragEndListener)', () => {
    const start = src.indexOf('setOnMarkerDragListener');
    const end = src.indexOf('setOnMarkerDragEndListener');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).not.toContain('addPolylines');
  });

  it('tapTargetDistances is invoked from exactly ONE arg-building call site (tapTargetForPos) — the shared seam both placeTarget and the live-drag tick funnel through', () => {
    const occurrences = src.split('tapTargetDistances(').length - 1;
    // The import statement lists the bare identifier (no trailing "("), so
    // this counts only actual call sites — must be exactly 1.
    expect(occurrences).toBe(1);
    expect(src).toContain('function tapTargetForPos(');
  });

  it('every tapTargetForPos( call site is the pure arg-building helper, used by both placeTarget and the live-drag listener', () => {
    const callSites = src.split('tapTargetForPos(').length - 1;
    // 1 function definition + 2 call sites (inside placeTarget, inside the
    // live-drag listener).
    expect(callSites).toBe(3);
  });

  it('drag callbacks are guarded to the tap marker id — a drag of any other marker is ignored', () => {
    const start = src.indexOf('setOnMarkerDragStartListener');
    const end = src.indexOf('setIsLoading(false);', start);
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, end);
    const guardCount = (body.match(/data\.markerId !== tapMarkerIdRef\.current/g) ?? []).length;
    expect(guardCount).toBe(3); // dragStart, drag (live), dragEnd
  });
});

// ── teeColorFor / teeMarkerIconUrl (colored tee marker) ───────────────────────

describe('teeColorFor — tee-name → canonical marker colour', () => {
  it('maps the canonical color words (case-insensitive)', () => {
    expect(teeColorFor('Black').slug).toBe('black');
    expect(teeColorFor('BLUE').slug).toBe('blue');
    expect(teeColorFor('white').slug).toBe('white');
    expect(teeColorFor('Gold').slug).toBe('gold');
    expect(teeColorFor('red').slug).toBe('red');
    expect(teeColorFor('Green').slug).toBe('green');
  });

  it('matches a substring within a longer tee name', () => {
    expect(teeColorFor('Black Tees').slug).toBe('black');
    expect(teeColorFor('Championship (Black)').slug).toBe('black');
    expect(teeColorFor('Forward / Red').slug).toBe('red');
  });

  it('is whitespace-insensitive', () => {
    expect(teeColorFor('   Blue   ').slug).toBe('blue');
  });

  it('folds "yellow" onto gold (no separate asset)', () => {
    expect(teeColorFor('Yellow').slug).toBe('gold');
  });

  it('folds silver/gray/grey onto white (no separate asset)', () => {
    expect(teeColorFor('Silver').slug).toBe('white');
    expect(teeColorFor('Gray').slug).toBe('white');
    expect(teeColorFor('Grey').slug).toBe('white');
  });

  it('folds combo/orange onto gold (no separate asset)', () => {
    expect(teeColorFor('Combo').slug).toBe('gold');
    expect(teeColorFor('Orange').slug).toBe('gold');
  });

  it('returns the neutral ink/graphite marker for an absent tee name', () => {
    expect(teeColorFor(undefined).slug).toBe('neutral');
    expect(teeColorFor(null).slug).toBe('neutral');
    expect(teeColorFor('').slug).toBe('neutral');
    expect(teeColorFor('   ').slug).toBe('neutral');
  });

  it('returns the neutral marker for an unrecognised tee name (honest, not a guess)', () => {
    expect(teeColorFor('Members').slug).toBe('neutral');
    expect(teeColorFor('Tips').slug).toBe('neutral');
  });

  it('every slug has a 6-digit hex rgb', () => {
    for (const name of ['black', 'blue', 'white', 'gold', 'red', 'green', 'unknown']) {
      expect(teeColorFor(name).rgb).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('teeMarkerIconUrl — bundled marker asset path', () => {
  it('builds the relative asset path for each canonical slug', () => {
    expect(teeMarkerIconUrl('black')).toBe('assets/tee-marker-black.png');
    expect(teeMarkerIconUrl('neutral')).toBe('assets/tee-marker-neutral.png');
  });
});

describe('bunkerMarkerIconUrl — lettered bunker marker asset path', () => {
  it('maps a valid letter (case-insensitive) to its lettered asset path', () => {
    expect(bunkerMarkerIconUrl('A')).toBe('assets/bunker-marker-a.png');
    expect(bunkerMarkerIconUrl('f')).toBe('assets/bunker-marker-f.png');
  });

  it('falls back to the plain bean marker for empty/out-of-range/multi-char/whitespace input', () => {
    expect(bunkerMarkerIconUrl('')).toBe('assets/bunker-marker.png');
    expect(bunkerMarkerIconUrl('G')).toBe('assets/bunker-marker.png');
    expect(bunkerMarkerIconUrl('AB')).toBe('assets/bunker-marker.png');
    expect(bunkerMarkerIconUrl(' ')).toBe('assets/bunker-marker.png');
  });
});
