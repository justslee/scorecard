/**
 * Pure derivation helpers for career personal-bests on the profile page.
 *
 * Distinct from profile-stats.ts (which handles averages / distribution / trend).
 * These functions compute career milestones across ALL of the owner's completed rounds.
 *
 * All functions accept Round[] (already loaded) and return plain data objects —
 * no React, no API calls, no side effects.
 * Owner identification: getOwnerPlayerId() from round-owner.ts (prefers
 * round.ownerPlayerId, falls back to players[0] for legacy rounds).
 *
 * Conventions (consistent with profile-stats.ts):
 * - Only `status === "completed"` rounds with ≥1 player are examined.
 * - Best-round and rounds-played count only rounds with ≥9 played holes.
 * - Hole-level stats (milestones, best-hole, streak) use all non-null scored
 *   holes in completed rounds — individual hole scores are meaningful even in
 *   partial rounds.
 * - Streak logic treats un-scored holes (null or absent) as breakers (conservative).
 * - All types are exported for use in the profile page and tests.
 */

import { calculateTotals } from "./types";
import { getOwnerPlayerId } from "./round-owner";
import type { Round } from "./types";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Best single round by score-to-par across the owner's career */
export type BestRound = {
  /** Strokes relative to par (played holes only; negative = under par) */
  toPar: number;
  /** Raw total strokes */
  totalStrokes: number;
  /** Course name as stored on the round */
  courseName: string;
  /** ISO date string normalised to YYYY-MM-DD */
  date: string;
  /** Number of holes set up for the round (typically 9 or 18) */
  holeCount: number;
};

/** Career totals for special hole results */
export type Milestones = {
  /** Holes at eagle or better (strokes − par ≤ −2) */
  eagles: number;
  /** Holes at birdie (strokes − par === −1) */
  birdies: number;
  /** Holes at par (strokes − par === 0) */
  pars: number;
};

/** Best single-hole score vs par, broken down by par type */
export type BestHoleByPar = {
  par3: { delta: number; strokes: number } | null;
  par4: { delta: number; strokes: number } | null;
  par5: { delta: number; strokes: number } | null;
};

/** Derived career personal-bests for the profile page */
export type PersonalBests = {
  /** Completed rounds with ≥9 holes played */
  roundsPlayed: number;
  /** Best single round by toPar; null when no qualifying round exists */
  bestRound: BestRound | null;
  /** Career totals for eagle / birdie / par hole results */
  milestones: Milestones;
  /** Best score vs par on a single hole, per par type */
  bestHoleByPar: BestHoleByPar;
  /**
   * Longest run of consecutive birdie-or-better (delta ≤ −1) holes within a
   * single round. Un-scored holes (null or absent) break the streak.
   * Zero when the owner has no birdies.
   */
  longestBirdieStreak: number;
};

// ── Derivation ────────────────────────────────────────────────────────────────

/**
 * Derive career personal-bests for the owner across all provided rounds.
 *
 * Returns a zero-state object when there are no qualifying rounds:
 *   { roundsPlayed: 0, bestRound: null, milestones: {0,0,0},
 *     bestHoleByPar: {null,null,null}, longestBirdieStreak: 0 }
 */
export function derivePersonalBests(rounds: Round[]): PersonalBests {
  const milestones: Milestones = { eagles: 0, birdies: 0, pars: 0 };
  const bestHoleByPar: BestHoleByPar = { par3: null, par4: null, par5: null };
  let bestRound: BestRound | null = null;
  let roundsPlayed = 0;
  let longestBirdieStreak = 0;

  const completed = rounds.filter(
    (r) => r.status === "completed" && r.players.length > 0
  );

  for (const r of completed) {
    const ownerId = getOwnerPlayerId(r);
    if (!ownerId) continue;

    // ── Build score lookup for this round (includes null entries) ─────────
    // Key: holeNumber → strokes (number | null). Missing entries → undefined.
    const ownerScoreByHole = new Map<number, number | null>(
      r.scores
        .filter((s) => s.playerId === ownerId)
        .map((s) => [s.holeNumber, s.strokes])
    );

    // ── Round-level aggregates (rounds played + best round) ───────────────
    const totals = calculateTotals(r.scores, r.holes, ownerId);
    if (totals.playedHoles >= 9) {
      roundsPlayed += 1;

      const candidate: BestRound = {
        toPar: totals.toPar,
        totalStrokes: totals.total,
        courseName: r.courseName,
        // Normalise to YYYY-MM-DD (some dates may include time components).
        date: r.date.slice(0, 10),
        holeCount: r.holes.length,
      };

      if (
        bestRound === null ||
        candidate.toPar < bestRound.toPar ||
        // Tie-break: prefer the more recent round.
        (candidate.toPar === bestRound.toPar && candidate.date > bestRound.date)
      ) {
        bestRound = candidate;
      }
    }

    // ── Hole-level aggregates ─────────────────────────────────────────────
    // Iterate through every hole in the round in order so streak gaps are
    // correctly detected even when a score entry is absent or null.
    const sortedHoles = [...r.holes].sort((a, b) => a.number - b.number);
    let currentStreak = 0;

    for (const hole of sortedHoles) {
      const par = hole.par;
      const strokes = ownerScoreByHole.get(hole.number);

      // Un-scored hole (null or missing) → break streak, skip hole-level stats.
      if (strokes == null) {
        currentStreak = 0;
        continue;
      }

      const delta = strokes - par;

      // ── Milestone counts ────────────────────────────────────────────────
      if (delta <= -2) milestones.eagles += 1;
      else if (delta === -1) milestones.birdies += 1;
      else if (delta === 0) milestones.pars += 1;

      // ── Best hole by par type (lower delta wins; tie → lower raw strokes) ──
      if (par === 3 || par === 4 || par === 5) {
        const parKey: keyof BestHoleByPar =
          par === 3 ? "par3" : par === 4 ? "par4" : "par5";
        const prev = bestHoleByPar[parKey];
        if (
          prev === null ||
          delta < prev.delta ||
          (delta === prev.delta && strokes < prev.strokes)
        ) {
          bestHoleByPar[parKey] = { delta, strokes };
        }
      }

      // ── Birdie streak (consecutive holes at birdie or better) ────────────
      if (delta <= -1) {
        currentStreak += 1;
        if (currentStreak > longestBirdieStreak) {
          longestBirdieStreak = currentStreak;
        }
      } else {
        currentStreak = 0;
      }
    }
    // Streak intentionally resets between rounds — we track single-round streaks.
  }

  return {
    roundsPlayed,
    bestRound,
    milestones,
    bestHoleByPar,
    longestBirdieStreak,
  };
}
