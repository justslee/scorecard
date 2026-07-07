// Course deep-link URL helper.
//
// In the Capacitor static export (`output: 'export'`) a dynamic path segment
// like /courses/<realId> has no generated RSC data file, so Next falls back to
// a HARD browser navigation → Capacitor serves the root index.html shell → the
// app cold-boots and gets stuck on the AuthGate "Preparing your book" loader.
//
// Fix: navigate to a single STATICALLY-generated path (/courses/view) and carry
// the real id in the query string. The pathname maps to a real out/courses/view
// file, so the App Router transitions CLIENT-SIDE with no reload. CourseDetailClient
// reads the id from the query (?id=) — see useSearchParams there.
// This is the established fix (round + tournament already use the same pattern).

/** The single static course route segment (matches generateStaticParams in courses/[id]/page.tsx). */
export const COURSE_VIEW_SEGMENT = "view";

/** Client-navigable URL for a course by id, optionally with club id. */
export function courseHref(
  args: { courseId: string | number; clubId?: string | number }
): string {
  const id = encodeURIComponent(String(args.courseId));
  const base = `/courses/${COURSE_VIEW_SEGMENT}?id=${id}`;
  return args.clubId != null && String(args.clubId) !== ""
    ? `${base}&clubId=${encodeURIComponent(String(args.clubId))}`
    : base;
}

/**
 * Detail-page URL for ANY course search selection (the unified landing).
 *
 * Every source lands on /courses/view — the page with the start-round handoff —
 * never on the bare /map/course viewer (that stays reachable FROM detail):
 * - golfapi          → ?id&clubId (detail fetches the GolfAPI proxy, unchanged)
 * - mapped           → ?id&src=mapped (detail fetches /api/courses/mapped/{id})
 * - anything else w/ a centre → ?id&src&name&lat&lng(&loc) — no backend row is
 *   guaranteed for these (client-side OSM leg), so the params carry the display
 *   data and the detail page renders without a fetch.
 */
export function courseDetailHref(selection: {
  id: number | string;
  clubId?: number | string;
  source?: string;
  name?: string;
  location?: string;
  center?: { lat: number; lng: number };
}): string {
  const { id, clubId, source, name, location, center } = selection;
  if (source === "mapped") {
    return `/courses/${COURSE_VIEW_SEGMENT}?id=${encodeURIComponent(String(id))}&src=mapped`;
  }
  if (source && source !== "golfapi" && center) {
    const qs = new URLSearchParams({
      id: String(id),
      src: source,
      name: name ?? "",
      lat: String(center.lat),
      lng: String(center.lng),
    });
    if (location) qs.set("loc", location);
    return `/courses/${COURSE_VIEW_SEGMENT}?${qs.toString()}`;
  }
  return courseHref({ courseId: id, clubId });
}
