import { Game, Round, Score } from './types';

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

export interface StablefordResults {
  byPlayer: { playerId: string; points: number; holesPlayed: number }[];
  pointsByHole: Record<string, (number | null)[]>; // playerId -> 18-length
  scoring: 'stableford' | 'modifiedStableford';
}

export interface MatchPlayResults {
  player1Id: string;
  player2Id: string;
  holeResults: { holeNumber: number; winnerPlayerId: string | null; statusAfter: string }[];
  currentStatus: string; // e.g. "A/S", "2 up", "1 dn"
  holesPlayed: number;
}

export interface ThreePointResults {
  teamAId: string;
  teamBId: string;
  pairings: {
    teamAPlayer1Id: string;
    teamAPlayer2Id: string;
    teamBPlayer1Id: string;
    teamBPlayer2Id: string;
  };
  holePoints: {
    holeNumber: number;
    a1Points: number;
    b1Points: number;
    a2Points: number;
    b2Points: number;
    bestBallA: number;
    bestBallB: number;
  }[];
  totals: { teamId: string; points: number }[];
}

export interface GameResults {
  skins?: SkinsResults;
  bestBall?: BestBallResults;
  nassau?: NassauResults;
  stableford?: StablefordResults;
  modifiedStableford?: StablefordResults;
  matchPlay?: MatchPlayResults;
  threePoint?: ThreePointResults;
  // stubs for later
  scramble?: unknown;
  wolf?: unknown;
  bingoBangoBongo?: unknown;
  vegas?: unknown;
  hammer?: unknown;
  rabbit?: unknown;
  trash?: unknown;
  chicago?: unknown;
  defender?: unknown;
}

