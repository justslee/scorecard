// Pure helper: maps getRecentCourses() rows into calm list items for the
// /courses hub. Kept separate and pure so it is fully unit-testable without
// touching GolfAPI or any I/O.

import { courseHref } from "./course-url";

export interface RecentCourseRow {
  id: string | number;
  name: string;
  clubName: string;
}

export interface RecentCourseItem {
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

/**
 * Map getRecentCourses() rows to calm list items.
 * Recent rows carry no clubId, so href omits it — the detail page falls back
 * to getCourseDetails(id) alone.
 *
 * subtitle: clubName only when it differs from the display name (composed names
 * like "Bethpage Black" already contain the club).
 */
export function mapRecentCourses(
  rows: Array<{ id: string | number; name: string; clubName: string }>
): RecentCourseItem[] {
  return rows.map((r) => ({
    id: String(r.id),
    title: r.name,
    subtitle: r.clubName && r.clubName !== r.name ? r.clubName : "",
    href: courseHref({ courseId: r.id }),
  }));
}
