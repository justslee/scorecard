"use client";

/**
 * HoleDiagram — top-down yardage-book hole diagram rendered as inline SVG.
 *
 * Uses real GeoJSON polygon geometry from the homegrown mapped-course store
 * (no Mapbox, no live GPS, no satellite imagery).  The hole is oriented so
 * tee is at the bottom and green is at the top — exactly like a printed
 * yardage book.
 *
 * Layers (back → front):
 *   1. Paper background  (T.paper fill + subtle rough texture)
 *   2. Fairway polygons  (muted sage green)
 *   3. Water polygons    (calm slate blue)
 *   4. Bunker polygons   (sand / parchment)
 *   5. Green polygon     (slightly deeper green + hairline outline)
 *   6. Dashed centreline (tee → green, very faint)
 *   7. Tee box marker    (T.ink filled circle with paper inner dot)
 *   8. Flag on green     (ink pole + T.flag pennant)
 *   9. Optional: TEE / GRN labels in mono type
 *  10. GPS "you" dot     (cobalt, only when on-hole)
 *  11. Tap-to-measure marker + label (moved on each tap; × to dismiss)
 *
 * Gestures (touch):
 *   - 1-finger drag  → pan (scrolls the zoomed diagram)
 *   - 2-finger pinch → zoom in/out (anchor at pinch midpoint)
 *   - double-tap     → reset to fitted (full-hole) view
 *   - tap (<8 px)    → tap-to-measure (unchanged)
 *   - wheel          → zoom (desktop)
 *
 * Zoom is implemented via SVG viewBox (NOT CSS/`<g>` transform).
 * This keeps `getScreenCTM().inverse()` working so tap-to-measure
 * always receives correct SVG user-space coordinates regardless of zoom level.
 *
 * All colours come from the yardage-book token palette or are close
 * on-paper analogues.  NO neon, NO dashboard chrome.
 */

import { useState, useRef, useCallback, useMemo } from 'react';
import { T } from '@/components/yardage/tokens';
import {
  projectHole,
  projectLatLng,
  unprojectPoint,
  isOnHoleBbox,
  yardsDistance,
  nearestGreenCentroid,
  ringCentroid,
  type Viewport,
  type ProjectedPolygon,
  type ProjectedHole,
} from '@/lib/course/hole-projection';
import {
  applyPinch,
  applyPan,
  clampViewBox,
  pinchDist,
  pinchMidpoint,
  viewBoxAttr,
  type ViewBox,
} from '@/lib/course/zoom-pan';
import type { CourseCoordinates } from '@/lib/golf-api';

// ── On-paper palette ─────────────────────────────────────────────────────────
// These intentionally do NOT use CSS vars so the SVG is self-contained and
// renders correctly when inlined (e.g. in a PNG export or email clip).

const PAL = {
  // backgrounds
  // groundFill: a soft warm-grass tone richer than plain paper, so holes with
  // sparse OSM data still read "full" rather than blank-paper empty.
  ground:      '#ddd8c6',        // muted warm grass — richer than T.paper
  paper:       T.paper,          // '#f4f1ea'

  // terrain features (render behind fairway)
  roughFill:   'rgba(190,195,140,0.78)',   // mid-sage, distinct from fairway but greener than ground
  roughEdge:   'rgba(140,148,90,0.40)',
  woodsFill:   'rgba(90,118,78,0.72)',     // deeper forest green, muted and calm
  woodsEdge:   'rgba(60,88,50,0.50)',
  // tree glyph — slightly lighter than woods fill; small filled canopy dots
  treeGlyph:   'rgba(75,105,60,0.82)',

  // feature fills
  fairway:     'rgba(168,198,126,0.82)',   // soft sage — calm, not neon
  fairwayEdge: 'rgba(120,155,80,0.50)',    // subtle outline
  water:       'rgba(104,148,180,0.68)',   // muted slate blue
  waterEdge:   'rgba(70,112,145,0.45)',
  bunker:      'rgba(222,200,150,0.90)',   // parchment / sand
  bunkerEdge:  'rgba(175,150,95,0.55)',
  green:       'rgba(140,178,100,0.90)',   // slightly deeper than fairway
  greenEdge:   T.inkSoft,                  // '#3a4a38' hairline

  // markers
  teeMarker:   T.ink,            // '#1a2a1a'
  teePaper:    T.paper,
  routeLine:   T.ink,
  flagPole:    T.ink,
  flagFill:    T.flag,           // 'oklch(0.54 0.18 28)' — warm red/coral
  label:       T.pencil,         // '#6b6558'

  // tap-to-measure connector lines (tee→tap, tap→green)
  tapConnector: T.inkSoft,       // thin dashed lines, calm ink tone

  // tap-to-measure dot/label
  tapDot:      T.accent,         // cobalt '#3a4a8a'
  tapLabel:    T.ink,
  tapDismiss:  T.pencilSoft,

  // GPS "you" dot
  gpsDot:      T.accent,         // same cobalt — calm, distinct from tee/flag
  gpsRing:     'rgba(58,74,138,0.25)',
  gpsLabel:    T.inkSoft,
} as const;

