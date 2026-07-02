import { describe, it, expect } from "vitest";
import {
  distanceMiles,
  formatMiles,
  dedupeByName,
  mergeAndSortNearby,
  matchesQueryPrefix,
  tokenizeCourseName,
  courseNameKey,
} from "./course-search-helpers";
import type { CourseSearchResult } from "./golf-api";

// ---------------------------------------------------------------------------
// distanceMiles
// ---------------------------------------------------------------------------

describe("distanceMiles", () => {
  it("returns 0 for same point", () => {
    expect(distanceMiles({ lat: 40.0, lng: -73.0 }, { lat: 40.0, lng: -73.0 })).toBe(0);
  });

  it("approximates JFK to LAX (~2468 miles)", () => {
    // JFK: 40.6413, -73.7781  /  LAX: 33.9425, -118.4081
    const d = distanceMiles(
      { lat: 40.6413, lng: -73.7781 },
      { lat: 33.9425, lng: -118.4081 }
    );
    expect(d).toBeGreaterThan(2400);
    expect(d).toBeLessThan(2600);
  });

  it("is symmetric", () => {
    const a = { lat: 40.7442, lng: -73.4593 }; // Bethpage
    const b = { lat: 40.6413, lng: -73.7781 }; // JFK
    expect(distanceMiles(a, b)).toBeCloseTo(distanceMiles(b, a), 6);
  });

  it("short distances are small (< 1 mi for nearby points)", () => {
    const a = { lat: 40.7442, lng: -73.4593 };
    // ~0.09° ≈ ~6 miles in lat; keep tiny
    const b = { lat: 40.7450, lng: -73.4600 };
    expect(distanceMiles(a, b)).toBeLessThan(0.1);
  });
});

// ---------------------------------------------------------------------------
// formatMiles
// ---------------------------------------------------------------------------

describe("formatMiles", () => {
  it('formats sub-10 miles with one decimal: "0.3 mi"', () => {
    expect(formatMiles(0.3)).toBe("0.3 mi");
  });

  it('formats 1.0 as "1.0 mi"', () => {
    expect(formatMiles(1.0)).toBe("1.0 mi");
  });

  it('formats 10+ miles as rounded integer: "12 mi"', () => {
    expect(formatMiles(12.4)).toBe("12 mi");
    expect(formatMiles(12.6)).toBe("13 mi");
  });

  it('formats exactly 10 as "10 mi"', () => {
    expect(formatMiles(10)).toBe("10 mi");
  });
});

// ---------------------------------------------------------------------------
// dedupeByName
// ---------------------------------------------------------------------------

const makeResult = (overrides: Partial<CourseSearchResult>): CourseSearchResult => ({
  id: "default-id",
  name: "Default Course",
  source: "osm",
  ...overrides,
});

describe("dedupeByName", () => {
  it("returns all unique names unchanged", () => {
    const input = [
      makeResult({ id: "a", name: "Bethpage Black" }),
      makeResult({ id: "b", name: "Pebble Beach" }),
    ];
    expect(dedupeByName(input)).toHaveLength(2);
  });

  it("removes duplicate name (case-insensitive), keeps first", () => {
    const input = [
      makeResult({ id: "a", name: "Bethpage Black", source: "mapped" }),
      makeResult({ id: "b", name: "bethpage black", source: "osm" }),
    ];
    const result = dedupeByName(input);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a"); // first kept
  });

  it("handles empty array", () => {
    expect(dedupeByName([])).toEqual([]);
  });

  it("preserves order of first occurrences", () => {
    const input = [
      makeResult({ id: "a", name: "Alpha" }),
      makeResult({ id: "b", name: "Beta" }),
      makeResult({ id: "c", name: "Alpha" }), // dupe
      makeResult({ id: "d", name: "Gamma" }),
    ];
    const result = dedupeByName(input);
    expect(result.map((r) => r.id)).toEqual(["a", "b", "d"]);
  });
});

// ---------------------------------------------------------------------------
// mergeAndSortNearby
// ---------------------------------------------------------------------------

const USER = { lat: 40.7442, lng: -73.4593 }; // ~Bethpage

