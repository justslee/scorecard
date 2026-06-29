// Pure player name disambiguation — fuzzy + phonetic matching against the saved roster.
// Reuses normalizeName and similarity from @/lib/voice/utils (no duplication).

import type { SavedPlayer } from "@/lib/types";
import { normalizeName, similarity } from "@/lib/voice/utils";

// ---------------------------------------------------------------------------
// Soundex — classic 4-char phonetic key (American Soundex)
// ---------------------------------------------------------------------------

// Digit map: consonants → soundex code digit. Vowels, H, W, Y have no entry
// and resolve to "0" (ignored when encoding, but used for adjacency tracking).
const SDXMAP: Record<string, string> = {
  b: "1", f: "1", p: "1", v: "1",
  c: "2", g: "2", j: "2", k: "2", q: "2", s: "2", x: "2", z: "2",
  d: "3", t: "3",
  l: "4",
  m: "5", n: "5",
  r: "6",
};

/**
 * Classic 4-character American Soundex phonetic key.
 * Returns uppercase first letter + 3 digits, zero-padded, e.g. "D120".
 * Empty / non-alpha input returns "0000".
 *
 * Key property: phonetically similar names produce the same key.
 *   soundex("Dipak") === soundex("Deepak") === "D120"
 */
export function soundex(s: string): string {
  const alpha = s.toLowerCase().replace(/[^a-z]/g, "");
  if (!alpha) return "0000";

  const first = alpha[0].toUpperCase();
  let code = first;
  // Initialize prev to the digit of the first letter so that the first
  // consonant after the initial letter with the same code doesn't duplicate.
  let prev = SDXMAP[alpha[0]] ?? "0";

  for (let i = 1; i < alpha.length && code.length < 4; i++) {
    const ch = alpha[i];
    // H and W do not act as separators — they are invisible to the algorithm.
    if (ch === "h" || ch === "w") continue;

    const digit = SDXMAP[ch] ?? "0";
    // Only append non-zero digits that differ from the previous encoded digit.
    // Vowels (digit "0") reset prev so that same-coded consonants separated
    // by a vowel are each coded (e.g. "ama" → codes both m's independently).
    if (digit !== "0" && digit !== prev) {
      code += digit;
    }
    prev = digit;
  }

  return code.padEnd(4, "0");
}

// ---------------------------------------------------------------------------
// Single-name match
// ---------------------------------------------------------------------------

/** Default confidence threshold. */
const MIN_MATCH = 0.72;

/**
 * Minimum plain-similarity score required before a phonetic key match is
 * allowed to win. Guards against unrelated names that share a Soundex key.
 */
const PHONETIC_SIM_FLOOR = 0.5;

/** Score assigned when the phonetic path wins (sits above MIN_MATCH). */
const PHONETIC_SCORE = 0.8;

/**
 * Minimum character length (the shorter of spoken vs candidate) required to
 * allow the fuzzy similarity path. Below this length, only an exact normalized
 * match is accepted. Prevents containment boosts like "Dan" -> "Dane" (0.92)
 * or cross-linking "Dan" -> "Don" via Levenshtein drift.
 */
const MIN_LEN_FUZZY = 4;

/**
 * Minimum character length (the shorter of spoken vs candidate) required to
 * allow the Soundex phonetic boost. 3-letter names share Soundex codes too
 * readily (Dan/Don both D500, Tim/Tom both T500, Jon/Jan both J500) so the
 * phonetic path is only trusted for longer names where the key is a meaningful
 * discriminator (Dipak/Deepak both D120, Robert/Rupert both R163).
 */
const MIN_LEN_PHONETIC = 5;

export type MatchVia = "exact" | "fuzzy" | "phonetic" | "none";

export interface MatchResult {
  player: SavedPlayer | null;
  score: number;
  via: MatchVia;
}

/**
 * Match a single spoken player name against a saved-player roster.
 *
 * Both `name` and `nickname` of each SavedPlayer are treated as candidates.
 * The best score across all (player, candidate) pairs determines the result.
 *
 * Scoring strategy (highest score wins):
 *   1. Exact normalized equality           → 1.0       (via: "exact")  [always]
 *   2. `similarity()` from voice/utils     → [0, 1)    (via: "fuzzy")
 *      [only when min(spoken.len, cand.len) >= MIN_LEN_FUZZY=4]
 *   3. Soundex phonetic key match AND
 *      first normalized letter match AND
 *      plain similarity ≥ PHONETIC_SIM_FLOOR → PHONETIC_SCORE  (via: "phonetic")
 *      [only when min(spoken.len, cand.len) >= MIN_LEN_PHONETIC=5]
 *
 * Length guards prevent false matches for short names (Dan/Don, Tim/Tom,
 * Dan/Dane) while keeping the phonetic path for longer names (Dipak/Deepak,
 * Robert/Rupert) where Soundex is a reliable discriminator.
 *
 * Returns `{ player: null, ..., via: "none" }` when:
 *   - roster is empty, or
 *   - best score is below the threshold (default MIN_MATCH = 0.72).
 */
