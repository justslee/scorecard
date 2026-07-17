"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useReducedMotion } from "framer-motion";
import { T } from "./tokens";
import { shotPointForPath, type PathPoint } from "@/lib/hole-shot-point";
import { bookTargetDistances, clampToDiagram } from "@/lib/yardage-book-target";
import { haptic } from "@/lib/haptics";

// Abstract top-down hole diagram — ported from the prototype.

export type HoleSpec = {
  par: number;
  yards: number;
  hcp: number;
  path: Array<[number, number]>;
  dogleg: number;
  hazards: Array<
    | { t: "bunker"; x: number; y: number; r: number }
    | { t: "water"; x: number; y: number; w: number; h: number }
  >;
};

export const HOLES: HoleSpec[] = [
  { par: 4, yards: 412, hcp: 7, path: [[0.5, 0.92], [0.48, 0.55], [0.5, 0.18]], dogleg: 0, hazards: [{ t: "bunker", x: 0.38, y: 0.35, r: 0.06 }, { t: "bunker", x: 0.6, y: 0.3, r: 0.05 }] },
  { par: 4, yards: 385, hcp: 3, path: [[0.5, 0.92], [0.62, 0.58], [0.32, 0.18]], dogleg: -1, hazards: [{ t: "water", x: 0.2, y: 0.55, w: 0.22, h: 0.2 }] },
  { par: 3, yards: 178, hcp: 13, path: [[0.5, 0.88], [0.5, 0.2]], dogleg: 0, hazards: [{ t: "water", x: 0.26, y: 0.4, w: 0.48, h: 0.22 }] },
  { par: 5, yards: 548, hcp: 1, path: [[0.5, 0.94], [0.38, 0.65], [0.56, 0.38], [0.5, 0.14]], dogleg: 1, hazards: [{ t: "bunker", x: 0.5, y: 0.22, r: 0.05 }] },
  { par: 4, yards: 398, hcp: 9, path: [[0.5, 0.92], [0.5, 0.18]], dogleg: 0, hazards: [{ t: "bunker", x: 0.42, y: 0.24, r: 0.05 }] },
  { par: 4, yards: 365, hcp: 11, path: [[0.5, 0.92], [0.58, 0.5], [0.42, 0.2]], dogleg: -1, hazards: [] },
  { par: 3, yards: 195, hcp: 15, path: [[0.5, 0.88], [0.5, 0.22]], dogleg: 0, hazards: [{ t: "bunker", x: 0.38, y: 0.3, r: 0.04 }] },
  { par: 4, yards: 428, hcp: 5, path: [[0.5, 0.92], [0.42, 0.55], [0.58, 0.2]], dogleg: 1, hazards: [{ t: "water", x: 0.1, y: 0.5, w: 0.15, h: 0.2 }] },
  { par: 5, yards: 542, hcp: 17, path: [[0.5, 0.94], [0.55, 0.62], [0.45, 0.35], [0.52, 0.14]], dogleg: 1, hazards: [{ t: "bunker", x: 0.5, y: 0.24, r: 0.05 }] },
  { par: 4, yards: 402, hcp: 8, path: [[0.5, 0.92], [0.5, 0.18]], dogleg: 0, hazards: [] },
  { par: 3, yards: 165, hcp: 14, path: [[0.5, 0.88], [0.5, 0.22]], dogleg: 0, hazards: [{ t: "bunker", x: 0.56, y: 0.28, r: 0.04 }] },
  { par: 4, yards: 422, hcp: 6, path: [[0.5, 0.92], [0.4, 0.55], [0.6, 0.2]], dogleg: 1, hazards: [] },
  { par: 5, yards: 512, hcp: 16, path: [[0.5, 0.94], [0.48, 0.6], [0.55, 0.32], [0.5, 0.14]], dogleg: 0, hazards: [{ t: "water", x: 0.2, y: 0.4, w: 0.18, h: 0.25 }] },
  { par: 4, yards: 378, hcp: 12, path: [[0.5, 0.92], [0.5, 0.18]], dogleg: 0, hazards: [] },
  { par: 4, yards: 405, hcp: 4, path: [[0.5, 0.92], [0.6, 0.5], [0.4, 0.2]], dogleg: -1, hazards: [{ t: "bunker", x: 0.35, y: 0.28, r: 0.05 }] },
  { par: 3, yards: 185, hcp: 18, path: [[0.5, 0.88], [0.5, 0.22]], dogleg: 0, hazards: [{ t: "water", x: 0.22, y: 0.5, w: 0.3, h: 0.15 }] },
  { par: 4, yards: 440, hcp: 2, path: [[0.5, 0.92], [0.42, 0.55], [0.58, 0.2]], dogleg: 1, hazards: [] },
  { par: 5, yards: 535, hcp: 10, path: [[0.5, 0.94], [0.55, 0.6], [0.45, 0.3], [0.5, 0.12]], dogleg: 0, hazards: [{ t: "water", x: 0.15, y: 0.5, w: 0.2, h: 0.3 }, { t: "bunker", x: 0.48, y: 0.18, r: 0.04 }] },
];

