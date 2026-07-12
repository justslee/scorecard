import { describe, it, expect } from "vitest";
import {
  deriveHighlightAction,
  highlightMarkerFor,
  boundsToBBox,
  SCOUT_MAP_STYLES,
} from "./scout-map-config";

describe("deriveHighlightAction", () => {
  it("null, null → none", () => {
    expect(deriveHighlightAction(null, null)).toBe("none");
  });

  it("A, null → remove", () => {
    expect(deriveHighlightAction("A", null)).toBe("remove");
  });

  it("null, A → add", () => {
    expect(deriveHighlightAction(null, "A")).toBe("add");
  });

  it("A, A → none (already highlighted, no churn)", () => {
    expect(deriveHighlightAction("A", "A")).toBe("none");
  });

  it("A, B → replace", () => {
    expect(deriveHighlightAction("A", "B")).toBe("replace");
  });
});

describe("highlightMarkerFor", () => {
  it("builds a 40x40 marker with the scaled anchor, zIndex 2, title = name, reusing course-flag.png", () => {
    const marker = highlightMarkerFor({
      name: "Marine Park Golf Course",
      center: { lat: 40.59, lng: -73.93 },
    });
    expect(marker).toEqual({
      coordinate: { lat: 40.59, lng: -73.93 },
      iconUrl: "assets/course-flag.png",
      iconSize: { width: 40, height: 40 },
      iconAnchor: { x: 8, y: 40 },
      zIndex: 2,
      title: "Marine Park Golf Course",
    });
  });
});

describe("boundsToBBox", () => {
  it("maps southwest/northeast → {swLat,swLng,neLat,neLng}", () => {
    const b = {
      southwest: { lat: 40.5, lng: -74.1 },
      northeast: { lat: 40.7, lng: -73.9 },
    };
    expect(boundsToBBox(b)).toEqual({
      swLat: 40.5,
      swLng: -74.1,
      neLat: 40.7,
      neLng: -73.9,
    });
  });
});

describe("SCOUT_MAP_STYLES invariants", () => {
  it("every rule targets only poi, poi.business, or transit", () => {
    const allowed = new Set(["poi", "poi.business", "transit"]);
    for (const rule of SCOUT_MAP_STYLES) {
      expect(rule.featureType).toBeDefined();
      expect(allowed.has(rule.featureType as string)).toBe(true);
    }
  });

  it("every styler is visibility: off", () => {
    for (const rule of SCOUT_MAP_STYLES) {
      expect(rule.stylers).toBeDefined();
      for (const styler of rule.stylers ?? []) {
        expect(styler).toEqual({ visibility: "off" });
      }
    }
  });

  it("no rule targets road, water, administrative, or bare 'all' (guards against blanket label-hiding regressions)", () => {
    const banned = new Set(["road", "water", "administrative", "all"]);
    for (const rule of SCOUT_MAP_STYLES) {
      expect(banned.has(rule.featureType as string)).toBe(false);
      expect(rule.featureType).not.toBeUndefined();
    }
  });
});
