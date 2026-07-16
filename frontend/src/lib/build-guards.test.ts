import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { checkAuthBypass } from "../../scripts/assert-no-auth-bypass.mjs";

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
