/**
 * Unit tests for the nearby-course → prefs CourseOption mapping, the
 * radius/merge/add helpers, and the honest load-state machine.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// fetchNearbyCourseOptions dynamically imports golf-api; mock it so the
// wrapper tests run without the real network client.
vi.mock("@/lib/golf-api", () => ({
  searchNearbyDetailed: vi.fn(),
}));

import type { CourseSearchResult } from "@/lib/golf-api";
import { searchNearbyDetailed } from "@/lib/golf-api";
import {
  toCourseOptions,
  muniFromAddress,
  localityLabel,
  muniEchoesName,
  haversineMiles,
  MAX_COURSE_OPTIONS,
  radiusMetersForMiles,
  MIN_RADIUS_METERS,
  MAX_RADIUS_METERS,
  mergeCourseOptions,
  reconcileCourseOptions,
  addCourseOption,
  courseOptionFromSelection,
  loadStateAfterLocate,
  loadStateAfterFetch,
  emptyCoursesNote,
  fetchNearbyCourseOptions,
  createCourseFetchSession,
  type CourseOption,
} from "./courses";

// Golfer in central SF.
const ORIGIN = { lat: 37.7749, lng: -122.4194 };

function result(overrides: Partial<CourseSearchResult> & { id: string; name: string }): CourseSearchResult {
  return { source: "osm", center: { lat: 37.78, lng: -122.46 }, ...overrides };
}

describe("haversineMiles", () => {
  it("computes a plausible SF-scale distance", () => {
    // Presidio GC is roughly 3–4 miles from downtown SF.
    const d = haversineMiles(ORIGIN.lat, ORIGIN.lng, 37.7907, -122.4611);
    expect(d).toBeGreaterThan(2);
    expect(d).toBeLessThan(5);
  });
});

describe("muniFromAddress", () => {
  it("pulls the city from a street address", () => {
    expect(muniFromAddress("300 Finley Rd, San Francisco, CA 94129")).toBe("San Francisco");
  });

  it("handles city-only and empty addresses", () => {
    expect(muniFromAddress("Pacifica, CA")).toBe("Pacifica");
    expect(muniFromAddress(undefined)).toBe("");
    expect(muniFromAddress("")).toBe("");
  });

  it("drops a 'USA' country suffix, not just 'United States' (plan §8 #4)", () => {
    expect(muniFromAddress("300 Finley Rd, San Francisco, CA 94129, USA")).toBe("San Francisco");
  });

  it("drops a 'United States of America' country suffix", () => {
    expect(muniFromAddress("300 Finley Rd, San Francisco, CA 94129, United States of America")).toBe("San Francisco");
  });

  it("still drops the plain 'United States' suffix (regression)", () => {
    expect(muniFromAddress("300 Finley Rd, San Francisco, CA 94129, United States")).toBe("San Francisco");
  });

  it("never mistakes a real locality for a country label (anchored, not substring)", () => {
    // A town whose name merely CONTAINS a country-ish substring must survive —
    // the filter matches the WHOLE segment, never a substring.
    expect(muniFromAddress("100 Main St, Unity, OH 44685, USA")).toBe("Unity");
  });

  // --- Pseudo-locality guard: a LONE surviving segment that is plainly a
  // venue/street is not a town — omit it rather than surface it as the city. ---
  it("omits a lone venue segment (no real city in the address)", () => {
    // "Bethpage State Park" is the whole address — a venue, not a locality.
    expect(muniFromAddress("Bethpage State Park")).toBe("");
    expect(muniFromAddress("Marine Park Golf Course")).toBe("");
    expect(muniFromAddress("Presidio Golf Club")).toBe("");
  });

  it("omits a lone street segment (a road name is not a town)", () => {
    expect(muniFromAddress("Finley Road")).toBe(""); // whole-word "Road" suffix → street, not a town
    expect(muniFromAddress("Skyline Blvd")).toBe(""); // street-suffix guard, no leading number involved
    expect(muniFromAddress("100 Skyline Blvd")).toBe(""); // whole segment starts with a digit → dropped outright
  });

  it("keeps a real city even when a street/venue segment precedes it (≥2 segments)", () => {
    // The guard only fires for a LONE segment — with a real city present the
    // last cityish segment is a town and must never be dropped.
    expect(muniFromAddress("Marine Park Golf Course, Brooklyn, NY, USA")).toBe("Brooklyn");
    expect(muniFromAddress("Finley Rd, San Francisco, CA 94129")).toBe("San Francisco");
  });

  it("never regresses real one/two-word cities that resemble nothing venue-y", () => {
    expect(muniFromAddress("Brooklyn")).toBe("Brooklyn");
    expect(muniFromAddress("Tenafly")).toBe("Tenafly");
    expect(muniFromAddress("San Francisco")).toBe("San Francisco");
    expect(muniFromAddress("Los Angeles")).toBe("Los Angeles");
    expect(muniFromAddress("Menlo Park")).toBe("Menlo Park"); // "Park" alone is NOT a venue token
    expect(muniFromAddress("Oak Park")).toBe("Oak Park");
    // Real municipalities that contain the whole word "Club" must survive —
    // bare "club" is NOT a venue token (golf venues carry golf/course/links).
    expect(muniFromAddress("Country Club Hills")).toBe("Country Club Hills");
    expect(muniFromAddress("100 Main St, Country Club Hills, IL 60478, USA")).toBe("Country Club Hills");
  });
});

describe("muniEchoesName", () => {
  it("flags a muni that just repeats the course name (either direction)", () => {
    expect(muniEchoesName("Tenafly", "Tenafly")).toBe(true);
    expect(muniEchoesName("San Francisco Golf Club", "San Francisco")).toBe(true); // muni ⊂ name
    expect(muniEchoesName("Marine Park", "Marine Park Golf Course")).toBe(true);    // name ⊂ muni
  });

  it("does NOT flag a real, distinct locality", () => {
    expect(muniEchoesName("Marine Park Golf Course", "Brooklyn")).toBe(false);
    expect(muniEchoesName("Bethpage Black", "Farmingdale")).toBe(false);
  });

  it("is token-based, so a shared substring never collides (York ≠ Yorktown)", () => {
    expect(muniEchoesName("Yorktown Golf Course", "York")).toBe(false);
  });

  it("returns false for an empty muni", () => {
    expect(muniEchoesName("Anything", "")).toBe(false);
  });
});

describe("localityLabel", () => {
  it("returns an honest town from an address", () => {
    expect(localityLabel("Bethpage Black", "99 Quaker Meeting House Rd, Farmingdale, NY, USA")).toBe("Farmingdale");
  });

  it("omits a locality that would just echo the course name (no 'Course · Course')", () => {
    // The classic duplication: the only address segment is the venue itself.
    expect(localityLabel("Marine Park Golf Course", "Marine Park Golf Course")).toBe("");
    // A city-named course in its own city: "Tenafly · Tenafly" → "Tenafly · —".
    expect(localityLabel("Tenafly", "Tenafly, NJ, USA")).toBe("");
  });

  it("keeps a real, distinct locality (never over-omits)", () => {
    expect(localityLabel("Marine Park Golf Course", "Marine Park Golf Course, Brooklyn, NY, USA")).toBe("Brooklyn");
  });

  it("returns '' when there is no honest locality", () => {
    expect(localityLabel("Some Course", undefined)).toBe("");
    expect(localityLabel("Some Course", "USA")).toBe("");
  });
});

describe("toCourseOptions", () => {
  it("maps results with honest distances, sorted nearest-first", () => {
    const options = toCourseOptions(
      [
        result({ id: "far", name: "Far Course", center: { lat: 38.0, lng: -122.5 } }),
        result({ id: "near", name: "Near Course", center: { lat: 37.7907, lng: -122.4611 } }),
      ],
      ORIGIN,
    );
    expect(options.map((o) => o.id)).toEqual(["near", "far"]);
    expect(options[0].distance).toBeGreaterThan(0);
    expect(options[0].distance).toBeLessThan(options[1].distance ?? 0);
  });

  it("skips results without a name or center", () => {
    const options = toCourseOptions(
      [
        result({ id: "ok", name: "Real Course" }),
        result({ id: "no-center", name: "Mystery", center: undefined }),
        result({ id: "no-name", name: "" }),
      ],
      ORIGIN,
    );
    expect(options.map((o) => o.id)).toEqual(["ok"]);
  });

  it("rejects a junk row whose name carries no identifying token", () => {
    const options = toCourseOptions(
      [
        result({ id: "junk", name: "Golf Course" }),          // all-stopword — filtered
        result({ id: "real", name: "Presidio Golf Course" }), // "presidio" survives — kept
      ],
      ORIGIN,
    );
    expect(options.map((o) => o.id)).toEqual(["real"]);
  });

  it("de-duplicates by name and caps the list", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      result({ id: `c${i}`, name: `Course ${i}` })
    );
    const options = toCourseOptions(
      [...many, result({ id: "dupe", name: "Course 0" })],
      ORIGIN,
    );
    expect(options).toHaveLength(MAX_COURSE_OPTIONS);
    expect(options.filter((o) => o.name === "Course 0")).toHaveLength(1);
  });

  it("pre-selects the nearest 3 when the golfer has no favorites nearby", () => {
    const options = toCourseOptions(
      Array.from({ length: 5 }, (_, i) =>
        result({ id: `c${i}`, name: `Course ${i}`, center: { lat: 37.78 + i * 0.02, lng: -122.46 } })
      ),
      ORIGIN,
    );
    expect(options.filter((o) => o.selected)).toHaveLength(3);
    expect(options.slice(0, 3).every((o) => o.selected)).toBe(true);
  });

  it("flags + pre-selects favorited courses (matched by id or name)", () => {
    const options = toCourseOptions(
      [
        result({ id: "a", name: "Alpha Links" }),
        result({ id: "b", name: "Bravo Golf Club", center: { lat: 37.8, lng: -122.5 } }),
        result({ id: "c", name: "Charlie Muni", center: { lat: 37.82, lng: -122.52 } }),
      ],
      ORIGIN,
      [{ id: "b", name: "Bravo Golf Club" }],
    );
    const bravo = options.find((o) => o.id === "b")!;
    expect(bravo.favorite).toBe(true);
    expect(bravo.selected).toBe(true);
    expect(options.filter((o) => o.selected)).toHaveLength(1);
  });

  it("includes a real favorite beyond the results with an honest distance", () => {
    // Golfer in SF; favorite is Bethpage Black in NY (~2500 mi) with a stored center.
    const options = toCourseOptions(
      [result({ id: "near", name: "Near Course" })],
      ORIGIN,
      [{ id: "fav-far", name: "Bethpage Black", center: { lat: 40.745, lng: -73.456 } }],
    );
    const fav = options.find((o) => o.id === "fav-far")!;
    expect(fav.favorite).toBe(true);
    expect(fav.selected).toBe(true);
    expect(fav.distance).toBeGreaterThan(2000);
    // The nearby course is still listed (and pre-selected as nearest).
    expect(options.find((o) => o.id === "near")!.selected).toBe(true);
  });

  it("omits out-of-results favorites without a stored center (never a fake distance)", () => {
    const options = toCourseOptions(
      [result({ id: "near", name: "Near Course" })],
      ORIGIN,
      [{ id: "fav-nowhere", name: "Mystery Club" }],
    );
    expect(options.find((o) => o.id === "fav-nowhere")).toBeUndefined();
  });

  it("does not duplicate a favorite that's already in the results", () => {
    const options = toCourseOptions(
      [result({ id: "b", name: "Bravo Golf Club", center: { lat: 37.8, lng: -122.5 } })],
      ORIGIN,
      [{ id: "b", name: "Bravo Golf Club", center: { lat: 37.8, lng: -122.5 } }],
    );
    expect(options.filter((o) => o.name === "Bravo Golf Club")).toHaveLength(1);
  });

  it("guards the raw provider 'city' fallback — a country-only value never leaks as a muni (item 3)", () => {
    const options = toCourseOptions(
      [result({ id: "usa-city", name: "Presidio Golf Course", address: undefined, city: "USA" })],
      ORIGIN,
    );
    expect(options.find((o) => o.id === "usa-city")?.muni).toBe("");
  });

  it("keeps a real provider 'city' field as the muni fallback when there's no address", () => {
    const options = toCourseOptions(
      [result({ id: "brooklyn", name: "Presidio Golf Course", address: undefined, city: "Brooklyn" })],
      ORIGIN,
    );
    expect(options.find((o) => o.id === "brooklyn")?.muni).toBe("Brooklyn");
  });

  it("omits a muni that just echoes the course name — never 'Tenafly · Tenafly'", () => {
    const options = toCourseOptions(
      [result({ id: "tenafly", name: "Tenafly", address: undefined, city: "Tenafly" })],
      ORIGIN,
    );
    const o = options.find((o) => o.id === "tenafly")!;
    expect(o.name).toBe("Tenafly");
    expect(o.muni).toBe("");
  });

  it("keeps a distinct real city as the muni (Marine Park GC → Brooklyn)", () => {
    const options = toCourseOptions(
      [result({ id: "mp", name: "Marine Park Golf Course", address: "Marine Park Golf Course, Brooklyn, NY, USA" })],
      ORIGIN,
    );
    expect(options.find((o) => o.id === "mp")?.muni).toBe("Brooklyn");
  });
});

describe("radiusMetersForMiles", () => {
  it("derives meters from the Max drive slider", () => {
    expect(radiusMetersForMiles(25)).toBe(25 * 1609);
    expect(radiusMetersForMiles(42)).toBe(42 * 1609);
  });

  it("clamps to the ceiling (~80km) and the floor", () => {
    expect(radiusMetersForMiles(50)).toBe(MAX_RADIUS_METERS);   // 80450 → 80000
    expect(radiusMetersForMiles(500)).toBe(MAX_RADIUS_METERS);
    expect(radiusMetersForMiles(0)).toBe(MIN_RADIUS_METERS);
    expect(radiusMetersForMiles(1)).toBe(MIN_RADIUS_METERS);
  });
});

// Shared fixtures for the merge/add tests.
function option(overrides: Partial<CourseOption> & { id: string; name: string }): CourseOption {
  return { muni: "", distance: 5, favorite: false, selected: false, ...overrides };
}

describe("mergeCourseOptions", () => {
  it("returns incoming untouched (with its pre-selects) when the list is empty", () => {
    const incoming = [option({ id: "a", name: "Alpha", selected: true })];
    expect(mergeCourseOptions([], incoming)).toBe(incoming);
  });

  it("preserves existing rows (order + selection) and appends only new courses", () => {
    const existing = [
      option({ id: "a", name: "Alpha", selected: true }),
      option({ id: "b", name: "Bravo", selected: false }),
    ];
    const merged = mergeCourseOptions(existing, [
      option({ id: "a2", name: "Alpha", selected: false }),         // dupe by name — dropped
      option({ id: "c", name: "Charlie", selected: true }),          // new — appended, unselected
      option({ id: "f", name: "Fav Club", favorite: true }),         // new favorite — appended selected
    ]);
    expect(merged.map((o) => o.id)).toEqual(["a", "b", "c", "f"]);
    expect(merged[0].selected).toBe(true);   // user's toggle survives
    expect(merged[2].selected).toBe(false);  // appended non-favorite arrives unselected
    expect(merged[3].selected).toBe(true);   // appended favorite arrives selected
  });

  it("returns the same array when nothing new arrives (no pointless re-render)", () => {
    const existing = [option({ id: "a", name: "Alpha" })];
    expect(mergeCourseOptions(existing, [option({ id: "a", name: "Alpha" })])).toBe(existing);
  });

  it("touched-guard: once the golfer has touched the list, additions NEVER auto-select — even favorites", () => {
    const existing = [option({ id: "a", name: "Alpha", selected: true })];
    const merged = mergeCourseOptions(
      existing,
      [option({ id: "f", name: "Fav Club", favorite: true })],
      { touched: true },
    );
    expect(merged.find((o) => o.id === "f")?.selected).toBe(false);
  });
});

describe("reconcileCourseOptions", () => {
  it("drops a far, unselected, non-favorite row when the radius shrinks", () => {
    const existing = [
      option({ id: "near", name: "Near", distance: 5 }),
      option({ id: "far", name: "Far", distance: 20 }),
    ];
    const next = reconcileCourseOptions(existing, existing, { maxMiles: 10 });
    expect(next.map((o) => o.id)).toEqual(["near"]);
  });

  it("keeps a far row the golfer explicitly selected", () => {
    const existing = [option({ id: "far", name: "Far", distance: 20, selected: true })];
    const next = reconcileCourseOptions(existing, existing, { maxMiles: 10 });
    expect(next.map((o) => o.id)).toEqual(["far"]);
  });

  it("keeps a far favorited row", () => {
    const existing = [option({ id: "far", name: "Far", distance: 20, favorite: true })];
    const next = reconcileCourseOptions(existing, existing, { maxMiles: 10 });
    expect(next.map((o) => o.id)).toEqual(["far"]);
  });

  it("keeps a hand-added row (distance null) regardless of the radius", () => {
    const existing = [option({ id: "hand", name: "Hand-added", distance: null })];
    const next = reconcileCourseOptions(existing, existing, { maxMiles: 1 });
    expect(next.map((o) => o.id)).toEqual(["hand"]);
  });

  it("a voice-widened far course (selected, beyond the OLD radius) survives a later shrink back", () => {
    // Simulates: voice names a far course → selected + radius widened to reach
    // it → golfer later drags "Max drive" back down. The named course must
    // still be there — never silently dropped.
    const existing = [option({ id: "far", name: "Far Course", distance: 30, selected: true })];
    const next = reconcileCourseOptions(existing, existing, { maxMiles: 15 });
    expect(next.map((o) => o.id)).toEqual(["far"]);
  });
});

describe("createCourseFetchSession", () => {
  it("applies the result for the live target", async () => {
    const seen: string[] = [];
    const session = createCourseFetchSession(
      { onResult: (_r, target) => seen.push(target.area) },
      async () => ({ options: [], failed: false }),
    );
    session.fetch({ area: "a", radius: 1000 }, 1, 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(["a"]);
  });

  it("drops a STALE result that resolves after a newer fetch superseded it", async () => {
    // Two fetches start back to back; the FIRST (older) resolves SECOND —
    // its result must never land over the newer one's.
    const seen: string[] = [];
    let resolveFirst!: (r: { options: never[]; failed: boolean }) => void;
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockImplementationOnce(async () => ({ options: [], failed: false }));

    const session = createCourseFetchSession(
      { onResult: (_r, target) => seen.push(target.area) },
      fetchFn,
    );
    session.fetch({ area: "old", radius: 1000 }, 1, 1);
    session.fetch({ area: "new", radius: 1000 }, 2, 2); // supersedes "old"
    await new Promise((r) => setTimeout(r, 0)); // let the "new" fetch settle first
    resolveFirst({ options: [], failed: false }); // the stale "old" fetch settles late
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toEqual(["new"]); // "old" never applied
  });

  it("cancel() drops any still-in-flight result", async () => {
    const seen: string[] = [];
    let resolve!: (r: { options: never[]; failed: boolean }) => void;
    const session = createCourseFetchSession(
      { onResult: (_r, target) => seen.push(target.area) },
      () => new Promise((r) => { resolve = r; }),
    );
    session.fetch({ area: "a", radius: 1000 }, 1, 1);
    session.cancel();
    resolve({ options: [], failed: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([]);
  });
});

describe("addCourseOption / courseOptionFromSelection", () => {
  it("shapes a picked course with an honest distance when center + origin exist", () => {
    const o = courseOptionFromSelection(
      { id: 42, name: "Bethpage Black", location: "Farmingdale, NY", center: { lat: 40.745, lng: -73.456 } },
      { lat: 40.75, lng: -73.6 },
    );
    expect(o.id).toBe("42");
    expect(o.muni).toBe("Farmingdale");
    expect(o.selected).toBe(true);
    expect(o.distance).toBeGreaterThan(5);
    expect(o.distance).toBeLessThan(15);
  });

  it("leaves distance unknown (null) when the center or origin is missing", () => {
    expect(courseOptionFromSelection({ id: "x", name: "No Center" }, { lat: 40, lng: -73 }).distance).toBeNull();
    expect(courseOptionFromSelection({ id: "x", name: "No Origin", center: { lat: 40, lng: -73 } }, null).distance).toBeNull();
  });

  it("omits a locality that just echoes the course name on the add-flow surface (no 'Tenafly · Tenafly')", () => {
    // The add flow goes through localityLabel, so the name-echo dedup applies
    // here too — not just in toCourseOptions.
    expect(courseOptionFromSelection({ id: "t", name: "Tenafly", location: "Tenafly, NJ, USA" }, null).muni).toBe("");
    // A distinct real locality is still kept.
    expect(courseOptionFromSelection({ id: "b", name: "Bethpage Black", location: "Farmingdale, NY" }, null).muni).toBe("Farmingdale");
  });

  it("appends a new course selected", () => {
    const next = addCourseOption([option({ id: "a", name: "Alpha" })], option({ id: "b", name: "Bravo" }));
    expect(next.map((o) => o.id)).toEqual(["a", "b"]);
    expect(next[1].selected).toBe(true);
  });

  it("de-dupes by normalized name — picking a listed course just selects it", () => {
    const existing = [option({ id: "a", name: "Bethpage Black", selected: false })];
    const next = addCourseOption(existing, option({ id: "other-id", name: "  bethpage black " }));
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe("a");
    expect(next[0].selected).toBe(true);
  });
});

describe("course-list load state machine", () => {
  it("locating → loading when any area is known, unlocated when none", () => {
    expect(loadStateAfterLocate("40.75,-73.5")).toBe("loading");
    expect(loadStateAfterLocate(null)).toBe("unlocated");
  });

  it("loading → failed only when all legs failed AND nothing came back", () => {
    expect(loadStateAfterFetch(true, 0)).toBe("failed");
    expect(loadStateAfterFetch(true, 2)).toBe("done");
    expect(loadStateAfterFetch(false, 0)).toBe("done");
    expect(loadStateAfterFetch(false, 5)).toBe("done");
  });

  it("empty-list copy is honest for every state — never fake data", () => {
    expect(emptyCoursesNote("locating", 25)).toMatch(/finding/i);
    expect(emptyCoursesNote("loading", 25)).toMatch(/finding/i);
    expect(emptyCoursesNote("done", 25)).toContain("within 25 miles");
    expect(emptyCoursesNote("failed", 25)).toMatch(/couldn.t reach/i);
    expect(emptyCoursesNote("unlocated", 25)).toMatch(/turn on location/i);
  });
});

describe("fetchNearbyCourseOptions", () => {
  const mockSearch = vi.mocked(searchNearbyDetailed);

  beforeEach(() => {
    mockSearch.mockReset();
  });

  it("maps results and reports failed:false while any leg is healthy", async () => {
    mockSearch.mockResolvedValue({
      results: [{ id: "osm-1", name: "Bethpage Black", source: "osm", center: { lat: 40.745, lng: -73.456 } }],
      mappedOk: false,
      osmOk: true,
    });
    const out = await fetchNearbyCourseOptions(40.75, -73.5, 40000);
    expect(out.failed).toBe(false);
    expect(out.options.map((o) => o.name)).toEqual(["Bethpage Black"]);
    expect(mockSearch).toHaveBeenCalledWith(40.75, -73.5, 40000);
  });

  it("reports failed:true when every leg is down", async () => {
    mockSearch.mockResolvedValue({ results: [], mappedOk: false, osmOk: false });
    const out = await fetchNearbyCourseOptions(40.75, -73.5, 40000);
    expect(out).toEqual({ options: [], failed: true });
  });

  it("never throws — an unexpected error comes back as failed:true", async () => {
    mockSearch.mockRejectedValue(new Error("boom"));
    const out = await fetchNearbyCourseOptions(40.75, -73.5, 40000);
    expect(out).toEqual({ options: [], failed: true });
  });
});
