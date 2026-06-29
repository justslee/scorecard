import { Suspense } from "react";
import CourseDetailClient from "./CourseDetailClient";

// Static export shim: we emit ONE real static shell ("view"); the course id is
// carried in the query string (/courses/view?id=…) and read client-side, so
// navigation stays client-side (no hard reload → no Capacitor index.html
// fallback → no cold-boot AuthGate hang). See lib/course-url.ts.
export function generateStaticParams() {
  return [{ id: "view" }];
}

export default function Page() {
  // Suspense boundary required because CourseDetailClient reads useSearchParams()
  // (the course id comes from ?id=) — static export prerender bails to CSR here.
  return (
    <Suspense>
      <CourseDetailClient />
    </Suspense>
  );
}
