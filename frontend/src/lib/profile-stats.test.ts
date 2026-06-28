/**
 * Unit tests for the profile scoring-breakdown helpers (lib/profile-stats.ts).
 *
 * All helpers are pure functions that accept Round[] and return plain objects.
 * Tests cover normal cases, empty/missing data, 9-hole rounds, and edge cases.
 *
 * DO NOT modify profile-stats.ts to make these tests pass — fix the tests instead
 * if a formula is wrong.
 */

import { describe, it, expect } from "vitest";
import {
  deriveParTypeAverages,
  deriveScoreDistribution,
  deriveTrend,
} from "./profile-stats";
import type { Round, HoleInfo, Player, Score } from "./types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeHoles(pars: number[], startAt = 1): HoleInfo[] {
  return pars.map((par, i) => ({ number: startAt + i, par }));
}

const STD_18_PARS = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 4, 5];
// 7 par-3s, 7 par-4s (front only has 3 par-4s+2 par-5 holes — see actual count)
// Actual: par-3: holes 3,7,11,16 = 4; par-4: holes 1,2,5,6,8,10,13,14,15,17 is wrong
// STD_18_PARS = [4,4,3,5,4,4,3,4,5, 4,3,4,5,4,4,3,4,5]
//   Par-3: indices 2,6,10,15 → holes 3,7,11,16 → 4 holes
//   Par-4: indices 0,1,4,5,7,9,11,13,14,16 → 10 holes
//   Par-5: indices 3,8,12,17 → holes 4,9,13,18 → 4 holes
// Total par = 4*4 + 10*4 + 4*5 = 16 + 40 + 20 = 76? Let me recount.
// [4,4,3,5,4,4,3,4,5,4,3,4,5,4,4,3,4,5]
//  0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17
// Par-3: idx 2(h3), 6(h7), 10(h11), 15(h16) → 4 par-3 holes
// Par-4: idx 0,1,4,5,7,9,11,13,14,16 → 10 par-4 holes
// Par-5: idx 3,8,12,17 → 4 par-5 holes
// Total: 4+10+4 = 18 ✓

function makePlayers(ids: string[]): Player[] {
  return ids.map((id) => ({ id, name: id }));
}

/** Build scores for a single player with one stroke per hole */
function makeScores(
  playerId: string,
  holeNumbers: number[],
  strokes: number[]
): Score[] {
  return holeNumbers.map((holeNumber, i) => ({
    playerId,
    holeNumber,
    strokes: strokes[i],
  }));
}

