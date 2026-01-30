import { Round, Score, Game } from './types';

export interface SkinsResults {
  byPlayer: { playerId: string; skins: number; holesWon: number[] }[];
  holeWinners: { holeNumber: number; winnerPlayerId: string | null; value: number; carried: boolean }[];
}

export interface BestBallResults {
  teamScoresByHole: Record<string, (number | null)[]>; // teamId -> 18-length array
  totals: { teamId: string; total: number; holesPlayed: number }[];
  winnerTeamId: string | null;
}

export interface NassauResults {
  front9WinnerId: string | null;
  back9WinnerId: string | null;
  overallWinnerId: string | null;
  front9Totals: Record<string, number>;
  back9Totals: Record<string, number>;
  overallTotals: Record<string, number>;
  mode: 'stroke' | 'match';
  scope: 'individual' | 'team';
}

export interface ThreePointResults {
  teamAId: string;
  teamBId: string;
  teamPointsByHole: Record<string, number[]>; // teamId -> 18-length array (hole points)
  runningTotalsByHole: Record<string, number[]>; // teamId -> 18-length array (running totals)
  totals: Record<string, number>; // teamId -> total points
  holeDetails: {
    holeNumber: number;
    a1vsb1: { teamA: number; teamB: number } | null;
    a2vsb2: { teamA: number; teamB: number } | null;
    bestBall: { teamA: number; teamB: number } | null;
    holeTotal: { teamA: number; teamB: number };
  }[];
}

export interface StablefordResults {
  pointsByPlayer: {
    playerId: string;
    total: number;
    pointsByHole: (number | null)[];
    holesPlayed: number;
  }[];
  winnerPlayerId: string | null;
}

export interface MatchPlayResults {
  player1Id: string;
  player2Id: string;
  holes: {
    holeNumber: number;
    result: 'P1' | 'P2' | 'HALVED' | 'NO_SCORE';
    matchDiffAfter: number; // positive => P1 up, negative => P2 up
    statusAfter: string; // "AS", "2 UP", "1 DN"...
    ended?: boolean;
  }[];
  currentStatus: string;
  endedAtHole: number | null;
  winnerPlayerId: string | null;
}

export interface WolfResults {
  orderPlayerIds: string[];
  holes: {
    holeNumber: number;
    wolfPlayerId: string;
    choice: { mode: 'lone' } | { mode: 'partner'; partnerId: string } | null;
    pointsDelta: Record<string, number>; // only players affected on this hole
    totalsAfter: Record<string, number>; // running totals after this hole
  }[];
  totals: Record<string, number>; // final totals
}

export interface GameResults {
  skins?: SkinsResults;
  bestBall?: BestBallResults;
  nassau?: NassauResults;
  threePoint?: ThreePointResults;
  stableford?: StablefordResults;
  matchPlay?: MatchPlayResults;
  wolf?: WolfResults;
  // stubs for later
  scramble?: unknown;
  bingoBangoBongo?: unknown;
  vegas?: unknown;
}

export function computeGameResults(round: Round, game: Game): GameResults {
  switch (game.format) {
    case 'skins':
      return { skins: computeSkins(round, game) };
    case 'bestBall':
      return { bestBall: computeBestBall(round, game) };
    case 'nassau':
      return { nassau: computeNassau(round, game) };
    case 'threePoint':
      return { threePoint: computeThreePoint(round, game) };
    case 'stableford':
    case 'modifiedStableford':
      return { stableford: computeStableford(round, game) };
    case 'matchPlay':
      return { matchPlay: computeMatchPlay(round, game) };
    case 'wolf':
      return { wolf: computeWolf(round, game) };
    default:
      return {};
  }
}

function scoreByHole(scores: Score[], playerId: string): Map<number, number> {
  const m = new Map<number, number>();
  for (const s of scores) {
    if (s.playerId !== playerId) continue;
    if (s.strokes === null) continue;
    m.set(s.holeNumber, s.strokes);
  }
  return m;
}

function pointsForComparison(a: number, b: number): { a: number; b: number } {
  if (a < b) return { a: 1, b: 0 };
  if (b < a) return { a: 0, b: 1 };
  return { a: 0.5, b: 0.5 };
}

