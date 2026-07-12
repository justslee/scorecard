"use client";

/**
 * InlineHoleDiagram — compact hole-map embedded in the active-round view.
 *
 * PRIMARY renderer: Google Maps satellite imagery (GoogleSatelliteMap in inline
 * mode) when NEXT_PUBLIC_GOOGLE_MAPS_KEY is set.  Falls back to the on-paper
 * HoleDiagram when the key is absent so the map never goes blank.
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
 * Google satellite mode (key present):
 *   • GoogleSatelliteMap renders inline (fills the container, no fixed overlay).
 *   • F/C/B distances, GPS dot, and tap-to-measure overlaid on imagery.
 *
 * Paper mode (fallback):
 *   • HoleDiagram SVG — tap-to-measure, pinch-zoom, GPS dot, all unaffected.
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import type { HoleData } from '@/lib/courses/types';
import { fetchMappedCourse, mappedCourseToCoordinates } from '@/lib/courses/mapped-course-api';
import { getCourseCoordinates } from '@/lib/course/course-coordinates';
import { attachTeeBoxes } from '@/lib/course/tee-anchor';
import { GPSWatcher, type Position } from '@/lib/gps';
import { T } from '@/components/yardage/tokens';
import { indexByHoleNumber } from '@/lib/hole-index';
import HoleDiagram from './HoleDiagram';
import GoogleSatelliteMap from '@/components/GoogleSatelliteMap';
import { mapRendererFor } from '@/lib/map/satellite-helpers';
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
  /**
   * UUID of the mapped course (from the round's anchor or resolveMappedCourse).
   * Optional: when absent, `fallbackCenter` drives a course-centred satellite view.
   */
  courseId?: string;
  /**
   * Course centre from the round's anchor — the satellite fallback when the
   * course has no mapped geometry (or the geometry fetch fails), so the round
   * map never silently disappears.
   */
  fallbackCenter?: { lat: number; lng: number };
  /** 1-indexed current hole number; updates the diagram with no refetch. */
  currentHole: number;
  /** Fixed pixel height for the diagram container. Defaults to 260px. */
  height?: number;
  /**
   * The round's chosen tee-box name — colors the Google satellite map's tee
   * marker (see GoogleSatelliteMapProps.teeMarker for the null/"" distinction).
   * Has no effect on the paper HoleDiagram fallback below (no tee marker there).
   */
  teeMarker?: string | null;
  /** Camera behavior on hole change — see GoogleSatelliteMapProps.cameraTransition. */
  cameraTransition?: "pan" | "cut";
  /**
   * Per-hole tee overrides (RoundPageClient's resolved tee anchor —
   * lib/course/tee-anchor.ts applyTeeAnchors) — replaces the tee point on
   * this component's own fetched coords before rendering, so the satellite
   * map's colored tee marker sits on the player's actual tee instead of an
   * arbitrary geometry pick (spec: multi-tee-anchor-reconciliation). A
   * `null` value for a hole means the honest card-only fallback (no marker).
   * Absent = unchanged (back-compat for callers without round context).
   */
  teeOverrideByHole?: ReadonlyMap<number, { lat: number; lng: number } | null>;
}

