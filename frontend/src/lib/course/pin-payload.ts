/**
 * Pin → search-result identity mapping — the B.3 parity crux (B2 map mode).
 *
 * Maps an /in-bounds pin into the SAME CourseSearchResult shape
 * searchAllCourses emits (golf-api.ts's search-row mapper), so the marker
 * "Add" path can funnel through the identical `resultToPayload` the list
 * path uses. A course added from the map is therefore indistinguishable
 * from the same course added from the list — both run through the same
 * mapper on the same wire fields. See specs/course-selection-b2-plan.md §2.3.
 */

import { normalizeSource, sourceLabelFor, type CourseSearchResult, type InBoundsCourse } from "@/lib/golf-api";

export function pinToSearchResult(pin: InBoundsCourse): CourseSearchResult {
  return {
    id: pin.id,
    name: pin.name,
    address: pin.address ?? undefined,
    center: pin.center,
    source: normalizeSource(pin.source),
    sourceLabel: sourceLabelFor(pin.source),
  };
}
