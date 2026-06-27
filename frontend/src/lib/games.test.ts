/**
 * Unit tests for the games engine (lib/games.ts).
 *
 * Covers every exported compute* function and the computeGameResults dispatcher.
 * Tests reflect the engine's ACTUAL current behavior, including documented stubs
 * (match-play Nassau falls back to stroke totals — see "STUB" comment below).
 *
 * DO NOT modify games.ts to make tests pass.
 */

import { describe, it, expect } from 'vitest';
import {
  computeSkins,
  computeBestBall,
  computeNassau,
  computeThreePoint,
  computeStableford,
  computeMatchPlay,
  computeWolf,
  computeGameResults,
} from './games';
import type { Round, Game, Score, HoleInfo, Player } from './types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeHoles(pars?: number[]): HoleInfo[] {
  const p = pars ?? Array<number>(18).fill(4);
  return p.map((par, i) => ({ number: i + 1, par }));
}

function makePlayers(ids: string[]): Player[] {
  return ids.map(id => ({ id, name: id }));
}

function makeRound(overrides: Partial<Round> = {}): Round {
  return {
    id: 'r1',
    courseId: 'c1',
    courseName: 'Test Course',
    date: '2026-01-01',
    players: makePlayers(['p1', 'p2']),
    scores: [],
    holes: makeHoles(),
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: 'g1',
    roundId: 'r1',
    format: 'skins',
    name: 'Test Game',
    playerIds: ['p1', 'p2'],
    settings: {},
    ...overrides,
  };
}

/** Build 18 identical scores for one player. */
function uniformScores(playerId: string, strokes: number): Score[] {
  return Array.from({ length: 18 }, (_, i) => ({
    playerId,
    holeNumber: i + 1,
    strokes,
  }));
}

// ---------------------------------------------------------------------------
// computeSkins
// ---------------------------------------------------------------------------

