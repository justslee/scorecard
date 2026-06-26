/**
 * API client for the Scorecard backend.
 *
 * All request/response shapes use camelCase to match the FastAPI/Pydantic backend
 * exactly. The shared domain types (Round, Tournament, etc.) are imported from
 * ./types — they are the single source of truth for both layers.
 *
 * Endpoints that do not yet exist are marked // TODO(<item-id>) so they are easy
 * to find when that backlog item lands.
 */

import type {
  Round,
  Tournament,
  Player,
  Score,
  HoleInfo,
  Game,
  PlayerGroup,
  SavedPlayer,
  Course,
} from './types';

// Re-export so callers that import domain types from here keep working.
export type {
  Round,
  Tournament,
  Player,
  Score,
  HoleInfo,
  Game,
  PlayerGroup,
  SavedPlayer,
  Course,
};

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

/**
 * Get auth token from Clerk (client-side only).
 */
async function getAuthToken(): Promise<string | null> {
  if (typeof window === 'undefined') return null;

  // @ts-expect-error - Clerk exposes this on window
  const clerk = window.Clerk;
  if (!clerk?.session) return null;

  try {
    return await clerk.session.getToken();
  } catch {
    return null;
  }
}

/**
 * Authorization header for a backend request, if a Clerk session exists.
 * Use for requests that can't go through fetchAPI (e.g. multipart uploads or
 * the golf proxy) but still need the owner Bearer against the gated backend.
 */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Make an authenticated API request.
 */
export async function fetchAPI<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getAuthToken();

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (token) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(error || `API error: ${res.status}`);
  }

  // Handle 204 No Content
  if (res.status === 204) {
    return undefined as T;
  }

  return res.json();
}

// ================
// Players API
// GET    /api/players         → SavedPlayer[]
// GET    /api/players/{id}    → SavedPlayer
// POST   /api/players         → SavedPlayer
// PUT    /api/players/{id}    → SavedPlayer
// DELETE /api/players/{id}    → {status}
// ================

export interface PlayerCreate {
  name: string;
  nickname?: string;
  email?: string;
  phone?: string;
  handicap?: number;
}

export interface PlayerUpdate {
  name?: string;
  nickname?: string;
  email?: string;
  phone?: string;
  handicap?: number;
}

export async function getPlayers(): Promise<SavedPlayer[]> {
  return fetchAPI<SavedPlayer[]>('/api/players');
}

export async function getPlayer(id: string): Promise<SavedPlayer> {
  return fetchAPI<SavedPlayer>(`/api/players/${id}`);
}

