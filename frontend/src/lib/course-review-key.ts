/**
 * course-review-key — pure helpers for resolving a stable course_key for B2.
 *
 * No React / DOM imports so this file is fully unit-testable in vitest and
 * reusable by B3 without any bundler concerns.
 *
 * Key resolution order (plan §0.2):
 *   1. GolfAPI id — match round.courseName against getRecentCourses() entries
 *      (by name or clubName after normalization); use String(match.id).
 *   2. name:<slug> fallback — always slash-free by construction (plan §0.3).
 *   3. null — when courseName is empty; RoundRecap hides the review form.
 */

/**
 * Normalize a course name to a slug safe for use as a URL path segment.
 * Rule: trim → toLowerCase → replace non-alnum runs with "-" → strip edge dashes.
 * Result contains only [a-z0-9-] — guaranteed no "/" or other path-significant chars.
 */
export function normalizeCourseName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Resolve a stable course_key for the given round.
 *
 * @param round  - Object with an optional courseName string.
 * @param recent - Array from getRecentCourses(): each entry has id, name, clubName.
 *                 The caller is responsible for reading this from localStorage; keeping
 *                 it out of this function preserves purity and SSR safety.
 * @returns A non-empty string course_key, or null when courseName is absent/blank.
 */
export function resolveCourseKey(
  round: { courseName?: string | null },
  recent: Array<{ id: number | string; name: string; clubName?: string }>,
): string | null {
  const raw = (round.courseName ?? '').trim();
  if (!raw) return null; // graceful hide — RoundRecap renders no review affordance

  const norm = normalizeCourseName(raw);

  // Step 1: prefer GolfAPI id — match by normalized name or clubName.
  const match = recent.find(
    (c) =>
      normalizeCourseName(c.name ?? '') === norm ||
      normalizeCourseName(c.clubName ?? '') === norm,
  );
  if (match && String(match.id) !== '') return String(match.id);

  // Step 2: name:<slug> fallback — slash-free by normalizeCourseName construction.
  return `name:${norm}`;
}
