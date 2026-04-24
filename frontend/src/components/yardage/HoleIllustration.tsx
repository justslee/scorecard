"use client";

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

  return (
    <svg viewBox={`0 0 ${VB} ${VB}`} width={size} height={size} style={{ display: "block" }}>
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

      {shotPoint && (
        <g transform={`translate(${scale(shotPoint[0])}, ${scale(shotPoint[1])})`}>
          <circle r="2.5" fill={accent} opacity="0.2">
            <animate attributeName="r" values="2.5;4;2.5" dur="2.4s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.2;0;0.2" dur="2.4s" repeatCount="indefinite" />
          </circle>
          <circle r="1.2" fill={accent} stroke="#f4f1ea" strokeWidth="0.3" />
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
