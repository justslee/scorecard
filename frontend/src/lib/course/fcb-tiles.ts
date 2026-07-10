/**
 * fcb-tiles.ts — pure selection of the Front / Center / Back tile VALUES shown
 * on the yardage card (DistancesCard) under the hole map.
 *
 * Extracted from RoundPageClient so the honest-vs-fabricated decision is
 * headless-testable (same pattern as tee-anchor.ts / fcb-labels.ts).
 *
 * No-fake-data invariant (specs / MEMORY "no-fake-data-fallbacks"): the tiles
 * MUST NEVER show a fabricated distance. Before this helper, the non-card
 * branch rendered `distance ± offset` — where `distance` is a ~40%
 * illustration PLACEHOLDER, not a real yardage — whenever `fcb` geometry was
 * missing but the source wasn't already `card`. That produced Front/Center/Back
 * numbers that silently disagreed with the scorecard (e.g. a round with a
 * course-center anchor but no mapped hole geometry, or the load window before
 * mapCoords resolve). This helper collapses every "no real F/C/B geometry"
 * state to the honest card-only tiles.
 *
 * Pure function — no React, no DOM, no network.
 */

import type { FCBDistances } from './course-coordinates';

export interface FcbTileValues {
  /** Yards to the front edge, or the "—" placeholder when unknown. */
  front: number | string;
  /** Yards to center, the scorecard yardage on the card-only path, or "—". */
  center: number | string;
  /** Yards to the back edge, or the "—" placeholder when unknown. */
  back: number | string;
}

const DASH = '—';

/**
 * The EFFECTIVE F/C/B source once "no real geometry" is accounted for.
 *
 * The tiles fall back to honest card-only whenever there is no real F/C/B
 * geometry to show — EITHER the resolved source is already `card` (tee-anchor's
 * card-only fallback), OR `fcb` is null (no live GPS fix AND no from-tee
 * geometry: unmapped / anchor-only round, a hole absent from the coords, or the
 * pre-load window). In that state the caption must ALSO read "from the card",
 * never "from the tee" over honest "—" tiles — so both the tile values and the
 * caption derive from this single function (they can never drift apart).
 *
 * The three working paths keep `fcb` non-null, so this returns `fcbSource`
 * unchanged for them.
 */
export function effectiveFcbSource(
  fcbSource: 'you' | 'tee' | 'card',
  fcb: FCBDistances | null,
): 'you' | 'tee' | 'card' {
  return fcb == null ? 'card' : fcbSource;
}

/**
 * Resolve the three tile values.
 *
 * Card-only (honest "—" front/back, scorecard yardage for center) whenever
 * `effectiveFcbSource` is `card`; otherwise the three real distances from `fcb`
 * (live GPS "you", or from-tee). The three working paths are byte-identical to
 * the pre-extraction behavior: on the GPS and from-tee paths `fcb` is always
 * non-null, and on the card path `fcbSource === 'card'` — so `fcb` is always
 * safe to read in the else branch.
 */
export function buildFcbTiles(opts: {
  fcb: FCBDistances | null;
  fcbSource: 'you' | 'tee' | 'card';
  cardYards: number | null;
}): FcbTileValues {
  const { fcb, fcbSource, cardYards } = opts;
  if (effectiveFcbSource(fcbSource, fcb) === 'card') {
    return { front: DASH, center: cardYards ?? DASH, back: DASH };
  }
  return { front: fcb!.front, center: fcb!.center, back: fcb!.back };
}