describe('computeSkins', () => {
  it('awards a skin to the outright low scorer on a hole', () => {
    const round = makeRound({
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 },
        { playerId: 'p2', holeNumber: 1, strokes: 4 },
      ],
    });
    const game = makeGame({ format: 'skins', playerIds: ['p1', 'p2'] });
    const result = computeSkins(round, game);

    expect(result.holeWinners[0]).toMatchObject({
      holeNumber: 1,
      winnerPlayerId: 'p1',
      value: 1,
      carried: false,
    });
    expect(result.byPlayer.find(p => p.playerId === 'p1')?.skins).toBe(1);
    expect(result.byPlayer.find(p => p.playerId === 'p2')?.skins).toBe(0);
  });

  it('ties carry over by default and next winner collects accumulated value', () => {
    const round = makeRound({
      scores: [
        // hole 1: tie → carry
        { playerId: 'p1', holeNumber: 1, strokes: 4 },
        { playerId: 'p2', holeNumber: 1, strokes: 4 },
        // hole 2: p1 wins, collects 2 skins (carry from hole 1 + hole 2)
        { playerId: 'p1', holeNumber: 2, strokes: 3 },
        { playerId: 'p2', holeNumber: 2, strokes: 5 },
      ],
    });
    const game = makeGame({ format: 'skins', playerIds: ['p1', 'p2'] });
    const result = computeSkins(round, game);

    expect(result.holeWinners[0]).toMatchObject({
      holeNumber: 1,
      winnerPlayerId: null,
      value: 1,
      carried: false,
    });
    expect(result.holeWinners[1]).toMatchObject({
      holeNumber: 2,
      winnerPlayerId: 'p1',
      value: 2,
      carried: true,
    });
    expect(result.byPlayer.find(p => p.playerId === 'p1')?.skins).toBe(2);
    expect(result.byPlayer.find(p => p.playerId === 'p2')?.skins).toBe(0);
  });

  it('does NOT carry over when carryover=false — tied hole stays at value 1', () => {
    const round = makeRound({
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 4 },
        { playerId: 'p2', holeNumber: 1, strokes: 4 },
        { playerId: 'p1', holeNumber: 2, strokes: 3 },
        { playerId: 'p2', holeNumber: 2, strokes: 5 },
      ],
    });
    const game = makeGame({
      format: 'skins',
      playerIds: ['p1', 'p2'],
      settings: { carryover: false },
    });
    const result = computeSkins(round, game);

    expect(result.holeWinners[1]).toMatchObject({
      holeNumber: 2,
      winnerPlayerId: 'p1',
      value: 1, // no carry
    });
    expect(result.byPlayer.find(p => p.playerId === 'p1')?.skins).toBe(1);
  });

  it('accumulates carry across multiple consecutive ties', () => {
    const scores: Score[] = [
      // holes 1–3 all tie, hole 4 p2 wins 4 skins
      { playerId: 'p1', holeNumber: 1, strokes: 4 },
      { playerId: 'p2', holeNumber: 1, strokes: 4 },
      { playerId: 'p1', holeNumber: 2, strokes: 4 },
      { playerId: 'p2', holeNumber: 2, strokes: 4 },
      { playerId: 'p1', holeNumber: 3, strokes: 4 },
      { playerId: 'p2', holeNumber: 3, strokes: 4 },
      { playerId: 'p1', holeNumber: 4, strokes: 5 },
      { playerId: 'p2', holeNumber: 4, strokes: 3 },
    ];
    const round = makeRound({ scores });
    const game = makeGame({ format: 'skins', playerIds: ['p1', 'p2'] });
    const result = computeSkins(round, game);

    expect(result.holeWinners[3]).toMatchObject({
      holeNumber: 4,
      winnerPlayerId: 'p2',
      value: 4,
      carried: true,
    });
    expect(result.byPlayer.find(p => p.playerId === 'p2')?.skins).toBe(4);
    expect(result.byPlayer.find(p => p.playerId === 'p1')?.skins).toBe(0);
  });

  it('records no winner when fewer than 2 players have a score on a hole', () => {
    const round = makeRound({
      scores: [{ playerId: 'p1', holeNumber: 3, strokes: 3 }],
    });
    const game = makeGame({ format: 'skins', playerIds: ['p1', 'p2'] });
    const result = computeSkins(round, game);

    expect(result.holeWinners[2]).toMatchObject({
      holeNumber: 3,
      winnerPlayerId: null,
    });
  });

  it('falls back to round.players when game.playerIds is empty', () => {
    const round = makeRound({
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 },
        { playerId: 'p2', holeNumber: 1, strokes: 4 },
      ],
    });
    const game = makeGame({ format: 'skins', playerIds: [] });
    const result = computeSkins(round, game);

    const ids = result.byPlayer.map(p => p.playerId);
    expect(ids).toContain('p1');
    expect(ids).toContain('p2');
    expect(result.holeWinners[0].winnerPlayerId).toBe('p1');
  });

  it('always returns an 18-element holeWinners array even with no scores', () => {
    const round = makeRound({ scores: [] });
    const game = makeGame({ format: 'skins' });
    const result = computeSkins(round, game);

    expect(result.holeWinners).toHaveLength(18);
    for (const hw of result.holeWinners) {
      expect(hw.winnerPlayerId).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// computeBestBall
// ---------------------------------------------------------------------------

describe('computeBestBall', () => {
  const FOUR_PLAYERS = ['p1', 'p2', 'p3', 'p4'];

  function fourPlayerGame(): Partial<Game> {
    return {
      format: 'bestBall',
      playerIds: FOUR_PLAYERS,
      teams: [
        { id: 'tA', name: 'Team A', playerIds: ['p1', 'p2'] },
        { id: 'tB', name: 'Team B', playerIds: ['p3', 'p4'] },
      ],
    };
  }

  it('picks the lowest score per hole per team', () => {
    const round = makeRound({
      players: makePlayers(FOUR_PLAYERS),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 4 },
        { playerId: 'p2', holeNumber: 1, strokes: 5 }, // team A best = 4
        { playerId: 'p3', holeNumber: 1, strokes: 3 },
        { playerId: 'p4', holeNumber: 1, strokes: 6 }, // team B best = 3
      ],
    });
    const game = makeGame(fourPlayerGame());
    const result = computeBestBall(round, game);

    expect(result.teamScoresByHole['tA'][0]).toBe(4);
    expect(result.teamScoresByHole['tB'][0]).toBe(3);
  });

  it('declares the team with the lower total the winner', () => {
    // Team A best ball per hole: 3, Team B: 4 — two holes
    const round = makeRound({
      players: makePlayers(FOUR_PLAYERS),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 },
        { playerId: 'p2', holeNumber: 1, strokes: 5 },
        { playerId: 'p3', holeNumber: 1, strokes: 4 },
        { playerId: 'p4', holeNumber: 1, strokes: 6 },
        { playerId: 'p1', holeNumber: 2, strokes: 3 },
        { playerId: 'p2', holeNumber: 2, strokes: 5 },
        { playerId: 'p3', holeNumber: 2, strokes: 4 },
        { playerId: 'p4', holeNumber: 2, strokes: 6 },
      ],
    });
    const game = makeGame(fourPlayerGame());
    const result = computeBestBall(round, game);

    expect(result.winnerTeamId).toBe('tA');
    expect(result.totals.find(t => t.teamId === 'tA')?.total).toBe(6);  // 3+3
    expect(result.totals.find(t => t.teamId === 'tB')?.total).toBe(8);  // 4+4
  });

  it('returns null winnerTeamId on a tie', () => {
    const round = makeRound({
      players: makePlayers(FOUR_PLAYERS),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 },
        { playerId: 'p3', holeNumber: 1, strokes: 3 }, // equal best balls
      ],
    });
    const game = makeGame(fourPlayerGame());
    const result = computeBestBall(round, game);

    expect(result.winnerTeamId).toBeNull();
  });

  it('stores null for unscored holes and ignores them from totals', () => {
    const round = makeRound({
      players: makePlayers(FOUR_PLAYERS),
      scores: [], // no scores
    });
    const game = makeGame(fourPlayerGame());
    const result = computeBestBall(round, game);

    expect(result.teamScoresByHole['tA']).toHaveLength(18);
    expect(result.teamScoresByHole['tA'][0]).toBeNull();
    expect(result.totals.find(t => t.teamId === 'tA')?.holesPlayed).toBe(0);
    expect(result.winnerTeamId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeNassau
// ---------------------------------------------------------------------------

describe('computeNassau', () => {
  it('determines front9/back9/overall winners in stroke/individual mode', () => {
    // p1: all 3s, p2: all 4s — p1 wins every segment
    const round = makeRound({
      scores: [...uniformScores('p1', 3), ...uniformScores('p2', 4)],
    });
    const game = makeGame({
      format: 'nassau',
      playerIds: ['p1', 'p2'],
      settings: { nassauMode: 'stroke', nassauScope: 'individual' },
    });
    const result = computeNassau(round, game);

    expect(result.mode).toBe('stroke');
    expect(result.scope).toBe('individual');
    expect(result.front9WinnerId).toBe('p1');
    expect(result.back9WinnerId).toBe('p1');
    expect(result.overallWinnerId).toBe('p1');
    expect(result.front9Totals['p1']).toBe(27);  // 9 × 3
    expect(result.back9Totals['p2']).toBe(36);   // 9 × 4
    expect(result.overallTotals['p1']).toBe(54); // 18 × 3
  });

  it('returns null for all winners on a tie', () => {
    const round = makeRound({
      scores: [...uniformScores('p1', 4), ...uniformScores('p2', 4)],
    });
    const game = makeGame({
      format: 'nassau',
      playerIds: ['p1', 'p2'],
      settings: { nassauMode: 'stroke', nassauScope: 'individual' },
    });
    const result = computeNassau(round, game);

    expect(result.front9WinnerId).toBeNull();
    expect(result.back9WinnerId).toBeNull();
    expect(result.overallWinnerId).toBeNull();
  });

  /**
   * STUB BEHAVIOR: match-play Nassau is not yet implemented.
   * The engine always uses stroke totals regardless of nassauMode='match'.
   * This test documents the current stub; a future item (P21) will implement it.
   */
  it('falls back to stroke totals when mode=match (documented stub)', () => {
    const round = makeRound({
      scores: [...uniformScores('p1', 3), ...uniformScores('p2', 4)],
    });
    const game = makeGame({
      format: 'nassau',
      playerIds: ['p1', 'p2'],
      settings: { nassauMode: 'match', nassauScope: 'individual' },
    });
    const result = computeNassau(round, game);

    // mode is echoed in the result
    expect(result.mode).toBe('match');
    // winner is still determined by stroke totals, not match-play hole wins
    expect(result.front9WinnerId).toBe('p1');
  });

  it('uses best-ball (lowest ball) logic for team scope', () => {
    // tA [p1=3, p2=5]: best ball 3 every hole → front9 = 27
    // tB [p3=4, p4=5]: best ball 4 every hole → front9 = 36
    const round = makeRound({
      players: makePlayers(['p1', 'p2', 'p3', 'p4']),
      scores: [
        ...uniformScores('p1', 3),
        ...uniformScores('p2', 5),
        ...uniformScores('p3', 4),
        ...uniformScores('p4', 5),
      ],
    });
    const game = makeGame({
      format: 'nassau',
      playerIds: ['p1', 'p2', 'p3', 'p4'],
      teams: [
        { id: 'tA', name: 'Team A', playerIds: ['p1', 'p2'] },
        { id: 'tB', name: 'Team B', playerIds: ['p3', 'p4'] },
      ],
      settings: { nassauScope: 'team' },
    });
    const result = computeNassau(round, game);

    expect(result.scope).toBe('team');
    expect(result.front9Totals['tA']).toBe(27);
    expect(result.front9WinnerId).toBe('tA');
  });

  it('only counts played holes in segment totals (partial round)', () => {
    // p1 and p2 only play front 9
    const round = makeRound({
      scores: [
        ...Array.from({ length: 9 }, (_, i) => ({
          playerId: 'p1',
          holeNumber: i + 1,
          strokes: 3,
        })),
        ...Array.from({ length: 9 }, (_, i) => ({
          playerId: 'p2',
          holeNumber: i + 1,
          strokes: 4,
        })),
      ],
    });
    const game = makeGame({
      format: 'nassau',
      playerIds: ['p1', 'p2'],
      settings: { nassauMode: 'stroke', nassauScope: 'individual' },
    });
    const result = computeNassau(round, game);

    expect(result.front9Totals['p1']).toBe(27);
    expect(result.back9Totals['p1']).toBe(0); // no back-9 scores
    expect(result.back9WinnerId).toBeNull();   // tie at 0
  });
});

// ---------------------------------------------------------------------------
// computeThreePoint
// ---------------------------------------------------------------------------

describe('computeThreePoint', () => {
  const FOUR_PLAYERS = ['p1', 'p2', 'p3', 'p4'];

  function threePointGame(): Partial<Game> {
    return {
      format: 'threePoint',
      playerIds: FOUR_PLAYERS,
      teams: [
        { id: 'tA', name: 'Team A', playerIds: ['p1', 'p2'] },
        { id: 'tB', name: 'Team B', playerIds: ['p3', 'p4'] },
      ],
      settings: {
        threePointPairs: {
          teamAPlayer1Id: 'p1',
          teamAPlayer2Id: 'p2',
          teamBPlayer1Id: 'p3',
          teamBPlayer2Id: 'p4',
        },
      },
    };
  }

  it('awards all 3 points to team A when they win all matchups on a hole', () => {
    // a1=3 beats b1=4, a2=3 beats b2=4, best-ball 3 beats 4 → 3-0
    const round = makeRound({
      players: makePlayers(FOUR_PLAYERS),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 },
        { playerId: 'p2', holeNumber: 1, strokes: 3 },
        { playerId: 'p3', holeNumber: 1, strokes: 4 },
        { playerId: 'p4', holeNumber: 1, strokes: 4 },
      ],
    });
    const game = makeGame(threePointGame());
    const result = computeThreePoint(round, game);

    expect(result.teamPointsByHole['tA'][0]).toBe(3);
    expect(result.teamPointsByHole['tB'][0]).toBe(0);
    expect(result.totals['tA']).toBe(3);
    expect(result.totals['tB']).toBe(0);
  });

  it('splits all points 1.5-1.5 when every matchup is a tie', () => {
    const round = makeRound({
      players: makePlayers(FOUR_PLAYERS),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 4 },
        { playerId: 'p2', holeNumber: 1, strokes: 4 },
        { playerId: 'p3', holeNumber: 1, strokes: 4 },
        { playerId: 'p4', holeNumber: 1, strokes: 4 },
      ],
    });
    const game = makeGame(threePointGame());
    const result = computeThreePoint(round, game);

    expect(result.teamPointsByHole['tA'][0]).toBe(1.5);
    expect(result.teamPointsByHole['tB'][0]).toBe(1.5);
  });

  it('returns 0 for all holes when threePointPairs is not configured', () => {
    const round = makeRound({
      players: makePlayers(FOUR_PLAYERS),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 },
        { playerId: 'p3', holeNumber: 1, strokes: 4 },
      ],
    });
    const game = makeGame({
      format: 'threePoint',
      teams: [
        { id: 'tA', name: 'Team A', playerIds: ['p1', 'p2'] },
        { id: 'tB', name: 'Team B', playerIds: ['p3', 'p4'] },
      ],
      settings: {}, // no threePointPairs
    });
    const result = computeThreePoint(round, game);

    expect(result.totals['tA']).toBe(0);
    expect(result.totals['tB']).toBe(0);
    expect(result.teamPointsByHole['tA']).toHaveLength(18);
  });

  it('accumulates running totals across holes correctly', () => {
    // hole 1: tA wins 3-0, hole 2: tB wins 0-3
    const round = makeRound({
      players: makePlayers(FOUR_PLAYERS),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 },
        { playerId: 'p2', holeNumber: 1, strokes: 3 },
        { playerId: 'p3', holeNumber: 1, strokes: 5 },
        { playerId: 'p4', holeNumber: 1, strokes: 5 },
        { playerId: 'p1', holeNumber: 2, strokes: 5 },
        { playerId: 'p2', holeNumber: 2, strokes: 5 },
        { playerId: 'p3', holeNumber: 2, strokes: 3 },
        { playerId: 'p4', holeNumber: 2, strokes: 3 },
      ],
    });
    const game = makeGame(threePointGame());
    const result = computeThreePoint(round, game);

    expect(result.runningTotalsByHole['tA'][0]).toBe(3); // after hole 1
    expect(result.runningTotalsByHole['tB'][0]).toBe(0); // after hole 1
    expect(result.runningTotalsByHole['tA'][1]).toBe(3); // after hole 2 (tA unchanged)
    expect(result.runningTotalsByHole['tB'][1]).toBe(3); // after hole 2
    expect(result.totals['tA']).toBe(3);
    expect(result.totals['tB']).toBe(3);
  });

  it('returns teamAId/teamBId from teams[0]/teams[1]', () => {
    const round = makeRound({ players: makePlayers(FOUR_PLAYERS), scores: [] });
    const game = makeGame(threePointGame());
    const result = computeThreePoint(round, game);

    expect(result.teamAId).toBe('tA');
    expect(result.teamBId).toBe('tB');
  });
});

