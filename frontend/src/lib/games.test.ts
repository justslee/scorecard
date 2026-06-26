import { describe, it, expect } from 'vitest';
import {
  computeGameResults,
  computeSkins,
  computeBestBall,
  computeNassau,
  computeThreePoint,
  computeStableford,
  computeMatchPlay,
  computeWolf,
} from './games';
import { Round, Score, Game, Player, HoleInfo, GameFormat, GameSettings, GameTeam } from './types';

// -----------------
// Fixture helpers
// -----------------

function mkPlayer(id: string, name = id): Player {
  return { id, name };
}

/** 18 holes. Pass an array of pars (length 18) to customise; defaults to all par 4. */
function mkHoles(pars?: number[]): HoleInfo[] {
  return Array.from({ length: 18 }, (_, i) => ({
    number: i + 1,
    par: pars ? pars[i] : 4,
  }));
}

/**
 * Build a scores list from a map of playerId -> per-hole strokes.
 * Each strokes array is indexed from hole 1; `null` or `undefined` entries
 * are recorded as no-score (strokes: null) so we can exercise missing-score paths.
 */
function mkScores(byPlayer: Record<string, Array<number | null | undefined>>): Score[] {
  const scores: Score[] = [];
  for (const [playerId, arr] of Object.entries(byPlayer)) {
    arr.forEach((strokes, idx) => {
      if (strokes === undefined) return;
      scores.push({ playerId, holeNumber: idx + 1, strokes });
    });
  }
  return scores;
}

function mkRound(opts: { players: Player[]; scores: Score[]; holes?: HoleInfo[] }): Round {
  return {
    id: 'r1',
    courseId: 'c1',
    courseName: 'Test Course',
    date: '2026-06-25',
    players: opts.players,
    scores: opts.scores,
    holes: opts.holes ?? mkHoles(),
    status: 'active',
    createdAt: '2026-06-25T00:00:00.000Z',
  } as Round;
}

function mkGame(opts: {
  format: GameFormat;
  playerIds?: string[];
  teams?: GameTeam[];
  settings?: GameSettings;
}): Game {
  return {
    id: 'g1',
    roundId: 'r1',
    format: opts.format,
    name: opts.format,
    playerIds: opts.playerIds ?? [],
    teams: opts.teams,
    settings: opts.settings ?? {},
  };
}

/** Repeat a value n times — small ergonomic helper for filling holes. */
function rep(value: number | null, n: number): Array<number | null> {
  return Array.from({ length: n }, () => value);
}

