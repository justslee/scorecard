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

/** Per-segment match-play state for match-mode Nassau. */
export interface NassauMatchSegment {
  /** Number of holes (in the segment) where both competitors had a score. */
  holesPlayed: number;
  /** Running match diff: positive = competitorIds[0] leads, negative = [1] leads. */
  matchDiff: number;
  /** Human-readable status: "AS", "3 UP", "5 & 4", etc. */
  statusLabel: string;
  /** Competitor ID currently leading this segment, or null if tied (AS). */
  leaderId: string | null;
  /** Hole number where the segment was mathematically clinched (null = still live). */
  closedAt: number | null;
  /** True if the segment is over (can't be recovered). */
  closed: boolean;
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
  /** Populated only when mode='match'. Hole-by-hole match state per segment. */
  front9Match?: NassauMatchSegment;
  back9Match?: NassauMatchSegment;
  overallMatch?: NassauMatchSegment;
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

// -----------------
// Scramble
// -----------------
/** Team format: each hole score = team's best (lowest) ball, mirroring how
 *  scramble play works — everyone picks up after the chosen shot is taken. */
export interface ScrambleResults {
  teamScoresByHole: Record<string, (number | null)[]>; // teamId → 18-length array
  totals: { teamId: string; total: number; holesPlayed: number }[];
  winnerTeamId: string | null;
}

// -----------------
// BingoBangoBongo
// -----------------
/** Bingo (first on green) · Bango (closest once all on) · Bongo (first to hole out).
 *  All three events require shot-by-shot tracking not captured in the current data
 *  model (strokes total only). Results are unavailable until event capture ships. */
export interface BingoBangoBongoResults {
  playerIds: string[];
  /** Points per player — always empty until event capture is added. */
  totals: Record<string, number>;
  dataLimitations: string[];
}

// -----------------
// Vegas
// -----------------
/** Team pair format: each team combines its two players' scores into a 2-digit
 *  number (lower score = tens digit), then the difference × pointValue is wagered. */
export interface VegasResults {
  teamAId: string;
  teamBId: string;
  holes: {
    holeNumber: number;
    /** Combined 2-digit score for team A (e.g., scores 4 & 5 → 45). */
    teamANumber: number | null;
    teamBNumber: number | null;
    /** teamBNumber − teamANumber; positive means Team A has the lower number and wins. */
    diff: number | null;
    winnerTeamId: string | null;
  }[];
  /** Cumulative points won/lost per team (net; wager format). */
  totals: Record<string, number>;
}

// -----------------
// Hammer
// -----------------
/** Press/doubling game where any player can "throw the hammer" to double the stakes.
 *  Per-hole multipliers are stored in game.settings.hammerMultiplierByHole (default 1).
 *  Live hammer-throw events need per-hole event capture (follow-up item). */
export interface HammerResults {
  playerIds: string[];
  holes: {
    holeNumber: number;
    /** Active multiplier for this hole (1 if no hammer thrown). */
    multiplier: number;
    /** Player with lowest score, or null on a tie. */
    winnerPlayerId: string | null;
    /** Points transferred (multiplier × pointValue); 0 on a tie. */
    points: number;
  }[];
  /** Net cumulative points per player (wager format — sums to zero). */
  totals: Record<string, number>;
  dataLimitations: string[];
}

// -----------------
// Rabbit
// -----------------
/** Win a hole outright to "capture" the rabbit; the rabbit transfers to whoever
 *  wins the next outright hole. Front-9 and back-9 holders each win a segment. */
export interface RabbitResults {
  playerIds: string[];
  holes: {
    holeNumber: number;
    /** Player who won this hole outright (null on a tie / no score). */
    outright: string | null;
    /** Who holds the rabbit after this hole resolves. */
    holder: string | null;
    /** True when the rabbit changed hands on this hole. */
    changed: boolean;
  }[];
  /** Rabbit holder at end of hole 9. */
  front9HolderId: string | null;
  /** Rabbit holder at end of hole 18. */
  back9HolderId: string | null;
}

// -----------------
// Trash / Junk
// -----------------
/** Point game for scoring achievements computable from stroke data:
 *  birdie = pointValue, eagle = 2×, albatross = 3×.
 *  Greenies, sandies, barkies, and snakes need per-shot event capture. */
export interface TrashResults {
  playerIds: string[];
  events: {
    type: 'birdie' | 'eagle' | 'albatross';
    playerId: string;
    holeNumber: number;
    /** Points awarded for this event. */
    pointValue: number;
  }[];
  /** Total trash points per player. */
  totals: Record<string, number>;
  dataLimitations: string[];
}

// -----------------
// Chicago
// -----------------
/** Quota-based stableford variant: each player's quota = chicagoQuotaBase − handicap.
 *  Points: bogey=1, par=2, birdie=4, eagle=8, albatross=16.
 *  Net = total stableford points − quota; highest net wins. */
export interface ChicagoResults {
  playerIds: string[];
  /** Each player's pre-round quota (base − handicap). */
  quotas: Record<string, number>;
  pointsByHole: { holeNumber: number; points: Record<string, number | null> }[];
  /** Total stableford points per player (before subtracting quota). */
  totals: Record<string, number>;
  /** total − quota; positive = beat quota. */
  netVsQuota: Record<string, number>;
  /** Player with the highest netVsQuota, or null on a tie. */
  winnerPlayerId: string | null;
}

// -----------------
// Defender
// -----------------
/** One player defends each hole against the field. If the defender has the
 *  sole lowest score they earn pointValue per challenger beaten; otherwise
 *  each beater earns pointValue from the defender. Defender rotates each hole
 *  unless game.settings.defenderPlayerId is set for a fixed defender. */
export interface DefenderResults {
  holes: {
    holeNumber: number;
    /** The player defending this hole. */
    defenderId: string;
    /** 'defended' = sole low score; 'beaten' = at least one challenger lower; 'no_score' = incomplete. */
    result: 'defended' | 'beaten' | 'no_score';
    /** Players who scored lower than the defender on this hole. */
    beaterIds: string[];
    /** Points delta for the defender on this hole (positive = won, negative = lost). */
    defenderDelta: number;
  }[];
  /** Cumulative net points per player. */
  totals: Record<string, number>;
}

export interface GameResults {
  skins?: SkinsResults;
  bestBall?: BestBallResults;
  nassau?: NassauResults;
  threePoint?: ThreePointResults;
  stableford?: StablefordResults;
  matchPlay?: MatchPlayResults;
  wolf?: WolfResults;
  scramble?: ScrambleResults;
  bingoBangoBongo?: BingoBangoBongoResults;
  vegas?: VegasResults;
  hammer?: HammerResults;
  rabbit?: RabbitResults;
  trash?: TrashResults;
  chicago?: ChicagoResults;
  defender?: DefenderResults;
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
    case 'scramble':
      return { scramble: computeScramble(round, game) };
    case 'bingoBangoBongo':
      return { bingoBangoBongo: computeBingoBangoBongo(round, game) };
    case 'vegas':
      return { vegas: computeVegas(round, game) };
    case 'hammer':
      return { hammer: computeHammer(round, game) };
    case 'rabbit':
      return { rabbit: computeRabbit(round, game) };
    case 'trash':
      return { trash: computeTrash(round, game) };
    case 'chicago':
      return { chicago: computeChicago(round, game) };
    case 'defender':
      return { defender: computeDefender(round, game) };
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

