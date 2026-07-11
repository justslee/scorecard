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
 * buildHoleContextText — the silent re-anchor item sent on connect, on every
 * hole change, AND on a yardage-basis flip (GPS acquired/lost — specs/
 * caddie-yardage-gps-selected-tee-plan.md §2.3) — see
 * specs/caddie-stale-hole-live-plan.md §2/§3.2 for the original hole-change
 * mechanism. Never spoken and never rendered as a transcript bubble (see
 * RealtimeCaddieClient.sendContext), so verbosity is fine here — pure,
 * DOM-free, network-free, unit-testable.
 */
export interface HoleContext {
  holeNumber: number;
  par: number;
  /** Resolved yardage (lib/caddie/hole-yardage.ts) — null when nothing honest
   *  is known yet. NEVER the mock illustration constant. */
  yards: number | null;
  /** Provenance of `yards` — drives the "GPS from where the player stands
   *  NOW" / "from the {teeName} tees" wording so the live session never
   *  claims a source it doesn't have. Omitted/null with a non-null `yards`
   *  reads as a bare, unqualified number (legacy/card-snapshot callers). */
  basis?: 'gps' | 'tee-card' | 'tee-geom' | 'card' | null;
  teeName?: string | null;
}

export function buildHoleContextText(h: HoleContext): string {
  let yardsClause: string;
  if (h.yards == null) {
    yardsClause = ', yardage not yet known';
  } else if (h.basis === 'gps') {
    yardsClause =
      `, ${h.yards} yards to the middle of the green — GPS from where the player ` +
      `stands NOW, this is the player's real number, use it`;
  } else if (h.teeName && (h.basis === 'tee-card' || h.basis === 'tee-geom')) {
    yardsClause = `, ${h.yards} yards from the ${h.teeName} tees (the tees this player is playing)`;
  } else {
    yardsClause = `, ${h.yards} yards`;
  }
  return (
    `Course update — ground truth: the player is now on hole ${h.holeNumber}, ` +
    `par ${h.par}${yardsClause}. Disregard any earlier hole. ` +
    `For live numbers call your tools (get_conditions, get_recommendation) with ` +
    `hole_number ${h.holeNumber}; never answer from a previous hole.`
  );
}
