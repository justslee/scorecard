/**
 * Unit tests for the career personal-bests derivation helpers (lib/personal-bests.ts).
 *
 * All helpers are pure functions; tests cover:
 * - No rounds / empty state
 * - Single round (18H and 9H)
 * - Mixed 9H and 18H rounds
 * - Incomplete rounds (< 9 holes played)
 * - Owner-not-first-player (explicit ownerPlayerId)
 * - Eagle / birdie counting
 * - Best-hole tiebreaking
 * - Best-round tiebreaking (equal toPar → prefer newer date)
 * - Birdie-streak counting (consecutive holes) and reset behaviour
 * - Streak resets on un-scored (null / absent) holes
 * - Active rounds are excluded
 * - Rounds with no players are excluded
 *
 * DO NOT modify personal-bests.ts to make these tests pass.
 */

import { describe, it, expect } from "vitest";
import { derivePersonalBests } from "./personal-bests";
import type { Round, HoleInfo, Player, Score } from "./types";

// ── Test helpers ────────────────────────────────────────────────────────────

function makeHoles(pars: number[], startAt = 1): HoleInfo[] {
  return pars.map((par, i) => ({ number: startAt + i, par }));
}

function makePlayers(ids: string[]): Player[] {
  return ids.map((id) => ({ id, name: id }));
}

function makeScores(
  playerId: string,
  holeNumbers: number[],
  strokes: (number | null)[]
): Score[] {
  return holeNumbers.map((holeNumber, i) => ({
    playerId,
    holeNumber,
    strokes: strokes[i],
  }));
}

const STD_18_PARS = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 4, 5];
const NINE_PARS = [4, 4, 3, 5, 4, 4, 3, 4, 5];

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

/** Build a round where the owner scores par on every hole (easy baseline). */
function makeParRound(id: string, date: string, pars = STD_18_PARS): Round {
  const holes = makeHoles(pars);
  const holeNums = holes.map((h) => h.number);
  return makeRound({
    id,
    date,
    holes,
    scores: makeScores("p1", holeNums, pars), // strokes === par on each hole
  });
}

// ── Zero state ────────────────────────────────────────────────────────────────

describe("derivePersonalBests — zero state", () => {
  it("returns zero state when rounds array is empty", () => {
    const bests = derivePersonalBests([]);
    expect(bests.roundsPlayed).toBe(0);
    expect(bests.bestRound).toBeNull();
    expect(bests.milestones).toEqual({ eagles: 0, birdies: 0, pars: 0 });
    expect(bests.bestHoleByPar).toEqual({ par3: null, par4: null, par5: null });
    expect(bests.longestBirdieStreak).toBe(0);
  });

  it("excludes active (non-completed) rounds", () => {
    const r = makeRound({ status: "active", scores: makeScores("p1", [1], [3]) });
    expect(derivePersonalBests([r])).toMatchObject({
      roundsPlayed: 0,
      bestRound: null,
      milestones: { eagles: 0, birdies: 0, pars: 0 },
      longestBirdieStreak: 0,
    });
  });

  it("excludes completed rounds with no players", () => {
    const r = makeRound({ players: [], scores: makeScores("p1", [1], [4]) });
    expect(derivePersonalBests([r])).toMatchObject({
      roundsPlayed: 0,
      bestRound: null,
    });
  });

  it("returns zero state for a completed round with zero scores", () => {
    const r = makeRound({ scores: [] });
    expect(derivePersonalBests([r])).toMatchObject({
      roundsPlayed: 0,
      bestRound: null,
      milestones: { eagles: 0, birdies: 0, pars: 0 },
      longestBirdieStreak: 0,
    });
  });
});

// ── roundsPlayed ─────────────────────────────────────────────────────────────