function makeRound(overrides: Partial<Round> = {}): Round {
  return {
    id: "r1",
    courseId: "c1",
    courseName: "Test Course",
    date: "2026-01-01",
    players: makePlayers(["p1"]),
    scores: [],
    holes: makeHoles(STD_18_PARS),
    status: "completed",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** Holes for a 9-hole round: 9 holes with pars [4,4,3,5,4,4,3,4,5] */
const NINE_HOLE_PARS = [4, 4, 3, 5, 4, 4, 3, 4, 5];

// ---------------------------------------------------------------------------
// deriveParTypeAverages
// ---------------------------------------------------------------------------

describe("deriveParTypeAverages", () => {
  it("returns empty array when there are no rounds", () => {
    expect(deriveParTypeAverages([])).toEqual([]);
  });

  it("returns empty array when all rounds are non-completed", () => {
    const r = makeRound({ status: "active" });
    expect(deriveParTypeAverages([r])).toEqual([]);
  });

  it("returns empty array when completed round has no players", () => {
    const r = makeRound({ players: [] });
    expect(deriveParTypeAverages([r])).toEqual([]);
  });

  it("returns empty array when owner has no scored holes", () => {
    const r = makeRound({ scores: [] });
    expect(deriveParTypeAverages([r])).toEqual([]);
  });

  it("skips holes with null strokes", () => {
    const r = makeRound({
      holes: makeHoles([4]),
      scores: [{ playerId: "p1", holeNumber: 1, strokes: null }],
    });
    expect(deriveParTypeAverages([r])).toEqual([]);
  });

  it("skips holes whose par is not 3, 4, or 5 (e.g. par-6)", () => {
    const r = makeRound({
      holes: makeHoles([6]),
      scores: [{ playerId: "p1", holeNumber: 1, strokes: 7 }],
    });
    expect(deriveParTypeAverages([r])).toEqual([]);
  });

  it("skips scores for holes not in the round's holes array", () => {
    const r = makeRound({
      holes: makeHoles([4]),           // only hole 1
      scores: [{ playerId: "p1", holeNumber: 99, strokes: 4 }], // no matching hole
    });
    expect(deriveParTypeAverages([r])).toEqual([]);
  });

  it("computes correct averages for a single par-4 hole", () => {
    const r = makeRound({
      holes: makeHoles([4]),
      scores: [{ playerId: "p1", holeNumber: 1, strokes: 5 }],
    });
    const [row] = deriveParTypeAverages([r]);
    expect(row.par).toBe(4);
    expect(row.holeCount).toBe(1);
    expect(row.avgScore).toBe(5);
    expect(row.avgToPar).toBe(1); // +1 (bogey)
  });

  it("returns all three par types when a round has par-3, par-4, and par-5 holes", () => {
    const holes = makeHoles([3, 4, 5]);
    const scores = makeScores("p1", [1, 2, 3], [3, 5, 5]);
    const r = makeRound({ holes, scores });
    const rows = deriveParTypeAverages([r]);
    expect(rows).toHaveLength(3);
    const byPar = Object.fromEntries(rows.map((row) => [row.par, row]));
    expect(byPar[3].avgScore).toBe(3);
    expect(byPar[3].avgToPar).toBe(0);    // even
    expect(byPar[4].avgScore).toBe(5);
    expect(byPar[4].avgToPar).toBe(1);    // +1
    expect(byPar[5].avgScore).toBe(5);
    expect(byPar[5].avgToPar).toBe(0);    // even
  });

  it("averages across multiple rounds correctly", () => {
    // Two rounds each with one par-4: scores 5 and 3 → avg 4.0, avg toPar 0.0
    const r1 = makeRound({
      id: "r1",
      date: "2026-01-01",
      holes: makeHoles([4]),
      scores: [{ playerId: "p1", holeNumber: 1, strokes: 5 }],
    });
    const r2 = makeRound({
      id: "r2",
      date: "2026-01-02",
      holes: makeHoles([4]),
      scores: [{ playerId: "p1", holeNumber: 1, strokes: 3 }],
    });
    const [row] = deriveParTypeAverages([r1, r2]);
    expect(row.par).toBe(4);
    expect(row.holeCount).toBe(2);
    expect(row.avgScore).toBe(4);
    expect(row.avgToPar).toBe(0);
  });

  it("rounds avgScore and avgToPar to 1 decimal place", () => {
    // Three par-4 holes scored as 5, 5, 6 → total 16 / 3 = 5.3333... → 5.3
    // avgToPar: (1+1+2)/3 = 1.3333... → 1.3
    const holes = makeHoles([4, 4, 4]);
    const scores = makeScores("p1", [1, 2, 3], [5, 5, 6]);
    const r = makeRound({ holes, scores });
    const [row] = deriveParTypeAverages([r]);
    expect(row.avgScore).toBe(5.3);
    expect(row.avgToPar).toBe(1.3);
  });

  it("works with a 9-hole round", () => {
    const holes = makeHoles(NINE_HOLE_PARS);
    // Score even on all holes: 4,4,3,5,4,4,3,4,5
    const scores = makeScores("p1", [1,2,3,4,5,6,7,8,9], NINE_HOLE_PARS);
    const r = makeRound({ holes, scores });
    const rows = deriveParTypeAverages([r]);
    // All avgToPar should be 0 (scored exactly par)
    for (const row of rows) {
      expect(row.avgToPar).toBe(0);
    }
  });

  it("only counts owner (players[0]) scores, ignores other players", () => {
    const holes = makeHoles([4]);
    const r = makeRound({
      players: [{ id: "p1", name: "Owner" }, { id: "p2", name: "Other" }],
      holes,
      scores: [
        { playerId: "p1", holeNumber: 1, strokes: 5 }, // +1
        { playerId: "p2", holeNumber: 1, strokes: 7 }, // +3 — should be ignored
      ],
    });
    const [row] = deriveParTypeAverages([r]);
    expect(row.avgToPar).toBe(1); // only p1's score counts
  });

  it("only returns rows for par types that have data", () => {
    // Only par-3 holes in this round
    const holes = makeHoles([3, 3]);
    const scores = makeScores("p1", [1, 2], [3, 4]);
    const r = makeRound({ holes, scores });
    const rows = deriveParTypeAverages([r]);
    expect(rows).toHaveLength(1);
    expect(rows[0].par).toBe(3);
  });

  it("handles negative avgToPar (under-par average)", () => {
    // Birdie on a par-4 (score 3)
    const holes = makeHoles([4]);
    const scores = [{ playerId: "p1", holeNumber: 1, strokes: 3 }];
    const r = makeRound({ holes, scores });
    const [row] = deriveParTypeAverages([r]);
    expect(row.avgToPar).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// deriveScoreDistribution
// ---------------------------------------------------------------------------

describe("deriveScoreDistribution", () => {
  it("returns empty array when there are no rounds", () => {
    expect(deriveScoreDistribution([])).toEqual([]);
  });

  it("returns empty array when no holes are scored", () => {
    expect(deriveScoreDistribution([makeRound({ scores: [] })])).toEqual([]);
  });

  it("returns empty array when all rounds are non-completed", () => {
    const r = makeRound({ status: "active" });
    expect(deriveScoreDistribution([r])).toEqual([]);
  });

  it("counts a single birdie correctly", () => {
    const holes = makeHoles([4]);
    const r = makeRound({
      holes,
      scores: [{ playerId: "p1", holeNumber: 1, strokes: 3 }], // -1 = birdie
    });
    const rows = deriveScoreDistribution([r]);
    expect(rows).toHaveLength(1);
    expect(rows[0].bucket).toBe("birdie");
    expect(rows[0].count).toBe(1);
    expect(rows[0].pct).toBe(100);
  });

  it("counts eagle-or-better for delta ≤ -2", () => {
    // Albatross on a par-5 (score 2 = -3)
    const holes = makeHoles([5]);
    const r = makeRound({
      holes,
      scores: [{ playerId: "p1", holeNumber: 1, strokes: 2 }],
    });
    const rows = deriveScoreDistribution([r]);
    expect(rows[0].bucket).toBe("eagle_or_better");
  });

  it("groups double-bogey and worse into double_plus", () => {
    const holes = makeHoles([4, 4]);
    // score 6 (+2) and score 8 (+4) — both should land in double_plus
    const r = makeRound({
      holes,
      scores: [
        { playerId: "p1", holeNumber: 1, strokes: 6 },
        { playerId: "p1", holeNumber: 2, strokes: 8 },
      ],
    });
    const rows = deriveScoreDistribution([r]);
    expect(rows).toHaveLength(1);
    expect(rows[0].bucket).toBe("double_plus");
    expect(rows[0].count).toBe(2);
  });

  it("computes percentages that sum to 100", () => {
    const holes = makeHoles([4, 4, 4, 3, 5]);
    const scores = makeScores("p1", [1,2,3,4,5], [4,5,3,3,5]); // par, bogey, birdie, par, par
    const r = makeRound({ holes, scores });
    const rows = deriveScoreDistribution([r]);
    const total = rows.reduce((s, row) => s + row.pct, 0);
    // 1dp rounding may produce 99.9 or 100.1 — allow ±0.5
    expect(Math.abs(total - 100)).toBeLessThan(0.5);
  });

  it("omits buckets with zero count from the results", () => {
    // All pars — only the par bucket should appear
    const holes = makeHoles([4, 4, 4]);
    const scores = makeScores("p1", [1,2,3], [4,4,4]);
    const r = makeRound({ holes, scores });
    const rows = deriveScoreDistribution([r]);
    expect(rows).toHaveLength(1);
    expect(rows[0].bucket).toBe("par");
    expect(rows[0].pct).toBe(100);
  });

  it("returns rows in the canonical bucket order", () => {
    const holes = makeHoles([4, 4, 3, 5]);
    // hole 1 par-4 score 3 → birdie; hole 2 par-4 score 5 → bogey;
    // hole 3 par-3 score 3 → par; hole 4 par-5 score 7 → double+ (delta +2)
    const scores = makeScores("p1", [1,2,3,4], [3, 5, 3, 7]);
    const r = makeRound({ holes, scores });
    const rows = deriveScoreDistribution([r]);
    const buckets = rows.map((row) => row.bucket);
    // Should appear in order: birdie, par, bogey, double_plus (eagle absent)
    expect(buckets).toEqual(["birdie", "par", "bogey", "double_plus"]);
  });

  it("accumulates correctly across multiple rounds", () => {
    const holes = makeHoles([4]);
    const r1 = makeRound({ id: "r1", date: "2026-01-01", holes, scores: [{ playerId: "p1", holeNumber: 1, strokes: 4 }] }); // par
    const r2 = makeRound({ id: "r2", date: "2026-01-02", holes, scores: [{ playerId: "p1", holeNumber: 1, strokes: 4 }] }); // par
    const r3 = makeRound({ id: "r3", date: "2026-01-03", holes, scores: [{ playerId: "p1", holeNumber: 1, strokes: 5 }] }); // bogey
    const rows = deriveScoreDistribution([r1, r2, r3]);
    const parRow = rows.find((row) => row.bucket === "par")!;
    const bogeyRow = rows.find((row) => row.bucket === "bogey")!;
    expect(parRow.count).toBe(2);
    expect(bogeyRow.count).toBe(1);
    expect(parRow.pct).toBeCloseTo(66.7, 0);
    expect(bogeyRow.pct).toBeCloseTo(33.3, 0);
  });

  it("skips holes with null strokes", () => {
    const holes = makeHoles([4, 4]);
    const r = makeRound({
      holes,
      scores: [
        { playerId: "p1", holeNumber: 1, strokes: null },
        { playerId: "p1", holeNumber: 2, strokes: 4 },
      ],
    });
    const rows = deriveScoreDistribution([r]);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(1); // only the par hole
  });

  it("skips scores for holes not in the round holes array", () => {
    const holes = makeHoles([4]); // only hole 1
    const r = makeRound({
      holes,
      scores: [
        { playerId: "p1", holeNumber: 99, strokes: 4 }, // no matching hole definition
      ],
    });
    expect(deriveScoreDistribution([r])).toEqual([]);
  });

  it("only counts owner (players[0]) scores", () => {
    const holes = makeHoles([4]);
    const r = makeRound({
      players: [{ id: "p1", name: "Owner" }, { id: "p2", name: "Other" }],
      holes,
      scores: [
        { playerId: "p1", holeNumber: 1, strokes: 4 }, // par
        { playerId: "p2", holeNumber: 1, strokes: 6 }, // double+ — should be ignored
      ],
    });
    const rows = deriveScoreDistribution([r]);
    expect(rows).toHaveLength(1);
    expect(rows[0].bucket).toBe("par");
  });
});

// ---------------------------------------------------------------------------
// deriveTrend
// ---------------------------------------------------------------------------

/** Build a completed round with a known to-par score for trend tests */
function makeRoundWithToPar(id: string, date: string, toPar: number): Round {
  // Use 18 par-4 holes; player scores (4 + toPar/18) on each.
  // Simplest: score 18 holes, toPar distributed evenly.
  // Actually: all par-4s, score enough to get the desired toPar total.
  // We'll score 9 holes only (to have playedHoles >= 9) with strokes = par + delta_per_hole.
  // For integer toPar: if toPar is divisible by 9 it's clean; otherwise some holes vary by 1.
  const pars = Array<number>(18).fill(4);
  const holes = makeHoles(pars);
  // Spread toPar across first 9 holes
  const perHole = Math.floor(toPar / 9);
  const remainder = toPar - perHole * 9;
  const scores: Score[] = Array.from({ length: 9 }, (_, i) => ({
    playerId: "p1",
    holeNumber: i + 1,
    strokes: 4 + perHole + (i < Math.abs(remainder) ? Math.sign(remainder) : 0),
  }));
  return {
    id,
    courseId: "c1",
    courseName: "Test Course",
    date,
    players: makePlayers(["p1"]),
    scores,
    holes,
    status: "completed",
    createdAt: `${date}T00:00:00Z`,
    updatedAt: `${date}T00:00:00Z`,
  };
}

describe("deriveTrend", () => {
  it("returns null when there are no rounds", () => {
    expect(deriveTrend([])).toBeNull();
  });

  it("returns null when there is only one completed round", () => {
    const r = makeRoundWithToPar("r1", "2026-01-01", 5);
    expect(deriveTrend([r])).toBeNull();
  });

  it("returns null when all rounds fall within recentN (no prior window)", () => {
    const rounds = [
      makeRoundWithToPar("r1", "2026-01-01", 5),
      makeRoundWithToPar("r2", "2026-01-02", 6),
    ];
    // With recentN=5, both rounds land in recent window, prior is empty
    expect(deriveTrend(rounds, 5)).toBeNull();
  });

  it("returns a result when recent and prior both have data", () => {
    const rounds = [
      makeRoundWithToPar("r1", "2026-01-01", 10),
      makeRoundWithToPar("r2", "2026-01-02", 12),
      makeRoundWithToPar("r3", "2026-01-03", 8),
    ];
    // recentN=1 → recent=[r3], prior=[r2, r1]
    const result = deriveTrend(rounds, 1);
    expect(result).not.toBeNull();
    expect(result!.recentCount).toBe(1);
    expect(result!.priorCount).toBe(2);
  });

  it("detects improving trend (negative delta)", () => {
    // Recent: +5 toPar; Prior: +10 toPar → delta = -5 (improving)
    const recent = makeRoundWithToPar("r3", "2026-01-03", 5);
    const prior = makeRoundWithToPar("r1", "2026-01-01", 10);
    // recentN=1 → recent=[r3 (newest)], prior=[r1 (oldest)]
    const result = deriveTrend([prior, recent], 1);
    expect(result).not.toBeNull();
    expect(result!.delta).toBeLessThan(0);
  });

  it("detects declining trend (positive delta)", () => {
    // Recent: +12 toPar; Prior: +6 toPar → delta = +6 (declining)
    const recent = makeRoundWithToPar("r2", "2026-01-02", 12);
    const prior = makeRoundWithToPar("r1", "2026-01-01", 6);
    const result = deriveTrend([prior, recent], 1);
    expect(result).not.toBeNull();
    expect(result!.delta).toBeGreaterThan(0);
  });

  it("excludes non-completed rounds from both windows", () => {
    const activeRound: Round = { ...makeRoundWithToPar("ra", "2026-01-03", 0), status: "active" };
    const r1 = makeRoundWithToPar("r1", "2026-01-01", 8);
    const r2 = makeRoundWithToPar("r2", "2026-01-02", 8);
    // Only 2 completed rounds + 1 active; recentN=1 → recent=[r2], prior=[r1]
    const result = deriveTrend([r1, r2, activeRound], 1);
    expect(result).not.toBeNull();
    expect(result!.recentCount).toBe(1);
    expect(result!.priorCount).toBe(1);
  });

  it("excludes rounds with fewer than 9 played holes from averages", () => {
    // A round with only 5 scores (incomplete)
    const partial: Round = {
      ...makeRoundWithToPar("rp", "2026-01-03", 3),
      scores: makeScores("p1", [1,2,3,4,5], [4,4,4,4,4]), // only 5 holes played
    };
    const r1 = makeRoundWithToPar("r1", "2026-01-01", 8);
    const r2 = makeRoundWithToPar("r2", "2026-01-02", 10);
    // recent=[partial], prior=[r2, r1]; partial has < 9 holes → recent window invalid
    const result = deriveTrend([r1, r2, partial], 1);
    expect(result).toBeNull(); // recentToPars would be empty
  });

  it("returns null when rounds have no players", () => {
    const r1: Round = { ...makeRoundWithToPar("r1", "2026-01-01", 5), players: [] };
    const r2: Round = { ...makeRoundWithToPar("r2", "2026-01-02", 5), players: [] };
    expect(deriveTrend([r1, r2])).toBeNull();
  });

  it("sorts rounds newest-first before windowing (order-independent input)", () => {
    // Provide rounds in ascending order; function should sort them descending
    const r1 = makeRoundWithToPar("r1", "2026-01-01", 20); // oldest → prior
    const r2 = makeRoundWithToPar("r2", "2026-01-02", 10); // newest → recent
    // recentN=1 → recent=[r2], prior=[r1]
    const result = deriveTrend([r1, r2], 1); // input in ascending order
    expect(result).not.toBeNull();
    // r2 is recent (toPar≈10), r1 is prior (toPar≈20)
    expect(result!.recentAvgToPar).toBeLessThan(result!.priorAvgToPar);
  });
});
