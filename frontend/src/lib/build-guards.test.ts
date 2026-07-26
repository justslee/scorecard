import { describe, expect, it, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkAuthBypass } from "../../scripts/assert-no-auth-bypass.mjs";
import { containsAuthDiagMarker } from "../../scripts/assert-no-auth-diag.mjs";

// P0 multi-user security slice (specs/multi-user-epic-plan.md §3.4 "Fail-open
// flags"): NEXT_PUBLIC_AUTH_BYPASS=1 must never reach a real build. This test
// proves BOTH the pure predicate the script uses AND the actual CLI's exit
// code, so a future refactor of one can't silently break the other.

describe("checkAuthBypass (pure predicate)", () => {
  it("passes when NEXT_PUBLIC_AUTH_BYPASS is unset", () => {
    expect(checkAuthBypass({})).toBe(true);
  });

  it("passes when NEXT_PUBLIC_AUTH_BYPASS is any other value", () => {
    expect(checkAuthBypass({ NEXT_PUBLIC_AUTH_BYPASS: "0" })).toBe(true);
    expect(checkAuthBypass({ NEXT_PUBLIC_AUTH_BYPASS: "true" })).toBe(true);
  });

  it("fails when NEXT_PUBLIC_AUTH_BYPASS is exactly '1'", () => {
    expect(checkAuthBypass({ NEXT_PUBLIC_AUTH_BYPASS: "1" })).toBe(false);
  });
});

describe("scripts/assert-no-auth-bypass.mjs (CLI, the real build-gate)", () => {
  const scriptPath = path.resolve(__dirname, "../../scripts/assert-no-auth-bypass.mjs");

  it("exits 0 when the flag is unset (the normal CI/prod-build case)", () => {
    const cleanEnv = { ...process.env };
    delete cleanEnv.NEXT_PUBLIC_AUTH_BYPASS;
    const { status } = spawnSync("node", [scriptPath], { env: cleanEnv });
    expect(status).toBe(0);
  });

  it("exits 1 (fails the build) when NEXT_PUBLIC_AUTH_BYPASS=1", () => {
    const { status, stderr } = spawnSync("node", [scriptPath], {
      env: { ...process.env, NEXT_PUBLIC_AUTH_BYPASS: "1" },
    });
    expect(status).toBe(1);
    expect(stderr.toString()).toContain("BUILD BLOCKED");
  });
});

// P0 login-blocked fix (specs/p0-login-blocked-plan.md §1 "Proof"): the
// NativeAuthDiag debug panel occluded the sign-in controls on every native
// build because its runtime gate was "native OR opt-in". It is now excluded
// at build time and this scan proves `out/` — the exact static export
// `npx cap sync ios` copies into the shipped app — carries no trace of it.