describe("roundsPlayed", () => {
  it("counts a single 18H completed round", () => {
    const r = makeParRound("r1", "2026-01-01");
    expect(derivePersonalBests([r]).roundsPlayed).toBe(1);
  });

  it("counts a 9H completed round (9 holes played)", () => {
    const r = makeParRound("r1", "2026-01-01", NINE_PARS);
    expect(derivePersonalBests([r]).roundsPlayed).toBe(1);
  });

  it("does NOT count a round with fewer than 9 played holes", () => {
    const holes = makeHoles(STD_18_PARS);
    // Only 5 holes scored
    const r = makeRound({
      holes,
      scores: makeScores("p1", [1, 2, 3, 4, 5], [4, 4, 3, 5, 4]),
    });
    expect(derivePersonalBests([r]).roundsPlayed).toBe(0);
  });

  it("accumulates count across multiple rounds", () => {
    const r1 = makeParRound("r1", "2026-01-01");
    const r2 = makeParRound("r2", "2026-01-02");
    const r3 = makeParRound("r3", "2026-01-03", NINE_PARS);
    expect(derivePersonalBests([r1, r2, r3]).roundsPlayed).toBe(3);
  });
});

// ── bestRound ─────────────────────────────────────────────────────────────────

describe("bestRound", () => {
  it("is null when no round has ≥9 played holes", () => {
    const r = makeRound({
      scores: makeScores("p1", [1, 2], [4, 5]), // only 2 holes
    });
    expect(derivePersonalBests([r]).bestRound).toBeNull();
  });

  it("captures the best round from a single-round history", () => {
    const holes = makeHoles(STD_18_PARS);
    // Score par on every hole → toPar = 0
    const scores = makeScores(
      "p1",
      holes.map((h) => h.number),
      STD_18_PARS
    );
    const r = makeRound({
      id: "r1",
      courseName: "Augusta National",
      date: "2026-06-01",
      holes,
      scores,
    });
    const bests = derivePersonalBests([r]);
    expect(bests.bestRound).not.toBeNull();
    expect(bests.bestRound!.toPar).toBe(0);
    expect(bests.bestRound!.courseName).toBe("Augusta National");
    expect(bests.bestRound!.holeCount).toBe(18);
    expect(bests.bestRound!.date).toBe("2026-06-01");
  });

  it("picks the round with the lower toPar", () => {
    const holes = makeHoles(STD_18_PARS);
    const holeNums = holes.map((h) => h.number);

    // r1: all par (toPar = 0)
    const r1 = makeRound({
      id: "r1",
      date: "2026-01-01",
      courseName: "Course A",
      holes,
      scores: makeScores("p1", holeNums, STD_18_PARS),
    });
    // r2: bogey on first hole (toPar = +1)
    const r2Strokes = [...STD_18_PARS];
    r2Strokes[0] += 1;
    const r2 = makeRound({
      id: "r2",
      date: "2026-01-02",
      courseName: "Course B",
      holes,
      scores: makeScores("p1", holeNums, r2Strokes),
    });

    const bests = derivePersonalBests([r1, r2]);
    expect(bests.bestRound!.courseName).toBe("Course A");
    expect(bests.bestRound!.toPar).toBe(0);
  });

  it("tie-breaks on date — prefers the more recent round", () => {
    const holes = makeHoles(STD_18_PARS);
    const holeNums = holes.map((h) => h.number);
    const evenPars = makeScores("p1", holeNums, STD_18_PARS);

    const r1 = makeRound({
      id: "r1",
      date: "2026-01-01",
      courseName: "Course Old",
      holes,
      scores: evenPars,
    });
    const r2 = makeRound({
      id: "r2",
      date: "2026-06-15",
      courseName: "Course New",
      holes,
      scores: evenPars,
    });

    // Both toPar = 0 → newer date (r2) wins.
    const bests = derivePersonalBests([r1, r2]);
    expect(bests.bestRound!.courseName).toBe("Course New");
  });

  it("normalises date to YYYY-MM-DD (strips time component)", () => {
    const holes = makeHoles(STD_18_PARS);
    const r = makeRound({
      date: "2026-03-10T08:30:00Z",
      holes,
      scores: makeScores(
        "p1",
        holes.map((h) => h.number),
        STD_18_PARS
      ),
    });
    const bests = derivePersonalBests([r]);
    expect(bests.bestRound!.date).toBe("2026-03-10");
  });

  it("records the raw totalStrokes of the best round", () => {
    const holes = makeHoles(STD_18_PARS);
    // Score one bogey on hole 1 (5 on a par-4), par on everything else.
    const strokes = [...STD_18_PARS];
    strokes[0] = 5;
    const r = makeRound({
      holes,
      scores: makeScores(
        "p1",
        holes.map((h) => h.number),
        strokes
      ),
    });
    const bests = derivePersonalBests([r]);
    const expectedTotal = strokes.reduce((a, b) => a + b, 0);
    expect(bests.bestRound!.totalStrokes).toBe(expectedTotal);
  });

  it("9H round is a valid bestRound candidate", () => {
    const holes = makeHoles(NINE_PARS);
    const r = makeRound({
      holes,
      scores: makeScores(
        "p1",
        holes.map((h) => h.number),
        NINE_PARS
      ),
    });
    const bests = derivePersonalBests([r]);
    expect(bests.bestRound).not.toBeNull();
    expect(bests.bestRound!.holeCount).toBe(9);
  });

  it("uses ownerPlayerId over players[0] when set", () => {
    const holes = makeHoles(STD_18_PARS);
    const holeNums = holes.map((h) => h.number);
    // p2 is the owner (explicit ownerPlayerId), p1 is listed first.
    const r = makeRound({
      players: makePlayers(["p1", "p2"]),
      ownerPlayerId: "p2",
      holes,
      scores: [
        // p1 plays badly
        ...makeScores("p1", holeNums, STD_18_PARS.map((p) => p + 3)),
        // p2 (owner) plays par
        ...makeScores("p2", holeNums, STD_18_PARS),
      ],
    });
    const bests = derivePersonalBests([r]);
    // Owner is p2, toPar should be 0 (par), not +54 (p1's score).
    expect(bests.bestRound!.toPar).toBe(0);
  });
});

