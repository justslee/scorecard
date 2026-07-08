// Incremental sentence extractor for TTS pipelining
// (specs/caddie-realtime-conversation-plan.md §6.5.4, Slice A2). Feed
// streamed deltas via push(); it returns any newly-completed sentences
// (usually 0 or 1 per call) and keeps the trailing partial buffered until
// either more text arrives or flush() is called at stream end.
//
// Deliberately NOT an NLP library — a focused boundary regex plus a small
// guard against the two false-positive shapes that actually show up in
// caddie replies: abbreviations ("165 yds.", "Dr. ") and number-continuation
// clauses ("Hit it 250. that's plenty" should stay one sentence). Decimals
// like "3.5" are excluded structurally — a boundary requires whitespace
// immediately after the punctuation, which a decimal point never has.

// Case-insensitive; kept short and specific to what a caddie actually says —
// not a general abbreviation dictionary.
// NOTE: deliberately does NOT include "no" — a sentence-final "No." is
// common in caddie speech ("Into the wind? No. Club up to a 6.") and must
// remain a real boundary. The rare "No. 5" (hole number) false positive is
// harmless here: MIN_TTS_CHUNK_CHARS in CaddieSheet.tsx merges a short
// "No." forward into the next sentence anyway.
const ABBREVIATIONS = new Set([
  "yds",
  "yd",
  "mr",
  "mrs",
  "dr",
  "vs",
  "approx",
  "ft",
  "e.g",
  "i.e",
  "st",
  "jr",
  "sr",
]);

// Punctuation run, optional closing quote/paren, then required whitespace —
// the whitespace requirement is what makes this a genuine mid-stream
// boundary candidate (a decimal point is never followed by whitespace).
const BOUNDARY_SOURCE = /[.!?]+(["')\]]*)(\s+)/;

/** The letters/dots run immediately before `index` — used to recover an
 *  abbreviation like "yds" or "e.g" right before a candidate boundary. */
function precedingWord(buffer: string, index: number): string {
  let i = index;
  while (i > 0 && /[A-Za-z.]/.test(buffer[i - 1])) i--;
  return buffer.slice(i, index);
}

/** The digits run immediately before `index` — used to recover a number
 *  like "250" right before a candidate boundary. */
function precedingNumber(buffer: string, index: number): string {
  let i = index;
  while (i > 0 && /[0-9]/.test(buffer[i - 1])) i--;
  return buffer.slice(i, index);
}

function isFalsePositive(buffer: string, punctStart: number, nextCharIndex: number): boolean {
  const word = precedingWord(buffer, punctStart).toLowerCase();
  if (ABBREVIATIONS.has(word)) return true;

  const number = precedingNumber(buffer, punctStart);
  if (number) {
    const nextChar = buffer[nextCharIndex];
    // A number, then a period, then a lowercase/digit continuation (no
    // capital to start a new sentence) reads as one clause — "Hit it 250.
    // that's plenty", not "...250." / "That's plenty.".
    if (nextChar && /[a-z0-9]/.test(nextChar)) return true;
  }
  return false;
}

export interface SentenceStream {
  /** Feed the next streamed delta. Returns any sentences newly completed by
   *  this delta, in order (usually 0 or 1, but a single delta may complete
   *  more than one). */
  push(delta: string): string[];
  /** Call once the stream is known to be complete. Returns the trailing
   *  buffered partial (if any) as a final "sentence", regardless of whether
   *  it ends in punctuation — e.g. a reply cut off mid-clause. */
  flush(): string[];
}

export function createSentenceStream(): SentenceStream {
  // Instance-scoped regex (not a module constant) so concurrent streams
  // never fight over a shared `lastIndex`.
  const boundaryRe = new RegExp(BOUNDARY_SOURCE, "g");
  let buffer = "";
  let consumed = 0;

  function push(delta: string): string[] {
    buffer += delta;
    const out: string[] = [];
    boundaryRe.lastIndex = consumed;
    let match: RegExpExecArray | null;
    while ((match = boundaryRe.exec(buffer))) {
      const punctStart = match.index;
      // End of the punctuation(+quote) run, i.e. the sentence text excludes
      // the trailing whitespace that terminates it.
      const sentenceEnd = punctStart + match[0].length - match[2].length;
      const nextCharIndex = punctStart + match[0].length;
      if (isFalsePositive(buffer, punctStart, nextCharIndex)) {
        // Not a real boundary — exec()'s own lastIndex already advanced
        // past this match, so the loop just keeps scanning forward.
        continue;
      }
      const sentence = buffer.slice(consumed, sentenceEnd).trim();
      if (sentence) out.push(sentence);
      consumed = nextCharIndex;
      boundaryRe.lastIndex = consumed;
    }
    return out;
  }

  function flush(): string[] {
    const rest = buffer.slice(consumed).trim();
    consumed = buffer.length;
    return rest ? [rest] : [];
  }

  return { push, flush };
}
