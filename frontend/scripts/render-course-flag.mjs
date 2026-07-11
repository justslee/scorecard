// Render the quiet ink golf-flag marker used by CourseScoutMap (B2 map mode)
// into a transparent PNG, using Playwright Chromium (already a devDependency —
// same tool as ios/simtest-headless.mjs). No new deps.
//
// Usage:  (from frontend/)  node scripts/render-course-flag.mjs
// Output: frontend/public/assets/course-flag.png (committed — regenerate via
// this script if the SVG ever changes; see specs/course-selection-b2-plan.md §2.4).

import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(fileURLToPath(import.meta.url), "../../public/assets/course-flag.png");

// 26x26 viewBox, rendered at 3x (78x78) for a crisp native marker.
const SIZE = 78;
const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 26">
  <line x1="5" y1="2.5" x2="5" y2="26" stroke="#1a2a1a" stroke-width="1.8" stroke-linecap="round"/>
  <path d="M6 2.5 L20 6.5 L6 10.5 Z" fill="#6b6558" fill-opacity="0.92" stroke="#1a2a1a" stroke-width="1.2" stroke-linejoin="round"/>
</svg>
`.trim();

const html = `<!doctype html><html><head><style>
  html,body{margin:0;padding:0;background:transparent;}
  svg{display:block;width:${SIZE}px;height:${SIZE}px;}
</style></head><body>${SVG}</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
await page.setContent(html);
const el = await page.$("svg");
const buf = await el.screenshot({ omitBackground: true });
await writeFile(OUT, buf);
await browser.close();

console.log(`Wrote ${OUT} (${buf.length} bytes)`);
