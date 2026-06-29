// Pure helper: derive the rounds shared with a given saved player.
//
// When a player is added to a round from the saved roster, the round's
// Player.id is set to SavedPlayer.id (see round/new/page.tsx ~line 187+250:
// saved players keep their id; only custom slots get random UUIDs). So
// "shared rounds" = rounds where some player has an id that matches the
// SavedPlayer.id.
//
// Custom (non-saved) participants get random UUIDs on round creation and will
// never match any SavedPlayer.id — correctly excluded by this derivation.

import type { Round } from "./types";

/**
 * Return the subset of `rounds` in which the saved player with `playerId`
 * participated, sorted most-recent first by date.
 *
 * Pure: does not mutate the input array.
 */
export function getSharedRounds(rounds: Round[], playerId: string): Round[] {
  if (!playerId) return [];
  return rounds
    .filter((r) => r.players.some((p) => p.id === playerId))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}