// ── Zoom constants ────────────────────────────────────────────────────────────

/** Maximum zoom factor relative to the fitted (1×) view. */
const MAX_ZOOM = 5;

/** Wheel zoom step per scroll event. */
const WHEEL_STEP = 1.18;

/** Tap disambiguation threshold (screen pixels). Moves ≤ this = tap, not pan. */
const TAP_MAX_MOVE = 8;

/** Double-tap window in milliseconds. */
const DOUBLE_TAP_MS = 300;

// ── Geometry helpers ─────────────────────────────────────────────────────────

/** Convert a points array to an SVG path "d" string (closed polygon). */
function polyPath(pts: [number, number][]): string {
  if (pts.length === 0) return '';
  return (
    pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ') +
    ' Z'
  );
}

/** Fill colour for a feature type. */
function featureFill(type: string): string {
  if (type === 'rough')   return PAL.roughFill;
  if (type === 'woods')   return PAL.woodsFill;
  if (type === 'fairway') return PAL.fairway;
  if (type === 'water')   return PAL.water;
  if (type === 'bunker')  return PAL.bunker;
  if (type === 'green')   return PAL.green;
  // Unknown types (tee, etc.) fall back to ground tone
  return PAL.ground;
}

/** Stroke colour for a feature type (undefined = no stroke). */
function featureStroke(type: string): string | undefined {
  if (type === 'rough')   return PAL.roughEdge;
  if (type === 'woods')   return PAL.woodsEdge;
  if (type === 'fairway') return PAL.fairwayEdge;
  if (type === 'water')   return PAL.waterEdge;
  if (type === 'bunker')  return PAL.bunkerEdge;
  if (type === 'green')   return PAL.greenEdge;
  return undefined;
}

/** Stroke width for a feature type. */
function featureStrokeWidth(type: string): number {
  if (type === 'green') return 0.8;
  return 0.5;
}

// ── Tap-to-measure state ─────────────────────────────────────────────────────

interface TapMeasure {
  /** Tap point in SVG viewport coordinates. */
  svgX: number;
  svgY: number;
  /** Distance from tee to tapped point, yards. */
  fromTee: number;
  /** Distance from tapped point to pin (green centroid), yards. */
  toPin: number;
}

// ── Event → SVG coordinate mapping ──────────────────────────────────────────

/**
 * Map a pointer/touch client coordinate to SVG user-space coordinates.
 * Uses createSVGPoint + getScreenCTM so it handles any viewBox transform
 * applied to the SVG element — this is why we use viewBox-based zoom rather
 * than a CSS or `<g>` transform: the matrix stays correct here.
 */
