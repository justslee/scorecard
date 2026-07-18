"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
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

export type AimReadout = { fromTee: number; toGreen: number };

/** Imperative escape hatch for the ONE action a parent needs to trigger on
 * internal aim state: clearing it. Keeps `aim`/`dragging` fully internal to
 * this component (minimal prop surface) while still letting HoleCard's DOM
 * pill own the × control. */
export type HoleIllustrationHandle = {
  clearAim: () => void;
};

const HoleIllustration = forwardRef<
  HoleIllustrationHandle,
  {
    holeNumber?: number;
    size?: number;
    shotPoint?: [number, number] | null;
    showDetail?: boolean;
    accent?: string;
    /** Fires whenever the custom-aim readout changes — null when no custom aim
     * is active (cleared, or hole just changed). HoleCard's top-right pill is
     * the single readout surface (specs/yardage-target-concept.md §3); this
     * component owns the drag/aim geometry but never draws its own panel. */
    onAimChange?: (r: AimReadout | null) => void;
    /** `"interactive"` (default) is byte-identical to the pre-existing
     * behavior — every existing call site (HoleCard etc.) is unaffected.
     * `"hero"` is a static, chrome-free rendering for the sign-in hero
     * (specs/login-screen-visual-plan.md §4): no `#ece7db` background rect
     * (paper + noise shows through — "no card chrome"), no aim reticle group,
     * no tee→green thread line, no invisible drag-hit circle, and the native
     * pointer-listener effect never attaches (no dead listeners). This exact
     * element set (rough texture, fairway ribbon, dashed centerline, hazards,
     * green + flag, tee dot, TEE/GRN labels) is the shared contract Slice 3
     * will animate — do not fork a second hero component. */
    variant?: "interactive" | "hero";
  }
