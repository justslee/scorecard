import { describe, it, expect } from 'vitest';
import { getSharedRounds } from './partner-rounds';
import type { Round } from './types';

// ---------------------------------------------------------------------------
// Minimal fixture helper — only the fields getSharedRounds reads.
// ---------------------------------------------------------------------------

function makeRound(
  id: string,
  date: string,
  playerIds: string[]
): Round {
  return {
    id,
    courseId: 'course-1',
    courseName: 'Test Course',
    date,
    players: playerIds.map((pid) => ({ id: pid, name: `Player ${pid}` })),
    scores: [],
    holes: [],
    status: 'completed',
    createdAt: date,
    updatedAt: date,
  } as Round;
}

const PLAYER_A = 'player-a';
const PLAYER_B = 'player-b';
const CUSTOM_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('getSharedRounds', () => {
  it('returns rounds where the player participated', () => {
    const rounds = [
      makeRound('r1', '2024-06-01', [PLAYER_A, PLAYER_B]),
      makeRound('r2', '2024-06-02', [PLAYER_B]),
    ];
    const result = getSharedRounds(rounds, PLAYER_A);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('r1');
  });

  it('excludes rounds where the player is not present', () => {
    const rounds = [
      makeRound('r1', '2024-06-01', [PLAYER_B]),
      makeRound('r2', '2024-06-02', [CUSTOM_UUID]),
    ];
    expect(getSharedRounds(rounds, PLAYER_A)).toHaveLength(0);
  });

  it('excludes rounds with only custom (UUID) player ids', () => {
    const rounds = [makeRound('r1', '2024-06-01', [CUSTOM_UUID])];
    expect(getSharedRounds(rounds, PLAYER_A)).toHaveLength(0);
  });

  it('sorts results date-descending (most recent first)', () => {
    const rounds = [
      makeRound('r1', '2024-01-10', [PLAYER_A]),
      makeRound('r2', '2024-06-01', [PLAYER_A]),
      makeRound('r3', '2024-03-15', [PLAYER_A]),
    ];
    const result = getSharedRounds(rounds, PLAYER_A);
    expect(result.map((r) => r.id)).toEqual(['r2', 'r3', 'r1']);
  });

  it('returns [] for an unknown playerId', () => {
    const rounds = [makeRound('r1', '2024-06-01', [PLAYER_A])];
    expect(getSharedRounds(rounds, 'nobody')).toEqual([]);
  });

  it('returns [] for empty rounds array', () => {
    expect(getSharedRounds([], PLAYER_A)).toEqual([]);
  });

  it('returns [] for empty playerId string', () => {
    const rounds = [makeRound('r1', '2024-06-01', [PLAYER_A])];
    expect(getSharedRounds(rounds, '')).toEqual([]);
  });

  it('does not mutate the original rounds array order', () => {
    const rounds = [
      makeRound('r1', '2024-01-10', [PLAYER_A]),
      makeRound('r2', '2024-06-01', [PLAYER_A]),
    ];
    const originalOrder = rounds.map((r) => r.id);
    getSharedRounds(rounds, PLAYER_A);
    expect(rounds.map((r) => r.id)).toEqual(originalOrder);
  });

  it('does not throw when a round has an invalid date string, and sorts it last', () => {
    const rounds = [
      makeRound('r1', '2024-06-01', [PLAYER_A]),
      makeRound('r2', 'not-a-date', [PLAYER_A]),
      makeRound('r3', '2024-03-15', [PLAYER_A]),
    ];
    let result: Round[] = [];
    expect(() => { result = getSharedRounds(rounds, PLAYER_A); }).not.toThrow();
    // Invalid date treated as epoch-0 (oldest) — sorts to the end.
    expect(result.map((r) => r.id)).toEqual(['r1', 'r3', 'r2']);
  });

  it('does not throw when a round has an empty date string, and sorts it last', () => {
    const rounds = [
      makeRound('r1', '2024-06-01', [PLAYER_A]),
      makeRound('r2', '', [PLAYER_A]),
    ];
    let result: Round[] = [];
    expect(() => { result = getSharedRounds(rounds, PLAYER_A); }).not.toThrow();
    // Empty string → Invalid Date → treated as epoch-0, sorts last.
    expect(result.map((r) => r.id)).toEqual(['r1', 'r2']);
  });
});
