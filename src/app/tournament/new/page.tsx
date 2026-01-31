'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Player, Tournament } from '@/lib/types';
import { initializeStorage, saveTournament } from '@/lib/storage';
import { Trophy, X } from 'lucide-react';

export default function NewTournamentPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [numRounds, setNumRounds] = useState<number>(3);
  const [players, setPlayers] = useState<Player[]>([{ id: crypto.randomUUID(), name: '' }]);

  useEffect(() => {
    initializeStorage();
  }, []);

  const addPlayer = () => setPlayers((p) => [...p, { id: crypto.randomUUID(), name: '' }]);

  const removePlayer = (id: string) => {
    setPlayers((p) => (p.length > 1 ? p.filter((x) => x.id !== id) : p));
  };

  const setPlayerName = (id: string, value: string) => {
    setPlayers((p) => p.map((x) => (x.id === id ? { ...x, name: value } : x)));
  };

  const handleCreate = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      alert('Tournament name is required');
      return;
    }

    const validPlayers = players.map((p) => ({ ...p, name: p.name.trim() })).filter((p) => p.name);
    if (validPlayers.length === 0) {
      alert('Add at least one player');
      return;
    }

    const playerIds = validPlayers.map((p) => p.id);
    const playerNamesById = Object.fromEntries(validPlayers.map((p) => [p.id, p.name]));

    const tournament: Tournament = {
      id: crypto.randomUUID(),
      name: trimmed,
      playerIds,
      roundIds: [],
      createdAt: new Date().toISOString(),
      numRounds: Math.max(1, numRounds || 1),
      playerNamesById,
    };

    saveTournament(tournament);
    router.push(`/tournament/${tournament.id}`);
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link href="/" className="btn btn-icon" aria-label="Back">
            ←
          </Link>
          <div>
            <h1 className="text-base font-semibold tracking-tight">New Tournament</h1>
            <p className="text-sm text-zinc-400">Create a multi-round event.</p>
          </div>
        </div>
        <div className="header-divider" />
      </header>

      <main className="max-w-2xl mx-auto px-4 pt-5 pb-24 space-y-4">
        <section className="card p-5">
          <label className="block text-xs font-medium text-zinc-400 tracking-wide uppercase mb-2">Tournament name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='e.g., "Boys Trip 2026"'
            className="w-full px-4 py-3 rounded-2xl bg-white/5 border border-white/10 focus:bg-white/7"
          />

          <label className="block text-xs font-medium text-zinc-400 tracking-wide uppercase mb-2 mt-4">Number of rounds</label>
          <input
            type="number"
            min={1}
            max={10}
            value={numRounds}
            onChange={(e) => setNumRounds(parseInt(e.target.value || '1', 10))}
            className="w-full px-4 py-3 rounded-2xl bg-white/5 border border-white/10 focus:bg-white/7"
          />
          <p className="text-xs text-zinc-500 mt-2">You can add rounds later as you play.</p>
        </section>

        <section className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-medium text-zinc-400 tracking-wide uppercase">Players</h2>
              <p className="text-lg font-semibold tracking-tight">Who’s in?</p>
            </div>
            {players.length < 12 && (
              <button onClick={addPlayer} className="text-sm text-emerald-400 hover:text-emerald-300 transition-colors">
                + Add
              </button>
            )}
          </div>

          <div className="space-y-3">
            {players.map((p, idx) => (
              <div key={p.id} className="flex gap-2">
                <input
                  value={p.name}
                  onChange={(e) => setPlayerName(p.id, e.target.value)}
                  placeholder={`Player ${idx + 1}`}
                  className="flex-1 px-4 py-3 rounded-2xl bg-white/5 border border-white/10 focus:bg-white/7"
                />
                {players.length > 1 && (
                  <button
                    onClick={() => removePlayer(p.id)}
                    className="btn rounded-2xl px-4 bg-red-500/10 hover:bg-red-500/20 border border-red-400/20 text-red-200"
                    aria-label="Remove player"
                  >
                    <X className="h-5 w-5" aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        <button onClick={handleCreate} className="btn btn-primary w-full">
          <span className="inline-flex items-center justify-center gap-2">
            <Trophy className="h-5 w-5" aria-hidden="true" />
            <span>Create Tournament</span>
          </span>
        </button>
      </main>
    </div>
  );
}
