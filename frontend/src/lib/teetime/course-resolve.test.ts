// course-resolve.ts — the voice course-resolution decision table
// (specs/course-selection-ux-plan.md §A.2.2). A stubbed unified search drives
// every branch without network I/O: one / ambiguous / none / timeout, plus the
// exact-facility-name dominance rule that keeps a same-name different-facility
// course from ever being silently auto-added.

import { describe, it, expect } from "vitest";
import { resolveSpokenCourse } from "./course-resolve";
import type { CourseSearchResult } from "@/lib/golf-api";

function hit(overrides: Partial<CourseSearchResult> & { name: string }): CourseSearchResult {
  return {
    id: overrides.id ?? overrides.name.toLowerCase().replace(/\s+/g, "-"),
    source: "local",
    center: { lat: 40.6, lng: -73.9 },
    ...overrides,
  };
}

/** A stub `search` returning fixed rows, ignoring the query (the real
 *  prefix-gate lives in searchAllCourses, which the stub replaces). */
function stubSearch(rows: CourseSearchResult[]) {
  return async () => rows;
}

const BROOKLYN = { lat: 40.6, lng: -73.9 };
const PITTSBURGH = { lat: 40.44, lng: -79.99 };

describe("resolveSpokenCourse — decision table", () => {
  it('single placeable hit → "one" with that course', async () => {
    const r = await resolveSpokenCourse("marine park", PITTSBURGH, {
      search: stubSearch([
        hit({ name: "Marine Park Golf Course", address: "Brooklyn, NY", center: BROOKLYN }),
      ]),
    });
    expect(r.kind).toBe("one");
    if (r.kind === "one") {
      expect(r.course.name).toBe("Marine Park Golf Course");
      expect(r.course.center).toEqual(BROOKLYN);
      expect(r.course.location).toBe("Brooklyn, NY");
    }
  });

  it('a UNIQUE exact facility-name match dominates weaker prefix hits → "one"', async () => {
    // "Pebble Beach" exactly names "Pebble Beach Golf Links" (golf/links are
    // generic); "Pebble Beach Lake Course" carries an extra identifying token,
    // so it is NOT exact and must not turn this into a question.
    const r = await resolveSpokenCourse("pebble beach", null, {
      search: stubSearch([
        hit({ name: "Pebble Beach Golf Links" }),
        hit({ name: "Pebble Beach Lake Course" }),
      ]),
    });
    expect(r.kind).toBe("one");
    if (r.kind === "one") expect(r.course.name).toBe("Pebble Beach Golf Links");
  });

  it('two facilities matching the SAME spoken name exactly → "ambiguous" (never auto-add)', async () => {
    const r = await resolveSpokenCourse("marine park", PITTSBURGH, {
      search: stubSearch([
        hit({ name: "Marine Park Golf Course", address: "Brooklyn, NY", center: BROOKLYN }),
        hit({ name: "Marine Park Golf Course", address: "Somewhere, CA", center: { lat: 34, lng: -118 } }),
      ]),
    });
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.candidates).toHaveLength(2);
      // origin-ranked nearest-first: Brooklyn (near Pittsburgh) leads California.
      expect(r.candidates[0].localityLabel).toContain("Brooklyn");
    }
  });

  it('several distinct facilities, none exact → "ambiguous" (2–4, capped)', async () => {
    const r = await resolveSpokenCourse("lincoln", null, {
      search: stubSearch([
        hit({ name: "Lincoln Park Golf Course", address: "San Francisco, CA" }),
        hit({ name: "Lincoln Hills Golf Club", address: "Lincoln, CA" }),
        hit({ name: "Lincoln Homestead State Park", address: "Springfield, KY" }),
        hit({ name: "Lincoln Greens Golf Course", address: "Springfield, IL" }),
        hit({ name: "Lincolnshire Fields", address: "Champaign, IL" }),
      ]),
    });
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.candidates).toHaveLength(4); // MAX_AMBIGUOUS_CANDIDATES
  });

  it('zero hits → "none"', async () => {
    const r = await resolveSpokenCourse("nonexistent muni", PITTSBURGH, { search: stubSearch([]) });
    expect(r.kind).toBe("none");
  });

  it('hits without a center are not placeable → "none" (never guess a location)', async () => {
    const r = await resolveSpokenCourse("marine park", PITTSBURGH, {
      search: stubSearch([hit({ name: "Marine Park Golf Course", center: undefined })]),
    });
    expect(r.kind).toBe("none");
  });

  it('a blank name never searches → "none"', async () => {
    let called = false;
    const r = await resolveSpokenCourse("   ", null, {
      search: async () => {
        called = true;
        return [];
      },
    });
    expect(r.kind).toBe("none");
    expect(called).toBe(false);
  });

  it('search slower than the timeout → "unreachable" (never hangs the turn)', async () => {
    const slow = () =>
      new Promise<CourseSearchResult[]>((resolve) =>
        setTimeout(() => resolve([hit({ name: "Marine Park Golf Course" })]), 60),
      );
    const r = await resolveSpokenCourse("marine park", null, { search: slow, timeoutMs: 5 });
    expect(r.kind).toBe("unreachable");
  });

  it('a search that throws → "unreachable" (honest, never crashes the turn)', async () => {
    const r = await resolveSpokenCourse("marine park", null, {
      search: async () => {
        throw new Error("network down");
      },
    });
    expect(r.kind).toBe("unreachable");
  });
});