// ---------------------------------------------------------------------------
// computeStableford
// ---------------------------------------------------------------------------

describe('computeStableford', () => {
  const PAR4_HOLES = makeHoles(Array<number>(18).fill(4));

  it('awards correct points per scoring category (par-4 holes)', () => {
    // strokes:  1→albatross(5), 2→eagle(4), 3→birdie(3), 4→par(2), 5→bogey(1), 6→double(0), 7→triple(0)
    const round = makeRound({
      holes: PAR4_HOLES,
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 1 }, // diff=-3 → 5
        { playerId: 'p1', holeNumber: 2, strokes: 2 }, // diff=-2 → 4
        { playerId: 'p1', holeNumber: 3, strokes: 3 }, // diff=-1 → 3
        { playerId: 'p1', holeNumber: 4, strokes: 4 }, // diff= 0 → 2
        { playerId: 'p1', holeNumber: 5, strokes: 5 }, // diff=+1 → 1
        { playerId: 'p1', holeNumber: 6, strokes: 6 }, // diff=+2 → 0
        { playerId: 'p1', holeNumber: 7, strokes: 7 }, // diff=+3 → 0
      ],
    });
    const game = makeGame({ format: 'stableford', playerIds: ['p1', 'p2'] });
    const result = computeStableford(round, game);
    const p1 = result.pointsByPlayer.find(p => p.playerId === 'p1')!;

    expect(p1.pointsByHole[0]).toBe(5); // albatross
    expect(p1.pointsByHole[1]).toBe(4); // eagle
    expect(p1.pointsByHole[2]).toBe(3); // birdie
    expect(p1.pointsByHole[3]).toBe(2); // par
    expect(p1.pointsByHole[4]).toBe(1); // bogey
    expect(p1.pointsByHole[5]).toBe(0); // double
    expect(p1.pointsByHole[6]).toBe(0); // triple
    expect(p1.total).toBe(15);          // 5+4+3+2+1+0+0
    expect(p1.holesPlayed).toBe(7);
  });

  it('determines winner as the player with highest total', () => {
    const round = makeRound({
      holes: PAR4_HOLES,
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 }, // birdie → 3 pts
        { playerId: 'p2', holeNumber: 1, strokes: 4 }, // par    → 2 pts
      ],
    });
    const game = makeGame({ format: 'stableford', playerIds: ['p1', 'p2'] });
    const result = computeStableford(round, game);

    expect(result.winnerPlayerId).toBe('p1');
  });

  it('returns null winnerPlayerId on a tie', () => {
    const round = makeRound({
      holes: PAR4_HOLES,
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 4 }, // par → 2 pts
        { playerId: 'p2', holeNumber: 1, strokes: 4 }, // par → 2 pts
      ],
    });
    const game = makeGame({ format: 'stableford', playerIds: ['p1', 'p2'] });
    const result = computeStableford(round, game);

    expect(result.winnerPlayerId).toBeNull();
  });

  it('stores null for unscored holes', () => {
    const round = makeRound({
      holes: PAR4_HOLES,
      scores: [{ playerId: 'p1', holeNumber: 1, strokes: 4 }],
    });
    const game = makeGame({ format: 'stableford', playerIds: ['p1', 'p2'] });
    const result = computeStableford(round, game);
    const p1 = result.pointsByPlayer.find(p => p.playerId === 'p1')!;

    expect(p1.pointsByHole[1]).toBeNull(); // hole 2 not scored
    expect(p1.holesPlayed).toBe(1);
  });

  it('uses round.holes for par (honours actual par per hole)', () => {
    // hole 1 is par-3; strokes=3 → par → 2 pts
    // Build all 18 holes explicitly so there are no duplicate hole numbers in the Map.
    const holes: HoleInfo[] = [
      { number: 1, par: 3 },
      ...Array.from({ length: 17 }, (_, i) => ({ number: i + 2, par: 4 })),
    ];
    const round = makeRound({
      holes,
      scores: [{ playerId: 'p1', holeNumber: 1, strokes: 3 }],
    });
    const game = makeGame({ format: 'stableford', playerIds: ['p1', 'p2'] });
    const result = computeStableford(round, game);
    const p1 = result.pointsByPlayer.find(p => p.playerId === 'p1')!;

    expect(p1.pointsByHole[0]).toBe(2); // par on a par-3 hole
  });
});

