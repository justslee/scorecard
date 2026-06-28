/**
 * Pure statistical helpers for the profile page scoring breakdown.
 *
 * All functions accept Round[] (already loaded by the profile page) and
 * return plain data objects — no React, no API calls, no side effects.
 * The owner's player is resolved via getOwnerPlayerId() (round-owner.ts), which
 * prefers round.ownerPlayerId and falls back to the first player for legacy rounds.
 */

import { calculateTotals } from "./types";
import { getOwnerPlayerId } from "./round-owner";
import type { Round } from "./types";

// ── Par-type averages ──────────────────────────────────────────────────────

export type ParTypeRow = {
  /** 3 | 4 | 5 */
  par: 3 | 4 | 5;
  /** Total scored holes of this par type across all completed rounds */
  holeCount: number;
  /** Average raw score, rounded to 1 decimal place */
  avgScore: number;
  /** Average score vs par (sign preserved), rounded to 1 decimal place */
  avgToPar: number;
};

/**
 * Compute per-par-type averages (par-3 / par-4 / par-5) from the owner's
 * completed rounds.
 *
 * - Only holes where the owner has a non-null strokes value are counted.
 * - Holes whose `par` is not 3, 4, or 5 are silently skipped.
 * - Non-completed rounds and rounds with no players are skipped.
 * - Returns only rows with at least one scored hole.
 */
export function deriveParTypeAverages(rounds: Round[]): ParTypeRow[] {
  type Bucket = { totalScore: number; totalToPar: number; count: number };
  const buckets: Record<3 | 4 | 5, Bucket> = {
    3: { totalScore: 0, totalToPar: 0, count: 0 },
    4: { totalScore: 0, totalToPar: 0, count: 0 },
    5: { totalScore: 0, totalToPar: 0, count: 0 },
  };

  for (const r of rounds) {
    if (r.status !== "completed" || r.players.length === 0) continue;
    const ownerId = getOwnerPlayerId(r);
    if (!ownerId) continue;
    const holeParByNumber = new Map<number, number>(r.holes.map((h) => [h.number, h.par]));

    for (const s of r.scores) {
      if (s.playerId !== ownerId || s.strokes === null) continue;
      const par = holeParByNumber.get(s.holeNumber);
      if (par !== 3 && par !== 4 && par !== 5) continue;
      buckets[par].totalScore += s.strokes;
      buckets[par].totalToPar += s.strokes - par;
      buckets[par].count += 1;
    }
  }

  const rows: ParTypeRow[] = [];
  for (const parKey of [3, 4, 5] as const) {
    const b = buckets[parKey];
    if (b.count === 0) continue;
    rows.push({
      par: parKey,
      holeCount: b.count,
      avgScore: Math.round((b.totalScore / b.count) * 10) / 10,
      avgToPar: Math.round((b.totalToPar / b.count) * 10) / 10,
    });
  }
  return rows;
}

// ── Score distribution ─────────────────────────────────────────────────────

export type ScoreDistBucket =
  | "eagle_or_better"
  | "birdie"
  | "par"
  | "bogey"
  | "double_plus";

export type ScoreDistRow = {
  bucket: ScoreDistBucket;
  label: string;
  count: number;
  /** Percentage of total scored holes, rounded to 1 decimal place (0–100) */
  pct: number;
};

const DIST_LABELS: Record<ScoreDistBucket, string> = {
  eagle_or_better: "Eagle or better",
  birdie: "Birdie",
  par: "Par",
  bogey: "Bogey",
  double_plus: "Double+",
};

const DIST_ORDER: ScoreDistBucket[] = [
  "eagle_or_better",
  "birdie",
  "par",
  "bogey",
  "double_plus",
];

/**
 * Count scored holes by result relative to par across all of the owner's
 * completed rounds.
 *
 * Buckets: eagle-or-better (delta ≤ −2) / birdie (−1) / par (0) / bogey (+1)
 * / double+ (≥+2). Only holes with non-null scores and a matching hole definition
 * are counted. Returns an empty array when there are no scored holes.
 */
