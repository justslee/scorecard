/**
 * Unit tests for the tournament setup page's "The Program" copy/format
 * helpers (specs/tournament-redesign-plan.md).
 */

import { describe, it, expect } from "vitest";
import {
  numberWord,
  formatProgramDate,
  fieldSummary,
  colophonLine,
  ghostCount,
} from "./tournament-program";

describe("numberWord", () => {
  it("spells 1-9", () => {
    expect(numberWord(1)).toBe("one");
    expect(numberWord(4)).toBe("four");
    expect(numberWord(9)).toBe("nine");
  });

  it("falls back to digits for 0 and 10+", () => {
    expect(numberWord(0)).toBe("0");
    expect(numberWord(10)).toBe("10");
  });
});

describe("formatProgramDate", () => {
  it("renders weekday, month, day — no year — uppercased", () => {
    // Local-time Date constructor (NOT an ISO string) so the test is
    // timezone-proof.
    expect(formatProgramDate(new Date(2026, 6, 12))).toBe("SUNDAY, JULY 12");
  });
});

describe("fieldSummary", () => {
  it("composes the sentence with word-form counts", () => {
    expect(fieldSummary(3, 2)).toBe("A field of three, over two days.");
    expect(fieldSummary(1, 1)).toBe("A field of one, over one day.");
  });

  it("falls back to digits at 10+ players", () => {
    expect(fieldSummary(12, 4)).toBe("A field of 12, over four days.");
  });

  it("returns empty string with no players", () => {
    expect(fieldSummary(0, 2)).toBe("");
  });
});

describe("colophonLine", () => {
  it("renders digits with singular/plural units", () => {
    expect(colophonLine(2, 3)).toBe("2 DAYS · 3 ENTRANTS");
    expect(colophonLine(1, 1)).toBe("1 DAY · 1 ENTRANT");
  });

  it("returns empty string with no players", () => {
    expect(colophonLine(2, 0)).toBe("");
  });
});

describe("ghostCount", () => {
  it("yields one-for-one, capped at 3, zero once field >= 4", () => {
    expect(ghostCount(0)).toBe(3);
    expect(ghostCount(1)).toBe(3);
    expect(ghostCount(2)).toBe(2);
    expect(ghostCount(3)).toBe(1);
    expect(ghostCount(4)).toBe(0);
    expect(ghostCount(9)).toBe(0);
  });
});
