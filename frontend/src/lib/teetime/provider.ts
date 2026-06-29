/**
 * TeeTimeProvider interface.
 *
 * Every provider (Mock, Affiliate, GolfNow, Chronogolf) implements this
 * interface.  The registry returns a provider by name; the UI and backend
 * client only ever call through this interface.
 *
 * Adding a real provider later:
 *   1. Create `providers/<name>.ts` implementing TeeTimeProvider.
 *   2. Register it in `registry.ts` (conditionally — only when credentials exist).
 *   3. Zero UI changes required.
 */

import type { TeeTimeQuery, TeeTimeSlot, BookingDetails, BookingResult } from "./types";

export interface TeeTimeProvider {
  /** Stable identifier used in slot.provider and in the registry key. */
  readonly name: string;

  /**
   * Search for available tee times matching the query.
   * Returns an empty array (never throws) when no slots are found.
   * Results are normalised to TeeTimeSlot — providers handle their own
   * API calls, scraping, or data generation internally.
   */
  searchAvailability(query: TeeTimeQuery): Promise<TeeTimeSlot[]>;

  /**
   * Attempt to book a specific slot.
   * Phase 1 providers return `not_supported` with a `bookingUrl` (deep-link).
   * Phase 2+ providers (Chronogolf, GolfNow) complete the booking natively.
   */
  book(slot: TeeTimeSlot, details: BookingDetails): Promise<BookingResult>;
}