export function computeGameResults(round: Round, game: Game): GameResults {
  switch (game.format) {
    case 'skins':
      return { skins: computeSkins(round, game) };
    case 'bestBall':
      return { bestBall: computeBestBall(round, game) };
    case 'nassau':
      return { nassau: computeNassau(round, game) };
    case 'stableford':
      return { stableford: computeStableford(round, game, 'stableford') };
    case 'modifiedStableford':
      return { modifiedStableford: computeStableford(round, game, 'modifiedStableford') };
    case 'matchPlay':
      return { matchPlay: computeMatchPlay(round, game) };
    case 'threePoint':
      return { threePoint: computeThreePoint(round, game) };
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

function parByHole(round: Round): Map<number, number> {
  return new Map<number, number>(round.holes.map(h => [h.number, h.par]));
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
      for (let i = 0; i < value; i++) list.push(holeNumber);
      holesWonByPlayer.set(winner, list);

      carry = 1;
    } else {
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
      // Team Nassau defaults to best-ball total.
      const maps = team.playerIds.map(pid => scoreByHole(round.scores, pid));
      const out: number[] = [];
      for (let h = startHole; h <= endHole; h++) {
        const strokes = maps.map(m => m.get(h)).filter((v): v is number => typeof v === 'number');
        if (strokes.length) out.push(Math.min(...strokes));
      }
      return out;
    }

    const m = scoreByHole(round.scores, competitorId);
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

  // Match-play Nassau is stubbed; stroke totals used.
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
// Stableford + Modified Stableford
// -----------------
export function computeStableford(round: Round, game: Game, scoring: 'stableford' | 'modifiedStableford'): StablefordResults {
  const playerIds = game.playerIds.length ? game.playerIds : round.players.map(p => p.id);
  const pars = parByHole(round);

  const pointsByHole: StablefordResults['pointsByHole'] = {};
  const byPlayer: StablefordResults['byPlayer'] = [];

  for (const pid of playerIds) {
    const m = scoreByHole(round.scores, pid);
    const holePoints: (number | null)[] = [];

    for (let h = 1; h <= 18; h++) {
      const strokes = m.get(h);
      const par = pars.get(h);
      if (typeof strokes !== 'number' || typeof par !== 'number') {
        holePoints.push(null);
        continue;
      }
      const diff = strokes - par;

      let pts = 0;
      if (scoring === 'stableford') {
        // double bogey+ = 0, bogey=1, par=2, birdie=3, eagle=4, albatross=5
        if (diff <= -3) pts = 5;
        else if (diff === -2) pts = 4;
        else if (diff === -1) pts = 3;
        else if (diff === 0) pts = 2;
        else if (diff === 1) pts = 1;
        else pts = 0;
      } else {
        // Modified Stableford: bogey=-1, par=0, birdie=+2, eagle=+5, double eagle=+8
        if (diff <= -3) pts = 8;
        else if (diff === -2) pts = 5;
        else if (diff === -1) pts = 2;
        else if (diff === 0) pts = 0;
        else if (diff === 1) pts = -1;
        else pts = -1; // treat worse than bogey as -1 (common variant)
      }

      holePoints.push(pts);
    }

    pointsByHole[pid] = holePoints;
    const played = holePoints.filter(v => typeof v === 'number') as number[];
    byPlayer.push({ playerId: pid, points: played.reduce((a, b) => a + b, 0), holesPlayed: played.length });
  }

  byPlayer.sort((a, b) => b.points - a.points);

  return { byPlayer, pointsByHole, scoring };
}

// -----------------
// Match Play (1v1)
// -----------------
export function computeMatchPlay(round: Round, game: Game): MatchPlayResults {
  const [p1, p2] = game.playerIds;
  const m1 = scoreByHole(round.scores, p1);
  const m2 = scoreByHole(round.scores, p2);

  let diff = 0; // positive => p1 up
  let holesPlayed = 0;

  const holeResults: MatchPlayResults['holeResults'] = [];
  for (let h = 1; h <= 18; h++) {
    const s1 = m1.get(h);
    const s2 = m2.get(h);
    if (typeof s1 !== 'number' || typeof s2 !== 'number') {
      holeResults.push({ holeNumber: h, winnerPlayerId: null, statusAfter: formatMatchStatus(diff) });
      continue;
    }

    holesPlayed += 1;
    let winner: string | null = null;
    if (s1 < s2) {
      diff += 1;
      winner = p1;
    } else if (s2 < s1) {
      diff -= 1;
      winner = p2;
    }

    holeResults.push({ holeNumber: h, winnerPlayerId: winner, statusAfter: formatMatchStatus(diff) });
  }

  return {
    player1Id: p1,
    player2Id: p2,
    holeResults,
    currentStatus: formatMatchStatus(diff),
    holesPlayed,
  };
}

function formatMatchStatus(diff: number): string {
  if (diff === 0) return 'A/S';
  if (diff > 0) return `${diff} up`;
  return `${Math.abs(diff)} dn`;
}

// -----------------
// 3-Point System (2v2) - corrected rules
// -----------------
export function computeThreePoint(round: Round, game: Game): ThreePointResults {
  const teams = game.teams ?? [];
  const teamA = teams[0];
  const teamB = teams[1];

  const fallbackTeamAId = teamA?.id ?? 'A';
  const fallbackTeamBId = teamB?.id ?? 'B';

  const pairings = game.settings.threePointPairs;
  if (!pairings) {
    return {
      teamAId: fallbackTeamAId,
      teamBId: fallbackTeamBId,
      pairings: {
        teamAPlayer1Id: teamA?.playerIds?.[0] ?? '',
        teamAPlayer2Id: teamA?.playerIds?.[1] ?? '',
        teamBPlayer1Id: teamB?.playerIds?.[0] ?? '',
        teamBPlayer2Id: teamB?.playerIds?.[1] ?? '',
      },
      holePoints: [],
      totals: [
        { teamId: fallbackTeamAId, points: 0 },
        { teamId: fallbackTeamBId, points: 0 },
      ],
    };
  }

  const a1 = scoreByHole(round.scores, pairings.teamAPlayer1Id);
  const a2 = scoreByHole(round.scores, pairings.teamAPlayer2Id);
  const b1 = scoreByHole(round.scores, pairings.teamBPlayer1Id);
  const b2 = scoreByHole(round.scores, pairings.teamBPlayer2Id);

  const holePoints: ThreePointResults['holePoints'] = [];

  let teamAPoints = 0;
  let teamBPoints = 0;

  const award = (sa: number | undefined, sb: number | undefined): { a: number; b: number } => {
    if (typeof sa !== 'number' || typeof sb !== 'number') return { a: 0, b: 0 };
    if (sa < sb) return { a: 1, b: 0 };
    if (sb < sa) return { a: 0, b: 1 };
    return { a: 0.5, b: 0.5 };
  };

  for (let h = 1; h <= 18; h++) {
    const sa1 = a1.get(h);
    const sb1 = b1.get(h);
    const sa2 = a2.get(h);
    const sb2 = b2.get(h);

    const m1 = award(sa1, sb1);
    const m2 = award(sa2, sb2);

    const bestA = [sa1, sa2].filter((v): v is number => typeof v === 'number');
    const bestB = [sb1, sb2].filter((v): v is number => typeof v === 'number');

    const bestBall = award(bestA.length ? Math.min(...bestA) : undefined, bestB.length ? Math.min(...bestB) : undefined);

    teamAPoints += m1.a + m2.a + bestBall.a;
    teamBPoints += m1.b + m2.b + bestBall.b;

    holePoints.push({
      holeNumber: h,
      a1Points: m1.a,
      b1Points: m1.b,
      a2Points: m2.a,
      b2Points: m2.b,
      bestBallA: bestBall.a,
      bestBallB: bestBall.b,
    });
  }

  return {
    teamAId: fallbackTeamAId,
    teamBId: fallbackTeamBId,
    pairings,
    holePoints,
    totals: [
      { teamId: fallbackTeamAId, points: teamAPoints },
      { teamId: fallbackTeamBId, points: teamBPoints },
    ],
  };
}
