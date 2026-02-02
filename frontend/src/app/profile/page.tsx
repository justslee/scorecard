'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { GolferProfile } from '@/lib/types';
import { getGolferProfile, saveGolferProfile } from '@/lib/storage';

type ClubKey = keyof GolferProfile['clubDistances'];

const CLUBS: { key: ClubKey; label: string }[] = [
  { key: 'driver', label: 'Driver' },
  { key: 'threeWood', label: '3W' },
  { key: 'fiveWood', label: '5W' },
  { key: 'hybrid', label: 'Hybrid' },
  { key: 'fourIron', label: '4i' },
  { key: 'fiveIron', label: '5i' },
  { key: 'sixIron', label: '6i' },
  { key: 'sevenIron', label: '7i' },
  { key: 'eightIron', label: '8i' },
  { key: 'nineIron', label: '9i' },
  { key: 'pitchingWedge', label: 'PW' },
  { key: 'gapWedge', label: 'GW' },
  { key: 'sandWedge', label: 'SW' },
  { key: 'lobWedge', label: 'LW' },
  { key: 'putter', label: 'Putter' },
];

function parseOptionalNumber(v: string): number | null {
  const trimmed = v.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (Number.isNaN(n)) return null;
  return n;
}

export default function ProfilePage() {
  const existing = useMemo(() => getGolferProfile(), []);

  const [profile, setProfile] = useState<GolferProfile>(
    () =>
      existing ?? {
        id: crypto.randomUUID(),
        name: '',
        handicap: null,
        homeCourse: null,
        clubDistances: {},
      }
  );

  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const fromStorage = getGolferProfile();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (fromStorage) setProfile(fromStorage);
  }, []);

  const handleSave = () => {
    const next: GolferProfile = {
      ...profile,
      name: profile.name.trim(),
      homeCourse: profile.homeCourse?.trim() || null,
      handicap: profile.handicap === null ? null : Number(profile.handicap),
    };

    saveGolferProfile(next);
    setProfile(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link href="/" className="btn btn-icon" aria-label="Back">
            ←
          </Link>
          <div>
            <h1 className="text-base font-semibold tracking-tight">Profile</h1>
            <p className="text-sm text-zinc-400">Handicap + distances (optional).</p>
          </div>
        </div>
        <div className="header-divider" />
      </header>

      <main className="max-w-2xl mx-auto px-4 pt-5 pb-24 space-y-4">
        {/* My Players Link */}
        <Link href="/players" className="card card-hover p-5 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">My Players</h2>
            <p className="text-sm text-zinc-400">Manage your golf buddies</p>
          </div>
          <span className="text-zinc-500">→</span>
        </Link>

        <section className="card p-5">
          <h2 className="text-lg font-semibold tracking-tight">Golfer Info</h2>

          <div className="mt-4 space-y-4">
            <div>
              <label className="block text-xs font-medium text-zinc-400 tracking-wide uppercase mb-2">Name</label>
              <input
                value={profile.name}
                onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
                placeholder="Your name"
                className="w-full px-4 py-3 rounded-2xl bg-white/5 border border-white/10 focus:bg-white/7"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-400 tracking-wide uppercase mb-2">Handicap index</label>
              <input
                inputMode="decimal"
                value={profile.handicap ?? ''}
                onChange={(e) => setProfile((p) => ({ ...p, handicap: parseOptionalNumber(e.target.value) }))}
                placeholder="e.g., 12.4"
                className="w-full px-4 py-3 rounded-2xl bg-white/5 border border-white/10 focus:bg-white/7"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-400 tracking-wide uppercase mb-2">Home course</label>
              <input
                value={profile.homeCourse ?? ''}
                onChange={(e) => setProfile((p) => ({ ...p, homeCourse: e.target.value }))}
                placeholder="e.g., Bethpage Black"
                className="w-full px-4 py-3 rounded-2xl bg-white/5 border border-white/10 focus:bg-white/7"
              />
            </div>
          </div>
        </section>

        <section className="card p-5">
          <div className="flex items-end justify-between mb-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Club Distances</h2>
              <p className="text-sm text-zinc-400">Yards (optional)</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {CLUBS.map((c) => (
              <div key={c.key} className="rounded-2xl bg-white/4 border border-white/10 p-3">
                <label className="block text-xs font-medium text-zinc-400 tracking-wide uppercase mb-2">{c.label}</label>
                <input
                  inputMode="numeric"
                  value={profile.clubDistances[c.key] ?? ''}
                  onChange={(e) => {
                    const n = parseOptionalNumber(e.target.value);
                    setProfile((p) => ({
                      ...p,
                      clubDistances: {
                        ...p.clubDistances,
                        [c.key]: n === null ? undefined : n,
                      },
                    }));
                  }}
                  placeholder="–"
                  className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10 focus:bg-white/7"
                />
              </div>
            ))}
          </div>
        </section>

        <button onClick={handleSave} className="btn btn-primary w-full">
          {saved ? 'Saved' : 'Save Profile'}
        </button>

        <p className="text-xs text-zinc-500 text-center">Stored locally in your browser.</p>
      </main>
    </div>
  );
}
