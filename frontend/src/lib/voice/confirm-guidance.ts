// Deterministic, calm guidance for the voice score-confirm step.
//
// When a score parse comes back LOW confidence and one or more players have no
// score, a generic "double-check these" leaves the golfer guessing which name to
// fix. This derives a specific, gentle note ("I didn't catch a score for Jack
// and Mia") straight from the parse result — no LLM, no backend — so the on-course
// voice flow tells you exactly what to re-say or tap. Pure + unit-tested.

/** Confidence at/under this is "low" — mirrors VoiceConfirmPanel's threshold. */
export const LOW_CONFIDENCE_THRESHOLD = 0.65;

/** Join names the way a person would: "A", "A and B", "A, B, and C". */
export function joinNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** Names of players the parse produced no score for, in roster order. */
export function missingPlayerNames(
  players: { name: string }[],
  parsedScores: Record<string, number>,
): string[] {
  return players
    .map((p) => p.name)
    .filter((name) => parsedScores[name] === undefined);
}

/**
 * A calm note naming the players the voice parse missed — shown ONLY when the
 * parse is low-confidence AND at least one (but not every) player is missing a
 * score. Returns null when there's nothing useful to say:
 *  - confidence is unknown or high (the parse is trusted),
 *  - no players are missing (nothing to flag), or
 *  - EVERY player is missing (the parse caught nothing — the panel's empty
 *    state already covers that; naming everyone would just be noise).
 */
export function missingScoreNote(
  players: { name: string }[],
  parsedScores: Record<string, number>,
  confidence: number | undefined,
): string | null {
  if (typeof confidence !== "number" || confidence >= LOW_CONFIDENCE_THRESHOLD) {
    return null;
  }
  const missing = missingPlayerNames(players, parsedScores);
  if (missing.length === 0 || missing.length === players.length) return null;
  // Just name who was missed — the amber tiles invite the tap and the footer
  // owns "try again", so the note stays quiet (Northstar: minimal chrome).
  return `I didn't catch a score for ${joinNames(missing)}.`;
}
