"use client";

/**
 * Homegrown-course hole diagram viewer — /map/course?id=<mapped-course-uuid>
 *
 * Loads a mapped course from GET /api/courses/mapped/{id} and renders each
 * hole as a calm, top-down yardage-book diagram: tee at bottom, green at top,
 * geometry derived from ingested OSM polygons (green / fairway / tee / bunker
 * / water).
 *
 * What this page does NOT do:
 *   - No Mapbox / satellite imagery
 *   - No live GPS distances shown for off-hole positions (no "50531 yds" bug)
 *   - No mapbox-gl import
 *
 * Navigation: ◄ / ► buttons step through holes 1–18.
 * The current hole number and course name are shown in the header.
 *
 * GPS behaviour:
 *   - Permission is requested lazily when the component mounts.
 *   - When the player is within ~720 yds of the current hole, a "you" dot
 *     appears on the diagram and distances are shown in the info strip.
 *   - When the player is remote (e.g. on another hole, or at home), GPS info
 *     is suppressed — no absurd yardage numbers.
 *   - If GPS permission is denied, tap-to-measure still works normally.
 *
 * Usage:
 *   http://localhost:3000/map/course?id=<deterministic-uuid-of-bethpage-black>
 */

import { Suspense, useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Loader2, AlertCircle } from "lucide-react";
import type { CourseData, HoleData } from "@/lib/courses/types";
import { fetchMappedCourse } from "@/lib/courses/mapped-course-api";
import HoleDiagram from "@/components/course/HoleDiagram";
import {
  holeLengthYards,
  describeHazards,
  projectHole,
  isOnHoleBbox,
  yardsDistance,
  type ProjectedHole,
} from "@/lib/course/hole-projection";
import {
  extractHoleElevation,
  formatPlaysLike,
  type HoleElevation,
} from "@/lib/course/hole-elevation";
import {
  getCourseCoordinates,
  computeFCBDistances,
  type FCBDistances,
} from "@/lib/course/course-coordinates";
import type { CourseCoordinates } from "@/lib/golf-api";
import { GPSWatcher, type Position } from "@/lib/gps";
import { T } from "@/components/yardage/tokens";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract the raw GeoJSON features from a HoleData.features FeatureCollection. */
function holeFeatures(hole: HoleData): GeoJSON.Feature[] {
  return (hole.features?.features ?? []) as GeoJSON.Feature[];
}

/**
 * Pick the best yardage to display for a hole.
 *
 * Priority: scorecard tee-yardage (prefer "Black", then any) → holeLengthYards
 * from geometry → 0.
 */
function bestYardage(hole: HoleData): number {
  const yd = hole.yardages ?? {};
  if (yd["Black"]) return yd["Black"];
  const first = Object.values(yd)[0];
  if (first) return first;
  return holeLengthYards(holeFeatures(hole));
}

// ── GPS distances from projected hole + player position ───────────────────────

interface GpsDistances {
  toPin: number;
  /** F/C/B distances from player; present when GolfAPI coords are available. */
  fcb?: FCBDistances;
  /** F/C/B distances from the tee (static); present when GolfAPI coords available. */
  fcbFromTee?: FCBDistances;
}

function computeGpsDistances(
  pos: Position,
  features: GeoJSON.Feature[],
  holeCoords?: CourseCoordinates | null
): GpsDistances | null {
  // Use a 600px viewport — just needs to be something consistent; distances
  // are computed in lat/lng space so the viewport size doesn't matter.
  const projected: ProjectedHole | null = projectHole(
    features,
    { width: 600, height: 800, padding: 50 },
    holeCoords
      ? { teeLngLat: holeCoords.tee, greenLngLat: holeCoords.green }
      : undefined
  );
  if (!projected) return null;
  if (!isOnHoleBbox(pos, projected.params)) return null;

  // Prefer GolfAPI green for "to pin" distance; fall back to OSM centroid.
  const pinLatLng = holeCoords?.green ?? projected.greenLatLng;
  if (!pinLatLng) return null;

  const toPin = yardsDistance(pos, pinLatLng);

  // F/C/B from player (only when GolfAPI coords present)
  const fcb = holeCoords
    ? computeFCBDistances(pos, holeCoords)
    : undefined;

  // F/C/B from tee (static — useful in the info strip even without GPS fix)
  const fcbFromTee = holeCoords?.tee
    ? computeFCBDistances(holeCoords.tee, holeCoords)
    : undefined;

  return { toPin, fcb, fcbFromTee };
}

