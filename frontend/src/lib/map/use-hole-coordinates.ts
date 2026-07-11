"use client";

/**
 * useHoleCoordinates — fetch a mapped course's per-hole coordinates once and
 * expose them for BOTH the inline hole map and the fullscreen blow-up, so they
 * share a single source (no double render logic, one fetch).
 *
 * Mirrors InlineHoleDiagram's strategy: prefer GolfAPI-verified coords, fall
 * back to green/tee centroids (or the hole centerline) derived from the mapped
 * OSM geometry, and always expose the course centre as a last-resort camera.
 */

import { useEffect, useState } from "react";
import { fetchMappedCourse, mappedCourseToCoordinates } from "@/lib/courses/mapped-course-api";
import { getCourseCoordinates } from "@/lib/course/course-coordinates";
import { attachTeeBoxes } from "@/lib/course/tee-anchor";
import type { CourseCoordinates } from "@/lib/golf-api";
import type { HoleData } from "@/lib/courses/types";

export interface HoleCoordinatesState {
  allCoords: CourseCoordinates[];
  courseCenter: { lat: number; lng: number } | null;
  loaded: boolean;
  /** The mapped course's per-hole data, including `yardages` (tee name ->
   *  card yardage) — surfaced so callers can hydrate a golfer's SELECTED tee
   *  card yardage (specs/caddie-yardage-gps-selected-tee-plan.md §2.2), not
   *  just geometry. Empty until loaded. */
  courseHoles: HoleData[];
}

export function useHoleCoordinates(courseId: string | null): HoleCoordinatesState {
  const [allCoords, setAllCoords] = useState<CourseCoordinates[]>([]);
  const [courseCenter, setCourseCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [courseHoles, setCourseHoles] = useState<HoleData[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!courseId) {
        if (!cancelled) {
          setAllCoords([]);
          setCourseCenter(null);
          setCourseHoles([]);
          setLoaded(false);
        }
        return;
      }
      try {
        const [course, coords] = await Promise.all([
          fetchMappedCourse(courseId),
          getCourseCoordinates(courseId),
        ]);
        if (cancelled) return;
        // golfapi-cache/mock coords carry no teeBoxes of their own — merge in
        // the mapped course's stored tee-box polygons so multi-tee holes are
        // still selectable (spec: multi-tee-anchor-reconciliation). The
        // mappedCourseToCoordinates() branch already includes them.
        const effective = coords.length > 0
          ? attachTeeBoxes(coords, course)
          : mappedCourseToCoordinates(course);
        setAllCoords(effective);
        setCourseHoles(course.holes ?? []);
        if (course.location) setCourseCenter(course.location);
        setLoaded(true);
      } catch {
        // Silent — the map simply won't be available; the round UI is unaffected.
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  return { allCoords, courseCenter, loaded, courseHoles };
}
