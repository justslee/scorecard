/**
 * Unit tests for searchAllCourses() — the race-fix + append-only rendering +
 * client-side relevance filter (course-search-fix-plan.md, work item 2).
 *
 * Stubs `global.fetch` so these run offline/deterministically. `searchCourses`
 * (the GolfAPI leg) runs in node (no `window`), so it hits API_BASE directly
 * with the same stubbed fetch — no live network, no Clerk auth needed.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { searchAllCourses, type CourseSearchResult } from "./golf-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Build a fake fetch keyed by URL substring, with per-call latency so legs settle out of order. */
function makeFakeFetch(opts: {
  mapped?: unknown;
  osm?: unknown;
  golfapi?: unknown;
  delays?: { mapped?: number; osm?: number; golfapi?: number };
}) {
  const delays = opts.delays ?? {};
  return vi.fn((url: string, init?: RequestInit) => {
    const signal = init?.signal;
    const respond = (body: unknown, delayMs = 0) =>
      new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => {
          if (signal?.aborted) {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            return;
          }
          resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(body),
          } as Response);
        }, delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });

    if (typeof url === "string" && url.includes("/api/courses/mapped")) {
      return respond(opts.mapped ?? { courses: [] }, delays.mapped ?? 0);
    }
    if (typeof url === "string" && url.includes("/api/courses/search")) {
      return respond(opts.osm ?? { courses: [] }, delays.osm ?? 0);
    }
    // GolfAPI leg (either the proxy or golfapi.io directly, depending on `window`)
    return respond(opts.golfapi ?? { clubs: [] }, delays.golfapi ?? 0);
  });
}

describe("searchAllCourses — append-only progressive rendering", () => {
  it("delivers cumulative, never-shrinking batches as legs settle out of order", async () => {
    vi.stubGlobal(
      "fetch",
      makeFakeFetch({
        mapped: { courses: [{ id: "m1", name: "Bethpage Black", location: { lat: 1, lng: 2 } }] },
        osm: { courses: [{ id: "o1", name: "Bethpage Red", center: { lat: 1, lng: 2 } }] },
        golfapi: { clubs: [] },
        delays: { mapped: 5, osm: 30, golfapi: 15 },
      })
    );

    const batches: CourseSearchResult[][] = [];
    const final = await searchAllCourses("bethpage", {
      onResults: (rows) => batches.push(rows),
    });

    // Every recorded batch must be a superset (append-only prefix) of the previous one.
    for (let i = 1; i < batches.length; i++) {
      const prevNames = batches[i - 1].map((r) => r.name);
      const curNames = batches[i].map((r) => r.name);
      expect(curNames.slice(0, prevNames.length)).toEqual(prevNames);
    }

    const finalNames = final.map((r) => r.name).sort();
    expect(finalNames).toEqual(["Bethpage Black", "Bethpage Red"]);
    // Fast mapped leg must have produced the FIRST batch.
    expect(batches[0].map((r) => r.name)).toEqual(["Bethpage Black"]);
  });

  it("never removes or reorders already-delivered rows for the same query", async () => {
    vi.stubGlobal(
      "fetch",
      makeFakeFetch({
        mapped: {
          courses: [
            { id: "m1", name: "Bethpage Black", location: { lat: 1, lng: 2 } },
            { id: "m2", name: "Bethpage Green", location: { lat: 1, lng: 2 } },
          ],
        },
        osm: { courses: [{ id: "o1", name: "Bethpage Red", center: { lat: 1, lng: 2 } }] },
        delays: { mapped: 0, osm: 20 },
      })
    );

    const batches: string[][] = [];
    await searchAllCourses("bethpage", {
      onResults: (rows) => batches.push(rows.map((r) => r.name)),
    });

    expect(batches[0]).toEqual(["Bethpage Black", "Bethpage Green"]);
    expect(batches[batches.length - 1]).toEqual([
      "Bethpage Black",
      "Bethpage Green",
      "Bethpage Red",
    ]);
  });

  it("filters every leg's rows through the client-side prefix-relevance gate", async () => {
    vi.stubGlobal(
      "fetch",
      makeFakeFetch({
        mapped: {
          courses: [
            { id: "m1", name: "Bethpage Black", location: { lat: 1, lng: 2 } },
          ],
        },
        // Simulates a stale/unfiltered backend leaking a geocoder town — must be
        // dropped client-side even though the backend returned it.
        osm: { courses: [{ id: "o1", name: "Bethel Island", center: { lat: 1, lng: 2 } }] },
      })
    );

    const results = await searchAllCourses("bethpa", {});
    expect(results.map((r) => r.name)).toEqual(["Bethpage Black"]);
  });

  it("dedupes across legs by normalized name (mapped wins as it settles first)", async () => {
    vi.stubGlobal(
      "fetch",
      makeFakeFetch({
        mapped: { courses: [{ id: "m1", name: "Bethpage Black", location: { lat: 1, lng: 2 } }] },
        osm: { courses: [{ id: "o1", name: "bethpage, black!", center: { lat: 1, lng: 2 } }] },
        delays: { mapped: 0, osm: 10 },
      })
    );

    const results = await searchAllCourses("bethpage black", {});
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("mapped");
  });
});

describe("searchAllCourses — abort reaches every fetch leg", () => {
  it("threads the AbortSignal into the mapped, osm, and golfapi fetch calls", async () => {
    const fetchMock = makeFakeFetch({
      mapped: { courses: [{ id: "m1", name: "Bethpage Black" }] },
      osm: { courses: [{ id: "o1", name: "Bethpage Red" }] },
      golfapi: { clubs: [] },
      delays: { mapped: 20, osm: 20, golfapi: 20 },
    });
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const onResults = vi.fn();
    const resultPromise = searchAllCourses("bethpage", {
      signal: controller.signal,
      onResults,
    });

    controller.abort();
    const results = await resultPromise;

    // Every fetch call received a signal.
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    // Aborted request must never deliver rows.
    expect(onResults).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });
});
