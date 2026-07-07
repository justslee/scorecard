// Caddie API client — talks to the FastAPI backend through the authenticated,
// absolute-base client (Clerk Bearer + NEXT_PUBLIC_API_URL). No relative "/api"
// proxy, so it works in the static native build and passes the owner gate.

import type {
  CaddieRecommendation,
  WeatherConditions,
  HoleIntelligence,
  CaddiePersonalityInfo,
  VoiceCaddieMessage,
} from './types';
import { fetchAPI } from '../api';
import { saveLastRecommendation } from './hole-intel-cache';

async function post<T>(path: string, body: unknown): Promise<T> {
  return fetchAPI<T>(`/api${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function get<T>(path: string): Promise<T> {
  return fetchAPI<T>(`/api${path}`);
}

// ── Personalities ──

export async function fetchPersonalities(): Promise<CaddiePersonalityInfo[]> {
  const data = await get<{ personalities: CaddiePersonalityInfo[] }>('/caddie/personalities');
  return data.personalities;
}

export interface CreatePersonaInput {
  name: string;
  description: string;
  avatar: string;
  system_prompt: string;
  realtime_instructions?: string;
  voice_id?: string;
  response_style?: 'brief' | 'detailed' | 'conversational';
  traits?: string[];
}

export async function createPersona(input: CreatePersonaInput): Promise<CaddiePersonalityInfo> {
  return post<CaddiePersonalityInfo>('/caddie/personalities', input);
}

// ── Weather ──

/**
 * Backend takes lat/lng/round_id as QUERY params (scalar FastAPI args), not a
 * JSON body — the old body-post 422'd silently. Passing roundId caches the
 * weather into the round's caddie session for /session/recommend + voice.
 */
export async function fetchWeather(
  lat: number,
  lng: number,
  roundId?: string,
): Promise<WeatherConditions> {
  const qs = new URLSearchParams({ lat: String(lat), lng: String(lng) });
  if (roundId) qs.set('round_id', roundId);
  return fetchAPI<WeatherConditions>(`/api/caddie/weather?${qs.toString()}`, {
    method: 'POST',
  });
}

// ── Course Intelligence ──

export interface CourseIntelResult {
  weather: WeatherConditions;
  holes: HoleIntelligence[];
  conditions: string;
}

export async function fetchCourseIntel(
  holeCoordinates: Array<{
    holeNumber: number;
    green: { lat: number; lng: number };
    tee?: { lat: number; lng: number };
    front?: { lat: number; lng: number };
    back?: { lat: number; lng: number };
    par?: number;
    yards?: number;
    handicap?: number;
  }>,
  courseLat?: number,
  courseLng?: number,
  /** When set, the backend caches the intel + weather into the round's caddie
   *  session (round_id is a query param server-side). */
  roundId?: string,
): Promise<CourseIntelResult> {
  const qs = roundId ? `?round_id=${encodeURIComponent(roundId)}` : '';
  return post<CourseIntelResult>(`/caddie/course-intel${qs}`, {
    hole_coordinates: holeCoordinates,
    course_lat: courseLat,
    course_lng: courseLng,
  });
}

// ── Recommendation ──

export async function fetchRecommendation(params: {
  hole_number: number;
  distance_yards?: number;
  par?: number;
  yards?: number;
  club_distances?: Record<string, number>;
  handicap?: number;
  weather?: WeatherConditions;
  hole_intelligence?: HoleIntelligence;
  shot_bearing?: number;
  /** When true, request a USGA-conforming recommendation (no environmental
   *  distance adjustments). Default false. */
  competition_legal?: boolean;
}): Promise<CaddieRecommendation> {
  return post<CaddieRecommendation>('/caddie/recommend', {
    hole_number: params.hole_number,
    distance_yards: params.distance_yards,
    par: params.par || 4,
    yards: params.yards || 400,
    club_distances: params.club_distances || {},
    handicap: params.handicap,
    weather: params.weather,
    hole_intelligence: params.hole_intelligence,
    shot_bearing: params.shot_bearing,
    competition_legal: params.competition_legal ?? false,
  });
}

// ── Player Stats ──

export async function fetchPlayerStats(params: {
  rounds: unknown[];
  handicap?: number;
  course_id?: string;
}): Promise<unknown> {
  return post('/caddie/player-stats', params);
}

// ── Session Management ──

export interface CaddieMemoryEntry {
  kind: 'tendency' | 'preference' | 'course_history' | 'incident';
  summary: string;
  weight: number;
}

export interface CaddieProfile {
  handicap: number | null;
  preferred_personality_id: string | null;
  rounds_analyzed: number;
  miss_direction?: string | null;
  miss_short_pct?: number | null;
  three_putts_per_round?: number | null;
  par5_bogey_rate?: number | null;
}

/** What the caddie knows about the calling player (player_profiles surface). */
export async function getCaddieProfile(): Promise<CaddieProfile> {
  return get<CaddieProfile>('/caddie/profile');
}

/** Persist the preferred persona (the only writable profile field for now). */
export async function updateCaddieProfile(
  preferredPersonalityId: string,
): Promise<CaddieProfile> {
  return fetchAPI<CaddieProfile>('/api/caddie/profile', {
    method: 'PUT',
    body: JSON.stringify({ preferred_personality_id: preferredPersonalityId }),
  });
}

export interface SessionStatus {
  status: string;
  round_id: string;
  user_id?: string;
  current_hole?: number;
  holes_with_intel?: number[];
  has_weather?: boolean;
  shot_count?: number;
  conversation_length?: number;
  last_recommendation?: CaddieRecommendation | null;
  memories?: CaddieMemoryEntry[];
  profile?: CaddieProfile | null;
}

export async function startSession(params: {
  round_id: string;
  course_id?: string;
  club_distances?: Record<string, number>;
  handicap?: number;
}): Promise<SessionStatus> {
  return post('/caddie/session/start', params);
}

export async function endSession(roundId: string): Promise<{ status: string }> {
  return post('/caddie/session/end', { round_id: roundId });
}

export async function getSessionStatus(roundId: string): Promise<SessionStatus> {
  return get<SessionStatus>(`/caddie/session/${roundId}`);
}

export async function recordShot(params: {
  round_id: string;
  hole_number: number;
  club: string;
  distance_yards: number;
  result?: string;
}): Promise<{ status: string; total_shots: number }> {
  return post('/caddie/session/shot', params);
}

export async function sessionRecommend(params: {
  round_id: string;
  hole_number: number;
  distance_yards?: number;
  par?: number;
  yards?: number;
}): Promise<CaddieRecommendation> {
  const rec = await post<CaddieRecommendation>('/caddie/session/recommend', params);
  // Refresh the offline bundle's "last call" (tier-3 card) — fire-and-forget,
  // covers both mouths (voice tool + text sheet) in one place.
  saveLastRecommendation(params.round_id, {
    holeNumber: params.hole_number,
    club: rec.club,
    targetYards: rec.target_yards,
    aim: rec.aim_point?.description ?? '',
    missSide: rec.miss_side?.preferred ?? '',
  }).catch(() => {});
  return rec;
}

// ── Session tool reads (Realtime tool surface v1) ──

export interface SessionConditions {
  round_id: string;
  hole_number: number;
  weather: WeatherConditions | null;
  plays_like: {
    yards: number;
    effective_yards: number;
    plays_like_delta: number;
    elevation_change_ft: number;
  } | null;
}

/** Deterministic read backing the `get_conditions` voice tool. */
export async function getSessionConditions(
  roundId: string,
  holeNumber?: number,
): Promise<SessionConditions> {
  const qs = holeNumber != null ? `?hole_number=${holeNumber}` : '';
  return get<SessionConditions>(
    `/caddie/session/${encodeURIComponent(roundId)}/conditions${qs}`,
  );
}

export interface SessionPlayerProfile {
  round_id: string;
  handicap: number | null;
  club_distances: Record<string, number>;
  tendencies: {
    miss_direction: string | null;
    miss_short_pct: number | null;
    three_putts_per_round: number | null;
    par5_bogey_rate: number | null;
  } | null;
  rounds_analyzed: number;
}

/** Player numbers backing the `get_player_profile` voice tool. */
export async function getSessionPlayerProfile(roundId: string): Promise<SessionPlayerProfile> {
  return get<SessionPlayerProfile>(
    `/caddie/session/${encodeURIComponent(roundId)}/player-profile`,
  );
}

/**
 * Append a Realtime voice turn (pair) to the round's shared caddie_messages
 * ledger, so the text mouth (/session/voice) shares one conversation history.
 */
export async function appendSessionMessage(params: {
  round_id: string;
  user_content?: string;
  assistant_content?: string;
  hole_number?: number;
}): Promise<{ status: string; appended: number }> {
  return post('/caddie/session/message', params);
}

export async function sessionVoice(params: {
  round_id: string;
  transcript: string;
  personality_id: string;
  hole_number: number;
}): Promise<{ response: string }> {
  return post('/caddie/session/voice', params);
}

// ── Daily pin sheets (PR #6) ──

export interface PinRecord {
  id: string;
  course_id: string;
  hole_number: number;
  pin_date: string;
  pin_lat: number;
  pin_lng: number;
  source: 'manual' | 'admin' | 'estimated';
  marked_by_user_id: string | null;
}

export async function fetchPinsForCourse(courseId: string, date?: string): Promise<PinRecord[]> {
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  return get<PinRecord[]>(`/courses/${encodeURIComponent(courseId)}/pins${qs}`);
}

export async function markPin(params: {
  course_id: string;
  hole_number: number;
  pin_lat: number;
  pin_lng: number;
  source?: 'manual' | 'admin';
  pin_date?: string;
}): Promise<PinRecord> {
  return post<PinRecord>(`/courses/${encodeURIComponent(params.course_id)}/pins`, {
    hole_number: params.hole_number,
    pin_lat: params.pin_lat,
    pin_lng: params.pin_lng,
    source: params.source || 'manual',
    pin_date: params.pin_date,
  });
}

// ── Shot tracking (PR #4) ──

export type Lie = 'tee' | 'fairway' | 'rough' | 'bunker' | 'green' | 'water' | 'ob';

export interface TrackedShot {
  id: number;
  round_id: string;
  user_id: string | null;
  hole_id: string | null;
  hole_number: number;
  shot_number: number;
  start_lat: number | null;
  start_lng: number | null;
  start_lie: Lie | null;
  end_lat: number | null;
  end_lng: number | null;
  end_lie: Lie | null;
  distance_yards: number | null;
  club: string | null;
  result: string | null;
  created_at: string;
}

export interface RecordShotInput {
  round_id: string;
  hole_number: number;
  hole_id?: string;
  start_lat?: number;
  start_lng?: number;
  start_lie?: Lie;
  end_lat?: number;
  end_lng?: number;
  end_lie?: Lie;
  club?: string;
  result?: string;
  intended_target_lat?: number;
  intended_target_lng?: number;
  wind_speed_mph?: number;
  wind_direction?: number;
  notes?: string;
}

export async function recordTrackedShot(input: RecordShotInput): Promise<TrackedShot> {
  return post<TrackedShot>('/shots', input);
}

export async function fetchShotsForRound(roundId: string): Promise<TrackedShot[]> {
  return get<TrackedShot[]>(`/shots/round/${encodeURIComponent(roundId)}`);
}

export async function deleteTrackedShot(shotId: number): Promise<void> {
  await fetchAPI(`/api/shots/${shotId}`, { method: 'DELETE' });
}

// ── Realtime (OpenAI WebRTC) ──

export interface RealtimeSessionToken {
  client_secret: string;
  expires_at: number;
  model: string;
  voice_id: string;
  instructions: string;
  tools: Array<{ type: string; name: string; description?: string; parameters?: unknown }>;
  realtime_session_id: string;
}

export async function startRealtimeSession(params: {
  round_id: string;
  personality_id: string;
}): Promise<RealtimeSessionToken> {
  return post<RealtimeSessionToken>('/realtime/session', params);
}

/** Round-less Realtime session for conversational round SETUP (no round yet). */
export async function startSetupSession(params: {
  personality_id: string;
}): Promise<RealtimeSessionToken> {
  return post<RealtimeSessionToken>('/realtime/setup-session', params);
}

// ── Voice Caddie ──

export async function talkToCaddie(params: {
  transcript: string;
  personality_id: string;
  /** null = off-course general chat (the Looper orb outside a round) — the
   *  backend then omits the hole-context line instead of inventing one. */
  hole_number: number | null;
  par?: number;
  yards?: number;
  distance_yards?: number;
  wind_speed_mph?: number;
  wind_direction?: number;
  club_distances?: Record<string, number>;
  handicap?: number;
  current_recommendation?: CaddieRecommendation;
  conversation_history?: VoiceCaddieMessage[];
}): Promise<{ response: string; follow_up?: string }> {
  return post('/caddie/voice', {
    transcript: params.transcript,
    personality_id: params.personality_id,
    hole_number: params.hole_number,
    par: params.par,
    yards: params.yards,
    distance_yards: params.distance_yards,
    wind_speed_mph: params.wind_speed_mph || 0,
    wind_direction: params.wind_direction || 0,
    club_distances: params.club_distances || {},
    handicap: params.handicap,
    current_recommendation: params.current_recommendation,
    conversation_history: params.conversation_history || [],
  });
}
