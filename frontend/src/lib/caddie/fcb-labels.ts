/**
 * fcb-labels.ts — pure presentation helpers for the F/C/B distances card
 * (round map screen).
 *
 * Extracts the source-caption and PLAYS-sub-label derivation logic from
 * RoundPageClient so it can be unit-tested without rendering the 2400-line
 * component (same pattern as plays-like.ts / plays-like.test.ts).
 *
 * No React, no runtime dependencies — pure primitives in, primitives out.
 */

// ---------------------------------------------------------------------------
// fcbSourceCaption
// ---------------------------------------------------------------------------

export type FcbSource = "you" | "tee";

export interface FcbCaption {
  /** Display string incl. the leading accent dot when live. Rendered under
      textTransform:uppercase, so lowercase source strings are intentional. */
  text: string;
  /** true when derived from live GPS ("you") → render in DEFAULT_ACCENT. */
  isLive: boolean;
}

/** Source caption for the F/C/B tiles. */
export function fcbSourceCaption(source: FcbSource): FcbCaption {
  const isLive = source === "you";
  return {
    text: isLive ? "● from where you stand" : "from the tee",
    isLive,
  };
}

// ---------------------------------------------------------------------------
// playsSubLabel
// ---------------------------------------------------------------------------

export interface PlaysSubInput {
  /** holeWind != null — per-hole relative wind is available. */
  hasWind: boolean;
  /** holeIntel != null — USGS elevation intel is available. */
  hasElev: boolean;
  /** fcbLive != null — plays-base came from the live rangefinder distance. */
  isLive: boolean;
}

/**
 * PLAYS-tile sub label. Each branch truthfully names what was adjusted.
 * Mirrors the pre-refactor ternary in RoundPageClient exactly, EXCEPT the
 * wind+elev branch, which was the bare "adjusted".
 */
export function playsSubLabel({ hasWind, hasElev, isLive }: PlaysSubInput): string {
  if (hasWind) {
    if (isLive) return "wind from you"; // wind on live distance; no elev term applied
    if (hasElev) return "wind+elev";    // was "adjusted" — wind AND elevation both applied
    return "wind-adj";                  // wind only
  }
  if (hasElev && !isLive) return "elev-adj"; // elevation only
  if (isLive) return "from you";             // raw live distance, no adjustments
  return "from tee";                         // raw card/tee distance
}

// ---------------------------------------------------------------------------
// lineVsCardHint
// ---------------------------------------------------------------------------

export interface LineVsCardHint {
  /** true when |center − cardYards| / cardYards is strictly > 0.05. */
  show: boolean;
  /** Tiny label distinguishing straight-line from card; "" when !show. */
  text: string;
}

/**
 * Designer-gated dogleg hint. When the straight-line Center distance diverges
 * from the scorecard card yardage by more than 5%, the two numbers can read as
 * a bug; this flags a quiet "line" clarifier. Boundary is strictly >5%.
 */
export function lineVsCardHint(
  center: number | null | undefined,
  cardYards: number,
): LineVsCardHint {
  if (center == null || !Number.isFinite(center) || cardYards <= 0) {
    return { show: false, text: "" };
  }
  const divergence = Math.abs(center - cardYards) / cardYards;
  return divergence > 0.05 ? { show: true, text: "line" } : { show: false, text: "" };
}
