/**
 * Tournament-level + settlement rounding-drift coverage hardening.
 *
 * Lives in its OWN file (not settlement.test.ts, which is 2,345 lines and must
 * never be edited — CLAUDE.md rule) so the RED→GREEN diff for the threePoint
 * zero-sum bug fix is isolated and reviewable in one place.
 *
 * Local helpers are re-declared here (not imported from settlement.test.ts —
 * importing a test file executes it, and its exports are unexported anyway).
 * Patterns mirror settlement.test.ts:34-84.
 *
 * See specs/tournament-coverage-hardening-plan.md for the full rationale.
 */

import { describe, it, expect } from 'vitest';
import {
  computeGameNetWinnings,
  computeNetSettlement,
  computeTournamentSettlement,
  type SettlementLedger,
} from './settlement';
import type { Round, Game, Score, HoleInfo, Player } from './types';

// ─── Helpers (mirrors settlement.test.ts:34-84) ────────────────────────────────

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
  const result = Math.round(Object.values(net).reduce((s, v) => s + v, 0) * 100) / 100;
  // Object.is(-0, 0) is false; normalize so callers always receive plain 0
  // (mirrors settlement.ts:85's r2 normalization).
  return result === 0 ? 0 : result;
}

function roundCents(n: number): number {
  const result = Math.round(n * 100) / 100;
  return result === 0 ? 0 : result;
}

/**
 * Conservation invariant: for every player in the ledger, their displayed net
 * must exactly equal what the minimized transfers actually deliver — i.e.
 * `net[p] === inflow(p) - outflow(p)`. This is the real "displayed == settled"
 * guarantee (gap 5). Also asserts every transfer amount is >= 0.01 at 2dp
 * (minimizeTransfers must never emit dust).
 */
function assertConservation(ledger: SettlementLedger): void {
  const inflow: Record<string, number> = {};
  const outflow: Record<string, number> = {};

  for (const t of ledger.transfers) {
    expect(t.amount).toBeGreaterThanOrEqual(0.01);
    expect(roundCents(t.amount)).toBe(t.amount);
    inflow[t.toPlayerId] = roundCents((inflow[t.toPlayerId] ?? 0) + t.amount);
    outflow[t.fromPlayerId] = roundCents((outflow[t.fromPlayerId] ?? 0) + t.amount);
  }

  for (const [pid, net] of Object.entries(ledger.netByPlayer)) {
    const delivered = roundCents((inflow[pid] ?? 0) - (outflow[pid] ?? 0));
    expect(
      roundCents(net - delivered),
      `player ${pid}: displayed net ${net} but transfers deliver ${delivered}`
    ).toBe(0);
  }
}

// ─── Gap 3 — Rounding-drift accumulation ───────────────────────────────────────
// CONFIRMED REAL MONEY BUG: threePoint's team split (settlement.ts ~195-212) has
// no rounding-residual absorber (unlike skins ~125-135 and vegas distributeTeam
// ~222-235). An odd-cent team net fabricates money. Reproduced below with the
// classic "quarter a point" stake ($0.25) for 9s: team A sweeps hole 1 (3-0),
// pointValue 0.25 → teamANet = $0.75, split 2-per-team.
//
// RED→GREEN mandatory order: these tests MUST fail first with the documented
// +0.02 / +0.12 sums (bug evidence), THEN the fix lands, THEN they go green.

/** Odd-cent threePoint round: team A sweeps hole 1 3-0 at pointValue 0.25. */
function oddCentThreePointRound(id = 'r1'): Round {
  const playerIds = ['p1', 'p2', 'p3', 'p4'];
  const scores: Score[] = [
    { playerId: 'p1', holeNumber: 1, strokes: 3 },
    { playerId: 'p2', holeNumber: 1, strokes: 3 },
    { playerId: 'p3', holeNumber: 1, strokes: 4 },
    { playerId: 'p4', holeNumber: 1, strokes: 4 },
  ];
  return makeRound({
    id,
    players: makePlayers(playerIds),
    scores,
    games: [
      {
        id: `${id}-g`,
        roundId: id,
        format: 'threePoint',
        name: 'Three-Point',
        playerIds,
        teams: [
          { id: 'tA', name: 'Team A', playerIds: ['p1', 'p2'] },
          { id: 'tB', name: 'Team B', playerIds: ['p3', 'p4'] },
        ],
        settings: {
          pointValue: 0.25,
          threePointPairs: {
            teamAPlayer1Id: 'p1',
            teamAPlayer2Id: 'p2',
            teamBPlayer1Id: 'p3',
            teamBPlayer2Id: 'p4',
          },
        },
      },
    ],
  });
}

