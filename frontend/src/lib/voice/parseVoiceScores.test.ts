/**
 * Unit tests for parseVoiceScoresLocally — the offline, deterministic score parser
 * in lib/voice/parseVoiceScores.ts.
 *
 * These complement the integration harness at voice-tests/runner.ts (which tests
 * full-utterance → parse-result round-trips). We target the unit level: individual
 * STT-normalization tokens, phrasing patterns, nickname resolution, the collision
 * guard, everyone-par, and conjunction splitting.
 *
 * DO NOT modify lib/voice/* to make tests pass.
 * If a test reveals a real bug, stop and report rather than fixing.
 */

import { describe, it, expect } from 'vitest';
import { parseVoiceScoresLocally } from './parseVoiceScores';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type Opts = Parameters<typeof parseVoiceScoresLocally>[1];

function parse(transcript: string, players: string[], hole = 1, par = 4) {
  const opts: Opts = { playerNames: players, hole, par };
  return parseVoiceScoresLocally(transcript, opts);
}

// ---------------------------------------------------------------------------
// 1. STT number-word normalization
// ---------------------------------------------------------------------------

describe('STT number-word normalization (through parseVoiceScoresLocally)', () => {
  // "ford" → 4: classic iOS STT mishearing of "four"
  it('ford → 4 via "made a ford"', () => {
    const r = parse('Bob made a ford', ['Bob'], 4, 4);
    expect(r.scores['Bob']).toBe(4);
  });

  // "fore" → 4: another common STT variant
  it('fore → 4 via "with a fore"', () => {
    const r = parse('Justin with a fore', ['Justin'], 1, 5);
    expect(r.scores['Justin']).toBe(4);
  });

  // "four" → 4: standard word
  it('four → 4 via "shot a four"', () => {
    const r = parse('Sam shot a four', ['Sam'], 2, 4);
    expect(r.scores['Sam']).toBe(4);
  });

  // "ate" → 8: iOS STT mishearing of "eight"
  it('ate → 8 via "made a ate"', () => {
    const r = parse('Sam made a ate', ['Sam'], 5, 4);
    expect(r.scores['Sam']).toBe(8);
  });

  // "eight" → 8: standard word
  it('eight → 8 via "got a eight"', () => {
    const r = parse('Justin got a eight', ['Justin'], 3, 5);
    expect(r.scores['Justin']).toBe(8);
  });

  // "won" → 1: STT mishearing of "one"
  it('won → 1 via "got a won"', () => {
    const r = parse('Mike got a won', ['Mike'], 3, 3);
    expect(r.scores['Mike']).toBe(1);
  });

  // "too" → 2: STT mishearing of "two"
  it('too → 2 via "got a too"', () => {
    const r = parse('Bob got a too', ['Bob'], 6, 4);
    expect(r.scores['Bob']).toBe(2);
  });

  // "to" → 2: preposition / STT "two"
  it('to → 2 via "with a to"', () => {
    const r = parse('Justin with a to', ['Justin'], 1, 4);
    expect(r.scores['Justin']).toBe(2);
  });

  // "tree" → 3: STT mishearing of "three"
  it('tree → 3 via bare "player tree" clause', () => {
    const r = parse('Mike tree', ['Mike'], 7, 3);
    expect(r.scores['Mike']).toBe(3);
  });

  // bare digit
  it('bare digit string is parsed', () => {
    const r = parse('Justin 5', ['Justin'], 1, 4);
    expect(r.scores['Justin']).toBe(5);
  });

  // digit via "made a"
  it('bare digit via "made a N"', () => {
    const r = parse('Mike made a 6', ['Mike'], 4, 4);
    expect(r.scores['Mike']).toBe(6);
  });

  // hole number is passed through unchanged
  it('result.hole equals the opts.hole argument', () => {
    const r = parse('Justin par', ['Justin'], 7, 4);
    expect(r.hole).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 2. Phrasing patterns: "made a / got a / with a / shot a / shot"
// ---------------------------------------------------------------------------

describe('"made a / got a / with a / shot a / shot" phrasing', () => {
  it('"made a <digit>"', () => {
    const r = parse('Justin made a 4', ['Justin'], 1, 4);
    expect(r.scores['Justin']).toBe(4);
  });

  it('"got a <digit>"', () => {
    const r = parse('Bob got a 5', ['Bob'], 2, 4);
    expect(r.scores['Bob']).toBe(5);
  });

  it('"with a <word-num>"', () => {
    const r = parse('Sam with a five', ['Sam'], 3, 5);
    expect(r.scores['Sam']).toBe(5);
  });

  it('"shot a <golf-term>"', () => {
    const r = parse('Bob shot a birdie', ['Bob'], 4, 4);
    expect(r.scores['Bob']).toBe(3); // par 4 − 1
  });

  it('"shot <digit>"', () => {
    const r = parse('Justin shot 6', ['Justin'], 1, 5);
    expect(r.scores['Justin']).toBe(6);
  });

  // STT word in phrasing context
  it('"made a ford" (ford → 4)', () => {
    const r = parse('Justin made a ford', ['Justin'], 1, 4);
    expect(r.scores['Justin']).toBe(4);
  });

  it('"got a ate" (ate → 8)', () => {
    const r = parse('Bob got a ate', ['Bob'], 1, 4);
    expect(r.scores['Bob']).toBe(8);
  });

  it('"made a won" (won → 1)', () => {
    const r = parse('Sam made a won', ['Sam'], 1, 3);
    expect(r.scores['Sam']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Golf-term scoring (birdie / eagle / bogey / double bogey / par)
// ---------------------------------------------------------------------------

describe('golf-term scoring', () => {
  it('birdie = par − 1', () => {
    const r = parse('Justin birdie', ['Justin'], 1, 5);
    expect(r.scores['Justin']).toBe(4);
  });

  it('eagle = par − 2', () => {
    const r = parse('Justin eagle', ['Justin'], 1, 5);
    expect(r.scores['Justin']).toBe(3);
  });

  it('eagle on par 3 = hole-in-one (1)', () => {
    const r = parse('Bob eagle', ['Bob'], 5, 3);
    expect(r.scores['Bob']).toBe(1);
  });

  it('bogey = par + 1', () => {
    const r = parse('Justin bogey', ['Justin'], 1, 4);
    expect(r.scores['Justin']).toBe(5);
  });

  it('double bogey = par + 2', () => {
    const r = parse('Justin double bogey', ['Justin'], 1, 4);
    expect(r.scores['Justin']).toBe(6);
  });

  it('"double" alone (without "bogey") = par + 2', () => {
    const r = parse('Bob double', ['Bob'], 2, 4);
    expect(r.scores['Bob']).toBe(6);
  });

  it('par = par value', () => {
    const r = parse('Justin par', ['Justin'], 1, 3);
    expect(r.scores['Justin']).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 4. Everyone-par patterns
// ---------------------------------------------------------------------------

describe('everyone-par patterns', () => {
  const group = ['Justin', 'Bob', 'Mike', 'Sam'];

  it('"everyone par" → all get par', () => {
    const r = parse('everyone par', group, 1, 4);
    expect(r.scores).toEqual({ Justin: 4, Bob: 4, Mike: 4, Sam: 4 });
  });

  it('"everybody birdie" → all get par − 1', () => {
    const r = parse('everybody birdie', group, 2, 5);
    expect(r.scores).toEqual({ Justin: 4, Bob: 4, Mike: 4, Sam: 4 });
  });

  it('"all of us bogey" → all get par + 1', () => {
    const r = parse('all of us bogey', group, 3, 4);
    expect(r.scores).toEqual({ Justin: 5, Bob: 5, Mike: 5, Sam: 5 });
  });

  it('"everyone eagle" → all get par − 2', () => {
    const r = parse('everyone eagle', group, 4, 5);
    expect(r.scores).toEqual({ Justin: 3, Bob: 3, Mike: 3, Sam: 3 });
  });

  it('"everyone double bogey" → all get par + 2', () => {
    const r = parse('everyone double bogey', group, 5, 4);
    expect(r.scores).toEqual({ Justin: 6, Bob: 6, Mike: 6, Sam: 6 });
  });

  it('"everybody double" (no "bogey") → all get par + 2', () => {
    const r = parse('everybody double', group, 6, 4);
    expect(r.scores).toEqual({ Justin: 6, Bob: 6, Mike: 6, Sam: 6 });
  });

  it('everyone-par result reflects the actual par value (par 3)', () => {
    const r = parse('everyone par', ['A', 'B'], 1, 3);
    expect(r.scores).toEqual({ A: 3, B: 3 });
  });

  it('"all bogey" two-word variant → all get par + 1', () => {
    const r = parse('all bogey', group, 1, 4);
    expect(r.scores).toEqual({ Justin: 5, Bob: 5, Mike: 5, Sam: 5 });
  });
});

// ---------------------------------------------------------------------------
// 5. Conjunction splitting ("and", ",", "then")
// ---------------------------------------------------------------------------

describe('conjunction splitting', () => {
  it('"and" separates two player scores', () => {
    const r = parse('Justin 4 and Bob 5', ['Justin', 'Bob'], 1, 4);
    expect(r.scores['Justin']).toBe(4);
    expect(r.scores['Bob']).toBe(5);
  });

  it('comma separates two player scores', () => {
    const r = parse('Justin birdie, Bob par', ['Justin', 'Bob'], 2, 4);
    expect(r.scores['Justin']).toBe(3);
    expect(r.scores['Bob']).toBe(4);
  });

  it('"then" separates two player scores', () => {
    const r = parse('Mike 5 then Bob 4', ['Mike', 'Bob'], 3, 4);
    expect(r.scores['Mike']).toBe(5);
    expect(r.scores['Bob']).toBe(4);
  });

  it('three players across multiple conjunctions', () => {
    const r = parse('Justin par and Bob bogey and Mike birdie', ['Justin', 'Bob', 'Mike'], 4, 4);
    expect(r.scores['Justin']).toBe(4);
    expect(r.scores['Bob']).toBe(5);
    expect(r.scores['Mike']).toBe(3);
  });

  it('no-comma multi-player string works via first-pass regex', () => {
    const r = parse('Justin 4 Bob 5 Mike 4', ['Justin', 'Bob', 'Mike'], 1, 4);
    expect(r.scores['Justin']).toBe(4);
    expect(r.scores['Bob']).toBe(5);
    expect(r.scores['Mike']).toBe(4);
  });

  it('all four players with "and" chains', () => {
    const r = parse('Justin 4 and Bob 4 and Mike 4 and Sam 4', ['Justin', 'Bob', 'Mike', 'Sam'], 8, 4);
    expect(r.scores).toEqual({ Justin: 4, Bob: 4, Mike: 4, Sam: 4 });
  });
});

// ---------------------------------------------------------------------------
// 6. Nickname resolution via NICK_TO_CANONICAL
// ---------------------------------------------------------------------------

describe('nickname resolution', () => {
  it('"jt" resolves to Justin when no literal JT player exists', () => {
    const r = parse('jt with a 4', ['Justin', 'Bob'], 1, 4);
    expect(r.scores['Justin']).toBe(4);
    expect(r.scores['Bob']).toBeUndefined();
  });

  it('"mike" resolves to Michael when no literal Mike player exists', () => {
    const r = parse('mike 5', ['Michael', 'Bob'], 2, 4);
    expect(r.scores['Michael']).toBe(5);
  });

  it('"bob" resolves to Robert when no literal Bob player exists', () => {
    const r = parse('bob birdie', ['Robert', 'Justin'], 1, 4);
    expect(r.scores['Robert']).toBe(3);
  });

  it('"bobby" resolves to Robert when no literal Bobby player exists', () => {
    const r = parse('bobby 5', ['Robert', 'Justin'], 1, 4);
    expect(r.scores['Robert']).toBe(5);
  });

  it('"jt" nick used in phrasing with golf term', () => {
    const r = parse('jt birdie', ['Justin', 'Sam'], 1, 4);
    expect(r.scores['Justin']).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 7. Collision guard (PR #47): literal player name blocks nickname expansion
// ---------------------------------------------------------------------------

describe('collision guard — literal player wins over nickname expansion', () => {
  // PR #47 fixed a bug where a real "JT" player would be conflated with Justin
  // via the "jt" → ["justin"] nickname map.

  it('when JT is a literal player, "jt" matches JT not Justin', () => {
    const r = parse('jt with a 4', ['JT', 'Justin'], 1, 4);
    expect(r.scores['JT']).toBe(4);
    // Justin must NOT receive a score from the "jt" phrase
    expect(r.scores['Justin']).toBeUndefined();
  });

  it('Justin still resolves by literal name even when JT is in the round', () => {
    const r = parse('justin 3 and jt 4', ['JT', 'Justin'], 2, 4);
    expect(r.scores['Justin']).toBe(3);
    expect(r.scores['JT']).toBe(4);
  });

  it('when Bob is a literal player, "bob" matches Bob not Robert', () => {
    // "bob" is in NICK_TO_CANONICAL → ["robert"], but literal "Bob" wins.
    // Collision guard suppresses the nickname expansion for Robert.
    const r = parse('bob 5', ['Bob', 'Robert'], 3, 4);
    expect(r.scores['Bob']).toBe(5);
    expect(r.scores['Robert']).toBeUndefined();
  });

  it('JT and Justin both scored separately in one utterance', () => {
    const r = parse('jt par and justin birdie', ['JT', 'Justin'], 5, 4);
    expect(r.scores['JT']).toBe(4);
    expect(r.scores['Justin']).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 8. Edge cases and robustness
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('unknown transcript with no player names → empty scores', () => {
    const r = parse('gibberish here', ['Justin', 'Bob'], 1, 4);
    expect(r.scores).toEqual({});
  });

  it('filler-like words before a player name do not break parsing', () => {
    // The internal normalize() strips punctuation but not filler; the regex is
    // word-boundary anchored so "uh" before "Justin" is harmless.
    const r = parse('uh Justin birdie Bob par', ['Justin', 'Bob'], 1, 4);
    expect(r.scores['Justin']).toBe(3);
    expect(r.scores['Bob']).toBe(4);
  });

  it('case-insensitive: uppercase transcript still resolves players', () => {
    const r = parse('JUSTIN PAR', ['Justin'], 1, 4);
    expect(r.scores['Justin']).toBe(4);
  });

  it('returns scores keyed by original player-name casing', () => {
    // playerNames = ['Justin'] (capitalized) → result key must be 'Justin', not 'justin'
    const r = parse('justin 5', ['Justin'], 1, 4);
    expect(Object.keys(r.scores)).toContain('Justin');
  });

  it('single player with only a golf term returns that score', () => {
    const r = parse('Bob bogey', ['Bob'], 1, 4);
    expect(r.scores['Bob']).toBe(5);
  });

  it('partial match on first 3 chars of player name (findPlayerMatch prefix rule)', () => {
    // findPlayerMatch falls back to: pn.length >= 3 && chunk.includes(pn.slice(0,3))
    // e.g. "jus" → "Justin"
    const r = parse('justin 4', ['Justin'], 1, 4);
    expect(r.scores['Justin']).toBe(4);
  });
});
