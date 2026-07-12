/**
 * Unit tests for tee-shot-overlays.ts — the trust gate for the yardage-book
 * plate + bunker-carry overlays (specs/tee-shot-yardage-overlays-plan.md §9).
 *
 * Pure geometry — no browser APIs, no @capacitor/google-maps, no network.
 * Runs headlessly in Node via Vitest.
 *
 * Fixture strategy: real lat/lng coordinates built with a great-circle
 * `destPoint(origin, bearingDeg, distanceM)` helper (the mathematical inverse
 * of the Haversine formula `metersBetween` itself uses), so distances baked
 * into a fixture and distances measured back out by the module agree to
 * floating-point precision — a straight port of the "how do I know 245y is
 * really 245y" trust requirement into the test fixtures themselves.
 */

import { describe, it, expect } from 'vitest';
import {
  metersBetween,
  greenFirstCenterline,
  distanceMarkersFromGreen,
  fairwayBunkerCarries,
  computeTeeShotOverlays,
  teeShotOverlaysVisible,
  type LatLng,
} from './tee-shot-overlays';

// ── Fixture helpers ─────────────────────────────────────────────────────────

const YD = 0.9144; // metres per yard — mirrors the module's own constant

/** Great-circle destination point — the inverse of the Haversine distance
 *  formula `metersBetween` uses, so `metersBetween(origin, destPoint(origin,
 *  b, d)) === d` to floating-point precision. Lets fixtures bake in an exact
 *  intended distance. */
function destPoint(origin: LatLng, bearingDeg: number, distanceM: number): LatLng {
  const R = 6_371_000;
  const brng = (bearingDeg * Math.PI) / 180;
  const lat1 = (origin.lat * Math.PI) / 180;
  const lng1 = (origin.lng * Math.PI) / 180;
  const angDist = distanceM / R;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angDist) + Math.cos(lat1) * Math.sin(angDist) * Math.cos(brng)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(angDist) * Math.cos(lat1),
      Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2)
    );
  return { lat: (lat2 * 180) / Math.PI, lng: (lng2 * 180) / Math.PI };
}

/** Point `yards` due north of `origin` (bearing 0). */
function northOf(origin: LatLng, yards: number): LatLng {
  return destPoint(origin, 0, yards * YD);
}
/** Point `yards` due south of `origin` (bearing 180). */
function southOf(origin: LatLng, yards: number): LatLng {
  return destPoint(origin, 180, yards * YD);
}
/** Point `yards` due east of `origin` (negative = west). */
function eastOf(origin: LatLng, yards: number): LatLng {
  return destPoint(origin, 90, yards * YD);
}

function makeHoleLine(points: LatLng[]): GeoJSON.Feature {
  return {
    type: 'Feature',
    properties: { featureType: 'hole' },
    geometry: { type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat]) },
  };
}

