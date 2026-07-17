import { describe, expect, it } from "vitest";
import {
  pathArcLength,
  bookYardsPerUnit,
  bookTargetDistances,
  clampToDiagram,
  round5,
} from "./yardage-book-target";
import { HOLES } from "@/components/yardage/HoleIllustration";
import type { PathPoint } from "./hole-shot-point";

describe("pathArcLength", () => {
  it("sums euclidean segment lengths for a multi-point path", () => {
    const path: PathPoint[] = [[0, 0], [3, 4], [3, 0]];
    // |[0,0]-[3,4]| = 5, |[3,4]-[3,0]| = 4
    expect(pathArcLength(path)).toBeCloseTo(9);
  });

  it("is the single straight-line distance for a 2-point (par-3) path", () => {
    const path: PathPoint[] = [[0.5, 0.88], [0.5, 0.2]];
    expect(pathArcLength(path)).toBeCloseTo(0.68);
  });

  it("is 0 for a degenerate single-point / empty path", () => {
    expect(pathArcLength([[0.5, 0.5]])).toBe(0);
    expect(pathArcLength([])).toBe(0);
  });
});

describe("bookYardsPerUnit", () => {
  it("divides yards by the arc length", () => {
    const path: PathPoint[] = [[0.5, 0.92], [0.5, 0.18]]; // arc = 0.74
    expect(bookYardsPerUnit(398, path)).toBeCloseTo(398 / 0.74);
  });

  it("returns 0 (never NaN/Infinity) for a degenerate path", () => {
    expect(bookYardsPerUnit(400, [])).toBe(0);
    expect(bookYardsPerUnit(400, [[0.5, 0.5]])).toBe(0);
  });
});

describe("round5", () => {
  it("rounds to the nearest multiple of 5", () => {
    expect(round5(212)).toBe(210);
    expect(round5(213)).toBe(215);
    expect(round5(0)).toBe(0);
    expect(round5(247.4)).toBe(245);
    expect(round5(247.6)).toBe(250);
  });
});

describe("bookTargetDistances — straight holes", () => {
  // HOLES[4]: par 4, 398 yards, dead-straight 2-point path, dogleg: 0.
  const straight = HOLES[4];

  it("point AT the tee: toTarget = 0, toGreen = yards (within rounding)", () => {
    const { toTarget, toGreen } = bookTargetDistances(straight.path[0], straight.path, straight.yards);
    expect(toTarget).toBe(0);
    expect(Math.abs(toGreen - straight.yards)).toBeLessThanOrEqual(5);
  });

  it("point AT the green: toTarget = yards, toGreen = 0 (within rounding)", () => {
    const green = straight.path[straight.path.length - 1];
    const { toTarget, toGreen } = bookTargetDistances(green, straight.path, straight.yards);
    expect(toGreen).toBe(0);
    expect(Math.abs(toTarget - straight.yards)).toBeLessThanOrEqual(5);
  });

  it("point on the line ANYWHERE: legs sum to yards, within rounding", () => {
    const [tee, green] = [straight.path[0], straight.path[straight.path.length - 1]];
    for (const t of [0.1, 0.35, 0.5, 0.72, 0.9]) {
      const p: PathPoint = [tee[0] + (green[0] - tee[0]) * t, tee[1] + (green[1] - tee[1]) * t];
      const { toTarget, toGreen } = bookTargetDistances(p, straight.path, straight.yards);
      expect(Math.abs(toTarget + toGreen - straight.yards)).toBeLessThanOrEqual(5);
    }
  });

  it("every distance lands on a multiple of 5", () => {
    const { toTarget, toGreen } = bookTargetDistances([0.5, 0.4], straight.path, straight.yards);
    expect(toTarget % 5).toBe(0);
    expect(toGreen % 5).toBe(0);
  });
});

describe("bookTargetDistances — dogleg", () => {
  // HOLES[1]: par 4, 385 yards, 3-point dogleg path (dogleg: -1).
  const dogleg = HOLES[1];
  const tee = dogleg.path[0];
  const green = dogleg.path[dogleg.path.length - 1];
  const ypu = bookYardsPerUnit(dogleg.yards, dogleg.path);
  const straightTeeGreenYards = Math.hypot(green[0] - tee[0], green[1] - tee[1]) * ypu;

  it("cutting the corner (straight chord midpoint): legs sum LESS than yards", () => {
    // The midpoint of the direct tee→green chord bypasses the dogleg vertex
    // entirely — the honest "shorter line across the bend" case the plan
    // calls out. Sum should equal the straight tee→green distance (within
    // rounding), which is strictly less than the printed (arc-based) yards
    // for a real dogleg.
    const mid: PathPoint = [(tee[0] + green[0]) / 2, (tee[1] + green[1]) / 2];
    const { toTarget, toGreen } = bookTargetDistances(mid, dogleg.path, dogleg.yards);

    expect(toTarget).toBeLessThan(dogleg.yards);
    expect(toGreen).toBeLessThan(dogleg.yards);
    expect(toTarget + toGreen).toBeLessThan(dogleg.yards);
    // Triangle inequality: legs sum >= the straight tee→green distance —
    // here it should be approximately EQUAL, since the midpoint sits ON
    // that straight chord.
    expect(Math.abs(toTarget + toGreen - straightTeeGreenYards)).toBeLessThanOrEqual(5);
  });

  it("at the dogleg vertex itself, legs sum to (approximately) the full yards", () => {
    // The vertex IS on the path, so the two legs together equal the arc
    // length exactly (before rounding) — the one place a dogleg's legs DO
    // sum to the printed yardage, since there's no corner left to cut.
    const vertex = dogleg.path[1];
    const { toTarget, toGreen } = bookTargetDistances(vertex, dogleg.path, dogleg.yards);
    expect(Math.abs(toTarget + toGreen - dogleg.yards)).toBeLessThanOrEqual(5);
  });
});

describe("bookTargetDistances — par-3 (2-point path) sanity", () => {
  // HOLES[2]: par 3, 178 yards, 2-point path.
  const par3 = HOLES[2];

  it("does not crash and produces sane, rounded distances", () => {
    const mid: PathPoint = [
      (par3.path[0][0] + par3.path[1][0]) / 2,
      (par3.path[0][1] + par3.path[1][1]) / 2,
    ];
    const { toTarget, toGreen } = bookTargetDistances(mid, par3.path, par3.yards);
    expect(toTarget).toBeGreaterThan(0);
    expect(toGreen).toBeGreaterThan(0);
    expect(toTarget % 5).toBe(0);
    expect(toGreen % 5).toBe(0);
  });
});

describe("clampToDiagram", () => {
  it("leaves in-bounds points untouched", () => {
    expect(clampToDiagram([0.5, 0.5])).toEqual([0.5, 0.5]);
  });

  it("clamps points outside [0,1] to the inset bounds", () => {
    expect(clampToDiagram([-0.5, 1.8])).toEqual([0.04, 0.96]);
    expect(clampToDiagram([1.2, -0.3])).toEqual([0.96, 0.04]);
  });

  it("respects a custom inset", () => {
    expect(clampToDiagram([-1, -1], 0.1)).toEqual([0.1, 0.1]);
  });
});
