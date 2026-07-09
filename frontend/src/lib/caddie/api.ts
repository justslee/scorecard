// Caddie API client — talks to the FastAPI backend through the authenticated,
// absolute-base client (Clerk Bearer + NEXT_PUBLIC_API_URL). No relative "/api"
// proxy, so it works in the static native build and passes the owner gate.

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type {
  CaddieRecommendation,
  WeatherConditions,
  HoleIntelligence,
  CaddiePersonalityInfo,
  VoiceCaddieMessage,
} from './types';
import { API_BASE, authHeaders, fetchAPI } from '../api';
import { saveLastRecommendation } from './hole-intel-cache';
import { dataUrlToBlob } from '../scan-helpers';

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
  /** Course display name — lets the backend resolve legacy slug ids to a
   *  mapped-course UUID by name (legacy rounds crashed session start). */
  course_name?: string;
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
  return postWithTimeout('/caddie/session/voice', params, {
    timeoutMs: SESSION_VOICE_TIMEOUT_MS, // retries defaults to 0 → fail fast into the component's talkToCaddie fallback
  });
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
  /** Defense-in-depth (specs/caddie-stale-hole-live-plan.md §3.8) — the hole
   *  the client believes it is on at mint time, so the minted instructions
   *  are also right from the first turn. Optional/back-compatible. */
  current_hole?: number;
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

// Voice REPLY calls can otherwise hang forever on flaky on-course networks
// (specs/voice-agent-audit.md #7). These budgets are generous because each hits
// an LLM (GPT reply generation is usually 1–4 s; long history / cold start can
// push higher), so they fire only on a genuine hang, never on a slow-but-live call.
const VOICE_REPLY_TIMEOUT_MS = 10_000;      // terminal /caddie/voice, per attempt
const VOICE_REPLY_RETRIES = 1;              // terminal call gets ONE transient retry
const VOICE_REPLY_RETRY_BACKOFF_MS = 500;   // brief pause so the retry doesn't hit the same dead air
const SESSION_VOICE_TIMEOUT_MS = 8_000;     // session-first call — fail fast into the stateless fallback
const SPEAK_TIMEOUT_MS = 10_000;            // best-effort TTS

// Calm, human degradation for an exhausted-transient voice reply. Deliberately
// short and free of machine markers so humanizeVoiceError() (dictation.ts) passes
// it through AS-IS, and it never leaks "AbortError"/"signal is aborted".
const CALM_REPLY_ERROR = "Couldn't reach your caddie — give that another try.";

interface VoiceTimeoutOpts {
  timeoutMs: number;
  retries?: number;   // default 0
  backoffMs?: number; // default 0
  signal?: AbortSignal; // optional external signal to COMPOSE with the timeout
}

/** POST a voice reply with a per-attempt timeout and optional transient retry.
 *  Contained to the voice reply path — do NOT generalise this into fetchAPI.
 *  Exported for api.timeout.test.ts. */