function makeBunkerPolygon(points: LatLng[]): GeoJSON.Feature {
  const ring = [...points, points[0]].map((p) => [p.lng, p.lat]);
  return {
    type: 'Feature',
    properties: { featureType: 'bunker' },
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

function makeBunkerPoint(p: LatLng): GeoJSON.Feature {
  return {
    type: 'Feature',
    properties: { featureType: 'bunker' },
    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
  };
}

/** A straight hole: green center -> (offsetYards south) green edge (the
 *  `golf=hole` way's stored endpoint) -> (pathYards further south) tee. The
 *  hole LineString is stored TEE-FIRST (OSM convention). */
function buildStraightHole(
  pathYards: number,
  offsetYards: number,
  green: LatLng = { lat: 40.7, lng: -73.5 },
) {
  const greenEdge = southOf(green, offsetYards);
  const tee = southOf(greenEdge, pathYards);
  const holeFeature = makeHoleLine([tee, greenEdge]); // tee-first
  return { green, greenEdge, tee, holeFeature };
}

/** Perpendicular distance (yards) from `point` to the line segment a->b, in
 *  a local flat-earth metre frame (test-only helper — not the module's
 *  pinned frame, just precise enough to prove ">20y off a straight chord"). */
function perpDistanceYards(point: LatLng, a: LatLng, b: LatLng): number {
  const LAT_M = 111_320;
  const midLat = (a.lat + b.lat) / 2;
  const cosLat = Math.cos((midLat * Math.PI) / 180);
  const toXY = (p: LatLng): [number, number] => [
    (p.lng - a.lng) * LAT_M * cosLat,
    (p.lat - a.lat) * LAT_M,
  ];
  const [bx, by] = toXY(b);
  const [px, py] = toXY(point);
  const len = Math.hypot(bx, by) || 1;
  const cross = Math.abs(bx * py - by * px) / len;
  return cross / YD;
}

// ── 1. Straight 400y hole: plate accuracy + green-center offset ────────────

describe('1. straight 400y hole — plate accuracy validates the green-center offset', () => {
  it('places all three plates within +/-1y of their target, measured from green CENTER', () => {
    const { green, holeFeature } = buildStraightHole(400, 10);
    const centerline = greenFirstCenterline([holeFeature], green);
    expect(centerline).not.toBeNull();
    const markers = distanceMarkersFromGreen(centerline!, green);

    expect(markers.map((m) => m.yards)).toEqual([100, 150, 200]);
    for (const m of markers) {
      const actualYards = metersBetween(m.position, green) / YD;
      expect(Math.abs(actualYards - m.yards)).toBeLessThan(1);
    }
  });
});

// ── 2. Dogleg centerline — 200 plate on the second leg ──────────────────────

describe('2. dogleg centerline — the 200 plate lies on the second leg', () => {
  it('along-path distance = 200 AND perpendicular distance from the straight chord > 20y', () => {
    const green: LatLng = { lat: 40.65, lng: -73.5 };
    const corner = southOf(green, 130); // leg 1: green -> corner, 130y south
    const tee = eastOf(corner, 300); // leg 2: corner -> tee, 300y east (true dogleg)
    const holeFeature = makeHoleLine([tee, corner, green]); // tee-first

    const centerline = greenFirstCenterline([holeFeature], green);
    expect(centerline).not.toBeNull();
    const markers = distanceMarkersFromGreen(centerline!, green);

    const plate200 = markers.find((m) => m.yards === 200);
    expect(plate200).toBeDefined();

    // Along-path distance (green -> corner -> plate), NOT straight-line —
    // would differ sharply from the chord distance on a dogleg.
    const alongPathYards =
      (metersBetween(green, corner) + metersBetween(corner, plate200!.position)) / YD;
    expect(Math.abs(alongPathYards - 200)).toBeLessThan(1);

    // Would fail under any chord (tee->green straight line) fallback.
    const perp = perpDistanceYards(plate200!.position, tee, green);
    expect(perp).toBeGreaterThan(20);
  });
});

// ── 3. Too-short line: partial / single-plate omission ──────────────────────

describe('3. too-short line — omits plates beyond the path length', () => {
  it('160y centerline (+10y green offset) -> 100 & 150 only, 200 omitted', () => {
    const { green, holeFeature } = buildStraightHole(160, 10); // total reach 170y
    const centerline = greenFirstCenterline([holeFeature], green);
    const markers = distanceMarkersFromGreen(centerline!, green);
    expect(markers.map((m) => m.yards)).toEqual([100, 150]);
  });

  it('90y centerline (+15y green offset, total reach 105y) -> 100 only', () => {
    const { green, holeFeature } = buildStraightHole(90, 15); // total reach 105y
    const centerline = greenFirstCenterline([holeFeature], green);
    const markers = distanceMarkersFromGreen(centerline!, green);
    expect(markers.map((m) => m.yards)).toEqual([100]);
  });
});

// ── 4. No / degenerate centerline -> null ───────────────────────────────────

describe('4. no/degenerate centerline -> null (honest omission)', () => {
  it('no featureType:"hole" LineString at all -> null', () => {
    const green: LatLng = { lat: 40.7, lng: -73.5 };
    const notAHole: GeoJSON.Feature = {
      type: 'Feature',
      properties: { featureType: 'fairway' },
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 0], [0, 0], [0, 0]]] },
    };
    expect(greenFirstCenterline([notAHole], green)).toBeNull();
    expect(greenFirstCenterline([], green)).toBeNull();
  });

  it('green-end endpoint > 60y from green center -> null', () => {
    const green: LatLng = { lat: 40.7, lng: -73.5 };
    const greenEdge = southOf(green, 70); // 70y > 60y guard
    const tee = southOf(greenEdge, 300);
    const holeFeature = makeHoleLine([tee, greenEdge]);
    expect(greenFirstCenterline([holeFeature], green)).toBeNull();
  });
});

