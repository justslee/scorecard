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
import { Capacitor } from "@capacitor/core";
import { setTokenGetter } from "@/lib/auth-token";
import { clearNativeToken } from "@/lib/native-token-store";
import { setAuthDiag } from "@/lib/auth-diag";

export default function ClerkTokenBridge(): null {
  const { isLoaded, isSignedIn, getToken } = useAuth();

  // Register (or update) the getter on every auth-state change.
  // We register even when !isLoaded so the singleton knows Clerk is configured
  // and getTokenViaClerk can poll until it resolves.
  useEffect(() => {
    setTokenGetter(getToken, { isLoaded, isSignedIn: isSignedIn ?? false });
  }, [isLoaded, isSignedIn, getToken]);

  // Clear the persisted native JWT on sign-OUT (security: a stale credential
  // must not survive sign-out — see backlog clerk-jwt-keychain). We only act on
  // a real signed-in → signed-out transition, NOT the initial not-yet-signed-in
  // state, so cold-start session restoration (which injects the stored JWT
  // before Clerk reports isSignedIn) is never clobbered. Native-only: the store
  // is a no-op backend on web/dev.
  const wasSignedIn = useRef(false);
  useEffect(() => {
    if (!isLoaded) return;
    if (wasSignedIn.current && !isSignedIn && Capacitor.isNativePlatform()) {
      clearNativeToken()
        .then(() => setAuthDiag({ tokenRestored: false }))
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          setAuthDiag({ lastError: `token-clear: ${msg}` });
        });
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
