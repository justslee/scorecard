/**
 * Settlement computation for side-money games.
 *
 * Pure, deterministic, no side-effects — safe to unit-test in Node.
 *
 * Flow:
 *   1. `computeGameNetWinnings`  → per-player net for ONE game (zero-sum).
 *   2. `computeNetSettlement`    → sums across ALL money games in a round.
 *   3. `minimizeTransfers`       → greedy O(n log n) debt minimization (≤ n−1 transfers).
 *
 * Supported formats: skins, wolf, nassau (individual scope), matchPlay, threePoint,
 * vegas, hammer, rabbit, defender.
 * Formats without a clear monetary result (bestBall, scramble, stableford, chicago,
 * bingoBangoBongo, trash) are skipped; they can be added later without changing the
 * API surface.
 *
 * Zero-sum invariant: for any game with money, sum(netByPlayer.values) == 0
 * (to within floating-point rounding, which we cap at 2 decimal places).
 */

import { Round, Game } from './types';
import { computeGameResults } from './games';

// ─── Public types ──────────────────────────────────────────────────────────────

/** A single minimized transfer that settles debt between two players. */
export interface SettlementTransfer {
  fromPlayerId: string;
  toPlayerId: string;
  /** Always positive; direction encoded in from/to. */
  amount: number;
}

/** Round-level settlement ledger (before finalization). */
export interface SettlementLedger {
  /** Per-player net: positive = this player wins money, negative = owes money. */
  netByPlayer: Record<string, number>;
  /** Minimized set of transfers that settles all debts. */
  transfers: SettlementTransfer[];
  /** True when the round has no money games (nothing to settle). */
  isEmpty: boolean;
}

