/**
 * Pure helper — history-relative insights for the round-completion recap.
 *
 * Compares the just-finished round to the player's past completed rounds.
 * Owner-scoped via getOwnerPlayerId() — same convention as profile-stats.ts.
 * All functions are pure: no React, no API calls, no side effects.
 *
 * Three output states:
 *   'first-round'   — owner has no prior valid completed rounds.
 *   'thin-history'  — 1 valid prior round; vsAverageToPar is available but
 *                     ranking and parTypeComparison are withheld to avoid
 *                     fabricating comparisons from a single data point.
 *   'ready'         — ≥2 valid prior rounds; full insight set available.
 */

import { calculateTotals } from "./types";
import { getOwnerPlayerId } from "./round-owner";
import { deriveParTypeAverages } from "./profile-stats";
import type { Round } from "./types";
import type { ParTypeRow } from "./profile-stats";

// ── Constants ──────────────────────────────────────────────────────────────

/** Minimum valid history rounds required to reach the 'ready' state. */
const MIN_HISTORY_ROUNDS = 2;

/**
 * Minimum holes the owner must have played in a round for it to be treated
 * as a valid scorecard (matches the threshold used in deriveTrend).
 */
const MIN_PLAYED_HOLES = 9;

// ── Types ──────────────────────────────────────────────────────────────────

export type RoundInsightsState = "first-round" | "thin-history" | "ready";

/** Per-par-type comparison between this round and history. */
export type ParTypeInsight = {
  par: 3 | 4 | 5;
  /** Owner's avg strokes-to-par on this par type in the current round */
  thisRoundAvgToPar: number;
  /** Owner's historical avg strokes-to-par on this par type */
  historicalAvgToPar: number;
  /**
   * thisRoundAvgToPar − historicalAvgToPar.
   * Negative = performed better than usual on this par type.
   */
  delta: number;
};

export type RoundInsightsResult = {
  state: RoundInsightsState;
  /**
   * This round's total to-par vs historical average.
   * Present when there is ≥1 valid history round (thin-history and ready).
   * Absent for first-round state.
   */
  vsAverageToPar?: {
    /** Owner's to-par for this round (integer). */
    thisRound: number;
    /** Owner's historical average to-par (rounded to 1 dp). */
    historicalAvg: number;
    /**
     * thisRound − historicalAvg, rounded to 1 dp.
     * Negative = better than usual.
     */
    delta: number;
    /** Number of valid history rounds used for the average. */
    sampleSize: number;
  };
  /**
   * Per-par-type comparison. Only present when state === 'ready'.
   * Only includes par types that have data in both this round and history.
   * Absent when state is first-round or thin-history.
   */
  parTypeComparison?: ParTypeInsight[];
  /**
   * Where this round ranks among all valid rounds (history + current).
   * rank 1 = best (lowest to-par). Only present when state === 'ready'.
   */
  ranking?: {
    /** 1-indexed rank (1 = best). */
    rank: number;
    /** Total rounds compared (history count + 1 for current round). */
    total: number;
  };
};

// ── Main export ────────────────────────────────────────────────────────────

/**
 * Compute history-relative insights for the given round.
 *
 * @param round   The just-finished round (may be 'active' or 'completed').
 * @param history All of the owner's known rounds (any status, any count).
 *                The current round may be included — it is filtered out
 *                internally so callers don't have to pre-exclude it.
 */
