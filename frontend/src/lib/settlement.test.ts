/**
 * Unit tests for settlement computation (lib/settlement.ts).
 *
 * Covers:
 *  - computeGameNetWinnings per format (skins, nassau, matchPlay, threePoint,
 *    vegas, hammer, rabbit, defender) — wolf is points-only (not settleable,
 *    see the "wolf settles honestly empty" describe block below)
 *  - zero-sum invariant: sum of all nets == 0
 *  - computeNetSettlement across multiple games (including mixed skins + vegas)
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
  computeTournamentSettlement,
  minimizeTransfers,
  getPersistedSettlement,
  hasMoneyGames,
  SETTLEABLE_FORMATS,
} from './settlement';
import { buildRoundGames } from './round-games';
import type { GameId } from './round-games';
import type { Round, Game, GameFormat, Score, HoleInfo, Player } from './types';

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

// ─── computeGameNetWinnings — non-settleable formats (stake-mirage fix) ──────
// tournament-settlement-honesty-plan.md §1 Bug 1 / §5: a format outside
// SETTLEABLE_FORMATS must settle $0 HONESTLY — an empty record, not an
// all-zeros ledger that LOOKS like a real (if uneventful) settlement.

describe('computeGameNetWinnings — non-settleable formats settle honestly empty', () => {
  it('stableford with pointValue: 5 on a fully-scored round returns {} (not an all-zeros record)', () => {
    const scores: Score[] = [
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 5 },
    ];
    const round = makeRound({
      players: makePlayers(['p1', 'p2']),
      scores,
      games: [
        makeGame({
          format: 'stableford',
          playerIds: ['p1', 'p2'],
          settings: { pointValue: 5 },
        }),
      ],
    });
    const game = round.games![0];
    expect(computeGameNetWinnings(round, game)).toEqual({});
  });

  it('a stableford-only round is isEmpty and reports no money games — the round-level dishonesty fix', () => {
    const scores: Score[] = [
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 5 },
    ];
    const round = makeRound({
      players: makePlayers(['p1', 'p2']),
      scores,
      games: [
        makeGame({
          format: 'stableford',
          playerIds: ['p1', 'p2'],
          settings: { pointValue: 5 },
        }),
      ],
    });
    expect(computeNetSettlement(round).isEmpty).toBe(true);
    expect(hasMoneyGames([round])).toBe(false);
  });
});

// ─── computeGameNetWinnings — Wolf (points-only; NOT in SETTLEABLE_FORMATS) ──
// Adversarial review found computeWolf is NOT zero-sum: lone mode credits only
// the wolf player (±pointValue) and debits no one; partner mode credits only
// the winning pair and debits no one. A single lone-wolf win with
// pointValue:2 used to return {p1:6} — money invented from nothing. Wolf is
// points-only now (tournament-settlement-honesty-plan.md follow-up); it must
// settle honestly EMPTY, exactly like stableford, never an invented ledger.

describe('computeGameNetWinnings — wolf settles honestly empty (points-only, no longer a money format)', () => {
  it('a decided lone-wolf win with pointValue set returns {} (not the old fabricated ±pointValue record)', () => {
    const round = makeRound({
      players: makePlayers(['p1', 'p2', 'p3', 'p4']),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 }, // wolf beats the field
        { playerId: 'p2', holeNumber: 1, strokes: 5 },
        { playerId: 'p3', holeNumber: 1, strokes: 5 },
        { playerId: 'p4', holeNumber: 1, strokes: 5 },
      ],
    });
    const game = makeGame({
      playerIds: ['p1', 'p2', 'p3', 'p4'],
      format: 'wolf',
      settings: {
        pointValue: 2,
        wolfOrderPlayerIds: ['p1', 'p2', 'p3', 'p4'],
        wolfHoleChoices: { 1: { mode: 'lone' } },
      },
    });
    expect(computeGameNetWinnings(round, game)).toEqual({});
  });

  it('a wolf-only round is isEmpty and reports no money games', () => {
    const round = makeRound({
      players: makePlayers(['p1', 'p2', 'p3', 'p4']),
      scores: [
        { playerId: 'p1', holeNumber: 1, strokes: 3 },
        { playerId: 'p2', holeNumber: 1, strokes: 5 },
        { playerId: 'p3', holeNumber: 1, strokes: 5 },
        { playerId: 'p4', holeNumber: 1, strokes: 5 },
      ],
      games: [
        makeGame({
          playerIds: ['p1', 'p2', 'p3', 'p4'],
          format: 'wolf',
          settings: {
            pointValue: 2,
            wolfOrderPlayerIds: ['p1', 'p2', 'p3', 'p4'],
            wolfHoleChoices: { 1: { mode: 'lone' } },
          },
        }),
      ],
    });
    expect(computeNetSettlement(round).isEmpty).toBe(true);
    expect(hasMoneyGames([round])).toBe(false);
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

// ─── computeGameNetWinnings — threePoint ─────────────────────────────────────
// SETTLEABLE_FORMATS member with no prior describe block (plan §5 flagged the
// gap explicitly — settlement.ts:157-174 has a real branch for it).

describe('computeGameNetWinnings — threePoint', () => {
  it('zero-sum: team A sweeps hole 1 (3-0) → point diff moves pointValue between teams, split per player', () => {
    // Mirrors games.test.ts computeThreePoint "sweeps all matchups" case:
    // a1=3 beats b1=4, a2=3 beats b2=4, best-ball 3 beats 4 → totals tA=3, tB=0.
    // diff = 3, pointValue = 10 → teamANet = +30, split 2-per-team → +15/-15.
    const playerIds = ['p1', 'p2', 'p3', 'p4'];
    const scores: Score[] = [
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 3 },
      { playerId: 'p3', holeNumber: 1, strokes: 4 },
      { playerId: 'p4', holeNumber: 1, strokes: 4 },
    ];
    const round = makeRound({ players: makePlayers(playerIds), scores });
    const game: Game = {
      id: 'g1',
      roundId: 'r1',
      format: 'threePoint',
      name: 'Three-Point',
      playerIds,
      teams: [
        { id: 'tA', name: 'Team A', playerIds: ['p1', 'p2'] },
        { id: 'tB', name: 'Team B', playerIds: ['p3', 'p4'] },
      ],
      settings: {
        pointValue: 10,
        threePointPairs: {
          teamAPlayer1Id: 'p1',
          teamAPlayer2Id: 'p2',
          teamBPlayer1Id: 'p3',
          teamBPlayer2Id: 'p4',
        },
      },
    };
    const net = computeGameNetWinnings(round, game);
    expect(sumNet(net)).toBe(0);
    expect(net['p1']).toBe(15);
    expect(net['p2']).toBe(15);
    expect(net['p3']).toBe(-15);
    expect(net['p4']).toBe(-15);
  });

  it('zero-sum: every matchup ties (1.5-1.5) → no team differential, no money moves', () => {
    const playerIds = ['p1', 'p2', 'p3', 'p4'];
    const scores: Score[] = [
      { playerId: 'p1', holeNumber: 1, strokes: 4 },
      { playerId: 'p2', holeNumber: 1, strokes: 4 },
      { playerId: 'p3', holeNumber: 1, strokes: 4 },
      { playerId: 'p4', holeNumber: 1, strokes: 4 },
    ];
    const round = makeRound({ players: makePlayers(playerIds), scores });
    const game: Game = {
      id: 'g1',
      roundId: 'r1',
      format: 'threePoint',
      name: 'Three-Point',
      playerIds,
      teams: [
        { id: 'tA', name: 'Team A', playerIds: ['p1', 'p2'] },
        { id: 'tB', name: 'Team B', playerIds: ['p3', 'p4'] },
      ],
      settings: {
        pointValue: 10,
        threePointPairs: {
          teamAPlayer1Id: 'p1',
          teamAPlayer2Id: 'p2',
          teamBPlayer1Id: 'p3',
          teamBPlayer2Id: 'p4',
        },
      },
    };
    const net = computeGameNetWinnings(round, game);
    expect(sumNet(net)).toBe(0);
    expect(net['p1']).toBe(0);
    expect(net['p2']).toBe(0);
    expect(net['p3']).toBe(0);
    expect(net['p4']).toBe(0);
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

// ─── computeGameNetWinnings — Vegas ──────────────────────────────────────────

describe('computeGameNetWinnings — vegas', () => {
  it('zero-sum: team winner distributes dollarized net equally among team players', () => {
    // Hole 1: teamA=[p1=3,p2=5]→35, teamB=[p3=4,p4=5]→45  diff=10, teamA wins
    // pointValue=1 → teamA total +10, teamB total -10
    // 2 players per team → p1:+5, p2:+5, p3:-5, p4:-5
    const scores = [
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 5 },
      { playerId: 'p3', holeNumber: 1, strokes: 4 },
      { playerId: 'p4', holeNumber: 1, strokes: 5 },
    ];
    const round = makeRound({
      players: makePlayers(['p1', 'p2', 'p3', 'p4']),
      scores,
    });
    const game: Game = {
      id: 'g1',
      roundId: 'r1',
      format: 'vegas',
      name: 'Vegas',
      playerIds: ['p1', 'p2', 'p3', 'p4'],
      teams: [
        { id: 'tA', name: 'Team A', playerIds: ['p1', 'p2'] },
        { id: 'tB', name: 'Team B', playerIds: ['p3', 'p4'] },
      ],
      settings: { pointValue: 1 },
    };
    const net = computeGameNetWinnings(round, game);
    expect(sumNet(net)).toBe(0);
    expect(net['p1']).toBe(5);
    expect(net['p2']).toBe(5);
    expect(net['p3']).toBe(-5);
    expect(net['p4']).toBe(-5);
  });

  it('zero-sum: all holes push → all players net $0', () => {
    // Both teams produce the same vegas number on every hole
    const scores = Array.from({ length: 18 }, (_, i) => [
      { playerId: 'p1', holeNumber: i + 1, strokes: 4 },
      { playerId: 'p2', holeNumber: i + 1, strokes: 5 },
      { playerId: 'p3', holeNumber: i + 1, strokes: 4 },
      { playerId: 'p4', holeNumber: i + 1, strokes: 5 },
    ]).flat();
    const round = makeRound({
      players: makePlayers(['p1', 'p2', 'p3', 'p4']),
      scores,
    });
    const game: Game = {
      id: 'g1',
      roundId: 'r1',
      format: 'vegas',
      name: 'Vegas',
      playerIds: ['p1', 'p2', 'p3', 'p4'],
      teams: [
        { id: 'tA', name: 'Team A', playerIds: ['p1', 'p2'] },
        { id: 'tB', name: 'Team B', playerIds: ['p3', 'p4'] },
      ],
      settings: { pointValue: 5 },
    };
    const net = computeGameNetWinnings(round, game);
    expect(sumNet(net)).toBe(0);
    expect(net['p1']).toBe(0);
    expect(net['p2']).toBe(0);
    expect(net['p3']).toBe(0);
    expect(net['p4']).toBe(0);
  });
});

// ─── computeGameNetWinnings — Hammer ─────────────────────────────────────────

describe('computeGameNetWinnings — hammer', () => {
  it('zero-sum: winner collects from each loser; totals already dollarized', () => {
    // Hole 1: p1=3 (wins), p2=4, p3=5 (both lose). multiplier=1, pointValue=5.
    // computeHammer: p1 +5 per loser → +10; p2 -5; p3 -5. Net sum = 0.
    // Settlement must NOT re-multiply by pointValue (totals already in $).
    const scores = [
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 4 },
      { playerId: 'p3', holeNumber: 1, strokes: 5 },
    ];
    const round = makeRound({
      players: makePlayers(['p1', 'p2', 'p3']),
      scores,
    });
    const game = makeGame({
      playerIds: ['p1', 'p2', 'p3'],
      format: 'hammer',
      settings: { pointValue: 5 },
    });
    const net = computeGameNetWinnings(round, game);
    expect(sumNet(net)).toBe(0);
    expect(net['p1']).toBe(10);  // +5 from p2 + +5 from p3
    expect(net['p2']).toBe(-5);
    expect(net['p3']).toBe(-5);
  });

  it('zero-sum: all-tie hole → no money moves', () => {
    const scores = [
      { playerId: 'p1', holeNumber: 1, strokes: 4 },
      { playerId: 'p2', holeNumber: 1, strokes: 4 },
    ];
    const round = makeRound({
      players: makePlayers(['p1', 'p2']),
      scores,
    });
    const game = makeGame({
      playerIds: ['p1', 'p2'],
      format: 'hammer',
      settings: { pointValue: 10 },
    });
    const net = computeGameNetWinnings(round, game);
    expect(sumNet(net)).toBe(0);
    expect(net['p1']).toBe(0);
    expect(net['p2']).toBe(0);
  });

  it('zero-sum: multiplier doubles the wager per hole', () => {
    // Hole 1 has multiplier=2. p1=3 wins vs p2=5. points=2*3=$6.
    const scores = [
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 5 },
    ];
    const round = makeRound({
      players: makePlayers(['p1', 'p2']),
      scores,
    });
    const game = makeGame({
      playerIds: ['p1', 'p2'],
      format: 'hammer',
      settings: { pointValue: 3, hammerMultiplierByHole: { 1: 2 } },
    });
    const net = computeGameNetWinnings(round, game);
    expect(sumNet(net)).toBe(0);
    expect(net['p1']).toBe(6);   // multiplier(2) × pointValue(3) = 6
    expect(net['p2']).toBe(-6);
  });
});

// ─── computeGameNetWinnings — Rabbit ─────────────────────────────────────────

describe('computeGameNetWinnings — rabbit', () => {
  it('zero-sum: front9 and back9 holders each win pointValue from other players', () => {
    // p1 wins hole 1 outright → captures rabbit; holes 2-9 all tied → p1 holds F9.
    // p2 wins hole 10 outright → captures rabbit; holes 11-18 all tied → p2 holds B9.
    // N=3, pointValue=10.
    // F9: p1 +10*(3-1)=+20, p2 -10, p3 -10.
    // B9: p2 +10*(3-1)=+20, p1 -10, p3 -10.
    // Net: p1 +10, p2 +10, p3 -20. Sum=0.
    const scores: Score[] = [
      // p1 wins hole 1 outright
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 4 },
      { playerId: 'p3', holeNumber: 1, strokes: 4 },
      // holes 2-9: all tied at par
      ...Array.from({ length: 8 }, (_, i) => [
        { playerId: 'p1', holeNumber: i + 2, strokes: 4 },
        { playerId: 'p2', holeNumber: i + 2, strokes: 4 },
        { playerId: 'p3', holeNumber: i + 2, strokes: 4 },
      ]).flat(),
      // p2 wins hole 10 outright
      { playerId: 'p1', holeNumber: 10, strokes: 4 },
      { playerId: 'p2', holeNumber: 10, strokes: 3 },
      { playerId: 'p3', holeNumber: 10, strokes: 4 },
      // holes 11-18: all tied at par
      ...Array.from({ length: 8 }, (_, i) => [
        { playerId: 'p1', holeNumber: i + 11, strokes: 4 },
        { playerId: 'p2', holeNumber: i + 11, strokes: 4 },
        { playerId: 'p3', holeNumber: i + 11, strokes: 4 },
      ]).flat(),
    ];
    const round = makeRound({
      players: makePlayers(['p1', 'p2', 'p3']),
      scores,
    });
    const game = makeGame({
      playerIds: ['p1', 'p2', 'p3'],
      format: 'rabbit',
      settings: { pointValue: 10 },
    });
    const net = computeGameNetWinnings(round, game);
    expect(sumNet(net)).toBe(0);
    expect(net['p1']).toBe(10);   // +20 (F9 win) - 10 (B9 loss)
    expect(net['p2']).toBe(10);   // -10 (F9 loss) + 20 (B9 win)
    expect(net['p3']).toBe(-20);  // -10 (F9) - 10 (B9)
  });

  it('zero-sum: no rabbit holder → no money moves', () => {
    // All holes tied → rabbit never captured.
    const scores = Array.from({ length: 18 }, (_, i) => [
      { playerId: 'p1', holeNumber: i + 1, strokes: 4 },
      { playerId: 'p2', holeNumber: i + 1, strokes: 4 },
    ]).flat();
    const round = makeRound({
      players: makePlayers(['p1', 'p2']),
      scores,
    });
    const game = makeGame({
      playerIds: ['p1', 'p2'],
      format: 'rabbit',
      settings: { pointValue: 10 },
    });
    const net = computeGameNetWinnings(round, game);
    expect(sumNet(net)).toBe(0);
    expect(net['p1']).toBe(0);
    expect(net['p2']).toBe(0);
  });
});

// ─── computeGameNetWinnings — Defender ───────────────────────────────────────

describe('computeGameNetWinnings — defender', () => {
  it('zero-sum: defender wins sole-low → collects from each scored challenger', () => {
    // Hole 1: defender=p1 (idx 0), scores p1=3, p2=4, p3=5. p1 is sole low.
    // computeDefender: delta=5*2=10; p1:+10, p2:-5, p3:-5. Net sum=0.
    // Settlement must NOT re-multiply by pointValue (totals already in $).
    const scores = [
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 4 },
      { playerId: 'p3', holeNumber: 1, strokes: 5 },
    ];
    const round = makeRound({
      players: makePlayers(['p1', 'p2', 'p3']),
      scores,
    });
    const game = makeGame({
      playerIds: ['p1', 'p2', 'p3'],
      format: 'defender',
      settings: { pointValue: 5 },
    });
    const net = computeGameNetWinnings(round, game);
    expect(sumNet(net)).toBe(0);
    expect(net['p1']).toBe(10);  // earned from 2 challengers at $5 each
    expect(net['p2']).toBe(-5);
    expect(net['p3']).toBe(-5);
  });

  it('zero-sum: defender beaten → each beater earns pointValue from defender', () => {
    // Hole 1: defender=p1, p2 and p3 both score lower than p1.
    // Each beater earns pointValue from defender. computeDefender: p1:-10, p2:+5, p3:+5.
    const scores = [
      { playerId: 'p1', holeNumber: 1, strokes: 5 },
      { playerId: 'p2', holeNumber: 1, strokes: 3 },
      { playerId: 'p3', holeNumber: 1, strokes: 4 },
    ];
    const round = makeRound({
      players: makePlayers(['p1', 'p2', 'p3']),
      scores,
    });
    const game = makeGame({
      playerIds: ['p1', 'p2', 'p3'],
      format: 'defender',
      settings: { pointValue: 5 },
    });
    const net = computeGameNetWinnings(round, game);
    expect(sumNet(net)).toBe(0);
    expect(net['p1']).toBe(-10);  // paid $5 to each of 2 beaters
    expect(net['p2']).toBe(5);
    expect(net['p3']).toBe(5);
  });
});

// ─── computeNetSettlement — mixed-format round ────────────────────────────────

describe('computeNetSettlement — mixed skins + vegas', () => {
  it('zero-sum invariant holds across a skins game and a vegas game combined', () => {
    // 4 players: p1, p2, p3, p4.
    // Skins game (pointValue=4): p1 wins hole 1 outright vs p2/p3/p4 (all par).
    //   1 skin at $4, total pot=$4, cost=$1 each.
    //   p1: +3, p2: -1, p3: -1, p4: -1.
    // Vegas game (pointValue=1, teamA=[p1,p2], teamB=[p3,p4]):
    //   Hole 1: p1=3,p2=5 → teamANum=35; p3=4,p4=5 → teamBNum=45. diff=10, teamA wins.
    //   teamA total +10, teamB total -10.
    //   p1: +5, p2: +5, p3: -5, p4: -5.
    // Combined: p1:+8, p2:+4, p3:-6, p4:-6. Sum=0.
    const scores: Score[] = [
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 5 },
      { playerId: 'p3', holeNumber: 1, strokes: 4 },
      { playerId: 'p4', holeNumber: 1, strokes: 5 },
      // holes 2-18: all tied so no more skins
      ...Array.from({ length: 17 }, (_, i) => [
        { playerId: 'p1', holeNumber: i + 2, strokes: 4 },
        { playerId: 'p2', holeNumber: i + 2, strokes: 4 },
        { playerId: 'p3', holeNumber: i + 2, strokes: 4 },
        { playerId: 'p4', holeNumber: i + 2, strokes: 4 },
      ]).flat(),
    ];
    const round = makeRound({
      players: makePlayers(['p1', 'p2', 'p3', 'p4']),
      scores,
      games: [
        makeGame({
          id: 'g-skins',
          format: 'skins',
          playerIds: ['p1', 'p2', 'p3', 'p4'],
          settings: { pointValue: 4 },
        }),
        {
          id: 'g-vegas',
          roundId: 'r1',
          format: 'vegas',
          name: 'Vegas',
          playerIds: ['p1', 'p2', 'p3', 'p4'],
          teams: [
            { id: 'tA', name: 'Team A', playerIds: ['p1', 'p2'] },
            { id: 'tB', name: 'Team B', playerIds: ['p3', 'p4'] },
          ],
          settings: { pointValue: 1 },
        },
      ],
    });

    const ledger = computeNetSettlement(round);
    expect(ledger.isEmpty).toBe(false);
    // Zero-sum invariant across both games combined
    expect(sumNet(ledger.netByPlayer)).toBe(0);
    // Verify individual nets
    expect(ledger.netByPlayer['p1']).toBe(8);   // skins(+3) + vegas(+5)
    expect(ledger.netByPlayer['p2']).toBe(4);   // skins(-1) + vegas(+5)
    expect(ledger.netByPlayer['p3']).toBe(-6);  // skins(-1) + vegas(-5)
    expect(ledger.netByPlayer['p4']).toBe(-6);  // skins(-1) + vegas(-5)
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

// ─── computeTournamentSettlement ───────────────────────────────────────────────

/**
 * Build a single-round matchPlay round (p1 vs p2) where `winnerId` wins
 * every hole, so the loser pays `pointValue` to the winner for that round.
 */
