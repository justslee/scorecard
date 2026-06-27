'use client';

import Link from 'next/link';

// ---------------------------------------------------------------------------
// Inline icon — no lucide-react
// ---------------------------------------------------------------------------

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
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

export default function Settings() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link href="/" className="btn btn-icon" aria-label="Back">
            ←
          </Link>
          <div>
            <h1 className="text-base font-semibold tracking-tight">Settings</h1>
            <p className="text-sm" style={{ color: 'var(--pencil)' }}>Data options.</p>
          </div>
        </div>
        <div className="header-divider" />
      </header>

      <main className="max-w-2xl mx-auto px-4 pt-5 pb-24 space-y-4"
        style={{ paddingBottom: 'max(96px, calc(96px + env(safe-area-inset-bottom)))' }}
      >
        <section className="card p-5">
          <h2 className="text-lg font-semibold tracking-tight">About</h2>
          <p className="text-sm mt-2 leading-relaxed" style={{ color: 'var(--pencil)' }}>
            A voice-first golf companion with OCR scorecard scanning. Track your rounds, enter
            scores hole-by-hole, or snap a photo of your paper scorecard to auto-fill. Scanning
            runs securely on the backend — no API key needed here.
          </p>
          <div
            className="mt-4 pt-4 text-sm"
            style={{ borderTop: '1px solid var(--hairline)', color: 'var(--pencil-soft)' }}
          >
            <p>Version 1.0.0</p>
          </div>
        </section>

        <section className="card p-5">
          <h2 className="text-lg font-semibold tracking-tight">Local Cache</h2>
          <p className="text-sm mt-1" style={{ color: 'var(--pencil)' }}>
            Clear locally cached data (offline rounds, app state). Your backend data — players
            and profile — is not affected.
          </p>
          <button
            onClick={() => {
              if (
                confirm(
                  'Clear local offline cache?\n\nYour players and profile on the server are not affected — only this device\'s offline cache will be cleared.'
                )
              ) {
                localStorage.clear();
                window.location.href = '/';
              }
            }}
            className="btn w-full rounded-full mt-4"
            style={{
              minHeight: 44,
              padding: '0 1rem',
              background: 'rgba(184,74,58,0.08)',
              border: '1px solid rgba(184,74,58,0.22)',
              color: '#b84a3a',
            }}
          >
            <span className="inline-flex items-center justify-center gap-2">
              <TrashIcon className="h-5 w-5" />
              <span>Clear Local Cache</span>
            </span>
          </button>
        </section>
      </main>
    </div>
  );
}
