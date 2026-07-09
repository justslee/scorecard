/**
 * tee-anchor.ts — resolve which stored tee box (of potentially several per
 * hole) the "from the tee" F/C/B tiles, plays-like, wind bearing, and colored
 * tee marker should anchor to.
 *
 * Fixes the third geometry-anchor incident (after hazards + doglegs; see
 * specs/multi-tee-anchor-reconciliation.md): a hole can store multiple OSM
 * tee-box polygons (e.g. Bethpage hole 3: 232/207/174/159/136y to green), and
 * the old code always anchored to tee box [0] — the back-most box —
 * regardless of the tee the player actually selected at round start. The
 * result: the header card (from `round.holes[i].yards`, the player's card)
 * and the "FROM THE TEE" tiles (from the wrong geometry) silently disagreed.
 *
 * No React, no network — pure functions (same pattern as fcb-labels.ts /
 * hole-projection.ts), so the crux selection logic is headless-testable.
 *
 * Units: everywhere here, "yards" means straight-line yards via
 * `yardsDistance` (haversine). `HoleInfo.yards` / `HoleData.yardages` are
 * yards by convention (see hole-projection.ts).
 */

import type { CourseCoordinates } from '@/lib/golf-api';
import type { CourseData } from '@/lib/courses/types';
import type { HoleInfo } from '@/lib/types';
import { yardsDistance, ringCentroid } from './hole-projection';

// ── Types ────────────────────────────────────────────────────────────────────

export interface TeeBox {
  /** Tee-box polygon centroid. */
  point: { lat: number; lng: number };
  /** properties.teeSet (editor) or properties.ref/name (OSM), lowercased and
   *  trimmed; null when untagged (the common case for OSM-ingested tees
   *  before the osm.py tag-preservation change ships). */
  name: string | null;
  /** Straight-line yards from this box to the hole's green center. */
  yardsToGreen: number;
}

export type TeeAnchorSource = 'named' | 'card' | 'single' | 'legacy' | 'card-only';

export interface TeeAnchor {
  /** The resolved tee point to anchor geometry to. Null only for source
   *  'card-only' — the honest fallback when no stored geometry can be
   *  reconciled with the scorecard yardage. */
  tee: { lat: number; lng: number } | null;
  source: TeeAnchorSource;
  /** The card yardage used in resolution (or null when none was available). */
  cardYards: number | null;
}

// ── Tee-box extraction ──────────────────────────────────────────────────────

/**
 * All `featureType === "tee"` polygon centroids for one hole, measured
 * against its green. Returns one entry per tee-box polygon feature (NOT just
 * the first) — the crux fix that makes multi-tee holes selectable at all.
 *
 * Pure function — no side-effects, no DOM, headless-testable.
 */
export function extractTeeBoxes(
  features: GeoJSON.Feature[],
  green: { lat: number; lng: number }
): TeeBox[] {
  const boxes: TeeBox[] = [];
  for (const feat of features) {
    const featureType = (feat.properties?.featureType as string | undefined) ?? '';
    if (featureType !== 'tee') continue;
    const geom = feat.geometry;
    if (!geom || geom.type !== 'Polygon') continue;
    const ring = (geom as GeoJSON.Polygon).coordinates[0];
    const centroid = ringCentroid(ring);
    if (!centroid) continue;
    const point = { lat: centroid[1], lng: centroid[0] };
    const rawName =
      (feat.properties?.teeSet as string | undefined) ??
      (feat.properties?.ref as string | undefined) ??
      (feat.properties?.name as string | undefined) ??
      null;
    const name = rawName && rawName.trim() ? rawName.trim().toLowerCase() : null;
    boxes.push({ point, name, yardsToGreen: yardsDistance(point, green) });
  }
  return boxes;
}

// ── Name matching ────────────────────────────────────────────────────────────

/**
 * Case-insensitive equality, else mutual-substring match — mirrors
 * `teeColorFor`'s tolerance (lib/map/google-map-helpers.ts) so e.g. a box
 * tagged "White · Middle" matches a round's teeName "white".
 */
function namesMatch(boxName: string, teeName: string): boolean {
  const a = boxName.trim().toLowerCase();
  const b = teeName.trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
}

// ── Card-nearest selection ──────────────────────────────────────────────────

interface CardPick {
  box: TeeBox;
  /** |box.yardsToGreen - cardYards| / cardYards. */
  deltaFrac: number;
}

