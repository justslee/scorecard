import { describe, it, expect } from 'vitest';
import {
  whsSelection,
  scoreDifferential,
  handicapIndex,
  estimateHandicapFromRounds,
  NEUTRAL_RATING,
  NEUTRAL_SLOPE,
} from './handicap';
import type { Round, Player, HoleInfo, Score } from './types';

// ── whsSelection (official table) ─────────────────────────────────────────────

describe('whsSelection — lowest-N + adjustment table', () => {
  it('returns null below 3 differentials', () => {
    expect(whsSelection(0)).toBeNull();
    expect(whsSelection(2)).toBeNull();
  });
  it('matches the WHS table at each boundary', () => {
    expect(whsSelection(3)).toEqual({ count: 1, adjustment: -2.0 });
    expect(whsSelection(4)).toEqual({ count: 1, adjustment: -1.0 });
    expect(whsSelection(5)).toEqual({ count: 1, adjustment: 0 });
    expect(whsSelection(6)).toEqual({ count: 2, adjustment: -1.0 });
    expect(whsSelection(8)).toEqual({ count: 2, adjustment: 0 });
    expect(whsSelection(11)).toEqual({ count: 3, adjustment: 0 });
    expect(whsSelection(14)).toEqual({ count: 4, adjustment: 0 });
    expect(whsSelection(16)).toEqual({ count: 5, adjustment: 0 });
    expect(whsSelection(18)).toEqual({ count: 6, adjustment: 0 });
    expect(whsSelection(19)).toEqual({ count: 7, adjustment: 0 });
    expect(whsSelection(20)).toEqual({ count: 8, adjustment: 0 });
  });
});

// ── scoreDifferential ─────────────────────────────────────────────────────────

describe('scoreDifferential — (113/slope)(gross − rating)', () => {
  it('is gross − rating at neutral slope 113', () => {
    expect(scoreDifferential(90, 72, 113)).toBe(18.0);
  });
  it('scales by slope and rounds to 1 decimal', () => {
    // (113/125)(85 − 70.5) = 0.904 × 14.5 = 13.108 → 13.1
    expect(scoreDifferential(85, 70.5, 125)).toBe(13.1);
  });
  it('falls back to slope 113 for a non-positive slope', () => {
    expect(scoreDifferential(90, 72, 0)).toBe(18.0);
  });
});

// ── handicapIndex ─────────────────────────────────────────────────────────────

describe('handicapIndex — lowest-N mean + adjustment', () => {
  it('returns null with fewer than 3 differentials', () => {
    expect(handicapIndex([])).toBeNull();
    expect(handicapIndex([18, 20])).toBeNull();
  });
  it('uses the single lowest with −2.0 at exactly 3', () => {
    expect(handicapIndex([22, 18, 20])).toBe(16.0); // 18 + (−2.0)
  });
  it('averages the lowest 2 with −1.0 at 6', () => {
    // lowest 2 of [10..15] = 10,11 → mean 10.5 − 1.0 = 9.5
    expect(handicapIndex([15, 14, 13, 12, 11, 10])).toBe(9.5);
  });
  it('uses the best 8 of 20 (no adjustment)', () => {
    const diffs = Array.from({ length: 20 }, (_, i) => i + 5); // 5..24
    // lowest 8 = 5..12 → mean 8.5
    expect(handicapIndex(diffs)).toBe(8.5);
  });
  it('only considers the most recent 20', () => {
    const recent20 = Array.from({ length: 20 }, () => 30); // all high
    const older = [1, 1, 1]; // would lower it, but must be ignored
    expect(handicapIndex([...recent20, ...older])).toBe(30.0);
  });
});

// ── estimateHandicapFromRounds ────────────────────────────────────────────────

const OWNER = 'p1';

function player(id: string): Player {
  return { id, name: id } as Player;
}

function holes18(): HoleInfo[] {
  return Array.from({ length: 18 }, (_, i) => ({ number: i + 1, par: 4 } as HoleInfo));
}

/** A completed 18-hole round where the owner shoots `gross` total. */
function mkRound(gross: number, extra: Partial<Round> = {}): Round {
  const holes = holes18();
  const base = Math.floor(gross / 18);
  const rem = gross - base * 18; // spread across the first `rem` holes (base+1)
  const scores: Score[] = holes.map((h, i) => ({
    playerId: OWNER,
    holeNumber: h.number,
    strokes: base + (i < rem ? 1 : 0),
  }));
  return {
    id: `r-${gross}-${Math.random()}`,
    courseId: 'c1',
    courseName: 'Test GC',
    date: '2026-01-01',
    players: [player(OWNER)],
    ownerPlayerId: OWNER,
    scores,
    holes,
    status: 'completed',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...extra,
  } as Round;
}

/** A round from an explicit per-hole strokes array (all par-4 holes). */
function mkRoundFromStrokes(strokesPerHole: number[], id: string): Round {
  const holes = holes18();
  const scores: Score[] = holes.map((h, i) => ({
    playerId: OWNER, holeNumber: h.number, strokes: strokesPerHole[i],
  }));
  return { ...mkRound(72, { id }), holes, scores };
}

describe('estimateHandicapFromRounds', () => {
  it('returns null with fewer than 3 eligible rounds', () => {
    expect(estimateHandicapFromRounds([mkRound(90), mkRound(88)])).toBeNull();
  });

  it('caps each hole at par + 5 in the adjusted gross (blow-ups do not inflate it)', () => {
    // 17 par-4 holes at 4, one blow-up of 12 → capped at par+5 = 9.
    const blow = Array.from({ length: 18 }, (_, i) => (i === 0 ? 12 : 4));
    // adjusted gross = 17*4 + min(12, 9) = 77 → diff (77 − 72) = 5.0
    // three identical → lowest 1 (5.0) + (−2.0) = 3.0  (raw gross 80 would give 6.0)
    const rounds = [0, 1, 2].map((i) => mkRoundFromStrokes(blow, `b${i}`));
    expect(estimateHandicapFromRounds(rounds)!.index).toBe(3.0);
  });

  it('computes an index from 3 rounds at neutral defaults', () => {
    // diffs at 72/113: gross − 72 → [18, 16, 14]; lowest 1 = 14, −2.0 → 12.0
    const est = estimateHandicapFromRounds([mkRound(90), mkRound(88), mkRound(86)]);
    expect(est).not.toBeNull();
    expect(est!.roundsUsed).toBe(3);
    expect(est!.index).toBe(12.0);
  });

  it('uses real rating/slope when provided', () => {
    const rounds = [mkRound(90), mkRound(88), mkRound(86)];
    const est = estimateHandicapFromRounds(rounds, () => ({ rating: 70, slope: 130 }));
    // diff = (113/130)(gross − 70): 90→17.4, 88→15.6, 86→13.9; lowest 13.9 − 2.0 = 11.9
    expect(est!.index).toBe(11.9);
  });

  it('skips incomplete rounds, 9-hole rounds, and non-completed rounds', () => {
    const complete = [mkRound(90), mkRound(88), mkRound(86)];
    const nineHole = { ...mkRound(45), holes: holes18().slice(0, 9) } as Round;
    const active = mkRound(80, { status: 'active' });
    const missingHole = mkRound(85);
    missingHole.scores = missingHole.scores.slice(0, 17); // one hole unscored
    const est = estimateHandicapFromRounds([...complete, nineHole, active, missingHole]);
    expect(est!.roundsUsed).toBe(3); // only the 3 complete rounds counted
  });

  it('exposes neutral defaults', () => {
    expect(NEUTRAL_RATING).toBe(72.0);
    expect(NEUTRAL_SLOPE).toBe(113);
  });
});
