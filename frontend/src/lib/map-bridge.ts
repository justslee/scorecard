/**
 * map-bridge — pure helpers for the round → hole-map deep link.
 *
 * All functions here are side-effect-free and testable without a DOM or React.
 * The round page calls resolveMappedCourse() to decide whether to show the
 * "View hole map" affordance, and buildMapUrl() to construct the link.
 * The map page calls parseHoleParam() to open the diagram at the right hole.
 *
 * No new dependencies — only the project's own normalizeCourseName util.
 */

import { normalizeCourseName } from './course-review-key';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Minimal shape returned by GET /api/courses/mapped (list endpoint). */
export interface MappedCourseListItem {
  id: string;
  name: string;
}

// ── Hole param helpers ────────────────────────────────────────────────────────

/**
 * Clamp a hole number to [1, totalHoles].
 *
 * @param n          - The raw (possibly float) hole number.
 * @param totalHoles - Upper bound; defaults to 18.
 */
export function clampHole(n: number, totalHoles = 18): number {
  const int = Math.round(n);
  return Math.max(1, Math.min(totalHoles, int));
}

/**
 * Parse the raw `?hole=` search-param string into a clamped hole number.
 *
 * Returns null when the param is absent or non-numeric so callers can
 * fall back to the default first-hole behaviour unchanged.
 *
 * @param raw        - Value of URLSearchParams.get("hole") (null when absent).
 * @param totalHoles - Forwarded to clampHole; defaults to 18.
 */
export function parseHoleParam(raw: string | null, totalHoles = 18): number | null {
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return clampHole(n, totalHoles);
}

// ── Mapped-course name match ──────────────────────────────────────────────────

/**
 * Conservatively match a round's courseName against the list of homegrown-mapped
 * courses returned by GET /api/courses/mapped.
 *
 * Matching rules (in priority order):
 *   1. Exact normalized-name match (case-insensitive, punctuation-folded).
 *   2. Prefix match: the mapped course's normalized name starts with the
 *      round's normalized name (handles "Bethpage" → "Bethpage Black").
 *      Only applied when the round name is ≥ 5 chars to avoid over-matching
 *      short inputs like "TPC".
 *
 * Rule 2 is deliberately narrow: a "Bethpage" round name will match a mapped
 * "Bethpage Black" course (mapped-name starts with the round-name prefix), but
 * the reverse is false — a "Bethpage Black" round won't match a mapped "Bethpage"
 * entry purely via prefix, because rule 1 would have caught an exact match first.
 *
 * Returns null when there is no confident match; callers hide the map link.
 */
export function resolveMappedCourse(
  courseName: string,
  courses: MappedCourseListItem[],
): MappedCourseListItem | null {
  const raw = courseName.trim();
  if (!raw || courses.length === 0) return null;

  const norm = normalizeCourseName(raw);
  if (!norm) return null;

  // Pass 1: exact normalized match.
  const exact = courses.find((c) => normalizeCourseName(c.name) === norm);
  if (exact) return exact;

  // Pass 2: conservative prefix match (round-name as prefix of mapped-name).
  // Only when the round name is long enough to be unambiguous.
  if (norm.length >= 5) {
    const prefix = courses.find((c) => normalizeCourseName(c.name).startsWith(norm));
    if (prefix) return prefix;
  }

  return null;
}

// ── URL builder ───────────────────────────────────────────────────────────────

/**
 * Build the deep-link URL for the hole map.
 *
 * @param courseId   - UUID of the mapped course.
 * @param holeNumber - Current hole (1-indexed); clamped before embedding.
 */
export function buildMapUrl(courseId: string, holeNumber: number): string {
  const h = clampHole(holeNumber);
  return `/map/course?id=${encodeURIComponent(courseId)}&hole=${h}`;
}
