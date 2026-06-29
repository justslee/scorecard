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
  computeScramble,
  computeBingoBangoBongo,
  computeVegas,
  computeHammer,
  computeRabbit,
  computeTrash,
  computeChicago,
  computeDefender,
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

  // ---------------------------------------------------------------------------
  // Match-play Nassau (P21) — real hole-by-hole match play
  // ---------------------------------------------------------------------------

  it('match mode: p1 wins every hole → front9 closes early (5 & 4)', () => {
    // p1 always scores 3, p2 always scores 4 → p1 wins every hole.
    // Front-9 close: after hole 5, diff=5 > 4 remaining → "5 & 4"
    const round = makeRound({
      scores: [...uniformScores('p1', 3), ...uniformScores('p2', 4)],
    });
    const game = makeGame({
      format: 'nassau',
      playerIds: ['p1', 'p2'],
      settings: { nassauMode: 'match', nassauScope: 'individual' },
    });
    const result = computeNassau(round, game);

    expect(result.mode).toBe('match');
    // Match-play data is present
    expect(result.front9Match).toBeDefined();
    expect(result.back9Match).toBeDefined();
    expect(result.overallMatch).toBeDefined();

    // Front 9: closes at hole 5 (5 up with 4 remaining → "5 & 4")
    expect(result.front9Match!.closedAt).toBe(5);
    expect(result.front9Match!.closed).toBe(true);
    expect(result.front9Match!.statusLabel).toBe('5 & 4');
    expect(result.front9Match!.leaderId).toBe('p1');

    // Winner IDs come from match leaders, not stroke totals
    expect(result.front9WinnerId).toBe('p1');
    expect(result.back9WinnerId).toBe('p1');
    expect(result.overallWinnerId).toBe('p1');
  });

  it('match mode: AS segment — alternating hole wins, ends all square', () => {
    // p1 wins holes 1–4, p2 wins holes 5–8, hole 9 halved → Front 9 ends AS.
    // Check close never fires: max diff=4, at that point remaining=5 → 4>5? No.
    const scores: Score[] = [];
    // Holes 1–4: p1 wins (3 vs 4)
    for (let h = 1; h <= 4; h++) {
      scores.push({ playerId: 'p1', holeNumber: h, strokes: 3 });
      scores.push({ playerId: 'p2', holeNumber: h, strokes: 4 });
    }
    // Holes 5–8: p2 wins (4 vs 3)
    for (let h = 5; h <= 8; h++) {
      scores.push({ playerId: 'p1', holeNumber: h, strokes: 4 });
      scores.push({ playerId: 'p2', holeNumber: h, strokes: 3 });
    }
    // Hole 9: halved (4 vs 4)
    scores.push({ playerId: 'p1', holeNumber: 9, strokes: 4 });
    scores.push({ playerId: 'p2', holeNumber: 9, strokes: 4 });

    const round = makeRound({ scores });
    const game = makeGame({
      format: 'nassau',
      playerIds: ['p1', 'p2'],
      settings: { nassauMode: 'match', nassauScope: 'individual' },
    });
    const result = computeNassau(round, game);

    expect(result.front9Match!.closed).toBe(false);
    expect(result.front9Match!.matchDiff).toBe(0);
    expect(result.front9Match!.statusLabel).toBe('AS');
    expect(result.front9Match!.leaderId).toBeNull();
    expect(result.front9WinnerId).toBeNull(); // tied
  });

  it('match mode: partial round — in-progress status, no early close', () => {
    // Only holes 1–3 scored; p1 wins all three → "3 UP" (remaining=6, no close)
    const scores: Score[] = [];
    for (let h = 1; h <= 3; h++) {
      scores.push({ playerId: 'p1', holeNumber: h, strokes: 3 });
      scores.push({ playerId: 'p2', holeNumber: h, strokes: 4 });
    }
    const round = makeRound({ scores });
    const game = makeGame({
      format: 'nassau',
      playerIds: ['p1', 'p2'],
      settings: { nassauMode: 'match', nassauScope: 'individual' },
    });
    const result = computeNassau(round, game);

    expect(result.front9Match!.holesPlayed).toBe(3);
    expect(result.front9Match!.matchDiff).toBe(3);
    expect(result.front9Match!.closed).toBe(false);
    expect(result.front9Match!.statusLabel).toBe('3 UP');
    expect(result.front9Match!.leaderId).toBe('p1');

    // Back 9 and Overall: not started
    expect(result.back9Match!.holesPlayed).toBe(0);
    expect(result.back9Match!.statusLabel).toBe('—');
    expect(result.overallMatch!.holesPlayed).toBe(3);
    expect(result.overallMatch!.statusLabel).toBe('3 UP');
  });

  it('match mode: overall closes at hole 10 (10 & 8) when p1 wins every hole', () => {
    // p1 scores 3, p2 scores 4 on all 18 → overall closes when diff > remaining.
    // Diff=10 after hole 10, remaining=8 → 10>8 → closes at hole 10 ("10 & 8")
    const round = makeRound({
      scores: [...uniformScores('p1', 3), ...uniformScores('p2', 4)],
    });
    const game = makeGame({
      format: 'nassau',
      playerIds: ['p1', 'p2'],
      settings: { nassauMode: 'match', nassauScope: 'individual' },
    });
    const result = computeNassau(round, game);

    expect(result.overallMatch!.closedAt).toBe(10);
    expect(result.overallMatch!.statusLabel).toBe('10 & 8');
  });

  it('match mode: no scores → all segments show "—" with no leader', () => {
    const round = makeRound({ scores: [] });
    const game = makeGame({
      format: 'nassau',
      playerIds: ['p1', 'p2'],
      settings: { nassauMode: 'match', nassauScope: 'individual' },
    });
    const result = computeNassau(round, game);

    expect(result.front9Match!.holesPlayed).toBe(0);
    expect(result.front9Match!.statusLabel).toBe('—');
    expect(result.front9WinnerId).toBeNull();
    expect(result.overallWinnerId).toBeNull();
  });

  it('match mode: team scope — best-ball per hole determines match result', () => {
    // tA: p1=3, p2=5 → best ball 3 per hole; tB: p3=4, p4=5 → best ball 4 per hole
    // tA wins every hole → front9 closes early (same as individual scenario above)
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
      settings: { nassauMode: 'match', nassauScope: 'team' },
    });
    const result = computeNassau(round, game);

    expect(result.scope).toBe('team');
    expect(result.front9Match!.closed).toBe(true);
    expect(result.front9Match!.leaderId).toBe('tA');
    expect(result.front9WinnerId).toBe('tA');
  });

  it('stroke mode unchanged when nassauMode=stroke', () => {
    // Ensure existing stroke-mode behavior is completely unaffected.
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
    expect(result.front9Match).toBeUndefined();  // no match data in stroke mode
    expect(result.front9WinnerId).toBe('p1');    // determined by stroke totals
    expect(result.front9Totals['p1']).toBe(27);
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

  it('routes scramble → result.scramble defined', () => {
    const result = computeGameResults(BASE_ROUND, makeGame({ format: 'scramble', teams: [] }));
    expect(result.scramble).toBeDefined();
  });

  it('routes bingoBangoBongo → result.bingoBangoBongo defined', () => {
    const result = computeGameResults(BASE_ROUND, makeGame({ format: 'bingoBangoBongo' }));
    expect(result.bingoBangoBongo).toBeDefined();
  });

  it('routes vegas → result.vegas defined', () => {
    const result = computeGameResults(BASE_ROUND, makeGame({ format: 'vegas', teams: [] }));
    expect(result.vegas).toBeDefined();
  });

  it('routes hammer → result.hammer defined', () => {
    const result = computeGameResults(BASE_ROUND, makeGame({ format: 'hammer' }));
    expect(result.hammer).toBeDefined();
  });

  it('routes rabbit → result.rabbit defined', () => {
    const result = computeGameResults(BASE_ROUND, makeGame({ format: 'rabbit' }));
    expect(result.rabbit).toBeDefined();
  });

  it('routes trash → result.trash defined', () => {
    const result = computeGameResults(BASE_ROUND, makeGame({ format: 'trash' }));
    expect(result.trash).toBeDefined();
  });

  it('routes chicago → result.chicago defined', () => {
    const result = computeGameResults(BASE_ROUND, makeGame({ format: 'chicago' }));
    expect(result.chicago).toBeDefined();
  });

  it('routes defender → result.defender defined', () => {
    const result = computeGameResults(BASE_ROUND, makeGame({ format: 'defender' }));
    expect(result.defender).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// computeScramble
// ---------------------------------------------------------------------------

describe('computeScramble', () => {
  const FOUR_PLAYERS = ['p1', 'p2', 'p3', 'p4'];

  function scrambleGame(): Partial<Game> {
    return {
      format: 'scramble',
      playerIds: FOUR_PLAYERS,
      teams: [
        { id: 'tA', name: 'Team A', playerIds: ['p1', 'p2'] },
        { id: 'tB', name: 'Team B', playerIds: ['p3', 'p4'] },
      ],
    };
  }

  it('uses the lowest (best) score per team per hole', () => {
    const round = makeRound({
      players: makePlayers(FOUR_PLAYERS),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 4 },
        { playerId: 'p2', holeNumber: 1, strokes: 5 }, // team A best = 4
        { playerId: 'p3', holeNumber: 1, strokes: 3 },
        { playerId: 'p4', holeNumber: 1, strokes: 6 }, // team B best = 3
      ],
    });
    const game = makeGame(scrambleGame());
    const result = computeScramble(round, game);

    expect(result.teamScoresByHole['tA'][0]).toBe(4);
    expect(result.teamScoresByHole['tB'][0]).toBe(3);
  });

  it('declares the team with the lower total the winner', () => {
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
    const game = makeGame(scrambleGame());
    const result = computeScramble(round, game);

    expect(result.winnerTeamId).toBe('tA');
    expect(result.totals.find(t => t.teamId === 'tA')?.total).toBe(6);
    expect(result.totals.find(t => t.teamId === 'tB')?.total).toBe(8);
  });

  it('returns null winnerTeamId on a tie', () => {
    const round = makeRound({
      players: makePlayers(FOUR_PLAYERS),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 },
        { playerId: 'p3', holeNumber: 1, strokes: 3 },
      ],
    });
    const game = makeGame(scrambleGame());
    const result = computeScramble(round, game);
    expect(result.winnerTeamId).toBeNull();
  });

  it('stores null for unscored holes', () => {
    const round = makeRound({ players: makePlayers(FOUR_PLAYERS), scores: [] });
    const game = makeGame(scrambleGame());
    const result = computeScramble(round, game);
    expect(result.teamScoresByHole['tA']).toHaveLength(18);
    expect(result.teamScoresByHole['tA'][0]).toBeNull();
    expect(result.totals.find(t => t.teamId === 'tA')?.holesPlayed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeBingoBangoBongo
// ---------------------------------------------------------------------------

describe('computeBingoBangoBongo', () => {
  it('returns all-zero totals and a non-empty dataLimitations array', () => {
    const round = makeRound({
      scores: [...uniformScores('p1', 3), ...uniformScores('p2', 4)],
    });
    const game = makeGame({ format: 'bingoBangoBongo', playerIds: ['p1', 'p2'] });
    const result = computeBingoBangoBongo(round, game);

    expect(result.playerIds).toEqual(['p1', 'p2']);
    expect(result.totals['p1']).toBe(0);
    expect(result.totals['p2']).toBe(0);
    expect(result.dataLimitations.length).toBeGreaterThan(0);
    // All three event types noted
    const joined = result.dataLimitations.join(' ');
    expect(joined).toMatch(/[Bb]ingo/);
    expect(joined).toMatch(/[Bb]ango/);
    expect(joined).toMatch(/[Bb]ongo/);
  });

  it('falls back to round.players when playerIds is empty', () => {
    const round = makeRound({ players: makePlayers(['p1', 'p2', 'p3']) });
    const game = makeGame({ format: 'bingoBangoBongo', playerIds: [] });
    const result = computeBingoBangoBongo(round, game);
    expect(result.playerIds).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// computeVegas
// ---------------------------------------------------------------------------

describe('computeVegas', () => {
  const FOUR_PLAYERS = ['p1', 'p2', 'p3', 'p4'];

  function vegasGame(pv = 1): Partial<Game> {
    return {
      format: 'vegas',
      playerIds: FOUR_PLAYERS,
      teams: [
        { id: 'tA', name: 'Team A', playerIds: ['p1', 'p2'] },
        { id: 'tB', name: 'Team B', playerIds: ['p3', 'p4'] },
      ],
      settings: { pointValue: pv },
    };
  }

  it('combines 2-player scores into correct Vegas number (low digit first)', () => {
    // Team A: 4 & 5 → 45; Team B: 5 & 6 → 56
    const round = makeRound({
      players: makePlayers(FOUR_PLAYERS),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 4 },
        { playerId: 'p2', holeNumber: 1, strokes: 5 },
        { playerId: 'p3', holeNumber: 1, strokes: 5 },
        { playerId: 'p4', holeNumber: 1, strokes: 6 },
      ],
    });
    const game = makeGame(vegasGame());
    const result = computeVegas(round, game);

    expect(result.holes[0].teamANumber).toBe(45);
    expect(result.holes[0].teamBNumber).toBe(56);
    expect(result.holes[0].diff).toBe(11); // 56 - 45 = 11 (positive → A wins)
    expect(result.holes[0].winnerTeamId).toBe('tA');
  });

  it('sorts scores low-high regardless of player order (3 & 5 → 35, not 53)', () => {
    const round = makeRound({
      players: makePlayers(FOUR_PLAYERS),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 5 }, // high first
        { playerId: 'p2', holeNumber: 1, strokes: 3 }, // low second
        { playerId: 'p3', holeNumber: 2, strokes: 4 },
        { playerId: 'p4', holeNumber: 2, strokes: 4 },
      ],
    });
    const game = makeGame(vegasGame());
    const result = computeVegas(round, game);
    expect(result.holes[0].teamANumber).toBe(35); // sorted 3,5 → 35
  });

  it('team B winning produces negative totals for team A', () => {
    // Team A: 5 & 6 → 56; Team B: 4 & 4 → 44; diff = 44 - 56 = -12 → B wins 12
    const round = makeRound({
      players: makePlayers(FOUR_PLAYERS),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 5 },
        { playerId: 'p2', holeNumber: 1, strokes: 6 },
        { playerId: 'p3', holeNumber: 1, strokes: 4 },
        { playerId: 'p4', holeNumber: 1, strokes: 4 },
      ],
    });
    const game = makeGame(vegasGame());
    const result = computeVegas(round, game);

    expect(result.holes[0].winnerTeamId).toBe('tB');
    expect(result.totals['tA']).toBe(-12);
    expect(result.totals['tB']).toBe(12);
    // Zero-sum check
    expect(result.totals['tA'] + result.totals['tB']).toBe(0);
  });

  it('totals are zero-sum across a push (equal Vegas numbers)', () => {
    // Team A: 4 & 5 → 45; Team B: 4 & 5 → 45; push
    const round = makeRound({
      players: makePlayers(FOUR_PLAYERS),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 4 },
        { playerId: 'p2', holeNumber: 1, strokes: 5 },
        { playerId: 'p3', holeNumber: 1, strokes: 4 },
        { playerId: 'p4', holeNumber: 1, strokes: 5 },
      ],
    });
    const game = makeGame(vegasGame());
    const result = computeVegas(round, game);
    expect(result.holes[0].winnerTeamId).toBeNull();
    expect(result.totals['tA']).toBe(0);
    expect(result.totals['tB']).toBe(0);
  });

  it('scales by pointValue', () => {
    // Diff = 11, pointValue = 5 → each team ±55
    const round = makeRound({
      players: makePlayers(FOUR_PLAYERS),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 4 },
        { playerId: 'p2', holeNumber: 1, strokes: 5 },
        { playerId: 'p3', holeNumber: 1, strokes: 5 },
        { playerId: 'p4', holeNumber: 1, strokes: 6 },
      ],
    });
    const game = makeGame(vegasGame(5));
    const result = computeVegas(round, game);
    expect(result.totals['tA']).toBe(55);
    expect(result.totals['tB']).toBe(-55);
  });

  it('returns null Vegas numbers when fewer than 2 players on a team have scores', () => {
    const round = makeRound({
      players: makePlayers(FOUR_PLAYERS),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 4 },
        // p2 has no score — Team A can't form a Vegas number
        { playerId: 'p3', holeNumber: 1, strokes: 4 },
        { playerId: 'p4', holeNumber: 1, strokes: 5 },
      ],
    });
    const game = makeGame(vegasGame());
    const result = computeVegas(round, game);
    expect(result.holes[0].teamANumber).toBeNull();
    expect(result.holes[0].winnerTeamId).toBeNull();
    expect(result.totals['tA']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeHammer
// ---------------------------------------------------------------------------

describe('computeHammer', () => {
  it('winner of a hole earns pointValue from each loser', () => {
    const round = makeRound({
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 }, // wins
        { playerId: 'p2', holeNumber: 1, strokes: 5 },
      ],
    });
    const game = makeGame({
      format: 'hammer',
      playerIds: ['p1', 'p2'],
      settings: { pointValue: 2 },
    });
    const result = computeHammer(round, game);

    expect(result.totals['p1']).toBe(2);  // +2 from p2
    expect(result.totals['p2']).toBe(-2); // -2 to p1
    // Zero-sum
    expect(result.totals['p1'] + result.totals['p2']).toBe(0);
  });

  it('tie (equal scores) results in no exchange', () => {
    const round = makeRound({
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 4 },
        { playerId: 'p2', holeNumber: 1, strokes: 4 },
      ],
    });
    const game = makeGame({ format: 'hammer', playerIds: ['p1', 'p2'], settings: { pointValue: 1 } });
    const result = computeHammer(round, game);

    expect(result.holes[0].winnerPlayerId).toBeNull();
    expect(result.totals['p1']).toBe(0);
    expect(result.totals['p2']).toBe(0);
  });

  it('applies multiplier from hammerMultiplierByHole', () => {
    // hole 1: multiplier 2, pointValue 3 → winner earns 6 from each loser
    const round = makeRound({
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 },
        { playerId: 'p2', holeNumber: 1, strokes: 5 },
      ],
    });
    const game = makeGame({
      format: 'hammer',
      playerIds: ['p1', 'p2'],
      settings: { pointValue: 3, hammerMultiplierByHole: { 1: 2 } },
    });
    const result = computeHammer(round, game);

    expect(result.holes[0].multiplier).toBe(2);
    expect(result.holes[0].points).toBe(6); // 2 × 3
    expect(result.totals['p1']).toBe(6);
    expect(result.totals['p2']).toBe(-6);
  });

  it('default multiplier is 1 for holes not listed', () => {
    const round = makeRound({
      scores: [
        { playerId: 'p1', holeNumber: 3, strokes: 3 },
        { playerId: 'p2', holeNumber: 3, strokes: 5 },
      ],
    });
    const game = makeGame({
      format: 'hammer',
      playerIds: ['p1', 'p2'],
      settings: { pointValue: 1, hammerMultiplierByHole: {} },
    });
    const result = computeHammer(round, game);
    expect(result.holes[2].multiplier).toBe(1);
  });

  it('totals are zero-sum across multiple holes', () => {
    // hole 1: p1 wins; hole 2: p2 wins; net should cancel
    const scores: Score[] = [
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 5 },
      { playerId: 'p1', holeNumber: 2, strokes: 5 },
      { playerId: 'p2', holeNumber: 2, strokes: 3 },
    ];
    const round = makeRound({ scores });
    const game = makeGame({ format: 'hammer', playerIds: ['p1', 'p2'], settings: { pointValue: 1 } });
    const result = computeHammer(round, game);
    expect(result.totals['p1'] + result.totals['p2']).toBe(0);
    expect(result.totals['p1']).toBe(0);
  });

  it('reports a dataLimitations entry about live hammer events', () => {
    const round = makeRound({ scores: [] });
    const game = makeGame({ format: 'hammer', playerIds: ['p1', 'p2'], settings: {} });
    const result = computeHammer(round, game);
    expect(result.dataLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// computeRabbit
// ---------------------------------------------------------------------------

describe('computeRabbit', () => {
  it('first outright hole winner captures the rabbit', () => {
    const round = makeRound({
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 },
        { playerId: 'p2', holeNumber: 1, strokes: 4 },
      ],
    });
    const game = makeGame({ format: 'rabbit', playerIds: ['p1', 'p2'] });
    const result = computeRabbit(round, game);

    expect(result.holes[0].outright).toBe('p1');
    expect(result.holes[0].holder).toBe('p1');
    expect(result.holes[0].changed).toBe(true);
  });

  it('tie leaves rabbit with its current holder (or still free)', () => {
    // hole 1: p1 captures; hole 2: tie → p1 keeps
    const round = makeRound({
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 },
        { playerId: 'p2', holeNumber: 1, strokes: 4 },
        { playerId: 'p1', holeNumber: 2, strokes: 4 },
        { playerId: 'p2', holeNumber: 2, strokes: 4 },
      ],
    });
    const game = makeGame({ format: 'rabbit', playerIds: ['p1', 'p2'] });
    const result = computeRabbit(round, game);

    expect(result.holes[1].outright).toBeNull();
    expect(result.holes[1].holder).toBe('p1'); // p1 still holds
    expect(result.holes[1].changed).toBe(false);
  });

  it('rabbit transfers when a different player wins outright', () => {
    // hole 1: p1 captures; hole 2: p2 wins → rabbit transfers
    const round = makeRound({
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 },
        { playerId: 'p2', holeNumber: 1, strokes: 5 },
        { playerId: 'p1', holeNumber: 2, strokes: 5 },
        { playerId: 'p2', holeNumber: 2, strokes: 3 },
      ],
    });
    const game = makeGame({ format: 'rabbit', playerIds: ['p1', 'p2'] });
    const result = computeRabbit(round, game);

    expect(result.holes[1].holder).toBe('p2');
    expect(result.holes[1].changed).toBe(true);
  });

  it('tracks front9HolderId and back9HolderId correctly', () => {
    // p1 wins hole 1, p2 wins hole 10 (transfer midway)
    const scores: Score[] = [
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 5 },
      { playerId: 'p1', holeNumber: 10, strokes: 5 },
      { playerId: 'p2', holeNumber: 10, strokes: 3 },
    ];
    const round = makeRound({ scores });
    const game = makeGame({ format: 'rabbit', playerIds: ['p1', 'p2'] });
    const result = computeRabbit(round, game);

    expect(result.front9HolderId).toBe('p1'); // p1 held through hole 9
    expect(result.back9HolderId).toBe('p2');  // p2 captured on hole 10
  });

  it('returns null holders when no outright hole wins occur', () => {
    // All ties — rabbit never captured
    const round = makeRound({
      scores: [...uniformScores('p1', 4), ...uniformScores('p2', 4)],
    });
    const game = makeGame({ format: 'rabbit', playerIds: ['p1', 'p2'] });
    const result = computeRabbit(round, game);

    expect(result.front9HolderId).toBeNull();
    expect(result.back9HolderId).toBeNull();
    expect(result.holes.every(h => h.holder === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeTrash
// ---------------------------------------------------------------------------

describe('computeTrash', () => {
  const PAR4_HOLES = makeHoles(Array<number>(18).fill(4));

  it('awards 1× pointValue for a birdie, 2× for eagle, 3× for albatross', () => {
    const round = makeRound({
      holes: PAR4_HOLES,
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 }, // birdie on par 4
        { playerId: 'p1', holeNumber: 2, strokes: 2 }, // eagle on par 4
        { playerId: 'p1', holeNumber: 3, strokes: 1 }, // albatross on par 4
      ],
    });
    const game = makeGame({ format: 'trash', playerIds: ['p1', 'p2'], settings: { pointValue: 2 } });
    const result = computeTrash(round, game);

    const events = result.events.filter(e => e.playerId === 'p1');
    expect(events.find(e => e.type === 'birdie')?.pointValue).toBe(2);
    expect(events.find(e => e.type === 'eagle')?.pointValue).toBe(4);
    expect(events.find(e => e.type === 'albatross')?.pointValue).toBe(6);
    expect(result.totals['p1']).toBe(12); // 2+4+6
  });

  it('par or worse scores earn no trash points', () => {
    const round = makeRound({
      holes: PAR4_HOLES,
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 4 }, // par
        { playerId: 'p1', holeNumber: 2, strokes: 5 }, // bogey
        { playerId: 'p1', holeNumber: 3, strokes: 6 }, // double
      ],
    });
    const game = makeGame({ format: 'trash', playerIds: ['p1'], settings: { pointValue: 1 } });
    const result = computeTrash(round, game);
    expect(result.events).toHaveLength(0);
    expect(result.totals['p1']).toBe(0);
  });

  it('records events for all players independently', () => {
    const round = makeRound({
      holes: PAR4_HOLES,
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 }, // birdie
        { playerId: 'p2', holeNumber: 1, strokes: 3 }, // birdie
      ],
    });
    const game = makeGame({ format: 'trash', playerIds: ['p1', 'p2'], settings: { pointValue: 1 } });
    const result = computeTrash(round, game);

    expect(result.events).toHaveLength(2);
    expect(result.totals['p1']).toBe(1);
    expect(result.totals['p2']).toBe(1);
  });

  it('reports dataLimitations for events that need capture (greenie, sandy, etc.)', () => {
    const round = makeRound({ holes: PAR4_HOLES, scores: [] });
    const game = makeGame({ format: 'trash', playerIds: ['p1'], settings: {} });
    const result = computeTrash(round, game);

    const text = result.dataLimitations.join(' ').toLowerCase();
    expect(text).toMatch(/greenie/);
    expect(text).toMatch(/sandy/);
    expect(result.dataLimitations.length).toBeGreaterThanOrEqual(3);
  });

  it('uses par from round.holes per hole', () => {
    // par-3 hole 1; strokes=2 → birdie (diff=-1); strokes=1 → eagle (diff=-2)
    const holes: HoleInfo[] = [
      { number: 1, par: 3 },
      ...Array.from({ length: 17 }, (_, i) => ({ number: i + 2, par: 4 })),
    ];
    const round = makeRound({
      holes,
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 2 }, // birdie on par-3 (diff=-1)
        { playerId: 'p1', holeNumber: 2, strokes: 2 }, // eagle on par-4 (diff=-2)
      ],
    });
    const game = makeGame({ format: 'trash', playerIds: ['p1'], settings: { pointValue: 1 } });
    const result = computeTrash(round, game);
    expect(result.events.find(e => e.holeNumber === 1)?.type).toBe('birdie');
    expect(result.events.find(e => e.holeNumber === 2)?.type).toBe('eagle');
  });
});