// ── Loading / error screens ───────────────────────────────────────────────────

function Spinner() {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: T.paper,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
      }}
    >
      <Loader2
        style={{ color: T.inkSoft, width: 36, height: 36 }}
        className="animate-spin"
      />
      <p style={{ color: T.pencil, fontFamily: T.sans, fontSize: 13 }}>
        Loading course…
      </p>
    </div>
  );
}

function ErrorScreen({
  message,
  onBack,
}: {
  message: string;
  onBack: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: T.paper,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: "0 24px",
      }}
    >
      <AlertCircle style={{ color: T.errorInk, width: 36, height: 36 }} />
      <p
        style={{
          color: T.ink,
          fontFamily: T.sans,
          fontSize: 14,
          textAlign: "center",
        }}
      >
        {message}
      </p>
      <button
        onClick={onBack}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          color: T.pencil,
          fontFamily: T.sans,
          fontSize: 13,
          background: "none",
          border: "none",
          cursor: "pointer",
        }}
      >
        <ChevronLeft size={15} />
        Go back
      </button>
    </div>
  );
}

// ── Hole info strip ───────────────────────────────────────────────────────────

function HoleInfoStrip({
  hole,
  features,
  yards,
  gpsDistances,
  gpsAvailable,
  gpsOnHole,
  elevation,
  holeCoords,
}: {
  hole: HoleData;
  features: GeoJSON.Feature[];
  yards: number;
  gpsDistances: GpsDistances | null;
  gpsAvailable: boolean;
  gpsOnHole: boolean;
  /** Per-hole elevation data from the green feature's properties (null = none). */
  elevation: HoleElevation | null;
  /** GolfAPI-verified coordinates for this hole — enables F/C/B readout. */
  holeCoords?: CourseCoordinates | null;
}) {
  // We compute hazard description with projected info when available.
  // Using null projected here (no extra projection pass) keeps it simple.
  const hazardText = describeHazards(features, null);

  // F/C/B to show: from player when GPS on-hole, from tee otherwise.
  const fcb = gpsOnHole
    ? (gpsDistances?.fcb ?? null)
    : (gpsDistances?.fcbFromTee ?? null);

  return (
    <div
      style={{
        padding: "18px 24px 20px",
        borderTop: `1px solid ${T.hairline}`,
        background: T.paper,
      }}
    >
      {/* Hole number + par */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 10,
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: 1.5,
            color: T.pencil,
            textTransform: "uppercase" as const,
          }}
        >
          Hole
        </span>
        <span
          style={{
            fontFamily: T.serif,
            fontSize: 26,
            lineHeight: 1,
            color: T.ink,
          }}
        >
          {hole.number}
        </span>
        <span
          style={{
            fontFamily: T.mono,
            fontSize: 11,
            color: T.pencilSoft,
            marginLeft: 4,
          }}
        >
          Par {hole.par ?? "—"} · HCP {hole.handicap ?? "—"}
        </span>
      </div>

      {/* Yardage — the headline number */}
      {yards > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 5,
            marginBottom: 6,
          }}
        >
          <span
            style={{
              fontFamily: T.serif,
              fontSize: 40,
              lineHeight: 1,
              color: T.ink,
            }}
          >
            {yards}
          </span>
          <span
            style={{
              fontFamily: T.mono,
              fontSize: 11,
              color: T.pencil,
              letterSpacing: 0.8,
            }}
          >
            yds
          </span>
        </div>
      )}

      {/* Plays-like elevation readout — calm mono line, shown only when data exists */}
      {elevation && (
        <p
          style={{
            fontFamily: T.mono,
            fontSize: 11,
            color: T.pencilSoft,
            margin: "0 0 6px",
            letterSpacing: 0.6,
          }}
        >
          {formatPlaysLike(elevation.playsLikeYards)}
        </p>
      )}

      {/* GPS distance strip — on-hole only */}
      {gpsOnHole && gpsDistances && (
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 6,
            marginBottom: 4,
            paddingTop: 2,
          }}
        >
          <span
            style={{
              fontFamily: T.mono,
              fontSize: 9,
              letterSpacing: 1.2,
              color: T.pencil,
              textTransform: "uppercase" as const,
            }}
          >
            You to pin
          </span>
          <span
            style={{
              fontFamily: T.serif,
              fontSize: 22,
              lineHeight: 1,
              color: T.accent,
            }}
          >
            {gpsDistances.toPin}
          </span>
          <span
            style={{
              fontFamily: T.mono,
              fontSize: 10,
              color: T.pencil,
              letterSpacing: 0.6,
            }}
          >
            yds
          </span>
        </div>
      )}

      {/* F / C / B green distances — yardage-book style, printed planner feel.
          Shown from player when GPS on-hole; from tee when GPS off-hole (static). */}
      {fcb && holeCoords && (
        <p
          style={{
            fontFamily: T.mono,
            fontSize: 11,
            color: T.pencilSoft,
            margin: "0 0 4px",
            letterSpacing: 0.5,
          }}
        >
          <span style={{ color: T.pencil }}>F</span>{" "}
          <span style={{ color: T.ink }}>{fcb.front}</span>
          {"  ·  "}
          <span style={{ color: T.pencil }}>C</span>{" "}
          <span style={{ color: T.ink }}>{fcb.center}</span>
          {"  ·  "}
          <span style={{ color: T.pencil }}>B</span>{" "}
          <span style={{ color: T.ink }}>{fcb.back}</span>
          {" "}
          <span style={{ fontSize: 9, letterSpacing: 0.8 }}>
            {gpsOnHole ? "yds to green" : "yds from tee"}
          </span>
        </p>
      )}

      {/* Calm GPS hint when GPS is available but off-hole */}
      {gpsAvailable && !gpsOnHole && (
        <p
          style={{
            fontFamily: T.mono,
            fontSize: 10,
            color: T.pencilSoft,
            margin: "0 0 4px",
            letterSpacing: 0.6,
          }}
        >
          Not on this hole — tap to measure
        </p>
      )}

      {/* Hazard summary */}
      {hazardText && (
        <p
          style={{
            fontFamily: T.sans,
            fontSize: 12,
            color: T.pencilSoft,
            margin: 0,
          }}
        >
          {hazardText}
        </p>
      )}
    </div>
  );
}