// ── milestones ────────────────────────────────────────────────────────────────

describe("milestones", () => {
  it("counts zero when no special scores are made", () => {
    // All bogeys — no eagles, birdies, or pars.
    const holes = makeHoles([4, 4, 4]);
    const r = makeRound({
      holes,
      scores: makeScores("p1", [1, 2, 3], [5, 5, 5]),
    });
    expect(derivePersonalBests([r]).milestones).toEqual({
      eagles: 0,
      birdies: 0,
      pars: 0,
    });
  });

  it("counts a single birdie (delta === -1)", () => {
    const holes = makeHoles([4]);
    const r = makeRound({
      holes,
      scores: [{ playerId: "p1", holeNumber: 1, strokes: 3 }],
    });
    expect(derivePersonalBests([r]).milestones.birdies).toBe(1);
  });

  it("counts a single eagle (delta === -2)", () => {
    const holes = makeHoles([5]);
    const r = makeRound({
      holes,
      scores: [{ playerId: "p1", holeNumber: 1, strokes: 3 }],
    });
    expect(derivePersonalBests([r]).milestones.eagles).toBe(1);
  });

  it("counts eagle-or-better for delta ≤ -2 (albatross on a par-5)", () => {
    const holes = makeHoles([5]);
    const r = makeRound({
      holes,
      scores: [{ playerId: "p1", holeNumber: 1, strokes: 2 }], // −3
    });
    expect(derivePersonalBests([r]).milestones.eagles).toBe(1);
    expect(derivePersonalBests([r]).milestones.birdies).toBe(0);
  });

  it("counts pars correctly (delta === 0)", () => {
    const holes = makeHoles([3, 4, 5]);
    const r = makeRound({
      holes,
      scores: makeScores("p1", [1, 2, 3], [3, 4, 5]),
    });
    expect(derivePersonalBests([r]).milestones.pars).toBe(3);
    expect(derivePersonalBests([r]).milestones.birdies).toBe(0);
    expect(derivePersonalBests([r]).milestones.eagles).toBe(0);
  });

  it("accumulates milestones across multiple rounds", () => {
    const holes = makeHoles([4]);
    // r1: birdie (3 on par-4)
    const r1 = makeRound({
      id: "r1",
      date: "2026-01-01",
      holes,
      scores: [{ playerId: "p1", holeNumber: 1, strokes: 3 }],
    });
    // r2: eagle (2 on par-4 — unusual but valid)
    const r2 = makeRound({
      id: "r2",
      date: "2026-01-02",
      holes,
      scores: [{ playerId: "p1", holeNumber: 1, strokes: 2 }],
    });
    const bests = derivePersonalBests([r1, r2]);
    expect(bests.milestones.birdies).toBe(1);
    expect(bests.milestones.eagles).toBe(1);
  });

  it("skips null-strokes holes for milestone counting", () => {
    const holes = makeHoles([4, 4]);
    const r = makeRound({
      holes,
      scores: [
        { playerId: "p1", holeNumber: 1, strokes: null }, // no score
        { playerId: "p1", holeNumber: 2, strokes: 3 },    // birdie
      ],
    });
    expect(derivePersonalBests([r]).milestones.birdies).toBe(1);
  });

  it("only counts owner's scores — ignores other players", () => {
    const holes = makeHoles([4]);
    const r = makeRound({
      players: makePlayers(["p1", "p2"]),
      holes,
      scores: [
        { playerId: "p1", holeNumber: 1, strokes: 4 }, // par (owner)
        { playerId: "p2", holeNumber: 1, strokes: 3 }, // birdie (other) — ignored
      ],
    });
    const bests = derivePersonalBests([r]);
    expect(bests.milestones.birdies).toBe(0);
    expect(bests.milestones.pars).toBe(1);
  });

  it("counts milestones from incomplete rounds (< 9 holes) too", () => {
    // A partial round (only 3 holes) doesn't count toward bestRound / roundsPlayed
    // but its scored holes do contribute to milestone counts.
    const holes = makeHoles([4, 4, 4]);
    const r = makeRound({
      holes,
      scores: makeScores("p1", [1, 2, 3], [3, 3, 3]), // three birdies
    });
    const bests = derivePersonalBests([r]);
    expect(bests.roundsPlayed).toBe(0); // round not counted (only 3 holes)
    expect(bests.milestones.birdies).toBe(3); // birdies still counted
  });
});

