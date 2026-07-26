"use client";

import type { ComponentType } from "react";
import dynamic from "next/dynamic";
import { T, PAPER_NOISE } from "@/components/yardage/tokens";

// Load the headless sign-in screen client-only. Under static export the
// page is prerendered with no ClerkProvider (the publishable key is
// injected at runtime via the build env), so any Clerk-hook component
// would throw at prerender time. `PaperShell` below is the `loading`
// placeholder — instant first paint, no white screen — while the real
// screen (and Clerk) load in.
const SignInScreen = dynamic(() => import("@/components/auth/SignInScreen"), {
  ssr: false,
  loading: () => <PaperShell kicker="Your yardage book" />,
});

// Load the auth diagnostic strip client-only for the same reason: useAuth()
// requires a live <ClerkProvider> which is not available at prerender time.
// This is a DEV/SIM-ONLY tool now (P0 fix — specs/p0-login-blocked-plan.md):
// the panel used to render on every native build (TestFlight included) and
// occluded the sign-in controls, blocking the owner from logging in. The
// import itself is now build-time conditional on NEXT_PUBLIC_AUTH_DIAG so
// that with the flag unset (every real build — see ops/ios/ship.sh), the
// component + its strings never reach the static-export bundle (`out/`)
// that ships to TestFlight. Proof: frontend/scripts/assert-no-auth-diag.mjs
// scans `out/` post-build (wired as `postbuild`) — the scan is the arbiter,
// not this mechanism.
//
// NOTE on what actually makes this work (found empirically, corrects the
// plan's stated mechanism): the plan's inline-ternary form
// (`cond ? dynamic(...) : null`) did NOT survive Next 16 / Turbopack's build
// on its own — the scan kept finding the component's compiled code in `out/`
// with the flag unset. The root cause was NOT ternary-vs-statement syntax:
// Next only inlines a NEXT_PUBLIC_* var as a build-time LITERAL (which is
// what makes `process.env.X === "1"` a compile-time-constant-false condition
// a bundler can dead-code-eliminate) when that key is PRESENT in
// `process.env` at build time — see getNextPublicEnvironmentVariables() in
// next/dist/lib/static-env.js. An unset var instead compiles to a genuine
// runtime `process.env` object lookup, which no amount of conditional
// restructuring can eliminate. next.config.ts now force-defines
// NEXT_PUBLIC_AUTH_DIAG via its `env` field (always "1" or "", never unset)
// specifically to fix this. This statement-form module-scope `let`/`if` is
// still used, matching the plan's documented fallback shape, and IS
// scan-proven clean with that config fix in place (see the build-guards
// tests + the manual before/after bundle-scan runs in the PR description).
let NativeAuthDiag: ComponentType | null = null;
if (process.env.NEXT_PUBLIC_AUTH_DIAG === "1") {
  NativeAuthDiag = dynamic(() => import("@/components/NativeAuthDiag"), {
    ssr: false,
  });
}

/** Static paper background + masthead — the pre-hydration first paint. */
function PaperShell({ kicker }: { kicker: string }) {
  return (
    <div
      style={{
        minHeight: "100dvh",
        background: `${PAPER_NOISE}, ${T.paper}`,
        backgroundBlendMode: "multiply",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "max(14px, env(safe-area-inset-top)) 24px max(24px, env(safe-area-inset-bottom))",
        fontFamily: T.sans,
      }}
    >
      <div
        style={{
          fontFamily: T.serif,
          fontStyle: "italic",
          fontSize: 44,
          letterSpacing: -1,
          color: T.ink,
          lineHeight: 1,
        }}
      >
        Looper.
      </div>
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 8.5,
          letterSpacing: 1.8,
          color: T.pencil,
          textTransform: "uppercase",
          marginTop: 10,
        }}
      >
        {kicker}
      </div>
    </div>
  );
}

export default function SignInClient() {
  return (
    <>
      <SignInScreen intent="signIn" />

      {/* On-screen auth diagnostic — dev/sim-only, gated by NEXT_PUBLIC_AUTH_DIAG
          at build time (never present in a shipped bundle). Shows the exact
          Clerk state so a build can be validated in the simulator: isLoaded /
          isSignedIn / token restored / Native API status / origin. */}
      {NativeAuthDiag ? <NativeAuthDiag /> : null}
    </>
  );
}
