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

export interface GameResults {
  skins?: SkinsResults;
  bestBall?: BestBallResults;
  nassau?: NassauResults;
  // stubs for later
  scramble?: unknown;
  wolf?: unknown;
  threePoint?: unknown;
}

export function computeGameResults(round: Round, game: Game): GameResults {
  switch (game.format) {
    case 'skins':
      return { skins: computeSkins(round, game) };
    case 'bestBall':
      return { bestBall: computeBestBall(round, game) };
    case 'nassau':
      return { nassau: computeNassau(round, game) };
    case 'scramble':
    case 'wolf':
    case 'threePoint':
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
    scope === 'team' ? (game.teams ?? []).map(t => t.id) : (game.playerIds.length ? game.playerIds : round.players.map(p => p.id));

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
