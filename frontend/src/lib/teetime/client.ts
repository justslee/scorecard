/**
 * Tee-time API client.
 *
 * Thin wrapper around the backend /api/tee-times/* endpoints.  The UI calls
 * these functions; the backend holds the provider logic (secrets, caching, etc.)
 * so no provider credentials ever reach the client.
 *
 * S0 ("kill fake data", specs/teetime-s0-plan.md): a backend failure NO LONGER
 * silently serves the frontend mock catalogue on the real path — that was a
 * second fake-data leak alongside the (now-deleted) backend mock-fallback.
 * The mock fallback fires ONLY when the caller has explicitly opted in with
 * `NEXT_PUBLIC_TEETIME_PROVIDER=mock` (dev without the backend running); any
 * other failure rethrows so the UI shows the honest "provider unavailable" miss.
 */

import { fetchAPI } from "@/lib/api";
import type {
  TeeTimeQuery,
  TeeTimeSlot,
  BookingDetails,
  BookingResult,
  RehearsalCallResponse,
  CallerVoiceResponse,
  AvailabilityCallRequest,
  AvailabilityCallStatus,
} from "./types";
import { getActiveProvider } from "./registry";

// ─── Backend response shapes ──────────────────────────────────────────────────

export interface SearchResponse {
  query: TeeTimeQuery;
  results: TeeTimeSlot[];
  /** "mock" | "routing" | "golfnow" | "chronogolf" */
  provider: string;
  /** True when results come from cache. */
  cached: boolean;
}

export interface BookResponse {
  slotId: string;
  result: BookingResult;
}

// ─── Search ───────────────────────────────────────────────────────────────────

/** Explicit dev opt-in for the frontend mock catalogue — see the file docstring. */
function mockOptIn(): boolean {
  return process.env.NEXT_PUBLIC_TEETIME_PROVIDER === "mock";
}

/**
 * Search for available tee times.
 *
 * Calls the backend `GET /api/tee-times/search`. On failure: falls back to
 * the frontend mock provider ONLY when `NEXT_PUBLIC_TEETIME_PROVIDER=mock`
 * (explicit dev opt-in); otherwise rethrows so the caller shows an honest miss.
 */
export async function searchTeeTimes(query: TeeTimeQuery): Promise<TeeTimeSlot[]> {
  try {
    const params = new URLSearchParams({
      date: query.date,
      timeWindowStart: query.timeWindowStart,
      timeWindowEnd: query.timeWindowEnd,
      partySize: String(query.partySize),
    });
    if (query.area) params.set("area", query.area);
    if (query.maxDistanceMiles != null) params.set("maxDistanceMiles", String(query.maxDistanceMiles));
    if (query.maxPriceUsd != null) params.set("maxPriceUsd", String(query.maxPriceUsd));
    if (query.courseIds?.length) params.set("courseIds", query.courseIds.join(","));

    const data = await fetchAPI<SearchResponse>(`/api/tee-times/search?${params}`);
    return data.results;
  } catch (err) {
    if (!mockOptIn()) throw err;
    console.warn("[teetime] Backend unavailable — NEXT_PUBLIC_TEETIME_PROVIDER=mock, using frontend mock");
    return getActiveProvider().searchAvailability(query);
  }
}

// ─── Book ─────────────────────────────────────────────────────────────────────

/**
 * Attempt to book a slot.
 *
 * Calls the backend `POST /api/tee-times/book`. On failure: falls back to the
 * frontend mock provider ONLY when `NEXT_PUBLIC_TEETIME_PROVIDER=mock`
 * (explicit dev opt-in); otherwise rethrows.
 */
export async function bookTeeTime(slot: TeeTimeSlot, details: BookingDetails): Promise<BookingResult> {
  try {
    const data = await fetchAPI<BookResponse>("/api/tee-times/book", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot, details }),
    });
    return data.result;
  } catch (err) {
    if (!mockOptIn()) throw err;
    console.warn("[teetime] Backend unavailable — NEXT_PUBLIC_TEETIME_PROVIDER=mock, using frontend mock book");
    return getActiveProvider().book(slot, details);
  }
}

/**
 * Owner-only: place a REHEARSAL booking call to the owner's own verified number
 * (a self-call to validate the AI pro-shop caller before any real course is
 * dialed). No request body — the callee comes only from backend server config
 * (VOICE_BOOKING_OWNER_NUMBER); nothing here can influence which number rings.
 * Returns the transcript + outcome, or a structured "refused"/"not_enabled"
 * reason. No mock fallback — a failure surfaces honestly to the caller.
 */
export async function placeRehearsalCall(): Promise<RehearsalCallResponse> {
  return fetchAPI<RehearsalCallResponse>("/api/tee-times/rehearsal-call", {
    method: "POST",
  });
}

/**
 * Owner-only: get the caller's current preset-voice pick (resolved value,
 * raw saved preference, and the picker options). No voice CLONING — this is
 * Option B (specs/voice-clone-caller-plan.md §2B/§3): the owner chooses among
 * a calm subset of natural OpenAI Realtime preset voices.
 */
export async function getCallerVoice(): Promise<CallerVoiceResponse> {
  return fetchAPI<CallerVoiceResponse>("/api/tee-times/caller-voice");
}

/**
 * Owner-only: save the caller's preset-voice pick. The backend validates
 * against its allowlist and rejects anything else with 422.
 */
export async function setCallerVoice(voice: string): Promise<CallerVoiceResponse> {
  return fetchAPI<CallerVoiceResponse>("/api/tee-times/caller-voice", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voice }),
  });
}

// ─── Availability-by-call — S4e rung 3 ─────────────────────────────────────────
// User-initiated ONLY: call these from a tap on the "No online times — we can
// call the pro shop" CTA, NEVER as a side effect of search. Ships dark: with
// no Twilio keys the backend always answers status="not_enabled" and nothing
// is dialed — the caller must degrade to the honest tel: link on that status
// (see callTelHref in confirm-copy.ts).

/** Enqueue an availability-ASK call for one course/date/window/party. */
export async function requestAvailabilityCall(
  req: AvailabilityCallRequest
): Promise<AvailabilityCallStatus> {
  return fetchAPI<AvailabilityCallStatus>("/api/tee-times/availability-call", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
}

/** Poll the status of a previously enqueued availability-ASK call. */
export async function getAvailabilityCallStatus(id: string): Promise<AvailabilityCallStatus> {
  return fetchAPI<AvailabilityCallStatus>(
    `/api/tee-times/availability-call/${encodeURIComponent(id)}`
  );
}
