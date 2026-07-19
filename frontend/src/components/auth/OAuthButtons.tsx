"use client";

/**
 * OAuthButtons — Apple (primary ink pill, HIG-shaped) + Google (hairline
 * pill), rendered but live-DISABLED this slice (login-screen-visual plan
 * §3 step "method", items 1-3). No handlers wired here — flip
 * `OAUTH_LIVE` to `true` and wire `signIn.sso(...)` (web) /
 * `authenticateWithGoogleOneTap` / `oauth_token_apple` (native, see
 * AuthSpikePanel.tsx §3.3/§3.4) once `auth-clerk-enable-social-connections`
 * lands. Keeping Apple HIG-shaped (logo + "Continue with Apple") while
 * disabled means enabling later is a no-restyle flip.
 */

import { T } from "@/components/yardage/tokens";

// One-line flip when Google/Apple SSO connections go live on the Clerk
// instance (auth-clerk-enable-social-connections). Local constant so the
// future PR is a single-line diff.
const OAUTH_LIVE = false;

const pillBase: React.CSSProperties = {
  height: 56,
  width: "100%",
  borderRadius: 999,
  fontFamily: T.sans,
  fontSize: 15,
  fontWeight: 500,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  border: "none",
  cursor: "default",
  WebkitAppearance: "none",
};

function AppleGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" fill="currentColor" aria-hidden="true">
      <path d="M12.15 8.87c-.02-1.86 1.52-2.76 1.59-2.8-.87-1.27-2.22-1.44-2.7-1.46-1.15-.12-2.25.68-2.83.68-.59 0-1.48-.66-2.44-.64-1.25.02-2.4.73-3.04 1.85-1.3 2.25-.33 5.58.93 7.41.62.89 1.35 1.9 2.32 1.86.93-.04 1.28-.6 2.4-.6 1.12 0 1.43.6 2.41.58 1-.02 1.62-.9 2.23-1.79.7-1.03.99-2.02 1-2.07-.02-.01-1.92-.74-1.94-2.93zM10.36 3.14c.51-.62.86-1.48.76-2.34-.74.03-1.63.49-2.16 1.11-.47.55-.89 1.44-.78 2.28.83.06 1.68-.42 2.18-1.05z" />
    </svg>
  );
}

function GoogleGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.9v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.9A9 9 0 0 0 0 9c0 1.45.35 2.83.9 4.03l3.05-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .9 4.97L3.95 7.3C4.66 5.17 6.65 3.58 9 3.58z" />
    </svg>
  );
}

export default function OAuthButtons() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <button
        type="button"
        disabled={!OAUTH_LIVE}
        aria-disabled={!OAUTH_LIVE}
        style={{
          ...pillBase,
          background: T.ink,
          color: T.paper,
          opacity: OAUTH_LIVE ? 1 : 0.5,
        }}
      >
        <AppleGlyph />
        Continue with Apple
      </button>

      <button
        type="button"
        disabled={!OAUTH_LIVE}
        aria-disabled={!OAUTH_LIVE}
        style={{
          ...pillBase,
          background: "transparent",
          color: T.ink,
          border: `1px solid ${T.hairline}`,
          opacity: OAUTH_LIVE ? 1 : 0.5,
        }}
      >
        <GoogleGlyph />
        Continue with Google
      </button>

      {!OAUTH_LIVE && (
        <div
          style={{
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: 1.5,
            textTransform: "uppercase",
            color: T.pencil,
            textAlign: "center",
            marginTop: -2,
          }}
        >
          Apple &amp; Google coming online shortly
        </div>
      )}
    </div>
  );
}
