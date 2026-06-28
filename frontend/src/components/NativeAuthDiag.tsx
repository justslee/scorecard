"use client";

/**
 * NativeAuthDiag — on-screen auth diagnostic strip for on-device validation.
 *
 * Rendered on the sign-in screen ONLY when:
 *   - Capacitor.isNativePlatform() is true  (TestFlight / device build), OR
 *   - NEXT_PUBLIC_AUTH_DIAG=1 is set in the build env (web debug override).
 *
 * This component must be imported via dynamic(() => ..., { ssr: false })
 * because it calls useAuth() which requires a live <ClerkProvider> — not
 * available during Next.js static-export prerendering.
 *
 * Reading the strip on-device:
 *   loaded  — Clerk JS initialised (true within ~1 s of app open)
 *   signed  — isSignedIn from useAuth(); should flip to true after sign-in
 *   tok     — a saved JWT was found in @capacitor/preferences at first FAPI
 *             request (true = session restores on next cold start)
 *   napi    — Clerk Native API status:
 *               true  = API enabled → JWT will be in Authorization header
 *               false = DISABLED  → enable at Clerk Dashboard:
 *                 https://dashboard.clerk.com/last-active?path=native-applications
 *   origin  — window.location.origin (should be "https://localhost" for a
 *             correct Capacitor build with iosScheme: "https")
 *   err     — last error from FAPI hooks; absent when all is well
 *
 * Expected "everything OK" readout after a successful sign-in:
 *   loaded:true  signed:true  tok:true  napi:true  origin:https://localhost
 *
 * If signed:false after completing the form and napi:false is shown,
 * enable the Native API in the Clerk Dashboard (one-time action).
 */

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/clerk-react";
import { Capacitor } from "@capacitor/core";
import { T } from "@/components/yardage/tokens";
import { getAuthDiag, subscribeAuthDiag, type AuthDiagState } from "@/lib/auth-diag";

export default function NativeAuthDiag() {
  const { isLoaded, isSignedIn } = useAuth();
  const [diag, setDiag] = useState<AuthDiagState>(getAuthDiag());

  // Re-render whenever the async FAPI hooks update the diagnostic state.
  useEffect(() => subscribeAuthDiag(() => setDiag({ ...getAuthDiag() })), []);

  const isNative = Capacitor.isNativePlatform();
  const authDiagEnabled = process.env.NEXT_PUBLIC_AUTH_DIAG === "1";

  // Only show on-device or when explicitly enabled for web debugging.
  if (!isNative && !authDiagEnabled) return null;

  const origin = window.location.origin;

  const parts: string[] = [
    `loaded:${isLoaded}`,
    `signed:${isSignedIn ?? false}`,
    `tok:${diag.tokenRestored}`,
    `napi:${!diag.nativeApiDisabled}`,
    `origin:${origin}`,
    ...(diag.lastError ? [`err:${diag.lastError}`] : []),
  ];

  return (
    <div
      style={{
        position: "fixed",
        // Sits just above the home indicator / safe area.
        bottom: "max(env(safe-area-inset-bottom, 0px), 8px)",
        left: 0,
        right: 0,
        padding: "5px 14px",
        fontFamily: T.mono,
        fontSize: 9,
        lineHeight: 1.5,
        color: T.pencil,
        background: T.paperDeep,
        opacity: 0.9,
        zIndex: 9999,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        letterSpacing: 0.3,
        borderTop: `1px solid rgba(107,101,88,0.18)`,
        // Non-interactive — purely informational.
        pointerEvents: "none",
      }}
    >
      {parts.join("  ")}
    </div>
  );
}
