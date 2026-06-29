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
 *
 * All colours come from the yardage-book token palette or are close
 * on-paper analogues.  NO neon, NO dashboard chrome.
 */

import { T } from '@/components/yardage/tokens';
import {
  projectHole,
  type Viewport,
  type ProjectedPolygon,
  type ProjectedHole,
} from '@/lib/course/hole-projection';

// ── On-paper palette ─────────────────────────────────────────────────────────
// These intentionally do NOT use CSS vars so the SVG is self-contained and
// renders correctly when inlined (e.g. in a PNG export or email clip).

const PAL = {
  // backgrounds
  rough:       '#d8d3c2',        // slightly darker than T.paperDeep for rough grass
  paper:       T.paper,          // '#f4f1ea'

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
  if (type === 'fairway') return PAL.fairway;
  if (type === 'water')   return PAL.water;
  if (type === 'bunker')  return PAL.bunker;
  if (type === 'green')   return PAL.green;
  return PAL.rough;
}

/** Stroke colour for a feature type (undefined = no stroke). */
function featureStroke(type: string): string | undefined {
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
}

export default function HoleDiagram({
  features,
  width = 340,
  height = 460,
  padding = 36,
  showLabels = true,
}: HoleDiagramProps) {
  const viewport: Viewport = { width, height, padding };
  const projected: ProjectedHole | null = projectHole(features, viewport);

  if (!projected) {
    return <EmptyDiagram width={width} height={height} />;
  }

  const { polygons, line, teePt, greenPt } = projected;

  // Flag pin dimensions — scaled relative to viewport height
  const flagPoleH = Math.max(14, height * 0.038);
  const flagW     = Math.max(9,  height * 0.024);
  const flagH     = Math.max(6,  height * 0.016);
  const teeR      = Math.max(5,  Math.min(10, height * 0.016));

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      style={{ display: 'block' }}
      aria-label="Top-down hole diagram"
    >
      <defs>
        {/* Rough-grass background pattern — subtle dot texture like printed paper */}
        <pattern
          id="hd-rough"
          x="0"
          y="0"
          width="4"
          height="4"
          patternUnits="userSpaceOnUse"
        >
          <rect width="4" height="4" fill={PAL.rough} />
          <circle cx="1"   cy="1"   r="0.3" fill={T.paperEdge} opacity="0.5" />
          <circle cx="2.5" cy="2.8" r="0.25" fill={T.paperEdge} opacity="0.4" />
        </pattern>

        {/* Clip: keep all content within the SVG bounds */}
        <clipPath id="hd-clip">
          <rect x="0" y="0" width={width} height={height} />
        </clipPath>
      </defs>

      {/* ── Layer 0: Paper ground ─────────────────────────────────────────── */}
      <rect x={0} y={0} width={width} height={height} fill={T.paper} />
      <rect x={0} y={0} width={width} height={height} fill="url(#hd-rough)" opacity={0.55} />

      {/* ── Layers 1–4: Polygon features (already sorted back→front) ─────── */}
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

      {/* ── Layer 5: Routing centreline (dashed, very subtle) ─────────────── */}
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

      {/* ── Layer 6: Tee box marker (ink circle + paper centre dot) ──────── */}
      <circle cx={teePt[0]} cy={teePt[1]} r={teeR}     fill={PAL.teeMarker} />
      <circle cx={teePt[0]} cy={teePt[1]} r={teeR * 0.38} fill={PAL.teePaper} />

      {/* ── Layer 7: Flag on green ────────────────────────────────────────── */}
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

      {/* ── Layer 8: Optional mono labels ────────────────────────────────── */}
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
    </svg>
  );
}
