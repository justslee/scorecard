/**
 * Tee-time provider abstraction — public API.
 *
 * Import from "@/lib/teetime" in UI code; don't import from sub-modules directly
 * unless you need provider internals (e.g. in tests).
 */

export type { TeeTimeQuery, TeeTimeSlot, BookingDetails, BookingResult } from "./types";
export type {
  AvailabilityCallRequest,
  AvailabilityCallStatus,
  AvailabilityCallSpokenSlot,
} from "./types";
export type { TeeTimeProvider } from "./provider";
export { registerProvider, getProvider, getActiveProvider } from "./registry";
export { searchTeeTimes, bookTeeTime, requestAvailabilityCall, getAvailabilityCallStatus } from "./client";
export type { SearchResponse, BookResponse } from "./client";
