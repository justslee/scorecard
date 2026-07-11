/**
 * Shared game-format picker data + builder — extracted from
 * `app/round/new/page.tsx` so the tournament round-creation flow can reuse
 * the exact same option list and Game[]-construction semantics.
 *
 * Pure module: no React, no side effects (besides the injectable id
 * generator, which defaults to crypto.randomUUID()).
 */

import type { Game, GameFormat } from "./types";

export type GameId =
  | "stroke"
  | "match"
  | "skins"
  | "nassau"
  | "stable"
  | "wolf"
  | "vegas"
  | "bbb"
  | "bb"
  | "scr"
  | "quota"
  | "none";

export interface GameOption {
  id: GameId;
  l: string;
  sub: string;
  tag: string | null;
}

export const GAME_OPTIONS: GameOption[] = [
  { id: "stroke", l: "Stroke play", sub: "Classic. Lowest total wins.", tag: "Solo OK" },
  { id: "match", l: "Match play", sub: "Hole by hole. First to close it out wins.", tag: "1v1" },
  { id: "skins", l: "Skins", sub: "Low score on a hole takes the pot.", tag: "$ per hole" },
  { id: "nassau", l: "Nassau", sub: "Three bets: front 9, back 9, overall.", tag: "$20·20·20" },
  { id: "stable", l: "Stableford", sub: "Points per hole. Aggressive rewarded.", tag: "Net" },
  { id: "wolf", l: "Wolf", sub: "Rotating lone wolf. Partners or go alone.", tag: "3–4 ply" },
  { id: "vegas", l: "Vegas", sub: "Team scores combined into two-digit numbers.", tag: "Pairs" },
  { id: "bbb", l: "Bingo Bango Bongo", sub: "First on green, closest, first to hole.", tag: "Any size" },
  { id: "bb", l: "Best ball", sub: "Two-player team, best net score wins.", tag: "Teams" },
  { id: "scr", l: "Scramble", sub: "Everyone tees off, team plays best ball.", tag: "Teams" },
  { id: "quota", l: "Quota", sub: "Beat your handicap points total.", tag: "Solo OK" },
  { id: "none", l: "No stakes", sub: "Just a round.", tag: null },
];

/** Maps the local GameId to the canonical GameFormat type on the backend. */
export const GAME_ID_TO_FORMAT: Partial<Record<GameId, GameFormat>> = {
  match: "matchPlay",
  skins: "skins",
  nassau: "nassau",
  stable: "stableford",
  wolf: "wolf",
  vegas: "vegas",
  bbb: "bingoBangoBongo",
  bb: "bestBall",
  scr: "scramble",
};

/** Formats offered in the TOURNAMENT round picker (see plan §5 for why). */
export const TOURNAMENT_GAME_IDS: GameId[] = ["none", "skins", "match", "nassau", "stable"];
export const TOURNAMENT_GAME_OPTIONS: GameOption[] = TOURNAMENT_GAME_IDS.map(
  (id) => GAME_OPTIONS.find((g) => g.id === id)!
);

/**
 * Build the Game[] payload for a round from the picker's selection state.
 * Identical semantics to the old inline block in `app/round/new/page.tsx`
 * (390-405) — do not drift.
 */
export function buildRoundGames(
  selected: { id: GameId; stake: string }[],
  playerIds: string[],
  newId: () => string = () => crypto.randomUUID()
): Game[] {
  const gameObjects: Game[] = [];
  for (const sel of selected) {
    const format = GAME_ID_TO_FORMAT[sel.id];
    if (!format) continue; // "none" / "stroke" / "quota" have no engine format
    const stakeValue = parseFloat(sel.stake.replace("$", "")) || 0;
    gameObjects.push({
      id: newId(),
      roundId: "", // placeholder — backend assigns its own roundId FK
      format,
      name: GAME_OPTIONS.find((g) => g.id === sel.id)?.l ?? sel.id,
      playerIds,
      settings: { pointValue: stakeValue > 0 ? stakeValue : undefined },
    });
  }
  return gameObjects;
}
