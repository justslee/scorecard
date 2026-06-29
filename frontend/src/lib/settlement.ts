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
 * Supported formats: skins, wolf, nassau (individual scope), matchPlay, threePoint.
 * Formats without a clear monetary result (bestBall, stableford, etc.) are skipped;
 * they can be added later without changing the API surface.
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
