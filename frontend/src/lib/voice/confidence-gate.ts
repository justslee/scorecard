/**
 * Cascaded-STT feasibility spike — deterministic Deepgram confidence gate.
 *
 * See specs/cascaded-stt-spike-plan.md. Question: can a hard, testable
 * confidence gate on Deepgram's utterance/word confidence stop the live
 * caddie from confidently answering MISHEARD audio ("makes up words"), at an
 * acceptable latency cost versus the shipped speech-to-speech orb?
 *
 * `parseDeepgramLiveMessage()` (./deepgram-live.ts) already extracts
 * {transcript, isFinal} from Deepgram streaming Results frames and DISCARDS
 * `alternatives[0].confidence` (utterance-level, 0..1) and
 * `alternatives[0].words[].confidence` (per-word). That discarded signal is
 * the entire spike. `extractGateInput` below deliberately PARALLELS rather
 * than extends parseDeepgramLiveMessage — the shipped parser stays
 * byte-identical (its test file forbids modification) and this module owns
 * its own extraction so it can be deleted wholesale if the spike disproves.
 *
 * Calibration (read before trusting a number): the floors below are
 * UNCALIBRATED placeholders chosen from Deepgram's documented behavior
 * (clean nova-3 speech typically scores well above 0.85; garble lands much
 * lower) — NOT tuned against real audio. Real calibration requires logging
 * (confidence, words, was-the-answer-wrong) pairs from the classic sheet in
 * prod before trusting any threshold. This module proves the gate LOGIC and
 * TESTABILITY, not the numbers.
 *
 * Fail-open rationale: when the confidence signal is missing entirely
 * (confidence === null AND words === []), gateTranscript ACCEPTs. Missing
 * confidence most likely means upstream schema drift, not that the audio was
 * bad; fail-closed would turn a format change into a caddie that silently
 * rejects EVERY utterance. The gate is additive — failing open just degrades
 * to exactly today's shipped behavior (the soft INPUT_GROUNDING_RULE nudge in
 * backend/app/caddie/voice_prompts.py is still active). Matches the codebase
 * philosophy that failures degrade silently and the final path stays
 * authoritative (see deepgram-live.ts's header).
 *
 * NOT wired live. CONFIDENCE_GATE_ENABLED defaults to false and nothing reads
 * it yet — this is a pure, standalone module with zero call sites outside its
 * own test file. Per the plan's architecture options, it WOULD attach at
 * either:
 *   (B) CaddieSheet.tsx stopListening(), after pickDictationTranscript and
 *       before askCaddie() (~line 992) — reject there and speak
 *       REPROMPT_LINE instead of calling the caddie.
 *   (C, recommended candidate) realtime.ts sendText() — feed Deepgram STT +
 *       this gate ahead of the live orb; on ACCEPT, sendText() the verified
 *       transcript so Realtime still does low-latency LLM+TTS; on REJECT,
 *       play REPROMPT_LINE locally without waking the LLM.
 * Neither attach point is touched by this spike.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface DeepgramWord {
  word: string;
  confidence: number;
}

export interface GateInput {
  transcript: string;
  /** Utterance-level confidence (0..1); null when Deepgram omitted it. */
  confidence: number | null;
  /** Per-word confidence; [] when Deepgram omitted it. */
  words: DeepgramWord[];
}

export type GateRejectReason = 'empty' | 'low-utterance-conf' | 'low-word-conf';

export type GateVerdict =
  | { verdict: 'ACCEPT' }
  | { verdict: 'REJECT'; reason: GateRejectReason; detail?: string };

// ── Tunable constants (UNCALIBRATED placeholders — see header) ─────────────

/** Below this utterance confidence, reject (normal / non-short path). */
export const UTTERANCE_CONFIDENCE_FLOOR = 0.6;

/** Below this per-word confidence, any CONTENT word rejects the utterance. */
export const WORD_CONFIDENCE_FLOOR = 0.45;

/** Lower floor used for short (terse-question) utterances — see §3 of the
 *  plan: "driver?", "what club", "how far" are normal on-course speech, and
 *  for a one-word utterance word-conf ≈ utterance-conf, so the normal floor
 *  would double-penalize it. */
export const SHORT_UTTERANCE_CONFIDENCE_FLOOR = 0.45;

/** An utterance with this many CONTENT words or fewer takes the short path
 *  (lower floor, no per-word check). */
export const SHORT_UTTERANCE_MAX_CONTENT_WORDS = 2;

/** Common English fillers/stopwords that never count as content and never
 *  trigger low-word-conf, and are excluded from the short-utterance word
 *  count (so "uh driver?" is still a 1-content-word short utterance). */
export const FILLER_WORDS: ReadonlySet<string> = new Set([
  'uh',
  'um',
  'er',
  'ah',
  'a',
  'an',
  'the',
  'is',
  'it',
  'to',
  'of',
  'and',
  'so',
  'like',
  'you',
  'know',
]);

/** Spoken back to the golfer on REJECT — matches INPUT_GROUNDING_RULE phrasing
 *  (backend/app/caddie/voice_prompts.py) so the tone is consistent whichever
 *  layer ends up rejecting. Not wired anywhere yet. */
export const REPROMPT_LINE = "Didn't catch that — say again?";

/** Future attach point (see header). Nothing reads this yet — the spike
 *  ships the gate logic behind a default-off flag with zero live wiring. */
