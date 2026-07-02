/**
 * Unit tests for the nearby-course → prefs CourseOption mapping.
 */

import { describe, it, expect } from "vitest";
import type { CourseSearchResult } from "@/lib/golf-api";
import { toCourseOptions, muniFromAddress, haversineMiles, MAX_COURSE_OPTIONS } from "./courses";

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
    expect(options[0].distance).toBeLessThan(options[1].distance);
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
});
