'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Trash2, Users } from 'lucide-react';
import { seedDefaultPlayers } from '@/lib/storage';

export default function Settings() {
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const key = localStorage.getItem('anthropic_api_key') || '';
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setApiKey(key);
  }, []);

  const handleSave = () => {
    localStorage.setItem('anthropic_api_key', apiKey);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleClear = () => {
    if (confirm('Clear API key?')) {
      localStorage.removeItem('anthropic_api_key');
      setApiKey('');
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link href="/" className="btn btn-icon" aria-label="Back">
            ←
          </Link>
          <div>
            <h1 className="text-base font-semibold tracking-tight">Settings</h1>
            <p className="text-sm text-zinc-400">Scanning + data options.</p>
          </div>
        </div>
        <div className="header-divider" />
      </header>

      <main className="max-w-2xl mx-auto px-4 pt-5 pb-24 space-y-4">
        <section className="card p-5">
          <h2 className="text-lg font-semibold tracking-tight">Scorecard Scanning</h2>
          <p className="text-sm text-zinc-400 mt-1 leading-relaxed">
            To use OCR scanning, add your Claude API key from Anthropic. Your key is stored locally in your browser.
          </p>

          <div className="mt-4 space-y-3">
            <div>
              <label className="block text-xs font-medium text-zinc-400 tracking-wide uppercase mb-2">Claude API key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-ant-..."
                className="w-full px-4 py-3 rounded-2xl bg-white/5 border border-white/10 focus:bg-white/7"
              />
            </div>

            <div className="flex gap-2">
              <button onClick={handleSave} className="btn btn-primary flex-1">
                {saved ? 'Saved' : 'Save'}
              </button>
              {apiKey && (
                <button onClick={handleClear} className="btn rounded-full px-5 py-3 bg-red-500/10 hover:bg-red-500/20 border border-red-400/20 text-red-200">
                  Clear
                </button>
              )}
            </div>
          </div>

          <div className="mt-4 rounded-2xl bg-white/4 border border-white/10 p-4 text-sm">
            <p className="font-medium text-zinc-200 mb-2">Get an API key</p>
            <ol className="list-decimal list-inside space-y-1 text-zinc-400">
              <li>
                Go to{' '}
                <a
                  href="https://console.anthropic.com/settings/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-400 hover:text-emerald-300 underline"
                >
                  console.anthropic.com
                </a>
              </li>
              <li>Create a new API key</li>
              <li>Copy and paste it above</li>
            </ol>
          </div>
        </section>

        <section className="card p-5">
          <h2 className="text-lg font-semibold tracking-tight">About</h2>
          <p className="text-sm text-zinc-400 mt-2 leading-relaxed">
            A simple golf scoring app with optional OCR scorecard scanning. Track your rounds, enter scores hole-by-hole,
            or snap a photo of your paper scorecard to auto-fill.
          </p>
          <div className="mt-4 pt-4 border-t border-white/10 text-sm text-zinc-500">
            <p>Version 1.0.0</p>
            <p className="mt-1">Data is stored locally in your browser.</p>
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
