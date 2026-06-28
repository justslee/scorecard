import type { Round } from "@/lib/types";

/**
 * The id of the player in a round that represents the owner (the signed-in
 * user) — used for all owner-scoped stats (home scoring average, recent scores,
 * profile tee/season analytics).
 *
 * Prefers the explicit `round.ownerPlayerId` set at round creation. Falls back
 * to the first player for legacy rounds created before owner identity was
 * recorded (the historical `players[0]` assumption). Returns `undefined` when
 * the round has no players, so callers can skip cleanly.
 *
 * Use this everywhere instead of `round.players[0].id`: a round where the owner
 * is not first-listed would otherwise attribute another player's scores to the
 * owner (backlog owner-player-identity).
 */
export function getOwnerPlayerId(round: Round): string | undefined {
  return round.ownerPlayerId ?? round.players[0]?.id;
}
