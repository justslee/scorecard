// Course → round handoff via sessionStorage.
//
// Passes a rich course object from /courses/view to /round/new without
// restructuring round/new (no Suspense/useSearchParams rewrite) and without
// URL-length concerns for large objects.
//
// Uses sessionStorage (not localStorage) so a stale handoff never survives an
// app relaunch and silently overrides a fresh manual/voice setup.
//
// Both read and write are SSR-safe (typeof window guard).

const KEY = "looper_course_handoff";

/**
 * Shape MUST remain compatible with SelectedCourse in round/new/page.tsx.
 * Keep these in sync: { id, name, clubName?, location?, holes?, par?, source?, center? }.
 */
export interface CourseHandoff {
  id: number | string;
  name: string;
  clubName?: string;
  location?: string;
  holes?: number;
  par?: number;
  /** "mapped" means id is a mapped-course UUID (see round-anchor.ts). */
  source?: string;
  /** Geographic centre — becomes the round's course anchor when present. */
  center?: { lat: number; lng: number };
}

/** Write the course into sessionStorage for round/new to consume on mount. */
export function stashCourseForRound(c: CourseHandoff): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    // Storage full or blocked — silently ignore; round/new degrades gracefully.
  }
}

/**
 * Read-and-clear the stashed course (one-shot).
 * Returns null when nothing is stashed or on any parse error.
 */
export function takeCourseForRound(): CourseHandoff | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY); // clear immediately — one-shot
    return JSON.parse(raw) as CourseHandoff;
  } catch {
    return null;
  }
}
