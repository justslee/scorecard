/**
 * A3 — the clarify turn for AMBIGUOUS spoken course names
 * (specs/course-selection-a3-plan.md).
 *
 * A2 (`course-resolve.ts`) resolves a single spoken name to one real facility
 * OR surfaces 2-4 real candidates when the name is genuinely ambiguous (two
 * "Marine Park"s in different cities). This module is the PURE decision
 * layer for the follow-up turn: matching the golfer's reply ("the Brooklyn
 * one", "the first one", "Old Bridge") against those candidates, and routing
 * that reply against the page's normal parse so a bare "yes"/topic-change
 * never accidentally dispatches a guess. `caddie-task.ts` consumes both to
 * compute the actual apply plan; this module never touches page state.
 */

import { identifyingTokens } from "@/lib/course-search-helpers";
import type { TeeTimePrefsParseResultValidated } from "@/lib/voice/schemas";
import type { ResolvedCandidate } from "@/lib/teetime/course-resolve";

/** Page-owned pending state while a clarify question is outstanding. */
export interface PendingCourseClarify {
  /** Original spoken name, for honest copy. */
  name: string;
  /** Nearest-first, as the resolver ordered them. */
  candidates: ResolvedCandidate[];
  /** Did the original turn already have a window or an explicit go-ahead? */
  armed: boolean;
  /** Asks already answered-and-missed (0 right after the first ask). */
  attempts: number;
}

export type ClarifyReplyMatch =
  | { kind: "picked"; candidate: ResolvedCandidate }
  | { kind: "ambiguous" } // 2+ candidates matched
  | { kind: "none" };

// ── Ordinal stage ────────────────────────────────────────────────────────

const ORDINAL_WORD_INDEX: Record<string, number> = {
  first: 0,
  "1st": 0,
  second: 1,
  "2nd": 1,
  third: 2,
  "3rd": 2,
  fourth: 3,
  "4th": 3,
};
const NUMBER_WORD_INDEX: Record<string, number> = { one: 0, two: 1, three: 2, four: 3 };

const ORDINAL_RE = /\b(first|1st|second|2nd|third|3rd|fourth|4th)\b/;
const NUMBER_RE = /\bnumber\s+(one|two|three|four|\d+)\b/;
const LAST_ONE_RE = /\b(?:the\s+)?last\s+one\b/;

/** Resolve an ordinal reply to a candidate index. Out-of-range (a real
 *  ordinal word naming a slot beyond `count`, or an unrecognized ordinal like
 *  "fifth") → null so the caller falls through to the next stage. */
function matchOrdinal(transcript: string, count: number): number | null {
  if (count === 0) return null;
  const t = transcript.toLowerCase();
  if (LAST_ONE_RE.test(t)) return count - 1;

  const numMatch = t.match(NUMBER_RE);
  if (numMatch) {
    const raw = numMatch[1];
    const idx = /^\d+$/.test(raw) ? Number(raw) - 1 : NUMBER_WORD_INDEX[raw];
    return idx != null && idx >= 0 && idx < count ? idx : null;
  }

  const ordMatch = t.match(ORDINAL_RE);
  if (ordMatch) {
    const idx = ORDINAL_WORD_INDEX[ordMatch[1]];
    return idx != null && idx >= 0 && idx < count ? idx : null;
  }

  return null;
}

// ── Locality stage ───────────────────────────────────────────────────────

/** Full state names spoken instead of an abbreviation ("the New Jersey
 *  one") — mapped to the abbreviation localityLabel tokens actually carry.
 *  Not exhaustive of every US territory; the common 50 states cover the
 *  golfer's realistic spoken reply. */
const STATE_NAME_TO_ABBR: Record<string, string> = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca",
  colorado: "co", connecticut: "ct", delaware: "de", florida: "fl", georgia: "ga",
  hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia",
  kansas: "ks", kentucky: "ky", louisiana: "la", maine: "me", maryland: "md",
  massachusetts: "ma", michigan: "mi", minnesota: "mn", mississippi: "ms",
  missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv",
  "new hampshire": "nh", "new jersey": "nj", "new mexico": "nm", "new york": "ny",
  "north carolina": "nc", "north dakota": "nd", ohio: "oh", oklahoma: "ok",
  oregon: "or", pennsylvania: "pa", "rhode island": "ri", "south carolina": "sc",
  "south dakota": "sd", tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt",
  virginia: "va", washington: "wa", "west virginia": "wv", wisconsin: "wi",
  wyoming: "wy",
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace whole spoken state names with the abbreviation localityLabel
 *  tokens carry, so "the New Jersey one" lines up with a "nj" token. */
