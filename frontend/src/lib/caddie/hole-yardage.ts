/**
 * hole-yardage.ts — the ONE shared resolver for "how far is this hole",
 * used by every caddie/grounding surface (sheet header, offline card, voice
 * requests, live session context). Fixes the phantom-178 incident
 * (specs/caddie-yardage-gps-selected-tee-plan.md): the mock illustration
 * constant (`components/yardage/HoleIllustration.tsx` HOLES[i].yards) was
 * leaking into the caddie's mouth via `?? hole.yards` fallbacks, while a live
 * GPS fix and the golfer's actual selected tee sat unused.
 *
 * Priority (plan §2.1), most-trustworthy first:
 *   1. GPS-to-green, from where the player stands NOW (already gated 5–800y
 *      "on this hole" by the caller — see RoundPageClient's `posOnHole`).
 *   2. The golfer's selected tee, from a real per-tee card yardage.
 *   3. The golfer's selected tee, from mapped tee-box → green geometry
 *      (exact for par 3; a floor/"at least" number for par 4/5, since
 *      straight-line geometry understates a dogleg's routed distance).
 *   4. A real scorecard snapshot on the round (no tee-specific signal).
 *   5. Honest null — the prompt/UI omit the yardage line rather than guess.
 *
 * The mock `HOLES[i].yards` constant is BANNED from this module and from
 * every caller that feeds a caddie/grounding surface — it stays valid ONLY
 * for the paper hole illustration on a fully unmapped/no-anchor round.
 *
 * Pure, headless — no React, no network (mirrors lib/course/tee-anchor.ts).
 */

export type YardageBasis = 'gps' | 'tee-card' | 'tee-geom' | 'card' | null;

export interface ResolveHoleYardageInput {
  /** Live front/center/back distances computed from the player's current GPS
   *  fix, already gated by the caller's 5–800y "on this hole" plausibility
   *  check (RoundPageClient `posOnHole`). Pass null when there's no live fix
   *  or it's implausible — never a stale/off-hole value. */
  fcbLive: { front: number; center: number; back: number } | null;
  /** The golfer's selected tee's per-hole card yardage (e.g.
   *  `CourseData.holes[i].yardages[teeName]`), when known. */
  selectedTeeCardYards: number | null;
  /** Straight-line yards from the golfer's selected/resolved tee box to the
   *  green center (tee-anchor geometry). */
  selectedTeeGeomYards: number | null;
  /** A real scorecard snapshot on the round (`round.holes[i].yards`), with
   *  no tee-specific signal behind it. */
  cardYards: number | null;
  par: number | null;
}

export interface ResolvedHoleYardage {
  yards: number | null;
  basis: YardageBasis;
}

/**
 * Resolve the single honest yardage number for a hole, in priority order.
 * Never returns the mock illustration constant — callers must not pass it in
 * as any of these fields.
 */
export function resolveHoleYardage(input: ResolveHoleYardageInput): ResolvedHoleYardage {
  const { fcbLive, selectedTeeCardYards, selectedTeeGeomYards, cardYards } = input;

  if (fcbLive) {
    return { yards: Math.round(fcbLive.center), basis: 'gps' };
  }
  if (selectedTeeCardYards != null) {
    return { yards: Math.round(selectedTeeCardYards), basis: 'tee-card' };
  }
  if (selectedTeeGeomYards != null) {
    // Par 3: tee→green straight-line IS the yardage. Par 4/5: this is a
    // floor (a dogleg's routed distance is longer than the straight line) —
    // still the resolved number (the caller labels it "at least" via the
    // caption), never fabricated beyond what geometry actually measured.
    return { yards: Math.round(selectedTeeGeomYards), basis: 'tee-geom' };
  }
  if (cardYards != null) {
    return { yards: Math.round(cardYards), basis: 'card' };
  }
  return { yards: null, basis: null };
}

/**
 * Honest basis caption for display (sheet header, offline card, tiles) —
 * NEVER "on the card" unless the number really came from a real card/tee
 * source. "—" when nothing is known; never a fabricated number.
 *
 * `par` only affects the `tee-geom` caption: straight-line geometry is the
 * exact yardage on a par 3, but a floor/"at least" on a par 4/5 (a dogleg's
 * routed distance runs longer than the straight line) — see
 * `resolveHoleYardage`'s doc comment.
 */
export function yardageCaption(
  resolved: ResolvedHoleYardage,
  teeName: string | null,
  par: number | null = null,
): string {
  const { yards, basis } = resolved;
  if (yards == null || basis == null) return '—';
  if (basis === 'gps') return `${yards} to the green`;
  const teeLabel = teeName ? ` · ${teeName.toLowerCase()} tees` : '';
  const prefix = basis === 'tee-geom' && par !== 3 ? 'at least ' : '';
  return `${prefix}${yards} yds${teeLabel}`;
}
