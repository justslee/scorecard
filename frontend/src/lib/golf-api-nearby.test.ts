/**
 * Unit tests for searchNearbyDetailed — the two nearby-search legs (mapped +
 * OSM) must fail independently and report per-leg health, so callers can tell
 * "no courses nearby" from "couldn't reach course search".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api", () => ({
  fetchAPI: vi.fn(),
  API_BASE: "http://test.local",
  authHeaders: vi.fn(async () => ({})),
}));

import { searchNearbyDetailed } from "@/lib/golf-api";
import { fetchAPI } from "@/lib/api";

const mockFetchAPI = vi.mocked(fetchAPI);

const MAPPED = "/api/courses/mapped/nearby";

beforeEach(() => {
  mockFetchAPI.mockReset();
});

describe("searchNearbyDetailed", () => {
  it("one leg down — the other leg's results still come back", async () => {
    mockFetchAPI.mockImplementation(async (path: string) => {
      if (path.startsWith(MAPPED)) throw new Error("mapped leg down");
      return { courses: [{ id: "osm-1", name: "Bethpage Black", center: { lat: 40.745, lng: -73.456 } }] };
    });

    const out = await searchNearbyDetailed(40.75, -73.5, 40000);
    expect(out.mappedOk).toBe(false);
    expect(out.osmOk).toBe(true);
    expect(out.results.map((r) => r.id)).toEqual(["osm-1"]);
  });

  it("both legs down — empty results, both flagged, no throw", async () => {
    mockFetchAPI.mockRejectedValue(new Error("network down"));

    const out = await searchNearbyDetailed(40.75, -73.5, 40000);
    expect(out.results).toEqual([]);
    expect(out.mappedOk).toBe(false);
    expect(out.osmOk).toBe(false);
  });

  it("both legs up — merged results, de-duped by name, both healthy", async () => {
    mockFetchAPI.mockImplementation(async (path: string) => {
      if (path.startsWith(MAPPED)) {
        return { courses: [{ id: "m-1", name: "Eisenhower Red", location: { lat: 40.74, lng: -73.44 } }] };
      }
      return {
        courses: [
          { id: "osm-1", name: "Eisenhower Red", center: { lat: 40.74, lng: -73.44 } },
          { id: "osm-2", name: "Bethpage Black", center: { lat: 40.745, lng: -73.456 } },
        ],
      };
    });

    const out = await searchNearbyDetailed(40.75, -73.5, 40000);
    expect(out.mappedOk).toBe(true);
    expect(out.osmOk).toBe(true);
    expect(out.results.map((r) => r.id).sort()).toEqual(["m-1", "osm-2"]);
  });

  it("passes the caller's radius through to both legs", async () => {
    mockFetchAPI.mockResolvedValue({ courses: [] });

    await searchNearbyDetailed(40.75, -73.5, 67578);
    const paths = mockFetchAPI.mock.calls.map((c) => c[0]);
    expect(paths).toHaveLength(2);
    for (const p of paths) {
      expect(p).toContain("radiusMeters=67578");
    }
  });
});
