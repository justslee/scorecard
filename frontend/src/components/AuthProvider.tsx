"use client";

import { ClerkProvider } from "@clerk/clerk-react";
import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import type { ReactNode } from "react";
import ClerkTokenBridge from "@/components/ClerkTokenBridge";
import AuthGate from "@/components/AuthGate";

// Yardage-book appearance: warm paper / dark-ink palette to match the rest of
// the app. Uses Clerk's CSS-variable layer so the built-in widgets (sign-in,
// sign-up, profile) stay visually consistent without fighting the app's inline
// styles. Hex values mirror the T.* token constants in yardage/tokens.ts.
const clerkAppearance = {
  variables: {
    colorPrimary: "#1a2a1a",          // T.ink  — buttons, focus rings, links
    colorBackground: "#f4f1ea",       // T.paper — card / modal background
    colorText: "#1a2a1a",             // T.ink
    colorTextSecondary: "#6b6558",    // T.pencil — labels, hints
    colorInputBackground: "#ece7db",  // T.paperDeep — input fields
    colorInputText: "#1a2a1a",        // T.ink
    colorDanger: "#b84a3a",           // T.errorInk
    borderRadius: "2px",              // crisp, book-like corners
  },
  elements: {
    // Minimal structural overrides; variables drive the colour scheme.
    card: "shadow-sm",
    socialButtonsBlockButton: "border",
  },
};

// ─── Native session persistence (Capacitor iOS / Android only) ───────────────
//
// Problem: with standardBrowser:false, Clerk's JS SDK stores the client JWT
// in memory only — a force-quit clears it and the user must sign in again.
//
// Solution: Clerk's fapiClient (clerk-js/src/core/fapiClient.ts) reads two
// window-level callback slots before and after each FAPI request.  We install
// async callbacks in those slots at module-evaluation time — a synchronous
// operation that runs before React mounts and before the clerk-js CDN script
// finishes downloading and makes its first network call.  Every FAPI request
// (including the initial client-fetch on cold start) therefore goes through
// our hooks.
//
// Mechanism (mirrors @clerk/expo tokenCache, adapted for @clerk/clerk-react):
//   onBeforeRequest — appends ?_is_native=1 (signals Clerk backend to use
//     the Authorization header instead of cookies) and injects the JWT we
//     persisted from a previous session.
//   onAfterResponse — reads the "authorization" header from the FAPI response
//     and persists it to @capacitor/preferences (native Keychain on iOS).
//
// The key "__clerk_client_jwt" matches @clerk/expo's CLERK_CLIENT_JWT_KEY
// constant so the pattern is recognisable to anyone familiar with Clerk's
// mobile SDKs.
//
// Web / Next.js dev path: Capacitor.isNativePlatform() is false (it checks
// for the WKWebView bridge injected only by the native container), so no
// hooks are installed and the web code path is completely unchanged.

const CLERK_CLIENT_JWT_KEY = "__clerk_client_jwt";

// TypeScript declarations for the internal Clerk hook slots.
// These are not exported by @clerk/clerk-react but are explicitly supported
// in clerk-js/src/core/fapiClient.ts (lines ~90 and ~100 in that file).
declare global {
  interface Window {
    /** @internal Clerk FAPI pre-request hook (fapiClient.ts:runBeforeRequestCallbacks) */
    __internal_onBeforeRequest?: (requestInit: {
      url?: URL;
      headers?: Headers;
      credentials?: RequestCredentials;
      [key: string]: unknown;
    }) => Promise<void> | void;
    /** @internal Clerk FAPI post-response hook (fapiClient.ts:runAfterResponseCallbacks) */
    __internal_onAfterResponse?: (
      requestInit: unknown,
      response: { headers?: { get(name: string): string | null } },
    ) => Promise<void> | void;
  }
}

// Install native persistence hooks synchronously at module load.
// The guard keeps this a no-op on the web / dev path.
if (typeof window !== "undefined" && Capacitor.isNativePlatform()) {
  /**
   * Injected before every Clerk FAPI request on native.
   *
   * 1. Sets credentials:"omit" — WKWebView ITP blocks cross-site cookies
   *    from clerk.looperapp.org when the main origin is capacitor://localhost,
   *    so there is no point including them.
   * 2. Appends _is_native=1 — tells Clerk's backend to authenticate from the
   *    Authorization header rather than cookies.
   * 3. Injects the persisted client JWT if one exists (no-op on first launch
   *    before any JWT has been saved).
   */
  window.__internal_onBeforeRequest = async (requestInit) => {
    requestInit.credentials = "omit";
    requestInit.url?.searchParams.append("_is_native", "1");

    try {
      const { value } = await Preferences.get({ key: CLERK_CLIENT_JWT_KEY });
      if (value) {
        requestInit.headers?.set("authorization", value);
      }
    } catch {
      // Preferences unavailable (e.g. simulator without full native bridge).
      // Proceed without injecting the JWT; user will be asked to sign in.
    }
  };

  /**
   * Injected after every Clerk FAPI response on native.
   *
   * Clerk's backend echoes the current client JWT in the "authorization"
   * response header whenever _is_native=1 is present.  Persisting it here
   * means the next cold start can re-authenticate without a sign-in form.
   */
  window.__internal_onAfterResponse = async (_requestInit, response) => {
    const authHeader = response.headers?.get("authorization");
    if (authHeader) {
      try {
        await Preferences.set({ key: CLERK_CLIENT_JWT_KEY, value: authHeader });
      } catch {
        // Preferences unavailable; JWT not persisted this response.
      }
    }
  };
}

export default function AuthProvider({ children }: { children: ReactNode }) {
  // Check if Clerk is configured (key missing in local dev without .env).
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  if (!publishableKey) {
    // No Clerk configured — pass children through with no gate.
    // This keeps the app usable in local dev without credentials.
    return <>{children}</>;
  }

  // In a Capacitor WKWebView (iOS/Android), cookies set by a cross-origin domain
  // (clerk.looperapp.org) are blocked by Intelligent Tracking Prevention as
  // "third-party" relative to the https://localhost app origin. This prevents
  // Clerk's session cookie from being set, leaving isSignedIn permanently false
  // even after the user completes sign-in. Setting standardBrowser=false tells
  // Clerk's SDK to skip the standard-browser cookie assumption and use an
  // alternative (non-cookie) token storage path, which works in WKWebView.
  //
  // Capacitor.isNativePlatform() checks window.webkit.messageHandlers.bridge (iOS)
  // or window.androidBridge — both are injected only by the native container and
  // are absent in a regular browser or during the Next.js static-export build.
  // So this flag is reliably false on the web/dev path and true only in the app.
  const isNative = Capacitor.isNativePlatform();

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      appearance={clerkAppearance}
      {...(isNative ? { standardBrowser: false } : {})}
    >
      {/* Bridge registers useAuth().getToken into the module singleton so
          non-component code (api.ts / deepgram.ts) can fetch JWTs without
          relying on window.Clerk (which doesn't hydrate on capacitor://). */}
      <ClerkTokenBridge />
      {/* Gate: shows PaperLoading while Clerk initialises, the sign-in form
          when no session is present, and children once the session is active.
          Auth routes (/sign-in, /sign-up) always pass through to avoid loops. */}
      <AuthGate>{children}</AuthGate>
    </ClerkProvider>
  );
}