describe("mergeAndSortNearby", () => {
  it("sorts by distance ascending", () => {
    const input: CourseSearchResult[] = [
      makeResult({ id: "far", name: "Far Course", center: { lat: 41.0, lng: -74.0 } }),
      makeResult({ id: "near", name: "Near Course", center: { lat: 40.75, lng: -73.46 } }),
    ];
    const result = mergeAndSortNearby(input, USER.lat, USER.lng);
    expect(result[0].id).toBe("near");
    expect(result[1].id).toBe("far");
  });

  it("attaches distanceMi", () => {
    const input: CourseSearchResult[] = [
      makeResult({ id: "a", name: "A Course", center: { lat: 40.75, lng: -73.46 } }),
    ];
    const result = mergeAndSortNearby(input, USER.lat, USER.lng);
    expect(typeof result[0].distanceMi).toBe("number");
    expect(result[0].distanceMi).toBeGreaterThan(0);
  });

  it("handles courses with no center (sorts to end)", () => {
    const input: CourseSearchResult[] = [
      makeResult({ id: "no-center", name: "No Center", center: undefined }),
      makeResult({ id: "has-center", name: "Has Center", center: { lat: 40.75, lng: -73.46 } }),
    ];
    const result = mergeAndSortNearby(input, USER.lat, USER.lng);
    expect(result[0].id).toBe("has-center");
    expect(result[1].id).toBe("no-center");
  });

  it("deduplicates by name after sorting (closest copy wins)", () => {
    const input: CourseSearchResult[] = [
      makeResult({ id: "mapped-close", name: "Bethpage Black", source: "mapped", center: { lat: 40.745, lng: -73.459 } }),
      makeResult({ id: "osm-far", name: "bethpage black", source: "osm", center: { lat: 40.800, lng: -73.500 } }),
    ];
    const result = mergeAndSortNearby(input, USER.lat, USER.lng);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("mapped-close");
  });

  it("on equal distance, mapped course ranks first", () => {
    // Same center coordinates to force a tie
    const center = { lat: 40.75, lng: -73.46 };
    const input: CourseSearchResult[] = [
      makeResult({ id: "osm", name: "Twin Oaks OSM", source: "osm", center }),
      makeResult({ id: "mapped", name: "Twin Oaks Mapped", source: "mapped", center }),
    ];
    const result = mergeAndSortNearby(input, USER.lat, USER.lng);
    // Both survive (different names), mapped first
    expect(result[0].id).toBe("mapped");
  });

  it("handles empty array", () => {
    expect(mergeAndSortNearby([], USER.lat, USER.lng)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// tokenizeCourseName
// ---------------------------------------------------------------------------

describe("tokenizeCourseName", () => {
  it("splits on punctuation and lowercases", () => {
    expect(tokenizeCourseName("Bethpage State Park - Black Course")).toEqual([
      "bethpage",
      "state",
      "park",
      "black",
      "course",
    ]);
  });

  it("collapses repeated whitespace/punctuation", () => {
    expect(tokenizeCourseName("Pebble  Beach,   Golf-Links")).toEqual([
      "pebble",
      "beach",
      "golf",
      "links",
    ]);
  });

  it("returns empty array for empty/punctuation-only input", () => {
    expect(tokenizeCourseName("")).toEqual([]);
    expect(tokenizeCourseName("---")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// matchesQueryPrefix — the owner's Bethpage repro cases
// ---------------------------------------------------------------------------

describe("matchesQueryPrefix", () => {
  it('"bethpa" matches Bethpage courses', () => {
    expect(matchesQueryPrefix("Bethpage Black", "bethpa")).toBe(true);
    expect(matchesQueryPrefix("Bethpage Red", "bethpa")).toBe(true);
    expect(matchesQueryPrefix("Bethpage Green", "bethpa")).toBe(true);
  });

  it('"bethpa" does NOT match unrelated towns (Bethel Island, Bethanga)', () => {
    expect(matchesQueryPrefix("Bethel Island", "bethpa")).toBe(false);
    expect(matchesQueryPrefix("Bethanga", "bethpa")).toBe(false);
  });

  it('"bethpage black" matches exactly "Bethpage State Park - Black Course" (punctuation/word split)', () => {
    expect(matchesQueryPrefix("Bethpage State Park - Black Course", "bethpage black")).toBe(true);
  });

  it('"bethpage black" does NOT match "Bethpage Red" or "Bethpage Green"', () => {
    expect(matchesQueryPrefix("Bethpage Red", "bethpage black")).toBe(false);
    expect(matchesQueryPrefix("Bethpage Green", "bethpage black")).toBe(false);
  });

  it("every query token must prefix-match some name token (AND semantics)", () => {
    expect(matchesQueryPrefix("Pebble Beach Golf Links", "pebble links")).toBe(true);
    expect(matchesQueryPrefix("Pebble Beach Golf Links", "pebble zzz")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(matchesQueryPrefix("BETHPAGE BLACK", "Bethpage")).toBe(true);
  });

  it("strips golf-stopwords from the query but not from the name", () => {
    // "golf" is a stopword in the query — "golf cl" should still match "... Golf Club"
    expect(matchesQueryPrefix("Riverside Golf Club", "golf cl")).toBe(true);
    // An all-stopword query falls back to its literal tokens rather than
    // matching everything.
    expect(matchesQueryPrefix("Riverside Golf Club", "golf")).toBe(true);
    expect(matchesQueryPrefix("Bethpage Black", "golf")).toBe(false);
  });

  it("empty query matches everything (no filter to apply yet)", () => {
    expect(matchesQueryPrefix("Bethpage Black", "")).toBe(true);
  });

  it("prefix, not substring — a mid-word match does not count", () => {
    // "ethpage" is a substring of "Bethpage" but not a prefix of any word.
    expect(matchesQueryPrefix("Bethpage Black", "ethpage")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// courseNameKey
// ---------------------------------------------------------------------------

describe("courseNameKey", () => {
  it("normalizes case and punctuation for dedupe comparison", () => {
    expect(courseNameKey("Bethpage Black")).toBe(courseNameKey("bethpage, black!"));
  });

  it("distinguishes different courses", () => {
    expect(courseNameKey("Bethpage Black")).not.toBe(courseNameKey("Bethpage Red"));
  });
});
