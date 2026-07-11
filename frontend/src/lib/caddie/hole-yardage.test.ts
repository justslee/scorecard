/**
 * Unit tests for lib/caddie/hole-yardage.ts — the shared yardage resolver
 * (specs/caddie-yardage-gps-selected-tee-plan.md §2.1/§4).
 *
 * DO NOT weaken any assertion here to make a test pass; if one looks wrong,
 * the code is wrong (lessons.md #116).
 */

import { describe, it, expect } from 'vitest';
import { resolveHoleYardage, yardageCaption } from './hole-yardage';

describe('resolveHoleYardage — priority order', () => {
  it('GPS fix (already on-hole gated) wins over everything else', () => {
    const resolved = resolveHoleYardage({
      fcbLive: { front: 190, center: 204, back: 218 },
      selectedTeeCardYards: 231,
      selectedTeeGeomYards: 232,
      cardYards: 178,
      par: 3,
    });
    expect(resolved).toEqual({ yards: 204, basis: 'gps' });
  });

  it('no GPS (900y off-hole → caller passes fcbLive: null) falls to the selected-tee basis, never the mock/card', () => {
    const resolved = resolveHoleYardage({
      fcbLive: null, // off-hole GPS never reaches the resolver — caller gates it
      selectedTeeCardYards: 231,
      selectedTeeGeomYards: 232,
      cardYards: 178,
      par: 3,
    });
    expect(resolved.basis).toBe('tee-card');
    expect(resolved.yards).toBe(231);
  });

  it('nothing known at all → honest null, never a fabricated number', () => {
    const resolved = resolveHoleYardage({
      fcbLive: null,
      selectedTeeCardYards: null,
      selectedTeeGeomYards: null,
      cardYards: null,
      par: 3,
    });
    expect(resolved).toEqual({ yards: null, basis: null });
  });

  it('par-3 tee-geom: no card yards anywhere, only selected-tee geometry — resolves exact', () => {
    const resolved = resolveHoleYardage({
      fcbLive: null,
      selectedTeeCardYards: null,
      selectedTeeGeomYards: 232,
      cardYards: null,
      par: 3,
    });
    expect(resolved).toEqual({ yards: 232, basis: 'tee-geom' });
  });

  it('par 4/5 tee-geom: same resolver output as par 3 (the floor/"at least" nuance is caption-only)', () => {
    const resolved = resolveHoleYardage({
      fcbLive: null,
      selectedTeeCardYards: null,
      selectedTeeGeomYards: 470,
      cardYards: null,
      par: 5,
    });
    expect(resolved).toEqual({ yards: 470, basis: 'tee-geom' });
  });

  it('real card snapshot is the last resort before honest null', () => {
    const resolved = resolveHoleYardage({
      fcbLive: null,
      selectedTeeCardYards: null,
      selectedTeeGeomYards: null,
      cardYards: 178,
      par: 3,
    });
    expect(resolved).toEqual({ yards: 178, basis: 'card' });
  });

  it('NEVER accepts the mock illustration constant — the resolver has no such input at all (banned by type shape)', () => {
    // The mock (HoleIllustration.tsx HOLES[2].yards = 178) has no field in
    // ResolveHoleYardageInput it could flow through — this test documents
    // that guarantee structurally, not just behaviorally.
    const resolved = resolveHoleYardage({
      fcbLive: null,
      selectedTeeCardYards: null,
      selectedTeeGeomYards: null,
      cardYards: null,
      par: 3,
    });
    expect(resolved.yards).not.toBe(178);
  });
});

describe('yardageCaption', () => {
  it('gps basis reads "N to the green"', () => {
    expect(yardageCaption({ yards: 204, basis: 'gps' }, 'Black', 3)).toBe('204 to the green');
  });

  it('tee-card basis reads "N yds · tee tees"', () => {
    expect(yardageCaption({ yards: 231, basis: 'tee-card' }, 'Black', 3)).toBe(
      '231 yds · black tees',
    );
  });

  it('tee-geom on a par 3 is exact — no "at least" prefix', () => {
    expect(yardageCaption({ yards: 232, basis: 'tee-geom' }, 'Black', 3)).toBe(
      '232 yds · black tees',
    );
  });

  it('tee-geom on a par 4/5 is a floor — "at least" prefix', () => {
    expect(yardageCaption({ yards: 470, basis: 'tee-geom' }, 'Black', 5)).toBe(
      'at least 470 yds · black tees',
    );
  });

  it('no teeName known → no tee suffix', () => {
    expect(yardageCaption({ yards: 178, basis: 'card' }, null, 3)).toBe('178 yds');
  });

  it('nothing known → honest "—"', () => {
    expect(yardageCaption({ yards: null, basis: null }, 'Black', 3)).toBe('—');
  });
});
