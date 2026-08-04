/**
 * Unit tests for the cascaded-STT spike confidence gate
 * (specs/cascaded-stt-spike-plan.md §2.2).
 *
 * Mirrors deepgram-live.test.ts conventions: a small helper builds raw
 * Deepgram streaming Results JSON so extractGateInput can be exercised on
 * realistic wire messages, plus direct GateInput construction for
 * gateTranscript's pure logic.
 */

import { describe, it, expect } from 'vitest';
import {
  gateTranscript,
  extractGateInput,
  FILLER_WORDS,
  UTTERANCE_CONFIDENCE_FLOOR,
  WORD_CONFIDENCE_FLOOR,
  SHORT_UTTERANCE_CONFIDENCE_FLOOR,
  type DeepgramWord,
  type GateInput,
} from './confidence-gate';

// ── Helpers ──────────────────────────────────────────────────────────────────

interface RawWordOpts {
  word: string;
  confidence: number;
  punctuated_word?: string;
  start?: number;
  end?: number;
}

/** Builds a raw Deepgram streaming Results JSON message. `confidence`
 *  omitted -> Deepgram-omitted (extractGateInput must see it as null). */
function makeResultsMsg(opts: {
  transcript: string;
  confidence?: number;
  words?: RawWordOpts[];
  is_final?: boolean;
}): string {
  const { transcript, confidence, words = [], is_final = true } = opts;
  const alternative: Record<string, unknown> = { transcript, words };
  if (confidence !== undefined) alternative.confidence = confidence;
  return JSON.stringify({
    channel: { alternatives: [alternative] },
    is_final,
  });
}

function words(pairs: Array<[string, number]>): DeepgramWord[] {
  return pairs.map(([word, confidence]) => ({ word, confidence }));
}

// ── gateTranscript ───────────────────────────────────────────────────────────

