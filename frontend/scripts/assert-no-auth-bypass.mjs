// CI/build guard for the P0 multi-user security slice
// (specs/multi-user-epic-plan.md §3.4 "Fail-open flags").
//
// NEXT_PUBLIC_AUTH_BYPASS=1 is a compile-time test-only bypass (skips the
// sign-in gate — see the comments in src/components/AuthGate.tsx and
// src/lib/api.ts) that must NEVER be baked into a shipped build. It exists
// only for a manual local test build.
//
// Wired as npm's `prebuild` lifecycle hook (package.json), so it runs
// automatically before every `npm run build` — both CI's build step
// (.github/workflows/ci.yml) and the real prod build (ops/ios/ship.sh).
//
// Usage: node scripts/assert-no-auth-bypass.mjs
// Exit 1 (fails the build) if NEXT_PUBLIC_AUTH_BYPASS === "1"; exit 0 otherwise.

export function checkAuthBypass(env) {
  return env.NEXT_PUBLIC_AUTH_BYPASS !== "1";
}

function main() {
  if (!checkAuthBypass(process.env)) {
    console.error(
      "\nBUILD BLOCKED: NEXT_PUBLIC_AUTH_BYPASS=1 is set.\n" +
        "This flag skips the sign-in gate at compile time (AuthGate.tsx) and must\n" +
        "NEVER be baked into a shipped build. Unset it before running `npm run build`.\n" +
        "(It exists only for a manual local test build — see AuthGate.tsx's comment.)\n"
    );
    process.exit(1);
  }
  process.exit(0);
}

// Only run as a CLI entrypoint — importable for tests without executing.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