export const CONFIDENCE_GATE_ENABLED = false;

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Lowercase + strip trailing punctuation so "driver?" / "Driver." / "DRIVER"
 *  all compare equal. Defensive against non-string input (malformed frames
 *  parsed elsewhere could hand this something unexpected at runtime even
 *  though the type says `string`). */
function normalizeWord(word: string): string {
  if (typeof word !== 'string') return '';
  return word.toLowerCase().replace(/[.,!?;:]+$/, '');
}

function isFillerWord(word: string): boolean {
  return FILLER_WORDS.has(normalizeWord(word));
}

/** True finite number check — guards against NaN / non-number confidence
 *  values reaching a numeric comparison (never throws, just treated as "no
 *  usable signal for this word"). */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// ── gateTranscript ───────────────────────────────────────────────────────────

/**
 * Decide ACCEPT/REJECT for one utterance. Pure, synchronous, NEVER throws.
 *
 * 1. Empty/whitespace transcript -> REJECT 'empty'.
 * 2. Content words = words[] minus FILLER_WORDS (case/punctuation-insensitive).
 * 3. Short-utterance path (content words <= SHORT_UTTERANCE_MAX_CONTENT_WORDS):
 *    reject only if utterance confidence is present AND below
 *    SHORT_UTTERANCE_CONFIDENCE_FLOOR; the per-word check is skipped.
 * 4. Normal path: utterance confidence present AND below
 *    UTTERANCE_CONFIDENCE_FLOOR -> REJECT 'low-utterance-conf'; any content
 *    word present with confidence below WORD_CONFIDENCE_FLOOR -> REJECT
 *    'low-word-conf' (detail = that word). Fillers never trigger this.
 * 5. Missing signal (confidence === null AND words === []) -> ACCEPT
 *    (fail-open — see header). More generally: a check only fires when its
 *    signal is present; if neither signal is present, nothing can reject and
 *    the result is ACCEPT.
 */
export function gateTranscript(input: GateInput): GateVerdict {
  const transcript = typeof input.transcript === 'string' ? input.transcript : '';
  if (transcript.trim() === '') {
    return { verdict: 'REJECT', reason: 'empty' };
  }

  const words = Array.isArray(input.words) ? input.words : [];
  const contentWords = words.filter((w) => w && typeof w === 'object' && !isFillerWord(w.word));

  const confidence = isFiniteNumber(input.confidence) ? input.confidence : null;

  if (contentWords.length <= SHORT_UTTERANCE_MAX_CONTENT_WORDS) {
    if (confidence !== null && confidence < SHORT_UTTERANCE_CONFIDENCE_FLOOR) {
      return { verdict: 'REJECT', reason: 'low-utterance-conf' };
    }
    return { verdict: 'ACCEPT' };
  }

  if (confidence !== null && confidence < UTTERANCE_CONFIDENCE_FLOOR) {
    return { verdict: 'REJECT', reason: 'low-utterance-conf' };
  }

  for (const w of contentWords) {
    if (isFiniteNumber(w.confidence) && w.confidence < WORD_CONFIDENCE_FLOOR) {
      return { verdict: 'REJECT', reason: 'low-word-conf', detail: w.word };
    }
  }

  return { verdict: 'ACCEPT' };
}

// ── extractGateInput ─────────────────────────────────────────────────────────

/**
 * Parse a raw Deepgram streaming Results message into a GateInput, PARALLEL
 * to (does not call, does not modify) parseDeepgramLiveMessage in
 * ./deepgram-live.ts.
 *
 * Returns null for non-Results frames (metadata, UtteranceEnd — anything
 * lacking `channel`) and for unparseable JSON. NEVER throws. Tolerates
 * missing/malformed `words[]` entries by skipping them rather than throwing.
 */
export function extractGateInput(
  raw: string,
): (GateInput & { isFinal: boolean }) | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof msg !== 'object' || msg === null) return null;
  const record = msg as Record<string, unknown>;

  // UtteranceEnd / Metadata / SpeechStarted frames carry a `type` and no
  // `channel`. Explicit UtteranceEnd check for clarity; the no-channel
  // fallback below covers it (and Metadata) regardless.
  if (record['type'] === 'UtteranceEnd') return null;
  if (!('channel' in record)) return null;

  const channel = record['channel'];
  if (typeof channel !== 'object' || channel === null) return null;

  const alternatives = (channel as Record<string, unknown>)['alternatives'];
  if (!Array.isArray(alternatives) || alternatives.length === 0) return null;

  const first = alternatives[0];
  if (typeof first !== 'object' || first === null) return null;
  const firstRecord = first as Record<string, unknown>;

  const transcript =
    typeof firstRecord['transcript'] === 'string' ? firstRecord['transcript'] : '';

  const confidenceRaw = firstRecord['confidence'];
  const confidence = isFiniteNumber(confidenceRaw) ? confidenceRaw : null;

  const wordsRaw = firstRecord['words'];
  const words: DeepgramWord[] = [];
  if (Array.isArray(wordsRaw)) {
    for (const entry of wordsRaw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const w = entry as Record<string, unknown>;
      const word = w['word'];
      const wordConfidence = w['confidence'];
      // Tolerate malformed entries (missing word/confidence, wrong types) by
      // skipping them — extra fields (punctuated_word, start, end) are
      // simply ignored, not an error.
      if (typeof word === 'string' && isFiniteNumber(wordConfidence)) {
        words.push({ word, confidence: wordConfidence });
      }
    }
  }

  const isFinal = record['is_final'] === true;

  return { transcript, confidence, words, isFinal };
}