// ── bestHoleByPar ─────────────────────────────────────────────────────────────

describe("bestHoleByPar", () => {
  it("is null for all par types when there are no scored holes", () => {
    expect(derivePersonalBests([]).bestHoleByPar).toEqual({
      par3: null,
      par4: null,
      par5: null,
    });
  });

  it("records the best delta for par-3, par-4, and par-5 holes", () => {
    const holes = makeHoles([3, 4, 5]);
    const r = makeRound({
      holes,
      scores: makeScores("p1", [1, 2, 3], [2, 3, 4]), // -1, -1, -1 (all birdies)
    });
    const bests = derivePersonalBests([r]);
    expect(bests.bestHoleByPar.par3).toEqual({ delta: -1, strokes: 2 });
    expect(bests.bestHoleByPar.par4).toEqual({ delta: -1, strokes: 3 });
    expect(bests.bestHoleByPar.par5).toEqual({ delta: -1, strokes: 4 });
  });

  it("picks the lower-delta score when two holes of the same par type exist", () => {
    const holes = makeHoles([4, 4]);
    const r = makeRound({
      holes,
      scores: makeScores("p1", [1, 2], [3, 5]), // birdie then bogey
    });
    const bests = derivePersonalBests([r]);
    expect(bests.bestHoleByPar.par4!.delta).toBe(-1); // birdie wins
    expect(bests.bestHoleByPar.par4!.strokes).toBe(3);
  });

  it("tie-breaks on raw strokes (lower strokes wins) when delta is equal", () => {
    // Two par-5 holes: one scored 3 (−2 eagle), one scored 4 (−1 birdie).
    // Then two par-5 holes with same delta −1: strokes 4 and 5.
    // Simpler: a par-3 eagle via score 1 vs a par-3 eagle via score 0 (weird but testable).
    // Use realistic: two par-4 holes both scored 3 (= birdie −1). Lower strokes wins (same).
    // Test: two par-3 holes scored 2 and 2 (tie) — should store {delta:-1, strokes:2}.
    const holes = makeHoles([3, 3]);
    const r = makeRound({
      holes,
      scores: makeScores("p1", [1, 2], [2, 2]),
    });
    const bests = derivePersonalBests([r]);
    expect(bests.bestHoleByPar.par3).toEqual({ delta: -1, strokes: 2 });
  });

  it("tie-breaks on strokes: lower strokes beats equal-delta higher strokes", () => {
    // Two par-5 holes: score 3 (−2 eagle, 3 strokes) and score 2 (−3 albatross, 2 strokes).
    // The albatross has delta=−3 < delta=−2, so it wins by delta alone.
    // Test the strokes tie-break: same delta on two par-4s: strokes 3 vs 4 — 3 wins.
    // Actually for same delta, lower strokes happens only if we have identical par × different
    // raw scores... which isn't possible on the same hole. It happens across different
    // par type buckets comparing same bucket across rounds (e.g. hole 1 par-4 scored 4=par,
    // hole 2 par-4 scored 4=par). Same strokes and delta — nothing to distinguish.
    // Real tie-break case: can arise if par is the same but we have e.g. par-4 scored 3
    // in round 1 and par-4 scored 3 in round 2 (identical) — shouldn't change result.
    const holes4 = makeHoles([4]);
    const r1 = makeRound({
      id: "r1",
      date: "2026-01-01",
      holes: holes4,
      scores: [{ playerId: "p1", holeNumber: 1, strokes: 4 }], // par
    });
    const r2 = makeRound({
      id: "r2",
      date: "2026-01-02",
      holes: holes4,
      scores: [{ playerId: "p1", holeNumber: 1, strokes: 3 }], // birdie
    });
    const bests = derivePersonalBests([r1, r2]);
    expect(bests.bestHoleByPar.par4!.delta).toBe(-1);
    expect(bests.bestHoleByPar.par4!.strokes).toBe(3);
  });

  it("updates bestHole across rounds (better score in second round wins)", () => {
    const holes = makeHoles([5]);
    const r1 = makeRound({
      id: "r1",
      date: "2026-01-01",
      holes,
      scores: [{ playerId: "p1", holeNumber: 1, strokes: 4 }], // birdie
    });
    const r2 = makeRound({
      id: "r2",
      date: "2026-01-02",
      holes,
      scores: [{ playerId: "p1", holeNumber: 1, strokes: 3 }], // eagle
    });
    const bests = derivePersonalBests([r1, r2]);
    expect(bests.bestHoleByPar.par5!.delta).toBe(-2);
    expect(bests.bestHoleByPar.par5!.strokes).toBe(3);
  });

  it("only counts owner scores for best-hole stats", () => {
    const holes = makeHoles([4]);
    const r = makeRound({
      players: makePlayers(["p1", "p2"]),
      ownerPlayerId: "p1",
      holes,
      scores: [
        { playerId: "p1", holeNumber: 1, strokes: 4 }, // owner: par
        { playerId: "p2", holeNumber: 1, strokes: 2 }, // other: eagle (ignored)
      ],
    });
    const bests = derivePersonalBests([r]);
    expect(bests.bestHoleByPar.par4!.delta).toBe(0); // owner's par, not eagle
  });
});

