/**
 * wind-relative.ts — pure trig helper to classify wind direction relative to a shot bearing.
 *
 * Sign conventions (meteorological + golf):
 *   windFromDeg   — direction the wind comes FROM, in degrees (0=N, 90=E, 180=S, 270=W).
 *   shotBearingDeg — direction the player shoots TOWARD, in degrees (same compass).
 *
 * Derived angle:
 *   relativeAngle = normalize(windFromDeg - shotBearingDeg) → (-180, 180]
 *
 *   relativeAngle =   0 → wind comes FROM straight ahead  → headwind  (cos = +1)
 *   relativeAngle = 180 → wind comes FROM behind           → tailwind  (cos = -1)
 *   relativeAngle = +90 → wind comes FROM the right        → crosswind pushing ball left (R→L)
 *   relativeAngle = -90 → wind comes FROM the left         → crosswind pushing ball right (L→R)
 *
 * Components:
 *   headTailMph = cos(relativeAngle) * windSpeedMph   (+= headwind, -= tailwind)
 *   crossMph    = |sin(relativeAngle) * windSpeedMph| (unsigned magnitude)
 *   side        = 'R' when sin > 0 (from right), 'L' when sin < 0 (from left)
 *
 * Classification uses absolute angle thresholds in 30° increments:
 *   |rel| < 30°              → head
 *   30° ≤ |rel| ≤ 60°       → head-cross
 *   60° < |rel| < 120°      → cross
 *   120° ≤ |rel| ≤ 150°     → tail-cross
 *   |rel| > 150°             → tail
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type WindKind = 'head' | 'tail' | 'cross' | 'head-cross' | 'tail-cross';

export interface WindRelativeResult {
  /** Broad classification relative to shot direction. */
  kind: WindKind;
  /**
   * Which side the wind comes FROM (only present for cross-component kinds).
   * 'R' = from the right (pushes ball left, R→L); 'L' = from the left (L→R).
   */
  side?: 'L' | 'R';
  /** Head/tail component (mph). Positive = headwind, negative = tailwind. */
  headTailMph: number;
  /** Cross component (mph), unsigned magnitude. */
  crossMph: number;
  /** Human-readable label for the indicator, e.g. "Crosswind 12 mph · R→L". */
  label: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Bring an arbitrary degree angle into (-180, 180] using true modulo (not JS remainder).
 */
function normalizeAngle(deg: number): number {
  // ((a % n) + n) % n maps any real into [0, n). Then shift by 180.
  const r = ((deg % 360) + 360) % 360; // → [0, 360)
  return r > 180 ? r - 360 : r;        // → (-180, 180]
}

/**
 * Build the human-readable label from the classification result.
 * Speed shown is total wind speed to match what the golfer knows.
 */
function buildLabel(
  kind: WindKind,
  side: 'L' | 'R' | undefined,
  windSpeedMph: number
): string {
  const mph = `${Math.round(windSpeedMph)} mph`;
  const pushArrow = side === 'R' ? 'R→L' : side === 'L' ? 'L→R' : '';

  switch (kind) {
    case 'head':
      return `Headwind ${mph}`;
    case 'tail':
      return `Tailwind ${mph}`;
    case 'cross':
      return `Crosswind ${mph}${pushArrow ? ` · ${pushArrow}` : ''}`;
    case 'head-cross':
      return `Into + ${pushArrow || 'cross'} ${mph}`;
    case 'tail-cross':
      return `Down + ${pushArrow || 'cross'} ${mph}`;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify wind direction and magnitude relative to a shot bearing.
 *
 * @param windFromDeg   Direction the wind comes FROM, in degrees (0–360).
 * @param windSpeedMph  Wind speed in mph (must be > 0; returns calm sentinel at 0).
 * @param shotBearingDeg Direction the player shoots toward, in degrees (0–360).
 * @returns WindRelativeResult with components, classification, side, and a display label.
 */
export function windRelativeToShot(
  windFromDeg: number,
  windSpeedMph: number,
  shotBearingDeg: number
): WindRelativeResult {
  // Zero/calm wind — return a safe, labelless sentinel rather than NaN components.
  if (windSpeedMph <= 0) {
    return { kind: 'head', headTailMph: 0, crossMph: 0, label: 'Calm' };
  }

  const relDeg = normalizeAngle(windFromDeg - shotBearingDeg);
  const relRad = (relDeg * Math.PI) / 180;

  const headTailMph = Math.cos(relRad) * windSpeedMph;
  const crossSigned = Math.sin(relRad) * windSpeedMph;
  const crossMph = Math.abs(crossSigned);

  // Assign side only when crosswind is significant (≥ 0.5 mph avoids float noise).
  const side: 'L' | 'R' | undefined =
    crossMph >= 0.5 ? (crossSigned > 0 ? 'R' : 'L') : undefined;

  const absAngle = Math.abs(relDeg);
  let kind: WindKind;
  if (absAngle < 30) {
    kind = 'head';
  } else if (absAngle <= 60) {
    kind = 'head-cross';
  } else if (absAngle < 120) {
    kind = 'cross';
  } else if (absAngle <= 150) {
    kind = 'tail-cross';
  } else {
    kind = 'tail';
  }

  const label = buildLabel(kind, side, windSpeedMph);

  return { kind, side, headTailMph, crossMph, label };
}
