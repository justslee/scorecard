// Caddie API client — talks to FastAPI backend

import type {
  CaddieRecommendation,
  WeatherConditions,
  HoleIntelligence,
  CaddiePersonalityInfo,
  VoiceCaddieMessage,
} from './types';

// Backend URL — uses Next.js rewrite proxy in production, direct in dev
const API_BASE = '/api';

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
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

export async function fetchWeather(lat: number, lng: number): Promise<WeatherConditions> {
  return post<WeatherConditions>('/caddie/weather', { lat, lng });
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
): Promise<CourseIntelResult> {
  return post<CourseIntelResult>('/caddie/course-intel', {
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
  return post('/caddie/session/recommend', params);
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
  const res = await fetch(`${API_BASE}/shots/${shotId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Delete shot failed: ${res.status}`);
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

// ── Voice Caddie ──

export async function talkToCaddie(params: {
  transcript: string;
  personality_id: string;
  hole_number: number;
  par: number;
  yards: number;
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
