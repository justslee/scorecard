/**
 * hole-elevation.ts — pure helpers for reading per-hole elevation data from
 * GeoJSON feature properties and rendering a "plays-like" readout.
 *
 * Elevation data is stored in the **green feature's properties** during the
 * OSM ingest pipeline (embed_elevation_in_green_features in osm_ingest.py).
 * The four fields written there are:
 *
 *   tee_elevation_ft   — elevation at the tee in feet
 *   green_elevation_ft — elevation at the green centre in feet
 *   delta_ft           — green − tee in feet (positive = uphill)
 *   plays_like_yards   — adjustment in yards (1 yd per 3 ft rule)
 *
 * These functions are pure (no I/O, no React) and fully unit-testable.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HoleElevation {
  /** Tee elevation in feet. */
  teeElevationFt: number;
  /** Green centre elevation in feet. */
  greenElevationFt: number;
  /** delta_ft: green − tee in feet.  Positive = uphill, negative = downhill. */
  deltaFt: number;
  /**
   * Plays-like yardage adjustment.
   * Positive = hole plays longer (uphill); negative = shorter (downhill).
   * Computed from the backend PLAYS_LIKE_YARD_PER_FT constant (1 yd / 3 ft).
   */
  playsLikeYards: number;
}

// ── Extract elevation from green feature properties ────────────────────────────

/**
 * Scan *features* (from HoleData.features.features) for the first green
 * feature that carries elevation data and return it as a ``HoleElevation``.
 *
 * Returns ``null`` when:
 *   - there is no green feature in the list
 *   - the green feature exists but was ingested before elevation was added
 *     (i.e. ``plays_like_yards`` is absent from its properties)
 *
 * This makes the readout gracefully absent for holes without elevation data —
 * no UI element is rendered rather than showing NaN or 0.
 */
export function extractHoleElevation(
  features: GeoJSON.Feature[],
): HoleElevation | null {
  for (const f of features) {
    const props = f.properties as Record<string, unknown> | null;
    if (!props) continue;
    if (props['featureType'] !== 'green') continue;
    // Presence of plays_like_yards signals that elevation was embedded.
    if (typeof props['plays_like_yards'] !== 'number') continue;

    const teeElevationFt   = props['tee_elevation_ft']   as number;
    const greenElevationFt = props['green_elevation_ft'] as number;
    const deltaFt          = props['delta_ft']           as number;
    const playsLikeYards   = props['plays_like_yards']   as number;

    // Guard: ensure all four fields are present numbers.
    if (
      typeof teeElevationFt   !== 'number' ||
      typeof greenElevationFt !== 'number' ||
      typeof deltaFt          !== 'number'
    ) {
      continue;
    }

    return { teeElevationFt, greenElevationFt, deltaFt, playsLikeYards };
  }
  return null;
}

// ── Plays-like display text ────────────────────────────────────────────────────

/**
 * Format a plays-like readout for the yardage-book info strip.
 *
 * Rules:
 *   |playsLikeYards| < 1  → "flat"
 *   positive              → "plays ~N yds longer ↑"  (uphill)
 *   negative              → "plays ~N yds shorter ↓" (downhill)
 *
 * Yardage is rounded to the nearest integer.  The ↑/↓ arrows are plain
 * Unicode (U+2191 / U+2193) — no emoji, matching the on-paper, calm feel.
 */
export function formatPlaysLike(playsLikeYards: number): string {
  const abs = Math.abs(Math.round(playsLikeYards));
  if (abs < 1) return 'flat';
  return playsLikeYards > 0
    ? `plays ~${abs} yds longer ↑`
    : `plays ~${abs} yds shorter ↓`;
}
