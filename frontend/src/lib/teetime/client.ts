/**
 * Tee-time API client.
 *
 * Thin wrapper around the backend /api/tee-times/* endpoints.  The UI calls
 * these functions; the backend holds the provider logic (secrets, caching, etc.)
 * so no provider credentials ever reach the client.
 *
 * When the backend is unavailable (local dev without the backend running), the
 * client falls back to the frontend mock provider so the dev experience is smooth.
 */

import { fetchAPI } from "@/lib/api";
import type { TeeTimeQuery, TeeTimeSlot, BookingDetails, BookingResult } from "./types";
import { getActiveProvider } from "./registry";

// ─── Backend response shapes ──────────────────────────────────────────────────

export interface SearchResponse {
  query: TeeTimeQuery;
  results: TeeTimeSlot[];
  /** "mock" | "affiliate" | "golfnow" | "chronogolf" */
  provider: string;
  /** True when results come from cache. */
  cached: boolean;
}

export interface BookResponse {
  slotId: string;
  result: BookingResult;
}

// ─── Search ───────────────────────────────────────────────────────────────────

/**
 * Search for available tee times.
 *
 * Calls the backend `GET /api/tee-times/search`; falls back to the frontend
 * mock provider if the backend returns a non-2xx response or throws.
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
  } catch {
    // Fallback to frontend mock (e.g. backend not running locally).
    console.warn("[teetime] Backend unavailable — falling back to frontend mock");
    return getActiveProvider().searchAvailability(query);
  }
}

// ─── Book ─────────────────────────────────────────────────────────────────────

/**
 * Attempt to book a slot.
 *
 * Calls the backend `POST /api/tee-times/book`; falls back to the frontend
 * mock provider if the backend is unavailable.
 */
export async function bookTeeTime(slot: TeeTimeSlot, details: BookingDetails): Promise<BookingResult> {
  try {
    const data = await fetchAPI<BookResponse>("/api/tee-times/book", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot, details }),
    });
    return data.result;
  } catch {
    console.warn("[teetime] Backend unavailable — falling back to frontend mock book");
    return getActiveProvider().book(slot, details);
  }
}
