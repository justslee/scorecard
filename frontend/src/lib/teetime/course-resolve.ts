/**
 * Voice course resolution (specs/course-selection-ux-plan.md §A.2.2).
 *
 * Turns a spoken, *unmatched* course name — e.g. "marine park", heard on the
 * tee-time screen in Pittsburgh where the on-screen course list is all
 * Pittsburgh munis — into a REAL course through the ONE unified search that
 * typed search already uses (`searchAllCourses` → /api/courses/search: our DB
 * → Google Places → GolfAPI → anchored OSM, prefix-gated, server-cached 24h,
 * GolfAPI-budget-guarded). This is the missing middle of the
 * Marine-Park-from-Pittsburgh fix: A0 stopped the lie (never dispatch a search
 * that ignores a named course), A1 taught the backend to discover around a
 * selected course's center — this resolves the name so the RIGHT course gets
 * selected and searched.
 *
 * No fabrication, no GPS fallback: a spoken name resolves to a real facility
 * or it honestly doesn't. The decision:
 *   - one dominant hit   → "one"        (auto-add + search there)
 *   - 2–4 facilities     → "ambiguous"  (caddie asks which — the clarify turn
 *                                         that consumes candidates is A3)
 *   - zero placeable hit → "none"       (honest: couldn't find it)
 *   - search timed out   → "unreachable"(honest: couldn't reach search)
 *
 * Dominance is name-based, never location-based: a UNIQUE exact facility-name
 * match wins even amid weaker prefix hits ("Pebble Beach" → "Pebble Beach Golf
 * Links"), but two facilities that BOTH match the spoken name exactly (two
 * "Marine Park Golf Course"s in different cities) are genuinely ambiguous and
 * are never auto-added. `origin` only orders the ambiguous candidate list
 * (nearest first, for a calmer clarify) — it never fabricates a hit.
 */

import { searchAllCourses, type CourseSearchResult } from "@/lib/golf-api";
import {
  identifyingTokens,
  distanceMiles,
} from "@/lib/course-search-helpers";
import { localityLabel } from "@/lib/teetime/courses";

export interface ResolvedCourse {
  id: string;
  name: string;
  /** A real center — required (we need it for honest distance + the backend's
   *  selector-centered discovery). Hits without one are dropped, never guessed. */
  center: { lat: number; lng: number };
  /** Free-form location text (address), fed to courseOptionFromSelection so the
   *  added row inherits the same honest locality label the add-sheet produces. */
  location?: string;
}

export interface ResolvedCandidate {
  id: string;
  name: string;
  /** Honest short locality ("Brooklyn, NY"), "" when none — never invented. */
  localityLabel: string;
  /** Required — candidates are only ever built from a PlaceableResult, which
   *  guarantees a real center; the optional type was a lie that would force a
   *  guard downstream (A3). */
  center: { lat: number; lng: number };
  /** Free-form location text (address) — feeds a clarify pick into
   *  courseOptionFromSelection with the same honest input the "one" path uses. */
  address?: string;
}

export type SpokenCourseResolution =
  | { kind: "one"; course: ResolvedCourse }
  | { kind: "ambiguous"; candidates: ResolvedCandidate[] }
  | { kind: "none" }
  | { kind: "unreachable" };

const RESOLVE_TIMEOUT_MS = 4000;
const MAX_AMBIGUOUS_CANDIDATES = 4;

/** Distinct sentinel so a timed-out race is told apart from a real empty result
 *  (searchAllCourses swallows an abort and resolves []—an empty list is NOT a
 *  timeout, so we can't infer "unreachable" from [] alone). */
const TIMEOUT = { __resolveTimeout: true } as const;

type PlaceableResult = CourseSearchResult & { center: { lat: number; lng: number } };

export interface ResolveSpokenCourseOptions {
  timeoutMs?: number;
  /** Injectable unified-search fn — defaults to the real searchAllCourses.
   *  Tests stub this to drive the decision table without network I/O. */
  search?: (query: string, options?: { signal?: AbortSignal }) => Promise<CourseSearchResult[]>;
}

/**
 * Resolve a spoken course name to a real facility via the unified search.
 * Never throws; a failure or timeout resolves to "unreachable" / "none" so the
 * voice turn stays honest and never hangs the sheet.
 */