// ---------------------------------------------------------------------------
// computeMatchPlay
// ---------------------------------------------------------------------------

describe('computeMatchPlay', () => {
  function mpGame(): Partial<Game> {
    return {
      format: 'matchPlay',
      playerIds: ['p1', 'p2'],
      settings: { matchPlayPlayers: { player1Id: 'p1', player2Id: 'p2' } },
    };
  }

  it('records correct hole result and running match diff', () => {
    const round = makeRound({
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 }, // P1 wins
        { playerId: 'p2', holeNumber: 1, strokes: 4 },
        { playerId: 'p1', holeNumber: 2, strokes: 4 }, // halved
        { playerId: 'p2', holeNumber: 2, strokes: 4 },
        { playerId: 'p1', holeNumber: 3, strokes: 5 }, // P2 wins
        { playerId: 'p2', holeNumber: 3, strokes: 4 },
      ],
    });
    const game = makeGame(mpGame());
    const result = computeMatchPlay(round, game);

    expect(result.holes[0]).toMatchObject({ result: 'P1', matchDiffAfter: 1, statusAfter: '1 UP' });
    expect(result.holes[1]).toMatchObject({ result: 'HALVED', matchDiffAfter: 1, statusAfter: '1 UP' });
    expect(result.holes[2]).toMatchObject({ result: 'P2', matchDiffAfter: 0, statusAfter: 'AS' });
  });

  it('ends the match early when the lead exceeds remaining holes', () => {
    // p1 wins holes 1–10 → up 10 with 8 remaining → ends at hole 10 ("10 & 8")
    const scores: Score[] = [];
    for (let h = 1; h <= 10; h++) {
      scores.push({ playerId: 'p1', holeNumber: h, strokes: 3 });
      scores.push({ playerId: 'p2', holeNumber: h, strokes: 5 });
    }
    const round = makeRound({ scores });
    const game = makeGame(mpGame());
    const result = computeMatchPlay(round, game);

    expect(result.endedAtHole).toBe(10);
    expect(result.winnerPlayerId).toBe('p1');
    expect(result.currentStatus).toContain('Final');
    // holes beyond endedAtHole have ended=true
    expect(result.holes[10].ended).toBe(true);
  });

  it('marks NO_SCORE for holes with missing data and sets no winner', () => {
    const round = makeRound({ scores: [] });
    const game = makeGame(mpGame());
    const result = computeMatchPlay(round, game);

    expect(result.holes[0].result).toBe('NO_SCORE');
    expect(result.endedAtHole).toBeNull();
    expect(result.winnerPlayerId).toBeNull();
  });

  it('shows "AS" status when no holes have been played', () => {
    const round = makeRound({ scores: [] });
    const game = makeGame(mpGame());
    const result = computeMatchPlay(round, game);

    expect(result.currentStatus).toBe('AS');
  });

  it('falls back to game.playerIds[0]/[1] when matchPlayPlayers is not set', () => {
    const round = makeRound({
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 },
        { playerId: 'p2', holeNumber: 1, strokes: 4 },
      ],
    });
    const game = makeGame({
      format: 'matchPlay',
      playerIds: ['p1', 'p2'],
      settings: {}, // no matchPlayPlayers
    });
    const result = computeMatchPlay(round, game);

    expect(result.player1Id).toBe('p1');
    expect(result.player2Id).toBe('p2');
    expect(result.holes[0].result).toBe('P1');
  });
});

