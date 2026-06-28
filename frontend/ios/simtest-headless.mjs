// Headless reproduction of the Capacitor native code path.
//
// Serves the production static export (frontend/out) and loads it in Chromium
// with window.webkit.messageHandlers.bridge faked, so Capacitor.isNativePlatform()
// returns true and the iOS-only code path (e.g. AuthProvider's native FAPI hooks)
// executes — surfacing the REAL, unminified JS exception that the simulator only
// shows as "Application error: a client-side exception has occurred".
//
// Usage:  (from frontend/)  npm run build  &&  node ios/simtest-headless.mjs
// Requires: playwright (already a devDependency). See ios/SIMTEST.md.

import { chromium } from "playwright";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../out");
if (!existsSync(ROOT)) {
  console.error(`No build found at ${ROOT}. Run \`npm run build\` first.`);
  process.exit(1);
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ico": "image/x-icon",
  ".txt": "text/plain",
};

const server = http.createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(req.url.split("?")[0]);
    let fp = path.join(ROOT, p);
    if (existsSync(fp) && statSync(fp).isDirectory()) fp = path.join(fp, "index.html");
    if (!existsSync(fp)) fp = existsSync(fp + ".html") ? fp + ".html" : path.join(ROOT, "index.html");
    const buf = await readFile(fp);
    res.writeHead(200, { "content-type": MIME[path.extname(fp)] || "application/octet-stream" });
    res.end(buf);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}/`;
console.log("serving", ROOT, "at", base);

const browser = await chromium.launch();
const ctx = await browser.newContext();

// Capacitor detects iOS via window.webkit.messageHandlers.bridge.
await ctx.addInitScript(() => {
  window.webkit = window.webkit || {};
  window.webkit.messageHandlers = window.webkit.messageHandlers || {};
  window.webkit.messageHandlers.bridge = { postMessage: () => {} };
});

const page = await ctx.newPage();
const lines = [];
page.on("console", (m) => lines.push(`[console.${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => lines.push(`[PAGEERROR] ${e.message}\n${e.stack || ""}`));
page.on("requestfailed", (r) => lines.push(`[requestfailed] ${r.url()} :: ${r.failure()?.errorText}`));

await page.goto(base, { waitUntil: "load" });
await page.waitForTimeout(6000);

const platform = await page.evaluate(() => ({
  platform: window.Capacitor?.getPlatform?.(),
  isNative: window.Capacitor?.isNativePlatform?.(),
}));
const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 400));

console.log("\n===== PLATFORM =====", platform);
console.log("\n===== BODY TEXT =====\n" + bodyText);
console.log("\n===== CONSOLE / ERRORS =====\n" + lines.join("\n"));

const crashed = lines.some((l) => l.startsWith("[PAGEERROR]")) ||
  /client-side exception/i.test(bodyText);
await browser.close();
server.close();
process.exit(crashed ? 1 : 0);
