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
 * All colours come from the yardage-book token palette or are close
 * on-paper analogues.  NO neon, NO dashboard chrome.
 */

import { useState, useRef, useCallback } from 'react';
import { T } from '@/components/yardage/tokens';
import {
  projectHole,
  projectLatLng,
  unprojectPoint,
  isOnHoleBbox,
  yardsDistance,
  type Viewport,
  type ProjectedPolygon,
  type ProjectedHole,
} from '@/lib/course/hole-projection';

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
 * Uses createSVGPoint + getScreenCTM so it handles any CSS transform or
 * scaling applied to the SVG element.
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
}

export default function HoleDiagram({
  features,
  width = 340,
  height = 460,
  padding = 36,
  showLabels = true,
  gpsPosition,
}: HoleDiagramProps) {
  const viewport: Viewport = { width, height, padding };
  const projected: ProjectedHole | null = projectHole(features, viewport);

  // Tap-to-measure state: null = no active tap marker
  const [tap, setTap] = useState<TapMeasure | null>(null);

  // Ref to the SVG element — needed for clientToSVG coordinate mapping
  const svgRef = useRef<SVGSVGElement | null>(null);

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

  const handleSVGClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!svgRef.current || !projected) return;
      const [sx, sy] = clientToSVG(svgRef.current, e.clientX, e.clientY);
      processTap(sx, sy);
    },
    [projected, processTap]
  );

  const handleSVGTouch = useCallback(
    (e: React.TouchEvent<SVGSVGElement>) => {
      // Use changedTouches[0] for touchend; prevent the ghost click.
      const touch = e.changedTouches[0];
      if (!touch || !svgRef.current || !projected) return;
      e.preventDefault();
      const [sx, sy] = clientToSVG(svgRef.current, touch.clientX, touch.clientY);
      processTap(sx, sy);
    },
    [projected, processTap]
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
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      style={{ display: 'block', cursor: 'crosshair', touchAction: 'none' }}
      aria-label="Top-down hole diagram — tap to measure"
      onClick={handleSVGClick}
      onTouchEnd={handleSVGTouch}
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

      {/* ── Hint: "tap to measure" when no marker and no GPS on-hole ─────── */}
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
          tap to measure
        </text>
      )}
    </svg>
  );
}
