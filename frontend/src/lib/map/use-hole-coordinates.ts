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
import type { CourseCoordinates } from "@/lib/golf-api";

export interface HoleCoordinatesState {
  allCoords: CourseCoordinates[];
  courseCenter: { lat: number; lng: number } | null;
  loaded: boolean;
}

export function useHoleCoordinates(courseId: string | null): HoleCoordinatesState {
  const [allCoords, setAllCoords] = useState<CourseCoordinates[]>([]);
  const [courseCenter, setCourseCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!courseId) {
        if (!cancelled) {
          setAllCoords([]);
          setCourseCenter(null);
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
        const effective = coords.length > 0 ? coords : mappedCourseToCoordinates(course);
        setAllCoords(effective);
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

  return { allCoords, courseCenter, loaded };
}