function matchPlayRound(id: string, pointValue: number, winnerId: 'p1' | 'p2'): Round {
  const loserId = winnerId === 'p1' ? 'p2' : 'p1';
  const scores: Score[] = [...uniformScores(winnerId, 3), ...uniformScores(loserId, 4)];
  return makeRound({
    id,
    players: makePlayers(['p1', 'p2']),
    scores,
    games: [
      makeGame({
        id: `${id}-g`,
        roundId: id,
        playerIds: ['p1', 'p2'],
        format: 'matchPlay',
        settings: {
          pointValue,
          matchPlayMode: 'individual',
          matchPlayPlayers: { player1Id: 'p1', player2Id: 'p2' },
        },
      }),
    ],
  });
}

describe('computeTournamentSettlement', () => {
  it('sums cumulative net across rounds where it differs from any single round, and minimizes ONCE (not per-round)', () => {
    // Round 1: p1 wins $10; Round 2: p1 wins $15 → cumulative p1:+25, p2:-25.
    // Any single round (10 or 15) differs from the true cumulative (25).
    const rounds = [matchPlayRound('r1', 10, 'p1'), matchPlayRound('r2', 15, 'p1')];

    const ledger = computeTournamentSettlement(rounds);

    expect(ledger.isEmpty).toBe(false);
    expect(ledger.netByPlayer['p1']).toBe(25);
    expect(ledger.netByPlayer['p2']).toBe(-25);

    // Sum-then-minimize-once → exactly ONE transfer of $25.
    // Minimize-per-round-then-concat would wrongly produce TWO transfers
    // (p2→p1 $10 and p2→p1 $15).
    expect(ledger.transfers).toHaveLength(1);
    expect(ledger.transfers[0]).toMatchObject({
      fromPlayerId: 'p2',
      toPlayerId: 'p1',
      amount: 25,
    });
  });

  it('cancels opposing per-round debts to fewer transfers than minimize-per-round-then-concat', () => {
    // Round 1: p2 wins $10 (p1 owes p2). Round 2: p1 wins $10 (p2 owes p1).
    // Cumulative net is exactly zero for both players.
    const rounds = [matchPlayRound('r1', 10, 'p2'), matchPlayRound('r2', 10, 'p1')];

    const ledger = computeTournamentSettlement(rounds);

    expect(ledger.netByPlayer['p1']).toBe(0);
    expect(ledger.netByPlayer['p2']).toBe(0);

    // Sum-then-minimize-once → ZERO transfers needed.
    // Minimize-per-round-then-concat would wrongly produce TWO transfers
    // (p1→p2 $10 in round 1, p2→p1 $10 in round 2) even though nothing is owed.
    expect(ledger.transfers).toEqual([]);
  });

  it('is empty when no round has money results (game-less, zero pointValue, or unscored)', () => {
    const gameLessRound = makeRound({ id: 'r1', games: [] });
    const zeroPointValueRound = makeRound({
      id: 'r2',
      games: [makeGame({ id: 'g2', roundId: 'r2', settings: { pointValue: 0 } })],
    });
    const unscoredRound = makeRound({
      id: 'r3',
      scores: [],
      games: [makeGame({ id: 'g3', roundId: 'r3', format: 'skins', settings: { pointValue: 5 } })],
    });

    const ledger = computeTournamentSettlement([
      gameLessRound,
      zeroPointValueRound,
      unscoredRound,
    ]);

    expect(ledger.isEmpty).toBe(true);
    expect(ledger.transfers).toEqual([]);
  });

  it('preserves the zero-sum invariant on the cumulative net across multiple rounds and formats', () => {
    const rounds = [
      matchPlayRound('r1', 12, 'p1'),
      matchPlayRound('r2', 7, 'p2'),
      matchPlayRound('r3', 3, 'p1'),
    ];

    const ledger = computeTournamentSettlement(rounds);

    expect(sumNet(ledger.netByPlayer)).toBe(0);
  });

  it('returns isEmpty=true and no transfers for an empty rounds array', () => {
    const ledger = computeTournamentSettlement([]);

    expect(ledger.isEmpty).toBe(true);
    expect(ledger.transfers).toEqual([]);
    expect(ledger.netByPlayer).toEqual({});
  });
});

