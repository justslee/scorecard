import { describe, it, expect } from "vitest";
import {
  distanceMiles,
  formatMiles,
  dedupeByName,
  mergeAndSortNearby,
  appendNearby,
  NEARBY_LIMIT,
  matchesQueryPrefix,
  tokenizeCourseName,
  courseNameKey,
  dedupeIdleSections,
  buildRowSubline,
  resultSourceLabel,
} from "./course-search-helpers";
import type { CourseSearchResult } from "./golf-api";
import type { NearbyResult } from "./course-search-helpers";

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

  it(`caps the result at NEARBY_LIMIT (${NEARBY_LIMIT}), nearest first`, () => {
    const input: CourseSearchResult[] = Array.from({ length: NEARBY_LIMIT + 5 }, (_, i) =>
      makeResult({
        id: `c${i}`,
        name: `Course ${i}`,
        // Farther away as i increases, so distance order == index order.
        center: { lat: 40.7442 + i * 0.05, lng: -73.4593 },
      })
    );
    const result = mergeAndSortNearby(input, USER.lat, USER.lng);
    expect(result).toHaveLength(NEARBY_LIMIT);
    expect(result.map((r) => r.id)).toEqual(
      Array.from({ length: NEARBY_LIMIT }, (_, i) => `c${i}`)
    );
  });
});

// ---------------------------------------------------------------------------
// appendNearby — progressive, no-reshuffle append (search-speed-and-golfapi-
// verify-plan.md, win 2/3)
// ---------------------------------------------------------------------------

