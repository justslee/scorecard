/**
 * Unit tests for windRelativeToShot (lib/caddie/wind-relative.ts).
 *
 * Runs headless (no React, no browser) via vitest node environment.
 *
 * Sign conventions under test:
 *   windFromDeg    — direction wind comes FROM (0=N, 90=E, 180=S, 270=W)
 *   shotBearingDeg — direction player shoots TOWARD (same compass)
 *   relativeAngle  = normalize(windFromDeg - shotBearingDeg)
 *     0   → headwind  (cos= +1, headTailMph > 0)
 *     180 → tailwind  (cos= -1, headTailMph < 0)
 *    +90  → from right → crossMph > 0, side='R', pushes ball L (R→L)
 *    -90  → from left  → crossMph > 0, side='L', pushes ball R (L→R)
 *
 * DO NOT modify wind-relative.ts to make tests pass; fix the logic.
 */

import { describe, it, expect } from 'vitest';
import { windRelativeToShot } from './wind-relative';

// Tolerance for floating-point component values
const EPSILON = 0.01;

// ---------------------------------------------------------------------------
// Zero wind speed
// ---------------------------------------------------------------------------

describe('windRelativeToShot — zero wind speed', () => {
  it('returns calm sentinel with zero components', () => {
    const r = windRelativeToShot(90, 0, 0);
    expect(r.headTailMph).toBe(0);
    expect(r.crossMph).toBe(0);
    expect(r.label).toBe('Calm');
  });

  it('negative wind speed also returns calm sentinel', () => {
    const r = windRelativeToShot(90, -5, 0);
    expect(r.headTailMph).toBe(0);
    expect(r.crossMph).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pure headwind
// ---------------------------------------------------------------------------

describe('windRelativeToShot — pure headwind', () => {
  it('wind from due north, shot bearing north → headwind', () => {
    const r = windRelativeToShot(0, 12, 0);
    expect(r.kind).toBe('head');
    expect(r.headTailMph).toBeCloseTo(12, 1);
    expect(r.crossMph).toBeCloseTo(0, 1);
    expect(r.side).toBeUndefined();
    expect(r.label).toBe('Headwind 12 mph');
  });

  it('wind from east, shot bearing east → headwind regardless of compass direction', () => {
    const r = windRelativeToShot(90, 10, 90);
    expect(r.kind).toBe('head');
    expect(r.headTailMph).toBeCloseTo(10, 1);
    expect(r.crossMph).toBeCloseTo(0, 1);
  });
});

// ---------------------------------------------------------------------------
// Pure tailwind
// ---------------------------------------------------------------------------

describe('windRelativeToShot — pure tailwind', () => {
  it('wind FROM south (180°), shot bearing north (0°) → tailwind', () => {
    // relativeAngle = 180 - 0 = 180 → cos(180)=-1 → headTailMph=-12 (negative = tail)
    const r = windRelativeToShot(180, 12, 0);
    expect(r.kind).toBe('tail');
    expect(r.headTailMph).toBeCloseTo(-12, 1);
    expect(r.crossMph).toBeCloseTo(0, 1);
    expect(r.side).toBeUndefined();
    expect(r.label).toBe('Tailwind 12 mph');
  });

  it('wind FROM 45° behind shot bearing → tail (relativeAngle > 150°)', () => {
    // windFromDeg=225, bearing=45: relAngle=180 → tail
    const r = windRelativeToShot(225, 8, 45);
    expect(r.kind).toBe('tail');
    expect(r.headTailMph).toBeCloseTo(-8, 1);
  });
});

// ---------------------------------------------------------------------------
// Pure crosswind — from right (R→L push)
// ---------------------------------------------------------------------------

describe('windRelativeToShot — pure crosswind from right', () => {
  it('wind FROM east (90°), shot bearing north (0°) → cross R, side=R', () => {
    // relativeAngle = 90 - 0 = 90 → sin(90)=1 → crossSigned=+8 → side='R'
    const r = windRelativeToShot(90, 8, 0);
    expect(r.kind).toBe('cross');
    expect(r.side).toBe('R');
    expect(r.crossMph).toBeCloseTo(8, 1);
    expect(Math.abs(r.headTailMph)).toBeLessThan(EPSILON);
    expect(r.label).toContain('R→L');
  });
});

// ---------------------------------------------------------------------------
// Pure crosswind — from left (L→R push)
// ---------------------------------------------------------------------------

describe('windRelativeToShot — pure crosswind from left', () => {
  it('wind FROM west (270°), shot bearing north (0°) → cross L, side=L', () => {
    // relativeAngle = normalise(270 - 0) = -90 → sin(-90)=-1 → crossSigned=-8 → side='L'
    const r = windRelativeToShot(270, 8, 0);
    expect(r.kind).toBe('cross');
    expect(r.side).toBe('L');
    expect(r.crossMph).toBeCloseTo(8, 1);
    expect(Math.abs(r.headTailMph)).toBeLessThan(EPSILON);
    expect(r.label).toContain('L→R');
  });
});

// ---------------------------------------------------------------------------
// Quartering head-cross (relativeAngle ≈ 45°)
// ---------------------------------------------------------------------------

describe('windRelativeToShot — quartering head-cross', () => {
  it('wind FROM NE (45°), shot bearing north → head-cross R', () => {
    // relativeAngle = 45 - 0 = 45
    // cos(45)≈0.707 → headTailMph≈7.07 (head component)
    // sin(45)≈0.707 → crossMph≈7.07, side='R'
    const r = windRelativeToShot(45, 10, 0);
    expect(r.kind).toBe('head-cross');
    expect(r.side).toBe('R');
    expect(r.headTailMph).toBeCloseTo(10 * Math.cos(Math.PI / 4), 1);
    expect(r.crossMph).toBeCloseTo(10 * Math.sin(Math.PI / 4), 1);
    // label should mention push direction
    expect(r.label).toContain('R→L');
  });

  it('wind FROM NW (315°), shot bearing north → head-cross L', () => {
    // relativeAngle = normalise(315 - 0) = -45
    // cos(-45)≈+0.707 → headTailMph≈+7.07 (head), sin(-45)≈-0.707 → side='L'
    const r = windRelativeToShot(315, 10, 0);
    expect(r.kind).toBe('head-cross');
    expect(r.side).toBe('L');
    expect(r.headTailMph).toBeCloseTo(10 * Math.cos(Math.PI / 4), 1);
    expect(r.label).toContain('L→R');
  });
});

// ---------------------------------------------------------------------------
// Wraparound at 0 / 360°
// ---------------------------------------------------------------------------

describe('windRelativeToShot — angle wraparound', () => {
  it('shot bearing near 355°, wind from 10° → small relative angle (headwind-ish)', () => {
    // relativeAngle = normalise(10 - 355) = normalise(-345) = 15 → head
    const r = windRelativeToShot(10, 5, 355);
    expect(r.kind).toBe('head');
    expect(r.headTailMph).toBeGreaterThan(0);
  });

  it('shot bearing 0°, wind from 359° → still head (relAngle=-1°)', () => {
    const r = windRelativeToShot(359, 10, 0);
    expect(r.kind).toBe('head');
    expect(r.headTailMph).toBeCloseTo(10 * Math.cos((-1 * Math.PI) / 180), 1);
  });

  it('wind from 0°, shot bearing 361° (same as 1°) → treated identically to 0°/1°', () => {
    // normalise(0 - 361) = normalise(-361) = normalise(-1) = -1 → absAngle=1 → head
    const r = windRelativeToShot(0, 10, 361);
    expect(r.kind).toBe('head');
  });
});

// ---------------------------------------------------------------------------
// Tail-cross classification
// ---------------------------------------------------------------------------

describe('windRelativeToShot — tail-cross', () => {
  it('wind FROM SE (135°), shot bearing north → tail-cross R', () => {
    // relativeAngle = 135 → absAngle=135 → 120≤135≤150 → tail-cross
    const r = windRelativeToShot(135, 10, 0);
    expect(r.kind).toBe('tail-cross');
    expect(r.side).toBe('R');
    expect(r.headTailMph).toBeLessThan(0); // tail component → negative
  });

  it('wind FROM SW (225°), shot bearing north → tail-cross L', () => {
    // normalise(225-0)=225>180 → 225-360=-135 → absAngle=135 → tail-cross
    const r = windRelativeToShot(225, 10, 0);
    expect(r.kind).toBe('tail-cross');
    expect(r.side).toBe('L');
  });
});

// ---------------------------------------------------------------------------
// headTailMph sign verification
// ---------------------------------------------------------------------------

describe('windRelativeToShot — headTailMph sign verification', () => {
  it('headwind gives positive headTailMph', () => {
    expect(windRelativeToShot(0, 10, 0).headTailMph).toBeGreaterThan(0);
  });

  it('tailwind gives negative headTailMph', () => {
    expect(windRelativeToShot(180, 10, 0).headTailMph).toBeLessThan(0);
  });
});
