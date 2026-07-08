/**
 * Unit tests for resolveOpeningShotDistance (lib/caddie/opening-shot.ts).
 *
 * Pure, DOM-free, GPS-free — runs headless via vitest node environment.
 * Covers every branch in specs/caddie-opening-reco-from-tee-plan.md:
 *   - no green -> null (honest early guard)
 *   - plausible GPS -> GPS result, fromTee falsy (GPS wins even with tee present)
 *   - GPS null (denied/timeout) + tee present -> fromTee:true tee result
 *   - GPS present but IMPLAUSIBLE -> falls through to tee fallback (the core
 *     new-behavior case — must NOT return null)
 *   - GPS null + tee null -> null (honest idle)
 *   - tee present but tee->green implausible (>800y) + no GPS -> null (bounds
 *     hold on the tee path too)
 *
 * DO NOT modify opening-shot.ts to make tests pass; fix the logic.
 */

import { describe, it, expect } from 'vitest';
import { resolveOpeningShotDistance } from './opening-shot';

// A real hole: tee and green ~365 yards apart (Pebble Beach-ish coords).
const TEE = { lat: 36.5674, lng: -121.9491 };
const GREEN = { lat: 36.5709, lng: -121.9459 };

// A GPS fix near the green — plausible short-approach distance.
const GPS_NEAR_GREEN = { lat: 36.5706, lng: -121.9462 };

// A GPS fix ~5000y away — implausible (way outside the 800y bound).
const GPS_FAR_AWAY = { lat: 36.62, lng: -121.99 };

describe('resolveOpeningShotDistance', () => {
  it('returns null when the green is missing, regardless of gps/tee', () => {
    expect(resolveOpeningShotDistance(GPS_NEAR_GREEN, TEE, null)).toBeNull();
    expect(resolveOpeningShotDistance(null, TEE, null)).toBeNull();
    expect(resolveOpeningShotDistance(null, null, null)).toBeNull();
  });

  it('plausible GPS wins over tee: returns GPS distance with fromTee falsy', () => {
    const result = resolveOpeningShotDistance(GPS_NEAR_GREEN, TEE, GREEN);
    expect(result).not.toBeNull();
    expect(result!.fromTee).toBeFalsy();
    expect(typeof result!.distanceYards).toBe('number');
    expect(result!.distanceYards).toBeGreaterThanOrEqual(1);
    expect(result!.distanceYards).toBeLessThanOrEqual(800);
  });

  it('gps null (denied/timeout upstream) + tee present -> fromTee:true tee result', () => {
    const result = resolveOpeningShotDistance(null, TEE, GREEN);
    expect(result).not.toBeNull();
    expect(result!.fromTee).toBe(true);
    expect(result!.distanceYards).toBeGreaterThanOrEqual(1);
    expect(result!.distanceYards).toBeLessThanOrEqual(800);
  });

  it('gps present but implausible falls through to the tee fallback (does NOT return null)', () => {
    const result = resolveOpeningShotDistance(GPS_FAR_AWAY, TEE, GREEN);
    expect(result).not.toBeNull();
    expect(result!.fromTee).toBe(true);
    expect(result!.distanceYards).toBeGreaterThanOrEqual(1);
    expect(result!.distanceYards).toBeLessThanOrEqual(800);
  });

  it('gps null + tee null + green present -> null (honest idle)', () => {
    expect(resolveOpeningShotDistance(null, null, GREEN)).toBeNull();
  });

  it('tee present but tee->green distance implausible (>800y) + no gps -> null', () => {
    // Tee coords far enough from the green to exceed the 800y bound.
    const FAR_TEE = { lat: 36.62, lng: -121.99 };
    expect(resolveOpeningShotDistance(null, FAR_TEE, GREEN)).toBeNull();
  });
});
