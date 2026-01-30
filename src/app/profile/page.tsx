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

  const [profile, setProfile] = useState<GolferProfile>(() =>
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
    // In case localStorage wasn't available on first render for some reason
    const fromStorage = getGolferProfile();
    if (fromStorage) setProfile(fromStorage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="bg-green-700 p-4 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto flex items-center gap-4">
          <Link href="/" className="p-2 hover:bg-green-600 rounded">
            ←
          </Link>
          <h1 className="text-xl font-bold">Profile</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto p-4 pb-24 space-y-6">
        <section className="bg-gray-800 rounded-xl p-4">
          <h2 className="text-lg font-bold mb-4">Golfer Info</h2>

          <div className="space-y-4">
            <div>
              <label className="block text-sm text-gray-300 mb-2">Name</label>
              <input
                value={profile.name}
                onChange={e => setProfile(p => ({ ...p, name: e.target.value }))}
                placeholder="Your name"
                className="w-full p-3 bg-gray-700 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-sm text-gray-300 mb-2">Handicap index</label>
              <input
                inputMode="decimal"
                value={profile.handicap ?? ''}
                onChange={e => setProfile(p => ({ ...p, handicap: parseOptionalNumber(e.target.value) }))}
                placeholder="e.g., 12.4"
                className="w-full p-3 bg-gray-700 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-sm text-gray-300 mb-2">Home course</label>
              <input
                value={profile.homeCourse ?? ''}
                onChange={e => setProfile(p => ({ ...p, homeCourse: e.target.value }))}
                placeholder="e.g., Bethpage Black"
                className="w-full p-3 bg-gray-700 rounded-lg"
              />
            </div>
          </div>
        </section>

        <section className="bg-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold">Club Distances (yards)</h2>
            <div className="text-xs text-gray-500">Optional</div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {CLUBS.map(c => (
              <div key={c.key} className="bg-gray-700/60 rounded-lg p-3">
                <label className="block text-xs text-gray-300 mb-1">{c.label}</label>
                <input
                  inputMode="numeric"
                  value={profile.clubDistances[c.key] ?? ''}
                  onChange={e => {
                    const n = parseOptionalNumber(e.target.value);
                    setProfile(p => ({
                      ...p,
                      clubDistances: {
                        ...p.clubDistances,
                        [c.key]: n === null ? undefined : n,
                      },
                    }));
                  }}
                  placeholder="-"
                  className="w-full p-2 bg-gray-700 rounded-lg"
                />
              </div>
            ))}
          </div>
        </section>

        <button
          onClick={handleSave}
          className="w-full p-4 bg-green-600 hover:bg-green-700 rounded-xl text-xl font-bold"
        >
          {saved ? '✓ Saved' : 'Save Profile'}
        </button>

        <p className="text-xs text-gray-500 text-center">Stored locally in your browser.</p>
      </main>
    </div>
  );
}
