/**
 * Unit tests for zoom-pan.ts
 *
 * Pure math — no DOM, no browser APIs.
 * Runs headlessly in Node via Vitest.
 */

import { describe, it, expect } from 'vitest';
import {
  pinchDist,
  pinchMidpoint,
  applyPinch,
  applyPan,
  clampViewBox,
  currentScale,
  viewBoxAttr,
  type ViewBox,
} from './zoom-pan';

// ── Shared fixture ─────────────────────────────────────────────────────────────

// SVG canvas: 400 × 800 px (portrait, like our hole diagram)
const FITTED: ViewBox = { x: 0, y: 0, w: 400, h: 800 };
const MAX_SCALE = 5;

// ── pinchDist ──────────────────────────────────────────────────────────────────

describe('pinchDist', () => {
  it('returns 0 for the same point', () => {
    expect(pinchDist({ clientX: 10, clientY: 20 }, { clientX: 10, clientY: 20 })).toBe(0);
  });

  it('3-4-5 right triangle → distance = 5', () => {
    const d = pinchDist({ clientX: 0, clientY: 0 }, { clientX: 3, clientY: 4 });
    expect(d).toBeCloseTo(5, 8);
  });

  it('is symmetric', () => {
    const a = { clientX: 10, clientY: 30 };
    const b = { clientX: 40, clientY: 70 };
    expect(pinchDist(a, b)).toBeCloseTo(pinchDist(b, a), 8);
  });
});

// ── pinchMidpoint ──────────────────────────────────────────────────────────────

describe('pinchMidpoint', () => {
  it('midpoint of same point is that point', () => {
    const m = pinchMidpoint({ clientX: 5, clientY: 10 }, { clientX: 5, clientY: 10 });
    expect(m.clientX).toBe(5);
    expect(m.clientY).toBe(10);
  });

  it('midpoint of (0,0) and (10,20) is (5,10)', () => {
    const m = pinchMidpoint({ clientX: 0, clientY: 0 }, { clientX: 10, clientY: 20 });
    expect(m.clientX).toBe(5);
    expect(m.clientY).toBe(10);
  });

  it('is symmetric', () => {
    const a = { clientX: 30, clientY: 40 };
    const b = { clientX: 70, clientY: 90 };
    const m1 = pinchMidpoint(a, b);
    const m2 = pinchMidpoint(b, a);
    expect(m1.clientX).toBeCloseTo(m2.clientX, 8);
    expect(m1.clientY).toBeCloseTo(m2.clientY, 8);
  });
});

// ── applyPinch ─────────────────────────────────────────────────────────────────

describe('applyPinch', () => {
  it('scale=1 leaves the viewBox unchanged', () => {
    const anchor = { x: 200, y: 400 };  // centre of fitted
    const result = applyPinch(FITTED, anchor, 1, FITTED, MAX_SCALE);
    expect(result.w).toBeCloseTo(FITTED.w, 5);
    expect(result.h).toBeCloseTo(FITTED.h, 5);
    expect(result.x).toBeCloseTo(FITTED.x, 5);
    expect(result.y).toBeCloseTo(FITTED.y, 5);
  });

  it('scale=2 from centre halves the window size', () => {
    const anchor = { x: 200, y: 400 };  // centre of fitted
    const result = applyPinch(FITTED, anchor, 2, FITTED, MAX_SCALE);
    expect(result.w).toBeCloseTo(200, 5);  // 400 / 2
    expect(result.h).toBeCloseTo(400, 5);  // 800 / 2
  });

  it('scale=2 from centre keeps anchor at the same fractional position', () => {
    const anchor = { x: 200, y: 400 };
    const result = applyPinch(FITTED, anchor, 2, FITTED, MAX_SCALE);
    // anchor was at fraction (0.5, 0.5) of FITTED; should stay at (0.5, 0.5) of result
    expect((anchor.x - result.x) / result.w).toBeCloseTo(0.5, 5);
    expect((anchor.y - result.y) / result.h).toBeCloseTo(0.5, 5);
  });

  it('zoom in from a non-centre anchor preserves anchor fraction', () => {
    // Anchor at top-left quadrant: (100, 200) = fraction (0.25, 0.25)
    const anchor = { x: 100, y: 200 };
    const result = applyPinch(FITTED, anchor, 3, FITTED, MAX_SCALE);
    expect((anchor.x - result.x) / result.w).toBeCloseTo(0.25, 5);
    expect((anchor.y - result.y) / result.h).toBeCloseTo(0.25, 5);
  });

  it('clamps to fitted size at scale < 1 (zoom-out attempt)', () => {
    // Start at 2× zoom, then try to zoom out past 1×
    const zoomed: ViewBox = { x: 100, y: 200, w: 200, h: 400 };
    const anchor = { x: 200, y: 400 };
    // scale = 0.3 would try to set w = 200 / 0.3 ≈ 667, but max is FITTED.w = 400
    const result = applyPinch(zoomed, anchor, 0.3, FITTED, MAX_SCALE);
    expect(result.w).toBeCloseTo(FITTED.w, 5);
    expect(result.h).toBeCloseTo(FITTED.h, 5);
  });

  it('clamps to minW at max-scale zoom-in', () => {
    // MAX_SCALE = 5, so minW = 400 / 5 = 80
    const anchor = { x: 200, y: 400 };
    // Attempt to zoom in 10× (beyond maxScale)
    const result = applyPinch(FITTED, anchor, 10, FITTED, MAX_SCALE);
    expect(result.w).toBeCloseTo(FITTED.w / MAX_SCALE, 5);
  });
});

