/**
 * Nearby course options for the tee-time prefs screen.
 *
 * Real courses come from the existing course-search client
 * (`searchNearbyDetailed` → /api/courses/mapped/nearby + /api/courses/nearby);
 * this module maps them into the prefs `CourseOption` shape with honest
 * distances. The pure helpers (mapping, merge, add, radius, load-state) are
 * unit-tested; the fetch wrapper is the thin browser entry point and NEVER
 * throws — it reports failure honestly instead, so the page never has to
 * fall back to fake data.
 */

import type { CourseSearchResult } from "@/lib/golf-api";
import { hasIdentifyingTokens } from "@/lib/course-search-helpers";

/** A course row in the tee-time prefs UI. */
export interface CourseOption {
  id: string;
  name: string;
  /** Short town/city label, e.g. "SF" / "Pacifica". Empty when unknown. */
  muni: string;
  /**
   * Drive distance in miles from the golfer (1 decimal). Null when unknown —
   * a hand-added course without a geo center. Unknown-distance courses are
   * never silently filtered out of the search.
   */
  distance: number | null;
  favorite: boolean;
  selected: boolean;
}

/** How many nearby courses the prefs list shows. */
export const MAX_COURSE_OPTIONS = 8;

/** Fetch-radius clamps: never below ~3 mi, never above ~50 mi (Overpass-friendly). */
export const MIN_RADIUS_METERS = 5_000;
export const MAX_RADIUS_METERS = 80_000;

/** The "Max drive" slider (miles) → nearby-fetch radius in meters, clamped. */
export function radiusMetersForMiles(maxMiles: number): number {
  const meters = Math.round(maxMiles * 1609);
  return Math.max(MIN_RADIUS_METERS, Math.min(MAX_RADIUS_METERS, meters));
}

/** Great-circle distance in miles (matches the backend's honest-distance math). */
export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(a));
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** A whole address segment naming the country — "United States", "United
 *  States of America", "USA", "U.S.A." (anchored, never a substring match,
 *  so a real locality is never mistaken for one). */
const COUNTRY_SEGMENT_RE = /^(u\.?s\.?a\.?|united states(\s+of\s+america)?)$/i;

/** Word-final street suffixes — mark a lone segment as a road, not a town.
 *  Real one/two-word cities never end in these ("San Francisco", "Menlo Park"),
 *  so this only ever rejects a street name standing where a locality belongs. */
const STREET_SUFFIX_RE = /\b(rd|road|ave|avenue|blvd|pkwy|parkway|dr|drive|ln|lane|st|street|hwy|highway)$/i;
/** Tokens that mark a segment as a golf venue / state park — never a locality.
 *  Deliberately NOT bare "Park": real cities are named "Menlo Park", "Oak
 *  Park", so "Park" alone must survive; only "state park" + golf tokens drop. */
const VENUE_TOKEN_RE = /\b(golf|course|club|links|state\s+park)\b/i;

/** True when a segment plainly names a venue or street rather than a town. */
function isVenueOrStreetSegment(seg: string): boolean {
  const s = seg.trim();
  return VENUE_TOKEN_RE.test(s) || STREET_SUFFIX_RE.test(s);
}

/** Pull a short city label out of a free-form address. Empty string when unknown. */
export function muniFromAddress(address?: string): string {
  if (!address) return "";
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  // Drop street numbers, "CA 94121"-style segments, and country names —
  // "USA"/"United States of America" too, not just "United States" (no-fake-
  // data-adjacent honesty fix: a location label should read as a real
  // locality or be omitted, never leak a country-name suffix).
  const cityish = parts.filter(
    (p) => !/^\d/.test(p) && !/^[A-Z]{2}(\s+[\d-]+)?$/.test(p) && !COUNTRY_SEGMENT_RE.test(p)
  );
  if (cityish.length === 0) return "";
  const last = cityish[cityish.length - 1];
  // A LONE surviving segment that is plainly a venue/street ("Bethpage State
  // Park", "Finley Road") is a pseudo-locality — omit it rather than show it
  // where a town belongs. Only when it's the SOLE segment: with ≥2 cityish
  // parts the last is a real city (the street/venue sits earlier), so we never
  // touch it — "Marine Park Golf Course, Brooklyn" still yields "Brooklyn".
  if (cityish.length === 1 && isVenueOrStreetSegment(last)) return "";
  return last;
}

/** Tokenize a label case/space/punctuation-insensitively for comparison. */
function labelTokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean);
}

