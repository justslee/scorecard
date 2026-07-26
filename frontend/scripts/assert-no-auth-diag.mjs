// CI/build guard for the P0 login-blocked fix (specs/p0-login-blocked-plan.md
// §1 "Proof"). The NativeAuthDiag panel used to render on EVERY native build
// (including TestFlight) and occluded the sign-in controls — the release
// blocker this fix addresses. The panel is now excluded at build time via a
// build-time-conditional dynamic import in SignInClient.tsx keyed on
// NEXT_PUBLIC_AUTH_DIAG. This script PROVES the exclusion by scanning the
// emitted static export (`out/`) — the exact directory `npx cap sync ios`
// copies into the shipped app — for any trace of the panel.
//
// Mirrors the assert-no-auth-bypass.mjs / assert-no-credential-log.mjs
// pattern: an importable predicate + a CLI entrypoint, proven by
// src/lib/build-guards.test.ts.
//
// Wired as npm's `postbuild` lifecycle hook (package.json), which npm runs
// automatically AFTER `next build` emits `out/` — unlike `prebuild`
// (assert-no-auth-bypass.mjs), which must run BEFORE the build. Both the CI
// build step and the real prod build (ops/ios/ship.sh runs `npm run build`)
// prove the exclusion on every build. ship.sh sets only API_URL / Clerk pk /
// Maps key — never NEXT_PUBLIC_AUTH_DIAG — so every shipped bundle is
// scan-proven clean.
//
// Usage: node scripts/assert-no-auth-diag.mjs [outDir]
// Exit 1 (fails the build) if a marker is found while NEXT_PUBLIC_AUTH_DIAG
// is not "1". If the flag IS set (a legitimate dev/sim diag build): exit 0
// with a loud "DIAG BUILD — NOT SHIPPABLE" warning instead of failing.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_OUT_DIR = "out";
const SCAN_EXTENSIONS = new Set([".js", ".html", ".txt"]);

// Markers that can only be present if the NativeAuthDiag component (or its
// on-screen copy) reached the bundle. Case-insensitive match on "authdiag"
// (the "[authdiag]" console-log prefix / module fragments) catches most of
// it; the other two are copy strings unique to the panel's rendered/copied
// text. The negative lookahead excludes `getAuthDiagnostics` — an unrelated,
// always-shipped function in src/lib/auth-token.ts (used by api.ts /
// deepgram.ts for 401 diagnostics) whose name legitimately contains
// "AuthDiag" as a substring of "AuthDiagnostics"; without it every build
// would false-positive on that function forever, regardless of the panel
// (a scan that always fires is as worthless as one that never does).
const MARKERS = [/authdiag(?!nostic)/i, /Looper Auth Diagnostic/, /Auth diag/];

/** Pure predicate: does this file content contain any auth-diag marker? */
export function containsAuthDiagMarker(content) {
  return MARKERS.some((re) => re.test(content));
}

function walk(path, out) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return; // dir doesn't exist — nothing to scan
  }
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) {
      walk(join(path, entry), out);
    }
  } else {
    const ext = path.slice(path.lastIndexOf("."));
    if (SCAN_EXTENSIONS.has(ext)) out.push(path);
  }
}

/**
 * Scan `outDir` for any file containing an auth-diag marker.
 * Returns the list of offending file paths (empty = clean).
 */
export function scanForAuthDiagMarkers(outDir = DEFAULT_OUT_DIR, cwd = process.cwd()) {
  const abs = join(cwd, outDir);
  const files = [];
  walk(abs, files);
  const offenders = [];
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    if (containsAuthDiagMarker(content)) offenders.push(file);
  }
  return offenders;
}

function main() {
  const outDir = process.argv[2] || DEFAULT_OUT_DIR;
  const flagSet = process.env.NEXT_PUBLIC_AUTH_DIAG === "1";
  const offenders = scanForAuthDiagMarkers(outDir);

  if (offenders.length === 0) {
    process.exit(0);
  }

  if (flagSet) {
    console.warn(
      "\n⚠️  DIAG BUILD — NOT SHIPPABLE ⚠️\n" +
        "NEXT_PUBLIC_AUTH_DIAG=1 is set: the NativeAuthDiag panel is present in\n" +
        `${outDir}/ (${offenders.length} file(s)). This is expected for a dev/sim\n` +
        "diagnostic build (see frontend/ios/SIMTEST.md) but this bundle must NEVER\n" +
        "be shipped to TestFlight. Unset the flag and rebuild before shipping.\n",
    );
    process.exit(0);
  }

  console.error(
    "\nBUILD BLOCKED (specs/p0-login-blocked-plan.md §1): the NativeAuthDiag\n" +
      "panel was found in the shipped bundle with NEXT_PUBLIC_AUTH_DIAG unset:\n",
  );
  for (const file of offenders) {
    console.error(`  ${file}`);
  }
  console.error(
    "\nThis panel occludes the sign-in controls on native builds (the P0 login\n" +
      "outage) and must never reach a shipped build. Check that SignInClient.tsx's\n" +
      "dynamic import of NativeAuthDiag is still build-time-conditional on\n" +
      "NEXT_PUBLIC_AUTH_DIAG (inline literal condition — see the plan's mechanism\n" +
      "note on why a named const defeats dead-branch elimination).\n",
  );
  process.exit(1);
}

// Only run as a CLI entrypoint — importable for tests without executing.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
