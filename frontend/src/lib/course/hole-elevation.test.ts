/**
 * Unit tests for hole-elevation.ts — pure helpers, no React, no network.
 *
 * Coverage:
 *   extractHoleElevation:
 *     - returns null when features is empty
 *     - returns null when no green feature exists
 *     - returns null when green feature lacks plays_like_yards
 *     - returns correct HoleElevation when all four fields are present
 *     - skips non-green features and finds the first green with data
 *     - returns null when type is present but value is not a number
 *     - handles multiple features; only the first qualifying green is used
 *
 *   formatPlaysLike:
 *     - flat when |yards| < 1
 *     - "plays ~N yds longer ↑" for uphill (positive)
 *     - "plays ~N yds shorter ↓" for downhill (negative)
 *     - rounding: 5.6 → 6, 5.4 → 5
 *     - boundary: exactly 1.0 → longer (not flat)
 *     - boundary: exactly −1.0 → shorter (not flat)
 *     - 0.9 rounds to 1 → longer (not flat)
 *     - −0.9 rounds to −1 → NOT flat? No: abs(round(-0.9)) = abs(-1) = 1 → shorter
 *
 * DO NOT modify hole-elevation.ts to make tests pass — fix the logic.
 */

import { describe, it, expect } from 'vitest';
import { extractHoleElevation, formatPlaysLike } from './hole-elevation';

// ── Fixture helpers ────────────────────────────────────────────────────────────

function makeGreenFeature(
  props: Record<string, unknown> = {},
): GeoJSON.Feature {
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[]] },
    properties: {
      featureType: 'green',
      osm_id: 'way/green_h1',
      tee_elevation_ft:   95.0,
      green_elevation_ft: 110.0,
      delta_ft:           15.0,
      plays_like_yards:    5.0,
      ...props,
    },
  };
}

function makeFairwayFeature(): GeoJSON.Feature {
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[]] },
    properties: {
      featureType: 'fairway',
      osm_id: 'way/fairway_h1',
    },
  };
}

function makeBunkerFeature(): GeoJSON.Feature {
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[]] },
    properties: {
      featureType: 'bunker',
      osm_id: 'way/bunker_h1',
    },
  };
}

// ── extractHoleElevation ──────────────────────────────────────────────────────

describe('extractHoleElevation — no data', () => {
  it('returns null for empty features', () => {
    expect(extractHoleElevation([])).toBeNull();
  });

  it('returns null when no green feature exists', () => {
    expect(extractHoleElevation([makeFairwayFeature(), makeBunkerFeature()])).toBeNull();
  });

  it('returns null when green feature lacks plays_like_yards', () => {
    const green = makeGreenFeature();
    delete (green.properties as Record<string, unknown>)['plays_like_yards'];
    expect(extractHoleElevation([green])).toBeNull();
  });

  it('returns null when plays_like_yards is not a number (e.g. string)', () => {
    const green = makeGreenFeature({ plays_like_yards: 'not-a-number' });
    expect(extractHoleElevation([green])).toBeNull();
  });

  it('returns null when green feature has null properties', () => {
    const feat: GeoJSON.Feature = {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[]] },
      properties: null,
    };
    expect(extractHoleElevation([feat])).toBeNull();
  });
});

