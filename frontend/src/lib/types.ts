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
  color?: string;
  slope?: number;
  rating?: number;
  totalYards?: number;
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
  /** GolfAPI.io course ID for GPS features */
  golfApiCourseId?: number | string;
  /** GolfAPI.io club ID */
  golfApiClubId?: number | string;
  /** Hole coordinates for GPS map view */
  holeCoordinates?: Array<{
    holeNumber: number;
    green: { lat: number; lng: number };
    tee?: { lat: number; lng: number };
    front?: { lat: number; lng: number };
    back?: { lat: number; lng: number };
  }>;
}

export interface Player {
  id: string;
  name: string;
  handicap?: number;
  /** Group ID this player belongs to (for tournament rounds) */
  groupId?: string;
}

/** Saved player in user's network (persisted contacts) */
export interface SavedPlayer {
  id: string;
  name: string;
  nickname?: string;
  email?: string;
  phone?: string;
  handicap?: number;
  avatarUrl?: string;
  /** Clerk user ID if they have an account */
  clerkUserId?: string;
  /** Number of rounds played together */
  roundsPlayed: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlayerGroup {
  id: string;
  name: string; // e.g., "Group 1", "Morning Flight"
  teeTime?: string; // e.g., "8:00 AM"
  startingHole?: number; // For shotgun starts (1-18)
  playerIds: string[];
}

export interface Score {
  playerId: string;
  holeNumber: number;
  strokes: number | null;
}

// -----------------
// Games overlay system
// -----------------
export type GameFormat =
  | 'skins'
  | 'nassau'
  | 'bestBall'
  | 'scramble'
  | 'wolf'
  | 'threePoint'
  | 'stableford'
  | 'modifiedStableford'
  | 'matchPlay'
  | 'bingoBangoBongo'
  | 'vegas'
  | 'hammer'
  | 'rabbit'
  | 'trash'
  | 'chicago'
  | 'defender'
  /**
   * Synthetic format — not a playable game, but the persisted settlement
   * ledger for a completed round. Stored as a game row so no DB migration
   * is required. Rendered by SettleUpPanel, filtered out of GameResults /
   * GameLeaderboards.  settings = { transfers: SettlementTransfer[], finalizedAt: string }.
   */
  | 'settlement';

export interface GameTeam {
  id: string;
  name: string;
  playerIds: string[];
}

export interface GameSettings {
  /**
   * Index signature allows synthetic game formats (e.g. 'settlement') to
   * store arbitrary JSONB in settings without requiring a DB migration or
   * a separate table. Well-typed formats use the explicit fields below.
   */
  [key: string]: unknown;

  // shared
  pointValue?: number;
  handicapped?: boolean;

  // skins
  carryover?: boolean;

  // nassau
  nassauMode?: 'stroke' | 'match';
  nassauScope?: 'individual' | 'team';

  // match play
  matchPlayMode?: 'individual';
  matchPlayPlayers?: { player1Id: string; player2Id: string };

  // 3-point system (2v2)
  threePointPairs?: {
    teamAPlayer1Id: string;
    teamAPlayer2Id: string;
    teamBPlayer1Id: string;
    teamBPlayer2Id: string;
  };

  // wolf (4 players)
  wolfOrderPlayerIds?: string[]; // length 4
  wolfHoleChoices?: Record<
    number,
    | { mode: 'lone' }
    | { mode: 'partner'; partnerId: string }
  >;

  // hammer — per-hole doubling multiplier recorded after each throw/accept.
  // Key = hole number (1-18); value = active multiplier for that hole (default 1).
  // Live hammer doubling events need per-hole event capture (follow-up item).
  hammerMultiplierByHole?: Record<number, number>;

  // defender — optional fixed defender player ID for the whole round.
  // When absent, defender rotates by (holeNumber - 1) % playerIds.length each hole.
  defenderPlayerId?: string;