export default function InlineHoleDiagram({
  courseId,
  fallbackCenter,
  currentHole,
  height = 260,
  teeMarker = null,
  cameraTransition = "pan",
  teeOverrideByHole,
}: InlineHoleDiagramProps) {
  // Indexed course data — built once from the fetched CourseData.
  const [holeIndex, setHoleIndex] = useState<Map<number, HoleData>>(new Map());
  const [coordsIndex, setCoordsIndex] = useState<Map<number, CourseCoordinates>>(new Map());
  // Flat coords array — passed to GoogleSatelliteMap as holeCoordinates.
  const [allCoords, setAllCoords] = useState<CourseCoordinates[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Course centre (every CourseData has one) — a guaranteed satellite fallback so
  // the round map never drops to paper just because per-hole coords are missing.
  const [courseCenter, setCourseCenter] = useState<{ lat: number; lng: number } | null>(null);
  // Runtime Google-map failure → fall through to the on-paper HoleDiagram below
  // instead of an empty black box.
  const [googleMapFailed, setGoogleMapFailed] = useState(false);

  // Live GPS position from the watcher; null until first fix or on error.
  const [gpsPos, setGpsPos] = useState<Position | null>(null);

  // ── One-shot geometry + coordinate fetch ──────────────────────────────────
  useEffect(() => {
    if (!courseId) {
      // Anchor-only mode: no mapped geometry to fetch — render the satellite
      // view centred on the round's stored course centre.
      if (fallbackCenter) {
        setCourseCenter(fallbackCenter);
        setLoaded(true);
      }
      return;
    }

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
        if (course.location) setCourseCenter(course.location);

        // Prefer GolfAPI-verified coords; fall back to green/tee centroids derived
        // from the mapped OSM geometry so the satellite map still renders for
        // courses without GolfAPI data (e.g. any newly-mapped course) instead of
        // dropping to the paper diagram. golfapi/mock coords carry no teeBoxes
        // of their own — merge in the mapped course's tee-box polygons so
        // multi-tee holes are still selectable (spec: multi-tee-anchor-reconciliation).
        const effectiveCoords = coords.length > 0
          ? attachTeeBoxes(coords, course)
          : mappedCourseToCoordinates(course);

        const ci = new Map<number, CourseCoordinates>();
        for (const c of effectiveCoords) ci.set(c.holeNumber, c);
        setCoordsIndex(ci);
        setAllCoords(effectiveCoords);

        setLoaded(true);
      } catch {
        // Geometry fetch failed. With an anchor centre we still show the
        // satellite view (centre-only) — the round map should never silently
        // disappear. Without one: graceful absence, score UI unaffected.
        if (!cancelled && fallbackCenter) {
          setCourseCenter(fallbackCenter);
          setLoaded(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, fallbackCenter?.lat, fallbackCenter?.lng]);

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

  // ── Tee-anchor override (spec: multi-tee-anchor-reconciliation) ──────────
  // RoundPageClient resolves each hole's actual player-selected tee (via
  // applyTeeAnchors) from ITS OWN fetch of these same coords; this component
  // self-fetches independently, so the resolved override is threaded down as
  // a prop and merged onto the tee field here rather than re-resolved.
  const effectiveAllCoords = useMemo(() => {
    if (!teeOverrideByHole || teeOverrideByHole.size === 0) return allCoords;
    return allCoords.map((c) => {
      if (!teeOverrideByHole.has(c.holeNumber)) return c;
      return { ...c, tee: teeOverrideByHole.get(c.holeNumber) ?? undefined };
    });
  }, [allCoords, teeOverrideByHole]);

  const effectiveCoordsIndex = useMemo(() => {
    if (!teeOverrideByHole || teeOverrideByHole.size === 0) return coordsIndex;
    const idx = new Map(coordsIndex);
    for (const [holeNumber, override] of teeOverrideByHole) {
      const existing = idx.get(holeNumber);
      if (existing) idx.set(holeNumber, { ...existing, tee: override ?? undefined });
    }
    return idx;
  }, [coordsIndex, teeOverrideByHole]);

  // ── Renderer selection ────────────────────────────────────────────────────
  // Key changed from NEXT_PUBLIC_MAPBOX_TOKEN (Mapbox, retired) to
  // NEXT_PUBLIC_GOOGLE_MAPS_KEY (@capacitor/google-maps).
  const renderer = mapRendererFor(process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY);

  // ── PRIMARY: Google satellite mode — inline GoogleSatelliteMap ────────────
  // When the Google Maps key is configured AND we have GolfAPI coords (allCoords),
  // show the satellite map inline (fills the height container, no fixed overlay).
  // autoDetectHole is disabled: the round page controls currentHole.
  // fitBounds crash fixed in v1.0.601 — cameraForHole() + setCamera() used instead.
  const hasHoleCoords = allCoords.length > 0;
  const canShowSatellite =
    loaded && renderer === 'google' && !googleMapFailed && (hasHoleCoords || courseCenter != null);
  if (canShowSatellite) {
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
        <GoogleSatelliteMap
          courseId={courseId ?? ""}
          courseName=""
          holeCoordinates={hasHoleCoords ? effectiveAllCoords : []}
          currentHole={currentHole}
          onHoleChange={() => {
            // Round page controls the hole — ignore auto-detection updates.
          }}
          autoDetectHole={false}
          inline
          // Per-hole framing when we have coords; otherwise a course-centred
          // satellite view so the round map never falls back to paper.
          centerOnly={!hasHoleCoords}
          fallbackCenter={courseCenter ?? undefined}
          onFallback={() => setGoogleMapFailed(true)}
          teeMarker={teeMarker}
          cameraTransition={cameraTransition}
          mappedHoles={holeIndex}
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

  const holeCoords = effectiveCoordsIndex.get(currentHole) ?? null;
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