export function deriveScoreDistribution(rounds: Round[]): ScoreDistRow[] {
  const counts: Record<ScoreDistBucket, number> = {
    eagle_or_better: 0,
    birdie: 0,
    par: 0,
    bogey: 0,
    double_plus: 0,
  };

  for (const r of rounds) {
    if (r.status !== "completed" || r.players.length === 0) continue;
    const ownerId = getOwnerPlayerId(r);
    if (!ownerId) continue;
    const holeParByNumber = new Map<number, number>(r.holes.map((h) => [h.number, h.par]));

    for (const s of r.scores) {
      if (s.playerId !== ownerId || s.strokes === null) continue;
      const par = holeParByNumber.get(s.holeNumber);
      if (typeof par !== "number") continue;
      const delta = s.strokes - par;
      if (delta <= -2) counts.eagle_or_better += 1;
      else if (delta === -1) counts.birdie += 1;
      else if (delta === 0) counts.par += 1;
      else if (delta === 1) counts.bogey += 1;
      else counts.double_plus += 1;
    }
  }

  const total = DIST_ORDER.reduce((s, k) => s + counts[k], 0);
  if (total === 0) return [];

  return DIST_ORDER.filter((k) => counts[k] > 0).map((k) => ({
    bucket: k,
    label: DIST_LABELS[k],
    count: counts[k],
    pct: Math.round((counts[k] / total) * 1000) / 10,
  }));
}

// ── Recent trend ───────────────────────────────────────────────────────────

export type TrendResult = {
  /** Average to-par over the most-recent window (rounded to 1dp) */
  recentAvgToPar: number;
  /** Average to-par over the prior window (rounded to 1dp) */
  priorAvgToPar: number;
  /** recentAvgToPar − priorAvgToPar; negative = improving (rounded to 1dp) */
  delta: number;
  /** Number of valid rounds in the recent window */
  recentCount: number;
  /** Number of valid rounds in the prior window */
  priorCount: number;
};

/**
 * Compare the owner's scoring trend: the most-recent `recentN` completed
 * rounds vs all prior completed rounds.
 *
 * Returns null when:
 * - Fewer than 2 completed rounds in total.
 * - No rounds remain in the "prior" window (all rounds are within recentN).
 * - Either window has no rounds with ≥ 9 played holes (i.e. valid scorecards).
 *
 * Rounds are sorted newest-first before windowing; rounds with < 9 played holes
 * are excluded from averages but do not disqualify the whole result.
 */
export function deriveTrend(rounds: Round[], recentN = 5): TrendResult | null {
  const completed = rounds
    .filter((r) => r.status === "completed" && r.players.length > 0)
    .slice()
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  if (completed.length < 2) return null;

  const recent = completed.slice(0, recentN);
  const prior = completed.slice(recentN);
  if (prior.length === 0) return null;

  const validToPars = (rs: Round[]): number[] =>
    rs
      .map((r) => {
        const ownerId = getOwnerPlayerId(r);
        return ownerId ? calculateTotals(r.scores, r.holes, ownerId) : null;
      })
      .filter((t) => t !== null && t.playedHoles >= 9)
      .map((t) => t!.toPar);

  const recentToPars = validToPars(recent);
  const priorToPars = validToPars(prior);
  if (recentToPars.length === 0 || priorToPars.length === 0) return null;

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const recentAvg = avg(recentToPars);
  const priorAvg = avg(priorToPars);

  return {
    recentAvgToPar: Math.round(recentAvg * 10) / 10,
    priorAvgToPar: Math.round(priorAvg * 10) / 10,
    delta: Math.round((recentAvg - priorAvg) * 10) / 10,
    recentCount: recentToPars.length,
    priorCount: priorToPars.length,
  };
}
