'use client';

import Link from 'next/link';
import { Trash2, Users } from 'lucide-react';
import { seedDefaultPlayers } from '@/lib/storage';

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
            <p className="text-sm text-zinc-400">Data options.</p>
          </div>
        </div>
        <div className="header-divider" />
      </header>

      <main className="max-w-2xl mx-auto px-4 pt-5 pb-24 space-y-4">
        <section className="card p-5">
          <h2 className="text-lg font-semibold tracking-tight">About</h2>
          <p className="text-sm text-zinc-400 mt-2 leading-relaxed">
            A voice-first golf companion with OCR scorecard scanning. Track your rounds, enter scores
            hole-by-hole, or snap a photo of your paper scorecard to auto-fill. Scanning runs securely
            on the backend — no API key needed here.
          </p>
          <div className="mt-4 pt-4 border-t border-white/10 text-sm text-zinc-500">
            <p>Version 1.0.0</p>
          </div>
        </section>

        <section className="card p-5">
          <h2 className="text-lg font-semibold tracking-tight">Sample Players</h2>
          <p className="text-sm text-zinc-400 mt-1">Load 10 sample player profiles to test with.</p>
          <button
            onClick={() => {
              seedDefaultPlayers();
              alert('Sample players loaded! Go to Profile → My Players to see them.');
            }}
            className="btn w-full rounded-full py-3 mt-4 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-400/20 text-emerald-200"
          >
            <span className="inline-flex items-center justify-center gap-2">
              <Users className="h-5 w-5" aria-hidden="true" />
              <span>Load Sample Players</span>
            </span>
          </button>
        </section>

        <section className="card p-5">
          <h2 className="text-lg font-semibold tracking-tight">Data</h2>
          <p className="text-sm text-zinc-400 mt-1">Reset local app data (rounds, tournaments, profile).</p>
          <button
            onClick={() => {
              if (confirm('This will delete ALL rounds and data. Continue?')) {
                localStorage.clear();
                window.location.href = '/';
              }
            }}
            className="btn w-full rounded-full py-3 mt-4 bg-red-500/10 hover:bg-red-500/20 border border-red-400/20 text-red-200"
          >
            <span className="inline-flex items-center justify-center gap-2">
              <Trash2 className="h-5 w-5" aria-hidden="true" />
              <span>Clear All Data</span>
            </span>
          </button>
        </section>
      </main>
    </div>
  );
}