// ---------------------------------------------------------------------------
// computeWolf
// ---------------------------------------------------------------------------

describe('computeWolf', () => {
  const ORDER = ['p1', 'p2', 'p3', 'p4'];

  function wolfGame(choices: Record<number, { mode: 'lone' } | { mode: 'partner'; partnerId: string }> = {}): Partial<Game> {
    return {
      format: 'wolf',
      playerIds: ORDER,
      settings: {
        wolfOrderPlayerIds: ORDER,
        wolfHoleChoices: choices,
      },
    };
  }

  it('assigns wolf by (holeNumber-1) % 4 rotation', () => {
    const round = makeRound({ players: makePlayers(ORDER), scores: [] });
    const game = makeGame(wolfGame());
    const result = computeWolf(round, game);

    expect(result.holes[0].wolfPlayerId).toBe('p1');  // hole 1
    expect(result.holes[1].wolfPlayerId).toBe('p2');  // hole 2
    expect(result.holes[2].wolfPlayerId).toBe('p3');  // hole 3
    expect(result.holes[3].wolfPlayerId).toBe('p4');  // hole 4
    expect(result.holes[4].wolfPlayerId).toBe('p1');  // hole 5 (wraps)
  });

  it('lone wolf wins: wolf +3, others unchanged', () => {
    const round = makeRound({
      players: makePlayers(ORDER),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 }, // wolf beats others
        { playerId: 'p2', holeNumber: 1, strokes: 4 },
        { playerId: 'p3', holeNumber: 1, strokes: 4 },
        { playerId: 'p4', holeNumber: 1, strokes: 4 },
      ],
    });
    const game = makeGame(wolfGame({ 1: { mode: 'lone' } }));
    const result = computeWolf(round, game);

    expect(result.holes[0].pointsDelta['p1']).toBe(3);
    expect(result.totals['p1']).toBe(3);
    expect(result.totals['p2']).toBe(0);
    expect(result.totals['p3']).toBe(0);
    expect(result.totals['p4']).toBe(0);
  });

  it('lone wolf loses: wolf -3, others unchanged', () => {
    const round = makeRound({
      players: makePlayers(ORDER),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 5 }, // wolf loses to others
        { playerId: 'p2', holeNumber: 1, strokes: 3 },
        { playerId: 'p3', holeNumber: 1, strokes: 4 },
        { playerId: 'p4', holeNumber: 1, strokes: 4 },
      ],
    });
    const game = makeGame(wolfGame({ 1: { mode: 'lone' } }));
    const result = computeWolf(round, game);

    expect(result.holes[0].pointsDelta['p1']).toBe(-3);
    expect(result.totals['p1']).toBe(-3);
    expect(result.totals['p2']).toBe(0);
  });

  it('partner mode win: wolf + partner each +1', () => {
    // p1 (wolf) partners with p3; their best ball 3 beats p2/p4 best ball 4
    const round = makeRound({
      players: makePlayers(ORDER),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 },
        { playerId: 'p2', holeNumber: 1, strokes: 4 },
        { playerId: 'p3', holeNumber: 1, strokes: 3 }, // partner
        { playerId: 'p4', holeNumber: 1, strokes: 4 },
      ],
    });
    const game = makeGame(wolfGame({ 1: { mode: 'partner', partnerId: 'p3' } }));
    const result = computeWolf(round, game);

    expect(result.holes[0].pointsDelta['p1']).toBe(1);
    expect(result.holes[0].pointsDelta['p3']).toBe(1);
    expect(result.totals['p1']).toBe(1);
    expect(result.totals['p3']).toBe(1);
    expect(result.totals['p2']).toBe(0);
    expect(result.totals['p4']).toBe(0);
  });

  it('partner mode loss: opposing team each +1, wolf and partner unchanged', () => {
    // p1 (wolf) + p3 lose to p2/p4
    const round = makeRound({
      players: makePlayers(ORDER),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 5 },
        { playerId: 'p2', holeNumber: 1, strokes: 3 },
        { playerId: 'p3', holeNumber: 1, strokes: 5 }, // partner
        { playerId: 'p4', holeNumber: 1, strokes: 3 },
      ],
    });
    const game = makeGame(wolfGame({ 1: { mode: 'partner', partnerId: 'p3' } }));
    const result = computeWolf(round, game);

    expect(result.totals['p2']).toBe(1);
    expect(result.totals['p4']).toBe(1);
    expect(result.totals['p1']).toBe(0);
    expect(result.totals['p3']).toBe(0);
  });

  it('no choice made: no points awarded on that hole', () => {
    const round = makeRound({
      players: makePlayers(ORDER),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 },
        { playerId: 'p2', holeNumber: 1, strokes: 4 },
        { playerId: 'p3', holeNumber: 1, strokes: 4 },
        { playerId: 'p4', holeNumber: 1, strokes: 4 },
      ],
    });
    const game = makeGame(wolfGame()); // no choices
    const result = computeWolf(round, game);

    expect(result.holes[0].choice).toBeNull();
    expect(Object.keys(result.holes[0].pointsDelta)).toHaveLength(0);
    expect(result.totals['p1']).toBe(0);
  });

  it('tracks cumulative running totals across multiple holes', () => {
    // hole 1: p1 lone wolf wins (+3); hole 2: p2 lone wolf wins (+3)
    const scores: Score[] = [
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 4 },
      { playerId: 'p3', holeNumber: 1, strokes: 4 },
      { playerId: 'p4', holeNumber: 1, strokes: 4 },
      { playerId: 'p1', holeNumber: 2, strokes: 4 },
      { playerId: 'p2', holeNumber: 2, strokes: 3 },
      { playerId: 'p3', holeNumber: 2, strokes: 4 },
      { playerId: 'p4', holeNumber: 2, strokes: 4 },
    ];
    const round = makeRound({ players: makePlayers(ORDER), scores });
    const game = makeGame(wolfGame({ 1: { mode: 'lone' }, 2: { mode: 'lone' } }));
    const result = computeWolf(round, game);

    expect(result.holes[0].totalsAfter['p1']).toBe(3);
    expect(result.holes[1].totalsAfter['p1']).toBe(3); // unchanged on hole 2
    expect(result.holes[1].totalsAfter['p2']).toBe(3); // p2 wins hole 2
    expect(result.totals['p1']).toBe(3);
    expect(result.totals['p2']).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// computeGameResults (dispatcher)
// ---------------------------------------------------------------------------

describe('computeGameResults', () => {
  const BASE_ROUND = makeRound({ holes: makeHoles() });

  it('routes skins → result.skins defined', () => {
    const result = computeGameResults(BASE_ROUND, makeGame({ format: 'skins' }));
    expect(result.skins).toBeDefined();
    expect(result.bestBall).toBeUndefined();
  });

  it('routes bestBall → result.bestBall defined', () => {
    const result = computeGameResults(
      BASE_ROUND,
      makeGame({ format: 'bestBall', teams: [] }),
    );
    expect(result.bestBall).toBeDefined();
  });

  it('routes nassau → result.nassau defined', () => {
    const result = computeGameResults(BASE_ROUND, makeGame({ format: 'nassau' }));
    expect(result.nassau).toBeDefined();
  });

  it('routes threePoint → result.threePoint defined', () => {
    const result = computeGameResults(
      BASE_ROUND,
      makeGame({ format: 'threePoint', teams: [] }),
    );
    expect(result.threePoint).toBeDefined();
  });

  it('routes stableford AND modifiedStableford → result.stableford defined', () => {
    const r1 = computeGameResults(BASE_ROUND, makeGame({ format: 'stableford' }));
    expect(r1.stableford).toBeDefined();

    const r2 = computeGameResults(BASE_ROUND, makeGame({ format: 'modifiedStableford' }));
    expect(r2.stableford).toBeDefined();
  });

  it('routes matchPlay → result.matchPlay defined', () => {
    const result = computeGameResults(
      BASE_ROUND,
      makeGame({
        format: 'matchPlay',
        settings: { matchPlayPlayers: { player1Id: 'p1', player2Id: 'p2' } },
      }),
    );
    expect(result.matchPlay).toBeDefined();
  });

  it('routes wolf → result.wolf defined', () => {
    const round = makeRound({
      holes: makeHoles(),
      players: makePlayers(['p1', 'p2', 'p3', 'p4']),
    });
    const result = computeGameResults(
      round,
      makeGame({
        format: 'wolf',
        playerIds: ['p1', 'p2', 'p3', 'p4'],
        settings: { wolfOrderPlayerIds: ['p1', 'p2', 'p3', 'p4'] },
      }),
    );
    expect(result.wolf).toBeDefined();
  });

  it('returns empty object for unimplemented formats (scramble, bingoBangoBongo, etc.)', () => {
    for (const fmt of ['scramble', 'bingoBangoBongo', 'vegas'] as const) {
      const result = computeGameResults(BASE_ROUND, makeGame({ format: fmt }));
      expect(Object.keys(result)).toHaveLength(0);
    }
  });
});
