"use client";

/**
 * ClerkTokenBridge — registers Clerk's supported useAuth().getToken into the
 * module-level auth-token singleton so that non-component code (api.ts,
 * deepgram.ts) can retrieve session JWTs without relying on window.Clerk.
 *
 * Background: window.Clerk.session frequently never hydrates on the
 * capacitor://localhost origin used by the Capacitor/iOS webview, producing
 * 401s on every authenticated call. useAuth().getToken is Clerk's SUPPORTED
 * API and works regardless of the custom scheme.
 *
 * Must be rendered inside <ClerkProvider>. Renders no UI.
 */

import { useEffect, useRef } from "react";
import { useAuth } from "@clerk/react";
import { setTokenGetter } from "@/lib/auth-token";
import { runSignOutTeardown } from "@/lib/sign-out-teardown";

export default function ClerkTokenBridge(): null {
  const { isLoaded, isSignedIn, getToken } = useAuth();

  // Register (or update) the getter on every auth-state change.
  // We register even when !isLoaded so the singleton knows Clerk is configured
  // and getTokenViaClerk can poll until it resolves.
  useEffect(() => {
    setTokenGetter(getToken, { isLoaded, isSignedIn: isSignedIn ?? false });
  }, [isLoaded, isSignedIn, getToken]);

  // The centralized sign-out invariant (specs/multiuser-p0-signout-namespace-
  // clear-plan.md §1): on a real signed-in → signed-out transition, tear down
  // ALL per-user device state (live caddie mic/WebRTC, the namespace pointer,
  // in-memory identity state, and — native-only — the Keychain JWT) so
  // nothing resolves to the prior account for the next user on this device.
  // We only act on a real transition, NOT the initial not-yet-signed-in
  // state, so cold-start session restoration (which injects the stored JWT
  // before Clerk reports isSignedIn) is never clobbered. This is the ONLY
  // call site for runSignOutTeardown — it fires for every sign-out cause
  // (button, server revocation, session expiry, headless clerk.signOut()),
  // not just the Profile/Settings button (see useAuthFlow.ts:23).
  const wasSignedIn = useRef(false);
  useEffect(() => {
    if (!isLoaded) return;
    if (wasSignedIn.current && !isSignedIn) {
      void runSignOutTeardown();
    }
    wasSignedIn.current = Boolean(isSignedIn);
  }, [isLoaded, isSignedIn]);

  // Clear the getter on unmount only (not on every re-render).
  useEffect(() => {
    return () => {
      setTokenGetter(null, { isLoaded: false, isSignedIn: false });
    };
  }, []);

  return null;
}