// -----------------
// Skins
// -----------------
describe('computeSkins', () => {
  it('awards a skin to the outright low score on a hole', () => {
    const round = mkRound({
      players: [mkPlayer('a'), mkPlayer('b')],
      scores: mkScores({
        a: [3, ...rep(4, 17)],
        b: [4, ...rep(4, 17)],
      }),
    });
    const res = computeSkins(round, mkGame({ format: 'skins', playerIds: ['a', 'b'] }));

    const hole1 = res.holeWinners.find(h => h.holeNumber === 1)!;
    expect(hole1.winnerPlayerId).toBe('a');
    expect(hole1.value).toBe(1);
    expect(hole1.carried).toBe(false);

    const a = res.byPlayer.find(p => p.playerId === 'a')!;
    expect(a.skins).toBe(1);
    expect(a.holesWon).toEqual([1]);
    // All other holes tie -> b wins nothing
    expect(res.byPlayer.find(p => p.playerId === 'b')!.skins).toBe(0);
  });

  it('carries the skin forward on a tie and pays it out on the next won hole', () => {
    const round = mkRound({
      players: [mkPlayer('a'), mkPlayer('b')],
      scores: mkScores({
        // Hole 1 tie, hole 2 a wins => a collects 2 skins
        a: [4, 3, ...rep(4, 16)],
        b: [4, 4, ...rep(4, 16)],
      }),
    });
    const res = computeSkins(round, mkGame({ format: 'skins', playerIds: ['a', 'b'] }));

    expect(res.holeWinners[0]).toMatchObject({ holeNumber: 1, winnerPlayerId: null, value: 1, carried: false });
    const hole2 = res.holeWinners[1];
    expect(hole2.winnerPlayerId).toBe('a');
    expect(hole2.value).toBe(2);
    expect(hole2.carried).toBe(true);

    const a = res.byPlayer.find(p => p.playerId === 'a')!;
    expect(a.skins).toBe(2); // value duplicated into holesWon
    expect(a.holesWon).toEqual([2, 2]);
  });

  it('does not carry over when carryover is disabled', () => {
    const round = mkRound({
      players: [mkPlayer('a'), mkPlayer('b')],
      scores: mkScores({
        a: [4, 3, ...rep(4, 16)],
        b: [4, 4, ...rep(4, 16)],
      }),
    });
    const res = computeSkins(
      round,
      mkGame({ format: 'skins', playerIds: ['a', 'b'], settings: { carryover: false } }),
    );

    const hole2 = res.holeWinners[1];
    expect(hole2.winnerPlayerId).toBe('a');
    expect(hole2.value).toBe(1); // no carry added
    expect(res.byPlayer.find(p => p.playerId === 'a')!.skins).toBe(1);
  });

  it('declares no winner and keeps the carry when fewer than two players have scored a hole', () => {
    const round = mkRound({
      players: [mkPlayer('a'), mkPlayer('b')],
      scores: mkScores({
        a: [3, 3, ...rep(4, 16)],
        b: [undefined, 4, ...rep(4, 16)], // hole 1 only a has a score
      }),
    });
    const res = computeSkins(round, mkGame({ format: 'skins', playerIds: ['a', 'b'] }));

    expect(res.holeWinners[0]).toMatchObject({ holeNumber: 1, winnerPlayerId: null, value: 1 });
    // carry stays at 1, so hole 2 pays a single skin
    expect(res.holeWinners[1]).toMatchObject({ winnerPlayerId: 'a', value: 1 });
  });

  it('falls back to round players when game.playerIds is empty', () => {
    const round = mkRound({
      players: [mkPlayer('a'), mkPlayer('b')],
      scores: mkScores({ a: [3], b: [4] }),
    });
    const res = computeSkins(round, mkGame({ format: 'skins', playerIds: [] }));
    expect(res.byPlayer.map(p => p.playerId).sort()).toEqual(['a', 'b']);
    expect(res.byPlayer.find(p => p.playerId === 'a')!.skins).toBe(1);
  });
});

// -----------------
// Best Ball
// -----------------
describe('computeBestBall', () => {
  const teams: GameTeam[] = [
    { id: 't1', name: 'Team 1', playerIds: ['a', 'b'] },
    { id: 't2', name: 'Team 2', playerIds: ['c', 'd'] },
  ];

  it('takes the lowest ball per hole and totals it', () => {
    const round = mkRound({
      players: ['a', 'b', 'c', 'd'].map(id => mkPlayer(id)),
      scores: mkScores({
        a: [5, 4],
        b: [3, 6], // team1 best: hole1=3, hole2=4
        c: [4, 4],
        d: [6, 5], // team2 best: hole1=4, hole2=4
      }),
    });
    const res = computeBestBall(round, mkGame({ format: 'bestBall', teams }));

    expect(res.teamScoresByHole['t1'].slice(0, 2)).toEqual([3, 4]);
    expect(res.teamScoresByHole['t2'].slice(0, 2)).toEqual([4, 4]);

    const t1 = res.totals.find(t => t.teamId === 't1')!;
    expect(t1).toMatchObject({ total: 7, holesPlayed: 2 });
    expect(res.winnerTeamId).toBe('t1'); // 7 < 8
  });

  it('records null for holes with no team scores', () => {
    const round = mkRound({
      players: ['a', 'b', 'c', 'd'].map(id => mkPlayer(id)),
      scores: mkScores({ a: [4], c: [5] }),
    });
    const res = computeBestBall(round, mkGame({ format: 'bestBall', teams }));
    expect(res.teamScoresByHole['t1'][0]).toBe(4);
    expect(res.teamScoresByHole['t1'][1]).toBeNull();
  });

  it('returns no winner on a tie', () => {
    const round = mkRound({
      players: ['a', 'b', 'c', 'd'].map(id => mkPlayer(id)),
      scores: mkScores({ a: [4], b: [5], c: [4], d: [6] }),
    });
    const res = computeBestBall(round, mkGame({ format: 'bestBall', teams }));
    expect(res.winnerTeamId).toBeNull();
  });

  it('returns no winner when only one team has played', () => {
    const round = mkRound({
      players: ['a', 'b', 'c', 'd'].map(id => mkPlayer(id)),
      scores: mkScores({ a: [4], b: [5] }),
    });
    const res = computeBestBall(round, mkGame({ format: 'bestBall', teams }));
    expect(res.winnerTeamId).toBeNull();
    expect(res.totals.find(t => t.teamId === 't2')!.holesPlayed).toBe(0);
  });

  it('handles a game with no teams gracefully', () => {
    const round = mkRound({ players: [mkPlayer('a')], scores: mkScores({ a: [4] }) });
    const res = computeBestBall(round, mkGame({ format: 'bestBall' }));
    expect(res.totals).toEqual([]);
    expect(res.winnerTeamId).toBeNull();
  });
});

