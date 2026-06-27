'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useClerk } from '@clerk/clerk-react';
import { T, PAPER_NOISE } from '@/components/yardage/tokens';

// ---------------------------------------------------------------------------
// Inline icons — no lucide-react
// ---------------------------------------------------------------------------

function TrashIcon({ size = 18 }: { size?: number }) {
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
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

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
// Section shell — mirrors profile/page.tsx Section component
// ---------------------------------------------------------------------------

function Section({
  kicker,
  title,
  children,
}: {
  kicker: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        padding: '22px 22px 20px',
        borderTop: `1px solid ${T.hairline}`,
        position: 'relative',
      }}
    >
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 9,
          letterSpacing: 1.6,
          color: T.pencil,
          textTransform: 'uppercase',
          fontWeight: 500,
        }}
      >
        {kicker}
      </div>
      <div
        style={{
          fontFamily: T.serif,
          fontStyle: 'italic',
          fontSize: 22,
          color: T.ink,
          letterSpacing: -0.4,
          lineHeight: 1,
          marginTop: 3,
          marginBottom: 14,
        }}
      >
        {title}
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// SignOutButton — uses useClerk(); only rendered inside ClerkProvider
// (Settings conditionally renders this based on isClerkConfigured)
// ---------------------------------------------------------------------------