describe('threePoint zero-sum — odd-cent rounding drift (RED→GREEN bug fix)', () => {
  it('per-round: odd-cent team net ($0.75 / 2 players) sums to exactly zero', () => {
    const round = oddCentThreePointRound();
    const game = round.games![0];
    const net = computeGameNetWinnings(round, game);

    // Bug evidence (pre-fix): net = { p1: 0.38, p2: 0.38, p3: -0.37, p4: -0.37 },
    // sumNet === 0.02 — the game fabricates $0.02. Must be exactly 0.
    expect(sumNet(net)).toBe(0);

    // Post-fix: team totals stay exact (+/- $0.75) and each share is one of
    // the two valid 2dp splits of $0.75 across 2 players.
    const teamATotal = roundCents((net['p1'] ?? 0) + (net['p2'] ?? 0));
    const teamBTotal = roundCents((net['p3'] ?? 0) + (net['p4'] ?? 0));
    expect(teamATotal).toBe(0.75);
    expect(teamBTotal).toBe(-0.75);
    expect([0.37, 0.38]).toContain(net['p1']);
    expect([0.37, 0.38]).toContain(net['p2']);
    expect([-0.37, -0.38]).toContain(net['p3']);
    expect([-0.37, -0.38]).toContain(net['p4']);
  });

  it('cumulative: 6 rounds of the odd-cent threePoint round sum to exactly zero with full conservation', () => {
    const rounds = Array.from({ length: 6 }, (_, i) => oddCentThreePointRound(`r${i + 1}`));
    const ledger = computeTournamentSettlement(rounds);

    // Bug evidence (pre-fix): cumulative sumNet === 0.12 (6 × $0.02 fabricated).
    expect(sumNet(ledger.netByPlayer)).toBe(0);

    // Conservation (pre-fix): fails because the fabricated $0.02/round leaves
    // the winning team's displayed net undelivered by the minimized transfers.
    assertConservation(ledger);
  });
});

// ─── Shared fixture builders (roster-flexible; NOT the fixed p1/p2 helper in
// settlement.test.ts, which is hardcoded to that pair) ─────────────────────────

/** Decided 1v1 matchPlay round: winnerId beats loserId every hole. */
function decidedMatchPlayRound(
  id: string,
  pointValue: number,
  winnerId: string,
  loserId: string
): Round {
  const scores: Score[] = [...uniformScores(winnerId, 3), ...uniformScores(loserId, 5)];
  return makeRound({
    id,
    players: makePlayers([winnerId, loserId]),
    scores,
    games: [
      {
        id: `${id}-g`,
        roundId: id,
        format: 'matchPlay',
        name: 'Match Play',
        playerIds: [winnerId, loserId],
        settings: {
          pointValue,
          matchPlayMode: 'individual',
          matchPlayPlayers: { player1Id: winnerId, player2Id: loserId },
        },
      },
    ],
  });
}

/**
 * Decided skins round for an arbitrary roster: the first player sweeps hole 1
 * (everyone else ties on it), every other hole is a full tie — so exactly one
 * skin (hole 1) is ever awarded, same shape as the SETTLEABLE_FORMATS skins
 * fixture at settlement.test.ts:1276.
 */
function decidedSkinsRound(id: string, pointValue: number, playerIds: string[]): Round {
  const [winner, ...rest] = playerIds;
  const scores: Score[] = [
    { playerId: winner, holeNumber: 1, strokes: 3 },
    ...rest.map((pid) => ({ playerId: pid, holeNumber: 1, strokes: 5 })),
    ...Array.from({ length: 17 }, (_, i) =>
      playerIds.map((pid) => ({ playerId: pid, holeNumber: i + 2, strokes: 4 }))
    ).flat(),
  ];
  return makeRound({
    id,
    players: makePlayers(playerIds),
    scores,
    games: [
      makeGame({
        id: `${id}-g`,
        roundId: id,
        format: 'skins',
        playerIds,
        settings: { pointValue },
      }),
    ],
  });
}

