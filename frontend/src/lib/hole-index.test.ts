/**
 * Unit tests for hole-index helpers.
 * Pure functions — no DOM, no React, safe in vitest node environment.
 */

import { describe, it, expect } from 'vitest';
import { indexByHoleNumber } from './hole-index';

// Minimal stub that satisfies the T extends { number: number } constraint.
interface StubHole {
  number: number;
  label: string;
}

const HOLES: StubHole[] = [
  { number: 1,  label: 'hole-one'   },
  { number: 2,  label: 'hole-two'   },
  { number: 9,  label: 'hole-nine'  },
  { number: 18, label: 'hole-18'    },
];

describe('indexByHoleNumber', () => {
  it('returns an empty Map for an empty array', () => {
    const index = indexByHoleNumber<StubHole>([]);
    expect(index.size).toBe(0);
  });

  it('indexes every item by its hole number', () => {
    const index = indexByHoleNumber(HOLES);
    expect(index.size).toBe(4);
    expect(index.get(1)?.label).toBe('hole-one');
    expect(index.get(9)?.label).toBe('hole-nine');
    expect(index.get(18)?.label).toBe('hole-18');
  });

  it('returns undefined for a hole number not in the set', () => {
    const index = indexByHoleNumber(HOLES);
    expect(index.get(5)).toBeUndefined();
    expect(index.get(0)).toBeUndefined();
    expect(index.get(19)).toBeUndefined();
  });

  it('handles a single-hole array', () => {
    const index = indexByHoleNumber([{ number: 7, label: 'par-3' }]);
    expect(index.get(7)?.label).toBe('par-3');
    expect(index.size).toBe(1);
  });

  it('last-wins on duplicate hole numbers (defensive)', () => {
    const dupes: StubHole[] = [
      { number: 1, label: 'first-copy'  },
      { number: 1, label: 'second-copy' },
    ];
    const index = indexByHoleNumber(dupes);
    expect(index.size).toBe(1);
    expect(index.get(1)?.label).toBe('second-copy');
  });

  // ── Mapped-course gating: verify the "no mapped course → no index" path ──
  // When resolveMappedCourse() returns null the caller never mounts
  // InlineHoleDiagram, so there is nothing to index. This is tested here as
  // a documentation-level check rather than a code path in hole-index itself.
  it('gracefully handles an empty holes list (course not yet ingested)', () => {
    const index = indexByHoleNumber<StubHole>([]);
    expect(index.get(1)).toBeUndefined();
  });
});