/** True when `sub`'s tokens appear as a contiguous run within `full`'s tokens. */
function isContiguousSubsequence(sub: string[], full: string[]): boolean {
  if (sub.length === 0 || sub.length > full.length) return false;
  for (let i = 0; i + sub.length <= full.length; i++) {
    if (sub.every((t, j) => full[i + j] === t)) return true;
  }
  return false;
}

/**
 * True when a derived `muni` would merely echo the course `name` — the muni's
 * words are a contiguous run of the name's words, or vice-versa. Used to omit
 * the locality so a row never reads "Marine Park Golf Course · Marine Park Golf
 * Course" (or "Tenafly · Tenafly"). Token-based, not substring, so "York"
 * never collides with "Yorktown".
 */
export function muniEchoesName(name: string, muni: string): boolean {
  if (!muni) return false;
  const n = labelTokens(name);
  const m = labelTokens(muni);
  if (m.length === 0) return false;
  return isContiguousSubsequence(m, n) || isContiguousSubsequence(n, m);
}

/**
 * The honest short locality label for a course: derive the town from the
 * address (dropping street numbers, state codes, countries, and lone
 * venue/street pseudo-localities), then omit it when it would just echo the
 * course name. "" when there's no honest locality to show. Use this at any
 * render site that shows a locality UNDER a course name, so the confirmation
 * path inherits the dedup rather than patching each surface.
 */
export function localityLabel(name: string, address?: string): string {
  const muni = muniFromAddress(address);
  return muniEchoesName(name, muni) ? "" : muni;
}

/** A stored favorite as this module needs it (course-favorites' shape fits). */
export interface FavoriteRef {
  id: string;
  name: string;
  center?: { lat: number; lng: number };
}

/**
 * Map raw course-search results into prefs options:
 * - honest distance from the golfer's position, sorted nearest-first
 * - de-duplicated by name, capped to MAX_COURSE_OPTIONS
 * - the golfer's favorited courses are flagged + pre-selected; when none of
 *   them are nearby, the nearest 3 are pre-selected instead
 * - real favorites OUTSIDE the results are appended with an honest distance
 *   when they have a stored center (no center → omitted, never guessed).
 */
export function toCourseOptions(
  results: CourseSearchResult[],
  origin: { lat: number; lng: number },
  favorites: FavoriteRef[] = [],
): CourseOption[] {
  const favIds = new Set(favorites.map((f) => f.id));
  const favNames = new Set(favorites.map((f) => f.name.toLowerCase()));

  const seen = new Set<string>();
  const options: CourseOption[] = [];
  for (const r of results) {
    if (!r.name || !r.center) continue;
    const nameKey = r.name.toLowerCase();
    const favorite = favIds.has(r.id) || favNames.has(nameKey);
    const rawCity = (r.city ?? "").trim();
    const derivedMuni = muniFromAddress(r.address) || (COUNTRY_SEGMENT_RE.test(rawCity) ? "" : rawCity);
    // Never let the locality echo the course name ("Tenafly · Tenafly").
    const muni = muniEchoesName(r.name, derivedMuni) ? "" : derivedMuni;
    // Junk rows: an all-generic name ("Golf Course") identifies nothing —
    // skip it UNLESS something else identifies it: the golfer favorited it,
    // or it carries a place ("Golf Course · Tenafly" is honest). Legit
    // all-generic names ("The Country Club", Brookline) keep their address,
    // so they survive; bare identity-free OSM ways don't.
    if (!hasIdentifyingTokens(r.name) && !favorite && !muni) continue;
    if (seen.has(nameKey)) continue;
    seen.add(nameKey);
    options.push({
      id: r.id,
      name: r.name,
      muni,
      distance: round1(haversineMiles(origin.lat, origin.lng, r.center.lat, r.center.lng)),
      favorite,
      selected: false,
    });
  }

  options.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0) || a.name.localeCompare(b.name));
  const capped = options.slice(0, MAX_COURSE_OPTIONS);

  if (capped.some((o) => o.favorite)) {
    for (const o of capped) o.selected = o.favorite;
  } else {
    capped.forEach((o, i) => { o.selected = i < 3; });
  }

  // Real favorites beyond the fetched results — honest distance via their
  // stored center. A favorite without a center can't be placed, so it's left
  // out rather than shown with a made-up distance.
  const present = new Set<string>();
  for (const o of capped) { present.add(o.id); present.add(o.name.toLowerCase()); }
  const beyond = favorites
    .filter((f) => f.center && !present.has(f.id) && !present.has(f.name.toLowerCase()))
    .map((f): CourseOption => ({
      id: f.id,
      name: f.name,
      muni: "",
      distance: round1(haversineMiles(origin.lat, origin.lng, f.center!.lat, f.center!.lng)),
      favorite: true,
      selected: true,
    }))
    .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));

  return [...capped, ...beyond];
}