// ─── Gap 1 — Cross-roster cumulative settlement ────────────────────────────────
// Every computeTournamentSettlement test in settlement.test.ts uses the
// identical {p1,p2} roster; the union-merge loop (settlement.ts:390-395) has
// never seen disjoint rosters.

describe('computeTournamentSettlement — cross-roster cumulative', () => {
  it('rotating pairs: a perfect debt circle cancels to zero transfers over the roster union', () => {
    // r1 {p1,p2} $10, p1 wins. r2 {p2,p3} $10, p2 wins. r3 {p1,p3} $10, p3 wins.
    const rounds = [
      decidedMatchPlayRound('r1', 10, 'p1', 'p2'),
      decidedMatchPlayRound('r2', 10, 'p2', 'p3'),
      decidedMatchPlayRound('r3', 10, 'p3', 'p1'),
    ];

    const ledger = computeTournamentSettlement(rounds);

    expect(Object.keys(ledger.netByPlayer).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(ledger.netByPlayer['p1']).toBe(0);
    expect(ledger.netByPlayer['p2']).toBe(0);
    expect(ledger.netByPlayer['p3']).toBe(0);
    expect(sumNet(ledger.netByPlayer)).toBe(0);
    expect(ledger.transfers).toEqual([]);
    expect(ledger.isEmpty).toBe(true);
  });

  it('rotating pairs, skewed: cross-round chain compresses through a player who nets exactly zero', () => {
    // r1 {p1,p2} $10, p1 wins. r2 {p2,p3} $10, p2 wins. r3 {p1,p3} $20, p3 wins.
    // p1: +10 (r1) -20 (r3) = -10. p2: -10 (r1) +10 (r2) = 0. p3: -10 (r2) +20 (r3) = +10.
    // Per-round minimize-then-concat can never produce a single p1->p3 transfer
    // (p1 and p3 never share a positive/negative pair within one round's ledger
    // after p2's net collapses); sum-then-minimize can.
    const rounds = [
      decidedMatchPlayRound('r1', 10, 'p1', 'p2'),
      decidedMatchPlayRound('r2', 10, 'p2', 'p3'),
      decidedMatchPlayRound('r3', 20, 'p3', 'p1'),
    ];

    const ledger = computeTournamentSettlement(rounds);

    expect(ledger.netByPlayer).toEqual({ p1: -10, p2: 0, p3: 10 });
    expect(sumNet(ledger.netByPlayer)).toBe(0);
    expect(ledger.transfers).toHaveLength(1);
    expect(ledger.transfers[0]).toMatchObject({
      fromPlayerId: 'p1',
      toPlayerId: 'p3',
      amount: 10,
    });
    assertConservation(ledger);
  });

  it('mixed roster sizes: a player who sits out a round contributes exactly the sat-out round\'s own ledger value, union has no silent drops', () => {
    const r1 = decidedSkinsRound('r1', 4, ['p1', 'p2', 'p3', 'p4']);
    const r2 = decidedMatchPlayRound('r2', 10, 'p1', 'p2');

    const r1Ledger = computeNetSettlement(r1);
    const ledger = computeTournamentSettlement([r1, r2]);

    // p3/p4 never appear in r2 — their cumulative value is EXACTLY r1's own
    // per-round net (r2 contributed nothing, not "unknown"/dropped).
    expect(ledger.netByPlayer['p3']).toBe(r1Ledger.netByPlayer['p3']);
    expect(ledger.netByPlayer['p4']).toBe(r1Ledger.netByPlayer['p4']);

    // Union property: no round's participant is silently dropped.
    for (const round of [r1, r2]) {
      const roundLedger = computeNetSettlement(round);
      for (const pid of Object.keys(roundLedger.netByPlayer)) {
        expect(Object.keys(ledger.netByPlayer)).toContain(pid);
      }
    }

    expect(sumNet(ledger.netByPlayer)).toBe(0);
    assertConservation(ledger);
  });
});

// ─── Gap 2 — Genuinely mixed formats across rounds ─────────────────────────────
// settlement.test.ts:1187-1197's "multiple rounds and formats" test is three
// matchPlay rounds — never actually multi-format. This tournament spans skins,
// wolf, vegas, matchPlay, nassau, and a non-settleable stableford round.

describe('computeTournamentSettlement — genuinely mixed formats across 6 rounds', () => {
  function vegasRound(id: string, pointValue: number): Round {
    const playerIds = ['p1', 'p2', 'p3', 'p4'];
    const scores: Score[] = [
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 5 },
      { playerId: 'p3', holeNumber: 1, strokes: 4 },
      { playerId: 'p4', holeNumber: 1, strokes: 5 },
    ];
    return makeRound({
      id,
      players: makePlayers(playerIds),
      scores,
      games: [
        {
          id: `${id}-g`,
          roundId: id,
          format: 'vegas',
          name: 'Vegas',
          playerIds,
          teams: [
            { id: 'tA', name: 'Team A', playerIds: ['p1', 'p2'] },
            { id: 'tB', name: 'Team B', playerIds: ['p3', 'p4'] },
          ],
          settings: { pointValue },
        },
      ],
    });
  }

  // Realistic wolf round (tournament-wolf-settlement-plan.md §5.3 shape, same
  // pattern as settlement.test.ts:1423): 5 decided holes, points p1+6/p2-2/p3-4/p4 0.
  function wolfRound(id: string, pointValue: number): Round {
    const playerIds = ['p1', 'p2', 'p3', 'p4'];
    const scores: Score[] = [
      { playerId: 'p1', holeNumber: 1, strokes: 3 },
      { playerId: 'p2', holeNumber: 1, strokes: 5 },
      { playerId: 'p3', holeNumber: 1, strokes: 5 },
      { playerId: 'p4', holeNumber: 1, strokes: 5 },
      { playerId: 'p1', holeNumber: 2, strokes: 3 },
      { playerId: 'p2', holeNumber: 2, strokes: 5 },
      { playerId: 'p3', holeNumber: 2, strokes: 4 },
      { playerId: 'p4', holeNumber: 2, strokes: 5 },
      { playerId: 'p1', holeNumber: 3, strokes: 4 },
      { playerId: 'p2', holeNumber: 3, strokes: 4 },
      { playerId: 'p3', holeNumber: 3, strokes: 6 },
      { playerId: 'p4', holeNumber: 3, strokes: 4 },
      { playerId: 'p1', holeNumber: 4, strokes: 4 },
      { playerId: 'p2', holeNumber: 4, strokes: 4 },
      { playerId: 'p3', holeNumber: 4, strokes: 4 },
      { playerId: 'p4', holeNumber: 4, strokes: 3 },
      { playerId: 'p1', holeNumber: 5, strokes: 4 },
      { playerId: 'p2', holeNumber: 5, strokes: 4 },
      { playerId: 'p3', holeNumber: 5, strokes: 4 },
      { playerId: 'p4', holeNumber: 5, strokes: 4 },
    ];
    return makeRound({
      id,
      players: makePlayers(playerIds),
      scores,
      games: [
        makeGame({
          id: `${id}-g`,
          roundId: id,
          format: 'wolf',
          playerIds,
          settings: {
            pointValue,
            wolfOrderPlayerIds: playerIds,
            wolfHoleChoices: {
              1: { mode: 'lone' },
              2: { mode: 'partner', partnerId: 'p4' },
              3: { mode: 'lone' },
              4: { mode: 'partner', partnerId: 'p1' },
              5: { mode: 'lone' },
            },
          },
        }),
      ],
    });
  }

  function nassauRound(id: string, pointValue: number): Round {
    const playerIds = ['p1', 'p2'];
    const scores: Score[] = [...uniformScores('p1', 3), ...uniformScores('p2', 5)];
    return makeRound({
      id,
      players: makePlayers(playerIds),
      scores,
      games: [
        makeGame({
          id: `${id}-g`,
          roundId: id,
          format: 'nassau',
          playerIds,
          settings: { pointValue, nassauMode: 'stroke', nassauScope: 'individual' },
        }),
      ],
    });
  }

  /** Non-settleable stableford round with full scores and a pointValue set — must
   *  contribute exactly nothing (stableford is not in SETTLEABLE_FORMATS). */
  function stablefordRound(id: string): Round {
    const playerIds = ['p1', 'p2', 'p3', 'p4'];
    const scores: Score[] = playerIds.flatMap((pid) => uniformScores(pid, 4));
    return makeRound({
      id,
      players: makePlayers(playerIds),
      scores,
      games: [
        makeGame({
          id: `${id}-g`,
          roundId: id,
          format: 'stableford',
          playerIds,
          settings: { pointValue: 5 },
        }),
      ],
    });
  }

  it('cumulative zero-sum + consistency invariant + stableford contributes exactly $0', () => {
    const r1 = decidedSkinsRound('r1', 5, ['p1', 'p2', 'p3']);
    const r2 = wolfRound('r2', 2);
    const r3 = vegasRound('r3', 1);
    const r4 = decidedMatchPlayRound('r4', 10, 'p1', 'p2');
    const r5 = nassauRound('r5', 4);
    const r6 = stablefordRound('r6');

    const moneyRounds = [r1, r2, r3, r4, r5];
    const allRounds = [...moneyRounds, r6];

    const ledger = computeTournamentSettlement(allRounds);

    // Real multi-format ledger, not a vacuous empty one.
    expect(Object.keys(ledger.netByPlayer).length).toBeGreaterThan(0);
    expect(sumNet(ledger.netByPlayer)).toBe(0);

    // Consistency invariant: cumulative === hand-summed per-round ledgers,
    // independently re-derived via computeNetSettlement per round (the
    // tournament function must add nothing beyond r2-summation).
    const handSummed: Record<string, number> = {};
    for (const round of allRounds) {
      const roundLedger = computeNetSettlement(round);
      for (const [pid, amount] of Object.entries(roundLedger.netByPlayer)) {
        handSummed[pid] = roundCents((handSummed[pid] ?? 0) + amount);
      }
    }
    expect(ledger.netByPlayer).toEqual(handSummed);

    // The stableford round contributes exactly $0 — dropping it changes nothing.
    const ledgerWithoutR6 = computeTournamentSettlement(moneyRounds);
    expect(ledger.netByPlayer).toEqual(ledgerWithoutR6.netByPlayer);
    expect(ledger.transfers).toEqual(ledgerWithoutR6.transfers);

    assertConservation(ledger);
  });
});

