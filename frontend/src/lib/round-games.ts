/**
 * Shared game-format picker data + builder — extracted from
 * `app/round/new/page.tsx` so the tournament round-creation flow can reuse
 * the exact same option list and Game[]-construction semantics.
 *
 * Pure module: no React, no side effects (besides the injectable id
 * generator, which defaults to crypto.randomUUID()).
 */

import type { Game, GameFormat } from "./types";
import { SETTLEABLE_FORMATS } from "./settlement";

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
  { id: "wolf", l: "Wolf", sub: "Rotating lone wolf. Partners or go alone.", tag: "Foursome" },
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
 * Formats that ARE settled by `settlement.ts` (`SETTLEABLE_FORMATS`) but that
 * the picker cannot construct a working stake for — vegas requires two
 * `teams` and no team-assignment UI exists anywhere (see plan §1/§2). Until
 * that UI ships, vegas stays picker-visible but never takes a stake.
 */
export const TEAM_ONLY_FORMATS: ReadonlySet<GameId> = new Set(["vegas"]);

/**
 * Ids whose format is BOTH settled by `settlement.ts` AND constructible by
 * this picker (no teams needed) — the only ids allowed to display/write a
 * stake ([[no-fake-data-fallbacks]]: a mirage stake elsewhere settles $0).
 * Derived, not hand-maintained, so it can never drift from SETTLEABLE_FORMATS.
 */
export const STAKE_GAME_IDS: ReadonlySet<GameId> = new Set(
  (Object.keys(GAME_ID_TO_FORMAT) as GameId[]).filter(
    (id) => SETTLEABLE_FORMATS.has(GAME_ID_TO_FORMAT[id]!) && !TEAM_ONLY_FORMATS.has(id)
  )
);

/**
 * Exact roster size a format needs to compute correctly (not a minimum — an
 * over- or under-sized roster silently drops players). Below/above this, the
 * engine silently drops players (matchPlay: games.ts:739-741 only ever reads
 * playerIds[0]/[1]; wolf: games.ts:806-809 cycles a 4-player order and falls
 * back to round.players.slice(0,4)) — a truncated game must be unrepresentable,
 * not just mislabeled. Match is also a `STAKE_GAME_IDS` member, so for match
 * this doubles as a money guard; wolf is no longer in `STAKE_GAME_IDS` (it
 * settles no money — see `SETTLEABLE_FORMATS` in settlement.ts), but the
 * requirement stays: a roster ≠ 4 still silently drops players from wolf's
 * points leaderboard, so this keeps that display honest too.
 */
export const ROSTER_REQUIREMENT: Partial<Record<GameId, number>> = {
  match: 2,
  wolf: 4,
};

/** True when `rosterSize` satisfies `id`'s exact roster requirement (no requirement = always true). */
export function gameSelectableForRoster(id: GameId, rosterSize: number): boolean {
  const required = ROSTER_REQUIREMENT[id];
  if (required === undefined) return true;
  return rosterSize === required;
}

/**
 * Build the Game[] payload for a round from the picker's selection state.
 * Identical semantics to the old inline block in `app/round/new/page.tsx`
 * (390-405) — do not drift.
 *
 * Money-honesty guards ([[no-fake-data-fallbacks]], tournament-settlement-
 * honesty-plan.md §3):
 *   - `settings.pointValue` is written ONLY for `STAKE_GAME_IDS` members — a
 *     format settlement.ts doesn't settle (e.g. stableford) never carries a
 *     stake, so it never displays one it won't honor.
 *   - A game whose format has a roster requirement (`ROSTER_REQUIREMENT`) that
 *     `playerIds` doesn't satisfy is SKIPPED entirely — never emitted, never
 *     silently truncated. A truncated match/wolf must be unrepresentable at
 *     this boundary regardless of upstream UI state.
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
    if (!gameSelectableForRoster(sel.id, playerIds.length)) continue; // unmet roster — skip, never truncate
    const stakeValue = STAKE_GAME_IDS.has(sel.id)
      ? parseFloat(sel.stake.replace("$", "")) || 0
      : 0;
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
