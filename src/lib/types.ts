// Core data models for the Scorecard app

export interface HoleInfo {
  number: number;
  par: number;
  yards?: number;
  handicap?: number;
}

export interface Course {
  id: string;
  name: string;
  holes: HoleInfo[];
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

export interface Round {
  id: string;
  courseId: string;
  courseName: string;
  date: string;
  players: Player[];
  scores: Score[];
  holes: HoleInfo[];
  status: 'active' | 'completed';
  createdAt: string;
  updatedAt: string;
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
  };
}

// Calculate totals
export function calculateTotals(scores: Score[], holes: HoleInfo[], playerId: string) {
  const playerScores = scores.filter(s => s.playerId === playerId);
  
  const front9 = playerScores
    .filter(s => s.holeNumber <= 9 && s.strokes !== null)
    .reduce((sum, s) => sum + (s.strokes || 0), 0);
  
  const back9 = playerScores
    .filter(s => s.holeNumber > 9 && s.strokes !== null)
    .reduce((sum, s) => sum + (s.strokes || 0), 0);
  
  const total = front9 + back9;
  
  const frontPar = holes.slice(0, 9).reduce((sum, h) => sum + h.par, 0);
  const backPar = holes.slice(9).reduce((sum, h) => sum + h.par, 0);
  const totalPar = frontPar + backPar;
  
  return {
    front9,
    back9,
    total,
    frontPar,
    backPar,
    totalPar,
    toPar: total - totalPar,
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