describe("containsAuthDiagMarker (pure predicate)", () => {
  it("matches the [authdiag] console-log prefix", () => {
    expect(containsAuthDiagMarker('console.log("[authdiag] loaded=true")')).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(containsAuthDiagMarker("AUTHDIAG marker present")).toBe(true);
  });

  it("matches the panel's copy-button text", () => {
    expect(containsAuthDiagMarker("Looper Auth Diagnostic  2026-07-26T00:00:00.000Z")).toBe(true);
  });

  it("matches the panel's rendered header text", () => {
    expect(containsAuthDiagMarker('"Auth diag"')).toBe(true);
  });

  it("does NOT match clean, unrelated bundle content", () => {
    expect(containsAuthDiagMarker("function useAuth(){return isSignedIn}")).toBe(false);
  });

  // The regression this negative-lookahead guards: getAuthDiagnostics()
  // (src/lib/auth-token.ts) is an unrelated, always-shipped function whose
  // name contains "AuthDiag" as a substring of "AuthDiagnostics". Without
  // the exclusion this predicate would flag every build forever, regardless
  // of whether the panel is actually present — a scan that always fires is
  // exactly as worthless as one that never does.
  it("does NOT false-positive on the unrelated getAuthDiagnostics() function", () => {
    expect(containsAuthDiagMarker('e.s(["getAuthDiagnostics",()=>s])')).toBe(false);
    expect(
      containsAuthDiagMarker("let t=(0,r.getAuthDiagnostics)();throw Error(`Transcribe 401`)"),
    ).toBe(false);
  });

  // ── MARKER COUPLING (reviewer fold, P0 2026-07-26) ────────────────────────
  // The scan proves the panel is absent from out/ by grepping for prose the
  // panel contains ("Auth diag", "Looper Auth Diagnostic", "[authdiag]").
  // Minifiers rename identifiers but preserve string literals, so prose is a
  // sound marker — but ONLY while the panel still contains it. If someone
  // later rewords the header or the copy-button text, every marker would stop
  // matching, the scan would go permanently green, and it would prove nothing
  // while looking healthy. That silent rot is the failure mode this test
  // exists to prevent: it pins the predicate to the ACTUAL component source,
  // so a copy edit that removes the last marker fails here instead of quietly
  // disarming the release gate that keeps the panel out of TestFlight.
  it("stays coupled to the real NativeAuthDiag source (marker set cannot rot)", () => {
    const panelSource = readFileSync(
      path.resolve(__dirname, "../components/NativeAuthDiag.tsx"),
      "utf8",
    );
    expect(containsAuthDiagMarker(panelSource)).toBe(true);
  });

  // Same coupling for the state module: its setAuthDiag console mirror is the
  // other thing that must never reach a shipped bundle's device log.
  it("stays coupled to the real auth-diag state module", () => {
    const diagSource = readFileSync(path.resolve(__dirname, "./auth-diag.ts"), "utf8");
    expect(containsAuthDiagMarker(diagSource)).toBe(true);
  });
});

describe("scripts/assert-no-auth-diag.mjs (CLI, the real postbuild gate)", () => {
  const scriptPath = path.resolve(__dirname, "../../scripts/assert-no-auth-diag.mjs");
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeFixtureOutDir(fileContent: string | null): string {
    tmpDir = mkdtempSync(path.join(tmpdir(), "auth-diag-scan-"));
    const outDir = path.join(tmpDir, "out", "_next", "static", "chunks");
    mkdirSync(outDir, { recursive: true });
    if (fileContent !== null) {
      writeFileSync(path.join(outDir, "chunk.js"), fileContent, "utf-8");
    } else {
      writeFileSync(path.join(outDir, "chunk.js"), "console.log('clean bundle')", "utf-8");
    }
    return tmpDir;
  }

  it("exits 0 on a clean out/ dir with the flag unset (the normal prod build)", () => {
    const cwd = makeFixtureOutDir(null);
    const cleanEnv = { ...process.env };
    delete cleanEnv.NEXT_PUBLIC_AUTH_DIAG;
    const { status, stderr } = spawnSync("node", [scriptPath], { cwd, env: cleanEnv });
    expect(status).toBe(0);
    expect(stderr.toString()).toBe("");
  });

  it("exits 1 (fails the build) when a marker is present and the flag is unset", () => {
    const cwd = makeFixtureOutDir('console.log("[authdiag] loaded=true signed=false")');
    const cleanEnv = { ...process.env };
    delete cleanEnv.NEXT_PUBLIC_AUTH_DIAG;
    const { status, stderr } = spawnSync("node", [scriptPath], { cwd, env: cleanEnv });
    expect(status).toBe(1);
    expect(stderr.toString()).toContain("BUILD BLOCKED");
  });

  it("exits 0 with a DIAG BUILD warning when a marker is present AND the flag is set (legitimate dev/sim build)", () => {
    const cwd = makeFixtureOutDir('console.log("[authdiag] loaded=true signed=false")');
    const { status, stdout, stderr } = spawnSync("node", [scriptPath], {
      cwd,
      env: { ...process.env, NEXT_PUBLIC_AUTH_DIAG: "1" },
    });
    expect(status).toBe(0);
    expect(stdout.toString() + stderr.toString()).toContain("DIAG BUILD");
    expect(stdout.toString() + stderr.toString()).toContain("NOT SHIPPABLE");
  });
});