export async function createPlayer(data: PlayerCreate): Promise<SavedPlayer> {
  return fetchAPI<SavedPlayer>('/api/players', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updatePlayer(id: string, data: PlayerUpdate): Promise<SavedPlayer> {
  return fetchAPI<SavedPlayer>(`/api/players/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deletePlayer(id: string): Promise<void> {
  await fetchAPI(`/api/players/${id}`, { method: 'DELETE' });
}

// ================
// Rounds API
// GET    /api/rounds               → Round[]
// GET    /api/rounds/{id}          → Round
// POST   /api/rounds               → Round
// PUT    /api/rounds/{id}          → Round
// DELETE /api/rounds/{id}          → {status}
// POST   /api/rounds/{id}/scores   → Round  (upserts one score)
// POST   /api/rounds/{id}/complete → Round
// ================

/** Body for POST /api/rounds. */
export interface RoundCreate {
  courseId: string;
  courseName: string;
  teeId?: string;
  teeName?: string;
  /** Each player must include an id (generate with crypto.randomUUID() client-side). */
  players: Player[];
  holes: HoleInfo[];
  games?: Game[];
  groups?: PlayerGroup[];
  tournamentId?: string;
}

/** Body for PUT /api/rounds/{id}. */
export interface RoundUpdate {
  scores?: Score[];
  games?: Game[];
  groups?: PlayerGroup[];
  status?: 'active' | 'completed';
}

export async function getRounds(): Promise<Round[]> {
  return fetchAPI<Round[]>('/api/rounds');
}

export async function getRound(id: string): Promise<Round> {
  return fetchAPI<Round>(`/api/rounds/${id}`);
}

export async function createRound(data: RoundCreate): Promise<Round> {
  return fetchAPI<Round>('/api/rounds', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/** Full replace of mutable round fields (scores, games, groups, status). */
export async function updateRound(id: string, data: RoundUpdate): Promise<Round> {
  return fetchAPI<Round>(`/api/rounds/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteRound(id: string): Promise<void> {
  await fetchAPI(`/api/rounds/${id}`, { method: 'DELETE' });
}

/** Upsert a single score. Returns the full updated round. */
export async function addScore(roundId: string, score: Score): Promise<Round> {
  return fetchAPI<Round>(`/api/rounds/${roundId}/scores`, {
    method: 'POST',
    body: JSON.stringify(score),
  });
}

export async function completeRound(id: string): Promise<Round> {
  return fetchAPI<Round>(`/api/rounds/${id}/complete`, { method: 'POST' });
}

// ================
// Tournaments API
// GET    /api/tournaments                          → Tournament[]
// GET    /api/tournaments/{id}                    → Tournament
// POST   /api/tournaments                         → Tournament
// PUT    /api/tournaments/{id}                    → Tournament
// DELETE /api/tournaments/{id}                    → {status}
// POST   /api/tournaments/{id}/players/{playerId} → {status}  (?player_name=)
// ================

export interface TournamentCreate {
  name: string;
  numRounds?: number;
  playerIds?: string[];
}

export interface TournamentUpdate {
  name?: string;
  numRounds?: number;
  roundIds?: string[];
  playerIds?: string[];
  games?: Game[];
}

export async function getTournaments(): Promise<Tournament[]> {
  return fetchAPI<Tournament[]>('/api/tournaments');
}

export async function getTournament(id: string): Promise<Tournament> {
  return fetchAPI<Tournament>(`/api/tournaments/${id}`);
}

export async function createTournament(data: TournamentCreate): Promise<Tournament> {
  return fetchAPI<Tournament>('/api/tournaments', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateTournament(id: string, data: TournamentUpdate): Promise<Tournament> {
  return fetchAPI<Tournament>(`/api/tournaments/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteTournament(id: string): Promise<void> {
  await fetchAPI(`/api/tournaments/${id}`, { method: 'DELETE' });
}

/** Add a player to a tournament (path + query-param style matching the backend route). */
export async function addPlayerToTournament(
  tournamentId: string,
  playerId: string,
  playerName: string
): Promise<void> {
  await fetchAPI(
    `/api/tournaments/${encodeURIComponent(tournamentId)}/players/${encodeURIComponent(playerId)}?player_name=${encodeURIComponent(playerName)}`,
    { method: 'POST' }
  );
}

// ================
// Courses API
// GET    /api/courses       → Course[]
// GET    /api/courses/{id}  → Course
// POST   /api/courses       → Course
// DELETE /api/courses/{id}  → {status}
//
// There is no server-side text search on /api/courses. For course discovery
// use /api/golf (GolfAPI.io proxy) or /api/courses/search (PostGIS mapped-courses).
// ================

export interface CourseCreate {
  name: string;
  holes: HoleInfo[];
  tees?: Array<{ id: string; name: string; holes: HoleInfo[] }>;
  location?: string;
}

export async function getCourses(): Promise<Course[]> {
  return fetchAPI<Course[]>('/api/courses');
}

export async function getCourse(id: string): Promise<Course> {
  return fetchAPI<Course>(`/api/courses/${id}`);
}

export async function createCourse(data: CourseCreate): Promise<Course> {
  return fetchAPI<Course>('/api/courses', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function deleteCourse(id: string): Promise<void> {
  await fetchAPI(`/api/courses/${id}`, { method: 'DELETE' });
}

// ================
// Profile API — TODO(backend-profile-endpoint)
// /api/profile/golfer does not exist yet; it ships in a dedicated backlog item.
// These stubs return null/throw immediately so callers fall back to localStorage.
// ================

export async function getGolferProfile(): Promise<null> {
  // TODO(backend-profile-endpoint): GET /api/profile/golfer once route exists.
  return null;
}

export async function createGolferProfile(): Promise<never> {
  // TODO(backend-profile-endpoint): POST /api/profile/golfer once route exists.
  throw new Error('Profile endpoint not yet implemented (backend-profile-endpoint)');
}

export async function updateGolferProfile(): Promise<never> {
  // TODO(backend-profile-endpoint): PUT /api/profile/golfer once route exists.
  throw new Error('Profile endpoint not yet implemented (backend-profile-endpoint)');
}

// ================
// Games API — TODO(backend-games-surface)
// Games are embedded in Round (no standalone /api/games CRUD).
// Create/update games via RoundCreate.games or updateRound({ games }).
// ================
// (getGame / createGame / updateGame / deleteGame removed — no route exists)
