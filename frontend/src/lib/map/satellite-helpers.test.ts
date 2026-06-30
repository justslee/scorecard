/**
 * Unit tests for satellite map pure helpers.
 *
 * All tests run in Node (no browser, no mapbox-gl) via vitest.
 * Run: cd frontend && npx vitest run src/lib/map/satellite-helpers.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  mapRendererFor,
  holeViewBounds,
  tapMeasureLabel,
  formatFCBLabel,
  annotateOsmFeatures,
  baseStyleUrl,
  osmFillColor,
  osmFillOpacity,
  osmOutlineColor,
  courseDisplayMode,
  parseCenterParams,
} from './satellite-helpers';

// ── mapRendererFor ────────────────────────────────────────────────────────────

describe('mapRendererFor — renderer selection', () => {
  it('returns "mapbox" for a real-looking public token', () => {
    expect(mapRendererFor('pk.eyJ1IjoiZXhhbXBsZSJ9.abc123')).toBe('mapbox');
  });

  it('returns "mapbox" for any non-empty string', () => {
    expect(mapRendererFor('anytokenvalue')).toBe('mapbox');
  });

  it('returns "holediagram" for an empty string', () => {
    expect(mapRendererFor('')).toBe('holediagram');
  });

  it('returns "holediagram" for undefined', () => {
    expect(mapRendererFor(undefined)).toBe('holediagram');
  });

  it('returns "holediagram" for null', () => {
    expect(mapRendererFor(null)).toBe('holediagram');
  });

  it('returns "holediagram" for whitespace-only string', () => {
    expect(mapRendererFor('   ')).toBe('holediagram');
  });

  it('returns "holediagram" for tab/newline whitespace', () => {
    expect(mapRendererFor('\t\n')).toBe('holediagram');
  });
});

// ── holeViewBounds ────────────────────────────────────────────────────────────

describe('holeViewBounds — bounding box computation', () => {
  const tee   = { lat: 40.7430, lng: -73.4546 };
  const green = { lat: 40.7451, lng: -73.4514 };
  const holeCoords = { tee, green };

  it('returns [[lngSW, latSW], [lngNE, latNE]] enclosing tee and green', () => {
    const [[lngSW, latSW], [lngNE, latNE]] = holeViewBounds(holeCoords);
    // SW corner
    expect(lngSW).toBeCloseTo(-73.4546, 4);
    expect(latSW).toBeCloseTo(40.7430, 4);
    // NE corner
    expect(lngNE).toBeCloseTo(-73.4514, 4);
    expect(latNE).toBeCloseTo(40.7451, 4);
  });

  it('sw lat is always ≤ ne lat', () => {
    const [[, latSW], [, latNE]] = holeViewBounds(holeCoords);
    expect(latSW).toBeLessThanOrEqual(latNE);
  });

  it('sw lng is always ≤ ne lng', () => {
    const [[lngSW], [lngNE]] = holeViewBounds(holeCoords);
    expect(lngSW).toBeLessThanOrEqual(lngNE);
  });

  it('expands to include user position when inside existing bbox', () => {
    const user = { lat: 40.7440, lng: -73.4530 }; // inside tee-green box
    const [[lngSW, latSW], [lngNE, latNE]] = holeViewBounds(holeCoords, user);
    // Bounds should not shrink — still the tee-green extents
    expect(lngSW).toBeCloseTo(-73.4546, 4);
    expect(latSW).toBeCloseTo(40.7430, 4);
    expect(lngNE).toBeCloseTo(-73.4514, 4);
    expect(latNE).toBeCloseTo(40.7451, 4);
  });

  it('expands to include user position north of the green', () => {
    const user = { lat: 40.7500, lng: -73.4530 }; // north of green
    const [[, latSW], [, latNE]] = holeViewBounds(holeCoords, user);
    expect(latNE).toBeCloseTo(40.7500, 4); // expanded north
    expect(latSW).toBeCloseTo(40.7430, 4); // tee still SW
  });

  it('expands to include user position west of the tee', () => {
    const user = { lat: 40.7435, lng: -73.4600 }; // west of tee
    const [[lngSW], [lngNE]] = holeViewBounds(holeCoords, user);
    expect(lngSW).toBeCloseTo(-73.4600, 4); // expanded west
    expect(lngNE).toBeCloseTo(-73.4514, 4); // green still NE
  });

  it('works without a tee (green-only hole data)', () => {
    const greenOnly = { green };
    const [[lngSW, latSW], [lngNE, latNE]] = holeViewBounds(greenOnly);
    expect(latSW).toBeCloseTo(40.7451, 4);
    expect(latNE).toBeCloseTo(40.7451, 4);
    expect(lngSW).toBeCloseTo(-73.4514, 4);
    expect(lngNE).toBeCloseTo(-73.4514, 4);
  });

  it('works without a user position (userPos omitted)', () => {
    const [[lngSW, latSW], [lngNE, latNE]] = holeViewBounds(holeCoords);
    expect(latSW).toBeCloseTo(40.7430, 4);
    expect(latNE).toBeCloseTo(40.7451, 4);
    expect(lngSW).toBeCloseTo(-73.4546, 4);
    expect(lngNE).toBeCloseTo(-73.4514, 4);
  });

  it('works with userPos=null (explicit no-position)', () => {
    const [[lngSW, latSW], [lngNE, latNE]] = holeViewBounds(holeCoords, null);
    expect(latSW).toBeCloseTo(40.7430, 4);
    expect(latNE).toBeCloseTo(40.7451, 4);
    expect(lngSW).toBeCloseTo(-73.4546, 4);
    expect(lngNE).toBeCloseTo(-73.4514, 4);
  });
});

// ── tapMeasureLabel ───────────────────────────────────────────────────────────

describe('tapMeasureLabel — distance label formatting', () => {
  it('formats with both tee and pin when tee distance is known', () => {
    expect(tapMeasureLabel(215, 185)).toBe('Tee 215y · Pin 185y');
  });

  it('formats with only pin when fromTeeYards is null', () => {
    expect(tapMeasureLabel(null, 185)).toBe('Pin 185y');
  });

  it('handles 0 pin distance', () => {
    expect(tapMeasureLabel(null, 0)).toBe('Pin 0y');
  });

  it('handles 0 tee distance (tap exactly on the tee)', () => {
    expect(tapMeasureLabel(0, 420)).toBe('Tee 0y · Pin 420y');
  });

  it('rounds large distances to integers', () => {
    // Pure: distances should already be integers from calculateDistance
    expect(tapMeasureLabel(301, 119)).toBe('Tee 301y · Pin 119y');
  });
});

// ── formatFCBLabel ────────────────────────────────────────────────────────────

describe('formatFCBLabel — front/center/back label', () => {
  it('formats three distances separated by · symbols', () => {
    expect(formatFCBLabel(148, 163, 178)).toBe('F 148 · C 163 · B 178');
  });

  it('handles equal values (fallback when front/back absent)', () => {
    expect(formatFCBLabel(163, 163, 163)).toBe('F 163 · C 163 · B 163');
  });

  it('handles single-digit yardages', () => {
    expect(formatFCBLabel(3, 5, 8)).toBe('F 3 · C 5 · B 8');
  });

  it('handles large yardages', () => {
    expect(formatFCBLabel(420, 435, 450)).toBe('F 420 · C 435 · B 450');
  });
});

// ── annotateOsmFeatures ───────────────────────────────────────────────────────

describe('annotateOsmFeatures — OSM feature annotation', () => {
  const makeFeature = (type: string): GeoJSON.Feature => ({
    type: 'Feature',
    properties: { featureType: type },
    geometry: { type: 'Point', coordinates: [0, 0] },
  });

  it('annotates each feature with its hole number', () => {
    const pairs = [
      { holeNumber: 1, features: [makeFeature('green'), makeFeature('fairway')] },
      { holeNumber: 2, features: [makeFeature('tee')] },
    ];
    const result = annotateOsmFeatures(pairs);
    expect(result).toHaveLength(3);
    expect(result[0].properties?.hole).toBe(1);
    expect(result[1].properties?.hole).toBe(1);
    expect(result[2].properties?.hole).toBe(2);
  });

  it('preserves existing properties while adding hole', () => {
    const pairs = [
      { holeNumber: 5, features: [makeFeature('bunker')] },
    ];
    const result = annotateOsmFeatures(pairs);
    expect(result[0].properties?.featureType).toBe('bunker');
    expect(result[0].properties?.hole).toBe(5);
  });

  it('returns an empty array for empty input', () => {
    expect(annotateOsmFeatures([])).toHaveLength(0);
  });

  it('returns an empty array when all holes have empty feature lists', () => {
    const pairs = [
      { holeNumber: 1, features: [] },
      { holeNumber: 2, features: [] },
    ];
    expect(annotateOsmFeatures(pairs)).toHaveLength(0);
  });

  it('does not mutate the original feature objects', () => {
    const feat = makeFeature('green');
    const pairs = [{ holeNumber: 3, features: [feat] }];
    annotateOsmFeatures(pairs);
    // Original should not have hole property
    expect(feat.properties?.hole).toBeUndefined();
  });
});

// ── baseStyleUrl ──────────────────────────────────────────────────────────────

describe('baseStyleUrl — Mapbox style URL selection', () => {
  it('returns empty-v9 for vector mode (blank canvas)', () => {
    expect(baseStyleUrl('vector')).toContain('empty-v9');
  });

  it('returns empty-v9 for satellite mode (raster toggled via custom layer)', () => {
    // Both modes share the same base style; satellite is toggled as a custom layer.
    expect(baseStyleUrl('satellite')).toContain('empty-v9');
  });

  it('always returns a mapbox:// style URL', () => {
    expect(baseStyleUrl('vector')).toMatch(/^mapbox:\/\//);
    expect(baseStyleUrl('satellite')).toMatch(/^mapbox:\/\//);
  });
});

// ── osmFillColor ──────────────────────────────────────────────────────────────

describe('osmFillColor — fill colour by feature type and mode', () => {
  it('vector: green is a muted sage hex', () => {
    const c = osmFillColor('green', 'vector');
    expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    expect(c).toBe('#8cb264');
  });

  it('vector: fairway is lighter sage than green', () => {
    const fairway = osmFillColor('fairway', 'vector');
    const green   = osmFillColor('green', 'vector');
    expect(fairway).not.toBe(green);
    expect(fairway).toBe('#a8c67e');
  });

  it('vector: bunker is a warm sand tone', () => {
    expect(osmFillColor('bunker', 'vector')).toBe('#dec896');
  });

  it('vector: water is a muted slate blue', () => {
    expect(osmFillColor('water', 'vector')).toBe('#6894b4');
  });

  it('vector: unknown type returns a neutral ground tone', () => {
    const c = osmFillColor('unknown', 'vector');
    expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('satellite: green is bright Tailwind green (high contrast over imagery)', () => {
    expect(osmFillColor('green', 'satellite')).toBe('#22c55e');
  });

  it('satellite: unknown type returns a neutral grey', () => {
    const c = osmFillColor('unknown', 'satellite');
    expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

// ── osmFillOpacity ────────────────────────────────────────────────────────────

describe('osmFillOpacity — fill opacity by feature type and mode', () => {
  it('vector: green is near-opaque (0.90)', () => {
    expect(osmFillOpacity('green', 'vector')).toBeCloseTo(0.90, 2);
  });

  it('vector: fairway is slightly transparent (0.82)', () => {
    expect(osmFillOpacity('fairway', 'vector')).toBeCloseTo(0.82, 2);
  });

  it('vector: water is 0.68 (lets paper show faintly through)', () => {
    expect(osmFillOpacity('water', 'vector')).toBeCloseTo(0.68, 2);
  });

  it('vector: unknown type falls back to 1.0', () => {
    expect(osmFillOpacity('unknown', 'vector')).toBeCloseTo(1.0, 2);
  });

  it('satellite: green is 0.40 (subtle over imagery)', () => {
    expect(osmFillOpacity('green', 'satellite')).toBeCloseTo(0.40, 2);
  });

  it('satellite: fairway is 0.18 (barely visible over imagery)', () => {
    expect(osmFillOpacity('fairway', 'satellite')).toBeCloseTo(0.18, 2);
  });

  it('satellite: all opacities are < 0.60 (imagery must show through)', () => {
    for (const t of ['green', 'fairway', 'bunker', 'tee', 'water']) {
      expect(osmFillOpacity(t, 'satellite')).toBeLessThan(0.60);
    }
  });

  it('vector: all opacities are >= 0.65 (fills must be clearly visible)', () => {
    for (const t of ['green', 'fairway', 'bunker', 'water']) {
      expect(osmFillOpacity(t, 'vector')).toBeGreaterThanOrEqual(0.65);
    }
  });
});

// ── osmOutlineColor ───────────────────────────────────────────────────────────

describe('osmOutlineColor — outline colour by feature type and mode', () => {
  it('vector: green outline is T.inkSoft', () => {
    expect(osmOutlineColor('green', 'vector')).toBe('#3a4a38');
  });

  it('vector: water outline is distinct from fill', () => {
    const outline = osmOutlineColor('water', 'vector');
    const fill    = osmFillColor('water', 'vector');
    expect(outline).not.toBe(fill);
  });

  it('satellite: green outline is bright green', () => {
    expect(osmOutlineColor('green', 'satellite')).toBe('#16a34a');
  });

  it('vector and satellite outlines differ for all known types', () => {
    for (const t of ['green', 'fairway', 'bunker', 'water']) {
      expect(osmOutlineColor(t, 'vector')).not.toBe(osmOutlineColor(t, 'satellite'));
    }
  });
});

// ── courseDisplayMode ─────────────────────────────────────────────────────────

describe('courseDisplayMode — which rendering path to take', () => {
  it('returns "ingested" when hasIngestedCourse is true', () => {
    expect(courseDisplayMode({ hasIngestedCourse: true, hasCenterParams: false })).toBe('ingested');
  });

  it('returns "ingested" even when hasCenterParams is also true', () => {
    expect(courseDisplayMode({ hasIngestedCourse: true, hasCenterParams: true })).toBe('ingested');
  });

  it('returns "center-only" when no ingested course but center params present', () => {
    expect(courseDisplayMode({ hasIngestedCourse: false, hasCenterParams: true })).toBe('center-only');
  });

  it('returns "no-data" when neither condition is met', () => {
    expect(courseDisplayMode({ hasIngestedCourse: false, hasCenterParams: false })).toBe('no-data');
  });
});

// ── parseCenterParams ─────────────────────────────────────────────────────────

describe('parseCenterParams — lat/lng/name extraction from URL params', () => {
  function makeGet(params: Record<string, string>) {
    return (key: string) => params[key] ?? null;
  }

  it('returns CenterParams for valid lat/lng', () => {
    const result = parseCenterParams(makeGet({ lat: '40.7430', lng: '-73.4546', name: 'Bethpage Black' }));
    expect(result).not.toBeNull();
    expect(result!.lat).toBeCloseTo(40.7430, 4);
    expect(result!.lng).toBeCloseTo(-73.4546, 4);
    expect(result!.name).toBe('Bethpage Black');
  });

  it('defaults name to empty string when absent', () => {
    const result = parseCenterParams(makeGet({ lat: '40.7430', lng: '-73.4546' }));
    expect(result).not.toBeNull();
    expect(result!.name).toBe('');
  });

  it('returns null when lat is missing', () => {
    expect(parseCenterParams(makeGet({ lng: '-73.4546' }))).toBeNull();
  });

  it('returns null when lng is missing', () => {
    expect(parseCenterParams(makeGet({ lat: '40.7430' }))).toBeNull();
  });

  it('returns null for non-numeric lat', () => {
    expect(parseCenterParams(makeGet({ lat: 'abc', lng: '-73.4546' }))).toBeNull();
  });

  it('returns null for non-numeric lng', () => {
    expect(parseCenterParams(makeGet({ lat: '40.7430', lng: 'NaN' }))).toBeNull();
  });

  it('returns null for lat out of range (> 90)', () => {
    expect(parseCenterParams(makeGet({ lat: '91', lng: '-73.4546' }))).toBeNull();
  });

  it('returns null for lat out of range (< -90)', () => {
    expect(parseCenterParams(makeGet({ lat: '-91', lng: '0' }))).toBeNull();
  });

  it('returns null for lng out of range (> 180)', () => {
    expect(parseCenterParams(makeGet({ lat: '40', lng: '181' }))).toBeNull();
  });

  it('returns null for lng out of range (< -180)', () => {
    expect(parseCenterParams(makeGet({ lat: '40', lng: '-181' }))).toBeNull();
  });

  it('handles zero coordinates (0,0 is valid)', () => {
    const result = parseCenterParams(makeGet({ lat: '0', lng: '0' }));
    expect(result).not.toBeNull();
    expect(result!.lat).toBe(0);
    expect(result!.lng).toBe(0);
  });

  it('handles negative coordinates (southern hemisphere)', () => {
    const result = parseCenterParams(makeGet({ lat: '-33.8688', lng: '151.2093' }));
    expect(result).not.toBeNull();
    expect(result!.lat).toBeCloseTo(-33.8688, 4);
    expect(result!.lng).toBeCloseTo(151.2093, 4);
  });
});
