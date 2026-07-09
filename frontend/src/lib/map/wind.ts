// Per-hole wind math for the round tiles (owner 2026-07-07: the Wind/Elev
// tiles were HARDCODED "6mph R→L / +3ft uphill" on every hole — a no-fake-data
// violation). Real weather (speed, direction, gusts) + the hole's real
// tee→green bearing → an honest relative-wind label and a conservative
// wind-adjusted plays-like. Pure and unit-tested.

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Initial great-circle bearing from → to, degrees clockwise from north. */
export function bearingDeg(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
): number {
  const φ1 = rad(from.lat);
  const φ2 = rad(to.lat);
  const Δλ = rad(to.lng - from.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export interface RelativeWind {
  /** Short tile label, e.g. "R→L", "into", "help·L→R", "calm". */
  label: string;
  /** Along-hole component in mph. Positive = headwind (into), negative = tail. */
  headMph: number;
}

/**
 * Relative wind for a hole. `windFromDeg` is meteorological (the direction
 * the wind comes FROM); the wind travels toward `windFromDeg + 180`.
 * Cross labels are from the golfer's view standing on the tee facing the
 * green: wind blowing toward the right of the line of play = "L→R".
 */
export function relativeWind(
  windFromDeg: number,
  holeBearingDeg: number,
  speedMph: number
): RelativeWind {
  if (speedMph < 2) return { label: "calm", headMph: 0 };
  const towardDeg = (windFromDeg + 180) % 360;
  const delta = rad(((towardDeg - holeBearingDeg) % 360 + 360) % 360);
  // Along-hole: cos(delta)=1 means blowing the same way as play → tailwind.
  const headMph = -Math.cos(delta) * speedMph;
  // Cross: sin(delta)>0 means blowing toward the right of play → L→R.
  const crossMph = Math.sin(delta) * speedMph;

  const head = Math.abs(headMph);
  const cross = Math.abs(crossMph);
  const crossLabel = crossMph > 0 ? "L→R" : "R→L";
  const alongLabel = headMph > 0 ? "into" : "help";

  let label: string;
  if (head >= cross * 2.4) label = alongLabel; // within ~22.5° of the axis
  else if (cross >= head * 2.4) label = crossLabel;
  else label = `${alongLabel}·${crossLabel}`;
  return { label, headMph: Math.round(headMph * 10) / 10 };
}

/**
 * Conservative wind-adjusted plays-like distance. Headwind hurts more than
 * tailwind helps (standard ball-flight asymmetry): +0.8%/mph into, −0.5%/mph
 * helping, clamped to ±15%. Rounded to the yard.
 *
 * @deprecated Display-only heuristic for the round tiles. Any ADVICE-grade
 * plays-like number now comes from the backend ball-flight physics engine
 * (backend/app/caddie/physics.py via the `get_shot_distance` tool /
 * POST /caddie/session/shot-distance) — do not use this for caddie advice,
 * and do not extend it (specs/caddie-shot-physics-engine-plan.md step 12; a
 * follow-up slice points the tiles at the backend number too).
 */
export function playsLikeYards(distanceYds: number, headMph: number): number {
  const factor =
    headMph >= 0 ? 1 + Math.min(0.15, 0.008 * headMph) : 1 - Math.min(0.15, 0.005 * -headMph);
  return Math.round(distanceYds * factor);
}

/** Compass point ("N", "NE", …) for a meteorological from-direction. */
export function compassFrom(windFromDeg: number): string {
  const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return points[Math.round((((windFromDeg % 360) + 360) % 360) / 45) % 8];
}
