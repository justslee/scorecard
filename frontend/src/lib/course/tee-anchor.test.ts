/**
 * Unit tests for lib/course/tee-anchor.ts — the multi-tee anchor
 * reconciliation fix (specs/multi-tee-anchor-reconciliation-plan.md).
 *
 * These MUST fail on the pre-fix world (tee box [0] / back-most always won)
 * — the hole-3 fixture below is the literal prod bug (Bethpage hole 3: card
 * 178Y, tiles showed 232/245 from the back tee).
 *
 * Pure, headless — no React, no network.
 *
 * DO NOT weaken any assertion here to make a test pass; if one looks wrong,
 * the code is wrong (lessons.md #116 — the plural-hazard-row incident).
 */

import { describe, it, expect } from 'vitest';
import {
  extractTeeBoxes,
  resolveTeeAnchor,
  attachTeeBoxes,
  applyTeeAnchors,
  resolveFcbSource,
  type TeeBox,
} from './tee-anchor';
import { yardsDistance } from './hole-projection';
import { computeFCBDistances } from './course-coordinates';
import type { CourseCoordinates } from '@/lib/golf-api';
import type { CourseData } from '@/lib/courses/types';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Bethpage Black hole 3 green (real, from lib/course/course-coordinates.ts MOCK_BLACK). */
const GREEN = { lat: 40.7447291, lng: -73.4471708 };

/**
 * A point `yards` due north of `from` — inverts `yardsDistance`'s
 * meters-per-degree-latitude conversion (yards -> meters -> degrees lat).
 * Longitude is held constant so the synthesized points form a straight
 * tee->green line, matching yardsDistance's haversine to within rounding.
 */
function pointAtYards(from: { lat: number; lng: number }, yards: number): { lat: number; lng: number } {
  const meters = yards / 1.09361;
  const dLat = meters / 111_320;
  return { lat: from.lat + dLat, lng: from.lng };
}

/** A tiny square Polygon feature whose ring-centroid is exactly `center`
 *  (arithmetic mean of 4 symmetric corners). */