/**
 * Merge freshly fetched nearby options into the golfer's current list without
 * clobbering it: existing rows keep their order and selection (toggles and
 * hand-added courses survive a refetch), new courses are appended. Appended
 * courses arrive pre-selected when they're a favorite — UNLESS the golfer has
 * already touched the list (toggled or hand-added a course), in which case
 * the first-load convenience never re-applies and every addition arrives
 * unselected, honoring whatever the golfer has already decided.
 */
export function mergeCourseOptions(
  existing: CourseOption[],
  incoming: CourseOption[],
  opts: { touched?: boolean } = {},
): CourseOption[] {
  if (existing.length === 0) return incoming;
  const present = new Set<string>();
  for (const o of existing) { present.add(o.id); present.add(o.name.toLowerCase()); }
  const additions = incoming
    .filter((o) => !present.has(o.id) && !present.has(o.name.toLowerCase()))
    .map((o) => ({ ...o, selected: opts.touched ? false : o.favorite }));
  return additions.length > 0 ? [...existing, ...additions] : existing;
}

/**
 * Merge `incoming` into `existing` (see mergeCourseOptions), then prune rows
 * that no longer fit the drive radius: `distance != null && distance >
 * maxMiles` rows are dropped UNLESS they're hand-added (distance null,
 * always kept), favorited, or the golfer's own selection — a voice-widened
 * or hand-picked far course is never silently dropped. Passing `existing`
 * for both `existing` and `incoming` re-prunes in place (the golfer shrank
 * "Max drive" — no new fetch needed, just a re-filter of what's already on
 * the list).
 */
export function reconcileCourseOptions(
  existing: CourseOption[],
  incoming: CourseOption[],
  opts: { maxMiles: number; touched?: boolean },
): CourseOption[] {
  const merged = mergeCourseOptions(existing, incoming, { touched: opts.touched });
  return merged.filter((o) => !(o.distance != null && o.distance > opts.maxMiles && !o.selected && !o.favorite));
}

/** What the add-course sheet hands back (subset of CourseSelectPayload). */
export interface AddedCourseSelection {
  id: string | number;
  name: string;
  /** Free-form location text, e.g. "Farmingdale, NY". */
  location?: string;
  center?: { lat: number; lng: number };
  favorite?: boolean;
}

/**
 * Shape a searched-and-picked course into a prefs option. Distance is honest:
 * computed from the payload's center and the golfer's position when BOTH
 * exist, otherwise null (shown as unknown — never invented).
 */
export function courseOptionFromSelection(
  sel: AddedCourseSelection,
  origin: { lat: number; lng: number } | null,
): CourseOption {
  const distance = sel.center && origin
    ? round1(haversineMiles(origin.lat, origin.lng, sel.center.lat, sel.center.lng))
    : null;
  return {
    id: String(sel.id),
    name: sel.name,
    muni: muniFromAddress(sel.location),
    distance,
    favorite: sel.favorite ?? false,
    selected: true,
  };
}

/**
 * Add a picked course to the list, de-duplicating by id or normalized name —
 * picking a course that's already listed just selects it.
 */
export function addCourseOption(existing: CourseOption[], added: CourseOption): CourseOption[] {
  const nameKey = added.name.trim().toLowerCase();
  const match = existing.find((o) => o.id === added.id || o.name.trim().toLowerCase() === nameKey);
  if (match) {
    return existing.map((o) => (o === match ? { ...o, selected: true } : o));
  }
  return [...existing, { ...added, selected: true }];
}

// ---------------------------------------------------------------------------
// Load state — the page renders honest copy instead of fake data
// ---------------------------------------------------------------------------

/**
 * Course-list load state machine:
 *   locating → loading → done | failed
 *   locating → unlocated            (no GPS fix and no last-known area)
 */
export type CourseLoadState = "locating" | "loading" | "done" | "failed" | "unlocated";

/** After the GPS attempt: an area (fresh or last-known) → fetch; none → unlocated. */
export function loadStateAfterLocate(area: string | null): CourseLoadState {
  return area ? "loading" : "unlocated";
}