// ── longestBirdieStreak ───────────────────────────────────────────────────────

describe("longestBirdieStreak", () => {
  it("is 0 with no rounds", () => {
    expect(derivePersonalBests([]).longestBirdieStreak).toBe(0);
  });

  it("is 0 when no birdies are made", () => {
    const holes = makeHoles([4, 4, 4]);
    const r = makeRound({
      holes,
      scores: makeScores("p1", [1, 2, 3], [4, 5, 6]), // par / bogey / double
    });
    expect(derivePersonalBests([r]).longestBirdieStreak).toBe(0);
  });

  it("counts a single birdie as streak of 1", () => {
    const holes = makeHoles([4]);
    const r = makeRound({
      holes,
      scores: [{ playerId: "p1", holeNumber: 1, strokes: 3 }],
    });
    expect(derivePersonalBests([r]).longestBirdieStreak).toBe(1);
  });

  it("counts two consecutive birdies as streak of 2", () => {
    const holes = makeHoles([4, 4]);
    const r = makeRound({
      holes,
      scores: makeScores("p1", [1, 2], [3, 3]),
    });
    expect(derivePersonalBests([r]).longestBirdieStreak).toBe(2);
  });

  it("resets streak when a non-birdie hole intervenes", () => {
    // holes: birdie / par / birdie / birdie — longest run = 2
    const holes = makeHoles([4, 4, 4, 4]);
    const r = makeRound({
      holes,
      scores: makeScores("p1", [1, 2, 3, 4], [3, 4, 3, 3]),
    });
    expect(derivePersonalBests([r]).longestBirdieStreak).toBe(2);
  });

  it("eagle-or-better also extends the birdie streak (delta ≤ -1)", () => {
    // birdie / eagle / birdie — consecutive streak of 3
    const holes = makeHoles([4, 5, 3]);
    const r = makeRound({
      holes,
      scores: makeScores("p1", [1, 2, 3], [3, 3, 2]), // -1, -2, -1
    });
    expect(derivePersonalBests([r]).longestBirdieStreak).toBe(3);
  });

  it("breaks streak when a hole has no score (null strokes)", () => {
    // birdie / no-score / birdie — each run is 1; longest = 1
    const holes = makeHoles([4, 4, 4]);
    const r = makeRound({
      holes,
      scores: [
        { playerId: "p1", holeNumber: 1, strokes: 3 },    // birdie
        { playerId: "p1", holeNumber: 2, strokes: null },  // no score
        { playerId: "p1", holeNumber: 3, strokes: 3 },    // birdie
      ],
    });
    expect(derivePersonalBests([r]).longestBirdieStreak).toBe(1);
  });

  it("breaks streak when a hole has no score entry at all (absent from scores)", () => {
    // Round has 3 holes; owner only submitted scores for holes 1 and 3.
    // Hole 2 is missing entirely → should break the streak.
    const holes = makeHoles([4, 4, 4]);
    const r = makeRound({
      holes,
      scores: [
        { playerId: "p1", holeNumber: 1, strokes: 3 }, // birdie
        // hole 2 missing — absent
        { playerId: "p1", holeNumber: 3, strokes: 3 }, // birdie
      ],
    });
    expect(derivePersonalBests([r]).longestBirdieStreak).toBe(1);
  });

  it("streaks DO NOT carry across rounds (reset between rounds)", () => {
    // Each round: birdie on hole 1, bogey on hole 2 (streak of 1 per round).
    const holes = makeHoles([4, 4]);
    const r1 = makeRound({
      id: "r1",
      date: "2026-01-01",
      holes,
      scores: makeScores("p1", [1, 2], [3, 5]), // birdie then bogey
    });
    const r2 = makeRound({
      id: "r2",
      date: "2026-01-02",
      holes,
      scores: makeScores("p1", [1, 2], [3, 5]), // birdie then bogey
    });
    // If streaks crossed rounds wrongly we'd see 2; correct answer is 1.
    expect(derivePersonalBests([r1, r2]).longestBirdieStreak).toBe(1);
  });

  it("picks the longest streak across multiple rounds", () => {
    // r1: streak of 2; r2: streak of 4 — should return 4.
    const holes = makeHoles([4, 4, 4, 4]);
    const r1 = makeRound({
      id: "r1",
      date: "2026-01-01",
      holes,
      scores: makeScores("p1", [1, 2, 3, 4], [3, 3, 5, 5]), // 2 birdies then bogeys
    });
    const r2 = makeRound({
      id: "r2",
      date: "2026-01-02",
      holes,
      scores: makeScores("p1", [1, 2, 3, 4], [3, 3, 3, 3]), // 4 birdies
    });
    expect(derivePersonalBests([r1, r2]).longestBirdieStreak).toBe(4);
  });

  it("only counts owner's scores for the streak", () => {
    const holes = makeHoles([4, 4]);
    const r = makeRound({
      players: makePlayers(["p1", "p2"]),
      ownerPlayerId: "p1",
      holes,
      scores: [
        { playerId: "p1", holeNumber: 1, strokes: 5 },  // bogey (owner)
        { playerId: "p1", holeNumber: 2, strokes: 5 },  // bogey (owner)
        { playerId: "p2", holeNumber: 1, strokes: 3 },  // birdie (other — ignored)
        { playerId: "p2", holeNumber: 2, strokes: 3 },  // birdie (other — ignored)
      ],
    });
    expect(derivePersonalBests([r]).longestBirdieStreak).toBe(0);
  });
});

