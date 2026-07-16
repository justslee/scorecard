// Manifest guard for the named "caddie-experience" suite
// (specs/caddie-experience-harness-plan.md §1). Runs in the ordinary
// `npm run test` gate (not just `npm run test:caddie-experience`) — this is
// what makes suite MEMBERSHIP falsifiable rather than assumed:
//
//   (a) every manifest `file` exists on disk (repo-root-relative).
//   (b) every dimension 1-8 has at least one mapped file.
//   (c) package.json's `test:caddie-experience` script references the
//       dedicated vitest config (so the manifest and the runnable gate
//       can't silently drift apart).
//
// RED-proof (manual drill, mirrors backend/tests/eval/README.md's mutation
// drill): rename or delete a suite file on disk -> test (a) fails, NAMING
// the exact missing path. Delete every dimension-5 entry from the manifest
// -> test (b) fails, naming dimension 5. Both were verified red during
// development of this file before the manifest was filled in correctly.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { CADDIE_EXPERIENCE_SUITE } from "./caddie-experience-suite";

// This test always runs via `npm run test` / `npm run test:caddie-experience`
// from `frontend/` (see CLAUDE.md's Commands section) — repo root is one
// directory up from `process.cwd()`.
const REPO_ROOT = path.resolve(process.cwd(), "..");

describe("caddie-experience-suite manifest", () => {
  it("is non-empty", () => {
    expect(CADDIE_EXPERIENCE_SUITE.length).toBeGreaterThan(0);
  });

  it("every manifest file exists on disk", () => {
    const missing = CADDIE_EXPERIENCE_SUITE.filter(
      (entry) => !fs.existsSync(path.resolve(REPO_ROOT, entry.file)),
    ).map((entry) => entry.file);
    expect(missing).toEqual([]);
  });

  it("every dimension 1-8 has at least one mapped file", () => {
    const covered = new Set(CADDIE_EXPERIENCE_SUITE.flatMap((entry) => entry.dimensions));
    const missing = [1, 2, 3, 4, 5, 6, 7, 8].filter((dim) => !covered.has(dim));
    expect(missing).toEqual([]);
  });

  it("no manifest entry lists an out-of-range dimension", () => {
    const outOfRange = CADDIE_EXPERIENCE_SUITE.flatMap((entry) => entry.dimensions).filter(
      (dim) => dim < 1 || dim > 8,
    );
    expect(outOfRange).toEqual([]);
  });

  it("package.json's test:caddie-experience script references the caddie-experience vitest config", () => {
    const pkgPath = path.resolve(process.cwd(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      scripts?: Record<string, string>;
    };
    const script = pkg.scripts?.["test:caddie-experience"];
    expect(script).toBeTruthy();
    expect(script).toContain("vitest.caddie-experience.config.ts");
  });
});