// ─── hasMoneyGames ──────────────────────────────────────────────────────────────

describe('hasMoneyGames', () => {
  it('is true when a round has a money game (pointValue > 0)', () => {
    const round = makeRound({
      games: [makeGame({ format: 'skins', settings: { pointValue: 5 } })],
    });

    expect(hasMoneyGames([round])).toBe(true);
  });

  it('is false when the round has only a non-money game (pointValue 0 / unset, e.g. bestBall)', () => {
    const zeroPointValue = makeRound({
      id: 'r1',
      games: [makeGame({ id: 'g1', format: 'bestBall', settings: { pointValue: 0 } })],
    });
    const unsetPointValue = makeRound({
      id: 'r2',
      games: [makeGame({ id: 'g2', format: 'bestBall', settings: {} })],
    });

    expect(hasMoneyGames([zeroPointValue])).toBe(false);
    expect(hasMoneyGames([unsetPointValue])).toBe(false);
  });

  it('is false for an empty rounds array', () => {
    expect(hasMoneyGames([])).toBe(false);
  });

  it('does not count a "settlement"-format game as a money game', () => {
    const round = makeRound({
      games: [
        makeGame({
          format: 'settlement',
          settings: { pointValue: 5, transfers: [], finalizedAt: '2026-01-01T00:00:00Z' },
        }),
      ],
    });

    expect(hasMoneyGames([round])).toBe(false);
  });

  it('is true when rounds are mixed — one money round and one non-money round', () => {
    const moneyRound = makeRound({
      id: 'r1',
      games: [makeGame({ id: 'g1', format: 'skins', settings: { pointValue: 5 } })],
    });
    const nonMoneyRound = makeRound({
      id: 'r2',
      games: [makeGame({ id: 'g2', format: 'bestBall', settings: { pointValue: 0 } })],
    });

    expect(hasMoneyGames([moneyRound, nonMoneyRound])).toBe(true);
  });
});