describe('gateTranscript', () => {
  it('ACCEPTs a clean high-confidence golf utterance', () => {
    // "to" and "the" are fillers -> 4 content words (how, far, carry,
    // bunker), so this exercises the normal (non-short) path.
    const input: GateInput = {
      transcript: 'how far to carry the bunker',
      confidence: 0.97,
      words: words([
        ['how', 0.95],
        ['far', 0.96],
        ['to', 0.9],
        ['carry', 0.94],
        ['the', 0.9],
        ['bunker', 0.93],
      ]),
    };
    expect(gateTranscript(input)).toEqual({ verdict: 'ACCEPT' });
  });

  it("REJECTs the owner's real failure — a single garbled short word at low utterance confidence", () => {
    // "Scars" is one content word -> short path; short floor is 0.45, and
    // 0.30 < 0.45, so this must reject via the SHORT floor.
    expect(SHORT_UTTERANCE_CONFIDENCE_FLOOR).toBeGreaterThan(0.3);
    const input: GateInput = {
      transcript: 'Scars',
      confidence: 0.3,
      words: words([['Scars', 0.3]]),
    };
    expect(gateTranscript(input)).toEqual({
      verdict: 'REJECT',
      reason: 'low-utterance-conf',
    });
  });

  it('REJECTs low-word-conf when one content word is far below the word floor, and names it', () => {
    // "the" is a filler -> 3 content words (give, me, yardage) -> normal path.
    const input: GateInput = {
      transcript: 'give me the yardage',
      confidence: 0.9,
      words: words([
        ['give', 0.95],
        ['me', 0.93],
        ['the', 0.9],
        ['yardage', 0.2],
      ]),
    };
    expect(WORD_CONFIDENCE_FLOOR).toBeGreaterThan(0.2);
    const verdict = gateTranscript(input);
    expect(verdict).toEqual({
      verdict: 'REJECT',
      reason: 'low-word-conf',
      detail: 'yardage',
    });
  });

  it('REJECTs low-utterance-conf in the normal path even when every word is individually fine', () => {
    // 4 content words (normal path); utterance conf below the normal floor
    // should reject before the per-word check ever runs.
    expect(UTTERANCE_CONFIDENCE_FLOOR).toBeGreaterThan(0.5);
    const input: GateInput = {
      transcript: 'how far to the green',
      confidence: 0.5,
      words: words([
        ['how', 0.9],
        ['far', 0.9],
        ['to', 0.9],
        ['the', 0.9],
        ['green', 0.9],
      ]),
    };
    expect(gateTranscript(input)).toEqual({
      verdict: 'REJECT',
      reason: 'low-utterance-conf',
    });
  });

  it('never rejects on a low-confidence filler (filler immunity)', () => {
    // Content words: how, far, green, please (4, > 2 -> normal path).
    // "uh"/"to"/"the" are fillers and stay low-confidence without effect.
    const input: GateInput = {
      transcript: 'uh how far to the green please',
      confidence: 0.95,
      words: words([
        ['uh', 0.1],
        ['how', 0.9],
        ['far', 0.9],
        ['to', 0.1],
        ['the', 0.1],
        ['green', 0.9],
        ['please', 0.9],
      ]),
    };
    expect(gateTranscript(input)).toEqual({ verdict: 'ACCEPT' });
  });

  describe('terse-question guard (adversarial — §3 of the plan)', () => {
    it('ACCEPTs "driver?" at 0.55 (>= short floor)', () => {
      const input: GateInput = {
        transcript: 'driver?',
        confidence: 0.55,
        words: words([['driver', 0.55]]),
      };
      expect(gateTranscript(input)).toEqual({ verdict: 'ACCEPT' });
    });

    it('REJECTs "driver?" at 0.30 (< short floor)', () => {
      const input: GateInput = {
        transcript: 'driver?',
        confidence: 0.3,
        words: words([['driver', 0.3]]),
      };
      expect(gateTranscript(input)).toEqual({
        verdict: 'REJECT',
        reason: 'low-utterance-conf',
      });
    });

    it('ACCEPTs "what club" — two content words, moderate confidence, short path', () => {
      const input: GateInput = {
        transcript: 'what club',
        confidence: 0.5,
        words: words([
          ['what', 0.5],
          ['club', 0.5],
        ]),
      };
      expect(gateTranscript(input)).toEqual({ verdict: 'ACCEPT' });
    });
  });

  it("REJECTs an empty transcript with reason 'empty'", () => {
    expect(gateTranscript({ transcript: '', confidence: null, words: [] })).toEqual({
      verdict: 'REJECT',
      reason: 'empty',
    });
  });

  it('REJECTs a whitespace-only transcript with reason \'empty\'', () => {
    expect(gateTranscript({ transcript: '   ', confidence: null, words: [] })).toEqual({
      verdict: 'REJECT',
      reason: 'empty',
    });
  });

  it('fails OPEN (ACCEPT) when both confidence and words are missing', () => {
    const input: GateInput = { transcript: 'some transcript', confidence: null, words: [] };
    expect(gateTranscript(input)).toEqual({ verdict: 'ACCEPT' });
  });

  it('never throws on malformed words entries and still returns a verdict', () => {
    const malformedWords = [
      { word: 'driver', confidence: 0.9 },
      null,
      { word: 'club' }, // missing confidence
      { confidence: 0.9 }, // missing word
      { word: 42, confidence: 0.9 }, // wrong type for word
      { word: 'wedge', confidence: 'high' }, // wrong type for confidence
      { word: 'iron', confidence: NaN },
    ] as unknown as DeepgramWord[];
    const input: GateInput = {
      transcript: 'driver club wedge iron',
      confidence: 0.9,
      words: malformedWords,
    };
    expect(() => gateTranscript(input)).not.toThrow();
    // No usable low-conf signal survives the malformed entries, so this
    // degrades to ACCEPT rather than crashing.
    expect(gateTranscript(input)).toEqual({ verdict: 'ACCEPT' });
  });

  it('never throws when words itself is not an array', () => {
    const input = {
      transcript: 'driver',
      confidence: 0.9,
      words: undefined,
    } as unknown as GateInput;
    expect(() => gateTranscript(input)).not.toThrow();
  });

  it('sanity: FILLER_WORDS is a tight, sensible set (does not swallow real content)', () => {
    expect(FILLER_WORDS.has('driver')).toBe(false);
    expect(FILLER_WORDS.has('bunker')).toBe(false);
    expect(FILLER_WORDS.has('uh')).toBe(true);
    expect(FILLER_WORDS.has('the')).toBe(true);
  });
});

// ── extractGateInput ─────────────────────────────────────────────────────────