export function computeRoundInsights(
  round: Round,
  history: Round[]
): RoundInsightsResult {
  // ── Owner identity ───────────────────────────────────────────────────────
  const ownerId = getOwnerPlayerId(round);
  if (!ownerId) return { state: "first-round" };

  // ── Current round's to-par ───────────────────────────────────────────────
  const currentTotals = calculateTotals(round.scores, round.holes, ownerId);
  if (currentTotals.playedHoles < MIN_PLAYED_HOLES) {
    // Partial round — not enough data to compare.
    return { state: "first-round" };
  }
  const thisRoundToPar = currentTotals.toPar;

  // ── Valid history rounds ─────────────────────────────────────────────────
  // Pre-compute each history round's owner toPar to avoid double-calling
  // calculateTotals later.
  const validHistory: { round: Round; toPar: number }[] = [];
  for (const r of history) {
    if (r.id === round.id) continue;          // exclude the current round
    if (r.status !== "completed") continue;    // completed only
    if (r.players.length === 0) continue;
    const hOwner = getOwnerPlayerId(r);
    if (!hOwner) continue;
    const totals = calculateTotals(r.scores, r.holes, hOwner);
    if (totals.playedHoles < MIN_PLAYED_HOLES) continue;
    validHistory.push({ round: r, toPar: totals.toPar });
  }

  // ── State: first-round ───────────────────────────────────────────────────
  if (validHistory.length === 0) {
    return { state: "first-round" };
  }

  // ── vsAverageToPar — available for thin-history and ready ────────────────
  const historyToPars = validHistory.map((v) => v.toPar);
  const sum = historyToPars.reduce((a, b) => a + b, 0);
  const historicalAvg =
    Math.round((sum / historyToPars.length) * 10) / 10;

  const vsAverageToPar: NonNullable<RoundInsightsResult["vsAverageToPar"]> = {
    thisRound: thisRoundToPar,
    historicalAvg,
    delta: Math.round((thisRoundToPar - historicalAvg) * 10) / 10,
    sampleSize: validHistory.length,
  };

  // ── State: thin-history ──────────────────────────────────────────────────
  if (validHistory.length < MIN_HISTORY_ROUNDS) {
    return { state: "thin-history", vsAverageToPar };
  }

  // ── State: ready — full comparison ───────────────────────────────────────

  // Par-type comparison:
  // Historical side — reuse deriveParTypeAverages (owner-scoped per history round).
  const historyRounds = validHistory.map((v) => v.round);
  const historicalParTypeRows = deriveParTypeAverages(historyRounds);
  const histByPar = new Map<number, ParTypeRow>(
    historicalParTypeRows.map((row) => [row.par, row])
  );

  // Current round — compute per-par-type avg-to-par for the owner.
  type Bucket = { totalToPar: number; count: number };
  const currentBuckets = new Map<3 | 4 | 5, Bucket>();
  const holeParByNumber = new Map(
    round.holes.map((h) => [h.number, h.par])
  );
  for (const s of round.scores) {
    if (s.playerId !== ownerId || s.strokes === null) continue;
    const par = holeParByNumber.get(s.holeNumber);
    if (par !== 3 && par !== 4 && par !== 5) continue;
    const existing = currentBuckets.get(par) ?? { totalToPar: 0, count: 0 };
    currentBuckets.set(par, {
      totalToPar: existing.totalToPar + (s.strokes - par),
      count: existing.count + 1,
    });
  }

  const parTypeComparison: ParTypeInsight[] = [];
  for (const parKey of [3, 4, 5] as const) {
    const curr = currentBuckets.get(parKey);
    const hist = histByPar.get(parKey);
    if (!curr || !hist) continue; // only include where both have data
    const thisRoundAvgToPar =
      Math.round((curr.totalToPar / curr.count) * 10) / 10;
    parTypeComparison.push({
      par: parKey,
      thisRoundAvgToPar,
      historicalAvgToPar: hist.avgToPar,
      delta: Math.round((thisRoundAvgToPar - hist.avgToPar) * 10) / 10,
    });
  }

  // Ranking — count how many history rounds have a strictly lower (better) to-par.
  const rank =
    historyToPars.filter((tp) => tp < thisRoundToPar).length + 1;
  const total = historyToPars.length + 1; // history + current round

  return {
    state: "ready",
    vsAverageToPar,
    parTypeComparison:
      parTypeComparison.length > 0 ? parTypeComparison : undefined,
    ranking: { rank, total },
  };
}