  // ----- Match-play Nassau -----
  if (mode === 'match' && competitorIds.length >= 2) {
    const [aId, bId] = competitorIds;

    /** Gross score for a competitor on a single hole.
     *  Individual: raw strokes. Team: best-ball (same as stroke mode). */
    const holeScore = (competitorId: string, holeNumber: number): number | undefined => {
      if (scope === 'team') {
        const team = (game.teams ?? []).find(t => t.id === competitorId);
        if (!team) return undefined;
        const maps = team.playerIds.map(pid => scoreByHole(round.scores, pid));
        const strokes = maps.map(m => m.get(holeNumber)).filter((v): v is number => typeof v === 'number');
        return strokes.length ? Math.min(...strokes) : undefined;
      }
      return scoreByHole(round.scores, competitorId).get(holeNumber);
    };

    /** Compute match-play state for one segment (startHole..endHole, inclusive).
     *
     *  Close-check fires only when BOTH players have a score on the current hole.
     *  This prevents unscored holes from spuriously closing an in-progress match.
     *  "Holes remaining" = segmentLength − holesPlayed (same as real golf: remaining
     *  holes to be played, not just holes after the current index). */
    const computeMatchSeg = (startHole: number, endHole: number): NassauMatchSegment => {
      const segmentLength = endHole - startHole + 1;
      let diff = 0; // positive = A leads
      let holesPlayed = 0;
      let closedAt: number | null = null;
      let diffAtClose: number | null = null; // diff at the moment of closure

      for (let h = startHole; h <= endHole; h++) {
        const sA = holeScore(aId, h);
        const sB = holeScore(bId, h);

        if (typeof sA === 'number' && typeof sB === 'number') {
          holesPlayed++;
          if (sA < sB) diff++;
          else if (sB < sA) diff--;
          // tie: halved — no change to diff

          // Close-check: only after a scored hole.
          // Remaining = total segment holes − played so far.
          const holesRemainingInSeg = segmentLength - holesPlayed;
          if (closedAt === null && Math.abs(diff) > holesRemainingInSeg) {
            closedAt = h;
            diffAtClose = diff; // freeze the lead at closure
          }
        }
      }

      const closed = closedAt !== null;
      // Leader is the competitor ahead at closure (if closed) or currently ahead.
      const effectiveDiff = closed ? diffAtClose! : diff;
      const leaderId: string | null = effectiveDiff > 0 ? aId : effectiveDiff < 0 ? bId : null;

      let statusLabel: string;
      if (holesPlayed === 0) {
        statusLabel = '—';
      } else if (closed) {
        const lead = Math.abs(diffAtClose!);
        const remaining = endHole - closedAt!;
        // "X & Y" when holes remain; "X UP" when segment ends exactly on the last hole.
        // Always uppercase so raw label is consistent — LeaderboardSheet may also apply
        // textTransform:uppercase but GameResults/GameLeaderboards render it raw.
        statusLabel = remaining === 0 ? `${lead} UP` : `${lead} & ${remaining}`;
      } else if (diff === 0) {
        statusLabel = 'AS';
      } else {
        statusLabel = `${Math.abs(diff)} UP`;
      }

      // NOTE: `matchDiff` is the RAW running diff after all iterated holes
      // (continues past the close point). Use `leaderId` / `statusLabel` / `diffAtClose`
      // (frozen) for results display; `matchDiff` is only useful for hole-by-hole replay.
      return { holesPlayed, matchDiff: diff, statusLabel, leaderId, closedAt, closed };
    };

    const front9Match = computeMatchSeg(1, 9);
    const back9Match = computeMatchSeg(10, 18);
    const overallMatch = computeMatchSeg(1, 18);

    // Winner IDs come from match-play leaders (null = AS = no leader yet)
    return {
      front9WinnerId: front9Match.leaderId,
      back9WinnerId: back9Match.leaderId,
      overallWinnerId: overallMatch.leaderId,
      front9Totals,
      back9Totals,
      overallTotals,
      mode,
      scope,
      front9Match,
      back9Match,
      overallMatch,
    };
  }