// ── applyPan ───────────────────────────────────────────────────────────────────

describe('applyPan', () => {
  it('zero delta leaves the viewBox unchanged', () => {
    const result = applyPan(FITTED, { dx: 0, dy: 0 });
    expect(result).toEqual(FITTED);
  });

  it('pan right by 50 px moves x up by 50 (view shifts left)', () => {
    // User drags RIGHT by 50 px → the viewBox origin moves LEFT (x increases)
    // In our implementation deltaSvg.dx is the finger delta in SVG units;
    // dragging right means the content should shift right, so vb.x decreases.
    // (caller converts screen→SVG and provides signed delta)
    const result = applyPan(FITTED, { dx: 50, dy: 0 });
    expect(result.x).toBe(-50);
    expect(result.y).toBe(0);
    expect(result.w).toBe(FITTED.w);
    expect(result.h).toBe(FITTED.h);
  });

  it('pan down by 30 px shifts y', () => {
    const result = applyPan(FITTED, { dx: 0, dy: 30 });
    expect(result.x).toBe(0);
    expect(result.y).toBe(-30);
  });

  it('pan does not change width or height', () => {
    const vb: ViewBox = { x: 100, y: 100, w: 200, h: 400 };
    const result = applyPan(vb, { dx: 77, dy: -33 });
    expect(result.w).toBe(200);
    expect(result.h).toBe(400);
  });
});

// ── clampViewBox ───────────────────────────────────────────────────────────────

describe('clampViewBox', () => {
  it('fitted viewBox clamps to itself', () => {
    const result = clampViewBox(FITTED, FITTED);
    expect(result).toEqual(FITTED);
  });

  it('does not clamp a valid in-bounds zoomed+panned viewBox', () => {
    // 2× zoom, panned to top-left: x=0, y=0, w=200, h=400
    const vb: ViewBox = { x: 0, y: 0, w: 200, h: 400 };
    const result = clampViewBox(vb, FITTED);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });

  it('clamps x when panned too far left (x < fitted.x)', () => {
    // Zoomed 2×, then panned so x = -50 (out of bounds)
    const vb: ViewBox = { x: -50, y: 0, w: 200, h: 400 };
    const result = clampViewBox(vb, FITTED);
    expect(result.x).toBe(0);  // clamped to fitted.x
  });

  it('clamps x when panned too far right (right edge > fitted right edge)', () => {
    // 2× zoom (w=200), panned so x = 250 → right edge = 450 > 400
    const vb: ViewBox = { x: 250, y: 0, w: 200, h: 400 };
    const result = clampViewBox(vb, FITTED);
    // maxX = fitted.x + fitted.w - vb.w = 0 + 400 - 200 = 200
    expect(result.x).toBe(200);
  });

  it('clamps y when panned too far up (y < fitted.y)', () => {
    const vb: ViewBox = { x: 0, y: -100, w: 200, h: 400 };
    const result = clampViewBox(vb, FITTED);
    expect(result.y).toBe(0);
  });

  it('clamps y when panned too far down', () => {
    // 2× zoom (h=400), panned y = 500 → bottom = 900 > 800
    const vb: ViewBox = { x: 0, y: 500, w: 200, h: 400 };
    const result = clampViewBox(vb, FITTED);
    // maxY = fitted.y + fitted.h - vb.h = 0 + 800 - 400 = 400
    expect(result.y).toBe(400);
  });

  it('preserves width and height', () => {
    const vb: ViewBox = { x: -999, y: -999, w: 200, h: 400 };
    const result = clampViewBox(vb, FITTED);
    expect(result.w).toBe(200);
    expect(result.h).toBe(400);
  });

  it('clamps both axes simultaneously', () => {
    const vb: ViewBox = { x: -100, y: -200, w: 200, h: 400 };
    const result = clampViewBox(vb, FITTED);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });
});

