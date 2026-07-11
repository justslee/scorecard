/**
 * buildOpeningGreetingText / buildOpeningGreetingInstruction — the caddie's
 * self-authored opening greeting, shared by CaddieSheet's classic auto
 * opening-shot effect and the live-mode Realtime hook
 * (specs/caddie-remove-seeded-question-plan.md: the caddie opens the
 * conversation itself — never a fabricated player question). Pure — no DOM,
 * no network — so both paths render/speak the exact same greeting for a
 * given resolved shot. `buildOpeningGreetingText` is the single source of
 * truth for the human-facing words: classic renders them verbatim; the live
 * wrapper asks the Realtime model to say roughly them in its own voice.
 */

export interface OpeningShot {
  distanceYards: number;
  fromTee?: boolean;
}

export function buildOpeningGreetingText(shot: OpeningShot): string {
  return shot.fromTee
    ? `You're on the tee — about ${shot.distanceYards} to the pin. Want a read on the tee shot?`
    : `About ${shot.distanceYards} to the pin from here. Want a read on the shot?`;
}

/**
 * buildOpeningGreetingInstruction — wraps the greeting content in a fixed
 * live-mode instruction so the Realtime model voices a caddie-authored
 * opener (never answers a question the player never asked).
 */
export function buildOpeningGreetingInstruction(shot: OpeningShot): string {
  return (
    `Open the conversation now with one short greeting in your own voice, roughly: ` +
    `"${buildOpeningGreetingText(shot)}" The player has not said anything yet — ` +
    `do not answer a question they never asked. After the greeting, stop and listen.`
  );
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
  /** Resolved yardage (lib/caddie/hole-yardage.ts) — null when nothing honest
   *  is known yet. NEVER the mock illustration constant; never a fabricated
   *  "on the card" number (slice 3 adds full GPS/tee-basis provenance). */
  yards: number | null;
}

export function buildHoleContextText(h: HoleContext): string {
  const yardsClause =
    h.yards != null ? `, ${h.yards} yards` : ', yardage not yet known';
  return (
    `Course update — ground truth: the player is now on hole ${h.holeNumber}, ` +
    `par ${h.par}${yardsClause}. Disregard any earlier hole. ` +
    `For live numbers call your tools (get_conditions, get_recommendation) with ` +
    `hole_number ${h.holeNumber}; never answer from a previous hole.`
  );
}
