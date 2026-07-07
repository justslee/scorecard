// Pure helper: maps getRecentCourses() rows into calm list items for the
// /courses hub. Kept separate and pure so it is fully unit-testable without
// touching GolfAPI or any I/O.

import { courseDetailHref } from "./course-url";

export interface RecentCourseRow {
  id: string | number;
  name: string;
  clubName: string;
  source?: string;
  center?: { lat: number; lng: number };
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
 * to getCourseDetails(id) alone. Rows saved with source/center route to the
 * matching detail mode (mapped / centre-only) instead of the GolfAPI path.
 *
 * subtitle: clubName only when it differs from the display name (composed names
 * like "Bethpage Black" already contain the club).
 */
export function mapRecentCourses(rows: RecentCourseRow[]): RecentCourseItem[] {
  return rows.map((r) => ({
    id: String(r.id),
    title: r.name,
    subtitle: r.clubName && r.clubName !== r.name ? r.clubName : "",
    href: courseDetailHref({
      id: r.id,
      source: r.source,
      name: r.name,
      center: r.center,
    }),
  }));
}
