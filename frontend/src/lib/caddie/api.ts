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
