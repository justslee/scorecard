import { describe, it, expect } from 'vitest';
import { buildFcbTiles } from './fcb-tiles';
import type { FCBDistances } from './course-coordinates';

const fcb: FCBDistances = { front: 148, center: 162, back: 176 };

describe('buildFcbTiles', () => {
  it('GPS "you" path: shows the live front/center/back unchanged', () => {
    expect(buildFcbTiles({ fcb, fcbSource: 'you', cardYards: 400 })).toEqual({
      front: 148,
      center: 162,
      back: 176,
    });
  });

  it('from-tee path: shows the from-tee front/center/back unchanged', () => {
    expect(buildFcbTiles({ fcb, fcbSource: 'tee', cardYards: 400 })).toEqual({
      front: 148,
      center: 162,
      back: 176,
    });
  });

  it('card-only source: honest — front/back are "—", center is the scorecard yardage', () => {
    expect(buildFcbTiles({ fcb: null, fcbSource: 'card', cardYards: 178 })).toEqual({
      front: '—',
      center: 178,
      back: '—',
    });
  });

  it('card-only source with no card yardage: center falls back to "—", never a number', () => {
    expect(buildFcbTiles({ fcb: null, fcbSource: 'card', cardYards: null })).toEqual({
      front: '—',
      center: '—',
      back: '—',
    });
  });

  // The bug this item fixes: fcb geometry is missing but the source is NOT
  // 'card' (e.g. a round with a course-center anchor but no mapped hole
  // geometry → teeAnchor null → fcbSource "tee"; or the pre-load window). The
  // old code rendered fabricated `distance ± offset` numbers here.
  it('fcb null + non-card source: honest card-only, NEVER a fabricated distance', () => {
    const tiles = buildFcbTiles({ fcb: null, fcbSource: 'tee', cardYards: 425 });
    expect(tiles).toEqual({ front: '—', center: 425, back: '—' });
    // Guard the regression explicitly: no numeric front/back leaked.
    expect(typeof tiles.front).toBe('string');
    expect(typeof tiles.back).toBe('string');
  });

  it('fcb null + "you" source (defensive): still honest card-only, no fabricated number', () => {
    expect(buildFcbTiles({ fcb: null, fcbSource: 'you', cardYards: 300 })).toEqual({
      front: '—',
      center: 300,
      back: '—',
    });
  });
});
