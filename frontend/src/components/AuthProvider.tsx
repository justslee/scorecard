"use client";

import { ClerkProvider } from "@clerk/react";
import { Capacitor } from "@capacitor/core";
import { useEffect } from "react";
import type { ReactNode } from "react";
import ClerkTokenBridge from "@/components/ClerkTokenBridge";
import AuthGate from "@/components/AuthGate";
import { setAuthDiag } from "@/lib/auth-diag";
import { getNativeToken, setNativeToken } from "@/lib/native-token-store";
import { IdentityBridge } from "@/lib/identity";

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
// Problem: in a Capacitor WKWebView, cookies from Clerk's FAPI
// (clerk.looperapp.org) are blocked by WebKit's Intelligent Tracking Prevention
// as "third-party". The session cookie is never stored, so clerk-js never sees
// an active session even though sign-in succeeded.
//
// ── Regression that this file fixes (v1.0.365 white-screen) ──────────────────
// A previous version bundled @clerk/clerk-js locally, constructed a Clerk
// instance at MODULE-EVALUATION time (`new ClerkBrowser(pk)` inside an IIFE),
// wired FAPI callbacks on the instance, and passed it to <ClerkProvider> via the
// `Clerk={instance}` prop. That bundled instance has NO prebuilt UI components
// (those are only attached when clerk-react loads clerk-js from Clerk's CDN). On
// the sign-in screen, <SignIn/> calls `clerk.mountSignIn()` → `assertComponents
// Ready()` throws **"Clerk was not loaded with Ui components"** from inside
// React's componentDidMount, which trips Next.js's production error boundary →
// "Application error: a client-side exception has occurred while loading
// localhost". The whole app white-screened on load, before any sign-in.
// (Captured in the iOS Simulator + a headless repro of the prod bundle with the
// native code path forced on, 2026-06-28.)
//
// ── Fix: standard ClerkProvider everywhere + window-global FAPI hooks ─────────
// We let <ClerkProvider> load clerk-js the normal way (with UI components), on
// EVERY platform, so <SignIn/> always mounts and the app never white-screens.
// For native, the FAPI request/response interception is registered the supported
// way clerk-js reads at request time — via the `window.__internal_onBeforeRequest`
// / `window.__internal_onAfterResponse` globals — inside a guarded effect that is
// gated to native and torn down on unmount. This never throws on the render path:
// the worst case is that interception is inert and the diagnostic shows
// native-sent:false (full native-token auth then needs the @clerk/react v6
// upgrade so clerk-js v6's instance/global hooks are honoured — now done via
// the @clerk/react upgrade in this commit). The web/dev path is completely unaffected: the globals are only set
// when Capacitor.isNativePlatform() is true.
//
// The before-request hook: omit cookies, append _is_native=1 (so FAPI echoes the
// JWT in the "authorization" response header instead of a cookie — requires
// Native Applications enabled in the Clerk Dashboard), and inject the persisted
// JWT from the native token store (see native-token-store.ts — Keychain-backed
// via @aparajita/capacitor-secure-storage). The after-response hook reads that
// "authorization" header back and persists it. CapacitorHttp routes fetch()
// through iOS NSURLSession so all response headers are readable.

// FapiRequestInit = RequestInit & { url?: URL; ... }. At call time
// requestInit.headers is a Headers instance and requestInit.url is the built URL.
type FapiRequestInit = RequestInit & { url?: URL };
type FapiResponse = {
  headers?: Headers;
  payload?: { errors?: Array<{ code?: string }> };
};

