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

export type TeeAnchorSource = 'named' | 'card' | 'ordinal' | 'single' | 'legacy' | 'card-only';

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
 * tagged "White · Middle" matches a round's teeName "white". Exported so
 * callers hydrating a mapped course's per-tee CARD yardages (`CourseData
 * .holes[].yardages`, keyed by tee name) can match a round's `teeName`
 * against those keys the same tolerant way (spec §2.2).
 */
export function namesMatch(boxName: string, teeName: string): boolean {
  const a = boxName.trim().toLowerCase();
  const b = teeName.trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  return a.includes(b) || b.includes(a);
}

// ── Untagged-box ordinal selection (spec §2.2) ──────────────────────────────

/**
 * Canonical tee-name order, longest→shortest — mirrors round/new's
 * TEE_OPTIONS. Used ONLY to align a hole's untagged tee-box geometry (ranked
 * by yardsToGreen desc) to the golfer's selected tee when there's no OSM/
 * editor name to go by (the common case pre tag-preservation ingestion).
 */
const ORDINAL_TEE_NAMES = ['black', 'blue', 'white', 'gold', 'red'];

/** A golfer's teeName that unambiguously means "the longest tee" even when
 *  the course's own tee count doesn't line up with ORDINAL_TEE_NAMES. */
const BACK_MOST_ALIASES = ['black', 'tips', 'championship', 'tournament'];
/** ...and "the shortest tee". */
const FORWARD_ALIASES = ['red', 'forward', 'ladies', 'junior'];

/**
 * Resolve which untagged box the golfer's teeName means, WITHOUT guessing
 * between look-alike middle tees (spec §2.2, edge case: Bethpage hole 3 —
 * 5 untagged boxes, teeName "Black"):
 *   1. Count-match ordinal align — if this hole has exactly as many boxes as
 *      `ORDINAL_TEE_NAMES` (5) and `teeName` matches one of those names,
 *      rank the boxes longest→shortest and take the box at that name's
 *      ordinal index (Black = index 0 = the longest box).
 *   2. Safe endpoints — otherwise only resolve the unambiguous ends: a
 *      "black"/"tips"-style name → the single longest box; a
 *      "red"/"forward"-style name → the single shortest box.
 *   3. Anything else (an ambiguous middle tee with no count match) → null,
 *      honest fallthrough to the caller's existing card-nearest/legacy paths
 *      — never a guess between two similar middle boxes.
 *
 * Pure function — no side-effects, no DOM, headless-testable.
 */
export function ordinalTeePick(boxes: TeeBox[], teeName: string): TeeBox | null {
  if (boxes.length === 0) return null;
  const name = teeName.trim().toLowerCase();
  if (!name) return null;
  const sortedDesc = [...boxes].sort((a, b) => b.yardsToGreen - a.yardsToGreen);

  if (boxes.length === ORDINAL_TEE_NAMES.length) {
    const idx = ORDINAL_TEE_NAMES.indexOf(name);
    if (idx !== -1) return sortedDesc[idx];
  }

  if (BACK_MOST_ALIASES.some((a) => a === name || name.includes(a))) {
    return sortedDesc[0];
  }
  if (FORWARD_ALIASES.some((a) => a === name || name.includes(a))) {
    return sortedDesc[sortedDesc.length - 1];
  }
  return null;
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

/**
 * Whether a card-nearest pick is trustworthy enough to adopt as
 * `source: 'card'` — the SAME par-aware tolerance as `guardFails` above
 * (par 3: within 8%; par 4/5/unknown: within the 25% sanity bound AND not
 * more than 8% longer than the card — doglegs are legitimately shorter than
 * the card and must never be rejected for that).
 *
 * This closes a Fable BLOCKING finding on the first cut: a fresh card pick
 * only had to clear the blanket 25% sanity bound, so e.g. card 178 / par 3
 * could silently adopt a 136y box (23.6% ≤ 25%) — the same header-vs-tiles
 * disagreement class as the prod bug, in the more dangerous understatement
 * direction. A pick that fails this must fall through to the honest
 * `card-only` state, never return a contradictory geometry number.
 *
 * Uses `pick.box.yardsToGreen` directly (not `guardFails`/`yardsDistance`
 * against a `green` point) — that field is already the authoritative
 * tee→green distance regardless of whether a `green` point was supplied to
 * `resolveTeeAnchor` for this call.
 */
function cardPickValid(pick: CardPick | null, cardYards: number, par: number | null): boolean {
  if (!pick) return false;
  if (par === 3) {
    return pick.deltaFrac <= 0.08;
  }
  return pick.deltaFrac <= 0.25 && pick.box.yardsToGreen <= cardYards * 1.08;
}

// ── Core selection ───────────────────────────────────────────────────────────

/**
 * Resolve which tee box (if any) the "from the tee" geometry should anchor
 * to for one hole.
 *
 * Selection order (spec §fix.1; ordinal step added by
 * specs/caddie-yardage-gps-selected-tee-plan.md §2.2):
 *   1. Named match — exactly one box's name matches `teeName`.
 *   2. Card-nearest — box whose yardsToGreen is closest to `cardYards`,
 *      accepted only if it ALSO passes the same par-aware reconciliation
 *      guard as steps 1/3/4/5 below (see `cardPickValid`): par 3 within 8%;
 *      par 4/5/unknown within the 25% sanity bound AND not more than 8%
 *      longer than the card. A 178y par-3 card must not adopt a 136y box
 *      just because it happens to clear a blanket 25% bound. A pick that
 *      fails falls straight through to the honest `card-only` state.
 *   3. Untagged-box ordinal (`ordinalTeePick`) — every box on this hole is
 *      untagged (>1 box; a lone box is step 4's job), `teeName` is known,
 *      and steps 1/2 didn't resolve: count-match ordinal align or a safe
 *      endpoint. Ambiguous → null, falls through. This is what flips
 *      Bethpage hole 3 (5 untagged boxes, "Black") to the 232y box instead
 *      of the arbitrary legacy pick.
 *   4. Single box — exactly one box exists and there's no card/name signal
 *      to prefer otherwise.
 *   5. Legacy — nothing to choose with; keep the incoming `currentTee`.
 *
 * After steps 1/3/4/5 (NOT a fresh card pick, which is already validated
 * against the identical guard in step 2), the par-aware >8%/1.08x
 * reconciliation guard (spec §fix.3) checks the result against `cardYards`.
 * A guard failure re-runs the card-nearest step; if that also fails (or
 * there are no boxes at all), the result is the honest `card-only`
 * fallback — `tee: null` — rather than a contradictory geometry number
 * (spec §fix.5).
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
  const cardValid = cardYards != null && cardPickValid(cardPick, cardYards, par);

  let tee: { lat: number; lng: number } | null = null;
  let source: TeeAnchorSource | null = null;

  // 1. Named match. Requires EXACTLY one match — an ambiguous match (e.g. two
  // combo-tee boxes like "White/Blue" and "White/Gold" both substring-match
  // "white") intentionally falls through to card-nearest rather than
  // guessing between them (non-blocking known limitation; see
  // tee-anchor.test.ts "ambiguous named match").
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

  // 3. Untagged-box ordinal (spec §2.2) — every box on this hole is
  // untagged, teeName is known, and named/card-nearest didn't resolve.
  // Gated to >1 box: a lone untagged box is step 4's ("single") job.
  if (!tee && teeName && boxes.length > 1 && boxes.every((b) => b.name == null)) {
    const picked = ordinalTeePick(boxes, teeName);
    if (picked) {
      tee = picked.point;
      source = 'ordinal';
    }
  }

  // 4. Single box — only when there's no card signal to prefer instead.
  if (!tee && boxes.length === 1 && cardYards == null) {
    tee = boxes[0].point;
    source = 'single';
  }

  // 5. Legacy / honest fallback.
  if (!tee) {
    if (cardYards != null && boxes.length > 0 && !cardValid) {
      // A card number exists but nothing satisfies the par-aware guard
      // (cardPickValid) — honest fallback, never silently keep a
      // contradicting legacy point.
      return { tee: null, source: 'card-only', cardYards };
    }
    tee = currentTee;
    source = 'legacy';
  }

  // Reconciliation guard — applies to named / single / legacy picks. A fresh
  // 'card' pick already passed the identical par-aware guard (cardValid /
  // cardPickValid above), so it's exempt from re-checking here.
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
