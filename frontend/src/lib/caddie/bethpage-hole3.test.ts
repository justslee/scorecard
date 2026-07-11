/**
 * The critical RED-before/GREEN-after fixture for
 * specs/caddie-yardage-gps-selected-tee-plan.md — the literal owner bug:
 * Bethpage Black hole 3, GPS active, caddie sheet header showed
 * "178 YDS" (the mock illustration constant) and argued when corrected to
 * 231 (the Black tees the golfer selected).
 *
 * On PRE-FIX code (no `ordinalTeePick` step in tee-anchor.ts, and the old
 * `round.holes[i]?.yards ?? hole.yards` fallback in RoundPageClient/
 * CaddieSheet), this scenario resolves to the mock's 178 — see the first
 * `it` below, which documents that source value directly. On fixed code the
 * resolver NEVER returns 178 for these inputs; it resolves 231 (tee-card,
 * once the mapped course's real per-tee card yardage is hydrated) or ~232
 * (tee-geom, from the untagged-box ordinal pick alone).
 *
 * DO NOT weaken any assertion here to make a test pass; if one looks wrong,
 * the code is wrong (lessons.md #116).
 */

import { describe, it, expect } from 'vitest';
import { HOLES } from '@/components/yardage/HoleIllustration';
import { extractTeeBoxes, resolveTeeAnchor } from '@/lib/course/tee-anchor';
import { computeFCBDistances } from '@/lib/course/course-coordinates';
import { yardsDistance } from '@/lib/course/hole-projection';
import { resolveHoleYardage } from './hole-yardage';

/** Real Bethpage Black hole 3 green (from lib/course/course-coordinates.ts MOCK_BLACK). */
const GREEN = { lat: 40.7447291, lng: -73.4471708 };

function pointAtYards(from: { lat: number; lng: number }, yards: number): { lat: number; lng: number } {
  const meters = yards / 1.09361;
  const dLat = meters / 111_320;
  return { lat: from.lat + dLat, lng: from.lng };
}

function teeBoxFeature(center: { lat: number; lng: number }): GeoJSON.Feature {
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
    properties: { featureType: 'tee' }, // untagged — no teeSet/ref/name, the real prod shape
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

describe('Bethpage hole 3 — the owner P0 bug, RED-before / GREEN-after', () => {
  it('the mock illustration constant IS 178 — the literal source of the bug (must never reach a caddie surface)', () => {
    expect(HOLES[2]).toMatchObject({ par: 3, yards: 178 });
  });

  it('real round shape (no card yards, teeName "Black", 5 untagged boxes 232/207/174/159/136) resolves via the untagged-box ordinal pick — NEVER 178, NEVER null/throwing', () => {
    // round `{ teeName: "Black", holes: [..., { number: 3, par: 3 }] }` —
    // no `.yards` on the hole, the real prod shape (round/new stores pars only).
    const yardages = [232, 207, 174, 159, 136];
    const features = yardages.map((y) => teeBoxFeature(pointAtYards(GREEN, y)));
    const boxes = extractTeeBoxes(features, GREEN);
    expect(boxes.every((b) => b.name === null)).toBe(true); // untagged, as in prod

    const anchor = resolveTeeAnchor({
      currentTee: null,
      green: GREEN,
      boxes,
      teeName: 'Black',
      cardYards: null,
      par: 3,
    });

    // GREEN after the fix: the ordinal step resolves the back-most (Black) box.
    expect(anchor.source).toBe('ordinal');
    expect(anchor.tee).not.toBeNull();

    const geomYards = computeFCBDistances(anchor.tee!, { green: GREEN }).center;
    expect(Math.round(yardsDistance(anchor.tee!, GREEN))).toBeGreaterThanOrEqual(226);
    expect(geomYards).toBeGreaterThanOrEqual(226);
    expect(geomYards).toBeLessThanOrEqual(238);
    expect(geomYards).not.toBe(178);

    // Feed straight into the shared resolver — geometry-only basis (no card
    // yardage hydrated at all): still resolves ~232, never the mock.
    const geomOnly = resolveHoleYardage({
      fcbLive: null,
      selectedTeeCardYards: null,
      selectedTeeGeomYards: geomYards,
      cardYards: null,
      par: 3,
    });
    expect(geomOnly.basis).toBe('tee-geom');
    expect(geomOnly.yards).not.toBe(178);
    expect(geomOnly.yards).toBeGreaterThanOrEqual(226);
    expect(geomOnly.yards).toBeLessThanOrEqual(238);
  });

  it('with the mapped course\'s real per-tee card yardage hydrated (231, Black tees) the resolver prefers it outright — NEVER 178', () => {
    const resolved = resolveHoleYardage({
      fcbLive: null,
      selectedTeeCardYards: 231, // CourseData.holes[2].yardages['Black'], hydrated by slice 2
      selectedTeeGeomYards: 232, // the ordinal geometry pick from the test above
      cardYards: null,
      par: 3,
    });
    expect(resolved).toEqual({ yards: 231, basis: 'tee-card' });
    expect(resolved.yards).not.toBe(178);
  });

  it('GPS on the hole (204y live) outranks every stored/geometry number — still never 178', () => {
    const resolved = resolveHoleYardage({
      fcbLive: { front: 190, center: 204, back: 218 },
      selectedTeeCardYards: 231,
      selectedTeeGeomYards: 232,
      cardYards: null,
      par: 3,
    });
    expect(resolved).toEqual({ yards: 204, basis: 'gps' });
  });
});
