/**
 * WHS-style Handicap Index computation from a player's real rounds.
 *
 * The app previously showed only a manually-typed handicap (the computed
 * differential/trend were removed as fabricated). This module computes a proper
 * Score Differential per round and a Handicap Index via the official WHS
 * selection table, so the profile can show an auto-updating estimate.
 *
 * WHS 2020 (no legacy 0.96 Bonus-for-Excellence):
 *   Score Differential = (113 / slope) × (adjustedGross − courseRating)
 *   Handicap Index      = mean of the lowest N differentials (per the table
 *                         below, of the most recent 20) + the low-count adjustment,
 *                         rounded to one decimal.
 *
 * Limitations (documented, not hidden):
 *   • Uses GROSS as the adjusted gross score (no net-double-bogey cap yet — that
 *     needs a course handicap, a follow-up).
 *   • Rating/slope default to 72.0 / 113 when a round doesn't carry them, so the
 *     estimate sharpens as courses gain rating/slope data. Clearly labelled an
 *     "estimate" in the UI.
 *   • 18-hole complete rounds only for now (9-hole combining is a follow-up).
 *
 * Pure — no I/O, fully unit-testable.
 */

import type { Round } from './types';
import { getOwnerPlayerId } from './round-owner';

export const NEUTRAL_RATING = 72.0;
export const NEUTRAL_SLOPE = 113;

/**
 * Number of lowest differentials to average, and the adjustment to add, for a
 * given count of available differentials (official WHS table). Counts below 3
 * are not enough for an index.
 */
export function whsSelection(n: number): { count: number; adjustment: number } | null {
  if (n < 3) return null;
  if (n === 3) return { count: 1, adjustment: -2.0 };
  if (n === 4) return { count: 1, adjustment: -1.0 };
  if (n === 5) return { count: 1, adjustment: 0 };
  if (n === 6) return { count: 2, adjustment: -1.0 };
  if (n <= 8) return { count: 2, adjustment: 0 };
  if (n <= 11) return { count: 3, adjustment: 0 };
  if (n <= 14) return { count: 4, adjustment: 0 };
  if (n <= 16) return { count: 5, adjustment: 0 };
  if (n <= 18) return { count: 6, adjustment: 0 };
  if (n === 19) return { count: 7, adjustment: 0 };
  return { count: 8, adjustment: 0 }; // 20 (and we only ever pass ≤20)
}

/** WHS Score Differential for one round, rounded to 1 decimal. */
export function scoreDifferential(
  adjustedGross: number,
  courseRating: number,
  slope: number,
): number {
  const s = slope > 0 ? slope : NEUTRAL_SLOPE;
  return Math.round((113 / s) * (adjustedGross - courseRating) * 10) / 10;
}

/**
 * Handicap Index from a list of Score Differentials (any order, most-recent
 * first is fine — only the most recent 20 are considered). Returns null when
 * there are fewer than 3.
 */
export function handicapIndex(differentials: number[]): number | null {
  const recent = differentials.slice(0, 20);
  const sel = whsSelection(recent.length);
  if (!sel) return null;
  const lowest = [...recent].sort((a, b) => a - b).slice(0, sel.count);
  const mean = lowest.reduce((acc, d) => acc + d, 0) / lowest.length;
  return Math.round((mean + sel.adjustment) * 10) / 10;
}

export interface HandicapEstimate {
  index: number;
  roundsUsed: number;
}

/** Optional per-round rating/slope source (e.g. from the course's tee). */
export type RatingSlopeFor = (round: Round) => { rating?: number; slope?: number } | undefined;

/** Owner's total gross strokes for a round, or null if the round isn't a
 *  complete 18 for that player. */
function ownerGross(round: Round): number | null {
  const ownerId = getOwnerPlayerId(round);
  if (!ownerId) return null;
  const holeCount = round.holes?.length ?? 0;
  if (holeCount < 18) return null; // 18-hole rounds only (v1)
  const strokesByHole = new Map<number, number>();
  for (const s of round.scores) {
    if (s.playerId === ownerId && typeof s.strokes === 'number') {
      strokesByHole.set(s.holeNumber, s.strokes);
    }
  }
  // Require a score on every hole (a complete round).
  for (const h of round.holes) {
    if (!strokesByHole.has(h.number)) return null;
  }
  let total = 0;
  for (const v of strokesByHole.values()) total += v;
  return total;
}

/**
 * Estimate a Handicap Index from the owner's completed 18-hole rounds.
 * Uses real rating/slope from `ratingSlopeFor` when available, else neutral
 * defaults. Returns null with fewer than 3 eligible rounds.
 *
 * `rounds` should be most-recent-first (the most recent 20 are used).
 */
export function estimateHandicapFromRounds(
  rounds: Round[],
  ratingSlopeFor?: RatingSlopeFor,
): HandicapEstimate | null {
  const diffs: number[] = [];
  for (const r of rounds) {
    if (r.status !== 'completed') continue;
    const gross = ownerGross(r);
    if (gross == null) continue;
    const rs = ratingSlopeFor?.(r);
    const rating = rs?.rating ?? NEUTRAL_RATING;
    const slope = rs?.slope ?? NEUTRAL_SLOPE;
    diffs.push(scoreDifferential(gross, rating, slope));
    if (diffs.length >= 20) break;
  }
  const index = handicapIndex(diffs);
  if (index == null) return null;
  return { index, roundsUsed: Math.min(diffs.length, 20) };
}