// -----------------
// Nassau
// -----------------
describe('computeNassau', () => {
  it('computes front/back/overall winners for individual stroke play', () => {
    // a is lower on the front, b is lower on the back; overall a edges it.
    const aScores = [...rep(3, 9), ...rep(5, 9)]; // front 27, back 45 => 72
    const bScores = [...rep(4, 9), ...rep(4, 9)]; // front 36, back 36 => 72... make a win overall
    const round = mkRound({
      players: [mkPlayer('a'), mkPlayer('b')],
      scores: mkScores({ a: aScores, b: bScores }),
    });
    const res = computeNassau(round, mkGame({ format: 'nassau', playerIds: ['a', 'b'] }));

    expect(res.scope).toBe('individual');
    expect(res.mode).toBe('stroke');
    expect(res.front9Totals['a']).toBe(27);
    expect(res.front9Totals['b']).toBe(36);
    expect(res.front9WinnerId).toBe('a');
    expect(res.back9Totals['a']).toBe(45);
    expect(res.back9WinnerId).toBe('b');
    // overall tie 72-72 => null
    expect(res.overallTotals['a']).toBe(72);
    expect(res.overallTotals['b']).toBe(72);
    expect(res.overallWinnerId).toBeNull();
  });

  it('defaults scope to team and uses best-ball totals when teams are present', () => {
    const teams: GameTeam[] = [
      { id: 't1', name: 'T1', playerIds: ['a', 'b'] },
      { id: 't2', name: 'T2', playerIds: ['c', 'd'] },
    ];
    const round = mkRound({
      players: ['a', 'b', 'c', 'd'].map(id => mkPlayer(id)),
      scores: mkScores({
        a: rep(4, 18),
        b: rep(3, 18), // team1 best = 3 each hole => front 27, back 27
        c: rep(4, 18),
        d: rep(4, 18), // team2 best = 4 each => front 36, back 36
      }),
    });
    const res = computeNassau(round, mkGame({ format: 'nassau', teams }));
    expect(res.scope).toBe('team');
    expect(res.front9Totals['t1']).toBe(27);
    expect(res.front9Totals['t2']).toBe(36);
    expect(res.front9WinnerId).toBe('t1');
    expect(res.overallWinnerId).toBe('t1');
  });

  it('honours explicit settings overrides for mode and scope', () => {
    const round = mkRound({
      players: [mkPlayer('a'), mkPlayer('b')],
      scores: mkScores({ a: rep(4, 18), b: rep(5, 18) }),
    });
    const res = computeNassau(
      round,
      mkGame({ format: 'nassau', playerIds: ['a', 'b'], settings: { nassauMode: 'match', nassauScope: 'individual' } }),
    );
    expect(res.mode).toBe('match');
    expect(res.scope).toBe('individual');
  });

  it('returns null winners when there is only one competitor', () => {
    const round = mkRound({ players: [mkPlayer('a')], scores: mkScores({ a: rep(4, 18) }) });
    const res = computeNassau(round, mkGame({ format: 'nassau', playerIds: ['a'] }));
    expect(res.front9WinnerId).toBeNull();
    expect(res.overallWinnerId).toBeNull();
  });
});

