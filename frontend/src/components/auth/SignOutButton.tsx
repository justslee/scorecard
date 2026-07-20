"use client";

/**
 * SignOutButton — quiet, yardage-book two-step in-page confirm. Shared by
 * Settings and the Profile "Account" section
 * (specs/multiuser-p0-signout-namespace-clear-plan.md §5). Extracted from
 * `settings/page.tsx` verbatim (behavior byte-equivalent) so it is not
 * duplicated between the two surfaces.
 *
 * No call to the sign-out teardown here — the reactive invariant in
 * `ClerkTokenBridge` owns it centrally, so it fires for EVERY sign-out cause
 * (this button, server revocation, session expiry, headless
 * `clerk.signOut()`), not just this one call site. See
 * `components/auth/useAuthFlow.ts:23`.
 */

import { useState } from "react";
import { useClerk } from "@clerk/react";
import { T } from "@/components/yardage/tokens";

// ---------------------------------------------------------------------------
// Icon
// ---------------------------------------------------------------------------

function SignOutIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Shared confirm-row — Cancel + a red action button side-by-side.
// Used by both SignOutButton and Settings' ClearCacheButton.
// ---------------------------------------------------------------------------

export function ConfirmRow({
  onCancel,
  onConfirm,
  confirmLabel,
  confirmIcon,
  disabled,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel: string;
  confirmIcon?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
      <button
        onClick={onCancel}
        style={{
          flex: 1,
          minHeight: 44,
          border: `1px solid ${T.hairline}`,
          borderRadius: 99,
          background: "transparent",
          cursor: "pointer",
          fontFamily: T.mono,
          fontSize: 9,
          letterSpacing: 1.3,
          color: T.pencil,
          textTransform: "uppercase",
          fontWeight: 500,
        }}
      >
        Cancel
      </button>
      <button
        onClick={onConfirm}
        disabled={disabled}
        style={{
          flex: 2,
          minHeight: 44,
          border: `1px solid rgba(184,74,58,0.26)`,
          borderRadius: 99,
          background: T.errorWash,
          cursor: disabled ? "not-allowed" : "pointer",
          fontFamily: T.mono,
          fontSize: 9,
          letterSpacing: 1.3,
          color: T.errorInk,
          textTransform: "uppercase",
          fontWeight: 500,
          opacity: disabled ? 0.6 : 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
        }}
      >
        {confirmIcon}
        {confirmLabel}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SignOutButtonInner — uses useClerk(); only rendered when Clerk is
// configured (see the guard on the default export below). Initial button is
// NEUTRAL (not red) — sign-out is routine and reversible. Only the confirm-
// step action button is red (moment of action).
// ---------------------------------------------------------------------------

function SignOutButtonInner() {
  const [confirming, setConfirming] = useState(false);
  const [signing, setSigning] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const { signOut } = useClerk();

  const handleSignOut = async () => {
    setSigning(true);
    setSignOutError(null);
    try {
      await signOut({ redirectUrl: "/" });
      // After signOut resolves, Clerk's session clears → AuthGate sees
      // isSignedIn=false → automatically shows the sign-in screen. The
      // centralized teardown (ClerkTokenBridge) runs off that transition.
    } catch (e) {
      console.error("[auth] sign out error:", e);
      setSignOutError("Couldn't sign out — try again.");
      setSigning(false);
      setConfirming(false);
    }
  };

  if (confirming) {
    return (
      <>
        <ConfirmRow
          onCancel={() => setConfirming(false)}
          onConfirm={handleSignOut}
          confirmLabel={signing ? "Signing out…" : "Yes, sign out"}
          confirmIcon={<SignOutIcon size={14} />}
          disabled={signing}
        />
        {signOutError && (
          <div
            style={{
              marginTop: 8,
              fontFamily: T.mono,
              fontSize: 8.5,
              letterSpacing: 1,
              color: T.errorInk,
              textTransform: "uppercase",
            }}
          >
            {signOutError}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      {/* Neutral button — sign-out is routine and fully reversible */}
      <button
        onClick={() => { setSignOutError(null); setConfirming(true); }}
        style={{
          width: "100%",
          minHeight: 44,
          border: `1px solid ${T.hairline}`,
          borderRadius: 99,
          background: "transparent",
          cursor: "pointer",
          fontFamily: T.mono,
          fontSize: 9,
          letterSpacing: 1.3,
          color: T.pencil,
          textTransform: "uppercase",
          fontWeight: 500,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: "0 1rem",
        }}
      >
        <SignOutIcon size={16} />
        Sign out
      </button>
      {/* Show a prior sign-out error even after reverting to idle state */}
      {signOutError && (
        <div
          style={{
            marginTop: 8,
            fontFamily: T.mono,
            fontSize: 8.5,
            letterSpacing: 1,
            color: T.errorInk,
            textTransform: "uppercase",
          }}
        >
          {signOutError}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Default export — self-guarded: useClerk() throws outside <ClerkProvider>
// on keyless dev builds, so render nothing (and never mount the inner
// component/hook) when Clerk isn't configured.
// ---------------------------------------------------------------------------

export default function SignOutButton() {
  const isClerkConfigured = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (!isClerkConfigured) return null;
  return <SignOutButtonInner />;
}
