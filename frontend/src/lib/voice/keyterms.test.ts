import { describe, it, expect } from "vitest";
import { buildKeyterms, keytermQuery, GOLF_KEYTERMS, MAX_KEYTERMS } from "./keyterms";

describe("buildKeyterms", () => {
  it("puts context terms before the golf baseline", () => {
    const terms = buildKeyterms(["Bethpage Black", "Jack"]);
    expect(terms[0]).toBe("Bethpage Black");
    expect(terms[1]).toBe("Jack");
    expect(terms).toContain("birdie");
  });

  it("dedupes case-insensitively and drops blanks", () => {
    const terms = buildKeyterms(["Birdie", "  ", "bethpage"], ["BETHPAGE"]);
    expect(terms.filter((t) => t.toLowerCase() === "birdie")).toHaveLength(1);
    expect(terms.filter((t) => t.toLowerCase() === "bethpage")).toHaveLength(1);
  });

  it("caps at MAX_KEYTERMS with context winning the budget", () => {
    const many = Array.from({ length: 60 }, (_, i) => `Course ${i}`);
    const terms = buildKeyterms(many);
    expect(terms).toHaveLength(MAX_KEYTERMS);
    expect(terms[0]).toBe("Course 0");
    expect(terms).not.toContain(GOLF_KEYTERMS[GOLF_KEYTERMS.length - 1]);
  });

  it("no context → the golf baseline", () => {
    expect(buildKeyterms()).toEqual([...GOLF_KEYTERMS].slice(0, MAX_KEYTERMS));
  });
});

describe("keytermQuery", () => {
  it("builds repeated encoded params", () => {
    expect(keytermQuery(["up and down", "3-wood"])).toBe(
      "&keyterm=up%20and%20down&keyterm=3-wood"
    );
  });

  it("empty list → empty string", () => {
    expect(keytermQuery([])).toBe("");
  });
});
