// Keyterm prompting (specs/voice-agent-audit.md P1.1): bias Deepgram nova-3
// toward the words this app actually hears — club names, golf scoring terms,
// the golfer's player names, and nearby course names. SOTA voice agents always
// send domain vocabulary; before this, we sent none (so "Bethpage" could come
// back "bath page" and "gimme" as "give me").

/** Baseline golf vocabulary — high-confusion terms worth boosting everywhere. */
export const GOLF_KEYTERMS: readonly string[] = [
  "birdie",
  "bogey",
  "double bogey",
  "eagle",
  "albatross",
  "mulligan",
  "gimme",
  "up and down",
  "fairway",
  "tee box",
  "pitching wedge",
  "sand wedge",
  "lob wedge",
  "gap wedge",
  "hybrid",
  "3-wood",
  "5-wood",
  "driver",
  "putter",
  "yardage",
  "dogleg",
  "carry",
  "layup",
  "pin high",
] as const;

/** Deepgram accepts many keyterms but each costs a little accuracy budget —
 *  keep the total tight and put the most specific terms first. */
export const MAX_KEYTERMS = 50;

/**
 * Merge context terms (player names, course names) with the golf baseline:
 * context first (most specific wins the budget), deduped case-insensitively,
 * blanks dropped, capped at MAX_KEYTERMS.
 */
export function buildKeyterms(...contextTerms: Array<readonly string[] | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (term: string) => {
    const t = term.trim();
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  for (const list of contextTerms) for (const t of list ?? []) push(t);
  for (const t of GOLF_KEYTERMS) push(t);
  return out.slice(0, MAX_KEYTERMS);
}

/** Repeated &keyterm= query fragment for the live WS URL ('' when empty). */
export function keytermQuery(terms: readonly string[]): string {
  return terms.map((t) => `&keyterm=${encodeURIComponent(t)}`).join("");
}
