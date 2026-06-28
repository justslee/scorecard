"use client";

import { ClerkProvider } from "@clerk/clerk-react";
import { Capacitor } from "@capacitor/core";
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
