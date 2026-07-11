/**
 * Unit tests for buildStatsGroundingBlock (lib/stats-grounding.ts).
 *
 * The module is a pure serializer of REAL derived stats — no fabricated
 * coaching, every stat carries its sample size, honest-thin sentinel below
 * 2 valid rounds, null only when there is literally nothing real at all.
 *
 * DO NOT modify stats-grounding.ts to make these tests pass — fix the tests
 * instead if a formula is wrong.
 */

import { describe, it, expect } from "vitest";
import { buildStatsGroundingBlock } from "./stats-grounding";
import type { Round, HoleInfo, Player, Score, GolferProfile } from "./types";
import type { ClubStat } from "./shot-stats";

// ── Test helpers ─────────────────────────────────────────────────────────────

const PARS = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 4, 5]; // 18 holes, sum=72

function makeHoles(pars: number[]): HoleInfo[] {
  return pars.map((par, i) => ({ number: i + 1, par }));
}

function makePlayers(ids: string[]): Player[] {
  return ids.map((id) => ({ id, name: id }));
}

/** Per-hole delta-vs-par array summing exactly to `total` (integer strokes). */
function deltasForToPar(total: number): number[] {
  const deltas = new Array(PARS.length).fill(0);
  const sign = total >= 0 ? 1 : -1;
  for (let i = 0; i < Math.abs(total); i++) deltas[i] = sign;
  return deltas;
}

/** A full, fully-scored 18-hole completed round for owner "p1" at the given
 *  total to-par (deterministic — every hole has a real strokes value, so
 *  estimateHandicapFromRounds can use it). */
function makeRound(id: string, date: string, toPar: number, overrides: Partial<Round> = {}): Round {
  const holes = makeHoles(PARS);
  const deltas = deltasForToPar(toPar);
  const scores: Score[] = holes.map((h, i) => ({
    playerId: "p1",
    holeNumber: h.number,
    strokes: h.par + deltas[i],
  }));
  return {
    id,
    courseId: "c1",
    courseName: `Course ${id}`,
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

function makeProfile(overrides: Partial<GolferProfile> = {}): GolferProfile {
  return {
    id: "u1",
    name: "Test Golfer",
    handicap: null,
    homeCourse: null,
    clubDistances: {},
    ...overrides,
  };
}

function makeClubStat(overrides: Partial<ClubStat> = {}): ClubStat {
  return {
    club: "driver",
    n: 41,
    avg_distance: 268,
    median_distance: 270,
    stdev_distance: 14,
    most_common_lie: null,
    ...overrides,
  };
}

// 7 fully-scored rounds, oldest → newest. deriveTrend sorts newest-first
// internally, so the chronologically-recent 5 (r7..r3) average to-par
// (-1+6+7+6+7)/5 = +5, vs the prior 2 (r2,r1) average (9+9)/2 = +9 — an
// "improving" trend. r7 (most recent) is also the career-best round.
const RICH_ROUNDS: Round[] = [
  makeRound("r1", "2026-01-01", 9),
  makeRound("r2", "2026-01-02", 9),
  makeRound("r3", "2026-01-03", 7),
  makeRound("r4", "2026-01-04", 6),
  makeRound("r5", "2026-01-05", 7),
  makeRound("r6", "2026-01-06", 6),
  makeRound("r7", "2026-01-07", -1, { courseName: "Presidio" }), // best round
];

describe("buildStatsGroundingBlock — rich data", () => {
  it("includes handicap, trend, par-type, scoring mix, best round, and club lines — each with a sample size", () => {
    const block = buildStatsGroundingBlock(RICH_ROUNDS, [makeClubStat()], makeProfile());
    expect(block).not.toBeNull();
    const text = block!;

    // Handicap — estimated path (profile.handicap null), notes rounds used.
    expect(text).toMatch(/Handicap: -?\d+(\.\d+)? \(estimated from 7 rounds\)/);

    // Trend — both window sizes present, improving (recent avg < prior avg).
    expect(text).toContain("Recent trend:");
    expect(text).toMatch(/last 5 rounds avg \+5/);
    expect(text).toMatch(/prior 2 rounds avg \+9/);
    expect(text).toContain("improving");

    // Par-type averages — holeCount sample size per par type.
    expect(text).toContain("Par-type scoring:");
    expect(text).toMatch(/Par-3 .* over \d+ holes/);
    expect(text).toMatch(/Par-4 .* over \d+ holes/);
    expect(text).toMatch(/Par-5 .* over \d+ holes/);

    // Scoring mix — percentages + total hole count.
    expect(text).toContain("Scoring mix:");
    expect(text).toMatch(/over \d+ holes\)/);

    // Best round — the -1 round at Presidio.
    expect(text).toContain("Best round: -1 at Presidio");

    // Club line — n + median + dispersion.
    expect(text).toContain("Driver: 268y avg (n=41, median 270, ±14y)");
  });

  it("set handicap wins over the estimate and is labelled 'set', not 'estimated'", () => {
    const block = buildStatsGroundingBlock(RICH_ROUNDS, [], makeProfile({ handicap: 15 }));
    expect(block).toContain("Handicap: 15 (set)");
    expect(block).not.toContain("estimated");
  });

  it("a club with n<2 (stdev null) renders without a bogus ± dispersion", () => {
    const thin = makeClubStat({ club: "putter", n: 1, avg_distance: 10, median_distance: 10, stdev_distance: null });
    const block = buildStatsGroundingBlock(RICH_ROUNDS, [thin], makeProfile());
    expect(block).toContain("Putter: 10y avg (n=1, median 10)");
    // No dispersion suffix for this line at all.
    const putterLine = block!.split("\n").find((l) => l.startsWith("Putter:"));
    expect(putterLine).not.toContain("±");
  });
});

describe("buildStatsGroundingBlock — thin data", () => {
  it("returns an honest 'not enough' sentinel with <2 valid rounds", () => {
    const block = buildStatsGroundingBlock([RICH_ROUNDS[0]], [], makeProfile());
    expect(block).not.toBeNull();
    expect(block!.toLowerCase()).toContain("not enough");
    expect(block).toContain("only 1 logged");
  });

  it("returns null when there is literally nothing real (0 rounds, 0 clubStats)", () => {
    const block = buildStatsGroundingBlock([], [], null);
    expect(block).toBeNull();
  });

  it("0 rounds but non-empty clubStats → honest thin block WITH club lines, not null", () => {
    const block = buildStatsGroundingBlock([], [makeClubStat()], null);
    expect(block).not.toBeNull();
    expect(block!.toLowerCase()).toContain("not enough");
    expect(block).toContain("none logged yet");
    expect(block).toContain("Driver: 268y avg (n=41, median 270, ±14y)");
  });

  it("active (in-progress) rounds don't count toward the valid-round threshold", () => {
    const active = makeRound("a1", "2026-02-01", 0, { status: "active" });
    const block = buildStatsGroundingBlock([RICH_ROUNDS[0], active], [], makeProfile());
    // Still only 1 VALID (completed) round — thin sentinel, not the rich block.
    expect(block!.toLowerCase()).toContain("not enough");
  });
});