/** After the nearby fetch: all legs down with nothing to show → failed; else done. */
export function loadStateAfterFetch(failed: boolean, optionCount: number): CourseLoadState {
  return failed && optionCount === 0 ? "failed" : "done";
}

/** Calm one-line copy for an empty course list, per load state. Never fake data. */
export function emptyCoursesNote(load: CourseLoadState, maxMiles: number): string {
  switch (load) {
    case "locating":
    case "loading":
      return "Finding courses near you…";
    case "failed":
      return "Couldn’t reach course search — add a course by name.";
    case "unlocated":
      return "Turn on location, or add a course by name.";
    case "done":
      return `No courses found within ${maxMiles} miles — widen the drive, or add one.`;
  }
}

/** What the fetch wrapper hands the page. */
export interface NearbyCourseOptionsResult {
  options: CourseOption[];
  /** True when every search leg failed — [] then means "couldn't look", not "none nearby". */
  failed: boolean;
}

/**
 * Fetch real courses near the golfer and shape them for the prefs screen.
 * Never throws: failures come back as `failed: true` so the page can say so
 * honestly instead of rendering a fallback list.
 */
export async function fetchNearbyCourseOptions(
  lat: number,
  lng: number,
  radiusMeters: number = MAX_RADIUS_METERS,
): Promise<NearbyCourseOptionsResult> {
  try {
    const [{ searchNearbyDetailed }, { listFavorites }] = await Promise.all([
      import("@/lib/golf-api"),
      import("@/lib/course-favorites"),
    ]);
    const { results, mappedOk, osmOk } = await searchNearbyDetailed(lat, lng, radiusMeters);
    const options = toCourseOptions(results, { lat, lng }, listFavorites());
    return { options, failed: !mappedOk && !osmOk };
  } catch {
    return { options: [], failed: true };
  }
}

// ---------------------------------------------------------------------------
// Race-hardened fetch session — mirrors course-search-session's
// AbortController + live-target-equality pattern so a mid-flight area/radius
// change (two locate fixes landing back to back) can never apply a STALE
// result over a newer one. Selections/order are separately protected by
// mergeCourseOptions' append-only merge.
// ---------------------------------------------------------------------------

/** The golfer's area + fetch radius — identifies one in-flight fetch. */
export interface CourseFetchTarget {
  area: string;
  radius: number;
}

function fetchTargetKey(t: CourseFetchTarget): string {
  return `${t.area}@${t.radius}`;
}

/** Injectable fetch function (fetchNearbyCourseOptions in production; a fake in tests). */
export type NearbyFetchFn = (lat: number, lng: number, radiusMeters: number) => Promise<NearbyCourseOptionsResult>;

export interface CourseFetchSessionCallbacks {
  /** Fires ONLY while `target` is still the live one — a superseded (older)
   *  fetch's result is silently dropped, never applied. */
  onResult: (result: NearbyCourseOptionsResult, target: CourseFetchTarget) => void;
}

export interface CourseFetchSession {
  /** Fetch nearby courses for `target`; supersedes any in-flight fetch. */
  fetch(target: CourseFetchTarget, lat: number, lng: number): void;
  /** Abort in-flight work (component unmount). */
  cancel(): void;
}

/**
 * Race-hardened nearby-course fetch session. `lastFetched`-style guards in
 * the page only compared against the LAST-SETTLED fetch, written post-await —
 * they can't stop a fetch for an OLDER target from landing after a NEWER one
 * if they happen to resolve out of order. This session tracks the live
 * target explicitly so a stale result is dropped no matter the arrival order.
 */
export function createCourseFetchSession(
  callbacks: CourseFetchSessionCallbacks,
  fetchFn: NearbyFetchFn = fetchNearbyCourseOptions,
): CourseFetchSession {
  let liveKey = "";
  let controller: AbortController | null = null;

  return {
    fetch(target, lat, lng) {
      controller?.abort();
      const key = fetchTargetKey(target);
      liveKey = key;
      const c = new AbortController();
      controller = c;
      const isLive = () => liveKey === key && !c.signal.aborted;

      fetchFn(lat, lng, target.radius)
        .then((result) => { if (isLive()) callbacks.onResult(result, target); })
        .catch(() => { /* fetchNearbyCourseOptions never throws — belt only */ });
    },
    cancel() {
      controller?.abort();
      controller = null;
    },
  };
}
