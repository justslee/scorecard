/**
 * record_scores routing — specs/caddie-two-tier-routing-plan.md §9.
 *
 * `resolveScoreEntry` is the pure glue between the live session and the
 * EXISTING parser + EXISTING write path: these tests exercise it directly
 * with a fake `parseScores` (standing in for /api/voice/parse-scores) and a
 * spy `onSetScore` (standing in for RoundPageClient.handleSetScore) — no
 * network, no DOM.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveScoreEntry, type ParseScoresResponse, type ScoreEntryPlayer } from './score-entry';

const PLAYERS: ScoreEntryPlayer[] = [
  { id: 'p1', name: 'Justin' },
  { id: 'p2', name: 'Mike' },
];

function fakeParse(response: ParseScoresResponse) {
  return vi.fn(async (_body: { transcript: string; playerNames: string[]; hole: number; par: number }) => response);
}

describe('resolveScoreEntry', () => {
  it('parses, writes through onSetScore, and returns the recorded map — single player, explicit command', async () => {
    const parse = fakeParse({ hole: 5, scores: { Justin: 5 }, confidence: 0.92 });
    const onSetScore = vi.fn();

    const result = await resolveScoreEntry('I made a 5', 5, 4, PLAYERS, onSetScore, parse);

    expect(parse).toHaveBeenCalledWith({
      transcript: 'I made a 5',
      playerNames: ['Justin', 'Mike'],
      hole: 5,
      par: 4,
    });
    // The write happens on THIS call — no confirm round-trip, no second call
    // required before onSetScore fires.
    expect(onSetScore).toHaveBeenCalledTimes(1);
    expect(onSetScore).toHaveBeenCalledWith('p1', 4, 5); // hole - 1 = idx 4
    expect(result).toEqual({ hole: 5, recorded: { Justin: 5 }, unmatched: [], confidence: 0.92 });
  });

  it('multi-player utterance writes every matched player, no read-back-and-await', async () => {
    const parse = fakeParse({ hole: 3, scores: { Justin: 5, Mike: 4 }, confidence: 0.88 });
    const onSetScore = vi.fn();

    const result = await resolveScoreEntry('put me down for a 5, par for Mike', 3, 4, PLAYERS, onSetScore, parse);

    expect(onSetScore).toHaveBeenCalledTimes(2);
    expect(onSetScore).toHaveBeenCalledWith('p1', 2, 5);
    expect(onSetScore).toHaveBeenCalledWith('p2', 2, 4);
    expect(result.recorded).toEqual({ Justin: 5, Mike: 4 });
    expect(result.unmatched).toEqual([]);
  });

  it('below-confidence parse writes nothing and returns an honest error', async () => {
    const parse = fakeParse({ hole: 5, scores: { Justin: 5 }, confidence: 0.3 });
    const onSetScore = vi.fn();

    const result = await resolveScoreEntry('mumble mumble', 5, 4, PLAYERS, onSetScore, parse);

    expect(onSetScore).not.toHaveBeenCalled();
    expect(result).toEqual({ error: "couldn't make out the scores", heard: 'mumble mumble' });
  });

  it('empty scores map writes nothing and returns an honest error, even at high confidence', async () => {
    const parse = fakeParse({ hole: 5, scores: {}, confidence: 0.95 });
    const onSetScore = vi.fn();

    const result = await resolveScoreEntry('say that again', 5, 4, PLAYERS, onSetScore, parse);

    expect(onSetScore).not.toHaveBeenCalled();
    expect(result.error).toBe("couldn't make out the scores");
  });

  it('a parser exception (network failure) writes nothing and returns an honest error', async () => {
    const parse = vi.fn(async () => {
      throw new Error('network down');
    });
    const onSetScore = vi.fn();

    const result = await resolveScoreEntry('I made a 5', 5, 4, PLAYERS, onSetScore, parse);

    expect(onSetScore).not.toHaveBeenCalled();
    expect(result.error).toBe("couldn't make out the scores");
  });

  it('out-of-range values (parser noise) are treated as unmatched, never written', async () => {
    const parse = fakeParse({ hole: 5, scores: { Justin: 0, Mike: 42 }, confidence: 0.9 });
    const onSetScore = vi.fn();

    const result = await resolveScoreEntry('scores', 5, 4, PLAYERS, onSetScore, parse);

    expect(onSetScore).not.toHaveBeenCalled();
    expect(result.recorded).toEqual({});
    expect(result.unmatched?.sort()).toEqual(['Justin', 'Mike']);
  });

  it('a name the parser returns that matches no known player is surfaced as unmatched', async () => {
    const parse = fakeParse({ hole: 5, scores: { Justin: 5, Bob: 4 }, confidence: 0.9 });
    const onSetScore = vi.fn();

    const result = await resolveScoreEntry('scores', 5, 4, PLAYERS, onSetScore, parse);

    expect(onSetScore).toHaveBeenCalledTimes(1);
    expect(onSetScore).toHaveBeenCalledWith('p1', 4, 5);
    expect(result.recorded).toEqual({ Justin: 5 });
    expect(result.unmatched).toEqual(['Bob']);
  });

  it('hole_number override (from the tool call args) is used for both the parse request and the write index', async () => {
    const parse = fakeParse({ hole: 9, scores: { Justin: 3 }, confidence: 0.9 });
    const onSetScore = vi.fn();

    await resolveScoreEntry('birdie on 9', 9, 4, PLAYERS, onSetScore, parse);

    expect(parse).toHaveBeenCalledWith(expect.objectContaining({ hole: 9 }));
    expect(onSetScore).toHaveBeenCalledWith('p1', 8, 3);
  });
});
