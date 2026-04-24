// Yardage Book — design tokens ported from the prototype.
// Kept in sync with CSS vars in globals.css. Use these for inline styles
// in framer-motion components where Tailwind/CSS class-only styling is
// awkward (SVG fills, animated inline styles, etc.).

export const T = {
  paper: "#f4f1ea",
  paperDeep: "#ece7db",
  paperEdge: "#d9d2c0",
  ink: "#1a2a1a",
  inkSoft: "#3a4a38",
  pencil: "#6b6558",
  pencilSoft: "#958d7d",
  hairline: "rgba(26,42,26,0.12)",
  hairlineSoft: "rgba(26,42,26,0.06)",

  // Accent is tunable — cobalt is the prototype default.
  flag: "oklch(0.54 0.18 28)",
  accent: "#3a4a8a",

  // Fonts — keep in sync with layout.tsx next/font vars
  serif: 'var(--font-instrument-serif), "Cormorant Garamond", Georgia, serif',
  sans: 'var(--font-geist), "Söhne", -apple-system, system-ui, sans-serif',
  mono: 'var(--font-geist-mono), "JetBrains Mono", ui-monospace, monospace',

  // Scores
  eagle: "oklch(0.48 0.14 280)",
  birdie: "oklch(0.54 0.18 28)",
  par: "#1a2a1a",
  bogey: "#6b6558",
  double: "#958d7d",

  // Motion
  spring: { type: "spring" as const, stiffness: 380, damping: 32 },
  springSoft: { type: "spring" as const, stiffness: 260, damping: 30 },
  ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
};

// Paper grain — inline background-image
export const PAPER_NOISE = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.1 0 0 0 0 0.15 0 0 0 0 0.1 0 0 0 0.035 0'/></filter><rect width='180' height='180' filter='url(%23n)'/></svg>")`;

export type Caddy = { id: string; name: string; initial: string; tag: string };

export const CADDIES: Caddy[] = [
  { id: "fluff", name: "Fluff", initial: "F", tag: "Warm, veteran looper" },
  { id: "steve", name: "Steve", initial: "S", tag: "Crisp, tour-data first" },
  { id: "uncle", name: "Uncle Joe", initial: "J", tag: "Clubhouse, a little sassy" },
  { id: "caddy", name: "The Caddy", initial: "C", tag: "Quiet, knowing" },
];

export const DEFAULT_ACCENT = "#3a4a8a"; // cobalt — prototype default