// ── 5. Reversed LineString — orientation-independent ────────────────────────

describe('5. reversed LineString (tee-first storage order) -> identical plates', () => {
  it('green-first orientation recovers the same plate positions either way', () => {
    const { green, greenEdge, tee } = buildStraightHole(400, 10);
    const teeFirst = makeHoleLine([tee, greenEdge]);
    const greenFirst = makeHoleLine([greenEdge, tee]);

    const markersA = distanceMarkersFromGreen(greenFirstCenterline([teeFirst], green)!, green);
    const markersB = distanceMarkersFromGreen(greenFirstCenterline([greenFirst], green)!, green);

    expect(markersA.length).toBe(markersB.length);
    for (let i = 0; i < markersA.length; i++) {
      expect(markersA[i].yards).toBe(markersB[i].yards);
      const driftYards = metersBetween(markersA[i].position, markersB[i].position) / YD;
      expect(driftYards).toBeLessThan(0.01);
    }
  });
});

// ── 5b. Plate honesty guard — offset way-end mislabels, must be OMITTED ─────

describe('5b. plate honesty guard — laterally-offset green-end way (collinear assumption broken)', () => {
  it('a way whose green-end is 40y EAST of green center (still inside the 60y guard) -> every plate omitted, not mislabeled', () => {
    const green: LatLng = { lat: 40.7, lng: -73.5 };
    // Stored green-end is 40y EAST of green center, not toward the tee — an
    // L-shaped/offset way. `greenFirstCenterline`'s 60y guard still passes
    // (40y < 60y), so this reaches the naive offset-subtraction walk.
    const greenEdge = eastOf(green, 40);
    const tee = southOf(greenEdge, 300);
    const holeFeature = makeHoleLine([tee, greenEdge]); // tee-first

    const centerline = greenFirstCenterline([holeFeature], green);
    expect(centerline).not.toBeNull();
    const markers = distanceMarkersFromGreen(centerline!, green);

    // `greenEdge` is 40y laterally offset from green center (not collinear
    // with the path's own direction) — the honesty guard catches this
    // up front and omits every plate for the hole. Left unguarded, the
    // naive walk would place, e.g., a "150" plate ~110y south of
    // `greenEdge` whose true distance to green center is
    // sqrt(40^2 + 110^2) ~= 117y — a ~33y mislabel.
    expect(markers).toEqual([]);
  });
});

// ── 6. Bunker front/back — chord and path agree on a straight hole ─────────

describe('6. bunker front/back carry — square ring straddling 230-260y at 15-25y lateral', () => {
  it('front 230, back 260, included — identical with and without a straight centerline', () => {
    const tee: LatLng = { lat: 40.6, lng: -73.5 };
    const green = northOf(tee, 450);
    const holeFeature = makeHoleLine([tee, green]);

    // Lateral range 15-25y — kept clear of the 10y LATERAL_DEADBAND_YARDS
    // edge (R3: a min-carry vertex sitting at exactly 10y lateral makes the
    // 'C' vs 'L'/'R' assertion fragile to benign floating-point noise).
    const corner = (alongYd: number, latYd: number) => eastOf(northOf(tee, alongYd), latYd);
    const bunker = makeBunkerPolygon([
      corner(230, 15),
      corner(230, 25),
      corner(260, 25),
      corner(260, 15),
    ]);

    const withPath = fairwayBunkerCarries({ features: [holeFeature, bunker], tee, green });
    const chordOnly = fairwayBunkerCarries({ features: [bunker], tee, green });

    expect(withPath).toHaveLength(1);
    expect(chordOnly).toHaveLength(1);
    expect(withPath[0].front).toBe(230);
    expect(withPath[0].back).toBe(260);
    // East of a due-north hole is the golfer's RIGHT hand.
    expect(withPath[0].side).toBe('R');
    expect(chordOnly[0]).toEqual(withPath[0]);
  });
});

