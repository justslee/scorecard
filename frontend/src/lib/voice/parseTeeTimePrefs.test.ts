/**
 * Unit tests for the tee-time prefs voice intent — the deterministic
 * heuristics behind the /tee-time "Hold to talk" button.
 */

import { describe, it, expect } from "vitest";
import {
  parseTeeTimePrefs,
  parseTeeTimePrefsLocally,
  parseSpokenAmount,
  matchKnownCourses,
  hasTeeTimeSignal,
} from "./parseTeeTimePrefs";

const KNOWN = [
  "Presidio Golf Course",
  "TPC Harding Park",
  "Lincoln Park",
  "Sharp Park",
  "Crystal Springs",
];

describe("parseTeeTimePrefsLocally — happy paths", () => {
  it("parses 'find me a tee time Saturday morning at Presidio'", () => {
    const r = parseTeeTimePrefsLocally(
      "find me a tee time Saturday morning at Presidio",
      { courses: KNOWN },
    );
    expect(r.windows).toEqual([{ day: "saturday", period: "morning" }]);
    expect(r.courseNames).toEqual(["Presidio Golf Course"]);
    expect(r.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("parses 'party of four Sunday afternoon, under eighty dollars'", () => {
    const r = parseTeeTimePrefsLocally(
      "party of four Sunday afternoon, under eighty dollars",
    );
    expect(r.windows).toEqual([{ day: "sunday", period: "afternoon" }]);
    expect(r.partySize).toBe(4);
    expect(r.maxPriceUsd).toBe(80);
  });

  it("parses 'just my favorites, within ten miles'", () => {
    const r = parseTeeTimePrefsLocally("just my favorites, within ten miles");
    expect(r.favoritesOnly).toBe(true);
    expect(r.maxDistanceMiles).toBe(10);
    expect(r.maxPriceUsd).toBeUndefined(); // "ten" must not read as $10
  });

  it("pairs each day with its nearest period", () => {
    const r = parseTeeTimePrefsLocally("Saturday morning or Sunday afternoon");
    expect(r.windows).toEqual([
      { day: "saturday", period: "morning" },
      { day: "sunday", period: "afternoon" },
    ]);
  });

  it("expands 'this weekend' to Saturday and Sunday", () => {
    const r = parseTeeTimePrefsLocally("sometime this weekend, early");
    expect(r.windows).toEqual([
      { day: "saturday", period: "early" },
      { day: "sunday", period: "early" },
    ]);
  });

  it("takes a day with no period as a whole-day window", () => {
    const r = parseTeeTimePrefsLocally("get us out on friday");
    expect(r.windows).toEqual([{ day: "friday", period: null }]);
  });

  it("parses dollar signs and bare 'under N' as a price ceiling", () => {
    expect(parseTeeTimePrefsLocally("under $65 please").maxPriceUsd).toBe(65);
    expect(parseTeeTimePrefsLocally("keep it under 90").maxPriceUsd).toBe(90);
  });

  it("parses group-size phrasings", () => {
    expect(parseTeeTimePrefsLocally("a foursome on saturday").partySize).toBe(4);
    expect(parseTeeTimePrefsLocally("three of us sunday").partySize).toBe(3);
    expect(parseTeeTimePrefsLocally("group of 2 tomorrow morning").partySize).toBe(2);
    expect(parseTeeTimePrefsLocally("just me, saturday early").partySize).toBe(1);
  });

  it("detects go-ahead confirmations", () => {
    expect(parseTeeTimePrefsLocally("go ahead and book it").dispatch).toBe(true);
    expect(parseTeeTimePrefsLocally("find it").dispatch).toBe(true);
    expect(parseTeeTimePrefsLocally("yep").dispatch).toBe(true);
    // "yes" buried in a long sentence is not a confirmation
    expect(
      parseTeeTimePrefsLocally("yes I was thinking maybe some weekend eventually").dispatch,
    ).toBe(false);
  });

  it("keeps price and party size apart in a combined utterance", () => {
    const r = parseTeeTimePrefsLocally(
      "party of four saturday morning at sharp park under eighty dollars within twenty miles",
      { courses: KNOWN },
    );
    expect(r.partySize).toBe(4);
    expect(r.maxPriceUsd).toBe(80);
    expect(r.maxDistanceMiles).toBe(20);
    expect(r.courseNames).toEqual(["Sharp Park"]);
    expect(r.windows).toEqual([{ day: "saturday", period: "morning" }]);
  });
});

describe("parseTeeTimePrefsLocally — garbage and partials", () => {
  it("returns an empty low-confidence parse for garbage", () => {
    const r = parseTeeTimePrefsLocally("the weather is quite nice these days");
    expect(hasTeeTimeSignal(r)).toBe(false);
    expect(r.windows).toEqual([]);
    expect(r.courseNames).toEqual([]);
    expect(r.dispatch).toBe(false);
    expect(r.confidence).toBeLessThanOrEqual(0.3);
    expect(r.warnings?.length).toBeGreaterThan(0);
  });

  it("handles the empty string", () => {
    const r = parseTeeTimePrefsLocally("");
    expect(hasTeeTimeSignal(r)).toBe(false);
  });

  it("accepts a partial utterance (party size only)", () => {
    const r = parseTeeTimePrefsLocally("party of four");
    expect(r.partySize).toBe(4);
    expect(r.windows).toEqual([]);
    expect(hasTeeTimeSignal(r)).toBe(true);
  });

  it("a lone period word without a day makes no window", () => {
    const r = parseTeeTimePrefsLocally("morning would be nice");
    expect(r.windows).toEqual([]);
  });
});

describe("matchKnownCourses", () => {
  it("matches on distinctive tokens, not generic words", () => {
    // "park" alone must not light up Lincoln Park / Sharp Park.
    expect(matchKnownCourses("somewhere with a nice park", KNOWN)).toEqual([]);
    expect(matchKnownCourses("sharp park on sunday", KNOWN)).toEqual(["Sharp Park"]);
  });

  it("matches a course by its distinctive word alone", () => {
    expect(matchKnownCourses("out at harding", KNOWN)).toEqual(["TPC Harding Park"]);
    expect(matchKnownCourses("presidio please", KNOWN)).toEqual(["Presidio Golf Course"]);
  });

  it("absorbs light STT damage on longer names", () => {
    expect(matchKnownCourses("precidio saturday", KNOWN)).toEqual(["Presidio Golf Course"]);
  });

  it("matches multiple courses in one utterance", () => {
    expect(matchKnownCourses("presidio or lincoln", KNOWN)).toEqual([
      "Presidio Golf Course",
      "Lincoln Park",
    ]);
  });

  it("returns nothing when no courses are known", () => {
    expect(matchKnownCourses("presidio saturday", [])).toEqual([]);
  });
});

describe("parseSpokenAmount", () => {
  it("parses digits, teens, tens, and compounds", () => {
    expect(parseSpokenAmount("80")).toBe(80);
    expect(parseSpokenAmount("eighty")).toBe(80);
    expect(parseSpokenAmount("eighty five")).toBe(85);
    expect(parseSpokenAmount("a hundred")).toBe(100);
    expect(parseSpokenAmount("one hundred twenty")).toBe(120);
    expect(parseSpokenAmount("ten")).toBe(10);
  });

  it("returns null when nothing numeric is present", () => {
    expect(parseSpokenAmount("cheap")).toBeNull();
    expect(parseSpokenAmount("")).toBeNull();
  });
});

describe("parseTeeTimePrefs (async wrapper)", () => {
  it("uses the deterministic heuristics without an LLM key", async () => {
    const r = await parseTeeTimePrefs({
      transcript: "Saturday morning at Presidio",
      known: { courses: KNOWN },
    });
    expect(r.windows).toEqual([{ day: "saturday", period: "morning" }]);
    expect(r.courseNames).toEqual(["Presidio Golf Course"]);
  });

  it("returns the low-confidence local parse for garbage without an LLM key", async () => {
    const r = await parseTeeTimePrefs({ transcript: "tell me a story" });
    expect(hasTeeTimeSignal(r)).toBe(false);
  });
});