// ── Navigation bar ────────────────────────────────────────────────────────────

function HoleNav({
  holeNumber,
  totalHoles,
  onPrev,
  onNext,
}: {
  holeNumber: number;
  totalHoles: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const isFirst = holeNumber <= 1;
  const isLast = holeNumber >= totalHoles;

  const btnStyle = (disabled: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "10px 16px",
    background: "none",
    border: "none",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.3 : 1,
    fontFamily: T.sans,
    fontSize: 13,
    color: T.ink,
    borderRadius: 8,
  });

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "8px 8px 12px",
        background: T.paper,
        borderTop: `1px solid ${T.hairline}`,
      }}
    >
      <button
        onClick={onPrev}
        disabled={isFirst}
        style={btnStyle(isFirst)}
        aria-label="Previous hole"
      >
        <ChevronLeft size={16} />
        Hole {holeNumber - 1}
      </button>

      <span
        style={{
          fontFamily: T.mono,
          fontSize: 10,
          letterSpacing: 1.2,
          color: T.pencilSoft,
          textTransform: "uppercase" as const,
        }}
      >
        {holeNumber} / {totalHoles}
      </span>

      <button
        onClick={onNext}
        disabled={isLast}
        style={btnStyle(isLast)}
        aria-label="Next hole"
      >
        Hole {holeNumber + 1}
        <ChevronRight size={16} />
      </button>
    </div>
  );
}

// ── Inner page (uses useSearchParams — must be inside Suspense) ───────────────