function normalizeStateNames(text: string): string {
  let out = text;
  for (const [full, abbr] of Object.entries(STATE_NAME_TO_ABBR)) {
    out = out.replace(new RegExp(`\\b${full}\\b`, "g"), abbr);
  }
  return out;
}

function localityTokens(candidate: ResolvedCandidate): string[] {
  return candidate.localityLabel.toLowerCase().split(/[,\s]+/).filter(Boolean);
}

function localityMatches(transcript: string, candidates: ResolvedCandidate[]): ResolvedCandidate[] {
  const normalized = normalizeStateNames(transcript.toLowerCase());
  return candidates.filter((c) => {
    const tokens = localityTokens(c);
    return tokens.some((tok) => new RegExp(`\\b${escapeRegExp(tok)}\\b`).test(normalized));
  });
}

// ── Name-token stage ─────────────────────────────────────────────────────

/** Sequence-equal identifying tokens = the golfer repeated the (bare)
 *  facility name. Mirrors course-resolve.ts's isExactFacilityMatch — two
 *  candidates that reduce to the SAME identifying tokens (e.g. "Golf Course"
 *  vs "Golf Club" of the same name) both match, which is exactly what keeps
 *  a bare name repeat from silently re-picking one of them. */
function nameMatches(transcript: string, candidates: ResolvedCandidate[]): ResolvedCandidate[] {
  const replyTokens = identifyingTokens(transcript);
  if (replyTokens.length === 0) return [];
  return candidates.filter((c) => {
    const nameTokens = identifyingTokens(c.name);
    return nameTokens.length === replyTokens.length && nameTokens.every((t, i) => t === replyTokens[i]);
  });
}

/**
 * Match a clarify reply against the pending candidates. Staged — the first
 * stage with ≥1 hit decides: ordinal, then locality tokens, then name
 * tokens. A unique hit within a stage → picked; 2+ → ambiguous (never
 * guesses between them); 0 in every stage → none.
 */
export function matchClarifyReply(transcript: string, candidates: ResolvedCandidate[]): ClarifyReplyMatch {
  const t = transcript.trim();
  if (!t || candidates.length === 0) return { kind: "none" };

  const ordIdx = matchOrdinal(t, candidates.length);
  if (ordIdx != null) return { kind: "picked", candidate: candidates[ordIdx] };

  const localityHits = localityMatches(t, candidates);
  if (localityHits.length === 1) return { kind: "picked", candidate: localityHits[0] };
  if (localityHits.length >= 2) return { kind: "ambiguous" };

  const nameHits = nameMatches(t, candidates);
  if (nameHits.length === 1) return { kind: "picked", candidate: nameHits[0] };
  if (nameHits.length >= 2) return { kind: "ambiguous" };

  return { kind: "none" };
}

/** True when the parse carries a real, non-dispatch signal — a topic change
 *  the clarify lane must yield to. `dispatch` (a bare "yes"/"go ahead") is
 *  DELIBERATELY excluded: while pending, a bare go-ahead must never dispatch
 *  a guessed course, so it stays in the clarify lane for a re-ask instead of
 *  escaping as a "topic change". */
function hasNonDispatchSignal(parsed: TeeTimePrefsParseResultValidated): boolean {
  return (
    parsed.windows.length > 0 ||
    parsed.courseNames.length > 0 ||
    parsed.unresolvedCourseNames.length > 0 ||
    parsed.favoritesOnly ||
    parsed.partySize != null ||
    parsed.maxPriceUsd != null ||
    parsed.maxDistanceMiles != null
  );
}

/**
 * The page's whole routing decision for one utterance while a clarify
 * question is pending. Pure and testable — `caddie-task.ts`/`page.tsx` own
 * everything else.
 *
 * - No pending → null (normal turn; a clarify-shaped utterance with nothing
 *   pending falls through to converse exactly as today).
 * - A pick (ordinal/locality/name) → the clarify lane, regardless of any
 *   other signal in the same utterance (windows/party/price merge in apply).
 * - Not a pick AND the utterance carries a real non-dispatch signal → null:
 *   topic change, the normal turn (incl. a fresh A2 resolve) takes over and
 *   clears pending.
 * - Otherwise (bare "yes", silence-noise, an unrecognized reply) → the
 *   clarify lane with the none/ambiguous match, for a re-ask or bail.
 */
export function routeClarifyReply(
  transcript: string,
  parsed: TeeTimePrefsParseResultValidated,
  pending: PendingCourseClarify | null,
): { pending: PendingCourseClarify; match: ClarifyReplyMatch } | null {
  if (!pending) return null;
  const match = matchClarifyReply(transcript, pending.candidates);
  if (match.kind === "picked") return { pending, match };
  if (hasNonDispatchSignal(parsed)) return null;
  return { pending, match };
}