export async function postWithTimeout<T>(
  path: string,
  body: unknown,
  { timeoutMs, retries = 0, backoffMs = 0, signal }: VoiceTimeoutOpts,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    // Compose an external caller signal WITHOUT clobbering our timeout controller.
    // (AbortSignal.any is avoided for older-WKWebView portability.)
    const onExternalAbort = () => controller.abort(signal!.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      return await fetchAPI<T>(`/api${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      lastErr = err;
      // Caller cancelled (external), not our timeout → propagate as-is, never retry/normalize.
      if (signal?.aborted && !timedOut) throw err;
      const transient = timedOut || err instanceof TypeError;
      if (transient && attempt < retries) {
        if (backoffMs) await new Promise((r) => setTimeout(r, backoffMs));
        continue; // retry
      }
      if (transient) throw new Error(CALM_REPLY_ERROR); // exhausted transient → calm
      throw err; // HTTP / other → let humanizeVoiceError judge the raw message
    } finally {
      clearTimeout(timer); // cleared on EVERY path: success, throw, retry-continue
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(CALM_REPLY_ERROR); // unreachable; satisfies TS
}

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
  return postWithTimeout('/caddie/voice', {
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
  }, {
    timeoutMs: VOICE_REPLY_TIMEOUT_MS,
    retries: VOICE_REPLY_RETRIES,
    backoffMs: VOICE_REPLY_RETRY_BACKOFF_MS,
  });
}

// ── Voice Caddie — Streaming (specs/voice-streaming-replies-plan.md) ──
//
// Streams the caddie's TEXT reply so the golfer sees words begin rendering
// in <1s instead of waiting for the full Claude turn. TTS is UNCHANGED — the
// caddie still speaks once, after the full text lands.
//
// Transport: fetch() + ReadableStream.getReader() (NOT EventSource — our
// endpoints are authenticated POSTs with a JSON body, which EventSource
// can't send). SSE framing (server contract, not a shared model):
//   event: token\ndata: <json-encoded delta>\n\n     # zero or more
//   event: done\ndata: {}\n\n                          # exactly one on success
//   event: error\ndata: <json-encoded calm copy>\n\n   # exactly one on failure

// First-token fail-fast budget — mirrors SESSION_VOICE_TIMEOUT_MS's intent so
// a dead stream falls back to the next ladder tier quickly.
const STREAM_FIRST_TOKEN_TIMEOUT_MS = 8_000;
// Once a first token has arrived, only dead air this long is a failure — a
// stream that's actively emitting tokens can legitimately run well past this.
// No whole-body timeout: a live stream that keeps emitting tokens for 30s
// completes normally.
const STREAM_IDLE_TIMEOUT_MS = 10_000;

/**
 * Thrown when no `token` (nor `done`/`error`) arrived before the first-token
 * timeout, or the connection/HTTP call failed before any token landed. The
 * ONLY error class a caller may treat as fallback-eligible (advance to the
 * next ladder tier) — see CaddieSheet's 3-tier ladder. Any failure AFTER a
 * first token is terminal: falling back post-token would double-render /
 * double-speak on top of text already on screen.
 */
export class BeforeFirstByteError extends Error {
  constructor(message = "No reply yet — trying another way.") {
    super(message);
    this.name = "BeforeFirstByteError";
  }
}

/** Internal marker for a mid-stream `error` SSE event (or idle timeout) that
 *  arrived AFTER the first token — terminal, not fallback-eligible. Unwrapped
 *  to a plain Error before it reaches the caller so `instanceof
 *  BeforeFirstByteError` is the only branch point callers need. */
class _StreamTerminalError extends Error {}

interface ParsedFrame {
  event: string;
  data: string;
}

function parseSSEFrame(raw: string): ParsedFrame | null {
  let event = "";
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data = line.slice(6);
  }
  return event ? { event, data } : null;
}

interface StreamCaddieReplyOpts {
  /** Called once per token delta, in order, as it arrives. Never called for
   *  the non-progressive (getReader-absent) fallback path. */
  onToken: (delta: string) => void;
  firstTokenTimeoutMs: number;
  idleTimeoutMs: number;
  signal?: AbortSignal;
}

/**
 * POST an SSE caddie reply, delivering tokens progressively via `onToken`,
 * and resolve with the FULL accumulated text once `event: done` arrives.
 * Same auth path as speakCaddieReply (bypasses fetchAPI, which only speaks
 * JSON). See the timeout model + BeforeFirstByteError doc above — this is a
 * DIFFERENT model from postWithTimeout (no whole-body timeout; a stream
 * legitimately runs long while emitting tokens the whole time).
 */
export async function streamCaddieReply(
  path: string,
  body: unknown,
  { onToken, firstTokenTimeoutMs, idleTimeoutMs, signal }: StreamCaddieReplyOpts,
): Promise<string> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(signal!.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let sawFirstToken = false;
  let timedOutPreToken = false;
  let timedOutIdle = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const armFirstTokenTimer = () => {
    clearTimer();
    timer = setTimeout(() => {
      timedOutPreToken = true;
      controller.abort();
    }, firstTokenTimeoutMs);
  };
  const armIdleTimer = () => {
    clearTimer();
    timer = setTimeout(() => {
      timedOutIdle = true;
      controller.abort();
    }, idleTimeoutMs);
  };

  armFirstTokenTimer();

  try {
    const res = await fetch(`${API_BASE}/api${path}`, {
      method: "POST",
      headers: {
        ...(await authHeaders()),
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Never a real SSE body on a non-2xx — always pre-first-token.
      const text = await res.text().catch(() => "");
      throw new BeforeFirstByteError(text || `Stream failed (${res.status})`);
    }

    // WKWebView safety net: platform buffered the whole body (or getReader
    // isn't implemented). Read it whole and parse every frame at once —
    // correct, just non-progressive. onToken is deliberately NOT called
    // here; the caller applies the resolved full text directly.
    if (!res.body || typeof res.body.getReader !== "function") {
      const raw = await res.text();
      let accumulated = "";
      let resolved = false;
      for (const chunk of raw.split("\n\n")) {
        const frame = parseSSEFrame(chunk);
        if (!frame) continue;
        if (frame.event === "token") {
          accumulated += JSON.parse(frame.data) as string;
        } else if (frame.event === "error") {
          const calm = JSON.parse(frame.data) as string;
          throw accumulated ? new _StreamTerminalError(calm) : new BeforeFirstByteError(calm);
        } else if (frame.event === "done") {
          resolved = true;
        }
      }
      clearTimer();
      if (!resolved) {
        throw accumulated
          ? new _StreamTerminalError(CALM_REPLY_ERROR)
          : new BeforeFirstByteError();
      }
      return accumulated;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulated = "";
    let resolved = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const frame = parseSSEFrame(raw);
        if (!frame) continue;

        if (frame.event === "token") {
          const delta = JSON.parse(frame.data) as string;
          accumulated += delta;
          if (!sawFirstToken) {
            sawFirstToken = true;
            armIdleTimer();
          } else {
            armIdleTimer(); // reset on every token — dead air only, never a slow-but-live stream
          }
          onToken(delta);
        } else if (frame.event === "error") {
          const calm = JSON.parse(frame.data) as string;
          throw sawFirstToken ? new _StreamTerminalError(calm) : new BeforeFirstByteError(calm);
        } else if (frame.event === "done") {
          resolved = true;
          clearTimer();
          break;
        }
      }
      if (resolved) break;
    }

    clearTimer();
    if (!resolved) {
      // Connection closed without a `done` frame — treat like any other
      // stream failure, classified by whether a token had already landed.
      throw sawFirstToken
        ? new _StreamTerminalError(CALM_REPLY_ERROR)
        : new BeforeFirstByteError();
    }
    return accumulated;
  } catch (err) {
    clearTimer();
    if (err instanceof BeforeFirstByteError) throw err;
    if (err instanceof _StreamTerminalError) throw new Error(err.message); // unwrap: terminal, calm text preserved
    // Caller cancelled (external), not our timeout → propagate as-is, never normalize/fallback.
    if (signal?.aborted && !timedOutPreToken && !timedOutIdle) throw err;
    if (timedOutPreToken) throw new BeforeFirstByteError();
    if (timedOutIdle) throw new Error(CALM_REPLY_ERROR);
    if (!sawFirstToken) throw new BeforeFirstByteError(err instanceof Error ? err.message : undefined);
    throw new Error(CALM_REPLY_ERROR);
  } finally {
    clearTimer();
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }
}

/** Streaming twin of sessionVoice — 3-tier CaddieSheet ladder, tier 1. */
export async function sessionVoiceStream(
  params: { round_id: string; transcript: string; personality_id: string; hole_number: number },
  opts: { onToken: (delta: string) => void; signal?: AbortSignal },
): Promise<string> {
  return streamCaddieReply("/caddie/session/voice/stream", params, {
    onToken: opts.onToken,
    signal: opts.signal,
    firstTokenTimeoutMs: STREAM_FIRST_TOKEN_TIMEOUT_MS,
    idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
  });
}

/** Streaming twin of talkToCaddie (stateless) — CaddieSheet tier 2, LooperSheet tier 1. */
export async function talkToCaddieStream(
  params: {
    transcript: string;
    personality_id: string;
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
  },
  opts: { onToken: (delta: string) => void; signal?: AbortSignal },
): Promise<string> {
  return streamCaddieReply(
    "/caddie/voice/stream",
    {
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
    },
    {
      onToken: opts.onToken,
      signal: opts.signal,
      firstTokenTimeoutMs: STREAM_FIRST_TOKEN_TIMEOUT_MS,
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    },
  );
}

/**
 * Synthesize a completed caddie reply to speech (specs/voice-tts-sheet-replies,
 * specs/fix-ios-tts-playback-plan.md). fetchAPI only speaks JSON, so this uses
 * a direct call + authHeaders() — same auth pattern as transcribeBlob() in
 * lib/voice/deepgram.ts — and returns the raw mp3 Blob for the caller to play
 * through an <audio> element.
 *
 * Platform-branched (specs/fix-ios-tts-playback-plan.md Part A): on native
 * iOS, `capacitor.config.ts` has `CapacitorHttp.enabled = true`, which patches
 * `window.fetch` to route through native NSURLSession. This is the app's only
 * receive-binary fetch through that path, and the patched-fetch
 * `.blob()`/`.arrayBuffer()` reconstruction of a native binary response is
 * known-flaky (corrupt bytes and/or an untyped Blob) — `URL.createObjectURL`
 * on that Blob yields a resource WKWebView's <audio> element can't decode,
 * surfacing as `play()` rejecting with `NotSupportedError`. So on native we
 * bypass the patched fetch entirely and call the native HTTP plugin directly,
 * decoding its base64 response ourselves with the already-tested
 * `dataUrlToBlob` helper (guarantees correct bytes AND an explicit
 * `Blob.type`). On web we keep `fetch`, but still always re-type the body via
 * `arrayBuffer()` instead of `res.blob()` so `createObjectURL` is
 * deterministic even if a proxy/browser hands back an untyped blob.
 *
 * Note: `CapacitorHttp.request` has no `AbortSignal` support, so on native we
 * lose true mid-flight cancellation — `readTimeout`/`connectTimeout` replace
 * the manual `SPEAK_TIMEOUT_MS` timer for that branch. Overlap/barge-in
 * correctness is still fully preserved because the caller (useSheetTTS)
 * guards the result with `if (controller.signal.aborted) return` AFTER the
 * await — a superseded native response is discarded, never played. The web
 * branch keeps the existing AbortController/external-abort wiring unchanged.
 */
export async function speakCaddieReply(
  text: string,
  personalityId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  if (Capacitor.isNativePlatform()) {
    const resp = await CapacitorHttp.request({
      method: 'POST',
      url: `${API_BASE}/api/voice/speak`,
      headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
      data: { text, personality_id: personalityId },
      responseType: 'blob',
      readTimeout: SPEAK_TIMEOUT_MS,
      connectTimeout: SPEAK_TIMEOUT_MS,
    });
    if (resp.status < 200 || resp.status >= 300) {
      // On error resp.data is base64 of the error body — never feed it to the player.
      throw new Error(`Speak failed (${resp.status})`);
    }
    // With responseType: 'blob' on native, resp.data is a base64 string.
    // Reconstruct with an explicit type so createObjectURL is deterministic.
    return dataUrlToBlob(`data:audio/mpeg;base64,${resp.data}`);
  }

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(signal!.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), SPEAK_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/api/voice/speak`, {
      method: 'POST',
      headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, personality_id: personalityId }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Speak failed (${res.status}): ${await res.text()}`);
    }
    const buf = await res.arrayBuffer();
    return new Blob([buf], { type: 'audio/mpeg' });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}