// ─── SETTLEABLE_FORMATS property test — zero-sum insurance ───────────────────
// tournament-settlement-honesty-plan.md BLOCKING #1b (adversarial reviewer):
// the wolf bug slipped past review because its "displayed==settled" test was
// hand-engineered around a balanced win+loss pair, making sumNet == 0 by
// construction rather than by proof. This test iterates the exhaustive
// SETTLEABLE_FORMATS source of truth with a REAL decided round per format
// (never a hand-balanced pair) so a future non-zero-sum format can never be
// silently certified — a missing fixture for a set member fails loudly.

const SETTLEABLE_FORMAT_FIXTURES: Partial<
  Record<GameFormat, () => { round: Round; game: Game }>
> = {
  skins: () => {
    const playerIds = ['p1', 'p2', 'p3'];
    const scores: Score[] = [
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 5 },
      { playerId: 'p3', holeNumber: 1, strokes: 5 },
      ...Array.from({ length: 17 }, (_, i) => [
        { playerId: 'p1', holeNumber: i + 2, strokes: 4 },
        { playerId: 'p2', holeNumber: i + 2, strokes: 4 },
        { playerId: 'p3', holeNumber: i + 2, strokes: 4 },
      ]).flat(),
    ];
    const round = makeRound({ players: makePlayers(playerIds), scores });
    const game = makeGame({ playerIds, format: 'skins', settings: { pointValue: 5 } });
    return { round, game };
  },
  nassau: () => {
    const playerIds = ['p1', 'p2'];
    const scores: Score[] = [...uniformScores('p1', 3), ...uniformScores('p2', 5)];
    const round = makeRound({ players: makePlayers(playerIds), scores });
    const game = makeGame({
      playerIds,
      format: 'nassau',
      settings: { pointValue: 10, nassauMode: 'stroke', nassauScope: 'individual' },
    });
    return { round, game };
  },
  matchPlay: () => {
    const playerIds = ['p1', 'p2'];
    const scores: Score[] = [...uniformScores('p1', 3), ...uniformScores('p2', 5)];
    const round = makeRound({ players: makePlayers(playerIds), scores });
    const game = makeGame({
      playerIds,
      format: 'matchPlay',
      settings: {
        pointValue: 20,
        matchPlayMode: 'individual',
        matchPlayPlayers: { player1Id: 'p1', player2Id: 'p2' },
      },
    });
    return { round, game };
  },
  threePoint: () => {
    const playerIds = ['p1', 'p2', 'p3', 'p4'];
    const scores: Score[] = [
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 3 },
      { playerId: 'p3', holeNumber: 1, strokes: 4 },
      { playerId: 'p4', holeNumber: 1, strokes: 4 },
    ];
    const round = makeRound({ players: makePlayers(playerIds), scores });
    const game: Game = {
      id: 'g1',
      roundId: 'r1',
      format: 'threePoint',
      name: 'Three-Point',
      playerIds,
      teams: [
        { id: 'tA', name: 'Team A', playerIds: ['p1', 'p2'] },
        { id: 'tB', name: 'Team B', playerIds: ['p3', 'p4'] },
      ],
      settings: {
        pointValue: 10,
        threePointPairs: {
          teamAPlayer1Id: 'p1',
          teamAPlayer2Id: 'p2',
          teamBPlayer1Id: 'p3',
          teamBPlayer2Id: 'p4',
        },
      },
    };
    return { round, game };
  },
  vegas: () => {
    const playerIds = ['p1', 'p2', 'p3', 'p4'];
    const scores: Score[] = [
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 5 },
      { playerId: 'p3', holeNumber: 1, strokes: 4 },
      { playerId: 'p4', holeNumber: 1, strokes: 5 },
    ];
    const round = makeRound({ players: makePlayers(playerIds), scores });
    const game: Game = {
      id: 'g1',
      roundId: 'r1',
      format: 'vegas',
      name: 'Vegas',
      playerIds,
      teams: [
        { id: 'tA', name: 'Team A', playerIds: ['p1', 'p2'] },
        { id: 'tB', name: 'Team B', playerIds: ['p3', 'p4'] },
      ],
      settings: { pointValue: 1 },
    };
    return { round, game };
  },
  hammer: () => {
    const playerIds = ['p1', 'p2', 'p3'];
    const scores: Score[] = [
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 4 },
      { playerId: 'p3', holeNumber: 1, strokes: 5 },
    ];
    const round = makeRound({ players: makePlayers(playerIds), scores });
    const game = makeGame({ playerIds, format: 'hammer', settings: { pointValue: 5 } });
    return { round, game };
  },
  rabbit: () => {
    const playerIds = ['p1', 'p2', 'p3'];
    const scores: Score[] = [
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 4 },
      { playerId: 'p3', holeNumber: 1, strokes: 4 },
      ...Array.from({ length: 8 }, (_, i) => [
        { playerId: 'p1', holeNumber: i + 2, strokes: 4 },
        { playerId: 'p2', holeNumber: i + 2, strokes: 4 },
        { playerId: 'p3', holeNumber: i + 2, strokes: 4 },
      ]).flat(),
      { playerId: 'p1', holeNumber: 10, strokes: 4 },
      { playerId: 'p2', holeNumber: 10, strokes: 3 },
      { playerId: 'p3', holeNumber: 10, strokes: 4 },
      ...Array.from({ length: 8 }, (_, i) => [
        { playerId: 'p1', holeNumber: i + 11, strokes: 4 },
        { playerId: 'p2', holeNumber: i + 11, strokes: 4 },
        { playerId: 'p3', holeNumber: i + 11, strokes: 4 },
      ]).flat(),
    ];
    const round = makeRound({ players: makePlayers(playerIds), scores });
    const game = makeGame({ playerIds, format: 'rabbit', settings: { pointValue: 10 } });
    return { round, game };
  },
  defender: () => {
    const playerIds = ['p1', 'p2', 'p3'];
    const scores: Score[] = [
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 4 },
      { playerId: 'p3', holeNumber: 1, strokes: 5 },
    ];
    const round = makeRound({ players: makePlayers(playerIds), scores });
    const game = makeGame({ playerIds, format: 'defender', settings: { pointValue: 5 } });
    return { round, game };
  },
};