// ── 7. Greenside exclusion ───────────────────────────────────────────────────

describe('7. greenside exclusion — close to green center even though carry is in range', () => {
  it('a bunker within 45y of green center is excluded despite carry in [100,330]', () => {
    const tee: LatLng = { lat: 40.55, lng: -73.5 };
    const green = northOf(tee, 300);
    const holeFeature = makeHoleLine([tee, green]);

    // Small ring hugging the green: along in [277,283], lateral in [-3,3].
    // min distance-to-green ≈ 17-23y (< 45y guard); front carry ≈ 277-283
    // (comfortably inside [100,330] — proves exclusion is the GREENSIDE
    // rule, not the floor/ceiling).
    const corner = (alongYd: number, latYd: number) => eastOf(northOf(tee, alongYd), latYd);
    const bunker = makeBunkerPolygon([
      corner(277, -3),
      corner(277, 3),
      corner(283, 3),
      corner(283, -3),
    ]);

    const result = fairwayBunkerCarries({ features: [holeFeature, bunker], tee, green });
    expect(result).toEqual([]);
  });
});

// ── 8. Corridor / floor / ceiling exclusion ─────────────────────────────────

describe('8. corridor + floor + ceiling exclusion', () => {
  it('70y lateral excluded; 60y and 360y carry excluded; an in-range control bunker survives', () => {
    const tee: LatLng = { lat: 40.5, lng: -73.5 };
    const green = northOf(tee, 450);
    const holeFeature = makeHoleLine([tee, green]);
    const corner = (alongYd: number, latYd: number) => eastOf(northOf(tee, alongYd), latYd);

    const corridorBunker = makeBunkerPolygon([
      corner(198, 68),
      corner(198, 72),
      corner(202, 72),
      corner(202, 68),
    ]); // 70y lateral -> excluded
    const floorBunker = makeBunkerPolygon([
      corner(58, 8),
      corner(58, 12),
      corner(62, 12),
      corner(62, 8),
    ]); // ~60y carry -> excluded (< 100y floor)
    const ceilingBunker = makeBunkerPolygon([
      corner(358, 8),
      corner(358, 12),
      corner(362, 12),
      corner(362, 8),
    ]); // ~360y carry -> excluded (> 330y ceiling)
    const controlBunker = makeBunkerPolygon([
      corner(198, 8),
      corner(198, 12),
      corner(202, 12),
      corner(202, 8),
    ]); // ~200y, 10y lateral -> included

    const result = fairwayBunkerCarries({
      features: [holeFeature, corridorBunker, floorBunker, ceilingBunker, controlBunker],
      tee,
      green,
    });

    expect(result).toHaveLength(1);
    expect(result[0].front).toBeGreaterThanOrEqual(195);
    expect(result[0].front).toBeLessThanOrEqual(205);
  });
});

// ── 8b. Floor/ceiling boundary — applied to RAW carry, not rounded display ──

