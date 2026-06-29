"use client";

/**
 * InlineHoleDiagram — compact hole-map embedded in the active-round view.
 *
 * PRIMARY renderer: Mapbox satellite imagery (GPSMapView in inline mode) when
 * NEXT_PUBLIC_MAPBOX_TOKEN is set.  Falls back to the on-paper HoleDiagram when
 * the token is absent so the map never goes blank.
 *
 * Data strategy:
 *   • `fetchMappedCourse` + `getCourseCoordinates` are called ONCE on mount.
 *   • Per-hole features and coordinates are indexed into Maps; changing
 *     `currentHole` is a cheap O(1) lookup with no network call.
 *   • While data loads the component renders nothing (scorecard stays visible
 *     immediately — the map appears when ready).
 *   • Any fetch error silently renders nothing (calm, not jarring).
 *
 * GPS:
 *   • A `GPSWatcher` runs while the component is mounted; the live position is
 *     passed to the renderer for the "you" dot and distance strip.
 *   • Permission denied → the dot is absent; tap-to-measure still works.
 *
 * Satellite mode (token present):
 *   • GPSMapView renders inline (fills the container, no fixed overlay).
 *   • F/C/B distances, GPS dot, and tap-to-measure overlaid on imagery.
 *
 * Paper mode (fallback):
 *   • HoleDiagram SVG — tap-to-measure, pinch-zoom, GPS dot, all unaffected.
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import type { HoleData } from '@/lib/courses/types';
import { fetchMappedCourse } from '@/lib/courses/mapped-course-api';
import { getCourseCoordinates } from '@/lib/course/course-coordinates';
import { GPSWatcher, type Position } from '@/lib/gps';
import { T } from '@/components/yardage/tokens';
import { indexByHoleNumber } from '@/lib/hole-index';
import HoleDiagram from './HoleDiagram';
import GPSMapView from '@/components/GPSMapView';
import { mapRendererFor, annotateOsmFeatures } from '@/lib/map/satellite-helpers';
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
  // Flat hole array — used by satellite mode to build annotated OSM features.
  const [allHoles, setAllHoles] = useState<HoleData[]>([]);
  // Flat coords array — passed to GPSMapView as holeCoordinates.
  const [allCoords, setAllCoords] = useState<CourseCoordinates[]>([]);
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
        setAllHoles(course.holes);

        const ci = new Map<number, CourseCoordinates>();
        for (const c of coords) ci.set(c.holeNumber, c);
        setCoordsIndex(ci);
        setAllCoords(coords);

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

  // All OSM features annotated with hole numbers — for GPSMapView overlays.
  // Computed here (not inside the conditional below) to satisfy Rules of Hooks.
  const osmFeaturesForSatellite = useMemo(
    () =>
      annotateOsmFeatures(
        allHoles.map((h) => ({
          holeNumber: h.number,
          features: (h.features?.features ?? []) as GeoJSON.Feature[],
        }))
      ),
    [allHoles]
  );

  // ── Renderer selection ────────────────────────────────────────────────────
  const renderer = mapRendererFor(process.env.NEXT_PUBLIC_MAPBOX_TOKEN);

  // ── PRIMARY: Satellite mode — inline GPSMapView ───────────────────────────
  // When the Mapbox token is configured AND we have GolfAPI coords (allCoords),
  // show the satellite map inline (fills the height container, no fixed overlay).
  // autoDetectHole is disabled: the round page controls currentHole.
  if (loaded && renderer === 'mapbox' && allCoords.length > 0) {
    // Graceful absence: if this hole has no geometry yet, still show the map
    // (GPSMapView degrades gracefully with no OSM polygons for this hole).
    return (
      <div
        style={{
          borderRadius: 10,
          overflow: 'hidden',
          border: '1px solid rgba(0,0,0,0.12)',
          height: `${height}px`,
          position: 'relative',
        }}
      >
        <GPSMapView
          courseId={courseId}
          courseName=""
          holeCoordinates={allCoords}
          currentHole={currentHole}
          onHoleChange={() => {
            // Round page controls the hole — ignore auto-detection updates.
          }}
          autoDetectHole={false}
          osmFeatures={osmFeaturesForSatellite}
          inline
        />
      </div>
    );
  }

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
