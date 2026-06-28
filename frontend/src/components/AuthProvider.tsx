"use client";

import { ClerkProvider } from "@clerk/clerk-react";
import type { HeadlessBrowserClerk } from "@clerk/clerk-react";
import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { Clerk as ClerkBrowser } from "@clerk/clerk-js";
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
// Problem: in a Capacitor WKWebView (origin capacitor://localhost), cookies from
// Clerk's FAPI (clerk.looperapp.org) are blocked by WebKit's Intelligent
// Tracking Prevention as "third-party". The session cookie is never stored,
// so clerk-js never sees an active session even though sign-in succeeded.
//
// Root cause of the previous approach (window globals): the window-global hooks
// (window.__internal_onBeforeRequest / window.__internal_onAfterResponse) are
// read by the clerk-js FAPI client at request time from the window object, but
// on-device diagnostics showed native-sent:false, meaning those globals were
// NEVER invoked. The CDN-loaded clerk-js bundle doesn't reliably honour the
// window globals in this Capacitor/WKWebView setup.
//
// Fix — bundle @clerk/clerk-js locally and register callbacks on the INSTANCE:
//
//   1. Import the Clerk class from @clerk/clerk-js (bundled locally in the
//      Next.js static export, not loaded from Clerk's CDN at runtime).
//
//   2. Construct a Clerk instance BEFORE ClerkProvider mounts:
//        const instance = new ClerkBrowser(publishableKey)
//
//   3. Register the FAPI before/after callbacks DIRECTLY on the instance using
//      the supported internal API:
//        instance.__internal_onBeforeRequest(cb)
//        instance.__internal_onAfterResponse(cb)
//      These delegate to the instance's FAPI client singleton
//      (this.#eq.onBeforeRequest / onAfterResponse in the minified source),
//      which is created in the constructor and guaranteed to fire on every
//      FAPI request.  Verified in @clerk/clerk-js@6 dist/clerk.mjs:
//        __internal_onBeforeRequest = e => this.#eq.onBeforeRequest(e)
//        __internal_onAfterResponse = e => this.#eq.onAfterResponse(e)
//      Also typed in dist/types/core/clerk.d.ts lines 241-242.
//
//   4. The before-request callback:
//      a. Sets credentials:"omit" — no browser-managed cookies on cross-origin.
//      b. Appends _is_native=1 to the URL — signals FAPI to echo the client
//         JWT in the "authorization" response header instead of a cookie.
//         Requires Native Applications enabled in the Clerk Dashboard:
//         https://dashboard.clerk.com/last-active?path=native-applications
//      c. Injects the persisted JWT (from @capacitor/preferences / Keychain)
//         into the "authorization" request header.
//      d. Sets x-mobile:1 (mirrors @clerk/expo) to identify native client.
//
//   5. The after-response callback:
//      a. Reads "authorization" from the response headers (the JWT Clerk echoes
//         when _is_native=1 is set and Native API is enabled).
//      b. Persists it to @capacitor/preferences (Keychain on iOS).
//      c. Detects native_api_disabled error and surfaces it in the diagnostic.
//
//   6. Pass the pre-constructed, callback-wired instance to ClerkProvider:
//        <ClerkProvider Clerk={instance} standardBrowser={false} ...>
//      ClerkProvider detects it is not a constructor (typeof instance !== "function")
//      and uses the existing instance, calling instance.load(options) where
//      options.standardBrowser=false switches Clerk to the non-cookie auth path.
//
// This approach is the @clerk/expo reference implementation adapted for
// Capacitor/Next.js.  See:
//   packages/expo/src/provider/singleton/createClerkInstance.ts in the
//   clerk/javascript GitHub repo (verified 2026-06-28).
//
// Gating: Capacitor.isNativePlatform() returns true only when
// window.webkit.messageHandlers.bridge (iOS) or window.androidBridge is present.
// During Next.js static export build (Node.js) and in regular browsers, it
// returns false — the web/dev build is completely unaffected.

const CLERK_CLIENT_JWT_KEY = "__clerk_client_jwt";

/**
 * Creates the native Clerk instance with FAPI callbacks wired on the instance.
 * Called at most once (from the module-level IIFE below).
 */
