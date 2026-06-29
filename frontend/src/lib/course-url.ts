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