function MappedCourseMapInner() {
  const params = useSearchParams();
  const router = useRouter();
  const courseId = params.get("id") ?? "";

  const [course, setCourse] = useState<CourseData | null>(null);
  const [currentHoleNum, setCurrentHoleNum] = useState(1);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(courseId));

  // GolfAPI-verified per-hole coordinates (mock until token provided)
  const [allCourseCoords, setAllCourseCoords] = useState<CourseCoordinates[]>([]);

  // GPS state
  const [gpsPos, setGpsPos] = useState<Position | null>(null);
  const [gpsAvailable, setGpsAvailable] = useState(false);
  const watcherRef = useRef<GPSWatcher | null>(null);

  const error = !courseId ? "No course id provided (?id=<uuid>)" : fetchError;

  // ── GPS watcher ──────────────────────────────────────────────────────────
  useEffect(() => {
    const watcher = new GPSWatcher(
      (pos) => {
        setGpsPos(pos);
        setGpsAvailable(true);
      },
      (err) => {
        // Permission denied or unavailable — GPS display silently disabled.
        // Tap-to-measure continues to work.
        if (err.code === err.PERMISSION_DENIED) {
          setGpsAvailable(false);
        }
        // Other errors (position unavailable, timeout) — keep gpsAvailable
        // true if we already received a position; otherwise stay false.
      }
    );
    watcher.start();
    watcherRef.current = watcher;

    return () => {
      watcher.stop();
      watcherRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!courseId) return;

    let cancelled = false;
    setLoading(true);
    setFetchError(null);

    (async () => {
      try {
        // Load course geometry + GolfAPI coordinates in parallel.
        const [c, coords] = await Promise.all([
          fetchMappedCourse(courseId),
          getCourseCoordinates(courseId),
        ]);
        if (cancelled) return;
        setCourse(c);
        setAllCourseCoords(coords);
        // Start on the first hole (sorted ascending by number)
        const firstHoleNum = [...(c.holes ?? [])]
          .sort((a, b) => a.number - b.number)
          .find(() => true)?.number ?? 1;
        setCurrentHoleNum(firstHoleNum);
      } catch (e: unknown) {
        if (!cancelled) {
          setFetchError(
            e instanceof Error ? e.message : "Failed to load course"
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

  // Sorted holes list (memoised so navigation is cheap)
  const sortedHoles = useMemo<HoleData[]>(
    () => [...(course?.holes ?? [])].sort((a, b) => a.number - b.number),
    [course]
  );

  const currentHole = useMemo(
    () => sortedHoles.find((h) => h.number === currentHoleNum) ?? sortedHoles[0],
    [sortedHoles, currentHoleNum]
  );

  const handleBack = useCallback(() => router.back(), [router]);

  const handlePrev = useCallback(() => {
    const idx = sortedHoles.findIndex((h) => h.number === currentHoleNum);
    if (idx > 0) setCurrentHoleNum(sortedHoles[idx - 1].number);
  }, [sortedHoles, currentHoleNum]);

  const handleNext = useCallback(() => {
    const idx = sortedHoles.findIndex((h) => h.number === currentHoleNum);
    if (idx < sortedHoles.length - 1) setCurrentHoleNum(sortedHoles[idx + 1].number);
  }, [sortedHoles, currentHoleNum]);

  // ── Loading ─────────────────────────────────────────────────────────────
  if (loading) return <Spinner />;

  // ── Error ────────────────────────────────────────────────────────────────
  if (error || !course) {
    return (
      <ErrorScreen message={error ?? "Course not found"} onBack={handleBack} />
    );
  }

  // ── Empty course ─────────────────────────────────────────────────────────
  if (sortedHoles.length === 0) {
    return (
      <ErrorScreen
        message="This course has no mapped geometry yet. Run the ingest script to populate it."
        onBack={handleBack}
      />
    );
  }

  const hole = currentHole;
  const features = holeFeatures(hole);
  const yards = bestYardage(hole);

  // GolfAPI coordinates for the current hole (null if course has no verified data).
  const holeCoords: CourseCoordinates | null =
    allCourseCoords.find((c) => c.holeNumber === currentHoleNum) ?? null;

  // Elevation: read from the green feature's properties (persisted during ingest).
  // extractHoleElevation returns null when no elevation data exists for this hole
  // (e.g. pre-elevation ingest or USGS returned None) — the UI shows nothing.
  const holeElevation = extractHoleElevation(features);

  // GPS: compute on-hole status and distances for the info strip.
  // Pass holeCoords so the distance uses the GolfAPI pin and F/C/B is computed.
  // We run this on every render; it's cheap (pure math, no I/O).
  const gpsDist = gpsPos ? computeGpsDistances(gpsPos, features, holeCoords) : null;
  const gpsOnHole = gpsDist !== null;

  // Static F/C/B from tee — shown in the info strip even without GPS, as long
  // as GolfAPI coords are available for this hole.
  const fcbFromTee: FCBDistances | undefined = holeCoords?.tee
    ? computeFCBDistances(holeCoords.tee, holeCoords)
    : undefined;

  // Merge: GPS distances win when on-hole; static tee distances fill in the rest.
  const displayDist: GpsDistances | null = gpsDist ?? (fcbFromTee
    ? { toPin: 0, fcbFromTee }
    : null);

  // GPS position to pass into HoleDiagram (as plain lat/lng — the component
  // does its own on-hole check internally for the SVG dot).
  const gpsForDiagram = gpsPos
    ? { lat: gpsPos.lat, lng: gpsPos.lng }
    : null;

  // ── Main layout ──────────────────────────────────────────────────────────
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: T.paper,
        display: "flex",
        flexDirection: "column",
        overflowY: "hidden",
      }}
    >
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          // Safe-area top inset so the back button clears the iOS status bar.
          // Same pattern as courses/page.tsx line 75 and app/page.tsx.
          padding: "max(14px, env(safe-area-inset-top)) 16px 10px",
          borderBottom: `1px solid ${T.hairline}`,
          flexShrink: 0,
        }}
      >
        <button
          onClick={handleBack}
          style={{
            display: "flex",
            alignItems: "center",
            padding: "4px 8px 4px 2px",
            background: "none",
            border: "none",
            cursor: "pointer",
            color: T.inkSoft,
            flexShrink: 0,
          }}
          aria-label="Back"
        >
          <ChevronLeft size={20} />
        </button>

        <div style={{ minWidth: 0 }}>
          <p
            style={{
              fontFamily: T.mono,
              fontSize: 9,
              letterSpacing: 1.5,
              color: T.pencil,
              textTransform: "uppercase" as const,
              margin: 0,
              lineHeight: 1,
              marginBottom: 2,
            }}
          >
            Course Map
          </p>
          <h1
            style={{
              fontFamily: T.serif,
              fontSize: 18,
              color: T.ink,
              margin: 0,
              lineHeight: 1.1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap" as const,
            }}
          >
            {course.name}
          </h1>
        </div>
      </div>

      {/* ── Diagram area — flex:1 + minHeight:0 so it expands to fill the gap */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "stretch",
          justifyContent: "center",
          overflow: "hidden",
          padding: "10px 14px",
        }}
      >
        <HoleDiagramAutosize
          features={features}
          gpsPosition={gpsForDiagram}
          courseCoords={holeCoords}
        />
      </div>

      {/* ── Info strip ─────────────────────────────────────────────────── */}
      <div style={{ flexShrink: 0 }}>
        <HoleInfoStrip
          hole={hole}
          features={features}
          yards={yards}
          gpsDistances={displayDist}
          gpsAvailable={gpsAvailable}
          gpsOnHole={gpsOnHole}
          elevation={holeElevation}
          holeCoords={holeCoords}
        />
      </div>

      {/* ── Hole navigation ────────────────────────────────────────────── */}
      <div style={{ flexShrink: 0 }}>
        <HoleNav
          holeNumber={currentHoleNum}
          totalHoles={sortedHoles.length}
          onPrev={handlePrev}
          onNext={handleNext}
        />
      </div>
    </div>
  );
}