export async function resolveSpokenCourse(
  name: string,
  origin: { lat: number; lng: number } | null,
  options: ResolveSpokenCourseOptions = {},
): Promise<SpokenCourseResolution> {
  const query = name.trim();
  if (!query) return { kind: "none" };

  const search = options.search ?? searchAllCourses;
  const timeoutMs = options.timeoutMs ?? RESOLVE_TIMEOUT_MS;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(TIMEOUT);
    }, timeoutMs);
  });

  let raced: CourseSearchResult[] | typeof TIMEOUT;
  try {
    raced = await Promise.race([search(query, { signal: controller.signal }), timeout]);
  } catch {
    // searchAllCourses itself resolves [] on abort/network error, so a throw is
    // unexpected — treat it as an honest "couldn't reach search".
    return { kind: "unreachable" };
  } finally {
    if (timer) clearTimeout(timer);
  }
  // Array.isArray narrows the race result away from the timeout sentinel (a
  // plain === on two object types doesn't narrow the union).
  if (!Array.isArray(raced)) return { kind: "unreachable" };

  // searchAllCourses has already prefix-gated (every hit prefix-matches the
  // query) and deduped by facility name. We additionally require a real center
  // to place a course (honest distance + the backend's selector-centered
  // discovery); center-less rows can't be placed → dropped, never guessed.
  const placeable = raced.filter((r): r is PlaceableResult => !!r.center);
  if (placeable.length === 0) return { kind: "none" };

  // A UNIQUE exact facility-name match dominates — even if weaker prefix hits
  // sit alongside it. Two+ exact matches are genuinely ambiguous facilities.
  //
  // NOTE (defensive-only in prod): searchAllCourses dedupes its legs by
  // courseNameKey (name only, no city/id — golf-api.ts), so two DISTINCT
  // facilities with byte-identical names (e.g. two municipal "Lincoln Park Golf
  // Course"s in different cities) already collapse to one row before we see
  // them → this exact.length>=2 branch effectively fires only on the injected
  // test input. That matches typed search's own semantics (it too surfaces one
  // such row), so it's not a regression; true same-name/different-city
  // disambiguation needs a city-aware dedupe key and is deferred to A3.
  const exact = placeable.filter((r) => isExactFacilityMatch(r.name, query));
  if (exact.length === 1) return { kind: "one", course: toResolvedCourse(exact[0]) };
  if (exact.length >= 2) return ambiguousOf(exact, origin);

  // No exact match: a single prefix hit is unambiguous; several are a question.
  if (placeable.length === 1) return { kind: "one", course: toResolvedCourse(placeable[0]) };
  return ambiguousOf(placeable, origin);
}

/** Sequence-equal identifying tokens = the SAME facility name. "marine park" ==
 *  "Marine Park Golf Course" (golf/course are generic); "Marine Park Ridge"
 *  carries an extra token → not exact → never a silent auto-add. */
function isExactFacilityMatch(name: string, query: string): boolean {
  const nt = identifyingTokens(name);
  const qt = identifyingTokens(query);
  if (qt.length === 0 || nt.length !== qt.length) return false;
  return qt.every((t, i) => nt[i] === t);
}

function toResolvedCourse(r: PlaceableResult): ResolvedCourse {
  return {
    id: r.id,
    name: r.name,
    center: r.center,
    location: r.address,
  };
}

/** Build the ambiguous branch, ordering candidates nearest-first when we have
 *  an origin (a calmer clarify list); the A3 clarify turn consumes them. */
function ambiguousOf(
  results: PlaceableResult[],
  origin: { lat: number; lng: number } | null,
): SpokenCourseResolution {
  const ranked = origin
    ? [...results].sort(
        (a, b) => distanceMiles(origin, a.center) - distanceMiles(origin, b.center),
      )
    : results;
  const candidates: ResolvedCandidate[] = ranked
    .slice(0, MAX_AMBIGUOUS_CANDIDATES)
    .map((r) => ({
      id: r.id,
      name: r.name,
      localityLabel: localityLabel(r.name, r.address),
      center: r.center,
      address: r.address,
    }));
  return { kind: "ambiguous", candidates };
}
