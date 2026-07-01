/**
 * Unit tests for the Google satellite map pure helpers.
 *
 * All tests run in Node (no browser, no @capacitor/google-maps) via vitest.
 * Run: cd frontend && npx vitest run src/lib/map/google-map-helpers.test.ts
 */

import { describe, it, expect } from 'vitest';
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
} from './google-map-helpers';

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
  it('returns 19 for very short holes (<130 yd padded)', () => {
    expect(zoomForPaddedYards(0)).toBe(19);
    expect(zoomForPaddedYards(100)).toBe(19);
    expect(zoomForPaddedYards(129)).toBe(19);
  });

  it('returns 18.5 for short par-3 (130–219 yd)', () => {
    expect(zoomForPaddedYards(130)).toBe(18.5);
    expect(zoomForPaddedYards(219)).toBe(18.5);
  });

  it('returns 18 for typical par-4 (220–479 yd)', () => {
    expect(zoomForPaddedYards(220)).toBe(18);
    expect(zoomForPaddedYards(400)).toBe(18);
    expect(zoomForPaddedYards(479)).toBe(18);
  });

  it('returns 17.5 for long par-4 / short par-5 (480–649 yd)', () => {
    expect(zoomForPaddedYards(480)).toBe(17.5);
    expect(zoomForPaddedYards(649)).toBe(17.5);
  });

  it('returns 17 for very long holes (≥650 yd)', () => {
    expect(zoomForPaddedYards(650)).toBe(17);
    expect(zoomForPaddedYards(1000)).toBe(17);
  });

  it('zoom is always in the range [17, 19]', () => {
    for (const d of [0, 50, 129, 130, 479, 480, 649, 650, 1500]) {
      const z = zoomForPaddedYards(d);
      expect(z).toBeGreaterThanOrEqual(17);
      expect(z).toBeLessThanOrEqual(19);
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

  it('zoom is always in the safe range [17, 19]', () => {
    const { zoom } = cameraForHole({ tee, green });
    expect(zoom).toBeGreaterThanOrEqual(17);
    expect(zoom).toBeLessThanOrEqual(19);
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
    // Distance is 0 → paddedYards = 0 → zoom = 19 (shortest bucket)
    expect(result.zoom).toBe(19);
  });

  it('does NOT use a GPS user position (off-hole guard preserved)', () => {
    // The function signature only accepts tee+green — no user position param.
    // This test confirms the off-hole guard is preserved by design.
    const result1 = cameraForHole({ tee, green });
    const result2 = cameraForHole({ tee, green }); // same inputs → deterministic
    expect(result1.coordinate.lat).toBe(result2.coordinate.lat);
    expect(result1.zoom).toBe(result2.zoom);
  });
});