// ---------------------------------------------------------------------------
// computeChicago
// ---------------------------------------------------------------------------

describe('computeChicago', () => {
  const PAR4_HOLES = makeHoles(Array<number>(18).fill(4));

  it('awards Chicago points correctly per score category', () => {
    const round = makeRound({
      holes: PAR4_HOLES,
      players: [
        { id: 'p1', name: 'p1', handicap: 0 },
        { id: 'p2', name: 'p2', handicap: 0 },
      ],
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 1 }, // albatross (diff=-3) → 16
        { playerId: 'p1', holeNumber: 2, strokes: 2 }, // eagle → 8
        { playerId: 'p1', holeNumber: 3, strokes: 3 }, // birdie → 4
        { playerId: 'p1', holeNumber: 4, strokes: 4 }, // par → 2
        { playerId: 'p1', holeNumber: 5, strokes: 5 }, // bogey → 1
        { playerId: 'p1', holeNumber: 6, strokes: 6 }, // double → 0
      ],
    });
    const game = makeGame({
      format: 'chicago',
      playerIds: ['p1', 'p2'],
      settings: {},
    });
    const result = computeChicago(round, game);
    expect(result.pointsByHole[0].points['p1']).toBe(16);
    expect(result.pointsByHole[1].points['p1']).toBe(8);
    expect(result.pointsByHole[2].points['p1']).toBe(4);
    expect(result.pointsByHole[3].points['p1']).toBe(2);
    expect(result.pointsByHole[4].points['p1']).toBe(1);
    expect(result.pointsByHole[5].points['p1']).toBe(0);
    expect(result.totals['p1']).toBe(31); // 16+8+4+2+1+0
  });

  it('calculates quota as chicagoQuotaBase - handicap (default base 39)', () => {
    const round = makeRound({
      holes: PAR4_HOLES,
      players: [
        { id: 'p1', name: 'p1', handicap: 10 },
        { id: 'p2', name: 'p2', handicap: 20 },
      ],
      scores: [],
    });
    const game = makeGame({ format: 'chicago', playerIds: ['p1', 'p2'], settings: {} });
    const result = computeChicago(round, game);

    expect(result.quotas['p1']).toBe(29); // 39 - 10
    expect(result.quotas['p2']).toBe(19); // 39 - 20
  });

  it('respects chicagoQuotaBase setting', () => {
    const round = makeRound({
      holes: PAR4_HOLES,
      players: [{ id: 'p1', name: 'p1', handicap: 5 }],
      scores: [],
    });
    const game = makeGame({
      format: 'chicago',
      playerIds: ['p1'],
      settings: { chicagoQuotaBase: 36 },
    });
    const result = computeChicago(round, game);
    expect(result.quotas['p1']).toBe(31); // 36 - 5
  });

  it('quota does not go below 0 for high handicappers', () => {
    const round = makeRound({
      holes: PAR4_HOLES,
      players: [{ id: 'p1', name: 'p1', handicap: 50 }],
      scores: [],
    });
    const game = makeGame({ format: 'chicago', playerIds: ['p1'], settings: {} });
    const result = computeChicago(round, game);
    expect(result.quotas['p1']).toBe(0);
  });

  it('netVsQuota = total - quota; highest net wins', () => {
    // p1: handicap 15, quota 24; p2: handicap 10, quota 29
    // p1 scores 30 total pts, p2 scores 30 total pts
    // p1 net = 30-24 = +6; p2 net = 30-29 = +1 → p1 wins
    const round = makeRound({
      holes: PAR4_HOLES,
      players: [
        { id: 'p1', name: 'p1', handicap: 15 },
        { id: 'p2', name: 'p2', handicap: 10 },
      ],
      // Give each player 15 pars (15×2=30) and 3 unscored holes to keep math clean
      scores: [
        ...Array.from({ length: 15 }, (_, i) => ({ playerId: 'p1', holeNumber: i + 1, strokes: 4 })),
        ...Array.from({ length: 15 }, (_, i) => ({ playerId: 'p2', holeNumber: i + 1, strokes: 4 })),
      ],
    });
    const game = makeGame({ format: 'chicago', playerIds: ['p1', 'p2'], settings: {} });
    const result = computeChicago(round, game);

    expect(result.totals['p1']).toBe(30);
    expect(result.totals['p2']).toBe(30);
    expect(result.netVsQuota['p1']).toBe(6);  // 30 - 24
    expect(result.netVsQuota['p2']).toBe(1);  // 30 - 29
    expect(result.winnerPlayerId).toBe('p1');
  });

  it('returns null winnerPlayerId on a net tie', () => {
    // Both players same handicap, same score → same net
    const round = makeRound({
      holes: PAR4_HOLES,
      players: [
        { id: 'p1', name: 'p1', handicap: 10 },
        { id: 'p2', name: 'p2', handicap: 10 },
      ],
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 4 }, // par → 2 pts
        { playerId: 'p2', holeNumber: 1, strokes: 4 },
      ],
    });
    const game = makeGame({ format: 'chicago', playerIds: ['p1', 'p2'], settings: {} });
    const result = computeChicago(round, game);
    expect(result.winnerPlayerId).toBeNull();
  });

  it('stores null for unscored holes', () => {
    const round = makeRound({
      holes: PAR4_HOLES,
      players: [{ id: 'p1', name: 'p1', handicap: 0 }],
      scores: [{ playerId: 'p1', holeNumber: 1, strokes: 4 }],
    });
    const game = makeGame({ format: 'chicago', playerIds: ['p1'], settings: {} });
    const result = computeChicago(round, game);
    expect(result.pointsByHole[1].points['p1']).toBeNull(); // hole 2 unscored
  });
});