function SignOutButton() {
  const [confirming, setConfirming] = useState(false);
  const [signing, setSigning] = useState(false);
  const { signOut } = useClerk();

  const handleSignOut = async () => {
    setSigning(true);
    try {
      await signOut({ redirectUrl: '/' });
      // After signOut resolves, Clerk's session clears → AuthGate sees
      // isSignedIn=false → automatically shows the sign-in screen.
    } catch (e) {
      console.error('[settings] sign out error:', e);
      setSigning(false);
      setConfirming(false);
    }
  };

  if (confirming) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
        {/* Cancel */}
        <button
          onClick={() => setConfirming(false)}
          style={{
            flex: 1,
            minHeight: 44,
            border: `1px solid ${T.hairline}`,
            borderRadius: 99,
            background: 'transparent',
            cursor: 'pointer',
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: 1.3,
            color: T.pencil,
            textTransform: 'uppercase',
            fontWeight: 500,
          }}
        >
          Cancel
        </button>
        {/* Confirm sign out */}
        <button
          onClick={handleSignOut}
          disabled={signing}
          style={{
            flex: 2,
            minHeight: 44,
            border: `1px solid rgba(184,74,58,0.26)`,
            borderRadius: 99,
            background: T.errorWash,
            cursor: signing ? 'not-allowed' : 'pointer',
            fontFamily: T.mono,
            fontSize: 9,
            letterSpacing: 1.3,
            color: T.errorInk,
            textTransform: 'uppercase',
            fontWeight: 500,
            opacity: signing ? 0.6 : 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          <SignOutIcon size={14} />
          {signing ? 'Signing out…' : 'Yes, sign out'}
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      style={{
        width: '100%',
        minHeight: 44,
        border: `1px solid rgba(184,74,58,0.22)`,
        borderRadius: 99,
        background: T.errorWash,
        cursor: 'pointer',
        fontFamily: T.mono,
        fontSize: 9,
        letterSpacing: 1.3,
        color: T.errorInk,
        textTransform: 'uppercase',
        fontWeight: 500,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: '0 1rem',
      }}
    >
      <SignOutIcon size={16} />
      Sign out
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Settings() {
  // Guard: only render SignOutButton when Clerk is wired up (key is a build-time
  // constant via NEXT_PUBLIC_ prefix). Without the key the app runs as an open
  // dev build; useClerk() would throw outside <ClerkProvider>.
  const isClerkConfigured = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  return (
    <div
      style={{
        minHeight: '100vh',
        background: `${PAPER_NOISE}, ${T.paper}`,
        backgroundBlendMode: 'multiply',
        fontFamily: T.sans,
        color: T.ink,
        paddingBottom: 'max(96px, calc(96px + env(safe-area-inset-bottom)))',
      }}
    >
      <div style={{ maxWidth: 420, margin: '0 auto' }}>

        {/* ── Masthead ────────────────────────────────────────────────── */}
        <div
          style={{
            padding: 'max(14px, env(safe-area-inset-top)) 22px 18px',
            position: 'relative',
          }}
        >
          {/* Header bar: back / page label */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              minHeight: 44,
            }}
          >
            <Link
              href="/"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                minHeight: 44,
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontFamily: T.mono,
                fontSize: 10,
                letterSpacing: 1.6,
                color: T.pencil,
                textTransform: 'uppercase',
                fontWeight: 500,
                textDecoration: 'none',
              }}
            >
              <svg width="10" height="10" viewBox="0 0 12 12">
                <path
                  d="M8 2 L3 6 L8 10"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Home
            </Link>
            <div
              style={{
                fontFamily: T.mono,
                fontSize: 9,
                letterSpacing: 1.6,
                color: T.pencil,
                textTransform: 'uppercase',
                fontWeight: 500,
              }}
            >
              The Book
            </div>
          </div>

          {/* Page identity */}
          <div style={{ marginTop: 22 }}>
            <div
              style={{
                fontFamily: T.serif,
                fontStyle: 'italic',
                fontSize: 38,
                color: T.ink,
                letterSpacing: -1,
                lineHeight: 1,
              }}
            >
              Settings.
            </div>
            <div
              style={{
                fontFamily: T.serif,
                fontSize: 14,
                color: T.pencil,
                letterSpacing: -0.1,
                marginTop: 6,
                fontStyle: 'italic',
              }}
            >
              Data options &amp; account.
            </div>
          </div>
        </div>

        {/* ── Account section (sign out) ───────────────────────────── */}
        {isClerkConfigured && (
          <Section kicker="Account" title="Sign out">
            <p
              style={{
                fontFamily: T.serif,
                fontSize: 14,
                color: T.pencil,
                fontStyle: 'italic',
                lineHeight: 1.55,
                letterSpacing: -0.1,
                margin: 0,
              }}
            >
              Sign out of your Looper account on this device. Your rounds and
              profile are saved on the server and will be here when you return.
            </p>
            <SignOutButton />
          </Section>
        )}

        {/* ── About section ────────────────────────────────────────── */}
        <Section kicker="About" title="Looper">
          <p
            style={{
              fontFamily: T.serif,
              fontSize: 14,
              color: T.pencil,
              fontStyle: 'italic',
              lineHeight: 1.55,
              letterSpacing: -0.1,
              margin: 0,
            }}
          >
            A voice-first golf companion with OCR scorecard scanning. Track
            your rounds, enter scores hole-by-hole, or snap a photo of your
            paper scorecard to auto-fill. Scanning runs securely on the
            backend — no API key needed here.
          </p>
          <div
            style={{
              marginTop: 14,
              paddingTop: 12,
              borderTop: `1px dashed ${T.hairline}`,
              fontFamily: T.mono,
              fontSize: 8.5,
              letterSpacing: 1.3,
              color: T.pencilSoft,
              textTransform: 'uppercase',
              fontWeight: 500,
            }}
          >
            Version 1.0.0
          </div>
        </Section>

        {/* ── Local Cache section ──────────────────────────────────── */}
        <Section kicker="Data" title="Local cache">
          <p
            style={{
              fontFamily: T.serif,
              fontSize: 14,
              color: T.pencil,
              fontStyle: 'italic',
              lineHeight: 1.55,
              letterSpacing: -0.1,
              margin: 0,
            }}
          >
            Clear locally cached data (offline rounds, app state). Your
            players and profile on the server are not affected — only this
            device&apos;s offline cache will be cleared.
          </p>
          <button
            onClick={() => {
              if (
                confirm(
                  "Clear local offline cache?\n\nYour players and profile on the server are not affected — only this device's offline cache will be cleared."
                )
              ) {
                localStorage.clear();
                window.location.href = '/';
              }
            }}
            style={{
              width: '100%',
              minHeight: 44,
              marginTop: 14,
              border: `1px solid rgba(184,74,58,0.22)`,
              borderRadius: 99,
              background: T.errorWash,
              cursor: 'pointer',
              fontFamily: T.mono,
              fontSize: 9,
              letterSpacing: 1.3,
              color: T.errorInk,
              textTransform: 'uppercase',
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: '0 1rem',
            }}
          >
            <TrashIcon size={16} />
            Clear local cache
          </button>
        </Section>
      </div>
    </div>
  );
}