describe('extractGateInput', () => {
  it('parses a realistic full Results JSON, tolerating extra word fields', () => {
    const raw = makeResultsMsg({
      transcript: 'how far to the pin',
      confidence: 0.91,
      is_final: true,
      words: [
        { word: 'how', confidence: 0.95, punctuated_word: 'How', start: 0.1, end: 0.3 },
        { word: 'far', confidence: 0.94, punctuated_word: 'far', start: 0.3, end: 0.5 },
        { word: 'to', confidence: 0.9, punctuated_word: 'to', start: 0.5, end: 0.6 },
        { word: 'the', confidence: 0.9, punctuated_word: 'the', start: 0.6, end: 0.7 },
        { word: 'pin', confidence: 0.93, punctuated_word: 'pin.', start: 0.7, end: 0.9 },
      ],
    });
    const result = extractGateInput(raw);
    expect(result).toEqual({
      transcript: 'how far to the pin',
      confidence: 0.91,
      isFinal: true,
      words: [
        { word: 'how', confidence: 0.95 },
        { word: 'far', confidence: 0.94 },
        { word: 'to', confidence: 0.9 },
        { word: 'the', confidence: 0.9 },
        { word: 'pin', confidence: 0.93 },
      ],
    });
  });

  it('returns confidence null when Deepgram omits it', () => {
    const raw = makeResultsMsg({ transcript: 'driver', words: [{ word: 'driver', confidence: 0.8 }] });
    const result = extractGateInput(raw);
    expect(result?.confidence).toBeNull();
  });

  it('returns null for a metadata frame (no channel)', () => {
    const metaMsg = JSON.stringify({ type: 'Metadata', transaction_key: 'abc' });
    expect(extractGateInput(metaMsg)).toBeNull();
  });

  it('returns null for an UtteranceEnd frame', () => {
    const utteranceEndMsg = JSON.stringify({ type: 'UtteranceEnd' });
    expect(extractGateInput(utteranceEndMsg)).toBeNull();
  });

  it('returns null for malformed JSON without throwing', () => {
    expect(() => extractGateInput('not valid json {')).not.toThrow();
    expect(extractGateInput('not valid json {')).toBeNull();
  });

  it('skips malformed word entries in a raw message rather than throwing', () => {
    const raw = JSON.stringify({
      channel: {
        alternatives: [
          {
            transcript: 'driver club',
            confidence: 0.9,
            words: [
              { word: 'driver', confidence: 0.9 },
              null,
              { word: 'club' }, // missing confidence
              { confidence: 0.9 }, // missing word
              'not-an-object',
            ],
          },
        ],
      },
      is_final: true,
    });
    expect(() => extractGateInput(raw)).not.toThrow();
    const result = extractGateInput(raw);
    expect(result?.words).toEqual([{ word: 'driver', confidence: 0.9 }]);
  });

  it('composes end-to-end with gateTranscript on a raw ACCEPT message', () => {
    const raw = makeResultsMsg({
      transcript: 'how far to carry the bunker',
      confidence: 0.97,
      words: [
        { word: 'how', confidence: 0.95 },
        { word: 'far', confidence: 0.96 },
        { word: 'to', confidence: 0.9 },
        { word: 'carry', confidence: 0.94 },
        { word: 'the', confidence: 0.9 },
        { word: 'bunker', confidence: 0.93 },
      ],
    });
    const extracted = extractGateInput(raw);
    expect(extracted).not.toBeNull();
    expect(extracted?.isFinal).toBe(true);
    expect(gateTranscript(extracted!)).toEqual({ verdict: 'ACCEPT' });
  });

  it('composes end-to-end with gateTranscript on a raw REJECT message', () => {
    const raw = makeResultsMsg({
      transcript: 'Scars',
      confidence: 0.3,
      words: [{ word: 'Scars', confidence: 0.3 }],
    });
    const extracted = extractGateInput(raw);
    expect(extracted).not.toBeNull();
    expect(gateTranscript(extracted!)).toEqual({
      verdict: 'REJECT',
      reason: 'low-utterance-conf',
    });
  });
});

// ── Micro-benchmark (evidence, not a strict perf assertion) ─────────────────

describe('gateTranscript micro-benchmark', () => {
  it('runs 10k gate checks on a 30-word utterance well under a second', () => {
    const thirtyWords: Array<[string, number]> = Array.from({ length: 30 }, (_, i) => [
      `word${i}`,
      0.9,
    ]);
    const input: GateInput = {
      transcript: thirtyWords.map(([w]) => w).join(' '),
      confidence: 0.9,
      words: words(thirtyWords),
    };

    const iterations = 10_000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      gateTranscript(input);
    }
    const elapsedMs = performance.now() - start;

    console.log(
      `[confidence-gate micro-benchmark] ${iterations} calls on a 30-word utterance: ${elapsedMs.toFixed(2)}ms`,
    );

    // Generous ceiling so this can't flake on a loaded CI box; the module is
    // O(words) pure logic with no I/O, so real numbers are far below this.
    expect(elapsedMs).toBeLessThan(500);
  });
});
