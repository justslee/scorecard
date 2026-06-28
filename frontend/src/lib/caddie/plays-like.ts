/**
 * plays-like.ts — pure presentation helper for the "Plays like" yardage card.
 *
 * Extracts the display logic from CaddiePanel so it can be unit-tested without
 * needing React or any runtime caddie dependencies.
 *
 * Input: a slim slice of CaddieRecommendation (raw_yards, target_yards, adjustments).
 * Output: a PlaysLikeSummary that the component renders directly.
 */

import type { ShotAdjustment, CaddieRecommendation } from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PlaysLikeRow {
  type: ShotAdjustment['type'];
  /** Human-readable factor label, e.g. "Elevation" */
  label: string;
  /** Signed yard delta from the raw distance (positive = plays longer) */
  signedYards: number;
  /** Free-text description from the backend, e.g. "Uphill — plays longer" */
  description: string;
}

export interface PlaysLikeSummary {
  rawYards: number;
  targetYards: number;
  /** targetYards − rawYards; negative means the shot plays shorter */
  deltaYards: number;
  /** true when at least one adjustment is present */
  hasAdjustment: boolean;
  /** One row per ShotAdjustment, in original order */
  rows: PlaysLikeRow[];
  /** Wind adjustment surfaced separately for the wind chip; undefined if no wind adj */
  wind?: { signedYards: number; description: string };
}

// ---------------------------------------------------------------------------
// Label map
// ---------------------------------------------------------------------------

const ADJUSTMENT_LABELS: Record<ShotAdjustment['type'], string> = {
  wind: 'Wind',
  elevation: 'Elevation',
  temperature: 'Temperature',
  altitude: 'Altitude',
  conditions: 'Conditions',
};

// ---------------------------------------------------------------------------
// Core builder — the function CaddiePanel (and tests) call
// ---------------------------------------------------------------------------

/**
 * Build a structured "plays-like" summary from the recommendation slice.
 *
 * @param rec - Slim pick of CaddieRecommendation with the fields we need.
 * @returns PlaysLikeSummary ready for the component to render.
 */
export function buildPlaysLike(
  rec: Pick<CaddieRecommendation, 'raw_yards' | 'target_yards' | 'adjustments'>
): PlaysLikeSummary {
  const rawYards = rec.raw_yards;
  const targetYards = rec.target_yards;
  const deltaYards = targetYards - rawYards;
  const hasAdjustment = rec.adjustments.length > 0;

  const rows: PlaysLikeRow[] = rec.adjustments.map((adj) => ({
    type: adj.type,
    label: ADJUSTMENT_LABELS[adj.type],
    signedYards: adj.yards,
    description: adj.description,
  }));

  const windAdj = rec.adjustments.find((a) => a.type === 'wind');
  const wind = windAdj
    ? { signedYards: windAdj.yards, description: windAdj.description }
    : undefined;

  return { rawYards, targetYards, deltaYards, hasAdjustment, rows, wind };
}

// ---------------------------------------------------------------------------
// Display helpers — used by the component for consistent signed-yard strings
// ---------------------------------------------------------------------------

/**
 * Format a signed yard delta as a string, e.g. −7y or +4y.
 * Uses a proper minus sign (−, U+2212) for negative values.
 */
export function formatSignedYards(signedYards: number): string {
  if (signedYards === 0) return '0y';
  return signedYards > 0 ? `+${signedYards}y` : `−${Math.abs(signedYards)}y`;
}
