/**
 * Unit tests for buildPlaysLike and formatSignedYards (lib/caddie/plays-like.ts).
 *
 * These run headless (no React, no browser) via vitest node environment.
 * Coverage targets:
 *   - no adjustments (raw === target)
 *   - single elevation adjustment
 *   - multiple adjustments — deltaYards integrity
 *   - wind adjustment surfaced into the wind chip field
 *   - signed-yard formatting (negative, positive, zero)
 *
 * DO NOT modify lib/caddie/plays-like.ts to make tests pass; fix the logic.
 */

import { describe, it, expect } from 'vitest';
import { buildPlaysLike, formatSignedYards } from './plays-like';

// ---------------------------------------------------------------------------
// buildPlaysLike
// ---------------------------------------------------------------------------

describe('buildPlaysLike — no adjustments', () => {
  it('raw equals target → hasAdjustment false, deltaYards 0, no rows', () => {
    const result = buildPlaysLike({ raw_yards: 185, target_yards: 185, adjustments: [] });
    expect(result.rawYards).toBe(185);
    expect(result.targetYards).toBe(185);
    expect(result.deltaYards).toBe(0);
    expect(result.hasAdjustment).toBe(false);
    expect(result.rows).toHaveLength(0);
    expect(result.wind).toBeUndefined();
  });
});

describe('buildPlaysLike — single elevation adjustment', () => {
  it('returns one row with correct label and signed yards', () => {
    const result = buildPlaysLike({
      raw_yards: 150,
      target_yards: 157,
      adjustments: [{ type: 'elevation', yards: 7, description: 'Uphill — plays longer' }],
    });
    expect(result.deltaYards).toBe(7);
    expect(result.hasAdjustment).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].type).toBe('elevation');
    expect(result.rows[0].label).toBe('Elevation');
    expect(result.rows[0].signedYards).toBe(7);
    expect(result.rows[0].description).toBe('Uphill — plays longer');
    expect(result.wind).toBeUndefined();
  });
});

describe('buildPlaysLike — multiple adjustments', () => {
  it('all rows present and deltaYards matches target − raw', () => {
    const result = buildPlaysLike({
      raw_yards: 185,
      target_yards: 178,
      adjustments: [
        { type: 'wind', yards: -7, description: 'Into wind' },
        { type: 'altitude', yards: 3, description: 'High altitude — ball carries further' },
        { type: 'temperature', yards: -3, description: 'Cool air — slightly less carry' },
      ],
    });
    expect(result.rows).toHaveLength(3);
    // deltaYards = 178 − 185 = −7 (independent of adjustment sum, derived from API values)
    expect(result.deltaYards).toBe(-7);
    expect(result.rows[1].label).toBe('Altitude');
    expect(result.rows[2].label).toBe('Temperature');
  });
});

describe('buildPlaysLike — wind chip', () => {
  it('wind adjustment is surfaced into the wind field', () => {
    const result = buildPlaysLike({
      raw_yards: 185,
      target_yards: 191,
      adjustments: [{ type: 'wind', yards: 6, description: 'Into wind' }],
    });
    expect(result.wind).toBeDefined();
    expect(result.wind!.signedYards).toBe(6);
    expect(result.wind!.description).toBe('Into wind');
  });

  it('wind field is undefined when no wind adjustment is present', () => {
    const result = buildPlaysLike({
      raw_yards: 150,
      target_yards: 157,
      adjustments: [{ type: 'elevation', yards: 7, description: 'Uphill' }],
    });
    expect(result.wind).toBeUndefined();
  });

  it('wind row is still present in rows even when also in wind chip', () => {
    const result = buildPlaysLike({
      raw_yards: 185,
      target_yards: 178,
      adjustments: [{ type: 'wind', yards: -7, description: 'Into wind' }],
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].type).toBe('wind');
    expect(result.wind).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// formatSignedYards
// ---------------------------------------------------------------------------

describe('formatSignedYards', () => {
  it('negative value uses proper minus sign and y suffix', () => {
    expect(formatSignedYards(-7)).toBe('−7y');
  });

  it('positive value uses + prefix and y suffix', () => {
    expect(formatSignedYards(4)).toBe('+4y');
  });

  it('zero returns 0y', () => {
    expect(formatSignedYards(0)).toBe('0y');
  });

  it('large negative rounds correctly', () => {
    expect(formatSignedYards(-15)).toBe('−15y');
  });
});
