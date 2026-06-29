"use client";

/**
 * InlineHoleDiagram — compact yardage-book hole diagram embedded in the
 * active-round view.
 *
 * Renders `HoleDiagram` for `currentHole` inline, visible by default.
 * No link or tap required — the map simply appears for mapped courses.
 *
 * Data strategy:
 *   • `fetchMappedCourse` + `getCourseCoordinates` are called ONCE when the
 *     component mounts (when `courseId` first becomes available).
 *   • Per-hole features and coordinates are indexed into Maps; changing
 *     `currentHole` is a cheap O(1) lookup with no network call.
 *   • While data loads the component renders nothing (scorecard stays visible
 *     immediately — the map appears when ready, not before).
 *   • Any fetch error silently renders nothing (calm, not jarring).
 *
 * GPS:
 *   • A `GPSWatcher` runs while the component is mounted; the live position is
 *     passed to `HoleDiagram` for the "you" dot and F/C/B distance strip.
 *   • Permission denied → the dot is simply absent; tap-to-measure still works.
 *
 * Pinch-zoom, pan, and tap-to-measure all work exactly as in the standalone
 * /map/course page — they are provided by HoleDiagram itself.
 */

import { useState, useEffect, useRef } from 'react';
import type { HoleData } from '@/lib/courses/types';
import { fetchMappedCourse } from '@/lib/courses/mapped-course-api';
import { getCourseCoordinates } from '@/lib/course/course-coordinates';
import { GPSWatcher, type Position } from '@/lib/gps';
import { T } from '@/components/yardage/tokens';
import { indexByHoleNumber } from '@/lib/hole-index';
import HoleDiagram from './HoleDiagram';
import type { CourseCoordinates } from '@/lib/golf-api';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract the raw GeoJSON features from a HoleData.features FeatureCollection. */
function holeFeatures(hole: HoleData): GeoJSON.Feature[] {
  return (hole.features?.features ?? []) as GeoJSON.Feature[];
}

// ── Auto-sized diagram wrapper ────────────────────────────────────────────────

/**
 * Sizes HoleDiagram to fill the container width; height is fixed.
 *
 * Uses a ResizeObserver to get the exact content-box width so the SVG fills
 * the container without overflow.  The SSR/first-paint fallback is 320 px —
 * replaced after the first ResizeObserver tick (~one animation frame).
 */
function SizedHoleDiagram({
  features,
  gpsPosition,
  courseCoords,
  height,
}: {
  features: GeoJSON.Feature[];
  gpsPosition: { lat: number; lng: number } | null;
  courseCoords: CourseCoordinates | null;
  height: number;
}) {
  const [width, setWidth] = useState(320);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w > 0) setWidth(Math.floor(w));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Proportional padding: keeps margins tasteful on both narrow and wide viewports.
  const padding = Math.max(20, Math.round(Math.min(width, height) * 0.06));

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: `${height}px`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      <HoleDiagram
        features={features}
        width={width}
        height={height}
        padding={padding}
        showLabels
        gpsPosition={gpsPosition}
        courseCoords={courseCoords}
      />
    </div>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

interface InlineHoleDiagramProps {
  /** UUID of the mapped course (from resolveMappedCourse). */
  courseId: string;
  /** 1-indexed current hole number; updates the diagram with no refetch. */
  currentHole: number;
  /** Fixed pixel height for the diagram container. Defaults to 260px. */
  height?: number;
}

export default function InlineHoleDiagram({
  courseId,
  currentHole,
  height = 260,
}: InlineHoleDiagramProps) {
  // Indexed course data — built once from the fetched CourseData.
  const [holeIndex, setHoleIndex] = useState<Map<number, HoleData>>(new Map());
  const [coordsIndex, setCoordsIndex] = useState<Map<number, CourseCoordinates>>(new Map());
  const [loaded, setLoaded] = useState(false);

  // Live GPS position from the watcher; null until first fix or on error.
  const [gpsPos, setGpsPos] = useState<Position | null>(null);

  // ── One-shot geometry + coordinate fetch ──────────────────────────────────
  useEffect(() => {
    if (!courseId) return;

    let cancelled = false;

    (async () => {
      try {
        const [course, coords] = await Promise.all([
          fetchMappedCourse(courseId),
          getCourseCoordinates(courseId),
        ]);
        if (cancelled) return;

        // Index holes and coordinates for O(1) per-hole lookup.
        setHoleIndex(indexByHoleNumber(course.holes));

        const ci = new Map<number, CourseCoordinates>();
        for (const c of coords) ci.set(c.holeNumber, c);
        setCoordsIndex(ci);

        setLoaded(true);
      } catch {
        // Silent — diagram simply won't appear. Score UI is unaffected.
        // This matches the "graceful absence" requirement.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [courseId]);

  // ── GPS watcher ───────────────────────────────────────────────────────────
  useEffect(() => {
    const watcher = new GPSWatcher(
      (pos) => setGpsPos(pos),
      () => {
        // Permission denied or transient error — leave gpsPos as-is.
        // Tap-to-measure in HoleDiagram continues to work without GPS.
      }
    );
    watcher.start();
    return () => watcher.stop();
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  // Not yet loaded: render nothing (scorecard is already visible above).
  if (!loaded) return null;

  const holeData = holeIndex.get(currentHole);
  if (!holeData) return null; // Hole number not in mapped data — shouldn't happen.

  const features = holeFeatures(holeData);
  if (features.length === 0) return null; // No geometry ingested for this hole.

  const holeCoords = coordsIndex.get(currentHole) ?? null;
  const gpsForDiagram = gpsPos ? { lat: gpsPos.lat, lng: gpsPos.lng } : null;

  return (
    // Yardage-book wrapper: paper background with a hairline border, flush with
    // the surrounding content — calm and on-paper, not a floating card.
    <div
      style={{
        borderRadius: 10,
        overflow: 'hidden',
        border: `1px solid ${T.hairline}`,
        background: T.paper,
      }}
    >
      <SizedHoleDiagram
        features={features}
        gpsPosition={gpsForDiagram}
        courseCoords={holeCoords}
        height={height}
      />
    </div>
  );
}