// -----------------
// 3-Point System
// -----------------
describe('computeThreePoint', () => {
  const teams: GameTeam[] = [
    { id: 'A', name: 'A', playerIds: ['a1', 'a2'] },
    { id: 'B', name: 'B', playerIds: ['b1', 'b2'] },
  ];
  const pairs = {
    teamAPlayer1Id: 'a1',
    teamAPlayer2Id: 'a2',
    teamBPlayer1Id: 'b1',
    teamBPlayer2Id: 'b2',
  };

  it('awards all three points to a team that sweeps both matchups and best ball', () => {
    const round = mkRound({
      players: ['a1', 'a2', 'b1', 'b2'].map(id => mkPlayer(id)),
      scores: mkScores({
        a1: [3],
        a2: [3],
        b1: [4],
        b2: [4],
      }),
    });
    const res = computeThreePoint(
      round,
      mkGame({ format: 'threePoint', playerIds: ['a1', 'a2', 'b1', 'b2'], teams, settings: { threePointPairs: pairs } }),
    );

    const d = res.holeDetails[0];
    expect(d.a1vsb1).toEqual({ teamA: 1, teamB: 0 });
    expect(d.a2vsb2).toEqual({ teamA: 1, teamB: 0 });
    expect(d.bestBall).toEqual({ teamA: 1, teamB: 0 });
    expect(d.holeTotal).toEqual({ teamA: 3, teamB: 0 });

    expect(res.totals['A']).toBe(3);
    expect(res.totals['B']).toBe(0);
    expect(res.runningTotalsByHole['A'][0]).toBe(3);
    expect(res.teamPointsByHole['A'][0]).toBe(3);
  });

  it('splits points on ties (half-and-half per comparison)', () => {
    const round = mkRound({
      players: ['a1', 'a2', 'b1', 'b2'].map(id => mkPlayer(id)),
      scores: mkScores({ a1: [4], a2: [4], b1: [4], b2: [4] }),
    });
    const res = computeThreePoint(
      round,
      mkGame({ format: 'threePoint', teams, settings: { threePointPairs: pairs } }),
    );
    expect(res.totals['A']).toBe(1.5);
    expect(res.totals['B']).toBe(1.5);
  });

  it('accumulates running totals across holes', () => {
    const round = mkRound({
      players: ['a1', 'a2', 'b1', 'b2'].map(id => mkPlayer(id)),
      scores: mkScores({
        a1: [3, 5],
        a2: [3, 5],
        b1: [4, 4],
        b2: [4, 4], // A sweeps hole1 (3), B sweeps hole2 (3)
      }),
    });
    const res = computeThreePoint(
      round,
      mkGame({ format: 'threePoint', teams, settings: { threePointPairs: pairs } }),
    );
    expect(res.runningTotalsByHole['A'].slice(0, 2)).toEqual([3, 3]);
    expect(res.runningTotalsByHole['B'].slice(0, 2)).toEqual([0, 3]);
    expect(res.totals).toEqual({ A: 3, B: 3 });
  });

  it('scores zero everywhere when no pairs are configured', () => {
    const round = mkRound({
      players: ['a1', 'b1'].map(id => mkPlayer(id)),
      scores: mkScores({ a1: [3], b1: [5] }),
    });
    const res = computeThreePoint(round, mkGame({ format: 'threePoint', teams }));
    expect(res.totals['A']).toBe(0);
    expect(res.totals['B']).toBe(0);
    expect(res.holeDetails[0].a1vsb1).toBeNull();
  });

  it('defaults team ids to A/B when no teams are supplied', () => {
    const round = mkRound({ players: [mkPlayer('a1')], scores: mkScores({ a1: [4] }) });
    const res = computeThreePoint(round, mkGame({ format: 'threePoint' }));
    expect(res.teamAId).toBe('A');
    expect(res.teamBId).toBe('B');
  });
});

