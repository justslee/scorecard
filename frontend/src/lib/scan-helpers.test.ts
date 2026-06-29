// Vitest unit tests for scan-helpers.ts
// Run with: cd frontend && npx vitest run src/lib/scan-helpers.test.ts

import { describe, it, expect } from 'vitest';
import type { ScanScorecardResponse, Player } from '@/lib/types';
import {
  scanResponseToReviewModel,
  buildScoreUpdates,
  type OcrPlayerReview,
} from '@/lib/scan-helpers';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a minimal Player for round membership. */
function rp(id: string, name: string): Player {
  return { id, name };
}

/** Build a minimal ScanScorecardResponse for testing. */
function resp(
  players: string[],
  holes: Array<{ number: number; par?: number | null; scores: Record<string, number | null> }>
): ScanScorecardResponse {
  return {
    players,
    holes: holes.map((h) => ({
      number: h.number,
      par: h.par ?? null,
      scores: h.scores,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// scanResponseToReviewModel — (a) shape conversion
// ─────────────────────────────────────────────────────────────────────────────

describe('scanResponseToReviewModel — shape conversion', () => {
  it('produces one OcrPlayerReview per scanned player', () => {
    const response = resp(['Alice', 'Bob'], [
      { number: 1, par: 4, scores: { Alice: 5, Bob: 4 } },
    ]);
    const result = scanResponseToReviewModel(response, [rp('p1', 'Alice'), rp('p2', 'Bob')]);
    expect(result).toHaveLength(2);
    expect(result[0].ocrName).toBe('Alice');
    expect(result[1].ocrName).toBe('Bob');
  });

  it('places scores at the correct 0-based hole index', () => {
    const response = resp(['Alice'], [
      { number: 1, scores: { Alice: 4 } },
      { number: 5, scores: { Alice: 3 } },
      { number: 18, scores: { Alice: 5 } },
    ]);
    const [row] = scanResponseToReviewModel(response, [rp('p1', 'Alice')]);
    expect(row.scores[0]).toBe(4);   // hole 1 → index 0
    expect(row.scores[4]).toBe(3);   // hole 5 → index 4
    expect(row.scores[17]).toBe(5);  // hole 18 → index 17
    // All other slots should be null
    expect(row.scores[1]).toBeNull();
    expect(row.scores[16]).toBeNull();
  });

  it('always produces exactly 18 score slots', () => {
    const response = resp(['Alice'], [
      { number: 1, scores: { Alice: 4 } },
    ]);
    const [row] = scanResponseToReviewModel(response, [rp('p1', 'Alice')]);
    expect(row.scores).toHaveLength(18);
  });

  it('stores null for blank / unreadable cells', () => {
    const response = resp(['Bob'], [
      { number: 2, scores: { Bob: null } },
    ]);
    const [row] = scanResponseToReviewModel(response, [rp('p2', 'Bob')]);
    expect(row.scores[1]).toBeNull();
  });

  it('stores null for holes missing the player key entirely', () => {
    // The OCR may miss a column for a player.
    const response = resp(['Alice', 'Bob'], [
      { number: 1, scores: { Alice: 4 } }, // Bob not in scores dict
    ]);
    const rows = scanResponseToReviewModel(response, [rp('p1', 'Alice'), rp('p2', 'Bob')]);
    expect(rows[1].scores[0]).toBeNull();
  });

  it('ignores hole numbers outside [1, 18]', () => {
    const response = resp(['Alice'], [
      { number: 0, scores: { Alice: 4 } },   // out of range
      { number: 19, scores: { Alice: 5 } },  // out of range
    ]);
    const [row] = scanResponseToReviewModel(response, [rp('p1', 'Alice')]);
    expect(row.scores.every((s) => s === null)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// scanResponseToReviewModel — (b) player matching
// ─────────────────────────────────────────────────────────────────────────────

describe('scanResponseToReviewModel — player matching', () => {
  it('maps an exact name to the correct round player ID', () => {
    const response = resp(['Alice'], [{ number: 1, scores: { Alice: 4 } }]);
    const [row] = scanResponseToReviewModel(response, [rp('p1', 'Alice'), rp('p2', 'Bob')]);
    expect(row.mappedPlayerId).toBe('p1');
  });

  it('is case-insensitive on exact matches', () => {
    const response = resp(['alice'], [{ number: 1, scores: { alice: 4 } }]);
    const [row] = scanResponseToReviewModel(response, [rp('p1', 'Alice')]);
    expect(row.mappedPlayerId).toBe('p1');
  });

  it('fuzzy-matches a close variant of a name (Justin → Justin)', () => {
    const response = resp(['Justin'], [{ number: 1, scores: { Justin: 5 } }]);
    const [row] = scanResponseToReviewModel(response, [rp('p1', 'Justin')]);
    expect(row.mappedPlayerId).toBe('p1');
  });

  it('phonetically matches Dipak → Deepak (classic owner case)', () => {
    // Soundex: Dipak = D120, Deepak = D120
    const response = resp(['Dipak'], [{ number: 1, scores: { Dipak: 4 } }]);
    const [row] = scanResponseToReviewModel(response, [rp('p1', 'Deepak')]);
    expect(row.mappedPlayerId).toBe('p1');
  });

  it('leaves mappedPlayerId null for a totally unrecognised OCR name', () => {
    const response = resp(['Zyx'], [{ number: 1, scores: { Zyx: 5 } }]);
    const [row] = scanResponseToReviewModel(response, [rp('p1', 'Alice'), rp('p2', 'Bob')]);
    expect(row.mappedPlayerId).toBeNull();
  });

  it('returns empty array when response has no players', () => {
    const response = resp([], []);
    const result = scanResponseToReviewModel(response, [rp('p1', 'Alice')]);
    expect(result).toHaveLength(0);
  });

  it('handles empty round player list (all OCR names stay unmatched)', () => {
    const response = resp(['Alice'], [{ number: 1, scores: { Alice: 4 } }]);
    const result = scanResponseToReviewModel(response, []);
    expect(result[0].mappedPlayerId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildScoreUpdates — (c) confirmed model → score update triples
// ─────────────────────────────────────────────────────────────────────────────

describe('buildScoreUpdates', () => {
  /** Build a minimal OcrPlayerReview row. */
  function row(ocrName: string, pid: string | null, scores: (number | null)[]): OcrPlayerReview {
    const padded: (number | null)[] = Array(18).fill(null);
    scores.forEach((s, i) => { padded[i] = s; });
    return { ocrName, scores: padded, mappedPlayerId: pid };
  }

  it('returns one entry per non-null score in range [1, 15]', () => {
    const model = [row('Alice', 'p1', [4, 3, 5])];
    const updates = buildScoreUpdates(model);
    expect(updates).toHaveLength(3);
    expect(updates[0]).toEqual(['p1', 0, 4]);
    expect(updates[1]).toEqual(['p1', 1, 3]);
    expect(updates[2]).toEqual(['p1', 2, 5]);
  });

  it('skips rows with no player mapping (mappedPlayerId = null)', () => {
    const model = [row('Alice', null, [4, 3])];
    expect(buildScoreUpdates(model)).toHaveLength(0);
  });

  it('skips null cells', () => {
    const model = [row('Alice', 'p1', [4, null, 5])];
    const updates = buildScoreUpdates(model);
    expect(updates).toHaveLength(2);
    expect(updates.map((u) => u[1])).toEqual([0, 2]); // hole indices 0 and 2
  });

  it('skips scores below 1', () => {
    const model = [row('Alice', 'p1', [0, 4])];
    const updates = buildScoreUpdates(model);
    expect(updates).toHaveLength(1);
    expect(updates[0][2]).toBe(4);
  });

  it('skips scores above 15', () => {
    const model = [row('Alice', 'p1', [16, 5])];
    const updates = buildScoreUpdates(model);
    expect(updates).toHaveLength(1);
    expect(updates[0][2]).toBe(5);
  });

  it('collects updates from multiple players in one call', () => {
    const model = [
      row('Alice', 'p1', [4, 3]),
      row('Bob', 'p2', [5, 4]),
    ];
    const updates = buildScoreUpdates(model);
    expect(updates).toHaveLength(4);
    expect(updates[0]).toEqual(['p1', 0, 4]);
    expect(updates[2]).toEqual(['p2', 0, 5]);
  });

  it('returns empty array when no rows have a mapping', () => {
    const model = [row('Unknown', null, [4, 3])];
    expect(buildScoreUpdates(model)).toHaveLength(0);
  });

  it('returns empty array for an empty review model', () => {
    expect(buildScoreUpdates([])).toHaveLength(0);
  });
});