function createNativeClerkInstance(
  publishableKey: string,
): InstanceType<typeof ClerkBrowser> {
  const instance = new ClerkBrowser(publishableKey);

  // ── Before-request: inject native-mode signals ──────────────────────────
  // FapiRequestInit = RequestInit & { url?: URL; ... }
  // At call time, requestInit.headers is a Headers instance (set by the FAPI
  // client before invoking callbacks) and requestInit.url is the built URL.
  instance.__internal_onBeforeRequest(async (requestInit) => {
    // (a) No browser-managed cookies — WKWebView ITP blocks cross-origin cookies.
    requestInit.credentials = "omit";

    // (b) Signal Clerk FAPI to echo the JWT in the "authorization" response
    //     header (instead of a cookie). Requires Native API enabled in Dashboard.
    requestInit.url?.searchParams.append("_is_native", "1");

    // Track the intercepted path for the diagnostic overlay.
    const path = requestInit.url?.pathname ?? null;
    setAuthDiag({ isNativeSent: true, lastFapiPath: path });

    // (c) Inject the persisted JWT from Keychain (empty string = first launch).
    let jwt = "";
    try {
      const { value } = await Preferences.get({ key: CLERK_CLIENT_JWT_KEY });
      if (value) {
        jwt = value;
        setAuthDiag({ tokenRestored: true });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAuthDiag({ lastError: `prefs-read: ${msg}` });
    }

    // Always set the header — FAPI uses its mere presence to confirm native mode.
    (requestInit.headers as Headers).set("authorization", jwt);

    // (d) Identify as native mobile (mirrors @clerk/expo).
    (requestInit.headers as Headers).set("x-mobile", "1");
  });

  // ── After-response: capture the echoed JWT ──────────────────────────────
  instance.__internal_onAfterResponse(async (_requestInit, response) => {
    // Detect the "Native API not enabled" configuration error.
    const errors = response?.payload?.errors;
    if (errors?.[0]?.code === "native_api_disabled") {
      setAuthDiag({
        nativeApiDisabled: true,
        lastError:
          "native_api_disabled — enable at Dashboard → Configure → Native applications",
      });
      console.error(
        "[Clerk native] Native API disabled.\n" +
          "Go to: https://dashboard.clerk.com/last-active?path=native-applications\n" +
          "Enable Native Applications, then rebuild.",
      );
    }

    // Read the JWT Clerk echoes in the "authorization" response header.
    // With CapacitorHttp enabled (capacitor.config.ts), fetch() routes through
    // iOS NSURLSession which bypasses CORS — all response headers are readable.
    const authHeader = response?.headers?.get("authorization");
    setAuthDiag({ authHeaderReceived: Boolean(authHeader) });

    if (authHeader) {
      try {
        await Preferences.set({
          key: CLERK_CLIENT_JWT_KEY,
          value: authHeader,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setAuthDiag({ lastError: `prefs-write: ${msg}` });
      }
    }
  });

  return instance;
}

// ── Module-level singleton ────────────────────────────────────────────────────
// Constructed once when the module is first evaluated in the browser (client JS).
// The IIFE guard (typeof window + isNativePlatform) ensures this is a no-op:
//   • During next build / SSR pre-render (Node.js): typeof window === "undefined"
//     → returns null, no Clerk instance created.
//   • In a regular browser (web/dev): isNativePlatform() returns false (no bridge)
//     → returns null, standard CDN ClerkProvider path is used.
//   • In the iOS/Android Capacitor app: both checks pass → instance created with
//     callbacks wired, ready before ClerkProvider mounts.
const _nativeClerkInstance: InstanceType<typeof ClerkBrowser> | null = (() => {
  const key = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (typeof window === "undefined" || !Capacitor.isNativePlatform() || !key) {
    return null;
  }
  return createNativeClerkInstance(key);
})();

export default function AuthProvider({ children }: { children: ReactNode }) {
  // Check if Clerk is configured (key missing in local dev without .env).
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  if (!publishableKey) {
    // No Clerk configured — pass children through with no gate.
    // This keeps the app usable in local dev without credentials.
    return <>{children}</>;
  }

  // Capacitor.isNativePlatform() checks window.webkit.messageHandlers.bridge
  // (iOS) or window.androidBridge — both injected only by the native container,
  // absent in regular browsers and during Next.js static-export build.
  const isNative = Capacitor.isNativePlatform();

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      appearance={clerkAppearance}
      {...(isNative && _nativeClerkInstance
        ? {
            // standardBrowser:false — skip Clerk's cookie-based code path.
            standardBrowser: false,
            // Pass the pre-constructed, callback-wired instance.
            // ClerkProvider detects typeof instance !== "function" and uses it
            // directly, calling instance.load({ standardBrowser:false, ... }).
            Clerk: _nativeClerkInstance as unknown as HeadlessBrowserClerk,
          }
        : {})}
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