// -----------------
// Stableford
// -----------------
describe('computeStableford', () => {
  it('maps score-to-par onto the standard points table', () => {
    // par 5 hole used so we can hit albatross (2 on a par 5 = -3)
    const pars = [5, 4, 4, 4, 4, ...Array.from({ length: 13 }, () => 4)];
    const round = mkRound({
      players: [mkPlayer('a')],
      // hole1 par5: strokes 2 => -3 => 5pts
      // hole2 par4: eagle 2 => 4pts
      // hole3 par4: birdie 3 => 3pts
      // hole4 par4: par 4 => 2pts
      // hole5 par4: bogey 5 => 1pt
      // hole6 par4: double 6 => 0pts
      scores: mkScores({ a: [2, 2, 3, 4, 5, 6] }),
      holes: mkHoles(pars),
    });
    const res = computeStableford(round, mkGame({ format: 'stableford', playerIds: ['a'] }));
    const p = res.pointsByPlayer[0];
    expect(p.pointsByHole.slice(0, 6)).toEqual([5, 4, 3, 2, 1, 0]);
    expect(p.total).toBe(15);
    expect(p.holesPlayed).toBe(6);
  });

  it('records null and skips holes with no strokes', () => {
    const round = mkRound({
      players: [mkPlayer('a')],
      scores: mkScores({ a: [4, undefined, 4] }),
    });
    const res = computeStableford(round, mkGame({ format: 'stableford', playerIds: ['a'] }));
    const p = res.pointsByPlayer[0];
    expect(p.pointsByHole[0]).toBe(2);
    expect(p.pointsByHole[1]).toBeNull();
    expect(p.pointsByHole[2]).toBe(2);
    expect(p.holesPlayed).toBe(2);
  });

  it('picks the highest total as the winner', () => {
    const round = mkRound({
      players: [mkPlayer('a'), mkPlayer('b')],
      scores: mkScores({ a: [3, 3], b: [4, 4] }), // a: birdie x2 = 6, b: par x2 = 4
    });
    const res = computeStableford(round, mkGame({ format: 'stableford', playerIds: ['a', 'b'] }));
    expect(res.winnerPlayerId).toBe('a');
  });

  it('returns no winner on a tie', () => {
    const round = mkRound({
      players: [mkPlayer('a'), mkPlayer('b')],
      scores: mkScores({ a: [4, 4], b: [4, 4] }),
    });
    const res = computeStableford(round, mkGame({ format: 'stableford', playerIds: ['a', 'b'] }));
    expect(res.winnerPlayerId).toBeNull();
  });
});

// -----------------
// Match Play
// -----------------
describe('computeMatchPlay', () => {
  const settings: GameSettings = { matchPlayPlayers: { player1Id: 'p1', player2Id: 'p2' } };

  it('tracks the running match difference and status labels', () => {
    const round = mkRound({
      players: [mkPlayer('p1'), mkPlayer('p2')],
      scores: mkScores({
        p1: [3, 4, 5], // win, halve, lose
        p2: [4, 4, 4],
      }),
    });
    const res = computeMatchPlay(round, mkGame({ format: 'matchPlay', playerIds: ['p1', 'p2'], settings }));
    expect(res.holes[0]).toMatchObject({ result: 'P1', matchDiffAfter: 1, statusAfter: '1 UP' });
    expect(res.holes[1]).toMatchObject({ result: 'HALVED', matchDiffAfter: 1, statusAfter: '1 UP' });
    expect(res.holes[2]).toMatchObject({ result: 'P2', matchDiffAfter: 0, statusAfter: 'AS' });
    expect(res.currentStatus).toBe('AS');
    expect(res.endedAtHole).toBeNull();
    expect(res.winnerPlayerId).toBeNull();
  });

  it('marks NO_SCORE holes and leaves the difference unchanged', () => {
    const round = mkRound({
      players: [mkPlayer('p1'), mkPlayer('p2')],
      scores: mkScores({ p1: [3], p2: [undefined] }),
    });
    const res = computeMatchPlay(round, mkGame({ format: 'matchPlay', playerIds: ['p1', 'p2'], settings }));
    expect(res.holes[0].result).toBe('NO_SCORE');
    expect(res.holes[0].matchDiffAfter).toBe(0);
  });

  it('closes the match out when the lead exceeds the holes remaining', () => {
    // p1 wins the first 10 holes => 10 up with 8 to play after hole 10 => closed at hole 10
    const round = mkRound({
      players: [mkPlayer('p1'), mkPlayer('p2')],
      scores: mkScores({
        p1: rep(3, 18),
        p2: rep(4, 18),
      }),
    });
    const res = computeMatchPlay(round, mkGame({ format: 'matchPlay', playerIds: ['p1', 'p2'], settings }));
    expect(res.endedAtHole).toBe(10);
    expect(res.winnerPlayerId).toBe('p1');
    expect(res.currentStatus).toContain('Final');
    // holes at/after the close are flagged ended
    expect(res.holes[9].ended).toBe(true);
    expect(res.holes[8].ended).toBe(false);
  });

  it('falls back to the first two game playerIds when no matchPlayPlayers set', () => {
    const round = mkRound({
      players: [mkPlayer('x'), mkPlayer('y')],
      scores: mkScores({ x: [3], y: [4] }),
    });
    const res = computeMatchPlay(round, mkGame({ format: 'matchPlay', playerIds: ['x', 'y'] }));
    expect(res.player1Id).toBe('x');
    expect(res.player2Id).toBe('y');
    expect(res.holes[0].result).toBe('P1');
  });
});