/** Settlement after the owner clicks "Finalize" — same ledger + a timestamp. */
export interface FinalizedSettlement {
  transfers: SettlementTransfer[];
  finalizedAt: string; // ISO datetime string
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Round a dollar value to 2 decimal places. Normalizes -0 → 0. */
function r2(n: number): number {
  const result = Math.round(n * 100) / 100;
  // Object.is(-0, 0) is false; normalize so callers always receive plain 0.
  return result === 0 ? 0 : result;
}

// ─── Per-game net winnings ────────────────────────────────────────────────────

/**
 * Return the net dollar amount each player wins (+) or owes (−) for a single game.
 * Returns {} when the game has no pointValue (no money at stake).
 * Zero-sum invariant: sum of all values ≈ 0.
 */
export function computeGameNetWinnings(round: Round, game: Game): Record<string, number> {
  const pointValue = game.settings?.pointValue ?? 0;
  if (pointValue <= 0) return {};

  const results = computeGameResults(round, game);

  // Player IDs in this game (fall back to full round roster)
  const playerIds =
    game.playerIds.length > 0 ? game.playerIds : round.players.map((p) => p.id);

  // Initialise all participants at 0
  const net: Record<string, number> = {};
  for (const pid of playerIds) net[pid] = 0;

  // ─── Skins ──────────────────────────────────────────────────────────────
  // Total pot = total_awarded_skins × pointValue.
  // Each player's exact net = (skins_won × pointValue) − (totalPot / N).
  //
  // With 3 players and an odd pot, division produces non-terminating decimals.
  // We compute N−1 nets rounded to 2dp, then set the last as −sum(others)
  // so the zero-sum invariant holds exactly at 2dp regardless of N.
  if (game.format === 'skins' && results.skins) {
    const totalAwarded = results.skins.byPlayer.reduce((s, p) => s + p.skins, 0);
    const totalPot = r2(totalAwarded * pointValue);
    const exactCost = totalPot / playerIds.length;

    const byPlayer = results.skins.byPlayer;
    let runningSum = 0;

    for (let i = 0; i < byPlayer.length - 1; i++) {
      const p = byPlayer[i];
      const n = r2(p.skins * pointValue - exactCost);
      net[p.playerId] = n;
      runningSum = r2(runningSum + n);
    }
    // Last player absorbs any rounding residual so sum == 0.
    if (byPlayer.length > 0) {
      const last = byPlayer[byPlayer.length - 1];
      net[last.playerId] = r2(-runningSum);
    }
  }

  // ─── Wolf ───────────────────────────────────────────────────────────────
  // Wolf totals are already zero-sum in points (direct point transfers).
  if (game.format === 'wolf' && results.wolf) {
    for (const pid of playerIds) {
      net[pid] = r2((results.wolf.totals[pid] ?? 0) * pointValue);
    }
  }

  // ─── Nassau (individual scope) ───────────────────────────────────────────
  // 3 bets: F9, B9, Overall — each worth pointValue.
  // Segment winner collects pointValue from every other player;
  // each non-winner pays pointValue / (N−1) to the winner.
  // Tied segments: no money moves.
  if (game.format === 'nassau' && results.nassau && results.nassau.scope === 'individual') {
    const segments = [
      results.nassau.front9WinnerId,
      results.nassau.back9WinnerId,
      results.nassau.overallWinnerId,
    ];
    const n = playerIds.length;

    for (const winnerId of segments) {
      if (!winnerId) continue; // tied — no transfer
      for (const pid of playerIds) {
        if (pid === winnerId) {
          // Winner collects from all others
          net[pid] = r2((net[pid] ?? 0) + r2(pointValue * (n - 1)));
        } else {
          // Non-winner pays their share
          net[pid] = r2((net[pid] ?? 0) - pointValue);
        }
      }
    }
  }

  // ─── Match Play ─────────────────────────────────────────────────────────
  // Winner gets +pointValue; loser pays −pointValue; all-square = no transfer.
  if (game.format === 'matchPlay' && results.matchPlay) {
    const { winnerPlayerId, player1Id, player2Id } = results.matchPlay;
    if (winnerPlayerId) {
      const loserId = winnerPlayerId === player1Id ? player2Id : player1Id;
      net[winnerPlayerId] = r2((net[winnerPlayerId] ?? 0) + pointValue);
      net[loserId] = r2((net[loserId] ?? 0) - pointValue);
    }
  }

  // ─── Three-Point (2v2) ───────────────────────────────────────────────────
  // Each point difference moves pointValue between teams.
  // Per-player share = team net / team size.
  if (game.format === 'threePoint' && results.threePoint) {
    const tp = results.threePoint;
    const teamA = tp.teamAId;
    const teamB = tp.teamBId;
    const ptA = tp.totals[teamA] ?? 0;
    const ptB = tp.totals[teamB] ?? 0;
    const teamANet = r2((ptA - ptB) * pointValue); // positive = teamA wins

    const teamAPlayers = game.teams?.find((t) => t.id === teamA)?.playerIds ?? [];
    const teamBPlayers = game.teams?.find((t) => t.id === teamB)?.playerIds ?? [];

    if (teamAPlayers.length > 0 && teamBPlayers.length > 0) {
      const shareA = r2(teamANet / teamAPlayers.length);
      const shareB = r2(-teamANet / teamBPlayers.length);
      for (const pid of teamAPlayers) net[pid] = r2((net[pid] ?? 0) + shareA);
      for (const pid of teamBPlayers) net[pid] = r2((net[pid] ?? 0) + shareB);
    }
  }

  // ─── Vegas ──────────────────────────────────────────────────────────────
  // Vegas totals are already dollarized (computeVegas multiplies diff × pointValue
  // internally). Totals are keyed by TEAM ID; distribute equally among each team's
  // players. Rounding residual absorbed by the last player per team, preserving
  // the zero-sum invariant across all players (teamA.total + teamB.total === 0).
  if (game.format === 'vegas' && results.vegas) {
    const { teamAId, teamBId, totals: vegasTotals } = results.vegas;

    const distributeTeam = (teamId: string, members: string[]) => {
      if (members.length === 0) return;
      const teamNet = vegasTotals[teamId] ?? 0;
      const n = members.length;
      let runningSum = 0;
      for (let i = 0; i < n - 1; i++) {
        const share = r2(teamNet / n);
        net[members[i]] = r2((net[members[i]] ?? 0) + share);
        runningSum = r2(runningSum + share);
      }
      // Last member absorbs rounding residual so the team total is exact.
      const last = members[n - 1];
      net[last] = r2((net[last] ?? 0) + r2(teamNet - runningSum));
    };

    const teamAMembers = game.teams?.find((t) => t.id === teamAId)?.playerIds ?? [];
    const teamBMembers = game.teams?.find((t) => t.id === teamBId)?.playerIds ?? [];
    distributeTeam(teamAId, teamAMembers);
    distributeTeam(teamBId, teamBMembers);
  }

  // ─── Hammer ─────────────────────────────────────────────────────────────
  // Hammer totals are already dollarized (computeHammer applies multiplier ×
  // pointValue per exchange). The per-player totals are zero-sum by construction.
  if (game.format === 'hammer' && results.hammer) {
    for (const pid of playerIds) {
      net[pid] = r2((net[pid] ?? 0) + r2(results.hammer.totals[pid] ?? 0));
    }
  }

  // ─── Rabbit ─────────────────────────────────────────────────────────────
  // Two segment prizes (front-9 and back-9). The holder of each segment wins
  // pointValue from each of the other N-1 players (same pattern as nassau
  // individual scope). If no one holds the rabbit at end of the segment, no
  // money moves for that segment.
  if (game.format === 'rabbit' && results.rabbit) {
    const n = playerIds.length;
    for (const holderId of [results.rabbit.front9HolderId, results.rabbit.back9HolderId]) {
      if (!holderId) continue; // no holder — segment prize unpaid
      for (const pid of playerIds) {
        if (pid === holderId) {
          net[pid] = r2((net[pid] ?? 0) + r2(pointValue * (n - 1)));
        } else {
          net[pid] = r2((net[pid] ?? 0) - pointValue);
        }
      }
    }
  }

  // ─── Defender ───────────────────────────────────────────────────────────
  // Defender totals are already dollarized (computeDefender applies pointValue
  // × challengers per hole). The per-player totals are zero-sum by construction.
  if (game.format === 'defender' && results.defender) {
    for (const pid of playerIds) {
      net[pid] = r2((net[pid] ?? 0) + r2(results.defender.totals[pid] ?? 0));
    }
  }

  return net;
}

// ─── Transfer minimization ────────────────────────────────────────────────────

/**
 * Greedy debt minimization.
 *
 * Complexity: O(n log n). Produces at most n−1 transfers (optimal minimum).
 * Precondition: sum of all values ≈ 0 (zero-sum game assumption).
 *
 * Exported so it can be tested independently.
 */
export function minimizeTransfers(netByPlayer: Record<string, number>): SettlementTransfer[] {
  // Round & filter out dust (< 1 cent)
  const entries = Object.entries(netByPlayer)
    .map(([pid, amount]) => ({ pid, amount: r2(amount) }))
    .filter((e) => Math.abs(e.amount) >= 0.01);

  if (entries.length === 0) return [];

  // Sort ascending: biggest debtors at front, biggest creditors at back
  const sorted = [...entries].sort((a, b) => a.amount - b.amount);
  const transfers: SettlementTransfer[] = [];

  let lo = 0;
  let hi = sorted.length - 1;

  while (lo < hi) {
    const debtor = sorted[lo];
    const creditor = sorted[hi];

    if (debtor.amount >= 0 || creditor.amount <= 0) break;

    const transferAmt = r2(Math.min(-debtor.amount, creditor.amount));
    if (transferAmt >= 0.01) {
      transfers.push({
        fromPlayerId: debtor.pid,
        toPlayerId: creditor.pid,
        amount: transferAmt,
      });
    }

    sorted[lo] = { ...debtor, amount: r2(debtor.amount + transferAmt) };
    sorted[hi] = { ...creditor, amount: r2(creditor.amount - transferAmt) };

    if (Math.abs(sorted[lo].amount) < 0.005) lo++;
    if (Math.abs(sorted[hi].amount) < 0.005) hi--;
  }

  return transfers;
}

// ─── Round-level net settlement ───────────────────────────────────────────────

/**
 * Compute the round-level NET settlement across ALL money games, then minimize transfers.
 *
 * Skips games with format "settlement" (the persisted ledger game record).
 * Returns isEmpty=true when there are no money games (caller can hide the UI).
 */
export function computeNetSettlement(round: Round): SettlementLedger {
  const moneyGames = (round.games ?? []).filter(
    (g) => g.format !== 'settlement' && (g.settings?.pointValue ?? 0) > 0
  );

  if (moneyGames.length === 0) {
    return { netByPlayer: {}, transfers: [], isEmpty: true };
  }

  // Aggregate net across all games
  const netByPlayer: Record<string, number> = {};
  for (const game of moneyGames) {
    const gameNet = computeGameNetWinnings(round, game);
    for (const [pid, amount] of Object.entries(gameNet)) {
      netByPlayer[pid] = r2((netByPlayer[pid] ?? 0) + amount);
    }
  }

  const transfers = minimizeTransfers(netByPlayer);

  return {
    netByPlayer,
    transfers,
    isEmpty: Object.keys(netByPlayer).length === 0,
  };
}

// ─── Tournament-level cumulative settlement ───────────────────────────────────

/**
 * Compute the CUMULATIVE settlement across every round of a tournament.
 *
 * Reuses `computeNetSettlement` per round (all per-format math lives there —
 * this function duplicates none of it), then sums each round's `netByPlayer`
 * into one running total and minimizes transfers ONCE over the cumulative net.
 *
 * This ordering matters: sum-then-minimize (correct) vs. minimize-per-round-
 * then-concat (wrong) — the latter can produce MORE transfers than necessary,
 * e.g. round 1 has A owe B $10 and round 2 has B owe A $10: per-round
 * minimization emits two transfers (A→B $10, B→A $10) while the cumulative
 * net is zero and should emit none.
 *
 * Returns isEmpty=true when no round produced a money net (every round was
 * either game-less or unscored) so the caller can render an honest empty
 * state instead of a fabricated $0 settlement.
 */
export function computeTournamentSettlement(rounds: Round[]): SettlementLedger {
  const netByPlayer: Record<string, number> = {};

  for (const round of rounds) {
    const roundLedger = computeNetSettlement(round);
    for (const [pid, amount] of Object.entries(roundLedger.netByPlayer)) {
      netByPlayer[pid] = r2((netByPlayer[pid] ?? 0) + amount);
    }
  }

  const transfers = minimizeTransfers(netByPlayer);

  // Empty when no player has a non-dust cumulative net (covers game-less
  // rounds and rounds whose net-per-player collapsed to ~0, e.g. unscored).
  const isEmpty = Object.values(netByPlayer).every((v) => Math.abs(v) < 0.01);

  return { netByPlayer, transfers, isEmpty };
}

/**
 * True when any round has at least one money game (a game with pointValue > 0).
 *
 * Mirrors the exact filter `computeNetSettlement` uses (format !== 'settlement'
 * && pointValue > 0) so the two can never diverge. Used by callers that need to
 * distinguish "no money games at all" (never a settlement) from "money games
 * exist but nothing is scored yet" (settlement pending).
 */
export function hasMoneyGames(rounds: Round[]): boolean {
  return rounds.some((round) =>
    (round.games ?? []).some(
      (g) => g.format !== 'settlement' && (g.settings?.pointValue ?? 0) > 0
    )
  );
}

/**
 * Pull the persisted FinalizedSettlement out of a round's games array.
 * Returns null when the round has not been settled yet.
 */
export function getPersistedSettlement(round: Round): FinalizedSettlement | null {
  const settlementGame = (round.games ?? []).find((g) => g.format === 'settlement');
  if (!settlementGame?.settings) return null;

  const s = settlementGame.settings as Record<string, unknown>;
  if (!s.finalizedAt || !Array.isArray(s.transfers)) return null;

  return {
    transfers: s.transfers as SettlementTransfer[],
    finalizedAt: s.finalizedAt as string,
  };
}