function clientToSVG(
  svgEl: SVGSVGElement,
  clientX: number,
  clientY: number
): [number, number] {
  const pt = svgEl.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svgEl.getScreenCTM();
  if (!ctm) return [clientX, clientY]; // fallback (should never happen)
  const svgPt = pt.matrixTransform(ctm.inverse());
  return [svgPt.x, svgPt.y];
}

// ── Gesture tracking (mutable ref — avoids re-renders on every move) ─────────

interface GestureState {
  /** Touch positions at gesture start (for displacement check). */
  startTouches: Array<{ clientX: number; clientY: number }>;
  /** Touch positions from the most-recent touchmove. */
  lastTouches:  Array<{ clientX: number; clientY: number }>;
  /** True once the finger has moved > TAP_MAX_MOVE px. */
  moved: boolean;
  /** Timestamp (ms) of the previous tap, for double-tap detection. */
  lastTapTime: number;
}

// ── Empty state ──────────────────────────────────────────────────────────────

function EmptyDiagram({ width, height }: { width: number; height: number }) {
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      style={{ display: 'block' }}
      aria-label="Hole diagram — no geometry yet"
    >
      <rect width={width} height={height} fill={T.paper} />
      <text
        x={width / 2}
        y={height / 2}
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily={T.serif}
        fontSize={14}
        fill={T.pencil}
      >
        No geometry yet
      </text>
    </svg>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export interface HoleDiagramProps {
  /** Flat array of GeoJSON Feature objects from HoleData.features.features. */
  features: GeoJSON.Feature[];
  /** SVG render width in px. Defaults to 340 to fit a phone viewport column. */
  width?: number;
  /** SVG render height in px. A tall aspect ratio suits a yardage-book layout. */
  height?: number;
  /** Uniform padding around the geometry within the SVG canvas. */
  padding?: number;
  /** When true, renders TEE / GRN mono labels near the markers. */
  showLabels?: boolean;
  /**
   * Live GPS position from the device. When provided and on-hole, a calm "you"
   * dot is plotted at the player's position with a distance-to-pin label.
   * When the position is off-hole (>~720 yds from the hole bbox), the dot is
   * suppressed — no absurd yardage numbers. When null/undefined, GPS display
   * is skipped entirely (tap-to-measure still works).
   */
  gpsPosition?: { lat: number; lng: number } | null;
  /**
   * GolfAPI-verified coordinates for this hole.  When present:
   *   - The GolfAPI green-center is used as the authoritative pin (flag position
   *     and all "to pin" distances — tap-to-measure, GPS dot label).
   *   - The GolfAPI tee is used as the tee anchor.
   *   - The corridor clip is anchored on the GolfAPI tee→green segment.
   *   - Among OSM green polygons, the one nearest the GolfAPI green is preferred.
   * When absent, falls back to OSM polygon centroids (existing behaviour).
   */
  courseCoords?: CourseCoordinates | null;
}

export default function HoleDiagram({
  features,
  width = 340,
  height = 460,
  padding = 36,
  showLabels = true,
  gpsPosition,
  courseCoords,
}: HoleDiagramProps) {
  const viewport: Viewport = { width, height, padding };

  // ── Belt-and-suspenders: pick the OSM green polygon nearest GolfAPI green ──
  // When courseCoords are present, we prefer the OSM green polygon closest to
  // the GolfAPI green point.  If there's only one green polygon (the normal
  // case) this is a no-op; it only matters when an OSM mapping artefact has
  // placed a neighbouring hole's green in this hole's feature list.
  const effectiveFeatures = useMemo<GeoJSON.Feature[]>(() => {
    if (!courseCoords?.green) return features;
    const nearest = nearestGreenCentroid(features, courseCoords.green);
    if (!nearest) return features;
    // If the nearest centroid is far from the GolfAPI green (> 300 m) keep all
    // greens — something odd is in the data and we shouldn't filter aggressively.
    const cosLat = Math.cos((nearest.lat * Math.PI) / 180);
    const distM = Math.hypot(
      (nearest.lng - courseCoords.green.lng) * 111320 * cosLat,
      (nearest.lat - courseCoords.green.lat) * 111320
    );
    if (distM > 300) return features;
    // Filter: keep the green polygon whose centroid matches `nearest`; discard others.
    // For all non-green features: always keep.
    return features.filter((feat) => {
      const type = (feat.properties?.featureType as string | undefined) ?? '';
      if (type !== 'green') return true;
      const geom = feat.geometry;
      if (!geom || geom.type !== 'Polygon') return true;
      const ring = (geom as GeoJSON.Polygon).coordinates[0];
      if (!ring || ring.length < 3) return true;
      // Compute centroid of this green polygon using ringCentroid (same method as
      // nearestGreenCentroid, which correctly excludes the GeoJSON closing duplicate).
      const c = ringCentroid(ring as number[][]);
      if (!c) return true;  // degenerate ring: keep it
      const [cLng, cLat] = c;
      // Keep if this is the nearest green (centroid matches within 1e-6 deg ≈ 11 cm)
      return Math.abs(cLat - nearest.lat) < 1e-6 && Math.abs(cLng - nearest.lng) < 1e-6;
    });
  }, [features, courseCoords]);

  const projected: ProjectedHole | null = projectHole(
    effectiveFeatures,
    viewport,
    courseCoords
      ? { teeLngLat: courseCoords.tee, greenLngLat: courseCoords.green }
      : undefined
  );

  // Tap-to-measure state: null = no active tap marker
  const [tap, setTap] = useState<TapMeasure | null>(null);

  // Ref to the SVG element — needed for clientToSVG coordinate mapping
  const svgRef = useRef<SVGSVGElement | null>(null);

  // ── Zoom / pan state ──────────────────────────────────────────────────────
  // The fitted ViewBox = the initial state: shows the full diagram.
  // Memoised so it doesn't change identity on each render (only when size changes).
  const fittedVb = useMemo<ViewBox>(
    () => ({ x: 0, y: 0, w: width, h: height }),
    [width, height]
  );

  // Current viewBox (drives the SVG viewBox attribute).
  const [vb, setVb] = useState<ViewBox>(() => ({ x: 0, y: 0, w: width, h: height }));

  // Mutable gesture state (updates don't need to trigger re-renders).
  const gestureRef = useRef<GestureState>({
    startTouches: [],
    lastTouches:  [],
    moved:        false,
    lastTapTime:  0,
  });

  // ── Process a tap/click at SVG coords (sx, sy) ──────────────────────────
  const processTap = useCallback(
    (sx: number, sy: number) => {
      if (!projected) return;
      const { params, teeLatLng, greenLatLng } = projected;
      const latlng = unprojectPoint({ x: sx, y: sy }, params);
      const fromTee = teeLatLng ? yardsDistance(teeLatLng, latlng) : 0;
      const toPin = greenLatLng ? yardsDistance(latlng, greenLatLng) : 0;
      setTap({ svgX: sx, svgY: sy, fromTee, toPin });
    },
    [projected]
  );

  // ── Mouse click (desktop) — always a tap ─────────────────────────────────
  const handleSVGClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!svgRef.current || !projected) return;
      const [sx, sy] = clientToSVG(svgRef.current, e.clientX, e.clientY);
      processTap(sx, sy);
    },
    [projected, processTap]
  );

  // ── Wheel zoom (desktop) ─────────────────────────────────────────────────
  const handleWheel = useCallback(
    (e: React.WheelEvent<SVGSVGElement>) => {
      e.preventDefault();
      const svgEl = svgRef.current;
      if (!svgEl) return;
      const scale = e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
      const [svgX, svgY] = clientToSVG(svgEl, e.clientX, e.clientY);
      setVb(cur => clampViewBox(applyPinch(cur, { x: svgX, y: svgY }, scale, fittedVb, MAX_ZOOM), fittedVb));
    },
    [fittedVb]
  );

  // ── Touch start: record initial positions ────────────────────────────────
  const handleTouchStart = useCallback(
    (e: React.TouchEvent<SVGSVGElement>) => {
      e.preventDefault();
      const touches = Array.from(e.touches).map(t => ({
        clientX: t.clientX,
        clientY: t.clientY,
      }));
      gestureRef.current.startTouches = touches;
      gestureRef.current.lastTouches  = touches;
      gestureRef.current.moved        = false;
    },
    []
  );

  // ── Touch move: pan (1 finger) or pinch (2 fingers) ─────────────────────
  const handleTouchMove = useCallback(
    (e: React.TouchEvent<SVGSVGElement>) => {
      e.preventDefault();
      const svgEl = svgRef.current;
      if (!svgEl) return;

      const touches = Array.from(e.touches).map(t => ({
        clientX: t.clientX,
        clientY: t.clientY,
      }));
      const { lastTouches, startTouches } = gestureRef.current;

      if (touches.length === 1 && lastTouches.length === 1) {
        // ── 1-finger pan ──────────────────────────────────────────────────
        const moved = Math.hypot(
          touches[0].clientX - startTouches[0].clientX,
          touches[0].clientY - startTouches[0].clientY
        );
        if (moved > TAP_MAX_MOVE) gestureRef.current.moved = true;

        if (gestureRef.current.moved) {
          // Convert delta from screen pixels to SVG user-space units via getScreenCTM.
          // Computing the delta between two clientToSVG calls eliminates the need for
          // manual scale factors and stays correct at any zoom level.
          const svgPrev = clientToSVG(svgEl, lastTouches[0].clientX, lastTouches[0].clientY);
          const svgCurr = clientToSVG(svgEl, touches[0].clientX, touches[0].clientY);
          const deltaSvg = {
            dx: svgCurr[0] - svgPrev[0],
            dy: svgCurr[1] - svgPrev[1],
          };
          setVb(cur => clampViewBox(applyPan(cur, deltaSvg), fittedVb));
        }
      } else if (touches.length === 2 && lastTouches.length === 2) {
        // ── 2-finger pinch ────────────────────────────────────────────────
        gestureRef.current.moved = true;
        const prevDist = pinchDist(lastTouches[0], lastTouches[1]);
        const newDist  = pinchDist(touches[0], touches[1]);
        if (prevDist < 1) {
          // Degenerate: fingers too close together to compute scale reliably
          gestureRef.current.lastTouches = touches;
          return;
        }
        const scale = newDist / prevDist;
        const mid   = pinchMidpoint(touches[0], touches[1]);
        const [svgX, svgY] = clientToSVG(svgEl, mid.clientX, mid.clientY);
        setVb(cur =>
          clampViewBox(applyPinch(cur, { x: svgX, y: svgY }, scale, fittedVb, MAX_ZOOM), fittedVb)
        );
      }

      gestureRef.current.lastTouches = touches;
    },
    [fittedVb]
  );

  // ── Touch end: classify as tap / double-tap / gesture-end ───────────────
  const handleTouchEnd = useCallback(
    (e: React.TouchEvent<SVGSVGElement>) => {
      e.preventDefault();
      const { moved, startTouches, lastTapTime } = gestureRef.current;

      if (!moved && startTouches.length === 1) {
        // ── Tap (no significant movement) ─────────────────────────────────
        const touch  = e.changedTouches[0];
        const svgEl  = svgRef.current;
        if (!touch || !svgEl) return;

        const now = Date.now();
        if (now - lastTapTime < DOUBLE_TAP_MS) {
          // Double-tap → reset to fitted view
          setVb(fittedVb);
          gestureRef.current.lastTapTime = 0; // consume the tap; prevent triple-tap reset
        } else {
          // Single tap → tap-to-measure
          gestureRef.current.lastTapTime = now;
          const [sx, sy] = clientToSVG(svgEl, touch.clientX, touch.clientY);
          processTap(sx, sy);
        }
      }

      // Reset per-gesture tracking
      gestureRef.current.startTouches = [];
      gestureRef.current.lastTouches  = [];
      gestureRef.current.moved        = false;
    },
    [processTap, fittedVb]
  );

  // ── GPS on-hole detection ────────────────────────────────────────────────
  // Only plot GPS if the player is within ~720 yds of the hole bbox.
  let gpsSVG: [number, number] | null = null;
  let gpsToPin: number | null = null;

  if (gpsPosition && projected) {
    const { params, greenLatLng } = projected;
    if (isOnHoleBbox(gpsPosition, params)) {
      gpsSVG = projectLatLng(gpsPosition, params);
      gpsToPin = greenLatLng ? yardsDistance(gpsPosition, greenLatLng) : null;
    }
  }

  if (!projected) {
    return <EmptyDiagram width={width} height={height} />;
  }

  const { polygons, line, teePt, greenPt, trees: treePts } = projected;

  // Flag pin dimensions — scaled relative to viewport height
  const flagPoleH = Math.max(14, height * 0.038);
  const flagW     = Math.max(9,  height * 0.024);
  const flagH     = Math.max(6,  height * 0.016);
  const teeR      = Math.max(5,  Math.min(10, height * 0.016));

  // Tap marker dimensions
  const tapR      = Math.max(5, height * 0.012);
  const tapFontSz = Math.max(9, height * 0.020);
  const labelPad  = 5; // px between marker and label

  // Tree glyph radius — small canopy dots, calm and quiet
  const treeR     = Math.max(2.5, height * 0.006);

  // GPS dot dimensions
  const gpsR      = Math.max(6, height * 0.014);
  const gpsFontSz = Math.max(9, height * 0.018);

  // Hint text when no tap and no GPS on-hole
  const showHint = !tap && !gpsSVG;

  return (
    <svg
      ref={svgRef}
      viewBox={viewBoxAttr(vb)}
      width={width}
      height={height}
      style={{ display: 'block', cursor: 'crosshair', touchAction: 'none' }}
      aria-label="Top-down hole diagram — tap to measure, pinch to zoom"
      onClick={handleSVGClick}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <defs>
        {/* Subtle paper-grain texture overlay — keeps the hand-drawn, printed feel */}
        <filter id="hd-grain" x="0%" y="0%" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch" result="noise" />
          <feColorMatrix type="saturate" values="0" in="noise" result="grey" />
          <feBlend in="SourceGraphic" in2="grey" mode="multiply" result="out" />
          <feComponentTransfer in="out">
            <feFuncA type="linear" slope="0.06" />
          </feComponentTransfer>
          <feComposite in="SourceGraphic" in2="out" operator="over" />
        </filter>

        {/* Clip: keep all content within the SVG bounds */}
        <clipPath id="hd-clip">
          <rect x="0" y="0" width={width} height={height} />
        </clipPath>
      </defs>

      {/* ── Layer 0: Ground fill — a warm-grass tone so sparse-OSM holes read full */}
      {/* Even without rough/woods polygons the hole always looks inhabited, not blank. */}
      <rect x={0} y={0} width={width} height={height} fill={PAL.ground} />
      {/* Faint paper-grain overlay — keeps the printed yardage-book feel */}
      <rect x={0} y={0} width={width} height={height} fill={T.paper} opacity={0.22} />

      {/* ── Layers 1–N: Polygon features (sorted back→front: rough→woods→fairway…) */}
      <g clipPath="url(#hd-clip)">
        {polygons.map((poly: ProjectedPolygon, i: number) => {
          const stroke = featureStroke(poly.type);
          return (
            <path
              key={i}
              d={polyPath(poly.points)}
              fill={featureFill(poly.type)}
              stroke={stroke ?? 'none'}
              strokeWidth={stroke ? featureStrokeWidth(poly.type) : 0}
              strokeLinejoin="round"
            />
          );
        })}
      </g>

      {/* ── Tree glyphs (natural=tree nodes) — calm canopy dots in woods green ─ */}
      {treePts.length > 0 && (
        <g clipPath="url(#hd-clip)">
          {treePts.map(([tx, ty], i) => (
            <circle
              key={i}
              cx={tx.toFixed(1)}
              cy={ty.toFixed(1)}
              r={treeR}
              fill={PAL.treeGlyph}
              opacity={0.75}
            />
          ))}
        </g>
      )}

      {/* ── Routing centreline (dashed, very subtle) ──────────────────────── */}
      {line.length === 2 && (
        <line
          x1={line[0][0].toFixed(1)}
          y1={line[0][1].toFixed(1)}
          x2={line[1][0].toFixed(1)}
          y2={line[1][1].toFixed(1)}
          stroke={PAL.routeLine}
          strokeWidth={1.2}
          strokeDasharray="6 9"
          opacity={0.14}
        />
      )}

      {/* ── Tee box marker (ink circle + paper centre dot) ────────────────── */}
      <circle cx={teePt[0]} cy={teePt[1]} r={teeR}        fill={PAL.teeMarker} />
      <circle cx={teePt[0]} cy={teePt[1]} r={teeR * 0.38} fill={PAL.teePaper} />

      {/* ── Flag on green ─────────────────────────────────────────────────── */}
      <g transform={`translate(${greenPt[0].toFixed(1)},${greenPt[1].toFixed(1)})`}>
        {/* pole */}
        <line
          x1="0" y1="0"
          x2="0" y2={-flagPoleH}
          stroke={PAL.flagPole}
          strokeWidth={1.1}
          strokeLinecap="round"
        />
        {/* pennant (right of pole = player's right looking at page) */}
        <path
          d={`M 0 ${-flagPoleH} L ${flagW} ${-flagPoleH + flagH / 2} L 0 ${-flagPoleH + flagH} Z`}
          fill={PAL.flagFill}
        />
      </g>

      {/* ── Optional mono labels ──────────────────────────────────────────── */}
      {showLabels && (
        <>
          <text
            x={teePt[0] + teeR + 4}
            y={teePt[1] + 3}
            fontFamily={T.mono}
            fontSize={Math.max(9, height * 0.018)}
            fill={PAL.label}
            letterSpacing={1.2}
          >
            TEE
          </text>
          <text
            x={greenPt[0] + teeR + 4}
            y={greenPt[1] + 3}
            fontFamily={T.mono}
            fontSize={Math.max(9, height * 0.018)}
            fill={PAL.label}
            letterSpacing={1.2}
          >
            GRN
          </text>
        </>
      )}

      {/* ── GPS "you" dot (only when on-hole) ────────────────────────────── */}
      {gpsSVG && (
        <g>
          {/* Outer halo — calm, not aggressive */}
          <circle
            cx={gpsSVG[0].toFixed(1)}
            cy={gpsSVG[1].toFixed(1)}
            r={gpsR * 2.2}
            fill={PAL.gpsRing}
          />
          {/* Inner dot */}
          <circle
            cx={gpsSVG[0].toFixed(1)}
            cy={gpsSVG[1].toFixed(1)}
            r={gpsR}
            fill={PAL.gpsDot}
            opacity={0.92}
          />
          {/* "YOU" micro label */}
          <text
            x={(gpsSVG[0] + gpsR + 3).toFixed(1)}
            y={(gpsSVG[1] + 3).toFixed(1)}
            fontFamily={T.mono}
            fontSize={gpsFontSz}
            fill={PAL.gpsLabel}
            letterSpacing={0.8}
          >
            YOU
          </text>
          {/* Distance to pin */}
          {gpsToPin !== null && (
            <text
              x={(gpsSVG[0] + gpsR + 3).toFixed(1)}
              y={(gpsSVG[1] + 3 + gpsFontSz + 2).toFixed(1)}
              fontFamily={T.mono}
              fontSize={gpsFontSz}
              fill={PAL.gpsLabel}
              letterSpacing={0.6}
            >
              {gpsToPin} yds
            </text>
          )}
        </g>
      )}

      {/* ── Tap-to-measure (Job C): connector lines + marker ─────────────── */}
      {tap && (
        <g>
          {/* Connector: tee → tapped point (shows "from tee" path as a line) */}
          <line
            x1={teePt[0].toFixed(1)}
            y1={teePt[1].toFixed(1)}
            x2={tap.svgX.toFixed(1)}
            y2={tap.svgY.toFixed(1)}
            stroke={PAL.tapConnector}
            strokeWidth={1.0}
            strokeDasharray="5 6"
            opacity={0.45}
          />
          {/* Connector: tapped point → green/pin (shows "to pin" path as a line) */}
          <line
            x1={tap.svgX.toFixed(1)}
            y1={tap.svgY.toFixed(1)}
            x2={greenPt[0].toFixed(1)}
            y2={greenPt[1].toFixed(1)}
            stroke={PAL.tapConnector}
            strokeWidth={1.0}
            strokeDasharray="5 6"
            opacity={0.45}
          />
          {/* Crosshair dot at tapped location */}
          <circle
            cx={tap.svgX.toFixed(1)}
            cy={tap.svgY.toFixed(1)}
            r={tapR}
            fill="none"
            stroke={PAL.tapDot}
            strokeWidth={1.8}
          />
          <circle
            cx={tap.svgX.toFixed(1)}
            cy={tap.svgY.toFixed(1)}
            r={2}
            fill={PAL.tapDot}
          />
          {/* Calm distance label — yardage-book mono style */}
          {/* Position label above the tap point if it's in the lower half, below if upper */}
          {(() => {
            const above = tap.svgY > height / 2;
            const labelY = above
              ? tap.svgY - tapR - labelPad - tapFontSz * 0.3
              : tap.svgY + tapR + labelPad + tapFontSz;
            const label = `Tee ${tap.fromTee} · Pin ${tap.toPin}`;
            // Anchor: keep label within bounds
            const anchorX = Math.min(
              Math.max(tap.svgX, padding + 2),
              width - padding - 2
            );
            return (
              <>
                {/* Label background pill for legibility over busy terrain */}
                <text
                  x={anchorX.toFixed(1)}
                  y={labelY.toFixed(1)}
                  textAnchor="middle"
                  fontFamily={T.mono}
                  fontSize={tapFontSz}
                  fill={PAL.tapLabel}
                  letterSpacing={0.6}
                  paintOrder="stroke"
                  stroke={T.paper}
                  strokeWidth={3}
                  strokeLinejoin="round"
                >
                  {label}
                </text>
                <text
                  x={anchorX.toFixed(1)}
                  y={labelY.toFixed(1)}
                  textAnchor="middle"
                  fontFamily={T.mono}
                  fontSize={tapFontSz}
                  fill={PAL.tapLabel}
                  letterSpacing={0.6}
                >
                  {label}
                </text>
                {/* Dismiss ×  — rendered as a small pressable text glyph */}
                <text
                  x={(anchorX + (label.length * tapFontSz * 0.38) / 2 + 10).toFixed(1)}
                  y={labelY.toFixed(1)}
                  textAnchor="start"
                  fontFamily={T.sans}
                  fontSize={tapFontSz + 1}
                  fill={PAL.tapDismiss}
                  style={{ cursor: 'pointer' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setTap(null);
                  }}
                >
                  ×
                </text>
              </>
            );
          })()}
        </g>
      )}

      {/* ── Hint: "tap to measure · pinch to zoom" when no marker / GPS ──── */}
      {showHint && (
        <text
          x={(width / 2).toFixed(1)}
          y={(height - padding * 0.5).toFixed(1)}
          textAnchor="middle"
          fontFamily={T.mono}
          fontSize={Math.max(8, height * 0.016)}
          fill={T.pencilSoft}
          opacity={0.6}
          letterSpacing={0.8}
          pointerEvents="none"
        >
          tap · pinch to zoom
        </text>
      )}
    </svg>
  );
}
