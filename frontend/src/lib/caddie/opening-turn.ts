/**
 * buildOpeningTurnText — the single opening-turn question builder shared by
 * CaddieSheet's classic auto opening-shot effect and the live-mode Realtime
 * hook (specs/caddie-realtime-conversation-plan.md §1.3: "keep the
 * opening-turn text builder in one place"; specs/caddie-realtime-slice-c1-plan.md
 * §3). Pure — no DOM, no network — so both paths speak/type the exact same
 * question for a given resolved shot.
 */

export interface OpeningShot {
  distanceYards: number;
  fromTee?: boolean;
}

export function buildOpeningTurnText(shot: OpeningShot): string {
  return shot.fromTee
    ? `I'm on the tee, about ${shot.distanceYards} yards to the pin. What should I hit off the tee?`
    : `I'm about ${shot.distanceYards} yards from the pin. What should I hit or do on this next shot?`;
}

/**
 * buildHoleContextText — the silent re-anchor item sent on connect and on
 * every hole change (specs/caddie-stale-hole-live-plan.md §2/§3.2). Never
 * spoken and never rendered as a transcript bubble (see
 * RealtimeCaddieClient.sendContext), so verbosity is fine here — pure,
 * DOM-free, network-free, unit-testable.
 */
export interface HoleContext {
  holeNumber: number;
  par: number;
  yards: number;
}

export function buildHoleContextText(h: HoleContext): string {
  return (
    `Course update — ground truth: the player is now on hole ${h.holeNumber}, ` +
    `par ${h.par}, ${h.yards} yards on the card. Disregard any earlier hole. ` +
    `For live numbers call your tools (get_conditions, get_recommendation) with ` +
    `hole_number ${h.holeNumber}; never answer from a previous hole.`
  );
}