// -----------------
// Skins
// -----------------
export function computeSkins(round: Round, game: Game): SkinsResults {
  const playerIds = game.playerIds.length > 0 ? game.playerIds : round.players.map(p => p.id);
  const scoreMaps = new Map<string, Map<number, number>>(
    playerIds.map(pid => [pid, scoreByHole(round.scores, pid)])
  );

  const carryoverEnabled = game.settings.carryover !== false; // default true

  const holeWinners: SkinsResults['holeWinners'] = [];
  const holesWonByPlayer = new Map<string, number[]>(playerIds.map(pid => [pid, []]));

  let carry = 1;
  for (let holeNumber = 1; holeNumber <= 18; holeNumber++) {
    const scoresThisHole: { playerId: string; strokes: number }[] = [];
    for (const pid of playerIds) {
      const strokes = scoreMaps.get(pid)?.get(holeNumber);
      if (typeof strokes === 'number') scoresThisHole.push({ playerId: pid, strokes });
    }

    if (scoresThisHole.length < 2) {
      holeWinners.push({ holeNumber, winnerPlayerId: null, value: carry, carried: carry > 1 });
      continue;
    }

    const min = Math.min(...scoresThisHole.map(s => s.strokes));
    const winners = scoresThisHole.filter(s => s.strokes === min);

    if (winners.length === 1) {
      const winner = winners[0].playerId;
      const value = carry;
      holeWinners.push({ holeNumber, winnerPlayerId: winner, value, carried: carry > 1 });

      const list = holesWonByPlayer.get(winner) ?? [];
      // Record hole number once per skin value (for quick totals + detail)
      for (let i = 0; i < value; i++) list.push(holeNumber);
      holesWonByPlayer.set(winner, list);

      carry = 1;
    } else {
      // tie
      holeWinners.push({ holeNumber, winnerPlayerId: null, value: carry, carried: carry > 1 });
      if (carryoverEnabled) carry += 1;
    }
  }

  const byPlayer = playerIds.map(pid => {
    const holesWon = holesWonByPlayer.get(pid) ?? [];
    return { playerId: pid, skins: holesWon.length, holesWon };
  });

  return { byPlayer, holeWinners };
}

// -----------------
// Best Ball (Four Ball)
// -----------------
export function computeBestBall(round: Round, game: Game): BestBallResults {
  const teams = game.teams ?? [];
  const teamScoresByHole: BestBallResults['teamScoresByHole'] = {};

  for (const t of teams) {
    const holeScores: (number | null)[] = [];
    const maps = t.playerIds.map(pid => scoreByHole(round.scores, pid));

    for (let holeNumber = 1; holeNumber <= 18; holeNumber++) {
      const strokes = maps
        .map(m => m.get(holeNumber))
        .filter((v): v is number => typeof v === 'number');
      holeScores.push(strokes.length ? Math.min(...strokes) : null);
    }

    teamScoresByHole[t.id] = holeScores;
  }

  const totals = teams.map(t => {
    const arr = teamScoresByHole[t.id] ?? [];
    const played = arr.filter(v => typeof v === 'number') as number[];
    return {
      teamId: t.id,
      holesPlayed: played.length,
      total: played.reduce((a, b) => a + b, 0),
    };
  });

  let winnerTeamId: string | null = null;
  const withScores = totals.filter(t => t.holesPlayed > 0);
  if (withScores.length >= 2) {
    const min = Math.min(...withScores.map(t => t.total));
    const w = withScores.filter(t => t.total === min);
    if (w.length === 1) winnerTeamId = w[0].teamId;
  }

  return { teamScoresByHole, totals, winnerTeamId };
}