// ── currentScale ───────────────────────────────────────────────────────────────

describe('currentScale', () => {
  it('fitted viewBox → scale = 1', () => {
    expect(currentScale(FITTED, FITTED)).toBe(1);
  });

  it('viewBox half the fitted width → scale = 2', () => {
    const vb: ViewBox = { x: 100, y: 200, w: 200, h: 400 };
    expect(currentScale(vb, FITTED)).toBe(2);
  });

  it('viewBox one-fifth the fitted width → scale = 5', () => {
    const vb: ViewBox = { x: 160, y: 320, w: 80, h: 160 };
    expect(currentScale(vb, FITTED)).toBe(5);
  });
});

// ── viewBoxAttr ────────────────────────────────────────────────────────────────

describe('viewBoxAttr', () => {
  it('formats integer viewBox correctly', () => {
    expect(viewBoxAttr({ x: 0, y: 0, w: 400, h: 800 })).toBe('0 0 400 800');
  });

  it('formats floating-point viewBox correctly', () => {
    expect(viewBoxAttr({ x: 1.5, y: 2.5, w: 200.25, h: 400.75 }))
      .toBe('1.5 2.5 200.25 400.75');
  });

  it('handles negative x/y for panned views', () => {
    expect(viewBoxAttr({ x: -10, y: -20, w: 200, h: 400 }))
      .toBe('-10 -20 200 400');
  });
});

// ── Integration: pinch then clamp ─────────────────────────────────────────────

describe('applyPinch + clampViewBox integration', () => {
  it('2× zoom from centre then clamp stays within fitted bounds', () => {
    const anchor = { x: 200, y: 400 };
    const pinched = applyPinch(FITTED, anchor, 2, FITTED, MAX_SCALE);
    const clamped = clampViewBox(pinched, FITTED);
    // x = 200 - 0.5 * 200 = 100; y = 400 - 0.5 * 400 = 200
    expect(clamped.x).toBeGreaterThanOrEqual(FITTED.x);
    expect(clamped.y).toBeGreaterThanOrEqual(FITTED.y);
    expect(clamped.x + clamped.w).toBeLessThanOrEqual(FITTED.x + FITTED.w + 0.001);
    expect(clamped.y + clamped.h).toBeLessThanOrEqual(FITTED.y + FITTED.h + 0.001);
  });

  it('pan after zoom then clamp stays within fitted bounds', () => {
    const anchor = { x: 200, y: 400 };
    const pinched = applyPinch(FITTED, anchor, 3, FITTED, MAX_SCALE);
    // Pan hard to the left (far out of bounds)
    const panned = applyPan(pinched, { dx: -999, dy: -999 });
    const clamped = clampViewBox(panned, FITTED);
    expect(clamped.x).toBeGreaterThanOrEqual(FITTED.x);
    expect(clamped.y).toBeGreaterThanOrEqual(FITTED.y);
    expect(clamped.x + clamped.w).toBeLessThanOrEqual(FITTED.x + FITTED.w + 0.001);
    expect(clamped.y + clamped.h).toBeLessThanOrEqual(FITTED.y + FITTED.h + 0.001);
  });
});