describe('extractHoleElevation — happy path', () => {
  it('returns HoleElevation with correct teeElevationFt', () => {
    const result = extractHoleElevation([makeGreenFeature()]);
    expect(result).not.toBeNull();
    expect(result!.teeElevationFt).toBe(95.0);
  });

  it('returns HoleElevation with correct greenElevationFt', () => {
    const result = extractHoleElevation([makeGreenFeature()]);
    expect(result!.greenElevationFt).toBe(110.0);
  });

  it('returns HoleElevation with correct deltaFt', () => {
    const result = extractHoleElevation([makeGreenFeature()]);
    expect(result!.deltaFt).toBe(15.0);
  });

  it('returns HoleElevation with correct playsLikeYards', () => {
    const result = extractHoleElevation([makeGreenFeature()]);
    expect(result!.playsLikeYards).toBe(5.0);
  });

  it('skips non-green features before finding the green', () => {
    const features = [makeFairwayFeature(), makeBunkerFeature(), makeGreenFeature()];
    const result = extractHoleElevation(features);
    expect(result).not.toBeNull();
    expect(result!.playsLikeYards).toBe(5.0);
  });

  it('uses the first qualifying green when multiple greens present', () => {
    const green1 = makeGreenFeature({ plays_like_yards: 5.0, delta_ft: 15.0 });
    const green2 = makeGreenFeature({ plays_like_yards: 3.3, delta_ft: 10.0 });
    const result = extractHoleElevation([green1, green2]);
    expect(result!.playsLikeYards).toBe(5.0);
  });

  it('returns downhill (negative) playsLikeYards correctly', () => {
    const green = makeGreenFeature({
      tee_elevation_ft:   130.0,
      green_elevation_ft: 100.0,
      delta_ft:           -30.0,
      plays_like_yards:   -10.0,
    });
    const result = extractHoleElevation([green]);
    expect(result!.playsLikeYards).toBe(-10.0);
    expect(result!.deltaFt).toBe(-30.0);
  });

  it('handles flat hole (plays_like_yards = 0)', () => {
    const green = makeGreenFeature({
      tee_elevation_ft:   100.0,
      green_elevation_ft: 100.0,
      delta_ft:             0.0,
      plays_like_yards:     0.0,
    });
    const result = extractHoleElevation([green]);
    expect(result!.playsLikeYards).toBe(0.0);
  });
});

// ── formatPlaysLike ───────────────────────────────────────────────────────────

describe('formatPlaysLike — flat cases', () => {
  it('returns "flat" for exactly 0', () => {
    expect(formatPlaysLike(0)).toBe('flat');
  });

  it('returns "flat" for 0.4 (rounds to 0)', () => {
    expect(formatPlaysLike(0.4)).toBe('flat');
  });

  it('returns "flat" for -0.4 (rounds to 0)', () => {
    expect(formatPlaysLike(-0.4)).toBe('flat');
  });
});

describe('formatPlaysLike — uphill (positive)', () => {
  it('returns "plays ~5 yds longer ↑" for 5 yds', () => {
    expect(formatPlaysLike(5)).toBe('plays ~5 yds longer ↑');
  });

  it('returns "plays ~10 yds longer ↑" for 10 yds', () => {
    expect(formatPlaysLike(10)).toBe('plays ~10 yds longer ↑');
  });

  it('rounds 5.6 → 6', () => {
    expect(formatPlaysLike(5.6)).toBe('plays ~6 yds longer ↑');
  });

  it('rounds 5.4 → 5', () => {
    expect(formatPlaysLike(5.4)).toBe('plays ~5 yds longer ↑');
  });

  it('exactly 1.0 → longer (not flat)', () => {
    expect(formatPlaysLike(1.0)).toBe('plays ~1 yds longer ↑');
  });

  it('0.9 rounds to 1 → longer (not flat)', () => {
    // Math.round(0.9) = 1; abs = 1 >= 1
    expect(formatPlaysLike(0.9)).toBe('plays ~1 yds longer ↑');
  });
});

describe('formatPlaysLike — downhill (negative)', () => {
  it('returns "plays ~8 yds shorter ↓" for -8 yds', () => {
    expect(formatPlaysLike(-8)).toBe('plays ~8 yds shorter ↓');
  });

  it('rounds -5.6 → 6', () => {
    expect(formatPlaysLike(-5.6)).toBe('plays ~6 yds shorter ↓');
  });

  it('exactly -1.0 → shorter (not flat)', () => {
    expect(formatPlaysLike(-1.0)).toBe('plays ~1 yds shorter ↓');
  });

  it('-0.9 rounds to -1 → shorter', () => {
    // Math.round(-0.9) = -1; abs(-1) = 1 >= 1
    expect(formatPlaysLike(-0.9)).toBe('plays ~1 yds shorter ↓');
  });
});