/**
 * Sizes HoleDiagram to fill whatever pixel space the parent gives it.
 *
 * Strategy: attach a ResizeObserver to the outer `div` so we get exact
 * content-box dimensions; pass them straight to HoleDiagram as `width`/`height`.
 * SSR / first paint: fall back to 320×430 until the measurement arrives
 * (one animation frame after mount on a real device).
 *
 * Tap-to-measure accuracy is unaffected because HoleDiagram uses
 * `getScreenCTM().inverse()` — CSS pixel scaling is already handled.
 */
function HoleDiagramAutosize({
  features,
  gpsPosition,
  courseCoords,
}: {
  features: GeoJSON.Feature[];
  gpsPosition: { lat: number; lng: number } | null;
  courseCoords?: CourseCoordinates | null;
}) {
  // Safe SSR / first-paint fallback — replaced after the first ResizeObserver tick.
  const [size, setSize] = useState<{ width: number; height: number }>({
    width: 320,
    height: 430,
  });
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setSize({ width: Math.floor(width), height: Math.floor(height) });
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Interior padding for the diagram — relative to the measured size so it
  // stays proportional on small and large viewports.
  const diagramPadding = Math.max(24, Math.round(Math.min(size.width, size.height) * 0.07));

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <HoleDiagram
        features={features}
        width={size.width}
        height={size.height}
        padding={diagramPadding}
        showLabels
        gpsPosition={gpsPosition}
        courseCoords={courseCoords}
      />
    </div>
  );
}

// ── Page shell ────────────────────────────────────────────────────────────────

export default function MappedCourseMapPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <MappedCourseMapInner />
    </Suspense>
  );
}