function smoothPath(pts: Array<[number, number]>) {
  if (pts.length < 2) return "";
  if (pts.length === 2) return `M ${pts[0][0]} ${pts[0][1]} L ${pts[1][0]} ${pts[1][1]}`;
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q ${pts[i][0]} ${pts[i][1]} ${mx} ${my}`;
  }
  const last = pts[pts.length - 1];
  d += ` T ${last[0]} ${last[1]}`;
  return d;
}

function fairwayRibbon(pts: Array<[number, number]>, widthStart = 0.18, widthEnd = 0.11) {
  if (pts.length < 2) return "";
  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const dx = next[0] - prev[0];
    const dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    const px = -dy / len;
    const py = dx / len;
    const t = i / (pts.length - 1);
    const w = widthStart * (1 - t) + widthEnd * t;
    left.push([pts[i][0] + px * w, pts[i][1] + py * w]);
    right.push([pts[i][0] - px * w, pts[i][1] - py * w]);
  }
  return (
    `M ${left[0][0]} ${left[0][1]} ` +
    left.slice(1).map((p) => `L ${p[0]} ${p[1]}`).join(" ") +
    ` L ${right[right.length - 1][0]} ${right[right.length - 1][1]} ` +
    right.slice(0, -1).reverse().map((p) => `L ${p[0]} ${p[1]}`).join(" ") +
    " Z"
  );
}

export default function HoleIllustration({
  holeNumber = 1,
  size = 320,
  shotPoint = null,
  showDetail = true,
  accent = "oklch(0.54 0.18 28)",
}: {
  holeNumber?: number;
  size?: number;
  shotPoint?: [number, number] | null;
  showDetail?: boolean;
  accent?: string;
}) {
  const hole = HOLES[(holeNumber - 1) % HOLES.length];
  const VB = 100;
  const scale = (v: number) => v * VB;
  const pathD = smoothPath(hole.path.map(([x, y]) => [scale(x), scale(y)] as [number, number]));
  const ribbonD = fairwayRibbon(hole.path.map(([x, y]) => [scale(x), scale(y)] as [number, number]));
  const tee = hole.path[0];
  const green = hole.path[hole.path.length - 1];

  // ── Draggable aim target (owner ask 2026-07-17) ──────────────────────────
  // Aim state lives INSIDE this component — no lift to HoleCard, `shotPoint`
  // prop contract stays untouched. `aim` is the user's drag override; when
  // null the reticle is seeded from `shotPoint` (or the path midpoint) so
  // there is ALWAYS something to grab. See specs/draggable-target-plan.md §2.4.
  const svgRef = useRef<SVGSVGElement>(null);
  const [aim, setAim] = useState<PathPoint | null>(null);
  const [dragging, setDragging] = useState(false);
  const pointerIdRef = useRef<number | null>(null);
  const movedRef = useRef(false);
  const startClientRef = useRef<{ x: number; y: number } | null>(null);
  const reduceMotion = useReducedMotion();

  // Reset on hole change — adjust state during render (React's documented
  // pattern for "derived from a changed prop"), not in an effect, so there's
  // no extra render pass / flash of the old hole's aim point. Don't rely on
  // the consumer remounting via a keyed AnimatePresence — reset locally too,
  // per the plan's edge-case guard.
  const [lastHoleNumber, setLastHoleNumber] = useState(holeNumber);
  if (holeNumber !== lastHoleNumber) {
    setLastHoleNumber(holeNumber);
    setAim(null);
    setDragging(false);
  }
  // Refs aren't rendering state — React's rules disallow touching them
  // during render, so the in-flight-pointer-id reset happens in an effect
  // instead (still fires on the same hole-change, just a tick later; the
  // state reset above already zeroed `dragging`/`aim` synchronously).
  useEffect(() => {
    pointerIdRef.current = null;
  }, [holeNumber]);

  const seed = shotPoint ?? shotPointForPath(hole.path) ?? tee;
  const aimPoint = aim ?? seed;

  // Screen→viewBox conversion via getScreenCTM().inverse() (canonical path,
  // plan §2.5) — keeps the reticle exactly under the finger regardless of the
  // card's rendered size (190 collapsed / 340 expanded). Falls back to a
  // bounding-rect ratio if the CTM isn't available yet; equivalent here
  // because the viewBox is a uniform square (width === height).
  function toSvgPoint(e: { clientX: number; clientY: number }): PathPoint {
    const svg = svgRef.current;
    if (svg) {
      const ctm = svg.getScreenCTM();
      if (ctm) {
        const pt = svg.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        const loc = pt.matrixTransform(ctm.inverse());
        return [loc.x / VB, loc.y / VB];
      }
      const rect = svg.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height];
      }
    }
    return aimPoint;
  }

  function handlePointerDown(e: ReactPointerEvent<SVGCircleElement>) {
    e.stopPropagation();
    if (pointerIdRef.current !== null) return; // ignore a second finger mid-drag
    pointerIdRef.current = e.pointerId;
    movedRef.current = false;
    startClientRef.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    haptic("light"); // once per drag-start, matches the map's feel
  }

  function handlePointerMove(e: ReactPointerEvent<SVGCircleElement>) {
    if (pointerIdRef.current !== e.pointerId) return;
    const start = startClientRef.current;
    if (start && !movedRef.current) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) movedRef.current = true;
    }
    setAim(clampToDiagram(toSvgPoint(e)));
  }

  function endDrag(e: ReactPointerEvent<SVGCircleElement>) {
    if (pointerIdRef.current !== e.pointerId) return;
    pointerIdRef.current = null;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // already released (e.g. pointercancel) — fine to ignore
    }
  }

  const { toTarget, toGreen } = bookTargetDistances(aimPoint, hole.path, hole.yards);
  const reticleColor = dragging ? accent : T.ink;
  const colorTransition = reduceMotion ? "none" : "stroke 0.2s ease, fill 0.2s ease";

  return (
    <svg ref={svgRef} viewBox={`0 0 ${VB} ${VB}`} width={size} height={size} style={{ display: "block" }}>
      <defs>
        <pattern id={`rough-${holeNumber}`} width="2" height="2" patternUnits="userSpaceOnUse">
          <rect width="2" height="2" fill="#cfc9b7" />
          <circle cx="0.5" cy="0.5" r="0.15" fill="#a8a18a" opacity="0.5" />
          <circle cx="1.5" cy="1.3" r="0.12" fill="#a8a18a" opacity="0.5" />
        </pattern>
        <radialGradient id={`green-grad-${holeNumber}`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#a8c98a" />
          <stop offset="100%" stopColor="#6b8a52" />
        </radialGradient>
      </defs>

      <rect x="0" y="0" width={VB} height={VB} fill="#ece7db" />
      <rect x="0" y="0" width={VB} height={VB} fill={`url(#rough-${holeNumber})`} opacity="0.3" />

      <path d={ribbonD} fill="#c8d6a8" stroke="#9bb07a" strokeWidth="0.3" />
      <path d={pathD} fill="none" stroke="#1a2a1a" strokeWidth="0.35" strokeDasharray="1.5 1.8" opacity="0.3" />

      {hole.hazards.map((h, i) => {
        if (h.t === "bunker") {
          return <circle key={i} cx={scale(h.x)} cy={scale(h.y)} r={scale(h.r)} fill="#e8d9a8" stroke="#b8a878" strokeWidth="0.25" />;
        }
        return <rect key={i} x={scale(h.x)} y={scale(h.y)} width={scale(h.w)} height={scale(h.h)} rx="1.5" fill="#6ba3c4" opacity="0.7" stroke="#4a7a9a" strokeWidth="0.25" />;
      })}

      <circle cx={scale(green[0])} cy={scale(green[1])} r="5" fill={`url(#green-grad-${holeNumber})`} stroke="#4a6a32" strokeWidth="0.3" />

      <g transform={`translate(${scale(green[0])}, ${scale(green[1])})`}>
        <line x1="0" y1="0" x2="0" y2="-6" stroke="#1a2a1a" strokeWidth="0.4" strokeLinecap="round" />
        <path d="M 0 -6 L 3.5 -5.2 L 0 -4.4 Z" fill={accent} />
      </g>

      <g transform={`translate(${scale(tee[0])}, ${scale(tee[1])})`}>
        <circle r="1.4" fill="#1a2a1a" />
        <circle r="0.6" fill="#f4f1ea" />
      </g>

      {/* Draggable aim reticle — supersedes the old passive shotPoint pulse
          (never both: two markers would be noise). One dashed thread while
          dragging, echoing the map's "what's left" leg, but restrained —
          no permanent tee→target leg on this smaller, calmer surface. */}
      <line
        x1={scale(aimPoint[0])}
        y1={scale(aimPoint[1])}
        x2={scale(green[0])}
        y2={scale(green[1])}
        stroke={T.pencil}
        strokeWidth="0.3"
        strokeDasharray="1 1.5"
        style={{
          opacity: dragging ? 0.35 : 0,
          transition: reduceMotion ? "none" : "opacity 0.3s ease",
        }}
      />

      {/* Translate via the XML attribute (position tracks the pointer
          glued, every render, no CSS transition — no lag). Scale-on-grab
          lives on a NESTED <g> as a separate CSS transform, so the grab
          bounce can spring/ease independently of position. (A CSS
          `transform` style completely overrides the XML `transform`
          attribute on the same element per SVG2/CSS Transforms — mixing
          both on ONE <g> would silently drop the translate, so they're
          split across parent/child instead.) */}
      <g transform={`translate(${scale(aimPoint[0])}, ${scale(aimPoint[1])})`}>
        <g
          style={{
            transform: `scale(${dragging ? 1.15 : 1})`,
            transformOrigin: "0px 0px",
            transition: reduceMotion ? "none" : "transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)",
          }}
        >
          <circle r="3.2" fill="none" stroke={reticleColor} strokeWidth="0.5" strokeLinecap="round" style={{ transition: colorTransition }} />
          <line x1="0" y1="-3.6" x2="0" y2="-4.6" stroke={reticleColor} strokeWidth="0.5" strokeLinecap="round" style={{ transition: colorTransition }} />
          <line x1="0" y1="3.6" x2="0" y2="4.6" stroke={reticleColor} strokeWidth="0.5" strokeLinecap="round" style={{ transition: colorTransition }} />
          <line x1="3.6" y1="0" x2="4.6" y2="0" stroke={reticleColor} strokeWidth="0.5" strokeLinecap="round" style={{ transition: colorTransition }} />
          <line x1="-3.6" y1="0" x2="-4.6" y2="0" stroke={reticleColor} strokeWidth="0.5" strokeLinecap="round" style={{ transition: colorTransition }} />
          <circle r="0.9" fill={reticleColor} stroke={T.paper} strokeWidth="0.3" style={{ transition: colorTransition }} />
        </g>
      </g>

      {/* Invisible hit target, ≥44pt physical touch target at both card
          sizes (r=12 viewBox units ⇒ ~45.6px diameter at the 190px
          collapsed card). Sits last so it's on top for hit-testing; the
          visible glyph above is purely decorative. */}
      <circle
        cx={scale(aimPoint[0])}
        cy={scale(aimPoint[1])}
        r="12"
        fill="transparent"
        style={{ touchAction: "none", cursor: "grab" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={(e) => e.stopPropagation()}
        aria-label="Drag aim target"
      />

      {/* Live/settled readout — appears once the golfer has placed a custom
          aim point (drag or settled); the drawn reticle alone is the quiet
          baseline the rest of the time. In-SVG (state is internal to this
          component), matching the DOM ink-pill idiom used for HoleCard's
          {distance}Y badge (dark ink fill, mono, paper text) rather than
          inventing a new chrome style. */}
      {aim && (
        // pointerEvents: none on the pill body — if the reticle is dragged
        // under this top-left corner, the pill must not shadow the hit
        // circle underneath it (re-enabled explicitly on the × control).
        <g style={{ pointerEvents: "none" }}>
          <rect x="4" y="4" width="46" height="24" rx="3.5" fill={T.ink} />
          <text x="7" y="17" fontFamily={T.mono} fontSize="3.6" letterSpacing="0.3" fill={T.paperMid} style={{ textTransform: "uppercase" }}>
            From tee
          </text>
          <text x="44" y="17" fontFamily={T.mono} fontSize="5.2" fill={T.paper} textAnchor="end" style={{ fontVariantNumeric: "tabular-nums" }}>
            {toTarget}Y
          </text>
          <text x="7" y="25" fontFamily={T.mono} fontSize="3.6" letterSpacing="0.3" fill={T.paperMid} style={{ textTransform: "uppercase" }}>
            To green
          </text>
          <text x="44" y="25" fontFamily={T.mono} fontSize="5.2" fill={accent} textAnchor="end" style={{ fontVariantNumeric: "tabular-nums" }}>
            {toGreen}Y
          </text>
          <circle
            cx="45"
            cy="8.5"
            r="4"
            fill="transparent"
            style={{ cursor: "pointer", pointerEvents: "auto" }}
            onClick={(e) => {
              e.stopPropagation();
              setAim(null);
            }}
            aria-label="Clear aim target"
          />
          <text x="45" y="10.3" fontFamily={T.mono} fontSize="5" fill={T.paperMid} textAnchor="middle" style={{ pointerEvents: "none" }}>
            ×
          </text>
        </g>
      )}

      {showDetail && (
        <>
          <text x={scale(tee[0]) + 3} y={scale(tee[1]) + 1} fontFamily='"Geist Mono", monospace' fontSize="2.4" fill="#6b6558">TEE</text>
          <text x={scale(green[0]) + 6} y={scale(green[1]) + 1} fontFamily='"Geist Mono", monospace' fontSize="2.4" fill="#6b6558">GRN</text>
        </>
      )}
    </svg>
  );
}