  // ----- Stroke-play Nassau (default) -----
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
/**
 * Every hole's `pointsDelta` sums to 0 — lone win: wolf +3 / each of the 3 opponents
 * −1; lone loss: mirror; partner win: winners +1 each / losers −1 each; partner loss:
 * mirror. Ties and any hole with incomplete data (missing pick, missing wolf score,
 * or — for a lone hole — fewer than all 3 opponent scores) emit an EMPTY delta, not a
 * `+0` entry. This is a money invariant: `settlement.ts` settles wolf by multiplying
 * `totals` by `pointValue`, so a non-zero-sum `totals` would fabricate or destroy money.
 */
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

        // Require all 3 opponent scores: you cannot debit a player −1 who has no
        // score for the hole, and letting the payout vary with data completeness
        // would make identical wins pay differently (tightened vs. the old
        // "any available opponent" path — no existing test relied on the loose path).
        if (otherScores.length === 3) {
          const otherBest = Math.min(...otherScores);
          if (wolfScore < otherBest) {
            delta[wolfPlayerId] = 3;
            for (const pid of others) delta[pid] = -1;
          } else if (wolfScore > otherBest) {
            delta[wolfPlayerId] = -3;
            for (const pid of others) delta[pid] = 1;
          }
          // tie — no entries (empty delta, not a +0 write)
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
              for (const pid of otherTeam) delta[pid] = -1;
            } else if (teamOtherBest < teamWolfBest) {
              for (const pid of otherTeam) delta[pid] = 1;
              delta[wolfPlayerId] = -1;
              delta[partnerId] = -1;
            }
            // tie — no entries
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

// -----------------
// Scramble
// -----------------
/** Mirrors computeBestBall: team score per hole = lowest individual score on the team.
 *  In a real scramble all players hit from the chosen best spot, so the recorded
 *  scores should already reflect the team's best effort — taking the min is the
 *  standard approximation when only a single stroke count is stored per player. */
export function computeScramble(round: Round, game: Game): ScrambleResults {
  const teams = game.teams ?? [];
  const teamScoresByHole: ScrambleResults['teamScoresByHole'] = {};

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
    const played = arr.filter((v): v is number => typeof v === 'number');
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
// BingoBangoBongo
// -----------------
/** All three events (Bingo/Bango/Bongo) require shot-by-shot event data that is
 *  not present in the current Score model (strokes total per hole only). This
 *  function returns a well-typed stub so the UI can render a clear "needs event
 *  capture" message rather than silently falling through to the generic fallback. */
export function computeBingoBangoBongo(round: Round, game: Game): BingoBangoBongoResults {
  const playerIds = game.playerIds.length ? game.playerIds : round.players.map(p => p.id);
  const totals: Record<string, number> = {};
  for (const pid of playerIds) totals[pid] = 0;
  return {
    playerIds,
    totals,
    dataLimitations: [
      'Bingo (first player to reach the green) — requires shot-by-shot green tracking',
      'Bango (closest to pin once all are on the green) — requires proximity event capture',
      'Bongo (first to hole out) — requires holing-out order event capture',
    ],
  };
}

// -----------------
// Vegas
// -----------------
/** Each team combines its two players' scores into a 2-digit number (low score
 *  as the tens digit, high as the units, e.g., 4 & 5 → 45). The hole winner is
 *  the team with the smaller number; the difference × pointValue is the wager. */
export function computeVegas(round: Round, game: Game): VegasResults {
  const teams = game.teams ?? [];
  const teamA = teams[0];
  const teamB = teams[1];
  const teamAId = teamA?.id ?? 'A';
  const teamBId = teamB?.id ?? 'B';
  const pointValue = game.settings.pointValue ?? 1;

  const mapsA = (teamA?.playerIds ?? []).map(pid => scoreByHole(round.scores, pid));
  const mapsB = (teamB?.playerIds ?? []).map(pid => scoreByHole(round.scores, pid));

  const totals: Record<string, number> = { [teamAId]: 0, [teamBId]: 0 };

  /** Combine two (or more) scores into a Vegas number — lowest two digits, low first. */
  const vegasNumber = (scores: number[]): number | null => {
    if (scores.length < 2) return null;
    const sorted = [...scores].sort((a, b) => a - b);
    return sorted[0] * 10 + sorted[1];
  };

  const holes: VegasResults['holes'] = [];

  for (let holeNumber = 1; holeNumber <= 18; holeNumber++) {
    const aScores = mapsA.map(m => m.get(holeNumber)).filter((v): v is number => typeof v === 'number');
    const bScores = mapsB.map(m => m.get(holeNumber)).filter((v): v is number => typeof v === 'number');

    const teamANumber = vegasNumber(aScores);
    const teamBNumber = vegasNumber(bScores);

    let diff: number | null = null;
    let winnerTeamId: string | null = null;

    if (teamANumber !== null && teamBNumber !== null) {
      // positive diff → Team A has smaller number → Team A wins
      diff = teamBNumber - teamANumber;
      if (diff > 0) {
        winnerTeamId = teamAId;
        totals[teamAId] += diff * pointValue;
        totals[teamBId] -= diff * pointValue;
      } else if (diff < 0) {
        winnerTeamId = teamBId;
        totals[teamBId] += Math.abs(diff) * pointValue;
        totals[teamAId] -= Math.abs(diff) * pointValue;
      }
      // diff === 0: push, no exchange
    }

    holes.push({ holeNumber, teamANumber, teamBNumber, diff, winnerTeamId });
  }

  return { teamAId, teamBId, holes, totals };
}

// -----------------
// Hammer
// -----------------
/** Head-to-head (or multi-player) doubling game. Per-hole multiplier is read from
 *  game.settings.hammerMultiplierByHole (default 1 for every hole). The hole winner
 *  (sole lowest score) earns multiplier × pointValue from each loser. Ties push.
 *
 *  Follow-up: live hammer-throw events (who throws/accepts per hole) need a
 *  per-hole event capture UI and a new HammerHoleEvent type in the data model. */
export function computeHammer(round: Round, game: Game): HammerResults {
  const playerIds = game.playerIds.length ? game.playerIds : round.players.map(p => p.id);
  const pointValue = game.settings.pointValue ?? 1;
  const multipliersByHole = game.settings.hammerMultiplierByHole ?? {};

  const scoreMaps = new Map<string, Map<number, number>>(
    playerIds.map(pid => [pid, scoreByHole(round.scores, pid)])
  );

  const totals: Record<string, number> = {};
  for (const pid of playerIds) totals[pid] = 0;

  const holes: HammerResults['holes'] = [];

  for (let holeNumber = 1; holeNumber <= 18; holeNumber++) {
    const multiplier = multipliersByHole[holeNumber] ?? 1;
    const scoresThisHole: { playerId: string; strokes: number }[] = [];

    for (const pid of playerIds) {
      const strokes = scoreMaps.get(pid)?.get(holeNumber);
      if (typeof strokes === 'number') scoresThisHole.push({ playerId: pid, strokes });
    }

    let winnerPlayerId: string | null = null;
    let points = 0;

    if (scoresThisHole.length >= 2) {
      const min = Math.min(...scoresThisHole.map(s => s.strokes));
      const winners = scoresThisHole.filter(s => s.strokes === min);

      if (winners.length === 1) {
        winnerPlayerId = winners[0].playerId;
        const losers = scoresThisHole.filter(s => s.strokes > min);
        points = multiplier * pointValue;
        // Winner collects `points` from each loser.
        for (const loser of losers) {
          totals[winnerPlayerId] += points;
          totals[loser.playerId] -= points;
        }
      }
      // ties: push — no exchange
    }

    holes.push({ holeNumber, multiplier, winnerPlayerId, points });
  }

  return {
    playerIds,
    holes,
    totals,
    dataLimitations: [
      'Hammer throws (doubling events) are not tracked per-hole. ' +
      'Record multipliers in game.settings.hammerMultiplierByHole or add live ' +
      'event capture for throw/accept/concede per hole.',
    ],
  };
}

// -----------------
// Rabbit
// -----------------
/** Win a hole outright (sole lowest score) to capture the rabbit. The rabbit
 *  transfers immediately to whoever wins the next outright hole (even if the
 *  current holder is not the one who lost — the common "direct transfer" variant).
 *  Ties leave the rabbit with its current holder (or still free if not yet captured).
 *  Front-9 and back-9 holders win a segment each. */
export function computeRabbit(round: Round, game: Game): RabbitResults {
  const playerIds = game.playerIds.length ? game.playerIds : round.players.map(p => p.id);
  const scoreMaps = new Map<string, Map<number, number>>(
    playerIds.map(pid => [pid, scoreByHole(round.scores, pid)])
  );

  let holder: string | null = null;
  let front9HolderId: string | null = null;
  const holes: RabbitResults['holes'] = [];

  for (let holeNumber = 1; holeNumber <= 18; holeNumber++) {
    const scoresThisHole: { playerId: string; strokes: number }[] = [];
    for (const pid of playerIds) {
      const strokes = scoreMaps.get(pid)?.get(holeNumber);
      if (typeof strokes === 'number') scoresThisHole.push({ playerId: pid, strokes });
    }

    let outright: string | null = null;
    let changed = false;

    if (scoresThisHole.length >= 2) {
      const min = Math.min(...scoresThisHole.map(s => s.strokes));
      const winners = scoresThisHole.filter(s => s.strokes === min);

      if (winners.length === 1) {
        outright = winners[0].playerId;
        if (holder !== outright) {
          holder = outright; // rabbit transfers (or is captured for the first time)
          changed = true;
        }
        // Holder wins again → keep, no change flag
      }
      // tie: rabbit stays with current holder, no change
    }

    if (holeNumber === 9) front9HolderId = holder;
    holes.push({ holeNumber, outright, holder, changed });
  }

  return { playerIds, holes, front9HolderId, back9HolderId: holder };
}

// -----------------
// Trash / Junk
// -----------------
/** Awards points for scoring achievements derivable from stroke + par data.
 *  Birdie = 1×pointValue, Eagle = 2×, Albatross = 3×.
 *
 *  Follow-up (needs event capture per-shot):
 *    - Greenie: closest to pin on a par-3 in regulation
 *    - Sandy: up-and-down from a bunker for par or better
 *    - Barkie: par or better after hitting a tree
 *    - Snake: three-putt (needs per-hole putt count) */
export function computeTrash(round: Round, game: Game): TrashResults {
  const playerIds = game.playerIds.length ? game.playerIds : round.players.map(p => p.id);
  const pointValue = game.settings.pointValue ?? 1;
  const parByHole = new Map<number, number>(round.holes.map(h => [h.number, h.par]));
  const scoreMaps = new Map<string, Map<number, number>>(
    playerIds.map(pid => [pid, scoreByHole(round.scores, pid)])
  );

  const events: TrashResults['events'] = [];
  const totals: Record<string, number> = {};
  for (const pid of playerIds) totals[pid] = 0;

  for (const pid of playerIds) {
    const m = scoreMaps.get(pid)!;
    for (let hole = 1; hole <= 18; hole++) {
      const strokes = m.get(hole);
      const par = parByHole.get(hole);
      if (typeof strokes !== 'number' || typeof par !== 'number') continue;

      const diff = strokes - par;
      if (diff === -1) {
        events.push({ type: 'birdie', playerId: pid, holeNumber: hole, pointValue });
        totals[pid] += pointValue;
      } else if (diff === -2) {
        events.push({ type: 'eagle', playerId: pid, holeNumber: hole, pointValue: pointValue * 2 });
        totals[pid] += pointValue * 2;
      } else if (diff <= -3) {
        events.push({ type: 'albatross', playerId: pid, holeNumber: hole, pointValue: pointValue * 3 });
        totals[pid] += pointValue * 3;
      }
    }
  }

  return {
    playerIds,
    events,
    totals,
    dataLimitations: [
      'Greenie (closest to pin on par-3 in regulation) — needs proximity event capture',
      'Sandy (up-and-down from bunker for par or better) — needs bunker event capture',
      'Barkie (par or better after hitting a tree) — needs tree/penalty event capture',
      'Snake (three-putt) — needs per-hole putt count',
    ],
  };
}

// -----------------
// Chicago
// -----------------
/** Quota-based stableford (standard points: bogey=1, par=2, birdie=4, eagle=8,
 *  albatross=16). Each player's quota = chicagoQuotaBase (default 39) − handicap.
 *  Net vs quota = total stableford points − quota; highest net wins. */
export function computeChicago(round: Round, game: Game): ChicagoResults {
  const playerIds = game.playerIds.length ? game.playerIds : round.players.map(p => p.id);
  const parByHole = new Map<number, number>(round.holes.map(h => [h.number, h.par]));
  const quotaBase = game.settings.chicagoQuotaBase ?? 39;

  const quotas: Record<string, number> = {};
  for (const pid of playerIds) {
    const player = round.players.find(p => p.id === pid);
    const handicap = player?.handicap ?? 0;
    quotas[pid] = Math.max(0, quotaBase - Math.round(handicap));
  }

  const scoreMaps = new Map<string, Map<number, number>>(
    playerIds.map(pid => [pid, scoreByHole(round.scores, pid)])
  );

  const chicagoPoints = (strokes: number, par: number): number => {
    const diff = strokes - par;
    if (diff <= -3) return 16; // albatross or better
    if (diff === -2) return 8;  // eagle
    if (diff === -1) return 4;  // birdie
    if (diff === 0) return 2;   // par
    if (diff === 1) return 1;   // bogey
    return 0;                   // double bogey or worse
  };

  const pointsByHole: ChicagoResults['pointsByHole'] = [];
  const totals: Record<string, number> = {};
  for (const pid of playerIds) totals[pid] = 0;

  for (let hole = 1; hole <= 18; hole++) {
    const points: Record<string, number | null> = {};
    const par = parByHole.get(hole);

    for (const pid of playerIds) {
      const strokes = scoreMaps.get(pid)?.get(hole);
      if (typeof strokes === 'number' && typeof par === 'number') {
        const pts = chicagoPoints(strokes, par);
        points[pid] = pts;
        totals[pid] += pts;
      } else {
        points[pid] = null;
      }
    }

    pointsByHole.push({ holeNumber: hole, points });
  }

  const netVsQuota: Record<string, number> = {};
  for (const pid of playerIds) netVsQuota[pid] = (totals[pid] ?? 0) - (quotas[pid] ?? 0);

  let winnerPlayerId: string | null = null;
  const playersWithAnyScore = playerIds.filter(pid => totals[pid] > 0 || playerIds.length >= 2);
  if (playersWithAnyScore.length >= 2) {
    const maxNet = Math.max(...playerIds.map(pid => netVsQuota[pid]));
    const winners = playerIds.filter(pid => netVsQuota[pid] === maxNet);
    if (winners.length === 1) winnerPlayerId = winners[0];
  }

  return { playerIds, quotas, pointsByHole, totals, netVsQuota, winnerPlayerId };
}

// -----------------
// Defender
// -----------------
/** One player defends each hole against the field. Defender is either fixed
 *  (game.settings.defenderPlayerId) or rotates by (holeNumber − 1) % playerIds.length.
 *  Defender wins sole-low → earns pointValue per challenged player who has a score.
 *  Any challenger scores lower than the defender → each earns pointValue from the defender.
 *  Ties on the low score (defender ties with a challenger) count as the defender NOT winning.
 *
 *  Settlement note: this is a wager format — net totals should feed computeGameNetWinnings
 *  once the settlement branch adds support for this format. */
export function computeDefender(round: Round, game: Game): DefenderResults {
  const playerIds = game.playerIds.length ? game.playerIds : round.players.map(p => p.id);
  const pointValue = game.settings.pointValue ?? 1;
  const fixedDefenderId = game.settings.defenderPlayerId ?? null;

  const scoreMaps = new Map<string, Map<number, number>>(
    playerIds.map(pid => [pid, scoreByHole(round.scores, pid)])
  );

  const totals: Record<string, number> = {};
  for (const pid of playerIds) totals[pid] = 0;

  const holes: DefenderResults['holes'] = [];

  for (let holeNumber = 1; holeNumber <= 18; holeNumber++) {
    const defenderId = fixedDefenderId ?? playerIds[(holeNumber - 1) % playerIds.length];
    if (!defenderId) {
      continue; // no players configured
    }

    const defenderScore = scoreMaps.get(defenderId)?.get(holeNumber);
    const challengers = playerIds.filter(pid => pid !== defenderId);

    if (typeof defenderScore !== 'number') {
      holes.push({ holeNumber, defenderId, result: 'no_score', beaterIds: [], defenderDelta: 0 });
      continue;
    }

    const beaterIds: string[] = [];
    const scoredChallengers: string[] = [];

    for (const pid of challengers) {
      const challengerScore = scoreMaps.get(pid)?.get(holeNumber);
      if (typeof challengerScore === 'number') {
        scoredChallengers.push(pid);
        if (challengerScore < defenderScore) beaterIds.push(pid);
      }
    }

    if (scoredChallengers.length === 0) {
      holes.push({ holeNumber, defenderId, result: 'no_score', beaterIds: [], defenderDelta: 0 });
      continue;
    }

    if (beaterIds.length === 0) {
      // No challenger beat the defender — won only if defender is the sole low score.
      const isSoleLow = scoredChallengers.every(
        pid => (scoreMaps.get(pid)!.get(holeNumber) as number) > defenderScore
      );

      if (isSoleLow) {
        // Defender collects pointValue from each scored challenger (zero-sum).
        const delta = pointValue * scoredChallengers.length;
        totals[defenderId] += delta;
        for (const pid of scoredChallengers) totals[pid] -= pointValue;
        holes.push({ holeNumber, defenderId, result: 'defended', beaterIds: [], defenderDelta: delta });
      } else {
        // Defender tied with at least one challenger — no exchange.
        holes.push({ holeNumber, defenderId, result: 'no_score', beaterIds: [], defenderDelta: 0 });
      }
    } else {
      // Defender was beaten by at least one challenger.
      // Each beater collects pointValue from the defender (zero-sum).
      const delta = -pointValue * beaterIds.length;
      totals[defenderId] += delta;
      for (const bid of beaterIds) totals[bid] += pointValue;
      holes.push({ holeNumber, defenderId, result: 'beaten', beaterIds, defenderDelta: delta });
    }
  }

  return { holes, totals };
}