// ---------------------------------------------------------------------------
// computeDefender
// ---------------------------------------------------------------------------

describe('computeDefender', () => {
  it('defender earns pointValue per scored challenger when they have the sole low score; challengers pay', () => {
    const round = makeRound({
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 }, // defender (fixed)
        { playerId: 'p2', holeNumber: 1, strokes: 5 },
        { playerId: 'p3', holeNumber: 1, strokes: 5 },
      ],
      players: makePlayers(['p1', 'p2', 'p3']),
    });
    const game = makeGame({
      format: 'defender',
      playerIds: ['p1', 'p2', 'p3'],
      settings: { pointValue: 2, defenderPlayerId: 'p1' },
    });
    const result = computeDefender(round, game);

    expect(result.holes[0].result).toBe('defended');
    expect(result.holes[0].defenderId).toBe('p1');
    expect(result.holes[0].defenderDelta).toBe(4); // 2 challengers × 2 pts
    expect(result.totals['p1']).toBe(4);
    expect(result.totals['p2']).toBe(-2); // paid 2 to defender
    expect(result.totals['p3']).toBe(-2); // paid 2 to defender
    // Zero-sum: 4 + (-2) + (-2) = 0
    expect(result.totals['p1'] + result.totals['p2'] + result.totals['p3']).toBe(0);
  });

  it('challenger who beats defender earns pointValue; defender loses pointValue per beater', () => {
    const round = makeRound({
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 5 }, // defender (fixed)
        { playerId: 'p2', holeNumber: 1, strokes: 3 }, // beater
        { playerId: 'p3', holeNumber: 1, strokes: 5 },
      ],
      players: makePlayers(['p1', 'p2', 'p3']),
    });
    const game = makeGame({
      format: 'defender',
      playerIds: ['p1', 'p2', 'p3'],
      settings: { pointValue: 1, defenderPlayerId: 'p1' },
    });
    const result = computeDefender(round, game);

    expect(result.holes[0].result).toBe('beaten');
    expect(result.holes[0].beaterIds).toEqual(['p2']);
    expect(result.totals['p1']).toBe(-1);
    expect(result.totals['p2']).toBe(1);
    expect(result.totals['p3']).toBe(0);
  });

  it('defender rotates by hole index when defenderPlayerId is not set', () => {
    const round = makeRound({
      players: makePlayers(['p1', 'p2', 'p3']),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 }, // p1 defends hole 1 (index 0 % 3 = 0)
        { playerId: 'p2', holeNumber: 1, strokes: 5 },
        { playerId: 'p3', holeNumber: 1, strokes: 5 },
        { playerId: 'p2', holeNumber: 2, strokes: 3 }, // p2 defends hole 2 (index 1 % 3 = 1)
        { playerId: 'p1', holeNumber: 2, strokes: 5 },
        { playerId: 'p3', holeNumber: 2, strokes: 5 },
      ],
    });
    const game = makeGame({
      format: 'defender',
      playerIds: ['p1', 'p2', 'p3'],
      settings: { pointValue: 1 },
    });
    const result = computeDefender(round, game);

    expect(result.holes[0].defenderId).toBe('p1'); // hole 1
    expect(result.holes[1].defenderId).toBe('p2'); // hole 2
    // p1 defended hole 1 (sole low vs p2 & p3) → +2 from challengers
    // p2 defended hole 2 (sole low vs p1 & p3) → +2 from challengers
    expect(result.holes[0].result).toBe('defended');
    expect(result.holes[1].result).toBe('defended');
    // Net across both holes: zero-sum
    const totalSum = Object.values(result.totals).reduce((a, b) => a + b, 0);
    expect(totalSum).toBe(0);
  });

  it('no_score when defender has no score for the hole', () => {
    const round = makeRound({
      players: makePlayers(['p1', 'p2']),
      scores: [{ playerId: 'p2', holeNumber: 1, strokes: 3 }],
    });
    const game = makeGame({
      format: 'defender',
      playerIds: ['p1', 'p2'],
      settings: { defenderPlayerId: 'p1' },
    });
    const result = computeDefender(round, game);
    expect(result.holes[0].result).toBe('no_score');
    expect(result.totals['p1']).toBe(0);
  });

  it('totals are zero-sum across all holes (wager format)', () => {
    // 3 players, 4 holes, various results
    const scores: Score[] = [
      // hole 1: p1 defends (fixed), beats p2 & p3
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 5 },
      { playerId: 'p3', holeNumber: 1, strokes: 5 },
      // hole 2: p1 defends, beaten by p2
      { playerId: 'p1', holeNumber: 2, strokes: 5 },
      { playerId: 'p2', holeNumber: 2, strokes: 3 },
      { playerId: 'p3', holeNumber: 2, strokes: 5 },
    ];
    const round = makeRound({
      players: makePlayers(['p1', 'p2', 'p3']),
      scores,
    });
    const game = makeGame({
      format: 'defender',
      playerIds: ['p1', 'p2', 'p3'],
      settings: { pointValue: 1, defenderPlayerId: 'p1' },
    });
    const result = computeDefender(round, game);
    const totalSum = Object.values(result.totals).reduce((a, b) => a + b, 0);
    expect(totalSum).toBe(0);
  });
});