export function matchPlayerName(
  spoken: string,
  roster: SavedPlayer[],
  opts?: { minScore?: number }
): MatchResult {
  const threshold = opts?.minScore ?? MIN_MATCH;
  const normSpoken = normalizeName(spoken);
  const sdxSpoken = soundex(normSpoken);

  if (!normSpoken || roster.length === 0) {
    return { player: null, score: 0, via: "none" };
  }

  let bestPlayer: SavedPlayer | null = null;
  let bestScore = 0;
  let bestVia: MatchVia = "none";

  for (const sp of roster) {
    // Consider both name and nickname (nickname may be undefined).
    const candidates: string[] = [sp.name];
    if (sp.nickname) candidates.push(sp.nickname);

    for (const cand of candidates) {
      const normCand = normalizeName(cand);
      if (!normCand) continue;

      // 1. Exact normalized match — perfect score, no need to check further.
      //    This path is always available regardless of name length, so "Bob"→"Bob"
      //    and short-nickname matches (e.g. "JB"→"JB") still link correctly.
      if (normSpoken === normCand) {
        if (1.0 > bestScore) {
          bestScore = 1.0;
          bestPlayer = sp;
          bestVia = "exact";
        }
        break; // done with this player's candidates
      }

      // Length of the shorter of the two sides — used to gate fuzzy/phonetic.
      const minLen = Math.min(normSpoken.length, normCand.length);

      // 2. Fuzzy similarity (Levenshtein + containment boost from voice/utils).
      //    Gated on MIN_LEN_FUZZY: for very short names the containment boost
      //    fires on unrelated names (e.g. "dan".startsWith("dan") ⊂ "dane" → 0.92).
      //    Short names (< 4 chars) only link via exact equality (path 1 above).
      let sim = 0;
      if (minLen >= MIN_LEN_FUZZY) {
        sim = similarity(normSpoken, normCand);
        if (sim > bestScore) {
          bestScore = sim;
          bestPlayer = sp;
          bestVia = "fuzzy";
        }
      }

      // 3. Phonetic boost: Soundex keys collide AND first letter matches AND
      //    plain similarity is already "close" AND name is long enough.
      //    The MIN_LEN_PHONETIC guard blocks Dan/Don, Tim/Tom, Jon/Jan (all 3
      //    chars, D500/T500/J500) while allowing Dipak/Deepak (5+6, D120) and
      //    Robert/Rupert (both 6, R163) where the key is meaningful.
      const sdxCand = soundex(normCand);
      if (
        minLen >= MIN_LEN_PHONETIC &&
        sdxSpoken === sdxCand &&
        normSpoken[0] === normCand[0] &&
        sim >= PHONETIC_SIM_FLOOR &&
        PHONETIC_SCORE > bestScore
      ) {
        bestScore = PHONETIC_SCORE;
        bestPlayer = sp;
        bestVia = "phonetic";
      }
    }
  }

  if (bestScore < threshold) {
    return { player: null, score: bestScore, via: "none" };
  }

  return { player: bestPlayer, score: bestScore, via: bestVia };
}

// ---------------------------------------------------------------------------
// Multi-slot matching with deduplication
// ---------------------------------------------------------------------------

export interface SlotResult extends MatchResult {
  /** The original spoken name (used for free-text fallback display). */
  name: string;
}

/**
 * Match a list of spoken player names against the roster, preventing the same
 * SavedPlayer.id from being linked to two different spoken slots.
 *
 * When two slots would resolve to the same saved id, the FIRST confident slot
 * retains the link; later duplicate slots fall back to free-text (player: null).
 * This mirrors the intent of the de-dup logic in handleTeeOff.
 */
export function matchPlayerNames(
  spoken: string[],
  roster: SavedPlayer[]
): SlotResult[] {
  const usedIds = new Set<string>();

  return spoken.map((name) => {
    const result = matchPlayerName(name, roster);

    if (result.player) {
      if (usedIds.has(result.player.id)) {
        // Duplicate — demote this slot to free-text.
        return { name, player: null, score: result.score, via: "none" as MatchVia };
      }
      usedIds.add(result.player.id);
    }

    return { name, ...result };
  });
}
