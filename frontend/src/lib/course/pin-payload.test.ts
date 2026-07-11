import { describe, it, expect } from "vitest";
import { pinToSearchResult } from "./pin-payload";
import { resultToPayload } from "@/components/CourseSearch";
import { normalizeSource, sourceLabelFor, type CourseSearchResult, type InBoundsCourse } from "@/lib/golf-api";

/** Build a CourseSearchResult exactly as golf-api.ts's searchAllCourses row
 *  mapper does (golf-api.ts:558-570) from the same wire fields, so the test
 *  proves byte parity between the map path and the list path. */
function listPathResult(wire: { id: string; name: string; address?: string | null; center?: { lat: number; lng: number }; source: string }): CourseSearchResult {
  return {
    id: wire.id,
    name: wire.name,
    address: wire.address ?? undefined,
    center: wire.center,
    source: normalizeSource(wire.source),
    sourceLabel: sourceLabelFor(wire.source),
  };
}

describe("pinToSearchResult / resultToPayload — B.3 identity parity", () => {
  it("OSM pin: resultToPayload(pinToSearchResult(pin)) deep-equals the list path's payload for the same wire fields", () => {
    const pin: InBoundsCourse = {
      id: "u-1",
      name: "Marine Park GC",
      address: "Brooklyn, NY",
      center: { lat: 40.6, lng: -73.9 },
      source: "osm",
      osm_id: "way/9",
    };

    const viaMap = resultToPayload(pinToSearchResult(pin));
    const viaList = resultToPayload(listPathResult(pin));

    expect(viaMap).toEqual(viaList);
    expect(viaMap).toEqual({
      id: "u-1",
      name: "Marine Park GC",
      clubName: "Marine Park GC",
      clubId: "u-1",
      location: "Brooklyn, NY",
      source: "osm",
      center: { lat: 40.6, lng: -73.9 },
    });
  });

  it("local DB pin (address null → location undefined)", () => {
    const pin: InBoundsCourse = {
      id: "db-1",
      name: "Bethpage Black",
      address: null,
      center: { lat: 40.74, lng: -73.46 },
      source: "local",
    };

    const viaMap = resultToPayload(pinToSearchResult(pin));
    const viaList = resultToPayload(listPathResult(pin));

    expect(viaMap).toEqual(viaList);
    expect(viaMap.location).toBeUndefined();
  });

  it("unknown source string normalizes to 'local' (mirrors normalizeSource)", () => {
    const pin: InBoundsCourse = {
      id: "x-1",
      name: "Mystery Links",
      center: { lat: 41, lng: -74 },
      source: "google_places_unknown_variant",
    };

    const result = pinToSearchResult(pin);
    expect(result.source).toBe("local");
  });

  it("never fabricates golfApiClubId/golfApiCourseId — clubId derivation stays id", () => {
    const pin: InBoundsCourse = {
      id: "u-2",
      name: "Some Course",
      center: { lat: 1, lng: 2 },
      source: "osm",
    };
    const result = pinToSearchResult(pin);
    expect(result.golfApiClubId).toBeUndefined();
    expect(result.golfApiCourseId).toBeUndefined();
    expect(resultToPayload(result).clubId).toBe("u-2");
  });
});
