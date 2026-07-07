/**
 * Unit tests for the tee-time window slider drag math — round-trips,
 * snapping, domain clamps, pickHandle, and applyDrag for every handle.
 */

import { describe, it, expect } from "vitest";
import {
  TRACK_START_MIN,
  TRACK_END_MIN,
  STEP_MIN,
  MIN_WINDOW_MIN,
  MAX_WINDOW_MIN,
  hhmmToMin,
  minToHhmm,
  fracToMin,
  minToFrac,
  pickHandle,
  applyDrag,
} from "./window-slider";

describe("hhmmToMin / minToHhmm", () => {
  it("round-trips", () => {
    expect(hhmmToMin("06:30")).toBe(390);
    expect(hhmmToMin("21:00")).toBe(1260);
    expect(minToHhmm(390)).toBe("06:30");
    expect(minToHhmm(1260)).toBe("21:00");
  });

  it("pads single-digit hours/minutes", () => {
    expect(minToHhmm(65)).toBe("01:05");
  });
});

describe("fracToMin / minToFrac", () => {
  it("round-trips through the domain", () => {
    expect(fracToMin(0)).toBe(TRACK_START_MIN);
    expect(fracToMin(1)).toBe(TRACK_END_MIN);
    expect(minToFrac(TRACK_START_MIN)).toBe(0);
    expect(minToFrac(TRACK_END_MIN)).toBe(1);
  });

  it("snaps to the 30-minute grid", () => {
    // Track is 15h (900 min); a frac just past the first step should snap down.
    const oneStepFrac = STEP_MIN / (TRACK_END_MIN - TRACK_START_MIN);
    expect(fracToMin(oneStepFrac + 0.001)).toBe(TRACK_START_MIN + STEP_MIN);
    expect(fracToMin(oneStepFrac - 0.001)).toBe(TRACK_START_MIN + STEP_MIN);
  });

  it("clamps out-of-range fractions", () => {
    expect(fracToMin(-0.5)).toBe(TRACK_START_MIN);
    expect(fracToMin(1.5)).toBe(TRACK_END_MIN);
    expect(minToFrac(TRACK_START_MIN - 500)).toBe(0);
    expect(minToFrac(TRACK_END_MIN + 500)).toBe(1);
  });
});

describe("pickHandle", () => {
  const start = 600; // 10:00
  const end = 780;   // 13:00

  it("grabs the start edge when close to it", () => {
    const frac = minToFrac(start + 10);
    expect(pickHandle(frac, start, end)).toBe("start");
  });

  it("grabs the end edge when close to it", () => {
    const frac = minToFrac(end - 10);
    expect(pickHandle(frac, start, end)).toBe("end");
  });

  it("grabs the band in the middle, away from both edges", () => {
    const frac = minToFrac((start + end) / 2);
    expect(pickHandle(frac, start, end)).toBe("band");
  });

  it("outside the window picks the nearer edge", () => {
    expect(pickHandle(minToFrac(start - 60), start, end)).toBe("start");
    expect(pickHandle(minToFrac(end + 60), start, end)).toBe("end");
  });
});

describe("applyDrag — start handle", () => {
  it("moves the start, keeping the end fixed", () => {
    const r = applyDrag("start", minToFrac(500), 600, 780);
    expect(r).toEqual({ start: 510, end: 780 }); // 500 snaps to the nearer 30-min tick
  });

  it("never lets start cross past end minus the 1h floor", () => {
    const r = applyDrag("start", minToFrac(779), 600, 780);
    expect(r.start).toBe(720); // 780 - MIN_WINDOW_MIN
    expect(r.end).toBe(780);
  });

  it("never lets the window exceed the 6h cap", () => {
    const r = applyDrag("start", minToFrac(0), 600, 780);
    expect(r.end - r.start).toBeLessThanOrEqual(MAX_WINDOW_MIN);
    expect(r.start).toBe(780 - MAX_WINDOW_MIN);
  });

  it("never leaves the track", () => {
    const r = applyDrag("start", minToFrac(-1), 600, 780);
    expect(r.start).toBeGreaterThanOrEqual(TRACK_START_MIN);
  });
});

describe("applyDrag — end handle", () => {
  it("moves the end, keeping the start fixed", () => {
    const r = applyDrag("end", minToFrac(900), 600, 780);
    expect(r).toEqual({ start: 600, end: 900 });
  });

  it("never lets end cross before start plus the 1h floor", () => {
    const r = applyDrag("end", minToFrac(601), 600, 780);
    expect(r.end).toBe(660); // 600 + MIN_WINDOW_MIN
  });

  it("never lets the window exceed the 6h cap", () => {
    const r = applyDrag("end", minToFrac(TRACK_END_MIN), 600, 780);
    expect(r.end - r.start).toBeLessThanOrEqual(MAX_WINDOW_MIN);
    expect(r.end).toBe(600 + MAX_WINDOW_MIN);
  });

  it("never leaves the track", () => {
    const r = applyDrag("end", minToFrac(2), 600, 780);
    expect(r.end).toBeLessThanOrEqual(TRACK_END_MIN);
  });
});

describe("applyDrag — band handle", () => {
  it("translates the whole window, preserving its length", () => {
    const length = 780 - 600;
    const grabOffsetMin = 30; // grabbed 30min into the window
    const r = applyDrag("band", minToFrac(600 + 30 + 60), 600, 780, grabOffsetMin);
    expect(r.end - r.start).toBe(length);
    expect(r.start).toBe(660);
    expect(r.end).toBe(840);
  });

  it("clamps at the start of the track without changing length", () => {
    const length = 780 - 600;
    const r = applyDrag("band", 0, 600, 780, 0);
    expect(r.start).toBe(TRACK_START_MIN);
    expect(r.end - r.start).toBe(length);
  });

  it("clamps at the end of the track without changing length", () => {
    const length = 780 - 600;
    const r = applyDrag("band", 1, 600, 780, 0);
    expect(r.end).toBe(TRACK_END_MIN);
    expect(r.end - r.start).toBe(length);
  });
});

describe("domain constants", () => {
  it("never allows a midnight-crossing window (track stays within one day)", () => {
    expect(TRACK_START_MIN).toBeGreaterThanOrEqual(0);
    expect(TRACK_END_MIN).toBeLessThan(24 * 60);
  });

  it("min/max window bounds are sane", () => {
    expect(MIN_WINDOW_MIN).toBeLessThan(MAX_WINDOW_MIN);
    expect(MAX_WINDOW_MIN).toBeLessThanOrEqual(TRACK_END_MIN - TRACK_START_MIN);
  });
});
