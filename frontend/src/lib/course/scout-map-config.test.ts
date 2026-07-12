import { describe, it, expect } from "vitest";
import {
  deriveHighlightAction,
  highlightMarkerFor,
  boundsToBBox,
  SCOUT_MAP_STYLES,
  SCOUT_MAP_BASE_TONE,
  SCOUT_POI_SUPPRESSION,
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

describe("SCOUT_POI_SUPPRESSION invariants", () => {
  it("every rule targets only poi, poi.business, or transit", () => {
    const allowed = new Set(["poi", "poi.business", "transit"]);
    for (const rule of SCOUT_POI_SUPPRESSION) {
      expect(rule.featureType).toBeDefined();
      expect(allowed.has(rule.featureType as string)).toBe(true);
    }
  });

  it("every styler is visibility: off", () => {
    for (const rule of SCOUT_POI_SUPPRESSION) {
      expect(rule.stylers).toBeDefined();
      for (const styler of rule.stylers ?? []) {
        expect(styler).toEqual({ visibility: "off" });
      }
    }
  });

  it("no rule targets road, water, administrative, or bare 'all' (guards against blanket label-hiding regressions)", () => {
    const banned = new Set(["road", "water", "administrative", "all"]);
    for (const rule of SCOUT_POI_SUPPRESSION) {
      expect(banned.has(rule.featureType as string)).toBe(false);
      expect(rule.featureType).not.toBeUndefined();
    }
  });
});

describe("SCOUT_MAP_STYLES (composed) invariants", () => {
  it("is exactly base tone + POI suppression, in that order", () => {
    expect(SCOUT_MAP_STYLES).toEqual([...SCOUT_MAP_BASE_TONE, ...SCOUT_POI_SUPPRESSION]);
  });

  it("still turns poi labels off (labels only — park geometry survives)", () => {
    expect(SCOUT_MAP_STYLES).toContainEqual({
      featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }],
    });
  });

  it("still turns poi.business off", () => {
    expect(SCOUT_MAP_STYLES).toContainEqual({
      featureType: "poi.business", stylers: [{ visibility: "off" }],
    });
  });

  it("still turns transit off", () => {
    expect(SCOUT_MAP_STYLES).toContainEqual({
      featureType: "transit", stylers: [{ visibility: "off" }],
    });
  });

  it("never hides road/water/landscape/park GEOMETRY — retone, don't hide", () => {
    const guarded = /^(road|water|landscape|poi\.park)/;
    for (const rule of SCOUT_MAP_STYLES) {
      if (!guarded.test(rule.featureType ?? "")) continue;
      const hidesIt = (rule.stylers ?? []).some(
        (s) => (s as { visibility?: string }).visibility === "off",
      );
      if (hidesIt) {
        // Sole allowed exception: colorful route-shield icons.
        expect(rule.elementType).toBe("labels.icon");
      }
    }
  });
});

describe("SCOUT_MAP_BASE_TONE invariants", () => {
  it("every rule names an explicit featureType AND elementType (no bare-all rules)", () => {
    for (const rule of SCOUT_MAP_BASE_TONE) {
      expect(rule.featureType).toBeDefined();
      expect(rule.elementType).toBeDefined();
    }
  });

  it("every color styler is an opaque 6-digit hex — GMSMapStyle silently rejects rgba/oklch, which would ship the stock map", () => {
    for (const rule of SCOUT_MAP_BASE_TONE) {
      for (const styler of rule.stylers ?? []) {
        const color = (styler as { color?: string }).color;
        if (color !== undefined) expect(color).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("road hierarchy is a real ladder: highway fill darker than arterial darker than local", () => {
    const fillOf = (ft: string) =>
      SCOUT_MAP_BASE_TONE.find(
        (r) => r.featureType === ft && r.elementType === "geometry.fill",
      )?.stylers?.map((s) => (s as { color?: string }).color)[0] as string;
    const lum = (hex: string) =>
      parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    expect(lum(fillOf("road.highway"))).toBeLessThan(lum(fillOf("road.arterial")));
    expect(lum(fillOf("road.arterial"))).toBeLessThan(lum(fillOf("road.local")));
  });
});