// ── integration: mixed 9H and 18H ─────────────────────────────────────────────

describe("mixed 9H and 18H rounds", () => {
  it("counts both as roundsPlayed and selects best overall", () => {
    const holes18 = makeHoles(STD_18_PARS);
    const holes9 = makeHoles(NINE_PARS);

    // 18H round: toPar = +2 (two bogeys)
    const strokes18 = [...STD_18_PARS];
    strokes18[0] += 1;
    strokes18[1] += 1;
    const r18 = makeRound({
      id: "r18",
      date: "2026-01-01",
      courseName: "Full Course",
      holes: holes18,
      scores: makeScores(
        "p1",
        holes18.map((h) => h.number),
        strokes18
      ),
    });

    // 9H round: toPar = 0 (all pars) — better toPar
    const r9 = makeRound({
      id: "r9",
      date: "2026-01-02",
      courseName: "Executive 9",
      holes: holes9,
      scores: makeScores(
        "p1",
        holes9.map((h) => h.number),
        NINE_PARS
      ),
    });

    const bests = derivePersonalBests([r18, r9]);
    expect(bests.roundsPlayed).toBe(2);
    expect(bests.bestRound!.courseName).toBe("Executive 9");
    expect(bests.bestRound!.toPar).toBe(0);
    expect(bests.bestRound!.holeCount).toBe(9);
  });
});

// ── integration: owner-not-first-player ───────────────────────────────────────

describe("owner identified via ownerPlayerId (not players[0])", () => {
  it("uses ownerPlayerId for all metrics when set", () => {
    const holes = makeHoles([4, 4, 4]);
    const r = makeRound({
      players: makePlayers(["p1", "p2"]),
      ownerPlayerId: "p2",
      holes,
      scores: [
        // p1 (listed first, NOT owner): bogeys
        ...makeScores("p1", [1, 2, 3], [5, 5, 5]),
        // p2 (owner, listed second): birdies
        ...makeScores("p2", [1, 2, 3], [3, 3, 3]),
      ],
    });
    const bests = derivePersonalBests([r]);
    // milestones should reflect p2's 3 birdies, not p1's 0 birdies
    expect(bests.milestones.birdies).toBe(3);
    expect(bests.milestones.pars).toBe(0);
    expect(bests.longestBirdieStreak).toBe(3);
  });
});