// -----------------
// Wolf
// -----------------
describe('computeWolf', () => {
  const order = ['w', 'x', 'y', 'z'];

  it('rotates the wolf by hole number', () => {
    const round = mkRound({
      players: order.map(id => mkPlayer(id)),
      scores: mkScores({ w: rep(4, 18), x: rep(4, 18), y: rep(4, 18), z: rep(4, 18) }),
    });
    const res = computeWolf(round, mkGame({ format: 'wolf', settings: { wolfOrderPlayerIds: order } }));
    expect(res.orderPlayerIds).toEqual(order);
    expect(res.holes[0].wolfPlayerId).toBe('w');
    expect(res.holes[1].wolfPlayerId).toBe('x');
    expect(res.holes[3].wolfPlayerId).toBe('z');
    expect(res.holes[4].wolfPlayerId).toBe('w'); // wraps
  });

  it('awards +3 to a lone wolf who beats the field', () => {
    const round = mkRound({
      players: order.map(id => mkPlayer(id)),
      scores: mkScores({ w: [3], x: [4], y: [4], z: [4] }),
    });
    const res = computeWolf(
      round,
      mkGame({ format: 'wolf', settings: { wolfOrderPlayerIds: order, wolfHoleChoices: { 1: { mode: 'lone' } } } }),
    );
    expect(res.holes[0].pointsDelta['w']).toBe(3);
    expect(res.totals['w']).toBe(3);
  });

  it('docks a lone wolf -3 when the field beats them', () => {
    const round = mkRound({
      players: order.map(id => mkPlayer(id)),
      scores: mkScores({ w: [5], x: [4], y: [6], z: [6] }),
    });
    const res = computeWolf(
      round,
      mkGame({ format: 'wolf', settings: { wolfOrderPlayerIds: order, wolfHoleChoices: { 1: { mode: 'lone' } } } }),
    );
    expect(res.holes[0].pointsDelta['w']).toBe(-3);
  });

  it('gives a lone wolf 0 when tied with the field best', () => {
    const round = mkRound({
      players: order.map(id => mkPlayer(id)),
      scores: mkScores({ w: [4], x: [4], y: [5], z: [5] }),
    });
    const res = computeWolf(
      round,
      mkGame({ format: 'wolf', settings: { wolfOrderPlayerIds: order, wolfHoleChoices: { 1: { mode: 'lone' } } } }),
    );
    expect(res.holes[0].pointsDelta['w']).toBe(0);
  });

  it('awards +1 each to the wolf and partner when their team wins', () => {
    const round = mkRound({
      players: order.map(id => mkPlayer(id)),
      scores: mkScores({ w: [3], x: [4], y: [5], z: [5] }), // wolf w + partner x beat y/z
    });
    const res = computeWolf(
      round,
      mkGame({
        format: 'wolf',
        settings: { wolfOrderPlayerIds: order, wolfHoleChoices: { 1: { mode: 'partner', partnerId: 'x' } } },
      }),
    );
    expect(res.holes[0].pointsDelta['w']).toBe(1);
    expect(res.holes[0].pointsDelta['x']).toBe(1);
    expect(res.totals['w']).toBe(1);
    expect(res.totals['x']).toBe(1);
  });

  it('awards +1 each to the opposing pair when the wolf team loses', () => {
    const round = mkRound({
      players: order.map(id => mkPlayer(id)),
      scores: mkScores({ w: [5], x: [5], y: [3], z: [4] }), // y/z beat wolf team
    });
    const res = computeWolf(
      round,
      mkGame({
        format: 'wolf',
        settings: { wolfOrderPlayerIds: order, wolfHoleChoices: { 1: { mode: 'partner', partnerId: 'x' } } },
      }),
    );
    expect(res.holes[0].pointsDelta['y']).toBe(1);
    expect(res.holes[0].pointsDelta['z']).toBe(1);
    expect(res.holes[0].pointsDelta['w']).toBeUndefined();
  });

  it('records an empty delta when the hole has no recorded choice', () => {
    const round = mkRound({
      players: order.map(id => mkPlayer(id)),
      scores: mkScores({ w: [3], x: [4], y: [4], z: [4] }),
    });
    const res = computeWolf(round, mkGame({ format: 'wolf', settings: { wolfOrderPlayerIds: order } }));
    expect(res.holes[0].choice).toBeNull();
    expect(res.holes[0].pointsDelta).toEqual({});
    expect(res.totals['w']).toBe(0);
  });

  it('derives the order from playerIds when no explicit wolf order is given', () => {
    const round = mkRound({
      players: order.map(id => mkPlayer(id)),
      scores: mkScores({ w: [3], x: [4], y: [4], z: [4] }),
    });
    const res = computeWolf(round, mkGame({ format: 'wolf', playerIds: order }));
    expect(res.orderPlayerIds).toEqual(order);
  });
});

