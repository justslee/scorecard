// Render the two ink-pin markers used by CourseScoutMap (B2 map mode) into
// transparent PNGs, using Playwright Chromium (already a devDependency — same
// tool as ios/simtest-headless.mjs). No new deps.
//
// Committed geometry: viewBox 0 0 32 40; visual tip at (16, 38), NOT the
// viewBox bottom (2 units of baked shadow room) -> normalized tip
// (0.5, 0.95). See specs/map-marker-craft-plan.md §0 for the full derivation
// (anchor semantics, shadow-gap rationale, tier numbers).
//
// Usage:  (from frontend/)  node scripts/render-course-flag.mjs
// Output: frontend/public/assets/course-flag.png (quiet in-bounds pin, T.pencil pennant)
//         frontend/public/assets/course-flag-highlight.png (search highlight, T.flag pennant)
// Both are committed binaries — regenerate via this script if the SVG ever
// changes; see specs/map-marker-craft-plan.md.

import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = path.resolve(fileURLToPath(import.meta.url), "../../public/assets");

const VB = { w: 32, h: 40 };
const SCALE = 4;
const SIZE = { w: VB.w * SCALE, h: VB.h * SCALE };

const svgFor = (flagFill) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB.w} ${VB.h}">
  <defs>
    <filter id="gs" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="0.6"/>
    </filter>
  </defs>
  <!-- grounding shadow: T.ink @ 16%, blurred. Spans y 35.7-39.3; the blur's
       faintest edge (<2% alpha) clips ~0.3u at the viewBox floor — invisible,
       accepted, and it never extends the opaque silhouette below y ~= 39.5. -->
  <ellipse cx="16" cy="37.5" rx="6.5" ry="1.8" fill="#1a2a1a" opacity="0.16" filter="url(#gs)"/>
  <!-- pin body: head = circle c(16,16) r14 (kappa 7.73), tapering to the tip
       at EXACTLY (16,38). Fill T.ink. -->
  <path fill="#1a2a1a" d="M16 2 C8.27 2 2 8.27 2 16 C2 22.6 6.43 26.96 10.9 31.24 C13.03 33.28 15.06 35.35 16 38 C16.94 35.35 18.97 33.28 21.1 31.24 C25.57 26.96 30 22.6 30 16 C30 8.27 23.73 2 16 2 Z"/>
  <!-- paper cutout (designer: cx16 cy14.6 r8.2), T.paper -->
  <circle cx="16" cy="14.6" r="8.2" fill="#f4f1ea"/>
  <!-- mini golf flag: ink pole + tier-colored pennant (designer's coords).
       Glyph extremes (13,9.4)/(13,19.6)/(20,11.8) are all <=6.0u from the
       cutout center — fully inside r8.2. -->
  <line x1="13" y1="9.4" x2="13" y2="19.6" stroke="#1a2a1a" stroke-width="1.4" stroke-linecap="round"/>
  <path d="M13 9.4 L20 11.8 L13 14.2 Z" fill="${flagFill}"/>
</svg>
`.trim();

const ASSETS = [
  { file: "course-flag.png", flag: "#6b6558" /* T.pencil */ },
  { file: "course-flag-highlight.png", flag: "#c1332c" /* T.flag oklch(0.54 0.18 28) -> sRGB */ },
];

/** Throws unless the PNG's IHDR chunk reports exactly the expected pixel size. */
function assertPngSize(buf, expectedW, expectedH, file) {
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w !== expectedW || h !== expectedH) {
    throw new Error(`${file}: expected ${expectedW}x${expectedH} PNG, got ${w}x${h}`);
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: SIZE.w, height: SIZE.h } });

for (const { file, flag } of ASSETS) {
  const svg = svgFor(flag);
  const html = `<!doctype html><html><head><style>
  html,body{margin:0;padding:0;background:transparent;}
  svg{display:block;width:${SIZE.w}px;height:${SIZE.h}px;}
</style></head><body>${svg}</body></html>`;
  await page.setContent(html);
  const el = await page.$("svg");
  const buf = await el.screenshot({ omitBackground: true });
  assertPngSize(buf, SIZE.w, SIZE.h, file);
  const out = path.join(OUT_DIR, file);
  await writeFile(out, buf);
  console.log(`Wrote ${out} (${buf.length} bytes, ${SIZE.w}x${SIZE.h})`);
}

await browser.close();
