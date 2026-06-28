import { describe, expect, it } from "vitest";
import {
  joinNames,
  missingPlayerNames,
  missingScoreNote,
} from "./confirm-guidance";

const players = [{ name: "Justin" }, { name: "Jack" }, { name: "Mia" }];

describe("joinNames", () => {
  it("handles 0/1/2/3 names like a person would", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["Jack"])).toBe("Jack");
    expect(joinNames(["Jack", "Mia"])).toBe("Jack and Mia");
    expect(joinNames(["Jack", "Mia", "Sam"])).toBe("Jack, Mia, and Sam");
  });
});

describe("missingPlayerNames", () => {
  it("returns roster-order names with no parsed score", () => {
    expect(missingPlayerNames(players, { Justin: 4 })).toEqual(["Jack", "Mia"]);
  });
  it("is empty when everyone has a score", () => {
    expect(missingPlayerNames(players, { Justin: 4, Jack: 5, Mia: 6 })).toEqual([]);
  });
});

describe("missingScoreNote", () => {
  it("names the missing players when low-confidence and some are missing", () => {
    const note = missingScoreNote(players, { Justin: 4 }, 0.4);
    expect(note).toBe("I didn't catch a score for Jack and Mia.");
  });

  it("returns null when confidence is high (parse is trusted)", () => {
    expect(missingScoreNote(players, { Justin: 4 }, 0.9)).toBeNull();
  });

  it("returns null when confidence is unknown", () => {
    expect(missingScoreNote(players, { Justin: 4 }, undefined)).toBeNull();
  });

  it("returns null when every player has a score, even if low-confidence", () => {
    expect(missingScoreNote(players, { Justin: 4, Jack: 5, Mia: 6 }, 0.3)).toBeNull();
  });

  it("returns null when NO player has a score (empty parse — panel covers that)", () => {
    expect(missingScoreNote(players, {}, 0.3)).toBeNull();
  });

  it("treats the 0.65 threshold as not-low (boundary)", () => {
    expect(missingScoreNote(players, { Justin: 4 }, 0.65)).toBeNull();
  });

  it("uses singular phrasing for one missing player", () => {
    const note = missingScoreNote(players, { Justin: 4, Jack: 5 }, 0.5);
    expect(note).toBe("I didn't catch a score for Mia.");
  });
});