describe('8b. floor/ceiling predicate uses the RAW carry, not the rounded display value', () => {
  it('raw front carry 98.5y (rounds to a 100y display) is still excluded — below the 100y floor', () => {
    const tee: LatLng = { lat: 40.48, lng: -73.5 };
    const green = northOf(tee, 450);
    const holeFeature = makeHoleLine([tee, green]);
    const corner = (alongYd: number, latYd: number) => eastOf(northOf(tee, alongYd), latYd);

    const bunker = makeBunkerPolygon([
      corner(98.5, 10),
      corner(98.5, 20),
      corner(101, 20),
      corner(101, 10),
    ]);

    const result = fairwayBunkerCarries({ features: [holeFeature, bunker], tee, green });
    expect(result).toEqual([]);
  });

  it('raw front carry 331.5y (rounds to a 330y display) is still excluded — above the 330y ceiling', () => {
    const tee: LatLng = { lat: 40.46, lng: -73.5 };
    const green = northOf(tee, 450);
    const holeFeature = makeHoleLine([tee, green]);
    const corner = (alongYd: number, latYd: number) => eastOf(northOf(tee, alongYd), latYd);

    const bunker = makeBunkerPolygon([
      corner(331.5, 10),
      corner(331.5, 20),
      corner(334, 20),
      corner(334, 10),
    ]);

    const result = fairwayBunkerCarries({ features: [holeFeature, bunker], tee, green });
    expect(result).toEqual([]);
  });
});

// ── 9. Centroid-only (Point) bunker -> skipped ──────────────────────────────

describe('9. centroid-only (Point) bunker -> skipped, never a fabricated range', () => {
  it('a Point-geometry bunker feature never appears in the result', () => {
    const tee: LatLng = { lat: 40.45, lng: -73.5 };
    const green = northOf(tee, 450);
    const holeFeature = makeHoleLine([tee, green]);
    const pointBunker = makeBunkerPoint(northOf(tee, 200));

    const result = fairwayBunkerCarries({ features: [holeFeature, pointBunker], tee, green });
    expect(result).toEqual([]);
  });
});

// ── 10. Rounding + equal-edge ────────────────────────────────────────────────

describe('10. rounding to nearest 5 + equal-edge (front === back)', () => {
  it('231.4/259.8 rounds to 230/260', () => {
    const tee: LatLng = { lat: 40.4, lng: -73.5 };
    const green = northOf(tee, 450);
    const holeFeature = makeHoleLine([tee, green]);
    const corner = (alongYd: number, latYd: number) => eastOf(northOf(tee, alongYd), latYd);

    const bunker = makeBunkerPolygon([
      corner(231.4, 10),
      corner(231.4, 20),
      corner(259.8, 20),
      corner(259.8, 10),
    ]);

    const result = fairwayBunkerCarries({ features: [holeFeature, bunker], tee, green });
    expect(result).toHaveLength(1);
    expect(result[0].front).toBe(230);
    expect(result[0].back).toBe(260);
  });

  it('a 4y-deep pot bunker renders front === back (no fake range)', () => {
    const tee: LatLng = { lat: 40.35, lng: -73.5 };
    const green = northOf(tee, 450);
    const holeFeature = makeHoleLine([tee, green]);
    const corner = (alongYd: number, latYd: number) => eastOf(northOf(tee, alongYd), latYd);

    const pot = makeBunkerPolygon([
      corner(248, 5),
      corner(248, 8),
      corner(252, 8),
      corner(252, 5),
    ]);

    const result = fairwayBunkerCarries({ features: [holeFeature, pot], tee, green });
    expect(result).toHaveLength(1);
    expect(result[0].front).toBe(result[0].back);
    expect(result[0].front).toBe(250);
  });
});

// ── 11. Cap at 4 by smallest lateral, sorted by front ───────────────────────

