/**
 * Unit tests for round-insights.ts — computeRoundInsights().
 *
 * All tests are pure: no network, no React, no async.
 * Round data is constructed inline with the same helpers used in
 * profile-stats.test.ts for consistency.
 *
 * DO NOT modify round-insights.ts to make these tests pass.
 */

import { describe, it, expect } from "vitest";
import { computeRoundInsights } from "./round-insights";
import type { Round, HoleInfo, Player, Score } from "./types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeHoles(pars: number[], startAt = 1): HoleInfo[] {
  return pars.map((par, i) => ({ number: startAt + i, par }));
}

function makePlayers(ids: string[]): Player[] {
  return ids.map((id) => ({ id, name: id }));
}

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

/** 18-hole par-4 layout (72 par). */
const PAR4_18 = Array<number>(18).fill(4);

/**
 * Build a completed 18-hole round for player "p1" with a known to-par.
 * Distributes toPar evenly over the first 9 holes; remaining 9 are par.
 */
function makeRoundWithToPar(
  id: string,
  date: string,
  toPar: number,
  overrides: Partial<Round> = {}
): Round {
  const holes = makeHoles(PAR4_18);
  const perHole = Math.floor(toPar / 9);
  const remainder = toPar - perHole * 9;
  const scores: Score[] = Array.from({ length: 18 }, (_, i) => ({
    playerId: "p1",
    holeNumber: i + 1,
    strokes:
      i < 9
        ? 4 + perHole + (i < Math.abs(remainder) ? Math.sign(remainder) : 0)
        : 4, // back 9 at par
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
    ...overrides,
  };
}

/** Minimal round factory for custom score/hole setups. */
function makeRound(overrides: Partial<Round> = {}): Round {
  return {
    id: "r-current",
    courseId: "c1",
    courseName: "Test Course",
    date: "2026-06-01",
    players: makePlayers(["p1"]),
    scores: makeScores("p1", Array.from({ length: 18 }, (_, i) => i + 1), Array<number>(18).fill(4)),
    holes: makeHoles(PAR4_18),
    status: "completed",
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Graceful empty / first-round / thin-history states
// ---------------------------------------------------------------------------

describe("computeRoundInsights — graceful states", () => {
  it("returns first-round when history is empty", () => {
    const round = makeRoundWithToPar("r1", "2026-06-01", 5);
    const result = computeRoundInsights(round, []);
    expect(result.state).toBe("first-round");
    expect(result.vsAverageToPar).toBeUndefined();
    expect(result.parTypeComparison).toBeUndefined();
    expect(result.ranking).toBeUndefined();
  });

  it("returns first-round when round has no players", () => {
    const round = makeRound({ players: [] });
    const history = [makeRoundWithToPar("h1", "2026-01-01", 8)];
    expect(computeRoundInsights(round, history).state).toBe("first-round");
  });

  it("returns first-round when current round has fewer than 9 played holes", () => {
    const round = makeRound({
      // Only 5 holes scored
      scores: makeScores("p1", [1, 2, 3, 4, 5], [4, 4, 4, 4, 4]),
    });
    const history = [
      makeRoundWithToPar("h1", "2026-01-01", 8),
      makeRoundWithToPar("h2", "2026-01-02", 10),
    ];
    expect(computeRoundInsights(round, history).state).toBe("first-round");
  });

  it("returns first-round when all history rounds are non-completed", () => {
    const round = makeRoundWithToPar("r1", "2026-06-01", 5);
    const active: Round = {
      ...makeRoundWithToPar("h1", "2026-01-01", 8),
      status: "active",
    };
    expect(computeRoundInsights(round, [active]).state).toBe("first-round");
  });

  it("returns first-round when all history rounds have fewer than 9 played holes", () => {
    const round = makeRoundWithToPar("r1", "2026-06-01", 5);
    const partial: Round = {
      ...makeRoundWithToPar("h1", "2026-01-01", 5),
      scores: makeScores("p1", [1, 2, 3, 4, 5], [4, 4, 4, 4, 4]),
    };
    expect(computeRoundInsights(round, [partial]).state).toBe("first-round");
  });

  it("returns thin-history when exactly 1 valid history round exists", () => {
    const round = makeRoundWithToPar("r1", "2026-06-01", 5);
    const history = [makeRoundWithToPar("h1", "2026-01-01", 10)];
    const result = computeRoundInsights(round, history);
    expect(result.state).toBe("thin-history");
    // vsAverageToPar should be present with 1-round data
    expect(result.vsAverageToPar).toBeDefined();
    expect(result.vsAverageToPar!.sampleSize).toBe(1);
    // Ranking and par-type withheld for thin-history
    expect(result.ranking).toBeUndefined();
    expect(result.parTypeComparison).toBeUndefined();
  });

  it("does not fabricate comparisons in first-round state", () => {
    const round = makeRoundWithToPar("r1", "2026-06-01", 5);
    const result = computeRoundInsights(round, []);
    // None of the comparison fields should be present
    expect(result.vsAverageToPar).toBeUndefined();
    expect(result.parTypeComparison).toBeUndefined();
    expect(result.ranking).toBeUndefined();
  });

  it("excludes the current round from history even if caller includes it", () => {
    const round = makeRoundWithToPar("r1", "2026-06-01", 5);
    // history includes the same round — function must filter it out
    const history = [round, makeRoundWithToPar("h2", "2026-01-01", 8)];
    const result = computeRoundInsights(round, history);
    // Only 1 valid history round remains after filtering → thin-history
    expect(result.state).toBe("thin-history");
    expect(result.vsAverageToPar!.sampleSize).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// vsAverageToPar — sign and magnitude
// ---------------------------------------------------------------------------

describe("computeRoundInsights — vsAverageToPar", () => {
  it("reports a negative delta when this round is better than average", () => {
    // history avg: (8 + 10) / 2 = 9. This round: 5. delta = 5 - 9 = -4.
    const round = makeRoundWithToPar("r1", "2026-06-01", 5);
    const history = [
      makeRoundWithToPar("h1", "2026-01-01", 8),
      makeRoundWithToPar("h2", "2026-01-02", 10),
    ];
    const result = computeRoundInsights(round, history);
    expect(result.state).toBe("ready");
    expect(result.vsAverageToPar!.delta).toBeLessThan(0);
    expect(result.vsAverageToPar!.delta).toBe(-4);
  });

  it("reports a positive delta when this round is worse than average", () => {
    // history avg: (2 + 4) / 2 = 3. This round: 10. delta = +7.
    const round = makeRoundWithToPar("r1", "2026-06-01", 10);
    const history = [
      makeRoundWithToPar("h1", "2026-01-01", 2),
      makeRoundWithToPar("h2", "2026-01-02", 4),
    ];
    const result = computeRoundInsights(round, history);
    expect(result.vsAverageToPar!.delta).toBeGreaterThan(0);
    expect(result.vsAverageToPar!.delta).toBe(7);
  });

  it("reports zero delta when this round matches the average exactly", () => {
    const round = makeRoundWithToPar("r1", "2026-06-01", 8);
    const history = [
      makeRoundWithToPar("h1", "2026-01-01", 6),
      makeRoundWithToPar("h2", "2026-01-02", 10),
    ];
    const result = computeRoundInsights(round, history);
    expect(result.vsAverageToPar!.delta).toBe(0);
  });

  it("reports correct thisRound and historicalAvg values", () => {
    // avg = (6 + 12) / 2 = 9
    const round = makeRoundWithToPar("r1", "2026-06-01", 5);
    const history = [
      makeRoundWithToPar("h1", "2026-01-01", 6),
      makeRoundWithToPar("h2", "2026-01-02", 12),
    ];
    const result = computeRoundInsights(round, history);
    expect(result.vsAverageToPar!.thisRound).toBe(5);
    expect(result.vsAverageToPar!.historicalAvg).toBe(9);
    expect(result.vsAverageToPar!.sampleSize).toBe(2);
  });

  it("rounds historicalAvg and delta to 1 decimal place", () => {
    // avg = (6 + 7 + 8) / 3 = 7. This round: 5. delta = -2.
    const round = makeRoundWithToPar("r1", "2026-06-01", 5);
    const h1 = makeRoundWithToPar("h1", "2026-01-01", 6);
    const h2 = makeRoundWithToPar("h2", "2026-01-02", 7);
    const h3 = makeRoundWithToPar("h3", "2026-01-03", 8);
    const result = computeRoundInsights(round, [h1, h2, h3]);
    // avg = 7.0 exactly
    expect(result.vsAverageToPar!.historicalAvg).toBe(7.0);
    expect(result.vsAverageToPar!.delta).toBe(-2.0);
  });
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

describe("computeRoundInsights — ranking", () => {
  it("ranks the current round as #1 when it is the best (lowest to-par)", () => {
    const round = makeRoundWithToPar("r1", "2026-06-01", 2); // best
    const history = [
      makeRoundWithToPar("h1", "2026-01-01", 8),
      makeRoundWithToPar("h2", "2026-01-02", 10),
    ];
    const result = computeRoundInsights(round, history);
    expect(result.ranking!.rank).toBe(1);
    expect(result.ranking!.total).toBe(3); // 2 history + 1 current
  });

  it("ranks the current round correctly when it is not the best", () => {
    // history: [2, 5]. this round: 8. rank = 3rd.
    const round = makeRoundWithToPar("r1", "2026-06-01", 8);
    const history = [
      makeRoundWithToPar("h1", "2026-01-01", 2),
      makeRoundWithToPar("h2", "2026-01-02", 5),
    ];
    const result = computeRoundInsights(round, history);
    expect(result.ranking!.rank).toBe(3);
    expect(result.ranking!.total).toBe(3);
  });

  it("ranks correctly when this round is middle of the pack", () => {
    // history: [3, 12]. this round: 7. rank = 2nd (only r1=3 is better).
    const round = makeRoundWithToPar("r1", "2026-06-01", 7);
    const history = [
      makeRoundWithToPar("h1", "2026-01-01", 3),
      makeRoundWithToPar("h2", "2026-01-02", 12),
    ];
    const result = computeRoundInsights(round, history);
    expect(result.ranking!.rank).toBe(2);
    expect(result.ranking!.total).toBe(3);
  });

  it("includes current round in the total count", () => {
    const round = makeRoundWithToPar("r1", "2026-06-01", 5);
    const history = [
      makeRoundWithToPar("h1", "2026-01-01", 8),
      makeRoundWithToPar("h2", "2026-01-02", 10),
      makeRoundWithToPar("h3", "2026-01-03", 12),
    ];
    const result = computeRoundInsights(round, history);
    expect(result.ranking!.total).toBe(4); // 3 history + 1 current
  });

  it("handles ties by using a strict less-than comparison for rank", () => {
    // history: [5, 5]. this round: 5. No history round is strictly less → rank 1.
    const round = makeRoundWithToPar("r1", "2026-06-01", 5);
    const history = [
      makeRoundWithToPar("h1", "2026-01-01", 5),
      makeRoundWithToPar("h2", "2026-01-02", 5),
    ];
    const result = computeRoundInsights(round, history);
    expect(result.ranking!.rank).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Par-type comparison
// ---------------------------------------------------------------------------

describe("computeRoundInsights — parTypeComparison", () => {
  it("computes per-par-type comparison when data is available", () => {
    // 9-hole layout with 3 par-3s, 3 par-4s, 3 par-5s — satisfies MIN_PLAYED_HOLES.
    const holePars = [3, 4, 5, 3, 4, 5, 3, 4, 5];
    const holes = makeHoles(holePars);
    const holeNums = Array.from({ length: 9 }, (_, i) => i + 1);
    // Current round: score exactly par on every hole (E, E, E per type)
    const currentScores = makeScores("p1", holeNums, holePars);
    const round: Round = {
      id: "r-cur",
      courseId: "c1",
      courseName: "Test",
      date: "2026-06-01",
      players: makePlayers(["p1"]),
      scores: currentScores,
      holes,
      status: "completed",
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
    };

    // History: two rounds where owner scores +1 on every hole (bogey on each)
    function makeHistRound(id: string, date: string): Round {
      return {
        id,
        courseId: "c1",
        courseName: "Test",
        date,
        players: makePlayers(["p1"]),
        holes,
        scores: makeScores("p1", holeNums, holePars.map((p) => p + 1)),
        status: "completed",
        createdAt: `${date}T00:00:00Z`,
        updatedAt: `${date}T00:00:00Z`,
      };
    }

    const history = [
      makeHistRound("h1", "2026-01-01"),
      makeHistRound("h2", "2026-01-02"),
    ];
    const result = computeRoundInsights(round, history);
    expect(result.state).toBe("ready");
    expect(result.parTypeComparison).toBeDefined();
    const byPar = Object.fromEntries(
      result.parTypeComparison!.map((pt) => [pt.par, pt])
    );
    // This round scored E on each; history avg was +1 → delta = -1 (better)
    expect(byPar[3].delta).toBe(-1);
    expect(byPar[4].delta).toBe(-1);
    expect(byPar[5].delta).toBe(-1);
    expect(byPar[3].thisRoundAvgToPar).toBe(0);
    expect(byPar[3].historicalAvgToPar).toBe(1);
  });

  it("omits par types where current round has no data", () => {
    // Current round: 9 par-4 holes only (no par-3 or par-5) — satisfies MIN_PLAYED_HOLES.
    const holes = makeHoles(Array<number>(9).fill(4));
    const holeNums = Array.from({ length: 9 }, (_, i) => i + 1);
    const round: Round = {
      id: "r-cur",
      courseId: "c1",
      courseName: "Test",
      date: "2026-06-01",
      players: makePlayers(["p1"]),
      scores: makeScores("p1", holeNums, Array<number>(9).fill(4)),
      holes,
      status: "completed",
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
    };

    // History: 9-hole rounds with a mix of par-3, par-4, par-5 (3 of each)
    const histHolePars = [3, 4, 5, 3, 4, 5, 3, 4, 5];
    const histHoles = makeHoles(histHolePars);
    function makeHistRound(id: string, date: string): Round {
      return {
        id,
        courseId: "c1",
        courseName: "Test",
        date,
        players: makePlayers(["p1"]),
        holes: histHoles,
        scores: makeScores("p1", holeNums, histHolePars),
        status: "completed",
        createdAt: `${date}T00:00:00Z`,
        updatedAt: `${date}T00:00:00Z`,
      };
    }

    const history = [
      makeHistRound("h1", "2026-01-01"),
      makeHistRound("h2", "2026-01-02"),
    ];
    const result = computeRoundInsights(round, history);
    // Only par-4 should appear — current round has no par-3 or par-5 data.
    expect(result.state).toBe("ready");
    expect(result.parTypeComparison).toBeDefined();
    const pars = result.parTypeComparison!.map((pt) => pt.par);
    expect(pars).toEqual([4]);
  });

  it("returns undefined parTypeComparison when no par types overlap", () => {
    // Current round: par-3 holes only
    const round: Round = {
      id: "r-cur",
      courseId: "c1",
      courseName: "Test",
      date: "2026-06-01",
      players: makePlayers(["p1"]),
      holes: makeHoles(Array<number>(18).fill(3)),
      scores: makeScores(
        "p1",
        Array.from({ length: 18 }, (_, i) => i + 1),
        Array<number>(18).fill(3)
      ),
      status: "completed",
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
    };
    // History: par-5 holes only
    function makeP5Round(id: string, date: string): Round {
      return {
        id,
        courseId: "c1",
        courseName: "Test",
        date,
        players: makePlayers(["p1"]),
        holes: makeHoles(Array<number>(18).fill(5)),
        scores: makeScores(
          "p1",
          Array.from({ length: 18 }, (_, i) => i + 1),
          Array<number>(18).fill(5)
        ),
        status: "completed",
        createdAt: `${date}T00:00:00Z`,
        updatedAt: `${date}T00:00:00Z`,
      };
    }
    const history = [makeP5Round("h1", "2026-01-01"), makeP5Round("h2", "2026-01-02")];
    const result = computeRoundInsights(round, history);
    expect(result.parTypeComparison).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Owner-player scoping
// ---------------------------------------------------------------------------

describe("computeRoundInsights — owner-player scoping", () => {
  it("only counts owner scores in the current round, ignores other players", () => {
    // Round with 2 players: owner (p1) scores even; other player (p2) scores +18
    const holes = makeHoles(PAR4_18);
    const ownerScores: Score[] = Array.from({ length: 18 }, (_, i) => ({
      playerId: "p1",
      holeNumber: i + 1,
      strokes: 4, // par
    }));
    const otherScores: Score[] = Array.from({ length: 18 }, (_, i) => ({
      playerId: "p2",
      holeNumber: i + 1,
      strokes: 5, // +1 per hole
    }));
    const round: Round = {
      id: "r-cur",
      courseId: "c1",
      courseName: "Test",
      date: "2026-06-01",
      players: [
        { id: "p1", name: "Owner" },
        { id: "p2", name: "Guest" },
      ],
      scores: [...ownerScores, ...otherScores],
      holes,
      status: "completed",
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
    };

    // History: owner had average of +9
    const history = [
      makeRoundWithToPar("h1", "2026-01-01", 9),
      makeRoundWithToPar("h2", "2026-01-02", 9),
    ];

    const result = computeRoundInsights(round, history);
    // Owner scored E (0) — should compare to history avg of +9
    expect(result.vsAverageToPar!.thisRound).toBe(0);
    expect(result.vsAverageToPar!.historicalAvg).toBe(9);
    expect(result.vsAverageToPar!.delta).toBe(-9);
  });

  it("uses ownerPlayerId when explicitly set rather than first player", () => {
    const holes = makeHoles(PAR4_18);
    // Owner is p2 (explicitly set), not p1 (first player)
    const p1Scores: Score[] = Array.from({ length: 18 }, (_, i) => ({
      playerId: "p1",
      holeNumber: i + 1,
      strokes: 6, // +2 per hole
    }));
    const p2Scores: Score[] = Array.from({ length: 18 }, (_, i) => ({
      playerId: "p2",
      holeNumber: i + 1,
      strokes: 4, // par
    }));
    const round: Round = {
      id: "r-cur",
      courseId: "c1",
      courseName: "Test",
      date: "2026-06-01",
      players: [
        { id: "p1", name: "Guest" },
        { id: "p2", name: "Owner" },
      ],
      ownerPlayerId: "p2", // explicit — owner is NOT the first player
      scores: [...p1Scores, ...p2Scores],
      holes,
      status: "completed",
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
    };

    // History: two rounds with ownerPlayerId set correctly
    const history = [
      { ...makeRoundWithToPar("h1", "2026-01-01", 9), ownerPlayerId: "p1" },
      { ...makeRoundWithToPar("h2", "2026-01-02", 9), ownerPlayerId: "p1" },
    ] as Round[];

    const result = computeRoundInsights(round, history);
    // Owner (p2) scored E (0), not +36 (p1's score)
    expect(result.vsAverageToPar!.thisRound).toBe(0);
  });

  it("excludes history rounds with no players", () => {
    const round = makeRoundWithToPar("r1", "2026-06-01", 5);
    const history = [
      makeRoundWithToPar("h1", "2026-01-01", 8),
      { ...makeRoundWithToPar("h2", "2026-01-02", 10), players: [] },
    ];
    const result = computeRoundInsights(round, history);
    // Only h1 is valid (h2 has no players)
    expect(result.state).toBe("thin-history");
    expect(result.vsAverageToPar!.sampleSize).toBe(1);
  });

  it("excludes non-completed history rounds", () => {
    const round = makeRoundWithToPar("r1", "2026-06-01", 5);
    const history = [
      makeRoundWithToPar("h1", "2026-01-01", 8),
      { ...makeRoundWithToPar("h2", "2026-01-02", 10), status: "active" as const },
    ];
    const result = computeRoundInsights(round, history);
    expect(result.state).toBe("thin-history");
    expect(result.vsAverageToPar!.sampleSize).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("computeRoundInsights — edge cases", () => {
  it("handles negative to-par rounds correctly (below average)", () => {
    // Both this round and history are under par
    const round = makeRoundWithToPar("r1", "2026-06-01", -3);
    const history = [
      makeRoundWithToPar("h1", "2026-01-01", -1),
      makeRoundWithToPar("h2", "2026-01-02", -2),
    ];
    const result = computeRoundInsights(round, history);
    expect(result.state).toBe("ready");
    // avg = -1.5, this = -3, delta = -1.5 (better)
    expect(result.vsAverageToPar!.historicalAvg).toBe(-1.5);
    expect(result.vsAverageToPar!.delta).toBe(-1.5);
    expect(result.ranking!.rank).toBe(1);
  });

  it("correctly counts sampleSize across many rounds", () => {
    const round = makeRoundWithToPar("r1", "2026-06-01", 5);
    const history = Array.from({ length: 10 }, (_, i) =>
      makeRoundWithToPar(`h${i}`, `2026-0${Math.floor(i / 30) + 1}-${(i % 30) + 1 < 10 ? `0${(i % 30) + 1}` : (i % 30) + 1}`, 8)
    );
    const result = computeRoundInsights(round, history);
    expect(result.vsAverageToPar!.sampleSize).toBe(10);
    expect(result.ranking!.total).toBe(11);
    expect(result.ranking!.rank).toBe(1); // scored +5 vs avg +8
  });
});