// -----------------
// Nassau
// -----------------
export function computeNassau(round: Round, game: Game): NassauResults {
  const mode = game.settings.nassauMode ?? 'stroke';
  const scope = game.settings.nassauScope ?? (game.teams?.length ? 'team' : 'individual');

  const competitorIds: string[] =
    scope === 'team'
      ? (game.teams ?? []).map(t => t.id)
      : (game.playerIds.length ? game.playerIds : round.players.map(p => p.id));

  const front9Totals: Record<string, number> = {};
  const back9Totals: Record<string, number> = {};
  const overallTotals: Record<string, number> = {};

  const getCompetitorScores = (competitorId: string, startHole: number, endHole: number): number[] => {
    if (scope === 'team') {
      const team = (game.teams ?? []).find(t => t.id === competitorId);
      if (!team) return [];
      // For Nassau team stroke-play, use Best Ball logic (lowest ball) by default.
      const maps = team.playerIds.map(pid => scoreByHole(round.scores, pid));
      const out: number[] = [];
      for (let h = startHole; h <= endHole; h++) {
        const strokes = maps.map(m => m.get(h)).filter((v): v is number => typeof v === 'number');
        if (strokes.length) out.push(Math.min(...strokes));
      }
      return out;
    }

    const pid = competitorId;
    const m = scoreByHole(round.scores, pid);
    const out: number[] = [];
    for (let h = startHole; h <= endHole; h++) {
      const v = m.get(h);
      if (typeof v === 'number') out.push(v);
    }
    return out;
  };

  for (const id of competitorIds) {
    const front = getCompetitorScores(id, 1, 9);
    const back = getCompetitorScores(id, 10, 18);
    const overall = [...front, ...back];

    front9Totals[id] = front.reduce((a, b) => a + b, 0);
    back9Totals[id] = back.reduce((a, b) => a + b, 0);
    overallTotals[id] = overall.reduce((a, b) => a + b, 0);
  }

  const winnerFor = (totals: Record<string, number>): string | null => {
    const entries = Object.entries(totals);
    if (entries.length < 2) return null;
    const min = Math.min(...entries.map(([, v]) => v));
    const w = entries.filter(([, v]) => v === min);
    if (w.length === 1) return w[0][0];
    return null;
  };

  // Match-play Nassau is not implemented yet; fall back to stroke totals.
  const front9WinnerId = winnerFor(front9Totals);
  const back9WinnerId = winnerFor(back9Totals);
  const overallWinnerId = winnerFor(overallTotals);

  return {
    front9WinnerId,
    back9WinnerId,
    overallWinnerId,
    front9Totals,
    back9Totals,
    overallTotals,
    mode,
    scope,
  };
}

// -----------------
// 3-Point System (2v2)
// -----------------
export function computeThreePoint(round: Round, game: Game): ThreePointResults {
  const teams = game.teams ?? [];
  const teamA = teams[0];
  const teamB = teams[1];

  const teamAId = teamA?.id ?? 'A';
  const teamBId = teamB?.id ?? 'B';

  const pairs = game.settings.threePointPairs;

  const pointsByHoleA: number[] = [];
  const pointsByHoleB: number[] = [];
  const runningA: number[] = [];
  const runningB: number[] = [];
  const holeDetails: ThreePointResults['holeDetails'] = [];

  const scoreMaps = new Map<string, Map<number, number>>(
    (game.playerIds.length ? game.playerIds : round.players.map(p => p.id)).map(pid => [pid, scoreByHole(round.scores, pid)])
  );

  let totalA = 0;
  let totalB = 0;

  for (let holeNumber = 1; holeNumber <= 18; holeNumber++) {
    let holeA = 0;
    let holeB = 0;

    const get = (pid: string | undefined) => (pid ? scoreMaps.get(pid)?.get(holeNumber) : undefined);

    const detail: ThreePointResults['holeDetails'][number] = {
      holeNumber,
      a1vsb1: null,
      a2vsb2: null,
      bestBall: null,
      holeTotal: { teamA: 0, teamB: 0 },
    };

    if (pairs) {
      const a1 = get(pairs.teamAPlayer1Id);
      const b1 = get(pairs.teamBPlayer1Id);
      const a2 = get(pairs.teamAPlayer2Id);
      const b2 = get(pairs.teamBPlayer2Id);

      if (typeof a1 === 'number' && typeof b1 === 'number') {
        const pts = pointsForComparison(a1, b1);
        holeA += pts.a;
        holeB += pts.b;
        detail.a1vsb1 = { teamA: pts.a, teamB: pts.b };
      }

      if (typeof a2 === 'number' && typeof b2 === 'number') {
        const pts = pointsForComparison(a2, b2);
        holeA += pts.a;
        holeB += pts.b;
        detail.a2vsb2 = { teamA: pts.a, teamB: pts.b };
      }

      const aTeam = [a1, a2].filter((v): v is number => typeof v === 'number');
      const bTeam = [b1, b2].filter((v): v is number => typeof v === 'number');
      if (aTeam.length && bTeam.length) {
        const aBest = Math.min(...aTeam);
        const bBest = Math.min(...bTeam);
        const pts = pointsForComparison(aBest, bBest);
        holeA += pts.a;
        holeB += pts.b;
        detail.bestBall = { teamA: pts.a, teamB: pts.b };
      }
    }

    totalA += holeA;
    totalB += holeB;

    pointsByHoleA.push(holeA);
    pointsByHoleB.push(holeB);
    runningA.push(totalA);
    runningB.push(totalB);

    detail.holeTotal = { teamA: holeA, teamB: holeB };
    holeDetails.push(detail);
  }

  return {
    teamAId,
    teamBId,
    teamPointsByHole: { [teamAId]: pointsByHoleA, [teamBId]: pointsByHoleB },
    runningTotalsByHole: { [teamAId]: runningA, [teamBId]: runningB },
    totals: { [teamAId]: totalA, [teamBId]: totalB },
    holeDetails,
  };
}

