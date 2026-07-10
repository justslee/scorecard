/**
 * Slide-to-edit drag math for a tee-time window's track — pure functions, no
 * DOM/React, so the gesture logic is unit-testable without a browser.
 *
 * The track spans one day, 06:00–21:00, in 30-minute steps. A window is a
 * [start, end] pair inside that range with a 1h floor and no practical
 * ceiling (it can span the full track) — it can never cross midnight because
 * the track itself never leaves the day.
 */

/** Track domain, in minutes-since-midnight. */
export const TRACK_START_MIN = 6 * 60;
export const TRACK_END_MIN = 21 * 60;
/** Snap grid. */
export const STEP_MIN = 30;
/** A window can't be shorter than 1h; the ceiling is the full track (no
 *  practical cap — a golfer can widen a window across the whole day). */
export const MIN_WINDOW_MIN = 60;
export const MAX_WINDOW_MIN = TRACK_END_MIN - TRACK_START_MIN;

/** How close (in minutes) a grab has to be to an edge to grab THAT edge
 *  instead of the band — generous so small handle pills stay easy to grab. */
const EDGE_BIAS_MIN = 45;

/** "06:30" → 390. */
export function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

/** 390 → "06:30" — clamped to a real time-of-day and rounded to the minute. */
export function minToHhmm(min: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * A track-relative fraction (0..1, e.g. pointer x / track width) → a snapped,
 * clamped minute value inside the track domain.
 */
export function fracToMin(frac: number): number {
  const clampedFrac = Math.max(0, Math.min(1, frac));
  const raw = TRACK_START_MIN + clampedFrac * (TRACK_END_MIN - TRACK_START_MIN);
  const snapped = Math.round(raw / STEP_MIN) * STEP_MIN;
  return Math.max(TRACK_START_MIN, Math.min(TRACK_END_MIN, snapped));
}

/** The inverse of fracToMin — a minute value → its position on the track (0..1). */
export function minToFrac(min: number): number {
  const clamped = Math.max(TRACK_START_MIN, Math.min(TRACK_END_MIN, min));
  return (clamped - TRACK_START_MIN) / (TRACK_END_MIN - TRACK_START_MIN);
}

/** Which part of the window a pointer-down grabbed. */
export type Handle = "start" | "end" | "band";

/**
 * Decide what a grab at `frac` picked up: the nearer edge when it's within
 * EDGE_BIAS_MIN of it (so small handle pills are easy to grab even a little
 * off-target), the band when it's between the edges, or — for a grab OUTSIDE
 * the window entirely — whichever edge is nearer (dragging past the current
 * end widens the window from that edge).
 */
export function pickHandle(frac: number, startMin: number, endMin: number): Handle {
  const grabMin = TRACK_START_MIN + Math.max(0, Math.min(1, frac)) * (TRACK_END_MIN - TRACK_START_MIN);
  const dStart = Math.abs(grabMin - startMin);
  const dEnd = Math.abs(grabMin - endMin);

  if (grabMin >= startMin && grabMin <= endMin) {
    if (dStart <= EDGE_BIAS_MIN && dStart <= dEnd) return "start";
    if (dEnd <= EDGE_BIAS_MIN && dEnd < dStart) return "end";
    return "band";
  }
  return dStart <= dEnd ? "start" : "end";
}

export interface DragResult {
  start: number;
  end: number;
}

/**
 * Apply a drag at track position `frac` to a window, given which handle was
 * grabbed. Always clamped + snapped; start/end can never cross (min 1h gap),
 * a window can never exceed 6h, and neither edge can leave the track (so no
 * midnight crossing — the domain itself never reaches midnight).
 *
 * `grabOffsetMin` is the (start,end)-invariant offset between the pointer's
 * initial grab point and the window's start, captured once at pointer-down —
 * it's what lets a BAND drag keep the pointer "attached" to where it grabbed
 * rather than snapping the window's start straight under the pointer.
 */
export function applyDrag(
  handle: Handle,
  frac: number,
  startMin: number,
  endMin: number,
  grabOffsetMin: number = 0,
): DragResult {
  const pointerMin = fracToMin(frac);

  if (handle === "start") {
    const lower = Math.max(TRACK_START_MIN, endMin - MAX_WINDOW_MIN);
    const upper = endMin - MIN_WINDOW_MIN;
    const start = Math.max(lower, Math.min(upper, pointerMin));
    return { start, end: endMin };
  }

  if (handle === "end") {
    const lower = startMin + MIN_WINDOW_MIN;
    const upper = Math.min(TRACK_END_MIN, startMin + MAX_WINDOW_MIN);
    const end = Math.max(lower, Math.min(upper, pointerMin));
    return { start: startMin, end };
  }

  // "band" — translate the whole window, preserving its length, clamped so
  // neither edge can leave the track.
  const length = endMin - startMin;
  const rawStart = pointerMin - grabOffsetMin;
  const snappedStart = Math.round(rawStart / STEP_MIN) * STEP_MIN;
  const start = Math.max(TRACK_START_MIN, Math.min(TRACK_END_MIN - length, snappedStart));
  return { start, end: start + length };
}
