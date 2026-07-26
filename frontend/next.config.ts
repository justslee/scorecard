import type { NextConfig } from "next";

// Static client: the app is exported to `out/` and wrapped natively (Capacitor).
// It talks only to the FastAPI backend at NEXT_PUBLIC_API_URL via absolute,
// authenticated requests (fetchAPI + Clerk Bearer) — there is no same-origin
// server, so the old rewrites() proxy block is gone.
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  // Force NEXT_PUBLIC_AUTH_DIAG to always be a build-time literal (specs/
  // p0-login-blocked-plan.md §1). Next only inlines a NEXT_PUBLIC_* var as a
  // literal (enabling dead-code elimination of `process.env.X === "1"`
  // conditionals) when the key is PRESENT in process.env at build time —
  // see getNextPublicEnvironmentVariables() in next/dist/lib/static-env.js,
  // which skips any NEXT_PUBLIC_ key that is unset. An unset var instead
  // compiles to a genuine runtime `process.env` object lookup, which no
  // amount of ternary/statement restructuring can dead-code-eliminate
  // (verified empirically: both forms left the NativeAuthDiag chunk in
  // `out/`, caught by scripts/assert-no-auth-diag.mjs). Config's own `env`
  // field is unconditionally inlined regardless of shell state, so this
  // guarantees a real build-time literal ("1" or "") in every build,
  // including the normal case where the flag is never exported at all.
  env: {
    NEXT_PUBLIC_AUTH_DIAG: process.env.NEXT_PUBLIC_AUTH_DIAG ?? "",
  },
};

export default nextConfig;
