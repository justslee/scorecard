/**
 * Unit tests for tee-time date helpers — the day-label → date logic that
 * fixes the "Sunday window searched Saturday's date" bug.
 */

import { describe, it, expect } from "vitest";
import {
  toISODateLocal,
  weekdayFromLabel,
  nextDateForWeekday,
  dateForWindowLabel,
} from "./dates";

// Wed Jul 1 2026, 10:00 local — a fixed reference point.
const WED = new Date(2026, 6, 1, 10, 0);
// Sat Jul 4 2026.
const SAT = new Date(2026, 6, 4, 10, 0);

describe("toISODateLocal", () => {
  it("formats in local time (no UTC drift near midnight)", () => {
    expect(toISODateLocal(new Date(2026, 6, 1, 23, 30))).toBe("2026-07-01");
    expect(toISODateLocal(new Date(2026, 0, 5, 0, 10))).toBe("2026-01-05");
  });
});

describe("weekdayFromLabel", () => {
  it("parses full weekday names case-insensitively", () => {
    expect(weekdayFromLabel("Saturday")).toBe(6);
    expect(weekdayFromLabel("sunday")).toBe(0);
    expect(weekdayFromLabel("FRIDAY")).toBe(5);
  });

  it("parses 3-letter prefixes and labels with suffixes", () => {
    expect(weekdayFromLabel("sat")).toBe(6);
    expect(weekdayFromLabel("Sunday early")).toBe(0);
  });

  it("returns null for labels without a weekday", () => {
    expect(weekdayFromLabel("Custom")).toBeNull();
    expect(weekdayFromLabel("")).toBeNull();
  });
});

describe("nextDateForWeekday", () => {
  it("finds the next Saturday from a Wednesday", () => {
    expect(nextDateForWeekday(6, WED)).toBe("2026-07-04");
  });

  it("finds the next Sunday from a Wednesday", () => {
    expect(nextDateForWeekday(0, WED)).toBe("2026-07-05");
  });

  it("is strictly future: Saturday from a Saturday jumps a week", () => {
    expect(nextDateForWeekday(6, SAT)).toBe("2026-07-11");
  });
});

describe("dateForWindowLabel", () => {
  it("Saturday and Sunday windows get their OWN dates", () => {
    expect(dateForWindowLabel("Saturday", WED)).toBe("2026-07-04");
    expect(dateForWindowLabel("Sunday", WED)).toBe("2026-07-05");
  });

  it("labels without a weekday fall back to next Saturday", () => {
    expect(dateForWindowLabel("Custom", WED)).toBe("2026-07-04");
  });
});