function teeBoxFeature(center: { lat: number; lng: number }, props: Record<string, unknown> = {}): GeoJSON.Feature {
  const eps = 0.00001;
  const ring = [
    [center.lng - eps, center.lat - eps],
    [center.lng + eps, center.lat - eps],
    [center.lng + eps, center.lat + eps],
    [center.lng - eps, center.lat + eps],
    [center.lng - eps, center.lat - eps],
  ];
  return {
    type: 'Feature',
    properties: { featureType: 'tee', ...props },
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

/** Build a TeeBox directly (name-only signal, real yardsToGreen off GREEN). */
function box(yards: number, name: string | null = null): TeeBox {
  const point = pointAtYards(GREEN, yards);
  return { point, name, yardsToGreen: yardsDistance(point, GREEN) };
}

// ---------------------------------------------------------------------------
// 1. Hole-3 fixture — THE PROOF (must fail pre-fix)
// ---------------------------------------------------------------------------

describe('hole-3 fixture — the prod bug (Bethpage hole 3, card 178Y, 5 tee boxes)', () => {
  const yardages = [232, 207, 174, 159, 136];
  const features = yardages.map((y) => teeBoxFeature(pointAtYards(GREEN, y)));

  it('extractTeeBoxes: each synthesized box lands within ±1y of its intended yardage', () => {
    const boxes = extractTeeBoxes(features, GREEN);
    expect(boxes).toHaveLength(5);
    boxes.forEach((b, i) => {
      expect(Math.abs(b.yardsToGreen - yardages[i])).toBeLessThanOrEqual(1);
    });
  });

  it('resolveTeeAnchor: selects the 174y box for a 178 card on a par 3 — NOT the 232y back tee', () => {
    const boxes = extractTeeBoxes(features, GREEN);
    const anchor = resolveTeeAnchor({
      currentTee: pointAtYards(GREEN, 232), // legacy pick — today's bug (tee box [0] / back-most)
      green: GREEN,
      boxes,
      teeName: 'White', // untagged boxes, as in prod — name match can't help
      cardYards: 178,
      par: 3,
    });

    expect(anchor.source).toBe('card');
    expect(anchor.tee).not.toBeNull();

    const fcb = computeFCBDistances(anchor.tee!, { green: GREEN });
    expect(fcb.center).toBeGreaterThanOrEqual(166);
    expect(fcb.center).toBeLessThanOrEqual(186);
    // Explicitly NOT the back tee — this is the exact prod symptom (231/245).
    expect(fcb.center).not.toBeGreaterThan(220);
  });
});

// ---------------------------------------------------------------------------
// 2. Named match — wins even when a different box is raw-nearer to the card,
//    then the guard test: an out-of-tolerance named pick gets re-anchored.
// ---------------------------------------------------------------------------

describe('named match', () => {
  it('wins over raw card-nearest when it still satisfies the guard tolerance', () => {
    // Named box at 182y; an untagged box at 179y is literally nearer to the
    // 178 card, but 182y is well within the par-3 8% guard (2.2%), so the
    // named selection is honored rather than overridden by raw nearness.
    const namedBox = box(182, 'white');
    const nearerUntagged = box(179, null);
    const boxes = [box(232), namedBox, nearerUntagged, box(159), box(136)];

    const anchor = resolveTeeAnchor({
      currentTee: null,
      green: GREEN,
      boxes,
      teeName: 'White',
      cardYards: 178,
      par: 3,
    });

    expect(anchor.source).toBe('named');
    expect(anchor.tee).toEqual(namedBox.point);
  });

  it('guard re-anchors an out-of-tolerance named pick to the card-nearest box', () => {
    // Named box tagged at the 232y back tee (a mis-tag, or the player's
    // named tee genuinely doesn't match the card) — guard fires (>8% on a
    // par 3) and re-anchors to the 174y card-nearest box.
    const backTee = box(232, 'white');
    const cardNearest174 = box(174);
    const boxes = [backTee, box(207), cardNearest174, box(159), box(136)];

    const anchor = resolveTeeAnchor({
      currentTee: null,
      green: GREEN,
      boxes,
      teeName: 'White',
      cardYards: 178,
      par: 3,
    });

    expect(anchor.source).toBe('card');
    expect(anchor.tee).toEqual(cardNearest174.point);
  });
});

// ---------------------------------------------------------------------------
// 3. Card-nearest tie rule
// ---------------------------------------------------------------------------

describe('card-nearest tie rule', () => {
  it('two boxes equidistant from the card → deterministic back-most (longer) box wins', () => {
    const shortSide = box(170); // |170-178| = 8
    const longSide = box(186); // |186-178| = 8 — exact tie
    const boxes = [shortSide, longSide];

    const anchor = resolveTeeAnchor({
      currentTee: null,
      green: GREEN,
      boxes,
      teeName: null,
      cardYards: 178,
      par: 3,
    });

    expect(anchor.source).toBe('card');
    expect(anchor.tee).toEqual(longSide.point);
  });
});

// ---------------------------------------------------------------------------
// 4. Sanity bound
// ---------------------------------------------------------------------------

describe('sanity bound (25%)', () => {
  it('card 250, only boxes 130 and 400 (best delta 32%) → card-only, never adopts an unrelated box', () => {
    const boxes = [box(130), box(400)];

    const anchor = resolveTeeAnchor({
      currentTee: null,
      green: GREEN,
      boxes,
      teeName: null,
      cardYards: 250,
      par: 4,
    });

    expect(anchor.source).toBe('card-only');
    expect(anchor.tee).toBeNull();
    expect(anchor.cardYards).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// 5. Dogleg no-misfire (par-aware guard, edge case 8)
// ---------------------------------------------------------------------------

describe('dogleg no-misfire — par 4/5 guard only fires on over-length geometry', () => {
  it('par 5, card 548, straight-line tee->green 470y (-14%, legitimate dogleg) → guard does NOT fire', () => {
    const legacyTee = pointAtYards(GREEN, 470);
    const anchor = resolveTeeAnchor({
      currentTee: legacyTee,
      green: GREEN,
      boxes: [], // no stored boxes — legacy tee is all we have
      teeName: null,
      cardYards: 548,
      par: 5,
    });

    expect(anchor.source).toBe('legacy');
    expect(anchor.tee).toEqual(legacyTee);
  });

  it('par 5, card 548, straight-line tee->green 600y (+9.5%, over card*1.08) → guard fires, no boxes → card-only', () => {
    const legacyTee = pointAtYards(GREEN, 600);
    const anchor = resolveTeeAnchor({
      currentTee: legacyTee,
      green: GREEN,
      boxes: [],
      teeName: null,
      cardYards: 548,
      par: 5,
    });

    expect(anchor.source).toBe('card-only');
    expect(anchor.tee).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Honest fallbacks
// ---------------------------------------------------------------------------

describe('honest fallbacks', () => {
  it('zero boxes + card contradicting the legacy tee (mock 232 vs card 178, par 3) → card-only', () => {
    const legacyTee = pointAtYards(GREEN, 232); // the mock's single centerline tee
    const anchor = resolveTeeAnchor({
      currentTee: legacyTee,
      green: GREEN,
      boxes: [],
      teeName: null,
      cardYards: 178,
      par: 3,
    });

    expect(anchor.source).toBe('card-only');
    expect(anchor.tee).toBeNull();
  });

  it('zero boxes + no card → legacy (keeps the incoming tee — nothing to contradict it)', () => {
    const legacyTee = pointAtYards(GREEN, 300);
    const anchor = resolveTeeAnchor({
      currentTee: legacyTee,
      green: GREEN,
      boxes: [],
      teeName: null,
      cardYards: null,
      par: 4,
    });

    expect(anchor.source).toBe('legacy');
    expect(anchor.tee).toEqual(legacyTee);
  });

  it('no teeName + no card + 5 boxes → legacy (keeps the incoming tee, doesn\'t guess)', () => {
    const boxes = [box(232), box(207), box(174), box(159), box(136)];
    const legacyTee = boxes[0].point;
    const anchor = resolveTeeAnchor({
      currentTee: legacyTee,
      green: GREEN,
      boxes,
      teeName: null,
      cardYards: null,
      par: 3,
    });

    expect(anchor.source).toBe('legacy');
    expect(anchor.tee).toEqual(legacyTee);
  });
});

// ---------------------------------------------------------------------------
// 7. attachTeeBoxes / mappedCourseToCoordinates integration
// ---------------------------------------------------------------------------

describe('attachTeeBoxes', () => {
  const yardages = [232, 207, 174, 159, 136];
  const teeFeatures = yardages.map((y, i) => teeBoxFeature(pointAtYards(GREEN, y), { ref: i === 2 ? 'White' : undefined }));
  const greenFeature: GeoJSON.Feature = {
    type: 'Feature',
    properties: { featureType: 'green' },
    geometry: { type: 'Polygon', coordinates: [[
      [GREEN.lng - 0.00002, GREEN.lat - 0.00002],
      [GREEN.lng + 0.00002, GREEN.lat - 0.00002],
      [GREEN.lng + 0.00002, GREEN.lat + 0.00002],
      [GREEN.lng - 0.00002, GREEN.lat + 0.00002],
      [GREEN.lng - 0.00002, GREEN.lat - 0.00002],
    ]] },
  };

  const course: CourseData = {
    id: 'course-1',
    name: 'Test Course',
    location: GREEN,
    teeSets: [],
    holes: [
      {
        number: 3,
        par: 3,
        handicap: 3,
        yardages: {},
        features: { type: 'FeatureCollection', features: [greenFeature, ...teeFeatures] },
      },
    ],
  };

  it('enriches golfapi/mock coords (no teeBoxes) with all 5 polygon-derived boxes', () => {
    // Simulates the golfapi/mock path winning: coords has green/tee but no
    // teeBoxes (getCourseCoordinates never returns that field).
    const mockCoords: CourseCoordinates[] = [
      { holeNumber: 3, green: GREEN, tee: pointAtYards(GREEN, 232) },
    ];

    const enriched = attachTeeBoxes(mockCoords, course);
    expect(enriched).toHaveLength(1);
    expect(enriched[0].teeBoxes).toBeDefined();
    expect(enriched[0].teeBoxes).toHaveLength(5);
    // Untouched fields survive.
    expect(enriched[0].green).toEqual(GREEN);
    expect(enriched[0].tee).toEqual(pointAtYards(GREEN, 232));
  });

  it('holes with no matching course hole pass through unchanged', () => {
    const mockCoords: CourseCoordinates[] = [{ holeNumber: 9, green: GREEN }];
    const enriched = attachTeeBoxes(mockCoords, course);
    expect(enriched[0].teeBoxes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. applyTeeAnchors (round-level integration)
// ---------------------------------------------------------------------------

describe('applyTeeAnchors', () => {
  it('overrides coords.tee per resolveTeeAnchor and reports the per-hole anchor', () => {
    const yardages = [232, 207, 174, 159, 136];
    const teeBoxes = yardages.map((y) => {
      const p = pointAtYards(GREEN, y);
      return { lat: p.lat, lng: p.lng, name: null };
    });
    const coords: CourseCoordinates[] = [
      { holeNumber: 3, green: GREEN, tee: pointAtYards(GREEN, 232), teeBoxes },
    ];

    const { coords: outCoords, anchorByHole } = applyTeeAnchors(coords, {
      teeName: 'White',
      holes: [
        { number: 1, par: 4 },
        { number: 2, par: 4 },
        { number: 3, par: 3, yards: 178 },
      ],
    });

    const anchor = anchorByHole.get(3);
    expect(anchor?.source).toBe('card');
    expect(outCoords[0].tee).toEqual(anchor?.tee);
    const fcb = computeFCBDistances(outCoords[0].tee!, { green: GREEN });
    expect(fcb.center).toBeGreaterThanOrEqual(166);
    expect(fcb.center).toBeLessThanOrEqual(186);
  });

  it('card-only holes have tee undefined on the output coords (honest — no marker at a wrong spot)', () => {
    const coords: CourseCoordinates[] = [
      { holeNumber: 3, green: GREEN, tee: pointAtYards(GREEN, 232) }, // no teeBoxes at all
    ];

    const { coords: outCoords, anchorByHole } = applyTeeAnchors(coords, {
      teeName: null,
      holes: [{ number: 1, par: 4 }, { number: 2, par: 4 }, { number: 3, par: 3, yards: 178 }],
    });

    expect(anchorByHole.get(3)?.source).toBe('card-only');
    expect(outCoords[0].tee).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 9. GPS override precedence (spec §fix.4) — live position ALWAYS wins
// ---------------------------------------------------------------------------

describe('resolveFcbSource — live GPS bypasses the anchor entirely', () => {
  it('a live fix wins even when the anchor is the honest card-only fallback', () => {
    expect(resolveFcbSource('card-only', true)).toBe('you');
  });

  it('a live fix wins over a normal named/card/legacy anchor too', () => {
    expect(resolveFcbSource('named', true)).toBe('you');
    expect(resolveFcbSource('card', true)).toBe('you');
    expect(resolveFcbSource('legacy', true)).toBe('you');
  });

  it('no live fix + card-only anchor → "card" (the honest fallback tiles)', () => {
    expect(resolveFcbSource('card-only', false)).toBe('card');
  });

  it('no live fix + any other anchor → "tee" (from-tee geometry tiles)', () => {
    expect(resolveFcbSource('named', false)).toBe('tee');
    expect(resolveFcbSource('legacy', false)).toBe('tee');
    expect(resolveFcbSource(null, false)).toBe('tee');
  });
});