// ── Before-request: inject native-mode signals ────────────────────────────────
async function nativeOnBeforeRequest(requestInit: FapiRequestInit): Promise<void> {
  // (a) No browser-managed cookies — WKWebView ITP blocks cross-origin cookies.
  requestInit.credentials = "omit";

  // (b) Signal Clerk FAPI to echo the JWT in the "authorization" response header
  //     (instead of a cookie). Requires Native API enabled in the Dashboard.
  requestInit.url?.searchParams.append("_is_native", "1");

  // Track the intercepted path for the diagnostic overlay.
  const path = requestInit.url?.pathname ?? null;
  setAuthDiag({ isNativeSent: true, lastFapiPath: path });

  // (c) Inject the persisted JWT from the native token store (empty string = first launch).
  let jwt = "";
  try {
    const value = await getNativeToken();
    if (value) {
      jwt = value;
      setAuthDiag({ tokenRestored: true });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setAuthDiag({ lastError: `token-read: ${msg}` });
  }

  // Always set the header — FAPI uses its mere presence to confirm native mode.
  (requestInit.headers as Headers).set("authorization", jwt);

  // (d) Identify as native mobile (mirrors @clerk/expo).
  (requestInit.headers as Headers).set("x-mobile", "1");
}

// ── After-response: capture the echoed JWT ────────────────────────────────────
async function nativeOnAfterResponse(
  _requestInit: FapiRequestInit,
  response: FapiResponse,
): Promise<void> {
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

  // Read the JWT Clerk echoes in the "authorization" response header. With
  // CapacitorHttp enabled (capacitor.config.ts), fetch() routes through iOS
  // NSURLSession which bypasses CORS — all response headers are readable.
  const authHeader = response?.headers?.get("authorization");
  setAuthDiag({ authHeaderReceived: Boolean(authHeader) });

  if (authHeader) {
    try {
      await setNativeToken(authHeader);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAuthDiag({ lastError: `token-write: ${msg}` });
    }
  }
}

/**
 * Registers the native FAPI interception hooks on `window` (gated to native).
 * Guarded so a failure can never break the render path — at worst the hooks are
 * simply not set and the app still loads via the standard ClerkProvider.
 */
function useNativeFapiHooks(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    type FapiWindow = typeof window & {
      __internal_onBeforeRequest?: typeof nativeOnBeforeRequest;
      __internal_onAfterResponse?: typeof nativeOnAfterResponse;
    };
    const w = window as FapiWindow;
    try {
      w.__internal_onBeforeRequest = nativeOnBeforeRequest;
      w.__internal_onAfterResponse = nativeOnAfterResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAuthDiag({ lastError: `hook-register: ${msg}` });
      console.error("[authdiag] native FAPI hook registration failed:", err);
    }
    return () => {
      try {
        delete w.__internal_onBeforeRequest;
        delete w.__internal_onAfterResponse;
      } catch {
        /* noop */
      }
    };
  }, [enabled]);
}

export default function AuthProvider({ children }: { children: ReactNode }) {
  // Check if Clerk is configured (key missing in local dev without .env).
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  // Capacitor.isNativePlatform() checks window.webkit.messageHandlers.bridge
  // (iOS) or window.androidBridge — both injected only by the native container,
  // absent in regular browsers and during Next.js static-export build.
  const isNative =
    typeof window !== "undefined" && Capacitor.isNativePlatform();

  // Register the native FAPI hooks (no-op on web/dev and during prerender).
  useNativeFapiHooks(Boolean(publishableKey) && isNative);

  if (!publishableKey) {
    // No Clerk configured — pass children through with no gate.
    // This keeps the app usable in local dev without credentials.
    return <>{children}</>;
  }

  // Standard ClerkProvider on EVERY platform: clerk-js loads with its UI
  // components so <SignIn/> mounts without throwing. Native interception is
  // layered on via the window globals registered above.
  return (
    <ClerkProvider publishableKey={publishableKey} appearance={clerkAppearance}>
      {/* Bridge registers useAuth().getToken into the module singleton so
          non-component code (api.ts / deepgram.ts) can fetch JWTs without
          relying on window.Clerk (which doesn't hydrate on capacitor://). */}
      <ClerkTokenBridge />
      {/* Mounts useMe() for the whole app (multiuser-p0-client-identity):
          persists scorecard_last_user_id on sign-in (the storage/namespacing
          fallback for platforms where window.Clerk never hydrates — see
          ClerkTokenBridge above) and best-effort ensures the golfer_profiles
          row exists. Placed BEFORE AuthGate so its effect commits before any
          newly-mounted page reads namespaced storage. Renders no UI. */}
      <IdentityBridge />
      {/* Gate: shows PaperLoading while Clerk initialises, the sign-in form
          when no session is present, and children once the session is active.
          Auth routes (/sign-in, /sign-up) always pass through to avoid loops. */}
      <AuthGate>{children}</AuthGate>
    </ClerkProvider>
  );
}
