/**
 * API client for the Scorecard backend.
 * Replaces localStorage with backend API calls.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

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
// Profile API
// ================

export interface GolferProfile {
  id: string;
  user_id: string;
  name: string;
  handicap: number | null;
  home_course: string | null;
  club_distances: Record<string, number> | null;
  created_at: string;
  updated_at: string;
}

export async function getGolferProfile(): Promise<GolferProfile | null> {
  try {
    return await fetchAPI<GolferProfile>('/api/profile/golfer');
  } catch {
    return null;
  }
}

export async function createGolferProfile(data: {
  name: string;
  handicap?: number | null;
  home_course?: string | null;
  club_distances?: Record<string, number> | null;
}): Promise<GolferProfile> {
  return fetchAPI<GolferProfile>('/api/profile/golfer', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateGolferProfile(data: {
  name?: string;
  handicap?: number | null;
  home_course?: string | null;
  club_distances?: Record<string, number> | null;
}): Promise<GolferProfile> {
  return fetchAPI<GolferProfile>('/api/profile/golfer', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

// ================
// Rounds API
// ================

export interface HoleInfo {
  number: number;
  par: number;
  yards?: number;
  handicap?: number;
}

export interface Player {
  id: string;
  name: string;
  handicap?: number | null;
  user_id?: string | null;
}

export interface Score {
  id: string;
  player_id: string;
  hole_number: number;
  strokes: number | null;
  putts?: number | null;
  fairway_hit?: boolean | null;
  green_in_regulation?: boolean | null;
}

export interface Round {
  id: string;
  owner_id: string;
  course_id: string;
  course_name: string;
  tee_id?: string | null;
  tee_name?: string | null;
  date: string;
  status: 'active' | 'completed';
  holes: HoleInfo[];
  tournament_id?: string | null;
  players: Player[];
  scores: Score[];
  created_at: string;
  updated_at: string;
}

export interface RoundListItem {
  id: string;
  course_name: string;
  date: string;
  status: 'active' | 'completed';
  player_count: number;
  tournament_id?: string | null;
  created_at: string;
}

export async function getRounds(params?: {
  limit?: number;
  offset?: number;
  status?: string;
}): Promise<RoundListItem[]> {
  const query = new URLSearchParams();
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.offset) query.set('offset', String(params.offset));
  if (params?.status) query.set('status', params.status);
  
  const queryStr = query.toString();
  return fetchAPI<RoundListItem[]>(`/api/rounds${queryStr ? `?${queryStr}` : ''}`);
}

export async function getRound(id: string): Promise<Round> {
  return fetchAPI<Round>(`/api/rounds/${id}`);
}

export async function createRound(data: {
  course_id: string;
  course_name: string;
  tee_id?: string;
  tee_name?: string;
  date: string;
  holes: HoleInfo[];
  players: Array<{ name: string; handicap?: number; user_id?: string }>;
  tournament_id?: string;
}): Promise<Round> {
  return fetchAPI<Round>('/api/rounds', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateRound(
  id: string,
  data: { status?: 'active' | 'completed'; tee_id?: string; tee_name?: string }
): Promise<Round> {
  return fetchAPI<Round>(`/api/rounds/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteRound(id: string): Promise<void> {
  await fetchAPI(`/api/rounds/${id}`, { method: 'DELETE' });
}

export async function addScore(
  roundId: string,
  data: { player_id: string; hole_number: number; strokes: number | null }
): Promise<Score> {
  return fetchAPI<Score>(`/api/rounds/${roundId}/scores`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function addPlayerToRound(
  roundId: string,
  data: { name: string; handicap?: number; user_id?: string }
): Promise<Player> {
  return fetchAPI<Player>(`/api/rounds/${roundId}/players`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ================
// Tournaments API
// ================

export interface Tournament {
  id: string;
  owner_id: string;
  name: string;
  num_rounds?: number | null;
  player_ids: string[];
  player_names_by_id: Record<string, string>;
  round_ids: string[];
  created_at: string;
  updated_at: string;
}

export async function getTournaments(params?: {
  limit?: number;
  offset?: number;
}): Promise<Tournament[]> {
  const query = new URLSearchParams();
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.offset) query.set('offset', String(params.offset));
  
  const queryStr = query.toString();
  return fetchAPI<Tournament[]>(`/api/tournaments${queryStr ? `?${queryStr}` : ''}`);
}

export async function getTournament(id: string): Promise<Tournament> {
  return fetchAPI<Tournament>(`/api/tournaments/${id}`);
}

export async function createTournament(data: {
  name: string;
  num_rounds?: number;
  player_ids?: string[];
  player_names_by_id?: Record<string, string>;
}): Promise<Tournament> {
  return fetchAPI<Tournament>('/api/tournaments', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateTournament(
  id: string,
  data: { name?: string; num_rounds?: number }
): Promise<Tournament> {
  return fetchAPI<Tournament>(`/api/tournaments/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteTournament(id: string): Promise<void> {
  await fetchAPI(`/api/tournaments/${id}`, { method: 'DELETE' });
}

export async function addPlayerToTournament(
  tournamentId: string,
  data: { player_id: string; player_name: string }
): Promise<Tournament> {
  return fetchAPI<Tournament>(`/api/tournaments/${tournamentId}/players`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ================
// Courses API
// ================

export interface CourseSearchResult {
  id: string;
  name: string;
  location?: string | null;
}

export interface Tee {
  id: string;
  name: string;
  holes: HoleInfo[];
}

export interface Course {
  id: string;
  name: string;
  location?: string | null;
  golf_api_course_id?: number | null;
  golf_api_club_id?: number | null;
  hole_coordinates?: Array<{
    hole_number: number;
    green: { lat: number; lng: number };
    tee?: { lat: number; lng: number };
    front?: { lat: number; lng: number };
    back?: { lat: number; lng: number };
  }> | null;
  tees: Tee[];
  created_at: string;
  updated_at: string;
}

export async function searchCourses(query?: string): Promise<CourseSearchResult[]> {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  
  const queryStr = params.toString();
  return fetchAPI<CourseSearchResult[]>(`/api/courses${queryStr ? `?${queryStr}` : ''}`);
}

export async function getCourse(id: string): Promise<Course> {
  return fetchAPI<Course>(`/api/courses/${id}`);
}

export async function createCourse(data: {
  name: string;
  location?: string;
  tees?: Array<{
    name: string;
    holes: HoleInfo[];
  }>;
}): Promise<Course> {
  return fetchAPI<Course>('/api/courses', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ================
// Games API
// ================

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
  | 'defender';

export interface GameTeam {
  id: string;
  name: string;
  player_ids: string[];
}

export interface Game {
  id: string;
  round_id: string;
  format: GameFormat;
  name: string;
  player_ids: string[];
  settings: Record<string, unknown>;
  teams: GameTeam[];
  created_at: string;
}

export async function getGame(id: string): Promise<Game> {
  return fetchAPI<Game>(`/api/games/${id}`);
}

export async function createGame(data: {
  round_id: string;
  format: GameFormat;
  name: string;
  player_ids: string[];
  settings?: Record<string, unknown>;
  teams?: Array<{ name: string; player_ids: string[] }>;
}): Promise<Game> {
  return fetchAPI<Game>('/api/games', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateGame(
  id: string,
  data: {
    name?: string;
    player_ids?: string[];
    settings?: Record<string, unknown>;
  }
): Promise<Game> {
  return fetchAPI<Game>(`/api/games/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteGame(id: string): Promise<void> {
  await fetchAPI(`/api/games/${id}`, { method: 'DELETE' });
}
