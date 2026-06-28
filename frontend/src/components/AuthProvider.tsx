"use client";

import { ClerkProvider } from "@clerk/clerk-react";
import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import type { ReactNode } from "react";
import ClerkTokenBridge from "@/components/ClerkTokenBridge";
import AuthGate from "@/components/AuthGate";
import { setAuthDiag } from "@/lib/auth-diag";

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
// Problem: in a Capacitor WKWebView (origin https://localhost), cookies from
// Clerk's FAPI (clerk.looperapp.org) are blocked by WebKit's Intelligent
// Tracking Prevention as "third-party".  The session cookie is never stored,
// so clerk-js never sees an active session even though sign-in succeeded on
// the server.
//
// Solution — Clerk native-token mode:
//
//   1. standardBrowser:false on <ClerkProvider> tells clerk-js to skip its
//      standard-browser code path (#loadInStandardBrowser) and use
//      #loadInNonStandardBrowser instead, which doesn't rely on cookies at
//      all.
//
//   2. Two window-level callback slots in clerk-js's fapiClient.ts are read
//      at the moment of every FAPI request:
//        window.__internal_onBeforeRequest  — mutates the RequestInit before fetch
//        window.__internal_onAfterResponse  — receives the Response after fetch
//      (Source: packages/clerk-js/src/core/fapiClient.ts,
//       runBeforeRequestCallbacks / runAfterResponseCallbacks.)
//      These are set here at module-evaluation time (synchronous, before React
//      mounts), so they are in place before clerk-js makes its first FAPI call.
//
//   3. __internal_onBeforeRequest:
//      a. Sets credentials:"omit" so the browser doesn't try to send/store
//         cookies for cross-origin FAPI requests.
//      b. Appends _is_native=1 to the URL, signalling Clerk's backend to echo
//         the client JWT in the "authorization" response header instead of
//         setting a cookie.  (Requires the Native API to be enabled in the
//         Clerk Dashboard: Configure → Native applications.)
//      c. Injects the JWT we persisted from a previous session into the
//         "authorization" request header.  Always sets the header (empty
//         string on first launch / after sign-out) — some Clerk backend
//         versions use its mere presence to confirm native mode.
//      d. Sets x-mobile:1 (mirrors @clerk/expo) to help the FAPI identify
//         the client as a native mobile app.
//
//   4. __internal_onAfterResponse:
//      a. Reads "authorization" from the response headers (the JWT the FAPI
//         returns when _is_native=1 is present and the Native API is enabled).
//      b. Persists it to @capacitor/preferences (Keychain on iOS) so the
//         next cold start can re-authenticate without showing the sign-in form.
//      c. Detects the native_api_disabled error code and logs it — this
//         indicates the Clerk Dashboard still needs the Native API enabled.
//
// Required Clerk Dashboard action (one-time):
//   https://dashboard.clerk.com/last-active?path=native-applications
//   → Enable Native Applications
//
// This approach mirrors @clerk/expo's createClerkInstance.ts (the reference
// implementation for Clerk native token mode) adapted for Capacitor / Next.js.
//
// Web / Next.js dev path: Capacitor.isNativePlatform() is false (it checks
// for window.webkit.messageHandlers.bridge injected only by the native
// container), so no hooks are installed and the standard web code path is
// completely unchanged.

const CLERK_CLIENT_JWT_KEY = "__clerk_client_jwt";

// TypeScript declarations for the internal Clerk FAPI hook slots.
// These are NOT exported by @clerk/clerk-react but are explicitly read from
// the window object in clerk-js/src/core/fapiClient.ts
// (runBeforeRequestCallbacks / runAfterResponseCallbacks).
declare global {
  interface Window {
    /**
     * @internal Clerk FAPI pre-request hook.
     * Read by fapiClient.ts: runBeforeRequestCallbacks.
     * Receives the RequestInit (with url:URL, headers:Headers already set)
     * just before fetch() is called.
     */
    __internal_onBeforeRequest?: (requestInit: {
      url?: URL;
      headers?: Headers;
      credentials?: RequestCredentials;
      [key: string]: unknown;
    }) => Promise<void> | void;

    /**
     * @internal Clerk FAPI post-response hook.
     * Read by fapiClient.ts: runAfterResponseCallbacks.
     * Receives the full FapiResponse (extends Response, adds .payload with
     * the parsed JSON body including any error codes).
     */
    __internal_onAfterResponse?: (
      requestInit: unknown,
      response: Response & {
        payload?: {
          errors?: Array<{ code: string; message?: string }>;
          [key: string]: unknown;
        } | null;
      },
    ) => Promise<void> | void;
  }
}