describe('11. cap at 4 — keeps the 4 smallest-lateral bunkers, sorted ascending by front', () => {
  it('6 qualifying bunkers -> 4 survive', () => {
    const tee: LatLng = { lat: 40.3, lng: -73.5 };
    const green = northOf(tee, 450);
    const holeFeature = makeHoleLine([tee, green]);
    const corner = (alongYd: number, latYd: number) => eastOf(northOf(tee, alongYd), latYd);

    // (carry, lateral) pairs — the 4 with SMALLEST |lateral| are 210(5),
    // 150(10), 270(15), 240(20); excluded: 120(30), 180(25).
    const pairs: Array<[number, number]> = [
      [120, 30],
      [150, 10],
      [180, 25],
      [210, 5],
      [240, 20],
      [270, 15],
    ];
    const bunkers = pairs.map(([carry, lateral]) =>
      makeBunkerPolygon([
        corner(carry - 1, lateral - 1),
        corner(carry - 1, lateral + 1),
        corner(carry + 1, lateral + 1),
        corner(carry + 1, lateral - 1),
      ])
    );

    const result = fairwayBunkerCarries({ features: [holeFeature, ...bunkers], tee, green });
    expect(result).toHaveLength(4);
    expect(result.map((b) => b.front)).toEqual([150, 210, 240, 270]);
  });

  it('maxBunkers: 2 (inline display cap) -> keeps only the 2 smallest-lateral bunkers, sorted by front', () => {
    const tee: LatLng = { lat: 40.3, lng: -73.5 };
    const green = northOf(tee, 450);
    const holeFeature = makeHoleLine([tee, green]);
    const corner = (alongYd: number, latYd: number) => eastOf(northOf(tee, alongYd), latYd);

    // Same fixture as above — the 2 SMALLEST |lateral| are 210(5) and
    // 150(10); everything else, including 240(20) and 270(15) which survive
    // the default cap of 4, is dropped at a display cap of 2.
    const pairs: Array<[number, number]> = [
      [120, 30],
      [150, 10],
      [180, 25],
      [210, 5],
      [240, 20],
      [270, 15],
    ];
    const bunkers = pairs.map(([carry, lateral]) =>
      makeBunkerPolygon([
        corner(carry - 1, lateral - 1),
        corner(carry - 1, lateral + 1),
        corner(carry + 1, lateral + 1),
        corner(carry + 1, lateral - 1),
      ])
    );

    const result = fairwayBunkerCarries({
      features: [holeFeature, ...bunkers],
      tee,
      green,
      maxBunkers: 2,
    });
    expect(result).toHaveLength(2);
    expect(result.map((b) => b.front)).toEqual([150, 210]);
  });
});

// ── 12. Par-3 suppression ────────────────────────────────────────────────────

describe('12. par-3 suppression', () => {
  it('par 3 -> fully empty despite valid geometry; par null -> not suppressed', () => {
    const { green, tee, holeFeature } = buildStraightHole(400, 10);

    const par3 = computeTeeShotOverlays({ features: [holeFeature], tee, green, par: 3 });
    expect(par3).toEqual({ markers: [], bunkers: [] });

    const parNull = computeTeeShotOverlays({ features: [holeFeature], tee, green, par: null });
    expect(parNull.markers.length).toBeGreaterThan(0);
  });
});

// ── 13. Visibility predicate ─────────────────────────────────────────────────

describe('13. teeShotOverlaysVisible', () => {
  const tee: LatLng = { lat: 40.2, lng: -73.5 };

  it('no GPS fix yet -> true (reading the hole)', () => {
    expect(teeShotOverlaysVisible({ position: null, gpsOnHole: false, tee })).toBe(true);
  });

  it('on the tee (10y away, on-hole) -> true', () => {
    const position = northOf(tee, 10);
    expect(teeShotOverlaysVisible({ position, gpsOnHole: true, tee })).toBe(true);
  });

  it('120y down the fairway, on-hole -> false', () => {
    const position = northOf(tee, 120);
    expect(teeShotOverlaysVisible({ position, gpsOnHole: true, tee })).toBe(false);
  });

  it('off-hole fix (far away, gpsOnHole false) -> true', () => {
    const position = northOf(tee, 5000);
    expect(teeShotOverlaysVisible({ position, gpsOnHole: false, tee })).toBe(true);
  });

  it('no anchored tee -> false regardless of position', () => {
    expect(teeShotOverlaysVisible({ position: null, gpsOnHole: false, tee: null })).toBe(false);
    expect(
      teeShotOverlaysVisible({ position: northOf(tee, 10), gpsOnHole: true, tee: null })
    ).toBe(false);
  });

  it('boundary: 40y -> true, 41y -> false', () => {
    const at40 = northOf(tee, 40);
    const at41 = northOf(tee, 41);
    expect(teeShotOverlaysVisible({ position: at40, gpsOnHole: true, tee })).toBe(true);
    expect(teeShotOverlaysVisible({ position: at41, gpsOnHole: true, tee })).toBe(false);
  });
});
