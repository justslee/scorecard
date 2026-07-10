'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useClerk } from '@clerk/react';
import { T, PAPER_NOISE } from '@/components/yardage/tokens';
import { placeRehearsalCall } from '@/lib/teetime/client';
import type { RehearsalCallResponse } from '@/lib/teetime/types';

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
// Shared confirm-row — Cancel + a red action button side-by-side.
// Used by both SignOutButton and ClearCacheButton.
// ---------------------------------------------------------------------------

function ConfirmRow({
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
      <button
        onClick={onCancel}
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
      <button
        onClick={onConfirm}
        disabled={disabled}
        style={{
          flex: 2,
          minHeight: 44,
          border: `1px solid rgba(184,74,58,0.26)`,
          borderRadius: 99,
          background: T.errorWash,
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontFamily: T.mono,
          fontSize: 9,
          letterSpacing: 1.3,
          color: T.errorInk,
          textTransform: 'uppercase',
          fontWeight: 500,
          opacity: disabled ? 0.6 : 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
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
// SignOutButton — uses useClerk(); only rendered inside ClerkProvider.
// Initial button is NEUTRAL (not red) — sign-out is routine and reversible.
// Only the confirm-step action button is red (moment of action).
// ---------------------------------------------------------------------------

function SignOutButton() {
  const [confirming, setConfirming] = useState(false);
  const [signing, setSigning] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const { signOut } = useClerk();

  const handleSignOut = async () => {
    setSigning(true);
    setSignOutError(null);
    try {
      await signOut({ redirectUrl: '/' });
      // After signOut resolves, Clerk's session clears → AuthGate sees
      // isSignedIn=false → automatically shows the sign-in screen.
    } catch (e) {
      console.error('[settings] sign out error:', e);
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
          confirmLabel={signing ? 'Signing out…' : 'Yes, sign out'}
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
              textTransform: 'uppercase',
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
          width: '100%',
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
      {/* Show a prior sign-out error even after reverting to idle state */}
      {signOutError && (
        <div
          style={{
            marginTop: 8,
            fontFamily: T.mono,
            fontSize: 8.5,
            letterSpacing: 1,
            color: T.errorInk,
            textTransform: 'uppercase',
          }}
        >
          {signOutError}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// ClearCacheButton — in-page two-step confirm (same pattern as SignOutButton,
// consistent UX; no raw window.confirm()). Action button stays red (destructive).
// ---------------------------------------------------------------------------

function ClearCacheButton() {
  const [confirming, setConfirming] = useState(false);

  const handleClear = () => {
    localStorage.clear();
    window.location.href = '/';
  };

  if (confirming) {
    return (
      <ConfirmRow
        onCancel={() => setConfirming(false)}
        onConfirm={handleClear}
        confirmLabel="Yes, clear cache"
        confirmIcon={<TrashIcon size={14} />}
      />
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
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
  );
}

// ---------------------------------------------------------------------------
// Rehearsal call — owner triggers the AI pro-shop caller to ring their OWN
// number so they can role-play the shop and hear the exact script. Dialing is
// server-gated; today this shows the disclosure + a calm "not enabled yet"
// note until the live telephony bridge ships. No number is ever entered here —
// the callee comes only from backend config.
// ---------------------------------------------------------------------------

function RehearsalCallSection() {
  const [state, setState] = useState<'idle' | 'calling' | 'done' | 'error'>('idle');
  const [resp, setResp] = useState<RehearsalCallResponse | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const run = async () => {
    setState('calling');
    setResp(null);
    setErrMsg(null);
    try {
      setResp(await placeRehearsalCall());
      setState('done');
    } catch (e) {
      setErrMsg(
        e instanceof Error && e.message
          ? e.message
          : 'Could not reach the rehearsal service.',
      );
      setState('error');
    }
  };

  const body: React.CSSProperties = {
    fontFamily: T.serif,
    fontSize: 14,
    color: T.pencil,
    fontStyle: 'italic',
    lineHeight: 1.55,
    letterSpacing: -0.1,
    margin: 0,
  };
  const label: React.CSSProperties = {
    fontFamily: T.mono,
    fontSize: 9,
    letterSpacing: 1.6,
    color: T.pencil,
    textTransform: 'uppercase',
    fontWeight: 500,
  };

  return (
    <>
      <p style={body}>
        Have Looper call your own phone and rehearse a tee-time booking, so you
        can play the pro shop and hear exactly what it says. It never dials
        anyone but you.
      </p>

      <button
        onClick={run}
        disabled={state === 'calling'}
        style={{
          width: '100%',
          minHeight: 44,
          marginTop: 14,
          border: `1px solid ${T.hairline}`,
          borderRadius: 99,
          background: 'transparent',
          cursor: state === 'calling' ? 'default' : 'pointer',
          fontFamily: T.mono,
          fontSize: 9,
          letterSpacing: 1.3,
          color: T.ink,
          textTransform: 'uppercase',
          fontWeight: 500,
          opacity: state === 'calling' ? 0.55 : 1,
          padding: '0 1rem',
        }}
      >
        {state === 'calling' ? 'Calling…' : 'Place a rehearsal call'}
      </button>

      {state === 'error' && errMsg && (
        <p style={{ ...body, marginTop: 12, color: T.pencilSoft }}>{errMsg}</p>
      )}

      {state === 'done' && resp && (
        <div style={{ marginTop: 16 }}>
          {resp.calleeNumber && (
            <div style={{ ...label, marginBottom: 6 }}>
              Would ring {resp.calleeNumber}
            </div>
          )}

          {resp.disclosure && (
            <p style={{ ...body, fontStyle: 'normal', marginBottom: 12 }}>
              “{resp.disclosure}”
            </p>
          )}

          {resp.status !== 'completed' && resp.reason && (
            <p style={{ ...body, color: T.pencilSoft }}>{resp.reason}</p>
          )}

          {resp.status === 'completed' && resp.transcript.length > 0 && (
            <div
              style={{
                borderTop: `1px dashed ${T.hairline}`,
                paddingTop: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              {resp.transcript.map((turn, i) => (
                <div key={i}>
                  <div style={label}>{turn.speaker === 'agent' ? 'Looper' : 'Shop'}</div>
                  <div
                    style={{
                      fontFamily: T.serif,
                      fontSize: 14,
                      color: T.ink,
                      lineHeight: 1.5,
                      marginTop: 2,
                    }}
                  >
                    {turn.text}
                  </div>
                </div>
              ))}
            </div>
          )}

          {resp.status === 'completed' && resp.result?.message && (
            <p style={{ ...body, marginTop: 12 }}>{resp.result.message}</p>
          )}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

// Version: prefer NEXT_PUBLIC_APP_VERSION env var (set at build time per build);
// fall back to "Beta" rather than hardcoding a stale number.
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? 'Beta';

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
        // env(safe-area-inset-bottom) is ≥0 so max() is a no-op — use calc() directly.
        paddingBottom: 'calc(96px + env(safe-area-inset-bottom))',
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
          // Title is a noun label ("Your account"), not a verb/command.
          // Matches profile's section-title pattern: Handicap / Club distances / etc.
          <Section kicker="Account" title="Your account">
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
            {APP_VERSION}
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
          <ClearCacheButton />
        </Section>

        {/* ── Rehearsal call section (owner tool) ──────────────────── */}
        <Section kicker="Tee times" title="Rehearsal call">
          <RehearsalCallSection />
        </Section>
      </div>
    </div>
  );
}
