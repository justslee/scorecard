/**
 * Pure helpers for course search result ranking, deduplication, and distance.
 *
 * All functions are side-effect-free so they can be unit-tested without any
 * I/O mocks. Intentionally no React or API imports.
 */

import type { CourseSearchResult } from "./golf-api";

// ---------------------------------------------------------------------------
// Distance helpers
// ---------------------------------------------------------------------------

/** Great-circle distance in miles between two lat/lng pairs (Haversine formula). */
export function distanceMiles(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 3958.8; // Earth radius in miles
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const aVal =
    sinDLat * sinDLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDLng * sinDLng;
  const c = 2 * Math.atan2(Math.sqrt(aVal), Math.sqrt(1 - aVal));
  return R * c;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Format a distance in miles to a short display string: "0.3 mi" / "12 mi". */
export function formatMiles(miles: number): string {
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Deduplicate an array of CourseSearchResult by name (case-insensitive),
 * keeping the first occurrence (which should be the highest-priority source
 * if the array is pre-sorted).
 */
export function dedupeByName(results: CourseSearchResult[]): CourseSearchResult[] {
  const seen = new Set<string>();
  const out: CourseSearchResult[] = [];
  for (const r of results) {
    const key = r.name.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Nearby merge + sort
// ---------------------------------------------------------------------------

export interface NearbyResult extends CourseSearchResult {
  /** Distance from the user's location in miles (undefined if no center). */
  distanceMi?: number;
}

/**
 * Merge mapped + OSM nearby results, deduplicate by name, and sort by distance.
 * Mapped results rank first on ties (they have full data).
 *
 * @param results   Raw results from searchNearby() or parallel mapped+OSM calls.
 * @param userLat   User's latitude.
 * @param userLng   User's longitude.
 */
export function mergeAndSortNearby(
  results: CourseSearchResult[],
  userLat: number,
  userLng: number
): NearbyResult[] {
  // Attach distances
  const withDist: NearbyResult[] = results.map((r) => ({
    ...r,
    distanceMi:
      r.center
        ? distanceMiles({ lat: userLat, lng: userLng }, r.center)
        : undefined,
  }));

  // Deduplicate by name (keeps first occurrence — we sort before deduping so
  // the closest copy wins)
  const sorted = withDist.sort((a, b) => {
    const dA = a.distanceMi ?? Infinity;
    const dB = b.distanceMi ?? Infinity;
    if (dA !== dB) return dA - dB;
    // Tie-break: mapped source first
    if (a.source === "mapped" && b.source !== "mapped") return -1;
    if (b.source === "mapped" && a.source !== "mapped") return 1;
    return 0;
  });

  return dedupeByName(sorted);
}