  // chicago — quota base (default 39). Each player's quota = base - handicap.
  // Points: bogey=1, par=2, birdie=4, eagle=8, albatross=16.
  chicagoQuotaBase?: number;
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
  /**
   * Course anchor captured at round creation: geographic centre + the mapped
   * course's UUID (when the selection was an ingested/write-through course).
   * The round screen renders the satellite map from these directly; absent on
   * legacy rounds, which fall back to by-name resolution.
   */
  courseLat?: number;
  courseLng?: number;
  mappedCourseId?: string;
  teeId?: string;
  teeName?: string;
  date: string;
  players: Player[];
  /**
   * Which player in `players` represents the owner (the signed-in user).
   * May be absent on legacy rounds; use getOwnerPlayerId() (lib/round-owner.ts),
   * which falls back to the first player, rather than reading this directly.
   */
  ownerPlayerId?: string;
  scores: Score[];
  holes: HoleInfo[];
  /** Side games (skins, nassau, best ball, etc.) attached to this round */
  games?: Game[];
  /** Player groups with tee times (for tournament rounds) */
  groups?: PlayerGroup[];
  status: 'active' | 'completed';
  /** If present, this round is part of a tournament */
  tournamentId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One day's planned course in a tournament (index = day − 1). Mirrors the
 * rounds course-anchor columns so drawing that day can reconstruct the full
 * CourseSearch selection (anchor + mapped identity). null = "Course to be drawn".
 */
export interface TournamentRoundCourse {
  courseId: string;
  courseName: string;
  courseLat?: number;
  courseLng?: number;
  mappedCourseId?: string;
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
  /** Tournament-level games (skins, nassau, etc.) that span all rounds */
  games?: Game[];
  /**
   * Per-day course plan from setup. Absent/undefined when the owner never
   * touched per-round courses (byte-identical guarantee) and on all
   * pre-feature tournaments.
   */
  roundCourses?: (TournamentRoundCourse | null)[];
}

export interface GolferProfile {
  id: string;
  /** Display name — null when the user hasn't set one yet (backend Optional[str]). */
  name: string | null;
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

// ─────────────────────────────────────────────────────────────────────────────
// Course Reviews (B2) — kept in sync with backend/app/models.py CourseReview
// ─────────────────────────────────────────────────────────────────────────────

/** Server-persisted course review. Mirrors backend CourseReview Pydantic model. */
export interface CourseReview {
  id: string;
  ownerId: string;
  courseKey: string;
  courseName?: string;
  roundId?: string;
  rating: number;       // 1–5, validated server-side
  body?: string;
  playedAt?: string;    // ISO date string (YYYY-MM-DD)
  createdAt: string;    // ISO datetime string
}

/** Request body for POST /api/courses/{courseKey}/reviews. */
export interface CourseReviewCreate {
  rating: number;       // 1–5
  body?: string;
  roundId?: string;
  courseName?: string;
  playedAt?: string;    // ISO date string
}

// ─────────────────────────────────────────────────────────────────────────────
// Course intel (course-discovery-intel) — kept in sync with backend
// app/models.py CourseIntel. One shape feeds BOTH the map tap-sheet and the
// course detail page. Pure-DB read; description is a precomputed cache.
// ─────────────────────────────────────────────────────────────────────────────

export interface CourseIntelDescription {
  text: string | null;               // composed prose; null = not yet seeded
  provenance: "landscape" | "enriched" | null;
  factsUsed: string[];               // subset of ["architect","yearBuilt","styleNotes","notableHistory"]
  generatedAt: string | null;        // ISO datetime
  model: string | null;
}

export interface CourseIntel {
  courseId: string;                  // public.courses.id
  description: CourseIntelDescription;
  stars: {
    avg: number | null;              // null iff count === 0 — never a fabricated 0.0
    count: number;
  };
  stats: {
    parTotal: number | null;         // null if not mapped
    yardageByTee: Record<string, number> | null;
    holesMapped: number | null;      // count of REAL public.holes rows, null if 0
    roundsPlayed: number;            // honest count, 0 is real
    avgScore: number | null;         // null unless ≥1 COMPLETE round exists
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scorecard OCR scan — kept in sync with backend/app/routes/scorecard.py
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-hole data returned by POST /api/scorecard/scan.
 * `par` is null when not printed on the card or unreadable.
 * `scores` values are null when a cell is blank or unreadable.
 * The key is the player name exactly as written on the scanned card.
 */
export interface ScanHole {
  number: number;
  par: number | null;
  scores: Record<string, number | null>;
}

/** Full response from POST /api/scorecard/scan. Mirrors backend ScanScorecardResponse. */
export interface ScanScorecardResponse {
  players: string[];   // OCR player names, in card order
  holes: ScanHole[];   // Per-hole data, ordered by hole number
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
  // Minimal, non-emoji display helpers.
  if (diff === -2) return 'Eagle';
  if (diff === -1) return 'Birdie';
  if (diff === 0) return 'Par';
  if (diff === 1) return 'Bogey';
  if (diff === 2) return 'Double';
  return `+${diff}`;
}

export function getScoreClass(strokes: number | null, par: number): string {
  if (strokes === null) return '';
  const diff = strokes - par;

  // These are intentionally subtle (modern dark UI): mostly text color + slight emphasis.
  if (diff <= -2) return 'text-yellow-200'; // Eagle or better
  if (diff === -1) return 'text-red-300'; // Birdie
  if (diff === 0) return 'text-emerald-300'; // Par
  if (diff === 1) return 'text-sky-300'; // Bogey
  if (diff === 2) return 'text-blue-300'; // Double
  return 'text-indigo-200'; // Triple+
}
