// CI/build guard for the auth-headless-spike (Gate 4 — credential no-log
// discipline; specs/auth-headless-spike-plan.md §6). Mirrors the
// assert-no-auth-bypass.mjs pattern: an importable predicate + a CLI
// entrypoint, proven by frontend/src/lib/auth-spike/no-credential-log.test.ts.
//
// Scans the auth-spike surface (the only files touched by this slice that
// handle raw credentials) and fails the build if any console.*(...) or
// setAuthDiag(...) call, or any template-literal / string-concatenation
// expression, references an identifier that looks like a raw secret:
// password | idToken | identityToken | rawNonce | token (word-boundary).
//
// Allowlisted identifiers (booleans/diag fields, not raw secrets):
//   tokenRestored, authHeaderReceived, tokenType, tok (diag-field names that
//   happen to contain "token" but never hold the raw value).
//
// Usage: node scripts/assert-no-credential-log.mjs
// Exit 1 if a violation is found; exit 0 otherwise.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SCAN_ROOTS = [
  "src/lib/auth-spike",
  "src/components/auth-spike",
  "src/components/AuthProvider.tsx",
  "src/components/ClerkTokenBridge.tsx",
];

// Matches a raw-secret-shaped identifier as a whole word (not a substring of
// an allowlisted diag field like tokenRestored/authHeaderReceived).
const SECRET_IDENTIFIER = /\b(password|idToken|identityToken|rawNonce|token)\b/;

// Calls whose arguments must never contain a secret-shaped reference.
const LOGGING_CALL = /\b(console\.\w+|setAuthDiag)\s*\(/g;

/**
 * Blank out plain string-literal TEXT so a descriptive label like
 * `"token-read: " + msg` or `` `token-read: ${msg}` `` doesn't false-positive
 * on the word "token" appearing inside prose — while still keeping template
 * literal `${...}` interpolation expressions (where a raw secret variable
 * could genuinely be interpolated) intact for the identifier check below.
 */
function stripStringLiteralText(source) {
  let stripped = source.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  stripped = stripped.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  stripped = stripped.replace(/`(?:[^`\\]|\\.)*`/g, (tmpl) => {
    const interpolations = [...tmpl.matchAll(/\$\{([^}]*)\}/g)]
      .map((m) => m[1])
      .join(" ");
    return "`" + interpolations + "`";
  });
  return stripped;
}

/**
 * Very small heuristic scanner (not a real parser): for every console.<fn>()
 * / setAuthDiag(...) call-site, grab a bounded window of source after the
 * opening paren and check it for a secret-shaped identifier OR a
 * template-literal / string-concatenation expression that references one.
 * False positives are acceptable (they just mean "rename the local var" in
 * this small, spike-only surface); false negatives are what we guard against.
 */
export function findCredentialLogViolations(filePath, source) {
  const violations = [];
  let match;
  LOGGING_CALL.lastIndex = 0;
  while ((match = LOGGING_CALL.exec(source)) !== null) {
    const start = match.index;
    // Find the matching closing paren for this call (naive depth counter —
    // sufficient for this codebase's formatting; a nested string containing
    // unbalanced parens would be unusual and is not present in this surface).
    let depth = 0;
    let i = start + match[0].length - 1; // at the opening '('
    let end = source.length;
    for (; i < source.length; i++) {
      if (source[i] === "(") depth++;
      if (source[i] === ")") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    const callSite = source.slice(start, end);
    if (SECRET_IDENTIFIER.test(stripStringLiteralText(callSite))) {
      const line = source.slice(0, start).split("\n").length;
      violations.push({ file: filePath, line, snippet: callSite.replace(/\s+/g, " ").slice(0, 160) });
    }
  }
  return violations;
}

function walk(path, out) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) continue;
      walk(join(path, entry), out);
    }
  } else if (/\.(ts|tsx)$/.test(path)) {
    out.push(path);
  }
}

export function scanForCredentialLogs(roots = SCAN_ROOTS, cwd = process.cwd()) {
  const files = [];
  for (const root of roots) {
    const abs = join(cwd, root);
    try {
      walk(abs, files);
    } catch {
      // Root doesn't exist (e.g. auth-spike dirs not created yet) — skip.
    }
  }
  const violations = [];
  for (const file of files) {
    const source = readFileSync(file, "utf-8");
    violations.push(...findCredentialLogViolations(file, source));
  }
  return violations;
}

function main() {
  const violations = scanForCredentialLogs();
  if (violations.length > 0) {
    console.error(
      "\nBUILD BLOCKED: possible credential logging found (Gate 4, " +
        "specs/auth-headless-spike-plan.md §6):\n",
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.snippet}`);
    }
    console.error(
      "\nNever console.*/setAuthDiag a password, code, idToken, identityToken, " +
        "or rawNonce. Rename the local var or restructure the log line.\n",
    );
    process.exit(1);
  }
  process.exit(0);
}

// Only run as a CLI entrypoint — importable for tests without executing.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