// -----------------
// Stableford
// -----------------
export function computeStableford(round: Round, game: Game): StablefordResults {
  const playerIds = game.playerIds.length ? game.playerIds : round.players.map(p => p.id);
  const parByHole = new Map<number, number>(round.holes.map(h => [h.number, h.par]));
  const scoreMaps = new Map<string, Map<number, number>>(playerIds.map(pid => [pid, scoreByHole(round.scores, pid)]));

  const pointsFor = (strokes: number, par: number): number => {
    const diff = strokes - par;
    if (diff <= -3) return 5; // albatross or better
    if (diff === -2) return 4; // eagle
    if (diff === -1) return 3; // birdie
    if (diff === 0) return 2; // par
    if (diff === 1) return 1; // bogey
    return 0; // double+ bogey
  };

  const pointsByPlayer = playerIds.map(pid => {
    const m = scoreMaps.get(pid)!;
    const pointsByHole: (number | null)[] = [];
    let total = 0;
    let holesPlayed = 0;

    for (let hole = 1; hole <= 18; hole++) {
      const strokes = m.get(hole);
      const par = parByHole.get(hole);
      if (typeof strokes !== 'number' || typeof par !== 'number') {
        pointsByHole.push(null);
        continue;
      }
      const pts = pointsFor(strokes, par);
      pointsByHole.push(pts);
      total += pts;
      holesPlayed += 1;
    }

    return { playerId: pid, total, pointsByHole, holesPlayed };
  });

  let winnerPlayerId: string | null = null;
  const withScores = pointsByPlayer.filter(p => p.holesPlayed > 0);
  if (withScores.length >= 2) {
    const max = Math.max(...withScores.map(p => p.total));
    const w = withScores.filter(p => p.total === max);
    if (w.length === 1) winnerPlayerId = w[0].playerId;
  }

  return { pointsByPlayer, winnerPlayerId };
}