>(function HoleIllustration(
  {
    holeNumber = 1,
    size = 320,
    shotPoint = null,
    showDetail = true,
    accent = "oklch(0.54 0.18 28)",
    onAimChange,
    variant = "interactive",
  },
  ref,
) {
  const isHero = variant === "hero";
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
  const hitRef = useRef<SVGCircleElement>(null);
  const [aim, setAim] = useState<PathPoint | null>(null);
  const [dragging, setDragging] = useState(false);
  const pointerIdRef = useRef<number | null>(null);
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

  // Ref mirror of the latest `toSvgPoint` closure (same pattern as
  // `onAimChangeRef` below) — the native listeners wired up in the effect
  // further down are attached ONCE (empty deps), so they must read fresh
  // state through refs rather than closing over a stale render's values.
  const toSvgPointRef = useRef(toSvgPoint);
  useEffect(() => {
    toSvgPointRef.current = toSvgPoint;
  });

  function handlePointerDown(e: PointerEvent) {
    e.stopPropagation();
    if (pointerIdRef.current !== null) return; // ignore a second finger mid-drag
    pointerIdRef.current = e.pointerId;
    (e.currentTarget as SVGCircleElement).setPointerCapture(e.pointerId);
    setDragging(true);
    haptic("light"); // once per drag-start, matches the map's feel
  }

  function handlePointerMove(e: PointerEvent) {
    if (pointerIdRef.current !== e.pointerId) return;
    e.stopPropagation();
    setAim(clampToDiagram(toSvgPointRef.current(e)));
  }

  function endDrag(e: PointerEvent) {
    if (pointerIdRef.current !== e.pointerId) return;
    e.stopPropagation();
    pointerIdRef.current = null;
    setDragging(false);
    try {
      (e.currentTarget as SVGCircleElement).releasePointerCapture(e.pointerId);
    } catch {
      // already released (e.g. pointercancel) — fine to ignore
    }
  }

  // Wire the drag via NATIVE addEventListener rather than React's
  // onPointerDown/Move/Up JSX props. Root cause of the card-wobble bug
  // (backlog: yardage-book-card-wobble-drag-isolation): the round page's
  // ancestor framer-motion `drag="x"` hole-swipe wrapper installs its OWN
  // native pointerdown listener directly on its DOM node. That listener
  // fires during REAL native event bubbling — which completes in full
  // before React's synthetic system (delegated from the root in React 17+)
  // ever dispatches to this component's handlers. So a React
  // SyntheticEvent.stopPropagation() call here always runs too late to stop
  // framer's PanSession from starting, and the card visibly rubber-banded a
  // few px on every reticle drag. A capture-phase React handler co-located
  // with this node's bubble handler was tried and REJECTED — in React 19 it
  // aborts the WHOLE synthetic dispatch for the node (capture + bubble share
  // one ordered list; calling stopPropagation mid-list skips the rest),
  // silently killing the drag entirely. A plain native listener attached to
  // THIS element runs at the true DOM "target" phase: stopPropagation()
  // there prevents the event from ever reaching the ancestor, and there's no
  // React synthetic dispatch in the mix to poison.
  useEffect(() => {
    if (isHero) return; // hero variant never attaches drag listeners — no dead listeners.
    const el = hitRef.current;
    if (!el) return;
    el.addEventListener("pointerdown", handlePointerDown);
    el.addEventListener("pointermove", handlePointerMove);
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
    return () => {
      el.removeEventListener("pointerdown", handlePointerDown);
      el.removeEventListener("pointermove", handlePointerMove);
      el.removeEventListener("pointerup", endDrag);
      el.removeEventListener("pointercancel", endDrag);
    };
    // Deps: `isHero` only (never toggles on a mounted instance in practice —
    // `variant` is a static prop — but listed so the guard above is honest to
    // the linter). The handlers otherwise only close over stable refs/setters
    // (or read through toSvgPointRef), so they never go stale; re-registering
    // per render would be pointless churn.
  }, [isHero]);

  const { toTarget, toGreen } = bookTargetDistances(aimPoint, hole.path, hole.yards);
  const reticleColor = dragging ? accent : T.ink;
  const colorTransition = reduceMotion ? "none" : "stroke 0.2s ease, fill 0.2s ease";

  useImperativeHandle(ref, () => ({
    clearAim: () => setAim(null),
  }));

  // Surface the readout to HoleCard's real pill (specs/yardage-target-concept.md
  // §3 — reuse the ONE existing badge, never a second in-SVG panel). Reads via
  // a ref so a fresh `onAimChange` identity every parent render doesn't retrigger
  // this effect (and loop) — it should only fire when the readout itself changes,
  // during AND after a drag (persists until cleared), null when no custom aim.
  const onAimChangeRef = useRef(onAimChange);
  useEffect(() => {
    onAimChangeRef.current = onAimChange;
  });
  useEffect(() => {
    onAimChangeRef.current?.(aim ? { fromTee: toTarget, toGreen } : null);
  }, [aim, toTarget, toGreen]);

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

      {!isHero && <rect x="0" y="0" width={VB} height={VB} fill="#ece7db" />}
      <rect x="0" y="0" width={VB} height={VB} fill={`url(#rough-${holeNumber})`} opacity={isHero ? 0.25 : 0.3} />

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

      {!isHero && (
        <>
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
            ref={hitRef}
            cx={scale(aimPoint[0])}
            cy={scale(aimPoint[1])}
            r="12"
            fill="transparent"
            style={{ touchAction: "none", cursor: "grab" }}
            // Pointer handlers are wired imperatively via native addEventListener
            // (see the effect above) rather than JSX onPointerDown/Move/Up props
            // — that's what lets stopPropagation() actually isolate the drag from
            // the round page's framer-motion `drag="x"` hole-swipe wrapper (see
            // the effect's comment for why). setPointerCapture (inside
            // handlePointerDown) still reroutes all subsequent pointermove/up to
            // this element regardless of finger movement; touch-action:none
            // blocks native browser pan gestures too. Do NOT add an
            // onPointerDownCapture alongside a co-located bubble onPointerDown on
            // this node: in React 19 that aborts the whole synthetic dispatch,
            // silently killing the drag (regression, fixed — see git history).
            onClick={(e) => e.stopPropagation()}
            aria-label="Drag aim target"
          />
        </>
      )}

      {showDetail && (
        <>
          <text x={scale(tee[0]) + 3} y={scale(tee[1]) + 1} fontFamily='"Geist Mono", monospace' fontSize="2.4" fill="#6b6558">TEE</text>
          <text x={scale(green[0]) + 6} y={scale(green[1]) + 1} fontFamily='"Geist Mono", monospace' fontSize="2.4" fill="#6b6558">GRN</text>
        </>
      )}
    </svg>
  );
});

export default HoleIllustration;
