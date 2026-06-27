/**
 * Unit tests for pure utility functions in lib/voice/utils.ts.
 *
 * Covers: parseSpokenNumber (STT word-to-int map), normalizeName,
 * levenshtein, similarity, fuzzyBestMatch, safeJsonExtract,
 * normalizeTranscript, stripFillerWords, clamp01.
 *
 * DO NOT modify lib/voice/utils.ts to make tests pass.
 */

import { describe, it, expect } from 'vitest';
import {
  safeJsonExtract,
  clamp01,
  normalizeName,
  levenshtein,
  similarity,
  fuzzyBestMatch,
  parseSpokenNumber,
  stripFillerWords,
  normalizeTranscript,
} from './utils';

// ---------------------------------------------------------------------------
// parseSpokenNumber — word/digit → integer
// ---------------------------------------------------------------------------

describe('parseSpokenNumber', () => {
  // Standard word numbers
  it.each([
    ['zero', 0],
    ['one', 1],
    ['two', 2],
    ['three', 3],
    ['four', 4],
    ['five', 5],
    ['six', 6],
    ['seven', 7],
    ['eight', 8],
    ['nine', 9],
    ['ten', 10],
    ['twenty', 20],
  ] as const)('"%s" → %i', (word, expected) => {
    expect(parseSpokenNumber(word)).toBe(expected);
  });

  // STT mishearings also present in WORD_NUMBERS
  it.each([
    ['won', 1],   // "one" → "won"
    ['to', 2],    // "two" → "to"
    ['too', 2],   // "two" → "too"
    ['for', 4],   // "four" → "for"  (NOTE: NOT in parseVoiceScores WORD_TO_NUM regex)
    ['fore', 4],  // "four" → "fore"
    ['tree', 3],  // "three" → "tree"
    ['ate', 8],   // "eight" → "ate"
  ] as const)('STT "%s" → %i', (word, expected) => {
    expect(parseSpokenNumber(word)).toBe(expected);
  });

  // Digit strings
  it('parses single-digit string "5"', () => {
    expect(parseSpokenNumber('5')).toBe(5);
  });

  it('parses multi-digit string "12"', () => {
    expect(parseSpokenNumber('12')).toBe(12);
  });

  // Unknown / non-numeric words → null
  it('returns null for "par"', () => {
    expect(parseSpokenNumber('par')).toBeNull();
  });

  it('returns null for "birdie"', () => {
    expect(parseSpokenNumber('birdie')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseSpokenNumber('')).toBeNull();
  });

  it('returns null for unknown word "xyz"', () => {
    expect(parseSpokenNumber('xyz')).toBeNull();
  });

  // NOTE: "ford" is in parseVoiceScores.ts's WORD_TO_NUM (local to that module)
  // but NOT in utils.ts's WORD_NUMBERS. So parseSpokenNumber returns null for "ford".
  it('returns null for "ford" (only in parseVoiceScores WORD_TO_NUM, not utils WORD_NUMBERS)', () => {
    expect(parseSpokenNumber('ford')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeName
// ---------------------------------------------------------------------------

describe('normalizeName', () => {
  it('lowercases input', () => {
    expect(normalizeName('JUSTIN')).toBe('justin');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeName('  Justin  ')).toBe('justin');
  });

  it('replaces non-alphanumeric characters with spaces', () => {
    expect(normalizeName("O'Brien")).toBe('o brien');
  });

  it('collapses multiple spaces into one', () => {
    expect(normalizeName('Justin  Lee')).toBe('justin lee');
  });

  it('preserves digit characters', () => {
    expect(normalizeName('Player1')).toBe('player1');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeName('')).toBe('');
  });

  it('handles mixed punctuation (period replaced then spaces collapsed)', () => {
    // '.' → ' ', then \s+ collapse → single space
    expect(normalizeName('St. Andrews')).toBe('st andrews');
  });
});

// ---------------------------------------------------------------------------
// clamp01
// ---------------------------------------------------------------------------

describe('clamp01', () => {
  it('clamps negative values to 0', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(-100)).toBe(0);
  });

  it('clamps values > 1 to 1', () => {
    expect(clamp01(2)).toBe(1);
    expect(clamp01(100)).toBe(1);
  });

  it('passes through values in [0, 1]', () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(1)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// levenshtein
// ---------------------------------------------------------------------------

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('justin', 'justin')).toBe(0);
  });

  it('returns 0 for two empty strings', () => {
    expect(levenshtein('', '')).toBe(0);
  });

  it('returns the length of b when a is empty', () => {
    expect(levenshtein('', 'abc')).toBe(3);
  });

  it('returns the length of a when b is empty', () => {
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('returns 1 for one missing character (insertion)', () => {
    // "jusin" → "justin": insert 't' → distance 1
    expect(levenshtein('jusin', 'justin')).toBe(1);
  });

  it('returns 1 for one substitution', () => {
    // "jusbin" → "justin": sub b→t → distance 1
    expect(levenshtein('jusbin', 'justin')).toBe(1);
  });

  it('handles strings of very different lengths', () => {
    const d = levenshtein('a', 'abcde');
    expect(d).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// similarity
// ---------------------------------------------------------------------------

describe('similarity', () => {
  it('returns 1 for identical strings', () => {
    expect(similarity('Justin', 'Justin')).toBe(1);
  });

  it('returns 1 for strings that differ only in case', () => {
    // normalizeName is applied inside, so "Justin" and "justin" are equal
    expect(similarity('Justin', 'justin')).toBe(1);
  });

  it('returns 0.92 for a prefix match (one is prefix of the other)', () => {
    // similarity returns 0.92 when one string startsWith the other
    expect(similarity('Just', 'Justin')).toBe(0.92);
  });

  it('returns > 0.8 for a very close match', () => {
    expect(similarity('Justiin', 'Justin')).toBeGreaterThan(0.8);
  });

  it('returns low score for very different strings', () => {
    expect(similarity('Justin', 'Xyz')).toBeLessThan(0.5);
  });

  it('returns 0 when either input is empty', () => {
    expect(similarity('', 'Justin')).toBe(0);
    expect(similarity('Justin', '')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fuzzyBestMatch
// ---------------------------------------------------------------------------

describe('fuzzyBestMatch', () => {
  const known = ['Justin', 'Bob', 'Michael', 'Sam'];

  it('returns the exact match with score = 1', () => {
    const { match, score } = fuzzyBestMatch('Justin', known);
    expect(match).toBe('Justin');
    expect(score).toBe(1);
  });

  it('matches a close misspelling above the default threshold', () => {
    const { match } = fuzzyBestMatch('Justn', known);
    expect(match).toBe('Justin');
  });

  it('matches a prefix above threshold', () => {
    const { match } = fuzzyBestMatch('Just', known);
    expect(match).toBe('Justin');
  });

  it('returns null when best score is below default minScore (0.72)', () => {
    const { match } = fuzzyBestMatch('Xyzzy', known);
    expect(match).toBeNull();
  });

  it('returns null for empty candidates list', () => {
    const { match } = fuzzyBestMatch('Justin', []);
    expect(match).toBeNull();
  });

  it('respects a custom minScore — rejects when similarity is below threshold', () => {
    // 'Jussy' has ~0.5 similarity to 'Justin' (well above 0.0, below 0.9)
    const { match: matchLoose } = fuzzyBestMatch('Jussy', known, 0.5);
    expect(matchLoose).toBe('Justin');
    const { match: matchStrict } = fuzzyBestMatch('Jussy', known, 0.95);
    expect(matchStrict).toBeNull();
  });

  it('returns the closest of multiple candidates', () => {
    const { match } = fuzzyBestMatch('Bob', ['Bobby', 'Bob', 'Robert']);
    expect(match).toBe('Bob');
  });
});

// ---------------------------------------------------------------------------
// safeJsonExtract
// ---------------------------------------------------------------------------

describe('safeJsonExtract', () => {
  it('extracts a plain JSON object', () => {
    expect(safeJsonExtract('{"hole": 1}')).toBe('{"hole": 1}');
  });

  it('extracts JSON from surrounding prose text', () => {
    const input = 'Here is the result: {"hole": 1, "scores": {}} done.';
    expect(safeJsonExtract(input)).toBe('{"hole": 1, "scores": {}}');
  });

  it('prefers a fenced ```json block over bare JSON', () => {
    const input = 'Sure! ```json\n{"hole": 2}\n``` Done.';
    expect(safeJsonExtract(input)).toBe('{"hole": 2}');
  });

  it('also handles ``` (no "json" label) fenced block', () => {
    const input = 'Result: ```\n{"hole": 3}\n```';
    expect(safeJsonExtract(input)).toBe('{"hole": 3}');
  });

  it('extracts nested JSON objects', () => {
    const input = '{"scores": {"Justin": 4, "Bob": 5}}';
    expect(safeJsonExtract(input)).toBe(input);
  });

  it('returns null when no JSON is present', () => {
    expect(safeJsonExtract('no json here')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(safeJsonExtract('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// stripFillerWords
// ---------------------------------------------------------------------------

describe('stripFillerWords', () => {
  it('removes "uh" and "um"', () => {
    expect(stripFillerWords('uh Justin um par')).toBe('Justin par');
  });

  it('removes "like"', () => {
    expect(stripFillerWords('like Justin par')).toBe('Justin par');
  });

  it('removes "please", "hey", "okay", "ok"', () => {
    expect(stripFillerWords('okay hey please ok Justin')).toBe('Justin');
  });

  it('collapses extra whitespace left by removed words', () => {
    expect(stripFillerWords('Justin uh 4')).toBe('Justin 4');
  });

  it('does not alter text without filler words', () => {
    expect(stripFillerWords('Justin par')).toBe('Justin par');
  });
});

// ---------------------------------------------------------------------------
// normalizeTranscript
// ---------------------------------------------------------------------------

describe('normalizeTranscript', () => {
  it('removes filler words ("uh")', () => {
    expect(normalizeTranscript('uh start skins')).toBe('start skins');
  });

  it('replaces "basketball" with "best ball" (iOS ASR mishearing)', () => {
    expect(normalizeTranscript('set up basketball with Justin and Bob')).toBe(
      'set up best ball with Justin and Bob'
    );
  });

  it('replaces "bestball" with "best ball"', () => {
    expect(normalizeTranscript('new bestball game')).toBe('new best ball game');
  });

  it('trims and collapses whitespace', () => {
    expect(normalizeTranscript('  Justin  4  ')).toBe('Justin 4');
  });

  it('does not alter a clean transcript', () => {
    expect(normalizeTranscript('start skins with Justin')).toBe('start skins with Justin');
  });
});
