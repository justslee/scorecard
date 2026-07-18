"use client";

/**
 * AuthGate — client-side auth boundary for the static-export / Capacitor build.
 *
 * No server middleware runs in a Capacitor webview (capacitor:// origin), so we
 * enforce the auth requirement here, inside <ClerkProvider>, using supported
 * useAuth() hooks instead of window.Clerk (which never hydrates on the custom
 * scheme).
 *
 * Three render states:
 *   !isLoaded           → calm paper loading screen — never flash the app or
 *                          sign-in form while the Clerk session is resolving
 *   isSignedIn          → render children (the full app)
 *   !isSignedIn + auth  → render children (sign-in / sign-up pages must stay
 *                          reachable so the Clerk widget can complete the flow)
 *   !isSignedIn + other → render <SignInClient> inline; once Clerk confirms the
 *                          session isSignedIn becomes true and children render
 *
 * After sign-in completes, useAuth() updates → isSignedIn=true → this component
 * re-renders → children render → getToken() works → voice + backend calls succeed.
 */

import { useAuth } from "@clerk/react";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { T, PAPER_NOISE } from "@/components/yardage/tokens";
import SignInClient from "@/app/sign-in/[[...sign-in]]/SignInClient";
import { SPIKE_AUTH_PREFIXES } from "@/lib/auth-spike/spike-flag";

/** URL prefixes that must remain reachable without a session. */
const AUTH_PREFIXES = ["/sign-in", "/sign-up"];

/**
 * `extraPrefixes` lets the auth-headless-spike (NEXT_PUBLIC_AUTH_SPIKE=1)
 * add its own dev routes to the allowlist without touching this function's
 * default behavior. On a default build SPIKE_AUTH_PREFIXES is `[]`, so
 * calling with no argument (or with `[]`) is byte-identical to today —
 * proven by auth-gate-routes.test.ts.
 */
export function isAuthRoute(pathname: string, extraPrefixes: string[] = []): boolean {
  const prefixes = [...AUTH_PREFIXES, ...extraPrefixes];
  return prefixes.some(
    (p) =>
      pathname === p ||
      pathname.startsWith(p + "/") ||
      pathname.startsWith(p + "#"),
  );
}

/** Calm yardage-book loading state shown while Clerk initialises. */
function PaperLoading() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: `${PAPER_NOISE}, ${T.paper}`,
        backgroundBlendMode: "multiply",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
      }}
    >
      <div
        style={{
          fontFamily: T.serif,
          fontStyle: "italic",
          fontSize: 38,
          color: T.ink,
          letterSpacing: -0.8,
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
        }}
      >
        Preparing your book
      </div>
    </div>
  );
}

export default function AuthGate({ children }: { children: ReactNode }) {
  // All hooks called unconditionally at the top (React rules of hooks).
  const { isLoaded, isSignedIn } = useAuth();
  const pathname = usePathname();

  // TEMPORARY test-build bypass (NEXT_PUBLIC_AUTH_BYPASS=1, set only by a manual
  // test build — never by the normal ship.sh prod build). Lets the owner exercise
  // the app while real login (Clerk pk_live) is being set up. This ONLY skips the
  // UI sign-in gate; the backend stays owner-gated, so backend-LLM features
  // (voice/caddie/OCR) still 401 and data uses the local cache. Remove once
  // pk_live login works — see backlog: clerk-prod-instance.
  if (process.env.NEXT_PUBLIC_AUTH_BYPASS === "1") {
    return <>{children}</>;
  }

  // Clerk is still resolving the session — show a calm paper placeholder.
  // This prevents flashing either the app content or the sign-in form.
  if (!isLoaded) {
    return <PaperLoading />;
  }

  // Auth routes (/sign-in, /sign-up, plus the spike's /dev/auth-spike and
  // /sso-callback when NEXT_PUBLIC_AUTH_SPIKE=1) render regardless of session
  // state so the Clerk widget / headless flow can complete without a
  // redirect loop. SPIKE_AUTH_PREFIXES is [] on a default build.
  if (isAuthRoute(pathname, SPIKE_AUTH_PREFIXES)) {
    return <>{children}</>;
  }

  // Not signed in on a non-auth route — show sign-in inline.
  // When the Clerk session activates, isSignedIn becomes true and this
  // component automatically re-renders to show children.
  if (!isSignedIn) {
    return <SignInClient />;
  }

  // Session active — render the full app.
  return <>{children}</>;
}
