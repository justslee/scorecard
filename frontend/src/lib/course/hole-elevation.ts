/**
 * hole-elevation.ts — pure helpers for reading per-hole elevation data from
 * GeoJSON feature properties and rendering plays-like + green-slope readouts.
 *
 * Elevation data is stored in the **green feature's properties** during the
 * OSM ingest pipeline (embed_elevation_in_green_features in osm_ingest.py).
 * Fields written there are:
 *
 *   tee_elevation_ft   — elevation at the tee in feet
 *   green_elevation_ft — elevation at the green centre in feet
 *   delta_ft           — green − tee in feet (positive = uphill)
 *   plays_like_yards   — adjustment in yards (1 yd per 3 ft rule)
 *   green_slope        — optional sub-dict: { direction, severity,
 *                        percent_grade, description, center_elevation_ft }
 *                        (absent for holes ingested before this feature was wired)
 *
 * All functions are pure (no I/O, no React) and fully unit-testable.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Green-slope profile from the backend 3DEP Sobel sampler.
 *
 * Stored as a jsonb sub-dict in the green feature's properties after
 * ``embed_elevation_in_green_features`` runs.  Absent for holes whose
 * ingest predates the green-slope wiring (or where USGS returned < 5
 * of the 9 Sobel grid samples).
 */
export interface GreenSlope {
  /** Downhill azimuth in degrees (0 = N, 90 = E, 180 = S, 270 = W). */
  direction: number;
  /** Slope class: 'flat' | 'mild' | 'moderate' | 'severe'. */
  severity: string;
  /** Slope magnitude as a percentage (e.g. 2.3 means 2.3%). */
  percent_grade: number;
  /** Human-readable description from the backend (e.g. "Green slopes mildly toward the south"). */
  description: string;
  /** Elevation at the green centre in feet (optional — may be absent in older data). */
  center_elevation_ft?: number;
}

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
  /**
   * Green-slope profile.  Null when the hole was ingested before green-slope
   * sampling was wired, or when the USGS 3DEP service returned insufficient data.
   */
  greenSlope: GreenSlope | null;
}

// ── 8-point compass helpers ───────────────────────────────────────────────────

/**
 * Ordered 8-point compass labels (clockwise from north).
 * Index 0 = North (0°), index 4 = South (180°), etc.
 */
const COMPASS_LABELS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
type CompassLabel = (typeof COMPASS_LABELS)[number];

/**
 * Unicode directional arrows corresponding to each compass label.
 * Used in the green-slope readout: "↘ SE".
 */
const COMPASS_ARROWS: Record<CompassLabel, string> = {
  N:  '↑',
  NE: '↗',
  E:  '→',
  SE: '↘',
  S:  '↓',
  SW: '↙',
  W:  '←',
  NW: '↖',
};

/**
 * Convert a bearing in degrees [0, 360) to an 8-point compass label.
 *
 * Uses 45° sectors centred on each compass point:
 *   N  covers 337.5° – 22.5°
 *   NE covers  22.5° – 67.5°
 *   …and so on clockwise.
 *
 * Inputs outside [0, 360) are normalised with ``% 360``.
 *
 * @param degrees  Bearing in degrees (0 = North, 90 = East, 180 = South, …).
 * @returns One of 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW'.
 */
export function degreesToCompassLabel(degrees: number): CompassLabel {
  const normalised = ((degrees % 360) + 360) % 360;
  const idx = Math.round(normalised / 45) % 8;
  return COMPASS_LABELS[idx];
}

/**
 * Return the Unicode arrow for a compass label (e.g. 'SE' → '↘').
 * Returns an empty string for unrecognised labels.
 */
export function compassLabelToArrow(label: string): string {
  return COMPASS_ARROWS[label as CompassLabel] ?? '';
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
 * The ``greenSlope`` field is populated when the green feature properties
 * include a ``green_slope`` sub-dict (added by the I4 ingest pipeline);
 * it is ``null`` for holes ingested before that feature was wired.
 *
 * This makes both readouts gracefully absent for holes without the data —
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

    // Extract green_slope sub-dict (optional — absent for older ingests).
    const rawSlope = props['green_slope'];
    let greenSlope: GreenSlope | null = null;
    if (
      rawSlope !== null &&
      rawSlope !== undefined &&
      typeof rawSlope === 'object' &&
      typeof (rawSlope as Record<string, unknown>)['direction'] === 'number' &&
      typeof (rawSlope as Record<string, unknown>)['percent_grade'] === 'number'
    ) {
      greenSlope = rawSlope as GreenSlope;
    }

    return { teeElevationFt, greenElevationFt, deltaFt, playsLikeYards, greenSlope };
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

// ── Green-slope display text ───────────────────────────────────────────────────

/**
 * Format a green-slope readout for the yardage-book info strip.
 *
 * Returns ``null`` when:
 *   - ``slope`` is null or undefined (not yet ingested)
 *   - slope severity is 'flat' (< 1% grade — not worth showing a direction)
 *
 * Otherwise returns a compact string in the form ``"green: 2.3% ↘ SE"``.
 * The percent grade is formatted to one decimal place.  The direction arrow
 * and compass label use the downhill bearing from the backend Sobel sampler.
 *
 * @param slope  GreenSlope from HoleElevation, or null/undefined.
 * @returns Formatted string or null (caller should not render when null).
 */
export function formatGreenSlope(slope: GreenSlope | null | undefined): string | null {
  if (!slope) return null;
  if (slope.severity === 'flat') return null;
  const label = degreesToCompassLabel(slope.direction);
  const arrow = compassLabelToArrow(label);
  const pct   = slope.percent_grade.toFixed(1);
  return `green: ${pct}% ${arrow} ${label}`;
}
