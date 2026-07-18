// Gate-4 offline test — proves both the predicate AND the CLI exit code,
// mirroring how assert-no-auth-bypass.mjs is proven
// (specs/auth-headless-spike-plan.md §6). Also covers the login-screen-
// visual broadening (specs/login-screen-visual-plan.md §1): the new
// `src/components/auth` scan root and the `append(...)` call-shape.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  findCredentialLogViolations,
  scanForCredentialLogs,
} from "../../../scripts/assert-no-credential-log.mjs";

describe("findCredentialLogViolations — predicate", () => {
  it("flags console.log of a password variable", () => {
    const violations = findCredentialLogViolations(
      "fake.ts",
      `console.log("signing in with", password);`,
    );
    expect(violations).toHaveLength(1);
  });

  it("flags console.error of an idToken", () => {
    const violations = findCredentialLogViolations(
      "fake.ts",
      `console.error(\`token exchange failed: \${idToken}\`);`,
    );
    expect(violations).toHaveLength(1);
  });

  it("flags setAuthDiag of a rawNonce", () => {
    const violations = findCredentialLogViolations(
      "fake.ts",
      `setAuthDiag({ lastError: rawNonce });`,
    );
    expect(violations).toHaveLength(1);
  });

  it("flags an identityToken reference", () => {
    const violations = findCredentialLogViolations(
      "fake.ts",
      `console.warn("apple identity:", identityToken);`,
    );
    expect(violations).toHaveLength(1);
  });

  it("does NOT flag allowlisted diag booleans that merely contain 'token' as a substring", () => {
    const violations = findCredentialLogViolations(
      "fake.ts",
      `setAuthDiag({ tokenRestored: false, authHeaderReceived: true });`,
    );
    expect(violations).toHaveLength(0);
  });

  it("does NOT flag an unrelated console.log with no secret identifiers", () => {
    const violations = findCredentialLogViolations(
      "fake.ts",
      `console.log("sign-in", label, "ok");`,
    );
    expect(violations).toHaveLength(0);
  });

  it("does NOT flag code that never logs the secret at all (secret var exists but isn't logged)", () => {
    const violations = findCredentialLogViolations(
      "fake.ts",
      `const password = getPassword();\nconsole.log("form ready");`,
    );
    expect(violations).toHaveLength(0);
  });

  it("flags append(...) of a password variable (login-screen-visual broadening)", () => {
    const violations = findCredentialLogViolations(
      "fake.ts",
      `append(\`signing in with \${password}\`);`,
    );
    expect(violations).toHaveLength(1);
  });

  it("does NOT flag append(...) with only descriptive labels/status codes", () => {
    const violations = findCredentialLogViolations(
      "fake.ts",
      `append(\`\${label}: FAILED (\${errCode(e)})\`);`,
    );
    expect(violations).toHaveLength(0);
  });
});

describe("scanForCredentialLogs — real repo files stay clean", () => {
  it("finds zero violations across the auth-spike + components/auth surface today", () => {
    const violations = scanForCredentialLogs();
    expect(violations).toEqual([]);
  });

  it("scanning ONLY the new src/components/auth root is clean (proves the root exists + is walked)", () => {
    const violations = scanForCredentialLogs(["src/components/auth"]);
    expect(violations).toEqual([]);
  });
});

describe("assert-no-credential-log.mjs — CLI exit code", () => {
  const scriptPath = fileURLToPath(
    new URL("../../../scripts/assert-no-credential-log.mjs", import.meta.url),
  );
  const cwd = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

  it("exits 0 when the repo is clean", () => {
    expect(() => execFileSync("node", [scriptPath], { cwd, stdio: "pipe" })).not.toThrow();
  });
});
