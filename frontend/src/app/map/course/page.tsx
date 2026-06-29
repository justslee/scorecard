"use client";

/**
 * Homegrown-course map viewer — /map/course?id=<mapped-course-uuid>
 *
 * Loads a mapped course from GET /api/courses/mapped/{id}, converts its
 * GeoJSON polygon features to CourseCoordinates for GPSMapView markers +
 * distance calculations, and passes the raw polygon features as the new
 * ``osmFeatures`` prop so GPSMapView can render greens / fairways / bunkers
 * as calm polygon overlays over the satellite basemap.
 *
 * This is a minimal POC viewer that proves "a hole map from free data, no
 * GolfAPI."  The URL parameter is ``?id=`` (query param, not a dynamic
 * segment) so no generateStaticParams is needed — matches the pattern used
 * by /players/view.
 *
 * Usage:
 *   http://localhost:3000/map/course?id=<deterministic-uuid-of-bethpage-black>
 *
 * The deterministic UUID for Bethpage Black can be obtained by running:
 *   uv run backend/scripts/ingest_osm_course.py --dry-run
 * and reading the "Course UUID:" line.
 */

import { Suspense, useEffect, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { ChevronLeft, Loader2, AlertCircle } from "lucide-react";
import dynamic from "next/dynamic";
import type { CourseData } from "@/lib/courses/types";
import type { CourseCoordinates } from "@/lib/golf-api";
import {
  fetchMappedCourse,
  mappedCourseToCoordinates,
  getAllHoleFeatures,
} from "@/lib/courses/mapped-course-api";

// GPSMapView uses mapbox-gl which requires the browser; disable SSR.
const GPSMapView = dynamic(() => import("@/components/GPSMapView"), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 bg-zinc-950 flex items-center justify-center">
      <Loader2 className="w-10 h-10 text-emerald-500 animate-spin" />
    </div>
  ),
});

// ── Inner client component (uses useSearchParams — must be inside Suspense) ──

function MappedCourseMapInner() {
  const params = useSearchParams();
  const router = useRouter();
  const courseId = params.get("id") ?? "";

  const [course, setCourse] = useState<CourseData | null>(null);
  const [holeCoords, setHoleCoords] = useState<CourseCoordinates[]>([]);
  const [osmFeatures, setOsmFeatures] = useState<GeoJSON.Feature[]>([]);
  const [currentHole, setCurrentHole] = useState(1);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(courseId));

  // Derive a static error when no id is present (no effect needed).
  const error = !courseId ? "No course id provided (?id=<uuid>)" : fetchError;

  useEffect(() => {
    if (!courseId) return;

    let cancelled = false;

    (async () => {
      setLoading(true);
      setFetchError(null);
      try {
        const c = await fetchMappedCourse(courseId);
        if (cancelled) return;
        setCourse(c);
        const coords = mappedCourseToCoordinates(c);
        setHoleCoords(coords);
        setOsmFeatures(getAllHoleFeatures(c));
        // Start on the first hole that has coordinates.
        if (coords.length > 0) setCurrentHole(coords[0].holeNumber);
      } catch (e: unknown) {
        if (!cancelled) {
          setFetchError(
            e instanceof Error ? e.message : "Failed to load mapped course"
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [courseId]);

  const handleClose = useCallback(() => {
    router.back();
  }, [router]);

  if (loading) {
    return (
      <div className="fixed inset-0 bg-zinc-950 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-10 h-10 text-emerald-500 animate-spin mx-auto mb-3" />
          <p className="text-zinc-400 text-sm">Loading course map…</p>
        </div>
      </div>
    );
  }

  if (error || !course) {
    return (
      <div className="fixed inset-0 bg-zinc-950 flex flex-col items-center justify-center gap-4 p-6">
        <AlertCircle className="w-10 h-10 text-red-400" />
        <p className="text-white text-center text-sm">
          {error ?? "Course not found"}
        </p>
        <button
          onClick={handleClose}
          className="flex items-center gap-1 text-zinc-400 hover:text-white text-sm"
        >
          <ChevronLeft size={16} />
          Go back
        </button>
      </div>
    );
  }

  if (holeCoords.length === 0) {
    return (
      <div className="fixed inset-0 bg-zinc-950 flex flex-col items-center justify-center gap-4 p-6">
        <p className="text-zinc-400 text-sm text-center">
          This course has no mapped geometry yet.
          <br />
          Run the ingest script to populate it.
        </p>
        <button
          onClick={handleClose}
          className="flex items-center gap-1 text-zinc-400 hover:text-white text-sm"
        >
          <ChevronLeft size={16} />
          Go back
        </button>
      </div>
    );
  }

  return (
    <GPSMapView
      courseId={0}
      courseName={course.name}
      holeCoordinates={holeCoords}
      currentHole={currentHole}
      onHoleChange={setCurrentHole}
      onClose={handleClose}
      osmFeatures={osmFeatures}
    />
  );
}

// ── Page shell with Suspense boundary (required for useSearchParams) ──────────

export default function MappedCourseMapPage() {
  return (
    <Suspense
      fallback={
        <div className="fixed inset-0 bg-zinc-950 flex items-center justify-center">
          <Loader2 className="w-10 h-10 text-emerald-500 animate-spin" />
        </div>
      }
    >
      <MappedCourseMapInner />
    </Suspense>
  );
}
