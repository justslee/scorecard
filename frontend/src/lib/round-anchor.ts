/**
 * Round course anchor — the geographic centre (+ mapped-course id) a round
 * carries from the moment it's created, so the round screen can render the
 * satellite map directly instead of re-resolving the course by name (which
 * silently dropped to the paper drawing on any miss).
 */

import type { Round } from "@/lib/types";

export interface CourseAnchor {
  lat: number;
  lng: number;
}

/** Anchor fields to include in a RoundCreate payload from a search selection. */
export interface RoundAnchorFields {
  courseLat?: number;
  courseLng?: number;
  mappedCourseId?: string;
}

/**
 * Derive the anchor fields from a CourseSearch selection payload.
 *
 * `source === "mapped"` means the id is a mapped-course UUID (ingested or
 * write-through row) — carry it so the round screen gets hole geometry, not
 * just a centre. Any selection with a known centre carries lat/lng.
 */
export function anchorFromSelectedCourse(selected: {
  id: number | string;
  source?: string;
  center?: { lat: number; lng: number };
} | null): RoundAnchorFields {
  if (!selected) return {};
  const fields: RoundAnchorFields = {};
  if (selected.center) {
    fields.courseLat = selected.center.lat;
    fields.courseLng = selected.center.lng;
  }
  if (selected.source === "mapped" && selected.id !== "" && selected.id != null) {
    fields.mappedCourseId = String(selected.id);
  }
  return fields;
}

/** The round's stored anchor centre, or null when absent (legacy rounds). */
export function roundCourseAnchor(
  round: Pick<Round, "courseLat" | "courseLng"> | null | undefined
): CourseAnchor | null {
  if (round?.courseLat == null || round?.courseLng == null) return null;
  return { lat: round.courseLat, lng: round.courseLng };
}