// -----------------
// Match Play (1v1)
// -----------------
export function computeMatchPlay(round: Round, game: Game): MatchPlayResults {
  const p1 = game.settings.matchPlayPlayers?.player1Id ?? game.playerIds[0];
  const p2 = game.settings.matchPlayPlayers?.player2Id ?? game.playerIds[1];

  const m1 = p1 ? scoreByHole(round.scores, p1) : new Map<number, number>();
  const m2 = p2 ? scoreByHole(round.scores, p2) : new Map<number, number>();

  const holes: MatchPlayResults['holes'] = [];
  let diff = 0;
  let endedAtHole: number | null = null;
  let winnerPlayerId: string | null = null;

  const statusFor = (d: number): string => {
    if (d === 0) return 'AS';
    if (d > 0) return `${d} UP`;
    return `${Math.abs(d)} DN`;
  };

  for (let holeNumber = 1; holeNumber <= 18; holeNumber++) {
    const s1 = m1.get(holeNumber);
    const s2 = m2.get(holeNumber);

    let result: MatchPlayResults['holes'][number]['result'] = 'NO_SCORE';

    if (typeof s1 === 'number' && typeof s2 === 'number') {
      if (s1 < s2) {
        diff += 1;
        result = 'P1';
      } else if (s2 < s1) {
        diff -= 1;
        result = 'P2';
      } else {
        result = 'HALVED';
      }
    }

    const holesRemaining = 18 - holeNumber;
    const ended = endedAtHole === null && Math.abs(diff) > holesRemaining;
    if (ended) {
      endedAtHole = holeNumber;
      winnerPlayerId = diff > 0 ? p1 ?? null : p2 ?? null;
    }

    holes.push({
      holeNumber,
      result,
      matchDiffAfter: diff,
      statusAfter: statusFor(diff),
      ended: endedAtHole !== null && holeNumber >= endedAtHole,
    });
  }

  const currentStatus = statusFor(diff);

  return {
    player1Id: p1 ?? 'P1',
    player2Id: p2 ?? 'P2',
    holes,
    currentStatus: endedAtHole ? `${currentStatus} (Final)` : currentStatus,
    endedAtHole,
    winnerPlayerId,
  };
}

// -----------------
// Wolf (4 players)
// -----------------
export function computeWolf(round: Round, game: Game): WolfResults {
  const order = game.settings.wolfOrderPlayerIds && game.settings.wolfOrderPlayerIds.length === 4
    ? game.settings.wolfOrderPlayerIds
    : (game.playerIds.length === 4 ? game.playerIds : round.players.slice(0, 4).map(p => p.id));

  const choices = game.settings.wolfHoleChoices ?? {};

  const scoreMaps = new Map<string, Map<number, number>>(order.map(pid => [pid, scoreByHole(round.scores, pid)]));
  const totals: Record<string, number> = {};
  for (const pid of order) totals[pid] = 0;

  const holes: WolfResults['holes'] = [];

  for (let holeNumber = 1; holeNumber <= 18; holeNumber++) {
    const wolfPlayerId = order[(holeNumber - 1) % 4];
    const choice = choices[holeNumber] ?? null;

    const delta: Record<string, number> = {};

    const wolfScore = scoreMaps.get(wolfPlayerId)?.get(holeNumber);

    if (choice && typeof wolfScore === 'number') {
      if (choice.mode === 'lone') {
        const others = order.filter(pid => pid !== wolfPlayerId);
        const otherScores = others
          .map(pid => scoreMaps.get(pid)?.get(holeNumber))
          .filter((v): v is number => typeof v === 'number');

        if (otherScores.length) {
          const otherBest = Math.min(...otherScores);
          if (wolfScore < otherBest) {
            delta[wolfPlayerId] = 3;
          } else if (wolfScore > otherBest) {
            delta[wolfPlayerId] = -3;
          } else {
            delta[wolfPlayerId] = 0;
          }
        }
      } else if (choice.mode === 'partner') {
        const partnerId = choice.partnerId;
        if (partnerId && partnerId !== wolfPlayerId && order.includes(partnerId)) {
          const otherTeam = order.filter(pid => pid !== wolfPlayerId && pid !== partnerId);

          const partnerScore = scoreMaps.get(partnerId)?.get(holeNumber);
          const otherScores = otherTeam
            .map(pid => scoreMaps.get(pid)?.get(holeNumber))
            .filter((v): v is number => typeof v === 'number');

          if (typeof partnerScore === 'number' && otherScores.length === 2) {
            const teamWolfBest = Math.min(wolfScore, partnerScore);
            const teamOtherBest = Math.min(...otherScores);
            if (teamWolfBest < teamOtherBest) {
              delta[wolfPlayerId] = 1;
              delta[partnerId] = 1;
            } else if (teamOtherBest < teamWolfBest) {
              for (const pid of otherTeam) delta[pid] = 1;
            }
          }
        }
      }
    }

    // apply deltas
    for (const [pid, d] of Object.entries(delta)) {
      totals[pid] = (totals[pid] ?? 0) + d;
    }

    holes.push({
      holeNumber,
      wolfPlayerId,
      choice,
      pointsDelta: delta,
      totalsAfter: { ...totals },
    });
  }

  return { orderPlayerIds: order, holes, totals };
}
