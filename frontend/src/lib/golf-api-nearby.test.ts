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

import { searchNearbyDetailed, type NearbyLegUpdate } from "@/lib/golf-api";
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

  // -------------------------------------------------------------------------
  // onLeg — progressive per-leg callback (search-speed-and-golfapi-verify-plan.md)
  // -------------------------------------------------------------------------

  describe("onLeg callback", () => {
    it("fires once per leg with that leg's own results and ok:true when both legs succeed", async () => {
      mockFetchAPI.mockImplementation(async (path: string) => {
        if (path.startsWith(MAPPED)) {
          return { courses: [{ id: "m-1", name: "Eisenhower Red", location: { lat: 40.74, lng: -73.44 } }] };
        }
        return { courses: [{ id: "osm-1", name: "Bethpage Black", center: { lat: 40.745, lng: -73.456 } }] };
      });

      const updates: NearbyLegUpdate[] = [];
      const out = await searchNearbyDetailed(40.75, -73.5, 40000, (u) => updates.push(u));

      expect(updates).toHaveLength(2);
      const byLeg = new Map(updates.map((u) => [u.leg, u]));
      expect(byLeg.get("mapped")?.ok).toBe(true);
      expect(byLeg.get("mapped")?.results.map((r) => r.id)).toEqual(["m-1"]);
      expect(byLeg.get("osm")?.ok).toBe(true);
      expect(byLeg.get("osm")?.results.map((r) => r.id)).toEqual(["osm-1"]);

      // Aggregate return is unchanged (back-compat) — order/contents intact.
      expect(out.mappedOk).toBe(true);
      expect(out.osmOk).toBe(true);
      expect(out.results.map((r) => r.id).sort()).toEqual(["m-1", "osm-1"]);
    });

    it("a down leg fires ok:false with an empty results array", async () => {
      mockFetchAPI.mockImplementation(async (path: string) => {
        if (path.startsWith(MAPPED)) throw new Error("mapped leg down");
        return { courses: [{ id: "osm-1", name: "Bethpage Black", center: { lat: 40.745, lng: -73.456 } }] };
      });

      const updates: NearbyLegUpdate[] = [];
      await searchNearbyDetailed(40.75, -73.5, 40000, (u) => updates.push(u));

      const byLeg = new Map(updates.map((u) => [u.leg, u]));
      expect(byLeg.get("mapped")?.ok).toBe(false);
      expect(byLeg.get("mapped")?.results).toEqual([]);
      expect(byLeg.get("osm")?.ok).toBe(true);
    });

    it("omitting onLeg does not throw and the aggregate return is unchanged", async () => {
      mockFetchAPI.mockResolvedValue({ courses: [] });
      const out = await searchNearbyDetailed(40.75, -73.5, 25000);
      expect(out).toEqual({ results: [], mappedOk: true, osmOk: true });
    });
  });
});