describe('SETTLEABLE_FORMATS property test — every member is zero-sum on a real decided round', () => {
  for (const format of SETTLEABLE_FORMATS) {
    it(`${format}: sum(computeGameNetWinnings) === 0 on a decided multi-hole round (not a hand-balanced pair)`, () => {
      const fixture = SETTLEABLE_FORMAT_FIXTURES[format];
      expect(
        fixture,
        `no zero-sum fixture registered for SETTLEABLE_FORMATS member "${format}" — add one, don't skip it`
      ).toBeDefined();
      const { round, game } = fixture!();
      const net = computeGameNetWinnings(round, game);
      // A decided round must produce a real ledger, not an accidental no-op —
      // an empty record here would make the zero-sum assertion vacuous.
      expect(Object.keys(net).length).toBeGreaterThan(0);
      expect(sumNet(net)).toBe(0);
    });
  }
});

// ─── Displayed == settled ─────────────────────────────────────────────────────
// tournament-settlement-honesty-plan.md §5: every STAKE_GAME_IDS id, built by
// the SAME `buildRoundGames` the picker uses, with pointValue > 0 and a
// decided score, must yield a non-empty zero-sum net — the stake the golfer
// saw in the picker is the stake that actually settles.

describe('Displayed == settled — buildRoundGames output settles for every STAKE_GAME_IDS member', () => {
  it('skins: builder-produced game with pointValue > 0 and a decided hole → non-empty, zero-sum net', () => {
    const playerIds = ['p1', 'p2', 'p3'];
    const scores: Score[] = [
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 5 },
      { playerId: 'p3', holeNumber: 1, strokes: 5 },
    ];
    const round = makeRound({ players: makePlayers(playerIds), scores });
    const [game] = buildRoundGames([{ id: 'skins' as GameId, stake: '$5' }], playerIds);
    round.games = [game];

    const net = computeGameNetWinnings(round, game);
    expect(Object.keys(net).length).toBeGreaterThan(0);
    expect(sumNet(net)).toBe(0);
    expect(net['p1']).toBeGreaterThan(0);
  });

  it('nassau: builder-produced game with pointValue > 0 and a decided round → non-empty, zero-sum net', () => {
    const playerIds = ['p1', 'p2'];
    const scores: Score[] = [...uniformScores('p1', 3), ...uniformScores('p2', 5)];
    const round = makeRound({ players: makePlayers(playerIds), scores });
    const [game] = buildRoundGames([{ id: 'nassau' as GameId, stake: '$20' }], playerIds);
    round.games = [game];

    const net = computeGameNetWinnings(round, game);
    expect(Object.keys(net).length).toBeGreaterThan(0);
    expect(sumNet(net)).toBe(0);
    expect(net['p1']).toBeGreaterThan(0);
  });

  it('match: builder-produced game (2-player roster) with pointValue > 0 and a decided round → non-empty, zero-sum net', () => {
    const playerIds = ['p1', 'p2'];
    const scores: Score[] = [...uniformScores('p1', 3), ...uniformScores('p2', 5)];
    const round = makeRound({ players: makePlayers(playerIds), scores });
    const [game] = buildRoundGames([{ id: 'match' as GameId, stake: '$5' }], playerIds);
    expect(game).toBeDefined(); // 2-player roster satisfies match's requirement — not skipped
    round.games = [game];

    const net = computeGameNetWinnings(round, game);
    expect(Object.keys(net).length).toBeGreaterThan(0);
    expect(sumNet(net)).toBe(0);
    expect(net['p1']).toBeGreaterThan(0);
  });

  it('wolf: builder-produced game (4-player roster) never carries a stake — wolf is points-only, not a STAKE_GAME_IDS member', () => {
    // Wolf is deliberately excluded from STAKE_GAME_IDS (see
    // "computeGameNetWinnings — wolf settles honestly empty" above): its
    // engine is not zero-sum, so it must never display a stake it can't
    // honor. A builder-produced wolf game gets pointValue undefined
    // regardless of what stake string was typed in the picker.
    const playerIds = ['p1', 'p2', 'p3', 'p4'];
    const [game] = buildRoundGames([{ id: 'wolf' as GameId, stake: '$2' }], playerIds);
    expect(game).toBeDefined(); // 4-player roster satisfies wolf's requirement — not skipped
    expect(game.settings.pointValue).toBeUndefined();
  });
});