// ─── Gap 3 (continued) — odd-cent-stake zero-sum property + fractional skins lock ─

describe('odd-cent-stake zero-sum property (pointValue 0.25) across pot-splitting formats', () => {
  const fixtures: Record<string, () => Round> = {
    skins: () => decidedSkinsRound('r-skins', 0.25, ['p1', 'p2', 'p3']),
    threePoint: () => oddCentThreePointRound('r-3pt'),
    nassau: () => {
      const playerIds = ['p1', 'p2', 'p3'];
      const scores: Score[] = [
        ...uniformScores('p1', 3),
        ...uniformScores('p2', 5),
        ...uniformScores('p3', 5),
      ];
      return makeRound({
        id: 'r-nassau',
        players: makePlayers(playerIds),
        scores,
        games: [
          makeGame({
            id: 'r-nassau-g',
            roundId: 'r-nassau',
            format: 'nassau',
            playerIds,
            settings: { pointValue: 0.25, nassauMode: 'stroke', nassauScope: 'individual' },
          }),
        ],
      });
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
      const game = makeGame({
        id: 'r-rabbit-g',
        roundId: 'r-rabbit',
        playerIds,
        format: 'rabbit',
        settings: { pointValue: 0.25 },
      });
      return makeRound({ id: 'r-rabbit', players: makePlayers(playerIds), scores, games: [game] });
    },
  };

  for (const [format, build] of Object.entries(fixtures)) {
    it(`${format}: sumNet === 0 at pointValue 0.25 on a decided round`, () => {
      const round = build();
      const ledger = computeNetSettlement(round);
      expect(Object.keys(ledger.netByPlayer).length).toBeGreaterThan(0);
      expect(sumNet(ledger.netByPlayer)).toBe(0);
    });
  }
});

