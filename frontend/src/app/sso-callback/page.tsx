/**
 * /sso-callback — web OAuth landing page for the auth-headless-spike's
 * Google web flow (specs/auth-headless-spike-plan.md §3.2). Only reachable
 * while signed out because AuthGate's SPIKE_AUTH_PREFIXES allows it — and
 * only when NEXT_PUBLIC_AUTH_SPIKE=1 (SPIKE_AUTH_PREFIXES is [] otherwise,
 * so this page is unreachable pre-sign-in on a default build; nothing links
 * to it either way).
 *
 * Flag OFF: static stub, no Clerk hooks touched.
 * Flag ON: dynamically imports <AuthenticateWithRedirectCallback/> (the same
 * dynamic-named-export pattern SignInClient.tsx uses for <SignIn/>), which
 * wraps clerk.handleRedirectCallback and completes both the sign-in and the
 * sign-in↔sign-up transfer case.
 */

"use client";

import dynamic from "next/dynamic";
import { AUTH_SPIKE_ENABLED } from "@/lib/auth-spike/spike-flag";

// Load client-only, exactly like SignInClient.tsx's <SignIn/> — the page is
// prerendered under static export with no live ClerkProvider, so rendering
// a Clerk component at prerender time would throw.
const AuthenticateWithRedirectCallback = dynamic(
  () => import("@clerk/react").then((m) => m.AuthenticateWithRedirectCallback),
  { ssr: false },
);

export default function SsoCallbackPage() {
  if (!AUTH_SPIKE_ENABLED) {
    return (
      <div style={{ padding: 24, fontFamily: "monospace" }}>
        auth-headless-spike disabled (set NEXT_PUBLIC_AUTH_SPIKE=1 to enable).
      </div>
    );
  }
  return (
    <div style={{ padding: 24, fontFamily: "monospace" }}>
      Completing sign-in…
      <AuthenticateWithRedirectCallback
        signInFallbackRedirectUrl="/dev/auth-spike"
        signUpFallbackRedirectUrl="/dev/auth-spike"
      />
    </div>
  );
}
