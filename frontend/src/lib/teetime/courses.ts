/**
 * Nearby course options for the tee-time prefs screen.
 *
 * Real courses come from the existing course-search client
 * (`searchNearby` → /api/courses/mapped/nearby + /api/courses/nearby);
 * this module maps them into the prefs `CourseOption` shape with honest
 * distances. `toCourseOptions` is pure and unit-tested; the fetch wrapper
 * is the thin browser entry point.
 */

import type { CourseSearchResult } from "@/lib/golf-api";

/** A course row in the tee-time prefs UI. */
export interface CourseOption {
  id: string;
  name: string;
  /** Short town/city label, e.g. "SF" / "Pacifica". Empty when unknown. */
  muni: string;
  /** Drive distance in miles from the golfer (1 decimal). */
  distance: number;
  favorite: boolean;
  selected: boolean;
}

/** How many nearby courses the prefs list shows. */
export const MAX_COURSE_OPTIONS = 8;

/** Great-circle distance in miles (matches the backend's honest-distance math). */
export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(a));
}

/** Pull a short city label out of a free-form address. Empty string when unknown. */
export function muniFromAddress(address?: string): string {
  if (!address) return "";
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  // Drop street numbers, "CA 94121"-style segments, and country names.
  const cityish = parts.filter(
    (p) => !/^\d/.test(p) && !/^[A-Z]{2}(\s+[\d-]+)?$/.test(p) && !/united states/i.test(p)
  );
  return cityish.length > 0 ? cityish[cityish.length - 1] : "";
}

/**
 * Map raw course-search results into prefs options:
 * - honest distance from the golfer's position, sorted nearest-first
 * - de-duplicated by name, capped to MAX_COURSE_OPTIONS
 * - the golfer's favorited courses are flagged + pre-selected; when none of
 *   them are nearby, the nearest 3 are pre-selected instead.
 */
export function toCourseOptions(
  results: CourseSearchResult[],
  origin: { lat: number; lng: number },
  favorites: Array<{ id: string; name: string }> = [],
): CourseOption[] {
  const favIds = new Set(favorites.map((f) => f.id));
  const favNames = new Set(favorites.map((f) => f.name.toLowerCase()));

  const seen = new Set<string>();
  const options: CourseOption[] = [];
  for (const r of results) {
    if (!r.name || !r.center) continue;
    const nameKey = r.name.toLowerCase();
    if (seen.has(nameKey)) continue;
    seen.add(nameKey);
    options.push({
      id: r.id,
      name: r.name,
      muni: muniFromAddress(r.address) || r.city || "",
      distance: Math.round(haversineMiles(origin.lat, origin.lng, r.center.lat, r.center.lng) * 10) / 10,
      favorite: favIds.has(r.id) || favNames.has(nameKey),
      selected: false,
    });
  }

  options.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  const capped = options.slice(0, MAX_COURSE_OPTIONS);

  if (capped.some((o) => o.favorite)) {
    for (const o of capped) o.selected = o.favorite;
  } else {
    capped.forEach((o, i) => { o.selected = i < 3; });
  }
  return capped;
}

/**
 * Fetch real courses near the golfer and shape them for the prefs screen.
 * Radius covers the full drive slider (50 mi). Returns [] on any failure —
 * the caller keeps its offline/dev fallback list.
 */
export async function fetchNearbyCourseOptions(lat: number, lng: number): Promise<CourseOption[]> {
  try {
    const [{ searchNearby }, { listFavorites }] = await Promise.all([
      import("@/lib/golf-api"),
      import("@/lib/course-favorites"),
    ]);
    const results = await searchNearby(lat, lng, 50 * 1609);
    return toCourseOptions(results, { lat, lng }, listFavorites());
  } catch {
    return [];
  }
}