describe('fractional 3-way skins drift — GREEN lock at tournament scale', () => {
  it('6 rounds of 3-way $1 skins (absorber-produced +0.67/-0.33/-0.34 shape) sum to exactly zero cumulatively', () => {
    const rounds = Array.from({ length: 6 }, (_, i) =>
      decidedSkinsRound(`r${i + 1}`, 1, ['p1', 'p2', 'p3'])
    );

    // Confirm the per-round absorber shape the plan describes.
    const perRound = computeNetSettlement(rounds[0]);
    expect([perRound.netByPlayer['p1'], perRound.netByPlayer['p2'], perRound.netByPlayer['p3']]).toEqual([
      0.67, -0.33, -0.34,
    ]);

    const ledger = computeTournamentSettlement(rounds);

    expect(sumNet(ledger.netByPlayer)).toBe(0);
    for (const v of Object.values(ledger.netByPlayer)) {
      // Every cumulative value must itself be a clean 2dp number (no residual
      // float drift accumulating silently across rounds).
      expect(Math.round(v * 100)).toBe(Math.round(v * 10000) / 100);
    }
    assertConservation(ledger);
  });
});

// ─── Gap 4 — Money + game-less + unscored rounds in one tournament ─────────────

describe('computeTournamentSettlement — money + game-less + unscored rounds together', () => {
  it('game-less and unscored rounds neither corrupt amounts nor drop players', () => {
    const r1 = decidedMatchPlayRound('r1', 10, 'p1', 'p2');
    const r2 = makeRound({ id: 'r2', players: makePlayers(['p1', 'p2']), games: [] });
    const r3 = makeRound({
      id: 'r3',
      players: makePlayers(['p1', 'p2', 'p3', 'p4']),
      scores: [], // unscored
      games: [
        makeGame({
          id: 'r3-g',
          roundId: 'r3',
          format: 'skins',
          playerIds: ['p1', 'p2', 'p3', 'p4'],
          settings: { pointValue: 5 },
        }),
      ],
    });
    const r4 = decidedMatchPlayRound('r4', 15, 'p2', 'p1');

    const moneyOnly = computeTournamentSettlement([r1, r4]);
    const ledger = computeTournamentSettlement([r1, r2, r3, r4]);

    expect(ledger.isEmpty).toBe(false);
    expect(ledger.transfers).toEqual(moneyOnly.transfers);

    // Every non-zero entry matches the money-only ([r1, r4]) ledger exactly.
    for (const [pid, amount] of Object.entries(ledger.netByPlayer)) {
      if (Math.abs(amount) >= 0.01) {
        expect(amount).toBe(moneyOnly.netByPlayer[pid]);
      }
    }

    // r3 (unscored skins) initializes its whole roster at $0 — p3/p4 must be
    // present with value exactly 0, not silently absent from the ledger.
    expect(ledger.netByPlayer['p3']).toBe(0);
    expect(ledger.netByPlayer['p4']).toBe(0);

    assertConservation(ledger);
  });
});

