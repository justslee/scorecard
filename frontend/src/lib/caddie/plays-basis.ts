/**
 * plays-basis.ts — pure selection of the PLAYS tile's basis numbers on the
 * round page (companion to plays-tile.ts, which formats the tile once the
 * basis is chosen).
 *
 * No-fake-data invariant (MEMORY "no-fake-data-fallbacks"; completes the
 * cycle-61 F/C/B honesty fix in lib/course/fcb-tiles.ts): the PLAYS number
 * must NEVER be the illustration placeholder `distance` (RoundPageClient's
 * `Math.max(80, hole.yards - round(hole.yards*0.6))`, a ~40% mock used only
 * to draw the hole). Before this helper, the round page keyed the plays basis
 * off the NARROW `showCardOnly = fcbSource === 'card'` flag while the F/C/B
 * tiles collapsed to honest card-only on the WIDER `effectiveFcbSource` (i.e.
 * `fcb == null || fcbSource === 'card'`). In the anchor-only unmapped state
 * (`fcb` null, `fcbSource === 'tee'`, `fcbFromTee` null) the tiles read honest
 * "—" but the plays basis fell through to `distance` — a fabricated number
 * labeled as a real plays-like beside the honest tiles.
 *
 * This helper keys the basis off the SAME `effectiveCardOnly` condition the
 * tiles use, and deliberately does NOT receive `distance` — so the plays basis
 * can never resolve to the placeholder. When there is no honest basis at all
 * (card-only with no scorecard yardage), `playsBase` is null and the caller
 * renders "—" (coherent with the "—" F/C/B center).
 *
 * The three real working paths are byte-identical to the pre-extraction code:
 *   - GPS (fcbLive present)      → fcbLive.center for both.
 *   - genuine from-tee           → playsBase = holeIntel.effectiveYards ||
 *                                  fcbFromTee.center; physicsBasis = the RAW
 *                                  fcbFromTee.center (NEVER effectiveYards —
 *                                  the engine applies elevation itself, so a
 *                                  pre-adjusted basis would double-count it,
 *                                  plan §4.2).
 *   - real card-only             → cardYards for both.
 * Only the fcb-null-but-source-'tee' state changes: it now lands in the
 * card-only branch (cardYards) instead of falling to `distance`.
 *
 * Pure function — no React, no DOM, no network.
 */

import type { FCBDistances } from '../course/course-coordinates';

export interface PlaysBasisInput {
  /** Live rangefinder F/C/B from where the golfer stands, or null. When set,
   *  its center wins for both bases (plays-like from the current spot). */
  fcbLive: FCBDistances | null;
  /** effectiveFcbSource(fcbSource, fcb) === 'card' — the SAME collapse the
   *  F/C/B tiles use (fcb == null || fcbSource === 'card'). Widened from the
   *  old narrow `showCardOnly = fcbSource === 'card'`. */
  effectiveCardOnly: boolean;
  /** The scorecard yardage for this hole, or null when unknown. */
  cardYards: number | null;
  /** Per-hole intel; only `effectiveYards` (elevation-composed) is read, and
   *  only for the from-tee fallback `playsBase` — never the physics basis. */
  holeIntel: { effectiveYards?: number } | null;
  /** From-tee F/C/B geometry, or null. Non-null whenever `effectiveCardOnly`
   *  is false and `fcbLive` is null (that is exactly when fcb = fcbFromTee is
   *  the non-null value that made `effectiveCardOnly` false). */
  fcbFromTee: FCBDistances | null;
}

export interface PlaysBasisResult {
  /** The honest fallback plays number shown while physics hasn't answered,
   *  or null when there is no honest basis at all (→ caller renders "—").
   *  NEVER the illustration placeholder `distance`. */
  playsBase: number | null;
  /** The RAW basis sent to the physics call — never elevation-composed
   *  (holeIntel.effectiveYards would double-count elevation, plan §4.2).
   *  null disables the physics hook. */
  physicsBasisYards: number | null;
}

export function playsBasis({
  fcbLive,
  effectiveCardOnly,
  cardYards,
  holeIntel,
  fcbFromTee,
}: PlaysBasisInput): PlaysBasisResult {
  if (fcbLive) {
    // Live rangefinder wins: plays-like from where they stand.
    return { playsBase: fcbLive.center, physicsBasisYards: fcbLive.center };
  }
  if (effectiveCardOnly) {
    // Card-only / no real F/C/B geometry: the scorecard yardage is the only
    // honest basis — never the illustration placeholder. holeIntel is skipped
    // (it was computed from the same unusable geometry). null → tile shows "—".
    return { playsBase: cardYards, physicsBasisYards: cardYards };
  }
  // Genuine from-tee: fcbFromTee is non-null here. playsBase may be the
  // elevation-composed intel yardage; the physics basis is the RAW center.
  const teeCenter = fcbFromTee?.center ?? null;
  return {
    playsBase: (holeIntel?.effectiveYards || teeCenter) ?? null,
    physicsBasisYards: teeCenter,
  };
}