describe("appendNearby", () => {
  it("NEVER reshuffles existing rows, even when a nearer row arrives later (owner's no-reshuffle law)", () => {
    // Existing rows deliberately NOT distance-sorted (as they'd be if a
    // faster leg landed first and a later, closer leg is still in flight).
    const existing: NearbyResult[] = [
      { ...makeResult({ id: "far", name: "Far Course", center: { lat: 41.0, lng: -74.0 } }), distanceMi: 20 },
      { ...makeResult({ id: "mid", name: "Mid Course", center: { lat: 40.8, lng: -73.5 } }), distanceMi: 5 },
    ];
    const incoming: CourseSearchResult[] = [
      makeResult({ id: "closest", name: "Closest Course", center: { lat: 40.745, lng: -73.46 } }),
    ];
    const result = appendNearby(existing, incoming, USER.lat, USER.lng);
    // Existing order is untouched — "far" still comes before "mid" — the new
    // (closer) row is appended at the END, not spliced in by distance.
    expect(result.map((r) => r.id)).toEqual(["far", "mid", "closest"]);
  });

  it("dedupes incoming against existing by courseNameKey", () => {
    const existing: NearbyResult[] = [
      { ...makeResult({ id: "mapped-1", name: "Bethpage Black", source: "mapped", center: { lat: 40.745, lng: -73.459 } }), distanceMi: 0.5 },
    ];
    const incoming: CourseSearchResult[] = [
      makeResult({ id: "osm-1", name: "bethpage, black!", source: "osm", center: { lat: 40.745, lng: -73.459 } }), // dupe by courseNameKey
      makeResult({ id: "osm-2", name: "Pebble Beach", source: "osm", center: { lat: 40.75, lng: -73.46 } }),
    ];
    const result = appendNearby(existing, incoming, USER.lat, USER.lng);
    expect(result.map((r) => r.id)).toEqual(["mapped-1", "osm-2"]);
  });

  it("sorts only the NEW rows among themselves by distance; existing rows are left as-is", () => {
    const existing: NearbyResult[] = [
      { ...makeResult({ id: "existing", name: "Existing Course", center: { lat: 41.0, lng: -74.0 } }), distanceMi: 20 },
    ];
    const incoming: CourseSearchResult[] = [
      makeResult({ id: "new-far", name: "New Far", center: { lat: 40.9, lng: -73.6 } }),
      makeResult({ id: "new-near", name: "New Near", center: { lat: 40.745, lng: -73.459 } }),
    ];
    const result = appendNearby(existing, incoming, USER.lat, USER.lng);
    expect(result.map((r) => r.id)).toEqual(["existing", "new-near", "new-far"]);
  });

  it("mapped-first tie-break among the new rows", () => {
    const existing: NearbyResult[] = [];
    const center = { lat: 40.75, lng: -73.46 };
    const incoming: CourseSearchResult[] = [
      makeResult({ id: "osm", name: "Twin Oaks OSM", source: "osm", center }),
      makeResult({ id: "mapped", name: "Twin Oaks Mapped", source: "mapped", center }),
    ];
    const result = appendNearby(existing, incoming, USER.lat, USER.lng);
    expect(result[0].id).toBe("mapped");
  });

  it(`caps the combined list at NEARBY_LIMIT (${NEARBY_LIMIT})`, () => {
    const existing: NearbyResult[] = Array.from({ length: NEARBY_LIMIT - 1 }, (_, i) => ({
      ...makeResult({ id: `existing-${i}`, name: `Existing ${i}` }),
      distanceMi: i,
    }));
    const incoming: CourseSearchResult[] = [
      makeResult({ id: "new-1", name: "New One", center: { lat: 40.745, lng: -73.459 } }),
      makeResult({ id: "new-2", name: "New Two", center: { lat: 40.75, lng: -73.46 } }),
      makeResult({ id: "new-3", name: "New Three", center: { lat: 40.8, lng: -73.5 } }),
    ];
    const result = appendNearby(existing, incoming, USER.lat, USER.lng);
    expect(result).toHaveLength(NEARBY_LIMIT);
    // The existing rows are preserved in full (no reshuffle); only ONE of the
    // three new rows fits under the cap.
    expect(result.slice(0, NEARBY_LIMIT - 1).map((r) => r.id)).toEqual(
      existing.map((r) => r.id)
    );
    expect(result[NEARBY_LIMIT - 1].id).toBe("new-1");
  });

  it("handles empty existing and empty incoming", () => {
    expect(appendNearby([], [], USER.lat, USER.lng)).toEqual([]);
  });

  it("respects a custom limit argument", () => {
    const existing: NearbyResult[] = [
      { ...makeResult({ id: "a", name: "A" }), distanceMi: 1 },
    ];
    const incoming: CourseSearchResult[] = [
      makeResult({ id: "b", name: "B", center: { lat: 40.75, lng: -73.46 } }),
      makeResult({ id: "c", name: "C", center: { lat: 40.76, lng: -73.47 } }),
    ];
    const result = appendNearby(existing, incoming, USER.lat, USER.lng, 2);
    expect(result).toHaveLength(2);
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

// ---------------------------------------------------------------------------
// dedupeIdleSections — Favorites / Recent / Nearby cross-section dedupe
// ---------------------------------------------------------------------------

describe("dedupeIdleSections", () => {
  it("drops a Recent entry already present as a Favorite (by name)", () => {
    const favorites = [{ name: "Bethpage Black" }];
    const recent = [{ name: "bethpage, black!" }, { name: "Pebble Beach" }];
    const nearby: { name: string }[] = [];
    const result = dedupeIdleSections(favorites, recent, nearby);
    expect(result.recent.map((r) => r.name)).toEqual(["Pebble Beach"]);
  });

  it("drops a Nearby entry already present as a Favorite or Recent", () => {
    const favorites = [{ name: "Bethpage Black" }];
    const recent = [{ name: "Pebble Beach" }];
    const nearby = [
      { name: "Bethpage Black" }, // dupes a favorite
      { name: "pebble beach" }, // dupes recent (case-insensitive)
      { name: "Torrey Pines" }, // unique — survives
    ];
    const result = dedupeIdleSections(favorites, recent, nearby);
    expect(result.nearby.map((n) => n.name)).toEqual(["Torrey Pines"]);
  });

  it("always returns favorites in full, untouched", () => {
    const favorites = [{ name: "Bethpage Black" }, { name: "Bethpage Black" }];
    const result = dedupeIdleSections(favorites, [], []);
    expect(result.favorites).toHaveLength(2);
  });

  it("handles all-empty input", () => {
    const result = dedupeIdleSections([], [], []);
    expect(result).toEqual({ favorites: [], recent: [], nearby: [] });
  });

  it("no overlap — everything passes through unchanged", () => {
    const favorites = [{ name: "A" }];
    const recent = [{ name: "B" }];
    const nearby = [{ name: "C" }];
    const result = dedupeIdleSections(favorites, recent, nearby);
    expect(result.recent).toEqual(recent);
    expect(result.nearby).toEqual(nearby);
  });
});

// ---------------------------------------------------------------------------
// buildRowSubline — one consolidated subline idiom for every CourseRow
// ---------------------------------------------------------------------------

describe("buildRowSubline", () => {
  it("prefers city/state when present", () => {
    expect(
      buildRowSubline({ name: "Bethpage Black", clubName: "Bethpage State Park", city: "Farmingdale", state: "NY" })
    ).toBe("Farmingdale, NY");
  });

  it("falls back to clubName when there's no city/state and it differs from the name", () => {
    expect(buildRowSubline({ name: "Bethpage Black", clubName: "Bethpage State Park" })).toBe(
      "Bethpage State Park"
    );
  });

  it("omits clubName when it equals the name (no redundant echo)", () => {
    expect(buildRowSubline({ name: "Pebble Beach", clubName: "Pebble Beach" })).toBe("");
  });

  it("appends distance and source label, in order, joined by middot", () => {
    expect(
      buildRowSubline({
        name: "Bethpage Black",
        city: "Farmingdale",
        state: "NY",
        distanceMi: 2.3,
        sourceLabel: "MAPPED",
      })
    ).toBe("Farmingdale, NY · 2.3 mi · MAPPED");
  });

  it("distance-only (no location, no clubName distinct from name)", () => {
    expect(buildRowSubline({ name: "X", distanceMi: 0.4 })).toBe("0.4 mi");
  });

  it("returns empty string when nothing applies", () => {
    expect(buildRowSubline({})).toBe("");
  });
});

// ---------------------------------------------------------------------------
// resultSourceLabel
// ---------------------------------------------------------------------------

describe("resultSourceLabel", () => {
  it("prefers the real backend sourceLabel when present", () => {
    expect(resultSourceLabel({ source: "google_places", sourceLabel: "Google" })).toBe("Google");
  });

  it("falls back to 'mapped' for mapped-source rows with no explicit label", () => {
    expect(resultSourceLabel({ source: "mapped" })).toBe("mapped");
  });

  it("returns undefined for other sources with no explicit label", () => {
    expect(resultSourceLabel({ source: "osm" })).toBeUndefined();
    expect(resultSourceLabel({ source: "golfapi" })).toBeUndefined();
    expect(resultSourceLabel({})).toBeUndefined();
  });
});