/**
 * argmin |box.yardsToGreen - cardYards| over `boxes`.
 *
 * Tie rule (deterministic): on an exact tie, prefer the LONGER (back-most)
 * box — the golfer is never handed a shorter-than-actual number for club
 * selection.
 */
function nearestByCard(boxes: TeeBox[], cardYards: number): CardPick | null {
  if (boxes.length === 0) return null;
  let best: TeeBox | null = null;
  let bestDelta = Infinity;
  for (const box of boxes) {
    const delta = Math.abs(box.yardsToGreen - cardYards);
    if (
      best === null ||
      delta < bestDelta ||
      (delta === bestDelta && box.yardsToGreen > best.yardsToGreen)
    ) {
      best = box;
      bestDelta = delta;
    }
  }
  if (!best) return null;
  const deltaFrac = cardYards > 0 ? bestDelta / cardYards : Infinity;
  return { box: best, deltaFrac };
}

/** Reconciliation guard — par-aware so doglegs don't misfire (edge case 8).
 *  Par 3: tee→green IS the card number, so any >8% disagreement is wrong.
 *  Par 4/5: straight-line ≤ card is a legitimate dogleg (card is measured
 *  along the routing) and must never trigger; only straight-line LONGER than
 *  the card (by >8%) indicates the wrong (too-far-back) tee box. Unknown par
 *  uses the more conservative par-4/5 rule (never misfires on a possible
 *  dogleg it can't rule out).
 */
function guardFails(
  tee: { lat: number; lng: number },
  green: { lat: number; lng: number },
  cardYards: number,
  par: number | null
): boolean {
  const geo = yardsDistance(tee, green);
  if (par === 3) {
    return Math.abs(geo - cardYards) / cardYards > 0.08;
  }
  return geo > cardYards * 1.08;
}

// ── Core selection ───────────────────────────────────────────────────────────

/**
 * Resolve which tee box (if any) the "from the tee" geometry should anchor
 * to for one hole.
 *
 * Selection order (spec §fix.1):
 *   1. Named match — exactly one box's name matches `teeName`.
 *   2. Card-nearest — box whose yardsToGreen is closest to `cardYards`,
 *      rejected outright if the closest candidate is still >25% off (a
 *      178y card must not silently adopt an unrelated 136y box).
 *   3. Single box — exactly one box exists and there's no card/name signal
 *      to prefer otherwise.
 *   4. Legacy — nothing to choose with; keep the incoming `currentTee`.
 *
 * After steps 1/3/4 (NOT a fresh card pick, which is already the
 * reconciliation target), the par-aware >8%/1.08x reconciliation guard
 * (spec §fix.3) checks the result against `cardYards`. A guard failure
 * re-runs the card-nearest step; if that also fails (or there are no boxes
 * at all), the result is the honest `card-only` fallback — `tee: null` —
 * rather than a contradictory geometry number (spec §fix.5).
 *
 * Pure function — no side-effects, no DOM, headless-testable.
 */
export function resolveTeeAnchor(opts: {
  currentTee: { lat: number; lng: number } | null;
  green: { lat: number; lng: number } | null;
  boxes: TeeBox[];
  teeName: string | null;
  cardYards: number | null;
  par: number | null;
}): TeeAnchor {
  const { currentTee, green, boxes, teeName, cardYards, par } = opts;

  const cardPick =
    cardYards != null && boxes.length > 0 ? nearestByCard(boxes, cardYards) : null;
  const cardValid = cardPick != null && cardPick.deltaFrac <= 0.25;

  let tee: { lat: number; lng: number } | null = null;
  let source: TeeAnchorSource | null = null;

  // 1. Named match.
  if (teeName) {
    const matches = boxes.filter((b) => b.name != null && namesMatch(b.name, teeName));
    if (matches.length === 1) {
      tee = matches[0].point;
      source = 'named';
    }
  }

  // 2. Card-nearest — primary fallback when step 1 didn't resolve.
  if (!tee && cardValid) {
    tee = cardPick!.box.point;
    source = 'card';
  }

  // 3. Single box — only when there's no card signal to prefer instead.
  if (!tee && boxes.length === 1 && cardYards == null) {
    tee = boxes[0].point;
    source = 'single';
  }

  // 4. Legacy / honest fallback.
  if (!tee) {
    if (cardYards != null && boxes.length > 0 && !cardValid) {
      // A card number exists but nothing satisfies the sanity bound —
      // honest fallback, never silently keep a contradicting legacy point.
      return { tee: null, source: 'card-only', cardYards };
    }
    tee = currentTee;
    source = 'legacy';
  }

  // Reconciliation guard — applies to named / single / legacy picks. A fresh
  // 'card' pick is already the reconciliation target, so it's exempt.
  if (source !== 'card' && tee && green && cardYards != null) {
    if (guardFails(tee, green, cardYards, par)) {
      if (cardValid) {
        tee = cardPick!.box.point;
        source = 'card';
      } else {
        tee = null;
        source = 'card-only';
      }
    }
  }

  return { tee, source: source ?? 'legacy', cardYards: cardYards ?? null };
}