// ─── Per-round COURSE plan — settlement is course-blind (§8) ───────────────────
// tournament-per-round-format-course-plan.md §8: computeTournamentSettlement
// settles per-round game ledgers, also course-blind. Per-round course variance
// must introduce NO math change.

describe('computeTournamentSettlement — per-round course variance is inert', () => {
  it('rounds sitting on different courses settle identically to the same-course fixture', () => {
    const sameCourse = [
      decidedMatchPlayRound('r1', 10, 'p1', 'p2'),
      decidedMatchPlayRound('r2', 10, 'p2', 'p1'),
    ];

    const differentCourses = [
      { ...decidedMatchPlayRound('r1', 10, 'p1', 'p2'), courseId: 'black', courseName: 'Bethpage Black' },
      { ...decidedMatchPlayRound('r2', 10, 'p2', 'p1'), courseId: 'red', courseName: 'Bethpage Red' },
    ];

    const sameCourseLedger = computeTournamentSettlement(sameCourse);
    const differentCoursesLedger = computeTournamentSettlement(differentCourses);

    expect(differentCoursesLedger.netByPlayer).toEqual(sameCourseLedger.netByPlayer);
    expect(differentCoursesLedger.transfers).toEqual(sameCourseLedger.transfers);
    assertConservation(differentCoursesLedger);
  });
});
