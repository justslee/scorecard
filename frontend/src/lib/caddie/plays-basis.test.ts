/**
 * Unit tests for playsBasis (lib/caddie/plays-basis.ts).
 *
 * The heart of the no-fake-data fix (completes cycle 61): in the anchor-only
 * unmapped state the plays basis must resolve to the scorecard yardage — NEVER
 * the illustration placeholder `distance` — and the three real working paths
 * must stay byte-identical. `distance` is intentionally not an input to the
 * helper, so it can never leak into the basis; these tests pin the four state
 * rows.
 *
 * DO NOT modify lib/caddie/plays-basis.ts to make tests pass; fix the logic.
 */

import { describe, it, expect } from 'vitest';
import { playsBasis } from './plays-basis';
import type { FCBDistances } from '../course/course-coordinates';

const fcb = (center: number): FCBDistances => ({ front: center - 8, center, back: center + 8 });

// The illustration placeholder the round page computes for a ~380y hole:
// Math.max(80, 380 - round(380*0.6)) = 152. Any assertion below that a basis
// is NOT this number is proof `distance` never leaked in.
const DISTANCE_PLACEHOLDER = 152;

describe('playsBasis', () => {
  it('(a) GPS path unchanged: fcbLive.center wins for both bases', () => {
    const r = playsBasis({
      fcbLive: fcb(137),
      effectiveCardOnly: false, // ignored — fcbLive short-circuits
      cardYards: 400,
      holeIntel: { effectiveYards: 999 },
      fcbFromTee: fcb(410),
    });
    expect(r.playsBase).toBe(137);
    expect(r.physicsBasisYards).toBe(137);
  });

  it('(b) genuine from-tee unchanged: playsBase = intel effectiveYards, physics basis = RAW tee center (no double-count)', () => {
    const r = playsBasis({
      fcbLive: null,
      effectiveCardOnly: false,
      cardYards: 405,
      holeIntel: { effectiveYards: 418 }, // elevation-composed
      fcbFromTee: fcb(400),
    });
    expect(r.playsBase).toBe(418); // fallback may be elevation-composed
    expect(r.physicsBasisYards).toBe(400); // physics gets the RAW center — never effectiveYards
  });

  it('(b2) from-tee with no intel: both bases = raw tee center', () => {
    const r = playsBasis({
      fcbLive: null,
      effectiveCardOnly: false,
      cardYards: 405,
      holeIntel: null,
      fcbFromTee: fcb(400),
    });
    expect(r.playsBase).toBe(400);
    expect(r.physicsBasisYards).toBe(400);
  });

  it('(c) real card-only unchanged: cardYards for both bases, never distance', () => {
    const r = playsBasis({
      fcbLive: null,
      effectiveCardOnly: true, // fcbSource === 'card'
      cardYards: 372,
      holeIntel: null,
      fcbFromTee: null,
    });
    expect(r.playsBase).toBe(372);
    expect(r.physicsBasisYards).toBe(372);
    expect(r.playsBase).not.toBe(DISTANCE_PLACEHOLDER);
  });

  it('(d) BUG STATE fixed: fcb null + source tee (effectiveCardOnly widened true) → cardYards basis, NEVER distance', () => {
    const r = playsBasis({
      fcbLive: null,
      effectiveCardOnly: true, // widened: fcb == null collapses to card-only
      cardYards: 388,
      holeIntel: null, // no usable intel geometry in this state
      fcbFromTee: null, // the placeholder `distance` used to leak in here
    });
    expect(r.playsBase).toBe(388); // scorecard yardage — honest
    expect(r.physicsBasisYards).toBe(388);
    expect(r.playsBase).not.toBe(DISTANCE_PLACEHOLDER);
  });

  it('(d2) degenerate card-only with no scorecard yardage → null basis (caller renders "—"), never a fabricated number', () => {
    const r = playsBasis({
      fcbLive: null,
      effectiveCardOnly: true,
      cardYards: null,
      holeIntel: null,
      fcbFromTee: null,
    });
    expect(r.playsBase).toBeNull();
    expect(r.physicsBasisYards).toBeNull();
  });

  it('never passes holeIntel.effectiveYards as the physics basis (double-count guard)', () => {
    const r = playsBasis({
      fcbLive: null,
      effectiveCardOnly: false,
      cardYards: 405,
      holeIntel: { effectiveYards: 418 },
      fcbFromTee: fcb(400),
    });
    expect(r.physicsBasisYards).not.toBe(418);
    expect(r.physicsBasisYards).toBe(400);
  });
});
