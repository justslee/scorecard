// Pure gesture core for the universal left-edge swipe-back
// (specs/universal-swipe-back-plan.md §5). No React, no DOM access in the
// decision functions — `BackSwipe.tsx` reads raw touch coordinates and hands
// them to these functions; `SwipeableRow.tsx` reuses `isEdgeStart` +
// `readSafeAreaLeft` to claim the edge zone for back-swipe instead of its
// own drag. Thresholds mirror the proven hole-swipe implementation
// (RoundPageClient.tsx's map-card touch handlers, ~L1802-1819).

export const EDGE_ZONE_PX = 24; // left-edge start zone (beyond safe-area inset)
export const MIN_DX_PX = 70; // matches the proven hole-swipe distance
export const HORIZONTAL_DOMINANCE = 1.8; // |dx| > 1.8 * |dy| — matches hole swipe
export const FLICK_MS = 600; // matches hole swipe time box
export const LONG_DRAG_FRACTION = 0.35; // slow deliberate drag: ≥35% of viewport width
export const REFIRE_LOCKOUT_MS = 350; // min gap between two triggered backs

/** Did the touch START inside the left-edge arming zone? */
export function isEdgeStart(startX: number, safeAreaLeft: number): boolean {
  return startX <= safeAreaLeft + EDGE_ZONE_PX;
}

export interface BackSwipeSample {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  elapsedMs: number;
  viewportWidth: number;
  safeAreaLeft: number;
}

export type BackSwipeDecision = 'back' | 'ignore';

/**
 * 'back' iff ALL of:
 *   - isEdgeStart(s.startX, s.safeAreaLeft)
 *   - dx = endX - startX > 0                          (rightward ONLY)
 *   - |dx| > HORIZONTAL_DOMINANCE * |dy|               (decisively horizontal)
 *   - AND ( (elapsedMs < FLICK_MS && dx >= MIN_DX_PX)              // fast flick
 *           || dx >= LONG_DRAG_FRACTION * viewportWidth )          // slow deliberate drag
 * else 'ignore'.
 *
 * Disqualifiers, summarized: started outside the edge zone; leftward;
 * vertical-dominant (early via `isDisqualified`, final via the dominance
 * ratio here); multi-touch/pinch at any point (handled by the caller before
 * this is invoked); too short and too slow (fails both the flick and the
 * long-drag arm).
 */
export function decideBackSwipe(s: BackSwipeSample): BackSwipeDecision {
  if (!isEdgeStart(s.startX, s.safeAreaLeft)) return 'ignore';

  const dx = s.endX - s.startX;
  const dy = s.endY - s.startY;
  if (dx <= 0) return 'ignore';
  if (Math.abs(dx) <= HORIZONTAL_DOMINANCE * Math.abs(dy)) return 'ignore';

  const fastFlick = s.elapsedMs < FLICK_MS && dx >= MIN_DX_PX;
  const longDrag = dx >= LONG_DRAG_FRACTION * s.viewportWidth;
  return fastFlick || longDrag ? 'back' : 'ignore';
}

/**
 * Mid-gesture early cancel: vertical scroll from the edge. `dy`/`dx` are the
 * deltas from the tracked touchstart to the current touchmove sample.
 */
export function isDisqualified(
  startX: number,
  startY: number,
  curX: number,
  curY: number
): boolean {
  const dx = Math.abs(curX - startX);
  const dy = Math.abs(curY - startY);
  return dy > 30 && dy > dx;
}

// ── The ONE impure, DOM-touching helper (guarded + memoized) ────────────────
//
// `viewportFit: "cover"` is set in app/layout.tsx's viewport export, so
// `env(safe-area-inset-left)` resolves to a real value. Read it once via a
// detached probe div (paddingLeft trick), cache it — portrait iPhone = 0,
// landscape notch side ≈ 59px. The pure functions above never touch the DOM;
// callers pass this number in.
let cachedSafeAreaLeft: number | null = null;

export function readSafeAreaLeft(): number {
  if (typeof document === 'undefined') return 0;
  if (cachedSafeAreaLeft !== null) return cachedSafeAreaLeft;

  const probe = document.createElement('div');
  probe.style.position = 'fixed';
  probe.style.top = '-9999px';
  probe.style.left = '-9999px';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  probe.style.paddingLeft = 'env(safe-area-inset-left)';
  document.body.appendChild(probe);
  const parsed = parseFloat(getComputedStyle(probe).paddingLeft);
  document.body.removeChild(probe);

  cachedSafeAreaLeft = Number.isFinite(parsed) ? parsed : 0;
  return cachedSafeAreaLeft;
}
