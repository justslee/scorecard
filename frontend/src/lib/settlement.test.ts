/**
 * Unit tests for settlement computation (lib/settlement.ts).
 *
 * Covers:
 *  - computeGameNetWinnings per format (skins, wolf, nassau, matchPlay, threePoint)
 *  - zero-sum invariant: sum of all nets == 0
 *  - computeNetSettlement across multiple games
 *  - minimizeTransfers: single game, multi-game, ties, already-settled
 *  - getPersistedSettlement: present / absent
 *  - isEmpty guard
 *
 * DO NOT modify settlement.ts to make these tests pass.
 */

import { describe, it, expect } from 'vitest';
import {
  computeGameNetWinnings,
  computeNetSettlement,
  minimizeTransfers,
  getPersistedSettlement,
} from './settlement';
import type { Round, Game, Score, HoleInfo, Player } from './types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeHoles(pars?: number[]): HoleInfo[] {
  const p = pars ?? Array<number>(18).fill(4);
  return p.map((par, i) => ({ number: i + 1, par }));
}

function makePlayers(ids: string[]): Player[] {
  return ids.map((id) => ({ id, name: id }));
}

function makeRound(overrides: Partial<Round> = {}): Round {
  return {
    id: 'r1',
    courseId: 'c1',
    courseName: 'Test Course',
    date: '2026-01-01',
    players: makePlayers(['p1', 'p2', 'p3', 'p4']),
    scores: [],
    holes: makeHoles(),
    games: [],
    status: 'completed',
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
    playerIds: ['p1', 'p2', 'p3', 'p4'],
    settings: { pointValue: 5 },
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

/** Sum all values in a record — used to check zero-sum invariant. */
function sumNet(net: Record<string, number>): number {
  return Math.round(Object.values(net).reduce((s, v) => s + v, 0) * 100) / 100;
}

// ─── minimizeTransfers ────────────────────────────────────────────────────────

describe('minimizeTransfers', () => {
  it('produces zero transfers for an empty ledger', () => {
    expect(minimizeTransfers({})).toEqual([]);
  });

  it('produces zero transfers when all nets are 0', () => {
    expect(minimizeTransfers({ p1: 0, p2: 0 })).toEqual([]);
  });

  it('resolves a simple 2-player debt with one transfer', () => {
    const transfers = minimizeTransfers({ p1: 10, p2: -10 });
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({ fromPlayerId: 'p2', toPlayerId: 'p1', amount: 10 });
  });

  it('minimizes a 3-player scenario to 2 transfers', () => {
    // p1 owes 15, p2 owes 5, p3 wins 20
    const transfers = minimizeTransfers({ p1: -15, p2: -5, p3: 20 });
    expect(transfers.length).toBeLessThanOrEqual(2);
    // All money flows to p3
    const toP3 = transfers.filter((t) => t.toPlayerId === 'p3');
    const totalToP3 = toP3.reduce((s, t) => s + t.amount, 0);
    expect(Math.round(totalToP3 * 100) / 100).toBe(20);
  });

  it('minimizes a 4-player scenario to at most 3 transfers', () => {
    // p1 wins 12, p2 wins 8, p3 owes 10, p4 owes 10
    const transfers = minimizeTransfers({ p1: 12, p2: 8, p3: -10, p4: -10 });
    expect(transfers.length).toBeLessThanOrEqual(3);
    // Total money out equals total money in
    const totalOut = transfers.reduce((s, t) => s + t.amount, 0);
    expect(Math.round(totalOut * 100) / 100).toBe(20);
  });

  it('handles fractional amounts and rounds to 2 decimal places', () => {
    const transfers = minimizeTransfers({ p1: 3.33, p2: -3.33 });
    expect(transfers[0].amount).toBe(3.33);
  });

  it('ignores dust amounts (< 1 cent)', () => {
    const transfers = minimizeTransfers({ p1: 0.001, p2: -0.001 });
    expect(transfers).toHaveLength(0);
  });
});

// ─── computeGameNetWinnings — Skins ──────────────────────────────────────────

describe('computeGameNetWinnings — skins', () => {
  it('returns empty record when pointValue is 0', () => {
    const round = makeRound();
    const game = makeGame({ settings: { pointValue: 0 } });
    expect(computeGameNetWinnings(round, game)).toEqual({});
  });

  it('zero-sum: sum of all nets is 0', () => {
    // p1 wins hole 1 (3 players all have scores; p1 lowest)
    const scores: Score[] = [
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 4 },
      { playerId: 'p3', holeNumber: 1, strokes: 5 },
      // holes 2–18: all tied (no more skins awarded)
      ...Array.from({ length: 17 }, (_, i) => [
        { playerId: 'p1', holeNumber: i + 2, strokes: 4 },
        { playerId: 'p2', holeNumber: i + 2, strokes: 4 },
        { playerId: 'p3', holeNumber: i + 2, strokes: 4 },
      ]).flat(),
    ];
    const round = makeRound({
      players: makePlayers(['p1', 'p2', 'p3']),
      scores,
    });
    const game = makeGame({ playerIds: ['p1', 'p2', 'p3'], settings: { pointValue: 5 } });
    const net = computeGameNetWinnings(round, game);
    expect(sumNet(net)).toBe(0);
    // p1 wins 1 skin at $5 = +$5; gross p1 = $5, cost = $5/3 ≈ $1.67, net p1 ≈ +$3.33
    expect(net['p1']).toBeGreaterThan(0);
    expect(net['p2']).toBeLessThan(0);
    expect(net['p3']).toBeLessThan(0);
  });

  it('zero-sum: all-tie round (no skins awarded)', () => {
    const scores: Score[] = Array.from({ length: 18 }, (_, i) => [
      { playerId: 'p1', holeNumber: i + 1, strokes: 4 },
      { playerId: 'p2', holeNumber: i + 1, strokes: 4 },
    ]).flat();
    const round = makeRound({
      players: makePlayers(['p1', 'p2']),
      scores,
    });
    const game = makeGame({ playerIds: ['p1', 'p2'], settings: { pointValue: 5 } });
    const net = computeGameNetWinnings(round, game);
    expect(sumNet(net)).toBe(0);
    // No skins awarded, total pot = 0, all nets = 0
    expect(net['p1']).toBe(0);
    expect(net['p2']).toBe(0);
  });
});

// ─── computeGameNetWinnings — Wolf ────────────────────────────────────────────

describe('computeGameNetWinnings — wolf', () => {
  it('zero-sum: wolf points * pointValue', () => {
    // Build a round where wolf has known totals
    const round = makeRound({
      players: makePlayers(['p1', 'p2', 'p3', 'p4']),
      scores: [
        // Hole 1: p1 is wolf; uniform scores — lone wolf: no choice provided
        ...makePlayers(['p1', 'p2', 'p3', 'p4']).map((_, i) => ({
          playerId: ['p1', 'p2', 'p3', 'p4'][i],
          holeNumber: 1,
          strokes: 4,
        })),
      ],
    });
    // With no wolfHoleChoices, wolf gets no points (no lone wolf declared).
    const game = makeGame({
      playerIds: ['p1', 'p2', 'p3', 'p4'],
      format: 'wolf',
      settings: {
        pointValue: 2,
        wolfOrderPlayerIds: ['p1', 'p2', 'p3', 'p4'],
      },
    });
    const net = computeGameNetWinnings(round, game);
    expect(sumNet(net)).toBe(0);
  });
});

// ─── computeGameNetWinnings — Nassau ─────────────────────────────────────────

describe('computeGameNetWinnings — nassau', () => {
  it('zero-sum: 2-player nassau where p1 wins all 3 segments', () => {
    // p1 beats p2 on F9, B9, and overall
    const scores: Score[] = [
      ...uniformScores('p1', 3), // all birdies
      ...uniformScores('p2', 4), // all pars
    ];
    const round = makeRound({
      players: makePlayers(['p1', 'p2']),
      scores,
    });
    const game = makeGame({
      playerIds: ['p1', 'p2'],
      format: 'nassau',
      settings: { pointValue: 10, nassauMode: 'stroke', nassauScope: 'individual' },
    });
    const net = computeGameNetWinnings(round, game);
    expect(sumNet(net)).toBe(0);
    // p1 wins all 3 bets at $10 each vs 1 opponent → +$30
    expect(net['p1']).toBe(30);
    expect(net['p2']).toBe(-30);
  });

  it('zero-sum: push on all segments → no transfers', () => {
    const scores: Score[] = [
      ...uniformScores('p1', 4),
      ...uniformScores('p2', 4),
    ];
    const round = makeRound({
      players: makePlayers(['p1', 'p2']),
      scores,
    });
    const game = makeGame({
      playerIds: ['p1', 'p2'],
      format: 'nassau',
      settings: { pointValue: 10, nassauMode: 'stroke', nassauScope: 'individual' },
    });
    const net = computeGameNetWinnings(round, game);
    expect(sumNet(net)).toBe(0);
    expect(net['p1']).toBe(0);
    expect(net['p2']).toBe(0);
  });
});

// ─── computeGameNetWinnings — matchPlay ──────────────────────────────────────

describe('computeGameNetWinnings — matchPlay', () => {
  it('zero-sum: winner gets +pointValue, loser -pointValue', () => {
    // p1 wins every hole → wins the match
    const scores: Score[] = [
      ...uniformScores('p1', 3),
      ...uniformScores('p2', 4),
    ];
    const round = makeRound({
      players: makePlayers(['p1', 'p2']),
      scores,
    });
    const game = makeGame({
      playerIds: ['p1', 'p2'],
      format: 'matchPlay',
      settings: {
        pointValue: 20,
        matchPlayMode: 'individual',
        matchPlayPlayers: { player1Id: 'p1', player2Id: 'p2' },
      },
    });
    const net = computeGameNetWinnings(round, game);
    expect(sumNet(net)).toBe(0);
    expect(net['p1']).toBe(20);
    expect(net['p2']).toBe(-20);
  });

  it('no transfer when match is all-square (neither player wins)', () => {
    // All holes tied
    const scores: Score[] = [
      ...uniformScores('p1', 4),
      ...uniformScores('p2', 4),
    ];
    const round = makeRound({
      players: makePlayers(['p1', 'p2']),
      scores,
    });
    const game = makeGame({
      playerIds: ['p1', 'p2'],
      format: 'matchPlay',
      settings: {
        pointValue: 20,
        matchPlayMode: 'individual',
        matchPlayPlayers: { player1Id: 'p1', player2Id: 'p2' },
      },
    });
    const net = computeGameNetWinnings(round, game);
    expect(sumNet(net)).toBe(0);
    expect(net['p1']).toBe(0);
    expect(net['p2']).toBe(0);
  });
});

// ─── computeNetSettlement ─────────────────────────────────────────────────────

describe('computeNetSettlement', () => {
  it('isEmpty when round has no games', () => {
    const round = makeRound({ games: [] });
    const ledger = computeNetSettlement(round);
    expect(ledger.isEmpty).toBe(true);
    expect(ledger.transfers).toHaveLength(0);
  });

  it('isEmpty when all games have pointValue 0', () => {
    const round = makeRound({
      games: [makeGame({ settings: { pointValue: 0 } })],
    });
    const ledger = computeNetSettlement(round);
    expect(ledger.isEmpty).toBe(true);
  });

  it('isEmpty skips settlement-format games', () => {
    const round = makeRound({
      games: [
        {
          id: 'sg',
          roundId: 'r1',
          format: 'settlement',
          name: 'Settlement',
          playerIds: [],
          settings: {
            transfers: [{ fromPlayerId: 'p1', toPlayerId: 'p2', amount: 5 }],
            finalizedAt: '2026-01-01T12:00:00Z',
          },
        },
      ],
    });
    const ledger = computeNetSettlement(round);
    expect(ledger.isEmpty).toBe(true);
  });

  it('aggregates multi-game nets and zero-sum invariant holds', () => {
    // Game 1 (skins): p1 wins 1 skin at $5 (3-player)
    // Game 2 (skins): p2 wins 1 skin at $5 (3-player)
    // Both games cancel out somewhat; sum must still be 0
    const skinScores1: Score[] = [
      { playerId: 'p1', holeNumber: 1, strokes: 3 }, // p1 wins hole 1
      { playerId: 'p2', holeNumber: 1, strokes: 4 },
      { playerId: 'p3', holeNumber: 1, strokes: 4 },
      // tie the rest
      ...Array.from({ length: 17 }, (_, i) => [
        { playerId: 'p1', holeNumber: i + 2, strokes: 4 },
        { playerId: 'p2', holeNumber: i + 2, strokes: 4 },
        { playerId: 'p3', holeNumber: i + 2, strokes: 4 },
      ]).flat(),
    ];

    const round = makeRound({
      players: makePlayers(['p1', 'p2', 'p3']),
      scores: skinScores1,
      games: [
        makeGame({ id: 'g1', playerIds: ['p1', 'p2', 'p3'], settings: { pointValue: 5 } }),
        // Second skins game: different betAmount
        makeGame({ id: 'g2', playerIds: ['p1', 'p2', 'p3'], settings: { pointValue: 10 } }),
      ],
    });

    const ledger = computeNetSettlement(round);
    expect(ledger.isEmpty).toBe(false);
    // Zero-sum invariant across all games combined
    expect(sumNet(ledger.netByPlayer)).toBe(0);
  });

  it('transfer minimization: single creditor single debtor', () => {
    // p1 wins $10 from nassau (2-player, 1 segment)
    const scores: Score[] = [
      ...uniformScores('p1', 3),
      ...uniformScores('p2', 4),
    ];
    const round = makeRound({
      players: makePlayers(['p1', 'p2']),
      scores,
      games: [
        makeGame({
          playerIds: ['p1', 'p2'],
          format: 'nassau',
          settings: { pointValue: 10, nassauMode: 'stroke', nassauScope: 'individual' },
        }),
      ],
    });
    const ledger = computeNetSettlement(round);
    expect(ledger.transfers).toHaveLength(1);
    expect(ledger.transfers[0]).toMatchObject({
      fromPlayerId: 'p2',
      toPlayerId: 'p1',
      amount: 30, // 3 segments × $10
    });
  });
});

// ─── getPersistedSettlement ───────────────────────────────────────────────────

describe('getPersistedSettlement', () => {
  it('returns null when no settlement game exists', () => {
    const round = makeRound({ games: [] });
    expect(getPersistedSettlement(round)).toBeNull();
  });

  it('returns null when games array is undefined', () => {
    const round = makeRound();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (round as any).games = undefined;
    expect(getPersistedSettlement(round)).toBeNull();
  });

  it('extracts finalized settlement from settlement game record', () => {
    const transfers = [{ fromPlayerId: 'p2', toPlayerId: 'p1', amount: 30 }];
    const round = makeRound({
      games: [
        {
          id: 'sg',
          roundId: 'r1',
          format: 'settlement',
          name: 'Settlement',
          playerIds: [],
          settings: {
            transfers,
            finalizedAt: '2026-01-01T12:00:00Z',
          },
        },
      ],
    });
    const result = getPersistedSettlement(round);
    expect(result).not.toBeNull();
    expect(result!.transfers).toEqual(transfers);
    expect(result!.finalizedAt).toBe('2026-01-01T12:00:00Z');
  });

  it('returns null when settlement game has malformed settings', () => {
    const round = makeRound({
      games: [
        {
          id: 'sg',
          roundId: 'r1',
          format: 'settlement',
          name: 'Settlement',
          playerIds: [],
          settings: { someOtherKey: true }, // missing transfers/finalizedAt
        },
      ],
    });
    expect(getPersistedSettlement(round)).toBeNull();
  });
});
