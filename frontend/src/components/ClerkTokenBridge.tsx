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

import { useEffect } from "react";
import { useAuth } from "@clerk/react";
import { setTokenGetter } from "@/lib/auth-token";

export default function ClerkTokenBridge(): null {
  const { isLoaded, isSignedIn, getToken } = useAuth();

  // Register (or update) the getter on every auth-state change.
  // We register even when !isLoaded so the singleton knows Clerk is configured
  // and getTokenViaClerk can poll until it resolves.
  useEffect(() => {
    setTokenGetter(getToken, { isLoaded, isSignedIn: isSignedIn ?? false });
  }, [isLoaded, isSignedIn, getToken]);

  // Clear the getter on unmount only (not on every re-render).
  useEffect(() => {
    return () => {
      setTokenGetter(null, { isLoaded: false, isSignedIn: false });
    };
  }, []);

  return null;
}
