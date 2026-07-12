// No-input clarifier classifier (specs/caddie-noise-clarification-reply-plan.md):
// on a noisy course, server VAD sometimes false-triggers on ambient noise and
// commits a no-signal audio turn. Following INPUT_GROUNDING_RULE
// (backend/app/caddie/voice_prompts.py), the model then speaks a "Didn't
// catch that — say again?" clarifier — freely paraphrased. Because the
// triggering turn produced no real user transcript (empty, or a
// priming-echo — see priming-echo.ts), realtime.ts would otherwise render a
// LONE assistant bubble with no user turn above it: the caddie appears to
// talk to itself. This module recognizes that clarifier shape from CONTENT
// (closed-vocabulary detection), never from exact-string matching against
// the persona's canonical phrase — so it holds across paraphrases and mints.
//
// Pure, no WebRTC/DOM — see realtime-ordering.ts / priming-echo.ts for the
// sibling pure modules this is styled after.

/** Above this many words, a reply is no longer clarifier-shaped — real
 *  answers routinely run longer than a bare "say again?". */
const MAX_CLARIFIER_WORDS = 14;

/** Release the hold if the correlated speech-turn transcript never resolves
 *  after the response finalizes — see realtime.ts's resolveHeldFor(). */
export const NOINPUT_RESOLVE_GRACE_MS = 2000;

// Closed vocabulary — ask-again function words only. No club/number/distance/
// hazard/direction/target word belongs here BY DESIGN: any substantive caddie
// reply names one of those, so it fails rule 5 (and usually rule 3, the digit
// ban) before a marker phrase is even consulted. See "Why this can't swallow
// a legit clarifier" in the plan.
const CLARIFIER_VOCAB = new Set([
  'i', 'im', 'sorry', 'didnt', 'dont', 'quite', 'catch', 'caught', 'get', 'got',
  'hear', 'heard', 'that', 'say', 'it', 'could', 'can', 'you', 'please', 'again',
  'what', 'was', 'missed', 'come', 'repeat', 'one', 'more', 'time', 'me', 'by',
  'run', 'there', 'pardon', 'huh', 'just', 'a', 'the', 'bit',
]);

// At least one of these must appear (as a substring of the normalized,
// space-joined text) for a candidate to count as an actual ask-again
// clarifier, not merely a string of function words.
const MARKER_PHRASES = [
  'say again',
  'say that again',
  'say it again',
  'catch that',
  'come again',
  'repeat that',
  'repeat it',
  'one more time',
  'didnt hear',
  'didnt get that',
  'missed that',
  'run that by me again',
  'try that again',
];

/**
 * Normalize once: lowercase; curly apostrophes -> straight, then strip
 * apostrophes (`didn't` -> `didnt`, so the possessive-free CLARIFIER_VOCAB
 * matches regardless of contraction spelling); em/en-dashes and hyphens ->
 * spaces; strip remaining punctuation; collapse whitespace; trim.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/'/g, '')
    .replace(/[—–-]/g, ' ')
    .replace(/[.,!?;:…"()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(normalized: string): string[] {
  return normalized.length ? normalized.split(' ') : [];
}

/**
 * True iff `responseText` reads as a pure ask-again clarifier AND the turn
 * that triggered it provably had no real user input. Callers pass
 * `hadRealUserInput` from the response↔input correlation in realtime.ts
 * (§2 of the plan) — this module never sees WebRTC state itself.
 *
 * ALL of the following must hold (plan §3.1):
 *   1. hadRealUserInput === false — the gate. A clarifier following real
 *      input is a legitimate reply by definition, never suppressed.
 *   2. normalized text non-empty.
 *   3. contains no digit — no club distance/number ever reads as ask-again.
 *   4. <= MAX_CLARIFIER_WORDS words.
 *   5. every word is in CLARIFIER_VOCAB.
 *   6. contains at least one MARKER_PHRASES substring.
 */
export function isNoInputClarifier(responseText: string, hadRealUserInput: boolean): boolean {
  if (hadRealUserInput) return false;
  const normalized = normalize(responseText);
  if (!normalized) return false;
  if (/\d/.test(normalized)) return false;

  const ws = words(normalized);
  if (ws.length === 0 || ws.length > MAX_CLARIFIER_WORDS) return false;
  if (!ws.every((w) => CLARIFIER_VOCAB.has(w))) return false;

  return MARKER_PHRASES.some((marker) => normalized.includes(marker));
}

/**
 * Streaming hold test — called on every delta while a response's trigger
 * turn hasn't yet classified as 'real'. True means "still plausibly a
 * clarifier — keep holding"; false means "diverged — release/emit now".
 *
 * Empty partial -> true (nothing to judge yet). Digit -> false. Too many
 * words -> false. Every word except the last must be in CLARIFIER_VOCAB;
 * the last word (which a delta boundary may have split mid-word) must be in
 * CLARIFIER_VOCAB OR a prefix of some vocab word. No marker-phrase check —
 * markers may not have streamed in yet.
 */
export function couldBecomeClarifier(partialText: string): boolean {
  const normalized = normalize(partialText);
  if (!normalized) return true;
  if (/\d/.test(normalized)) return false;

  const ws = words(normalized);
  if (ws.length > MAX_CLARIFIER_WORDS) return false;

  const complete = ws.slice(0, -1);
  const last = ws[ws.length - 1] ?? '';
  if (!complete.every((w) => CLARIFIER_VOCAB.has(w))) return false;
  if (last === '') return true;
  if (CLARIFIER_VOCAB.has(last)) return true;
  for (const vocabWord of CLARIFIER_VOCAB) {
    if (vocabWord.startsWith(last)) return true;
  }
  return false;
}
