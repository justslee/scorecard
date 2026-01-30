// Core data models for the Scorecard app

export interface HoleInfo {
  number: number;
  par: number;
  yards?: number;
  handicap?: number;
}

export interface TeeOption {
  id: string;
  name: string; // e.g., Blue, White, Red
  holes: HoleInfo[];
}

export interface Course {
  id: string;
  name: string;
  /** Default holes (used when no tee is selected / legacy courses) */
  holes: HoleInfo[];
  /** Optional tee boxes with different yardages/pars */
  tees?: TeeOption[];
  location?: string;
}

export interface Player {
  id: string;
  name: string;
  handicap?: number;
}

export interface Score {
  playerId: string;
  holeNumber: number;
  strokes: number | null;
}

// -----------------
// Games overlay system
// -----------------
export type GameFormat = 'skins' | 'nassau' | 'bestBall' | 'scramble' | 'wolf' | 'threePoint';

export interface GameTeam {
  id: string;
  name: string;
  playerIds: string[];
}

export interface GameSettings {
  // shared
  pointValue?: number;
  handicapped?: boolean;

  // skins
  carryover?: boolean;

  // nassau
  nassauMode?: 'stroke' | 'match';
  nassauScope?: 'individual' | 'team';
}

export interface Game {
  id: string;
  roundId: string;
  format: GameFormat;
  name: string;
  /** Player ids included in the game (used for individual formats; also useful for filtering). */
  playerIds: string[];
  /** Teams for team formats (Best Ball, Team Nassau, Scramble, etc.) */
  teams?: GameTeam[];
  settings: GameSettings;
}

export interface Round {
  id: string;
  courseId: string;
  courseName: string;
  teeId?: string;
  teeName?: string;
  date: string;
  players: Player[];
  scores: Score[];
  holes: HoleInfo[];
  /** Side games (skins, nassau, best ball, etc.) attached to this round */
  games?: Game[];
  status: 'active' | 'completed';
  /** If present, this round is part of a tournament */
  tournamentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Tournament {
  id: string;
  name: string;
  /** Player ids participating in the tournament */
  playerIds: string[];
  /** Round ids linked to this tournament */
  roundIds: string[];
  createdAt: string;
  /** Optional: planned number of rounds/days */
  numRounds?: number;
  /** Optional: name lookup for rendering (since players are otherwise stored per-round) */
  playerNamesById?: Record<string, string>;
}

export interface GolferProfile {
  id: string;
  name: string;
  handicap: number | null;
  homeCourse: string | null;
  clubDistances: {
    driver?: number;
    threeWood?: number;
    fiveWood?: number;
    hybrid?: number;
    fourIron?: number;
    fiveIron?: number;
    sixIron?: number;
    sevenIron?: number;
    eightIron?: number;
    nineIron?: number;
    pitchingWedge?: number;
    gapWedge?: number;
    sandWedge?: number;
    lobWedge?: number;
    putter?: number;
  };
}

// Helper to create a standard 18-hole course with default pars
export function createDefaultCourse(name: string): Course {
  const holes: HoleInfo[] = [];
  // Standard mix of pars: 4,4,3,5,4,4,3,4,5 (front) + 4,3,4,5,4,4,3,4,5 (back)
  const pars = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 4, 5];

  for (let i = 1; i <= 18; i++) {
    holes.push({
      number: i,
      par: pars[i - 1],
    });
  }

  return {
    id: crypto.randomUUID(),
    name,
    holes,
    tees: [
      { id: crypto.randomUUID(), name: 'Blue', holes },
      { id: crypto.randomUUID(), name: 'White', holes },
      { id: crypto.randomUUID(), name: 'Red', holes },
    ],
  };
}

// Calculate totals
export function calculateTotals(scores: Score[], holes: HoleInfo[], playerId: string) {
  const playerScores = scores.filter(s => s.playerId === playerId);

  const front9 = playerScores
    .filter(s => s.holeNumber <= 9 && s.strokes !== null)
    .reduce((sum, s) => sum + (s.strokes ?? 0), 0);

  const back9 = playerScores
    .filter(s => s.holeNumber > 9 && s.strokes !== null)
    .reduce((sum, s) => sum + (s.strokes ?? 0), 0);

  const total = front9 + back9;

  // Full-course pars (useful for displaying a scorecard)
  const frontPar = holes.slice(0, 9).reduce((sum, h) => sum + h.par, 0);
  const backPar = holes.slice(9).reduce((sum, h) => sum + h.par, 0);
  const totalPar = frontPar + backPar;

  // Played-to-par: only count holes where the player has a score.
  // This fixes partial rounds (don't compare to the full course par).
  const holeParByNumber = new Map<number, number>(holes.map(h => [h.number, h.par]));

  let playedFrontPar = 0;
  let playedBackPar = 0;
  let playedHoles = 0;

  const playedToPar = playerScores
    .filter(s => s.strokes !== null)
    .reduce((sum, s) => {
      const par = holeParByNumber.get(s.holeNumber);
      if (typeof par !== 'number') return sum;

      playedHoles += 1;
      if (s.holeNumber <= 9) playedFrontPar += par;
      else playedBackPar += par;

      return sum + ((s.strokes ?? 0) - par);
    }, 0);

  const playedTotalPar = playedFrontPar + playedBackPar;

  return {
    front9,
    back9,
    total,
    frontPar,
    backPar,
    totalPar,
    // new fields
    playedHoles,
    playedFrontPar,
    playedBackPar,
    playedTotalPar,
    // toPar is now computed only from played holes
    toPar: playedToPar,
  };
}

// Score relative to par display
export function scoreDisplay(strokes: number | null, par: number): string {
  if (strokes === null) return '-';
  const diff = strokes - par;
  if (diff === -2) return '🦅'; // Eagle
  if (diff === -1) return '🐦'; // Birdie
  if (diff === 0) return '⚪'; // Par
  if (diff === 1) return '⬜'; // Bogey
  if (diff === 2) return '🟨'; // Double
  return `+${diff}`;
}

export function getScoreClass(strokes: number | null, par: number): string {
  if (strokes === null) return '';
  const diff = strokes - par;
  if (diff <= -2) return 'bg-yellow-400 text-black'; // Eagle or better
  if (diff === -1) return 'bg-red-500 text-white'; // Birdie
  if (diff === 0) return 'bg-green-500 text-white'; // Par
  if (diff === 1) return 'bg-blue-400 text-white'; // Bogey
  if (diff === 2) return 'bg-blue-600 text-white'; // Double
  return 'bg-blue-900 text-white'; // Triple+
}