// Install native persistence hooks synchronously at module load.
// The guard keeps this a strict no-op on the web / dev path.
if (typeof window !== "undefined" && Capacitor.isNativePlatform()) {
  /**
   * Injected before every Clerk FAPI request on native.
   *
   * fapiClient.ts has already normalised requestInit.headers to a real
   * Headers instance and set requestInit.url to the built URL before
   * calling this callback, so .set() and .append() are safe.
   */
  window.__internal_onBeforeRequest = async (requestInit) => {
    // (a) Omit browser-managed cookies — WKWebView ITP blocks them for
    //     cross-origin FAPI requests from https://localhost.
    requestInit.credentials = "omit";

    // (b) Signal Clerk backend to return session JWT in response Authorization
    //     header instead of a Set-Cookie.  Requires Native API enabled in the
    //     Clerk Dashboard (Configure → Native applications).
    requestInit.url?.searchParams.append("_is_native", "1");

    // (c) Inject persisted JWT (or empty string to signal native mode).
    //     The header MUST be present on every request — some FAPI versions
    //     use its presence (even empty) to confirm native-mode handling.
    let jwt = "";
    try {
      const { value } = await Preferences.get({ key: CLERK_CLIENT_JWT_KEY });
      if (value) {
        jwt = value;
        // Signal to the diagnostic overlay that a token was found.
        setAuthDiag({ tokenRestored: true });
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : String(err);
      setAuthDiag({ lastError: `prefs-read: ${msg}` });
    }

    // Always set the header (empty string when no persisted token).
    const headers = requestInit.headers as Headers | undefined;
    headers?.set("authorization", jwt);

    // (d) Identify as a native mobile client (mirrors @clerk/expo).
    headers?.set("x-mobile", "1");
  };

  /**
   * Injected after every Clerk FAPI response on native.
   *
   * Clerk's backend echoes the client JWT in the "authorization" response
   * header whenever _is_native=1 is present AND the Native API is enabled.
   * We persist it to Capacitor Preferences (Keychain on iOS) so the next
   * cold start re-authenticates without a sign-in form.
   */
  window.__internal_onAfterResponse = async (_requestInit, response) => {
    // Detect and surface the "Native API not enabled" configuration error.
    // This fires when _is_native=1 is sent but the Clerk Dashboard hasn't
    // had "Native applications" enabled yet.
    const errors = response?.payload?.errors;
    if (errors?.[0]?.code === "native_api_disabled") {
      setAuthDiag({
        nativeApiDisabled: true,
        lastError:
          "native_api_disabled — enable at Dashboard → Configure → Native applications",
      });
      // Log clearly even in production so the owner sees it in Console.app.
      console.error(
        "[Clerk native] Native API disabled.\n" +
          "Go to: https://dashboard.clerk.com/last-active?path=native-applications\n" +
          "Enable Native Applications, then rebuild.",
      );
    }

    // Persist the JWT from the authorization response header.
    const authHeader = response?.headers?.get("authorization");
    if (authHeader) {
      try {
        await Preferences.set({
          key: CLERK_CLIENT_JWT_KEY,
          value: authHeader,
        });
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : String(err);
        setAuthDiag({ lastError: `prefs-write: ${msg}` });
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
  // The native-mode FAPI hooks above (window.__internal_onBeforeRequest /
  // __internal_onAfterResponse) handle the actual token injection/persistence.
  //
  // Capacitor.isNativePlatform() checks window.webkit.messageHandlers.bridge
  // (iOS) or window.androidBridge — both are injected only by the native
  // container and are absent in a regular browser or during the Next.js
  // static-export build. So this flag is reliably false on the web/dev path.
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
