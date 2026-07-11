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
// Prefix relevance filter
// ---------------------------------------------------------------------------

/**
 * Filler words that carry no identity in a course name. Stripped from the
 * QUERY before matching so "bethpage golf" still matches "Bethpage State Park".
 * MUST stay in sync with the backend's `matches_query_prefix` stopword list
 * (backend/app/services/course_finder.py) — the two filters mirror each other.
 */
const COURSE_QUERY_STOPWORDS = new Set([
  "golf",
  "course",
  "club",
  "links",
  "country",
  "the",
]);

/**
 * Normalize a course name / query into comparable word tokens:
 * lowercase, punctuation → word boundaries (unicode-aware), collapse spaces.
 * "Bethpage State Park - Black Course" → ["bethpage","state","park","black","course"]
 */
export function tokenizeCourseName(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Relevance gate: EVERY significant query token must prefix-match some word
 * of the course name. Mirrors the backend's `matches_query_prefix` so towns
 * from the geocoder ("Bethel Island", "Bethanga") never render for "bethpa",
 * even against a stale backend.
 *
 * - Stopwords (golf/course/club/…) are stripped from the query only; name
 *   words stay intact so "golf cl" can still prefix-match "… Golf Club".
 * - An all-stopword query ("golf") falls back to its literal tokens.
 * - An empty/punctuation-only query filters nothing (returns true).
 */
export function matchesQueryPrefix(name: string, query: string): boolean {
  const nameTokens = tokenizeCourseName(name);
  const rawQueryTokens = tokenizeCourseName(query);
  let queryTokens = rawQueryTokens.filter((t) => !COURSE_QUERY_STOPWORDS.has(t));
  if (queryTokens.length === 0) queryTokens = rawQueryTokens;
  if (queryTokens.length === 0) return true;
  return queryTokens.every((qt) => nameTokens.some((nt) => nt.startsWith(qt)));
}

/**
 * Stable dedupe key for a course name: lowercase, punctuation-stripped,
 * whitespace-collapsed. Keeps stopwords so "Bethpage Golf Club" and
 * "Bethpage Country Club" remain distinct.
 */
export function courseNameKey(name: string): string {
  return tokenizeCourseName(name).join(" ");
}

/**
 * True when the name has at least one token left after golf-generic words
 * are stripped — filters junk rows like a bare "Golf Course" that names
 * nothing, while keeping "Presidio Golf Course" (has "presidio"). Reuses the
 * same stopword list as the query-side prefix filter above.
 */
export function hasIdentifyingTokens(name: string): boolean {
  return tokenizeCourseName(name).some((t) => !COURSE_QUERY_STOPWORDS.has(t));
}

/**
 * The name's *identifying* tokens — tokenizeCourseName minus the golf-generic
 * stopwords (golf/course/club/links/country/the). "Marine Park Golf Course" →
 * ["marine","park"]. Used by voice resolution to test whether a search hit is
 * an EXACT facility-name match for a spoken name (so "Marine Park" resolves to
 * "Marine Park Golf Course" but never to the different-facility "Marine Park
 * Ridge", which carries an extra identifying token).
 */
export function identifyingTokens(text: string): string[] {
  return tokenizeCourseName(text).filter((t) => !COURSE_QUERY_STOPWORDS.has(t));
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

/** Cap on rendered/merged Nearby rows — a distance-sorted list this long is
 *  already more than a golfer scans; smaller payload/render too. Applied at
 *  this pure layer so every caller (mergeAndSortNearby, appendNearby)
 *  benefits without duplicating the cap. */
export const NEARBY_LIMIT = 12;

/** Shared distance comparator for nearby rows: nearest first (undefined
 *  distance sorts last), mapped source wins ties (it has full data). */
function byDistanceMappedFirst(a: NearbyResult, b: NearbyResult): number {
  const dA = a.distanceMi ?? Infinity;
  const dB = b.distanceMi ?? Infinity;
  if (dA !== dB) return dA - dB;
  if (a.source === "mapped" && b.source !== "mapped") return -1;
  if (b.source === "mapped" && a.source !== "mapped") return 1;
  return 0;
}

/**
 * Merge mapped + OSM nearby results, deduplicate by name, and sort by distance.
 * Mapped results rank first on ties (they have full data). Capped at `limit`.
 *
 * @param results   Raw results from searchNearby() or parallel mapped+OSM calls.
 * @param userLat   User's latitude.
 * @param userLng   User's longitude.
 */
export function mergeAndSortNearby(
  results: CourseSearchResult[],
  userLat: number,
  userLng: number,
  limit = NEARBY_LIMIT
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
  const sorted = withDist.sort(byDistanceMappedFirst);

  return dedupeByName(sorted).slice(0, limit);
}

/**
 * Append newly-arrived nearby results to an already-rendered list WITHOUT
 * reshuffling existing rows (the owner's no-reshuffle law — see
 * search-speed-and-golfapi-verify-plan.md). New rows are:
 *  1. Deduped against what's already shown (by `courseNameKey`).
 *  2. Sorted among THEMSELVES by distance, mapped-first tie-break (mirrors
 *     `mergeAndSortNearby`'s comparator).
 *  3. Appended BELOW the existing rows — existing rows never move.
 * The combined list is then capped at `limit`.
 */
export function appendNearby(
  existing: NearbyResult[],
  incoming: CourseSearchResult[],
  userLat: number,
  userLng: number,
  limit = NEARBY_LIMIT
): NearbyResult[] {
  const existingKeys = new Set(existing.map((r) => courseNameKey(r.name)));

  const withDist: NearbyResult[] = incoming
    .filter((r) => !existingKeys.has(courseNameKey(r.name)))
    .map((r) => ({
      ...r,
      distanceMi:
        r.center
          ? distanceMiles({ lat: userLat, lng: userLng }, r.center)
          : undefined,
    }));

  // Dedupe incoming against ITSELF too (e.g. an OSM leg with two similarly
  // named rows), keeping the closest copy — mirrors mergeAndSortNearby.
  const newSorted = dedupeByName(withDist.sort(byDistanceMappedFirst));

  return [...existing, ...newSorted].slice(0, limit);
}

// ---------------------------------------------------------------------------
// Idle-section dedupe (Favorites / Recent / Nearby) — Google-Maps-style
// search surface shows the three as separate lists; a course already
// pinned as a Favorite shouldn't also echo under Recent or Nearby.
// ---------------------------------------------------------------------------

export interface IdleSections<F, R, N> {
  favorites: F[];
  recent: R[];
  nearby: N[];
}

/**
 * Dedupe the three idle-state sections against each other by courseNameKey,
 * in priority order Favorites > Recent > Nearby. Favorites are always
 * returned in full (top priority, never dropped); a name already claimed by
 * Favorites is skipped in Recent, and a name already claimed by either is
 * skipped in Nearby.
 */
export function dedupeIdleSections<
  F extends { name: string },
  R extends { name: string },
  N extends { name: string },
>(favorites: F[], recent: R[], nearby: N[]): IdleSections<F, R, N> {
  const seen = new Set<string>();
  for (const f of favorites) seen.add(courseNameKey(f.name));

  const dedupedRecent: R[] = [];
  for (const r of recent) {
    const key = courseNameKey(r.name);
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedRecent.push(r);
  }

  const dedupedNearby: N[] = [];
  for (const n of nearby) {
    const key = courseNameKey(n.name);
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedNearby.push(n);
  }

  return { favorites, recent: dedupedRecent, nearby: dedupedNearby };
}

// ---------------------------------------------------------------------------
// Row view-model — one consolidated subline idiom for every CourseRow, no
// matter which section (Favorites / Recent / Nearby / typed results) it
// renders in. Composes "City, State · 2.3 mi · SOURCE" from whichever parts
// are available, skipping any that don't apply — never an empty separator.
// ---------------------------------------------------------------------------

export interface RowSublineParts {
  /** Course/property name — compared against clubName to avoid an echo. */
  name?: string;
  clubName?: string;
  city?: string;
  state?: string;
  distanceMi?: number;
  sourceLabel?: string;
}

/**
 * Compose the single mono subline shown under every CourseRow's title.
 * Falls back to clubName when there's no city/state (Favorite/Recent/GolfAPI
 * rows often only carry a club name, not a geocoded location).
 */
export function buildRowSubline(parts: RowSublineParts): string {
  const bits: string[] = [];
  const location = [parts.city, parts.state].filter(Boolean).join(", ");
  if (location) {
    bits.push(location);
  } else if (parts.clubName && parts.clubName !== parts.name) {
    bits.push(parts.clubName);
  }
  if (parts.distanceMi !== undefined) bits.push(formatMiles(parts.distanceMi));
  if (parts.sourceLabel) bits.push(parts.sourceLabel);
  return bits.join(" · ");
}

/**
 * Best-effort source tag for a search-result row: the real per-row label
 * from the backend (`sourceLabel`, added alongside `google_places` support)
 * when present, else a legacy fallback so mapped courses still show a tag
 * before that backend change lands.
 */
export function resultSourceLabel(r: { source?: string; sourceLabel?: string }): string | undefined {
  if (r.sourceLabel) return r.sourceLabel;
  if (r.source === "mapped") return "mapped";
  return undefined;
}
