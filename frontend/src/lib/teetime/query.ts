/**
 * Tee-time query building — pure logic extracted from the /tee-time page so
 * it can be unit-tested (per-window dates, area inclusion, fallback window).
 */

import type { TeeTimeQuery } from "./types";
import { dateForWindowLabel, nextDateForWeekday } from "./dates";

/** The slice of prefs state the Searching phase turns into provider queries. */
export interface QueryPrefs {
  /**
   * Selected time windows (already filtered to `selected`). `date` is the
   * real ISO date the window carries (set by the calendar picker, a preset,
   * or voice) — when present it's used VERBATIM; `label` is display-only and
   * only drives the date as a fallback for older callers.
   */
  windows: Array<{ label: string; start: string; end: string; date?: string }>;
  /** Selected course ids (already filtered to within the drive radius). */
  courseIds: string[];
  partySize: number;
  maxDistanceMiles: number;
  /** Price ceiling in USD — set by voice ("under $80"). Omitted when unset. */
  maxPriceUsd?: number;
  /** "lat,lng" from geolocation, or a place name. Omitted when unknown. */
  area?: string;
}

/**
 * Fan the selected windows out into one TeeTimeQuery each.
 *
 * - Each window searches the next occurrence of ITS OWN day label
 *   (Sunday windows get Sunday's date — not Saturday's).
 * - `area` rides on every query when known; omitted otherwise.
 * - No windows selected → a single broad Saturday-morning query.
 */
export function buildTeeTimeQueries(prefs: QueryPrefs, from: Date = new Date()): TeeTimeQuery[] {
  const base = {
    partySize: prefs.partySize,
    maxDistanceMiles: prefs.maxDistanceMiles,
    ...(prefs.maxPriceUsd != null ? { maxPriceUsd: prefs.maxPriceUsd } : {}),
    ...(prefs.area ? { area: prefs.area } : {}),
    ...(prefs.courseIds.length > 0 ? { courseIds: prefs.courseIds } : {}),
  };

  if (prefs.windows.length === 0) {
    return [{
      date: nextDateForWeekday(6, from), // next Saturday — the default dispatch day
      timeWindowStart: "06:00",
      timeWindowEnd: "12:00",
      ...base,
    }];
  }

  return prefs.windows.map((w) => ({
    date: w.date ?? dateForWindowLabel(w.label, from),
    timeWindowStart: w.start,
    timeWindowEnd: w.end,
    ...base,
  }));
}

/** Format a geolocated position as the "lat,lng" area the backend prefers. */
export function formatAreaLatLng(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}
