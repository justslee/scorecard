/**
 * Unit tests for `buildRoundGames` (lib/round-games.ts) — money-adjacent, so
 * the full Game[] object shape is asserted, not just spot fields.
 */

import { describe, it, expect } from "vitest";
import {
  buildRoundGames,
  GAME_OPTIONS,
  GAME_ID_TO_FORMAT,
  TOURNAMENT_GAME_IDS,
  TOURNAMENT_GAME_OPTIONS,
  STAKE_GAME_IDS,
  ROSTER_REQUIREMENT,
  gameSelectableForRoster,
} from "./round-games";
import type { GameId } from "./round-games";
import { SETTLEABLE_FORMATS } from "./settlement";

function makeIdGen() {
  let i = 0;
  return () => `g${i++}`;
}

describe("buildRoundGames", () => {
  it("maps every mapped GameId to its GameFormat (with a roster that satisfies any roster requirement)", () => {
    // match needs exactly 2 players, wolf needs exactly 4 — everything else
    // is roster-agnostic, so a single-player roster is enough to prove the
    // format mapping (ROSTER_REQUIREMENT, tournament-settlement-honesty-plan.md §3).
    const cases: [GameId, string, string[]][] = [
      ["match", "matchPlay", ["p1", "p2"]],
      ["skins", "skins", ["p1"]],
      ["nassau", "nassau", ["p1"]],
      ["stable", "stableford", ["p1"]],
      ["wolf", "wolf", ["p1", "p2", "p3", "p4"]],
      ["vegas", "vegas", ["p1"]],
      ["bbb", "bingoBangoBongo", ["p1"]],
      ["bb", "bestBall", ["p1"]],
      ["scr", "scramble", ["p1"]],
    ];
    for (const [id, format, roster] of cases) {
      const games = buildRoundGames([{ id, stake: "$5" }], roster, makeIdGen());
      expect(games).toHaveLength(1);
      expect(games[0].format).toBe(format);
    }
  });

  it("produces nothing for stroke, none, and quota", () => {
    const games = buildRoundGames(
      [
        { id: "stroke", stake: "$5" },
        { id: "none", stake: "$5" },
        { id: "quota", stake: "$5" },
      ],
      ["p1"],
      makeIdGen()
    );
    expect(games).toEqual([]);
  });

  it("parses stakes per the exact rule for stake-taking ids", () => {
    const newId = makeIdGen();
    const games = buildRoundGames(
      [
        { id: "skins", stake: "$5" },
        { id: "match", stake: "5" },
        { id: "nassau", stake: "$0" },
      ],
      ["p1", "p2"], // satisfies match's exact-2 requirement
      newId
    );
    expect(games.map((g) => g.settings.pointValue)).toEqual([5, 5, undefined]);
  });

  it("ignores the stake string entirely for non-stake ids — stableford settles $0 no matter what's typed in the box", () => {
    const games = buildRoundGames(
      [
        { id: "stable", stake: "$5" },
        { id: "vegas", stake: "$12.50" },
      ],
      ["p1"],
      makeIdGen()
    );
    expect(games.map((g) => g.settings.pointValue)).toEqual([undefined, undefined]);
  });

  it("passes playerIds through verbatim", () => {
    const playerIds = ["p1", "p2", "p3"];
    const games = buildRoundGames([{ id: "skins", stake: "$5" }], playerIds, makeIdGen());
    expect(games[0].playerIds).toBe(playerIds);
    expect(games[0].playerIds).toEqual(["p1", "p2", "p3"]);
  });

  it("sets roundId to the empty-string placeholder", () => {
    const games = buildRoundGames([{ id: "skins", stake: "$5" }], ["p1"], makeIdGen());
    expect(games[0].roundId).toBe("");
  });

  it("uses the GAME_OPTIONS label for name", () => {
    const games = buildRoundGames([{ id: "nassau", stake: "$20" }], ["p1"], makeIdGen());
    expect(games[0].name).toBe(GAME_OPTIONS.find((g) => g.id === "nassau")!.l);
    expect(games[0].name).toBe("Nassau");
  });

  it("preserves selection order across multiple games and uses the injected id generator", () => {
    const games = buildRoundGames(
      [
        { id: "skins", stake: "$5" },
        { id: "nassau", stake: "$20" },
      ],
      ["p1", "p2"],
      makeIdGen()
    );
    expect(games).toHaveLength(2);
    expect(games[0]).toEqual({
      id: "g0",
      roundId: "",
      format: "skins",
      name: "Skins",
      playerIds: ["p1", "p2"],
      settings: { pointValue: 5 },
    });
    expect(games[1]).toEqual({
      id: "g1",
      roundId: "",
      format: "nassau",
      name: "Nassau",
      playerIds: ["p1", "p2"],
      settings: { pointValue: 20 },
    });
  });

  it("defaults to a wrapper arrow around crypto.randomUUID (never unbound)", () => {
    const games = buildRoundGames([{ id: "skins", stake: "$5" }], ["p1"]);
    expect(games[0].id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  // ── Money-honesty guards (tournament-settlement-honesty-plan.md §5) ──────

  it("never returns a matchPlay game with playerIds.length !== 2 — skips, never truncates", () => {
    for (const rosterSize of [1, 3, 4]) {
      const roster = Array.from({ length: rosterSize }, (_, i) => `p${i + 1}`);
      const games = buildRoundGames([{ id: "match", stake: "$5" }], roster, makeIdGen());
      expect(games.find((g) => g.format === "matchPlay")).toBeUndefined();
    }
    const emitted = buildRoundGames([{ id: "match", stake: "$5" }], ["p1", "p2"], makeIdGen());
    expect(emitted).toHaveLength(1);
    expect(emitted[0].format).toBe("matchPlay");
    expect(emitted[0].playerIds).toEqual(["p1", "p2"]);
  });

  it("never returns a wolf game with a roster !== 4 — skips, never truncates", () => {
    for (const rosterSize of [1, 2, 3, 5]) {
      const roster = Array.from({ length: rosterSize }, (_, i) => `p${i + 1}`);
      const games = buildRoundGames([{ id: "wolf", stake: "$5" }], roster, makeIdGen());
      expect(games.find((g) => g.format === "wolf")).toBeUndefined();
    }
    const emitted = buildRoundGames(
      [{ id: "wolf", stake: "$5" }],
      ["p1", "p2", "p3", "p4"],
      makeIdGen()
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0].format).toBe("wolf");
  });

  it("emits pointValue === undefined for every non-stake id even when a $5 stake is selected — stableford settles $0, consistently", () => {
    const nonStakeIds: GameId[] = ["stable", "bbb", "bb", "scr", "vegas", "stroke", "quota", "none"];
    for (const id of nonStakeIds) {
      const games = buildRoundGames(
        [{ id, stake: "$5" }],
        ["p1", "p2", "p3", "p4"],
        makeIdGen()
      );
      for (const g of games) {
        expect(g.settings.pointValue).toBeUndefined();
      }
    }
  });
});

describe("STAKE_GAME_IDS", () => {
  it("equals exactly {skins, match, nassau, wolf}", () => {
    expect(new Set(STAKE_GAME_IDS)).toEqual(new Set(["skins", "match", "nassau", "wolf"]));
  });

  it("every member's mapped GameFormat is in SETTLEABLE_FORMATS — the two sets can never drift silently", () => {
    for (const id of STAKE_GAME_IDS) {
      const format = GAME_ID_TO_FORMAT[id];
      expect(format).toBeDefined();
      expect(SETTLEABLE_FORMATS.has(format!)).toBe(true);
    }
  });
});

describe("ROSTER_REQUIREMENT / gameSelectableForRoster", () => {
  it("requires exactly 2 for match and exactly 4 for wolf; everything else is roster-agnostic", () => {
    expect(ROSTER_REQUIREMENT).toEqual({ match: 2, wolf: 4 });
    expect(gameSelectableForRoster("match", 1)).toBe(false);
    expect(gameSelectableForRoster("match", 2)).toBe(true);
    expect(gameSelectableForRoster("match", 3)).toBe(false);
    expect(gameSelectableForRoster("wolf", 3)).toBe(false);
    expect(gameSelectableForRoster("wolf", 4)).toBe(true);
    expect(gameSelectableForRoster("wolf", 5)).toBe(false);
    expect(gameSelectableForRoster("skins", 1)).toBe(true);
    expect(gameSelectableForRoster("nassau", 8)).toBe(true);
  });
});

describe("TOURNAMENT_GAME_OPTIONS", () => {
  it("offers exactly none, skins, match, nassau, stable — in that order", () => {
    expect(TOURNAMENT_GAME_IDS).toEqual(["none", "skins", "match", "nassau", "stable"]);
    expect(TOURNAMENT_GAME_OPTIONS.map((g) => g.id)).toEqual(TOURNAMENT_GAME_IDS);
  });
});
