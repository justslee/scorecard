/**
 * Unit tests for tournament leaderboard standings math
 * (specs/tournament-net-handicap-leaderboard-plan.md).
 *
 * Covers:
 *  - net total + per-round math (single round)
 *  - per-round net allocation summed correctly over a 2-round tournament
 *  - missing-handicap → totalNet null (unranked, NOT 0)
 *  - net re-rank order + tie-aware "T"-label in net mode
 *  - gross/toPar standings are unchanged by the new playerHandicaps arg
 */

import { describe, it, expect } from "vitest";
import { computeStandings, tieRankLabel, sortStandings } from "./tournament-standings";
import type { Round, Score, HoleInfo, Player } from "./types";

function makeHoles(pars?: number[]): HoleInfo[] {
  const p = pars ?? Array<number>(18).fill(4); // par 72
  return p.map((par, i) => ({ number: i + 1, par }));
}

function makePlayers(ids: string[]): Player[] {
  return ids.map((id) => ({ id, name: id }));
}

function makeScores(playerId: string, strokesPerHole: number[]): Score[] {
  return strokesPerHole.map((strokes, i) => ({
    playerId,
    holeNumber: i + 1,
    strokes,
  }));
}

function makeRound(overrides: Partial<Round> = {}): Round {
  return {
    id: "r1",
    courseId: "c1",
    courseName: "Test Course",
    date: "2026-01-01",
    players: makePlayers(["p1", "p2"]),
    scores: [],
    holes: makeHoles(),
    games: [],
    status: "completed",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("computeStandings — net handicap math", () => {
  it("computes per-round net and totalNet for a single round (gross − rounded handicap)", () => {
    // p1 shoots 90 gross with a 12.4 handicap → rounds to 12 (chicago convention:
    // Math.round, full-handicap subtraction) → net = 90 - 12 = 78.
    const round = makeRound({
      players: makePlayers(["p1"]),
      scores: makeScores("p1", Array<number>(18).fill(5)), // 90 total
    });
    const standings = computeStandings(
      ["p1"],
      { p1: "Player One" },
      { p1: 12.4 },
      [round]
    );
    expect(standings).toHaveLength(1);
    const s = standings[0];
    expect(s.handicap).toBe(12); // Math.round(12.4)
    expect(s.roundNet).toEqual([78]); // 90 - 12
    expect(s.totalNet).toBe(78);
  });

  it("rounds .5 handicap up (Math.round convention) and applies per-round allocation summed over 2 rounds", () => {
    // handicap 8.5 → Math.round → 9 (JS Math.round rounds .5 up for positive numbers)
    // Round 1: 88 gross → net 79. Round 2: 92 gross → net 83. totalNet = 79 + 83 = 162.
    const r1 = makeRound({
      id: "r1",
      players: makePlayers(["p1"]),
      scores: makeScores("p1", [
        5, 5, 5, 5, 5, 5, 5, 5, 5, // front: 45
        5, 5, 5, 5, 5, 5, 5, 5, 3, // back: 43 → total 88
      ]),
    });
    const r2 = makeRound({
      id: "r2",
      players: makePlayers(["p1"]),
      scores: makeScores("p1", [
        5, 5, 5, 5, 5, 5, 5, 5, 5, // front: 45
        5, 5, 5, 5, 5, 5, 5, 5, 7, // back: 47 → total 92
      ]),
    });
    const standings = computeStandings(
      ["p1"],
      { p1: "Player One" },
      { p1: 8.5 },
      [r1, r2]
    );
    const s = standings[0];
    expect(s.handicap).toBe(9);
    expect(s.roundTotals).toEqual([88, 92]);
    expect(s.roundNet).toEqual([79, 83]);
    // Per-round allocation summed matches totalStrokes - handicap*roundsWithScore.
    expect(s.totalNet).toBe(79 + 83);
    expect(s.totalNet).toBe(180 - 9 * 2);
  });

  it("treats a missing handicap as null (unranked) — NEVER as 0", () => {
    const round = makeRound({
      players: makePlayers(["p1", "p2"]),
      scores: [
        ...makeScores("p1", Array<number>(18).fill(4)), // 72, no handicap given
        ...makeScores("p2", Array<number>(18).fill(5)), // 90, handicap 10
      ],
    });
    const standings = computeStandings(
      ["p1", "p2"],
      { p1: "No Handicap", p2: "Has Handicap" },
      { p2: 10 }, // p1 intentionally absent from the map
      [round]
    );
    const p1 = standings.find((s) => s.playerId === "p1")!;
    const p2 = standings.find((s) => s.playerId === "p2")!;

    expect(p1.handicap).toBeNull();
    expect(p1.totalNet).toBeNull(); // NOT 0, even though p1 shot the better gross round
    expect(p1.roundNet).toEqual([null]);

    expect(p2.handicap).toBe(10);
    expect(p2.totalNet).toBe(80); // 90 - 10
  });

  it("treats an EXPLICIT null handicap as no-handicap (never a fabricated scratch 0)", () => {
    // The backend serialises an unset handicap as literal `null` (not omitted),
    // so a null can reach the map. It must resolve to null ("no hcp"), NOT
    // Math.round(null) === 0 which would rank an un-handicapped player as scratch.
    const round = makeRound({
      players: makePlayers(["p1"]),
      scores: makeScores("p1", Array<number>(18).fill(4)), // 72 gross
    });
    const standings = computeStandings(
      ["p1"],
      { p1: "Null Handicap" },
      // Cast: the runtime value from the API can be null even though the map
      // type is Record<string, number>; this asserts the defensive `== null` guard.
      { p1: null } as unknown as Record<string, number>,
      [round]
    );
    const s = standings[0];
    expect(s.handicap).toBeNull(); // NOT 0
    expect(s.totalNet).toBeNull(); // unranked, not 72
    expect(s.roundNet).toEqual([null]);
  });

  it("allocates the handicap only for rounds the player actually scored (some-but-not-all)", () => {
    // p1 has handicap 10 and scores only in round 1 (90 gross); round 2 has no scores.
    // Net must be 90 - 10*1 = 80 (allocation counts ONLY the scored round), NOT
    // 90 - 10*2 (would over-allocate) and NOT null (they do have a scored round).
    const r1 = makeRound({
      id: "r1",
      players: makePlayers(["p1"]),
      scores: makeScores("p1", Array<number>(18).fill(5)), // 90 total
    });
    const r2 = makeRound({
      id: "r2",
      players: makePlayers(["p1"]),
      scores: [], // p1 did not play round 2
    });
    const standings = computeStandings(
      ["p1"],
      { p1: "Player One" },
      { p1: 10 },
      [r1, r2]
    );
    const s = standings[0];
    expect(s.handicap).toBe(10);
    expect(s.roundTotals).toEqual([90, null]);
    expect(s.roundNet).toEqual([80, null]); // 90 - 10 in R1; null in the unplayed R2
    expect(s.totalNet).toBe(80); // 90 - 10*1 — allocation over the single scored round
  });

  it("totalNet is null when the player has a handicap but no scores at all", () => {
    const round = makeRound({
      players: makePlayers(["p1"]),
      scores: [], // no scores recorded for p1
    });
    const standings = computeStandings(
      ["p1"],
      { p1: "No Scores" },
      { p1: 15 },
      [round]
    );
    expect(standings[0].totalNet).toBeNull();
    expect(standings[0].handicap).toBe(15); // handicap itself still resolves
    expect(standings[0].roundNet).toEqual([null]);
  });
});

describe("net re-rank order + tie-aware rank label", () => {
  it("sorts by totalNet ascending, with null (no-handicap) players sorted LAST", () => {
    const round = makeRound({
      players: makePlayers(["scratch", "highHcp", "noHcp"]),
      scores: [
        ...makeScores("scratch", Array<number>(18).fill(4)), // 72 gross, hcp 0 → net 72
        ...makeScores("highHcp", Array<number>(18).fill(5)), // 90 gross, hcp 18 → net 72
        ...makeScores("noHcp", Array<number>(18).fill(4)), // 72 gross, NO hcp → net null
      ],
    });
    const standings = computeStandings(
      ["scratch", "highHcp", "noHcp"],
      { scratch: "Scratch", highHcp: "High Hcp", noHcp: "No Hcp" },
      { scratch: 0, highHcp: 18 },
      [round]
    );
    const sorted = sortStandings(standings, "net");
    // scratch and highHcp tie at net 72; noHcp (null) sorts last regardless
    // of its gross score being tied with scratch.
    expect(sorted.map((s) => s.playerId)).toEqual([
      "scratch",
      "highHcp",
      "noHcp",
    ]);
    expect(sorted[2].totalNet).toBeNull();
  });

  it("labels tied net totals with a T-prefix and the unranked player with —", () => {
    const round = makeRound({
      players: makePlayers(["a", "b", "c"]),
      scores: [
        ...makeScores("a", Array<number>(18).fill(4)), // 72, hcp 0 → net 72
        ...makeScores("b", Array<number>(18).fill(5)), // 90, hcp 18 → net 72 (tied with a)
        ...makeScores("c", Array<number>(18).fill(4)), // 72, no hcp → null
      ],
    });
    const standings = computeStandings(
      ["a", "b", "c"],
      { a: "A", b: "B", c: "C" },
      { a: 0, b: 18 },
      [round]
    );
    const sorted = sortStandings(standings, "net");
    expect(tieRankLabel(sorted, 0, "net")).toBe("T1");
    expect(tieRankLabel(sorted, 1, "net")).toBe("T1");
    expect(tieRankLabel(sorted, 2, "net")).toBe("—");
  });

  it("gives a plain rank (no T-prefix) when net totals are unique", () => {
    const round = makeRound({
      players: makePlayers(["a", "b"]),
      scores: [
        ...makeScores("a", Array<number>(18).fill(4)), // 72, hcp 0 → net 72
        ...makeScores("b", Array<number>(18).fill(5)), // 90, hcp 10 → net 80
      ],
    });
    const standings = computeStandings(
      ["a", "b"],
      { a: "A", b: "B" },
      { a: 0, b: 10 },
      [round]
    );
    const sorted = sortStandings(standings, "net");
    expect(sorted.map((s) => s.playerId)).toEqual(["a", "b"]);
    expect(tieRankLabel(sorted, 0, "net")).toBe("1");
    expect(tieRankLabel(sorted, 1, "net")).toBe("2");
  });
});

describe("gross / toPar standings are unaffected by playerHandicaps", () => {
  it("produces identical gross/toPar totals and order whether or not handicaps are supplied", () => {
    const round = makeRound({
      players: makePlayers(["a", "b", "c"]),
      scores: [
        ...makeScores("a", Array<number>(18).fill(4)), // 72
        ...makeScores("b", Array<number>(18).fill(5)), // 90
        ...makeScores("c", Array<number>(18).fill(3)), // 54
      ],
    });

    const withHandicaps = computeStandings(
      ["a", "b", "c"],
      { a: "A", b: "B", c: "C" },
      { a: 5, b: 20, c: 0 },
      [round]
    );
    const withoutHandicaps = computeStandings(
      ["a", "b", "c"],
      { a: "A", b: "B", c: "C" },
      {},
      [round]
    );

    for (const mode of ["gross", "toPar"] as const) {
      const sortedWith = sortStandings(withHandicaps, mode);
      const sortedWithout = sortStandings(withoutHandicaps, mode);
      expect(sortedWith.map((s) => s.playerId)).toEqual(
        sortedWithout.map((s) => s.playerId)
      );
      expect(sortedWith.map((s) => s.totalStrokes)).toEqual(
        sortedWithout.map((s) => s.totalStrokes)
      );
      expect(sortedWith.map((s) => s.totalToPar)).toEqual(
        sortedWithout.map((s) => s.totalToPar)
      );
      for (let i = 0; i < sortedWith.length; i++) {
        expect(tieRankLabel(sortedWith, i, mode)).toBe(
          tieRankLabel(sortedWithout, i, mode)
        );
      }
    }

    // Gross/toPar values themselves never read handicap.
    expect(withHandicaps.find((s) => s.playerId === "a")!.totalStrokes).toBe(72);
    expect(withoutHandicaps.find((s) => s.playerId === "a")!.totalStrokes).toBe(72);
  });
});

describe("per-round COURSE plan — standings are course-blind", () => {
  // tournament-per-round-format-course-plan.md §8: computeStandings consumes
  // only r.scores + r.holes + handicap — no course identity anywhere. Two
  // member rounds with different courseId/courseName but identical
  // holes/scores must produce identical standings to the same-course case.
  it("two rounds with different courses but identical holes/scores produce identical standings", () => {
    const r1 = makeRound({
      id: "r1",
      courseId: "c1",
      courseName: "Same Course",
      players: makePlayers(["p1", "p2"]),
      scores: [
        ...makeScores("p1", Array<number>(18).fill(4)), // 72
        ...makeScores("p2", Array<number>(18).fill(5)), // 90
      ],
    });
    const r2 = makeRound({
      id: "r2",
      courseId: "c1",
      courseName: "Same Course",
      players: makePlayers(["p1", "p2"]),
      scores: [
        ...makeScores("p1", Array<number>(18).fill(5)), // 90
        ...makeScores("p2", Array<number>(18).fill(4)), // 72
      ],
    });
    const sameCourseStandings = computeStandings(
      ["p1", "p2"],
      { p1: "P1", p2: "P2" },
      { p1: 10, p2: 5 },
      [r1, r2]
    );

    const r1DifferentCourse = { ...r1, courseId: "black", courseName: "Bethpage Black" };
    const r2DifferentCourse = { ...r2, courseId: "red", courseName: "Bethpage Red" };
    const differentCourseStandings = computeStandings(
      ["p1", "p2"],
      { p1: "P1", p2: "P2" },
      { p1: 10, p2: 5 },
      [r1DifferentCourse, r2DifferentCourse]
    );

    expect(differentCourseStandings).toEqual(sameCourseStandings);
  });
});
