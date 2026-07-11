/**
 * Unit tests for `buildRoundGames` (lib/round-games.ts) — money-adjacent, so
 * the full Game[] object shape is asserted, not just spot fields.
 */

import { describe, it, expect } from "vitest";
import { buildRoundGames, GAME_OPTIONS, TOURNAMENT_GAME_IDS, TOURNAMENT_GAME_OPTIONS } from "./round-games";
import type { GameId } from "./round-games";

function makeIdGen() {
  let i = 0;
  return () => `g${i++}`;
}

describe("buildRoundGames", () => {
  it("maps every mapped GameId to its GameFormat", () => {
    const cases: [GameId, string][] = [
      ["match", "matchPlay"],
      ["skins", "skins"],
      ["nassau", "nassau"],
      ["stable", "stableford"],
      ["wolf", "wolf"],
      ["vegas", "vegas"],
      ["bbb", "bingoBangoBongo"],
      ["bb", "bestBall"],
      ["scr", "scramble"],
    ];
    for (const [id, format] of cases) {
      const games = buildRoundGames([{ id, stake: "$5" }], ["p1"], makeIdGen());
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

  it("parses stakes per the exact rule", () => {
    const newId = makeIdGen();
    const games = buildRoundGames(
      [
        { id: "skins", stake: "$5" },
        { id: "match", stake: "5" },
        { id: "nassau", stake: "$0" },
        { id: "stable", stake: "" },
        { id: "vegas", stake: "$12.50" },
      ],
      ["p1"],
      newId
    );
    expect(games.map((g) => g.settings.pointValue)).toEqual([5, 5, undefined, undefined, 12.5]);
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
});

describe("TOURNAMENT_GAME_OPTIONS", () => {
  it("offers exactly none, skins, match, nassau, stable — in that order", () => {
    expect(TOURNAMENT_GAME_IDS).toEqual(["none", "skins", "match", "nassau", "stable"]);
    expect(TOURNAMENT_GAME_OPTIONS.map((g) => g.id)).toEqual(TOURNAMENT_GAME_IDS);
  });
});
