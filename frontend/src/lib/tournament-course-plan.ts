// tournament-course-plan.ts — pure helpers for the per-round COURSE plan at
// tournament setup (specs/tournament-per-round-format-course-plan.md). Same
// extraction rationale as tournament-program.ts / tournament-standings.ts:
// vitest-testable without framer-motion / the rest of the client component
// tree. Reuses round-anchor.ts for anchor derivation — NO forked anchor logic.

import type { CourseSelectPayload } from "@/components/CourseSearch";
import type { Tournament, TournamentRoundCourse } from "@/lib/types";
import { anchorFromSelectedCourse } from "@/lib/round-anchor";

/** A CourseSearch selection → a stored plan entry (anchor + mapped identity). */
export function planEntryFromSelection(
  c: CourseSelectPayload
): TournamentRoundCourse {
  return {
    courseId: String(c.id),
    courseName: c.name,
    ...anchorFromSelectedCourse(c),
  };
}

/**
 * A stored plan entry → the shape CourseSearch selections use elsewhere
 * (pre-fill for the round-creation flow). Round-trips identity: mapped
 * selections come back mapped (yardage book / overlays / caddie follow),
 * centre-only selections come back centre-only. Never fabricates an anchor.
 */
export function selectionFromPlanEntry(e: TournamentRoundCourse): {
  id: string;
  name: string;
  source?: "mapped";
  center?: { lat: number; lng: number };
} {
  return {
    id: e.mappedCourseId ?? e.courseId,
    name: e.courseName,
    source: e.mappedCourseId ? "mapped" : undefined,
    center:
      e.courseLat != null && e.courseLng != null
        ? { lat: e.courseLat, lng: e.courseLng }
        : undefined,
  };
}

/**
 * Apply a course pick for `day` to the in-progress itinerary. The "one course
 * for all rounds" default: if no day is set yet (first pick), fill EVERY slot
 * with `c`; otherwise set only `prev[day]`. Pick Black once → whole trip at
 * Black; tap Day 2, pick Red → Day 2 overrides.
 */
export function applyDayCourseSelection(
  prev: (CourseSelectPayload | null)[],
  day: number,
  c: CourseSelectPayload
): (CourseSelectPayload | null)[] {
  const isFirstPick = prev.every((entry) => entry == null);
  if (isFirstPick) {
    return prev.map(() => c);
  }
  return prev.map((entry, i) => (i === day ? c : entry));
}

/**
 * The POST body's `roundCourses` field. Slices to `numRounds`, maps through
 * `planEntryFromSelection`. Returns `undefined` when every slot is null — the
 * byte-identical gate: an untouched itinerary writes NO field.
 */
export function buildRoundCoursesPayload(
  dayCourses: (CourseSelectPayload | null)[],
  numRounds: number
): (TournamentRoundCourse | null)[] | undefined {
  const sliced = dayCourses.slice(0, numRounds);
  if (sliced.every((entry) => entry == null)) return undefined;
  return sliced.map((entry) => (entry ? planEntryFromSelection(entry) : null));
}

/** 0-based index of the next day to draw. */
export function nextDayIndex(t: Pick<Tournament, "roundIds">): number {
  return t.roundIds.length;
}

/** The planned course name for `day` (0-based), or null when unset. */
export function planCourseNameForDay(
  t: Tournament,
  day: number
): string | null {
  return t.roundCourses?.[day]?.courseName ?? null;
}
