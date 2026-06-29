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
 *   - No live GPS distances (no "50531 yds to green" absurdity)
 *   - No mapbox-gl import
 *
 * Navigation: ◄ / ► buttons step through holes 1–18.
 * The current hole number and course name are shown in the header.
 *
 * Usage:
 *   http://localhost:3000/map/course?id=<deterministic-uuid-of-bethpage-black>
 */

import { Suspense, useEffect, useState, useCallback, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Loader2, AlertCircle } from "lucide-react";
import type { CourseData, HoleData } from "@/lib/courses/types";
import { fetchMappedCourse } from "@/lib/courses/mapped-course-api";
import HoleDiagram from "@/components/course/HoleDiagram";
import { holeLengthYards, describeHazards } from "@/lib/course/hole-projection";
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
}: {
  hole: HoleData;
  features: GeoJSON.Feature[];
  yards: number;
}) {
  // We compute hazard description with projected info when available.
  // Using null projected here (no extra projection pass) keeps it simple.
  const hazardText = describeHazards(features, null);

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

  const error = !courseId ? "No course id provided (?id=<uuid>)" : fetchError;

  useEffect(() => {
    if (!courseId) return;

    let cancelled = false;
    setLoading(true);
    setFetchError(null);

    (async () => {
      try {
        const c = await fetchMappedCourse(courseId);
        if (cancelled) return;
        setCourse(c);
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
          padding: "14px 16px 10px",
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

      {/* ── Diagram area (flex-1, scrollable if needed) ──────────────────── */}
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          padding: "12px 16px",
        }}
      >
        <HoleDiagramAutosize features={features} />
      </div>

      {/* ── Info strip ─────────────────────────────────────────────────── */}
      <div style={{ flexShrink: 0 }}>
        <HoleInfoStrip hole={hole} features={features} yards={yards} />
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
 * A thin wrapper that sizes the HoleDiagram to fill whatever space is available.
 * Uses a fixed tall aspect ratio (3:4) typical of a yardage-book hole page.
 */
function HoleDiagramAutosize({ features }: { features: GeoJSON.Feature[] }) {
  // 300×400 is a safe default that fits almost any phone in portrait mode.
  // The component's viewBox + CSS width/height handle responsive scaling.
  const W = 300;
  const H = 400;
  return (
    <div style={{ width: "100%", maxWidth: W + 40, display: "flex", justifyContent: "center" }}>
      <HoleDiagram
        features={features}
        width={W}
        height={H}
        padding={32}
        showLabels
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
