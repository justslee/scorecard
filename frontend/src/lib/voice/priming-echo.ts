// Priming-echo classifier (specs/caddie-context-leak-plan.md): the OpenAI
// Realtime input-transcriber (gpt-4o-transcribe) sometimes hallucinates its
// own `transcription.prompt` back as the transcript when server VAD
// false-triggers on silence/ambient noise — either verbatim or paraphrased.
// realtime.ts renders any non-empty transcript as a user chat bubble, so an
// unfiltered echo shows the caddie's own priming context as if the golfer
// said it. This module recognizes that echo from CONTENT (closed-vocabulary
// detection), never from exact-string matching against the minted prompt —
// so it holds across mints, holes, and reconnects.
//
// Pure, no WebRTC/DOM — see realtime-ordering.ts for the sibling pure module
// this is styled after.

import { GOLF_KEYTERMS } from './keyterms';

// Mirror of backend/app/caddie/keyterms.py _HAZARD_TERMS values (the spoken
// words, not the Hazard.type keys) — if you edit either, edit both.
const HAZARD_TERMS = ['water hazard', 'bunker', 'out of bounds', 'trees'];

/** Vocabulary-enumeration density threshold for branch B — see plan §3.1. */
const KEYTERM_DENSITY_THRESHOLD = 10;

/** Minimum segment count for the pure-hazard-list echo, branch C. */
const HAZARD_SEGMENT_MIN = 3;

/**
 * Normalize once: lowercase; curly apostrophes -> straight; hyphens -> spaces
 * (so `3-wood` normalizes the same as a spoken "3 wood"); collapse whitespace.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pre-normalized keyterms, sorted multi-word-first so masking a phrase like
// "double bogey" happens before the single-word "bogey" pass would otherwise
// double-count it. Stable sort preserves GOLF_KEYTERMS order among ties.
const NORMALIZED_KEYTERMS = GOLF_KEYTERMS.map((t) => normalize(t))
  .map((t) => ({ term: t, words: t.split(' ').length }))
  .sort((a, b) => b.words - a.words);

/**
 * Branch B — count DISTINCT GOLF_KEYTERMS present in the normalized
 * transcript (word-boundary matching). Multi-word terms are matched first
 * and their matched spans masked out so a phrase like "double bogey" isn't
 * also counted as a standalone "bogey".
 */
function countDistinctKeyterms(normalized: string): number {
  let working = normalized;
  let count = 0;
  for (const { term } of NORMALIZED_KEYTERMS) {
    const re = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'g');
    if (re.test(working)) {
      count += 1;
      working = working.replace(re, (m) => ' '.repeat(m.length));
    }
  }
  return count;
}

/**
 * Branch C — after stripping an optional leading "this hole" (+ optional
 * colon), split on commas / " and " / periods; true iff there are >= 3
 * non-empty segments and EVERY non-empty segment is a bare hazard term.
 */
function isHazardListEcho(normalized: string): boolean {
  const stripped = normalized.replace(/^this hole:?\s*/, '');
  const segments = stripped
    .split(/,|\band\b|\./)
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0);
  return segments.length >= HAZARD_SEGMENT_MIN && segments.every((seg) => HAZARD_TERMS.includes(seg));
}

/**
 * True iff `transcript` looks like the transcriber echoing its own
 * `transcription.prompt` rather than something the golfer said. Conservative
 * by construction — see plan §3.1 for the false-positive/false-negative
 * tradeoff. Callers should drop (never render, never treat as a turn) when
 * this returns true.
 */
export function isPrimingEcho(transcript: string): boolean {
  if (!transcript || !transcript.trim()) return false;
  const normalized = normalize(transcript);

  // A. Signature-label match — noun phrases that exist only in the prompt.
  if (/\bplayer'?s clubs\b/.test(normalized) || /\bgolf vocabulary\b/.test(normalized)) {
    return true;
  }

  // B. Vocabulary-enumeration density.
  if (countDistinctKeyterms(normalized) >= KEYTERM_DENSITY_THRESHOLD) {
    return true;
  }

  // C. Hazard-list echo.
  if (isHazardListEcho(normalized)) {
    return true;
  }

  return false;
}