// -----------------
// Dispatch (computeGameResults)
// -----------------
describe('computeGameResults', () => {
  const round = mkRound({
    players: ['a', 'b', 'c', 'd'].map(id => mkPlayer(id)),
    scores: mkScores({ a: [3], b: [4], c: [4], d: [4] }),
  });

  it('routes each format to its matching result key', () => {
    expect(computeGameResults(round, mkGame({ format: 'skins', playerIds: ['a', 'b'] })).skins).toBeDefined();
    expect(computeGameResults(round, mkGame({ format: 'nassau', playerIds: ['a', 'b'] })).nassau).toBeDefined();
    expect(
      computeGameResults(round, mkGame({ format: 'bestBall', teams: [{ id: 't1', name: 't1', playerIds: ['a'] }] })).bestBall,
    ).toBeDefined();
    expect(computeGameResults(round, mkGame({ format: 'threePoint' })).threePoint).toBeDefined();
    expect(computeGameResults(round, mkGame({ format: 'stableford', playerIds: ['a'] })).stableford).toBeDefined();
    expect(computeGameResults(round, mkGame({ format: 'matchPlay', playerIds: ['a', 'b'] })).matchPlay).toBeDefined();
    expect(computeGameResults(round, mkGame({ format: 'wolf', playerIds: ['a', 'b', 'c', 'd'] })).wolf).toBeDefined();
  });

  it('routes modifiedStableford through the stableford engine', () => {
    const res = computeGameResults(round, mkGame({ format: 'modifiedStableford', playerIds: ['a', 'b'] }));
    expect(res.stableford).toBeDefined();
  });

  it('returns an empty object for unimplemented formats', () => {
    expect(computeGameResults(round, mkGame({ format: 'scramble' }))).toEqual({});
    expect(computeGameResults(round, mkGame({ format: 'vegas' }))).toEqual({});
    expect(computeGameResults(round, mkGame({ format: 'hammer' }))).toEqual({});
  });
});
