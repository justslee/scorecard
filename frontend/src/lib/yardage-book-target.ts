/**
 * Pure geometry helpers for the yardage book's draggable aim target
 * (`HoleIllustration.tsx`). Mirrors the satellite map's `tapTargetDistances`
 * pattern (`frontend/src/lib/map/google-map-helpers.ts`): a SINGLE
 * arg-building seam so the live-drag readout and the settled readout always
 * compute identically. No DOM, no React — safe to unit test in Node.
 *
 * The book's `HOLES` geometry is an ABSTRACT, non-georeferenced polyline in
 * normalized [0,1] units, scaled to a single fixed `hole.yards` total. There
 * is no real lat/lng under this diagram, so all "distance" here is a
 * geometric estimate, not a GPS measurement — see the rounding note below.
 */

import type { PathPoint } from "./hole-shot-point";

/**
 * Total length of a polyline, summing the euclidean distance between each
 * consecutive pair of points, in the path's own normalized [0,1] units.
 */
export function pathArcLength(path: PathPoint[]): number {
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const [x1, y1] = path[i];
    const [x2, y2] = path[i + 1];
    total += Math.hypot(x2 - x1, y2 - y1);
  }
  return total;
}

/**
 * Yards-per-normalized-unit, derived from the path's ARC length (not the
 * straight-line tee→green distance). A scorecard's `hole.yards` is measured
 * along the dogleg centerline, so scaling off the arc length is the honest
 * mapping — a straight hole's tee→green euclidean distance then equals
 * `hole.yards` exactly. Returns 0 for a degenerate (zero-length) path so
 * callers never divide by zero / produce NaN.
 */
export function bookYardsPerUnit(yards: number, path: PathPoint[]): number {
  const arc = pathArcLength(path);
  return arc > 0 ? yards / arc : 0;
}

function euclidean(a: PathPoint, b: PathPoint): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * Round to the nearest 5 yards. The book's numbers are interpolated off an
 * abstract, hand-drawn schematic, not a GPS fix — nearest-1 precision would
 * be a lie of precision. Nearest-5 reads like a caddie's "call it 215"
 * (matches the satellite map's nearest-1, which IS measuring real lat/lng —
 * the two surfaces are deliberately different kinds of number).
 */
export function round5(yards: number): number {
  return Math.round(yards / 5) * 5;
}

export interface BookTargetDistances {
  /** Yards from the tee (origin, always) to the dragged point. */
  toTarget: number;
  /** Yards from the dragged point to the green. */
  toGreen: number;
}

/**
 * Distances for a point dragged on the book's hole diagram: from-tee and
 * to-green, both euclidean (straight-line) and both rounded to the nearest 5.
 *
 * This is the ONE arg-building seam for BOTH the live-drag tick and the
 * settled state — the book-side analogue of the map's `tapTargetDistances`
 * Item-4 contract. Never compute these numbers a second way elsewhere.
 *
 * NOTE — doglegs deliberately don't sum to `yards`: `toTarget + toGreen` is
 * two euclidean legs (tee→point, point→green), which cut the corner of a
 * bent fairway rather than following its centerline. That's intentional and
 * arguably honest — a target placed across a dogleg genuinely IS a shorter
 * line than the printed yardage. Do not "fix" this by forcing the legs to
 * sum; see `pathArcLength`/`bookYardsPerUnit` for the scale derivation.
 */
export function bookTargetDistances(
  point: PathPoint,
  path: PathPoint[],
  yards: number,
): BookTargetDistances {
  if (path.length === 0) return { toTarget: 0, toGreen: 0 };
  const tee = path[0];
  const green = path[path.length - 1];
  const ypu = bookYardsPerUnit(yards, path);
  return {
    toTarget: round5(euclidean(point, tee) * ypu),
    toGreen: round5(euclidean(point, green) * ypu),
  };
}

/**
 * Clamp a point to the diagram's paper bounds, inset from the edges so the
 * reticle can never be dragged fully off-canvas. `inset` and coordinates are
 * in the path's normalized [0,1] units.
 */
export function clampToDiagram(p: PathPoint, inset = 0.04): PathPoint {
  const lo = inset;
  const hi = 1 - inset;
  return [Math.min(hi, Math.max(lo, p[0])), Math.min(hi, Math.max(lo, p[1]))];
}
