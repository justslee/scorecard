/**
 * Unit tests for searchAllCourses() — course-search-v2 Work Item A: the old
 * 3-leg client fan-out (mapped + GolfAPI proxy + OSM) is collapsed into ONE
 * call to the backend's /api/courses/search (which now owns the full
 * pipeline: local DB → Google Places → internal GolfAPI leg → anchored OSM
 * fallback). Stubs `global.fetch` so these run offline/deterministically.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { searchAllCourses, type CourseSearchResult } from "./golf-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Build a fake fetch for /api/courses/search, with optional latency/status. */
function makeFakeFetch(opts: {
  body?: unknown;
  delayMs?: number;
  ok?: boolean;
  status?: number;
}) {
  const { body = { courses: [] }, delayMs = 0, ok = true, status = 200 } = opts;
  return vi.fn((url: string, init?: RequestInit) => {
    const signal = init?.signal;
    return new Promise<Response>((resolve, reject) => {
      const t = setTimeout(() => {
        if (signal?.aborted) {
          reject(Object.assign(new Error("aborted"), { name: signal.reason?.name || "AbortError" }));
          return;
        }
        resolve({
          ok,
          status,
          text: () => Promise.resolve(JSON.stringify(body)),
          json: () => Promise.resolve(body),
        } as Response);
      }, delayMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(Object.assign(new Error("aborted"), { name: signal.reason?.name || "AbortError" }));
      });
    });
  });
}

describe("searchAllCourses — single unified backend leg", () => {
  it("hits exactly ONE endpoint: /api/courses/search", async () => {
    const fetchMock = makeFakeFetch({
      body: { courses: [{ id: "1", name: "Bethpage Black", center: { lat: 1, lng: 2 }, source: "local" }] },
    });
    vi.stubGlobal("fetch", fetchMock);

    await searchAllCourses("bethpage");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/courses/search");
    expect(url).not.toContain("/api/courses/mapped");
  });

  it("maps courses + populates a per-row sourceLabel", async () => {
    vi.stubGlobal(
      "fetch",
      makeFakeFetch({
        body: {
          courses: [
            { id: "1", name: "Bethpage Black", center: { lat: 1, lng: 2 }, source: "local" },
            { id: "gplaces-2", name: "Bethpage Red", center: { lat: 1, lng: 2 }, source: "google_places" },
            { id: "golfapi-3", name: "Bethpage Green", center: { lat: 1, lng: 2 }, source: "golfapi" },
          ],
        },
      })
    );

    const results = await searchAllCourses("bethpage");

    const bySource = Object.fromEntries(results.map((r) => [r.source, r]));
    expect(bySource.local.sourceLabel).toBe("MAPPED");
    expect(bySource.google_places.sourceLabel).toBe("GOOGLE");
    expect(bySource.golfapi.sourceLabel).toBe("GOLFAPI");
  });

  it("delivers the batch via onResults (append-only, single batch)", async () => {
    vi.stubGlobal(
      "fetch",
      makeFakeFetch({
        body: { courses: [{ id: "1", name: "Bethpage Black", center: { lat: 1, lng: 2 }, source: "local" }] },
      })
    );

    const batches: CourseSearchResult[][] = [];
    const final = await searchAllCourses("bethpage", {
      onResults: (rows) => batches.push(rows),
    });

    expect(batches).toHaveLength(1);
    expect(batches[0].map((r) => r.name)).toEqual(["Bethpage Black"]);
    expect(final.map((r) => r.name)).toEqual(["Bethpage Black"]);
  });

  it("filters rows through the client-side prefix-relevance gate", async () => {
    vi.stubGlobal(
      "fetch",
      makeFakeFetch({
        body: {
          // Simulates a stale/unfiltered backend leaking a geocoder town —
          // must be dropped client-side even though the backend returned it.
          courses: [
            { id: "1", name: "Bethpage Black", center: { lat: 1, lng: 2 }, source: "local" },
            { id: "2", name: "Bethel Island", center: { lat: 1, lng: 2 }, source: "osm" },
          ],
        },
      })
    );

    const results = await searchAllCourses("bethpa");
    expect(results.map((r) => r.name)).toEqual(["Bethpage Black"]);
  });

  it("dedupes by normalized name, keeping the first occurrence", async () => {
    vi.stubGlobal(
      "fetch",
      makeFakeFetch({
        body: {
          courses: [
            { id: "1", name: "Bethpage Black", center: { lat: 1, lng: 2 }, source: "local" },
            { id: "2", name: "bethpage, black!", center: { lat: 1, lng: 2 }, source: "google_places" },
          ],
        },
      })
    );

    const results = await searchAllCourses("bethpage black");
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("local");
  });

  it("threads the caller's AbortSignal into the fetch call", async () => {
    const fetchMock = makeFakeFetch({
      body: { courses: [{ id: "1", name: "Bethpage Black" }] },
      delayMs: 20,
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

    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    // Aborted request must never deliver rows, and the search resolves
    // (never rejects) with whatever was already appended (nothing here).
    expect(onResults).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("resolves (not rejects) on a network/HTTP failure", async () => {
    vi.stubGlobal("fetch", makeFakeFetch({ ok: false, status: 500 }));
    await expect(searchAllCourses("bethpage")).resolves.toEqual([]);
  });
});
