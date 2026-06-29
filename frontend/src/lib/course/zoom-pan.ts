/**
 * Pure math helpers for SVG viewBox-based zoom + pan on the hole diagram.
 *
 * Design notes
 * ------------
 * We manipulate the SVG `viewBox` attribute directly rather than applying a
 * CSS or <g> transform.  This keeps the SVG coordinate system intact so that
 * `getScreenCTM().inverse()` continues to work for the tap-to-measure feature.
 *
 * All functions are pure (no side-effects, no DOM) so they are testable in Node
 * without a browser environment.
 *
 * Coordinate conventions
 * ----------------------
 * - `ViewBox`  → { x, y, w, h } where (x, y) is the top-left corner of the
 *   visible region in SVG user-space units and (w, h) is its size.
 * - "fitted" viewBox = the initial viewBox that makes the full diagram visible
 *   (i.e. viewBox="0 0 svgWidth svgHeight").
 * - `minScale` = 1.0  (never zoom out beyond the fitted view)
 * - `maxScale`        (caller provides; recommended 4–6×)
 *
 * Touch gesture handling (used by the caller, not this file)
 * ----------------------------------------------------------
 * - 1-finger drag  → pan
 * - 2-finger pinch → zoom (anchor at pinch midpoint)
 * - double-tap     → reset to fitted viewBox
 * - tap (<8 px displacement) → pass through to tap-to-measure
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** The four numbers that define an SVG viewBox. */
export interface ViewBox {
  x: number;  // left edge in SVG user units
  y: number;  // top edge in SVG user units
  w: number;  // visible width in SVG user units
  h: number;  // visible height in SVG user units
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Distance between two touch points (Euclidean, in screen pixels).
 * Used to detect how far apart two fingers are for pinch gestures.
 */
export function pinchDist(
  t0: { clientX: number; clientY: number },
  t1: { clientX: number; clientY: number }
): number {
  const dx = t1.clientX - t0.clientX;
  const dy = t1.clientY - t0.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Midpoint between two touch points (in screen pixels).
 * This is the zoom anchor: the SVG point under the midpoint stays fixed.
 */
export function pinchMidpoint(
  t0: { clientX: number; clientY: number },
  t1: { clientX: number; clientY: number }
): { clientX: number; clientY: number } {
  return {
    clientX: (t0.clientX + t1.clientX) / 2,
    clientY: (t0.clientY + t1.clientY) / 2,
  };
}

// ── Core transforms ───────────────────────────────────────────────────────────

/**
 * Apply a pinch gesture to the viewBox.
 *
 * @param vb         Current viewBox
 * @param anchorSvg  The SVG-space point that must remain fixed under the
 *                   pinch midpoint (convert screen→SVG before calling)
 * @param scale      Ratio of new finger distance / old finger distance (> 1 = zoom in)
 * @param fitted     The initial fitted ViewBox (used for min/max scale clamping)
 * @param maxScale   Maximum zoom factor relative to the fitted viewBox (e.g. 5)
 * @returns New viewBox (not yet clamped to the fitted bounds)
 */
export function applyPinch(
  vb: ViewBox,
  anchorSvg: { x: number; y: number },
  scale: number,
  fitted: ViewBox,
  maxScale: number
): ViewBox {
  // New dimensions (clamp so we never exceed the scale range)
  const minW = fitted.w / maxScale;
  const maxW = fitted.w;          // minScale = 1 → w = fitted.w

  let newW = vb.w / scale;
  let newH = vb.h / scale;

  // Clamp width, derive proportional height
  if (newW < minW) {
    const clampRatio = minW / newW;
    newW = minW;
    newH = newH * clampRatio;
  } else if (newW > maxW) {
    const clampRatio = maxW / newW;
    newW = maxW;
    newH = newH * clampRatio;
  }

  // Shift so that anchorSvg.x remains at the same fraction of the width
  const fracX = (anchorSvg.x - vb.x) / vb.w;
  const fracY = (anchorSvg.y - vb.y) / vb.h;
  const newX = anchorSvg.x - fracX * newW;
  const newY = anchorSvg.y - fracY * newH;

  return { x: newX, y: newY, w: newW, h: newH };
}

/**
 * Apply a pan (drag) gesture to the viewBox.
 *
 * @param vb      Current viewBox
 * @param deltaSvg Delta in SVG user-space units (convert screen px → SVG before calling)
 * @returns New viewBox (not yet clamped to fitted bounds)
 */
export function applyPan(
  vb: ViewBox,
  deltaSvg: { dx: number; dy: number }
): ViewBox {
  return {
    x: vb.x - deltaSvg.dx,
    y: vb.y - deltaSvg.dy,
    w: vb.w,
    h: vb.h,
  };
}

/**
 * Clamp a viewBox so it never scrolls outside the fitted (original) view.
 *
 * Rules:
 * - Width/height are already clamped by `applyPinch`; we only clamp position here.
 * - If the visible window is smaller than the fitted view on a given axis, clamp
 *   so the window never goes outside the fitted region.
 * - If the visible window equals the fitted size (scale = 1), snap x/y to fitted.
 *
 * @param vb     ViewBox to clamp
 * @param fitted The initial fitted ViewBox (defines the legal area)
 * @returns Clamped viewBox
 */
export function clampViewBox(vb: ViewBox, fitted: ViewBox): ViewBox {
  const fRight  = fitted.x + fitted.w;
  const fBottom = fitted.y + fitted.h;

  // Left edge: never let the right edge of vb go past fRight
  const maxX = fRight - vb.w;
  const minX = fitted.x;
  const clampedX = Math.max(minX, Math.min(maxX, vb.x));

  // Top edge
  const maxY = fBottom - vb.h;
  const minY = fitted.y;
  const clampedY = Math.max(minY, Math.min(maxY, vb.y));

  return { x: clampedX, y: clampedY, w: vb.w, h: vb.h };
}

/**
 * Compute the current zoom scale relative to the fitted (1×) viewBox.
 * Returns 1.0 when fully zoomed out, maxScale when fully zoomed in.
 */
export function currentScale(vb: ViewBox, fitted: ViewBox): number {
  // A smaller viewBox window = zoomed in → higher scale
  return fitted.w / vb.w;
}

/**
 * Convert a viewBox to the SVG `viewBox` attribute string.
 */
export function viewBoxAttr(vb: ViewBox): string {
  return `${vb.x} ${vb.y} ${vb.w} ${vb.h}`;
}
