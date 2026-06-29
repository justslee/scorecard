import { describe, it, expect } from "vitest";
import {
  distanceMiles,
  formatMiles,
  dedupeByName,
  mergeAndSortNearby,
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
