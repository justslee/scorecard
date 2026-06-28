import { describe, expect, it } from "vitest";
import { shotPointForPath } from "./hole-shot-point";

describe("shotPointForPath", () => {
  it("par-3 (2-point path) does NOT crash and returns the tee→green midpoint", () => {
    // Regression: this 2-point path crashed hole 3 (read pathPts[2][0]).
    const sp = shotPointForPath([[0.5, 0.88], [0.5, 0.2]]);
    expect(sp).not.toBeNull();
    expect(sp![0]).toBeCloseTo(0.5);
    expect(sp![1]).toBeCloseTo((0.88 + 0.2) / 2 + 0.05);
  });

  it("par-4 (3-point path) uses the last (approach) segment", () => {
    const sp = shotPointForPath([[0.5, 0.92], [0.62, 0.58], [0.32, 0.18]]);
    expect(sp![0]).toBeCloseTo((0.62 + 0.32) / 2);
  });

  it("par-5 (4-point path) uses the final segment", () => {
    const sp = shotPointForPath([[0.5, 0.94], [0.38, 0.65], [0.56, 0.38], [0.5, 0.14]]);
    expect(sp![0]).toBeCloseTo((0.56 + 0.5) / 2);
  });

  it("returns null for a degenerate single-point path", () => {
    expect(shotPointForPath([[0.5, 0.5]])).toBeNull();
    expect(shotPointForPath([])).toBeNull();
  });
});