// ── Coordinate enrichment ────────────────────────────────────────────────────

/**
 * Merge tee-box centroids extracted from `course`'s stored GeoJSON features
 * onto `coords` — even when `coords` came from the golfapi-cache / mock
 * provider (which never carries `teeBoxes`). This is what makes the Bethpage
 * prod case fixable: the mock provides green/front/back, the stored course
 * features provide the 5 tee boxes.
 *
 * Holes with no tee-box polygons (or no matching hole in `course`) pass
 * through unchanged. Pure function — no side-effects, no DOM.
 */
export function attachTeeBoxes(
  coords: CourseCoordinates[],
  course: CourseData
): CourseCoordinates[] {
  const holesByNumber = new Map(course.holes.map((h) => [h.number, h]));
  return coords.map((c) => {
    const hole = holesByNumber.get(c.holeNumber);
    if (!hole) return c;
    const features = hole.features?.features ?? [];
    const boxes = extractTeeBoxes(features as GeoJSON.Feature[], c.green);
    if (boxes.length === 0) return c;
    return {
      ...c,
      teeBoxes: boxes.map((b) => ({ lat: b.point.lat, lng: b.point.lng, name: b.name })),
    };
  });
}

// ── Live GPS precedence (spec §fix.4) ───────────────────────────────────────

/**
 * Decide the F/C/B tile source given a hole's resolved tee anchor and
 * whether a live, plausible GPS fix is in play.
 *
 * A live position ALWAYS wins over the anchor — this is the one guard that
 * must never regress from the tee-anchor change (RoundPageClient's GPS
 * override branch, lines ~1088–1121, is untouched by this fix). Only when
 * there is no live fix does the honest `card-only` fallback ever show.
 *
 * Pure function — no side-effects, no DOM, headless-testable.
 */
export function resolveFcbSource(
  anchorSource: TeeAnchorSource | null,
  hasLiveFix: boolean
): 'you' | 'tee' | 'card' {
  if (hasLiveFix) return 'you';
  return anchorSource === 'card-only' ? 'card' : 'tee';
}

// ── Round-level application ─────────────────────────────────────────────────

export interface ApplyTeeAnchorsResult {
  /** `coords` with `tee` overridden per resolveTeeAnchor (undefined for
   *  'card-only' holes — the honest "no usable geometry" state). */
  coords: CourseCoordinates[];
  /** Per-hole resolution detail (source, cardYards used) — the header ladder
   *  and honest card-only tile state both key off this. */
  anchorByHole: Map<number, TeeAnchor>;
}

/**
 * Apply `resolveTeeAnchor` across every hole's coordinates for a round.
 *
 * `holes[i].yards` is the card yardage for hole i+1 (round.holes, 0-indexed);
 * missing/undefined entries resolve to `cardYards: null` for that hole (the
 * standard `round/new` flow stores no yards — named/single/legacy paths
 * still work without a card number).
 */
export function applyTeeAnchors(
  coords: CourseCoordinates[],
  opts: { teeName: string | null; holes: HoleInfo[] }
): ApplyTeeAnchorsResult {
  const anchorByHole = new Map<number, TeeAnchor>();
  const outCoords = coords.map((c) => {
    const holeInfo = opts.holes[c.holeNumber - 1];
    const cardYards = holeInfo?.yards ?? null;
    const par = holeInfo?.par ?? null;
    const boxes = c.teeBoxes
      ? c.teeBoxes.map((b) => ({
          point: { lat: b.lat, lng: b.lng },
          name: b.name,
          yardsToGreen: yardsDistance({ lat: b.lat, lng: b.lng }, c.green),
        }))
      : [];
    const anchor = resolveTeeAnchor({
      currentTee: c.tee ?? null,
      green: c.green ?? null,
      boxes,
      teeName: opts.teeName,
      cardYards,
      par,
    });
    anchorByHole.set(c.holeNumber, anchor);
    return { ...c, tee: anchor.tee ?? undefined };
  });
  return { coords: outCoords, anchorByHole };
}
