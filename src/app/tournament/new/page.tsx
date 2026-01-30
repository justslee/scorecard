'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Tournament, Player } from '@/lib/types';
import { initializeStorage, saveTournament } from '@/lib/storage';

export default function NewTournamentPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [numRounds, setNumRounds] = useState<number>(3);
  const [players, setPlayers] = useState<Player[]>([{ id: crypto.randomUUID(), name: '' }]);

  useEffect(() => {
    initializeStorage();
  }, []);

  const addPlayer = () => setPlayers(p => [...p, { id: crypto.randomUUID(), name: '' }]);

  const removePlayer = (id: string) => {
    setPlayers(p => (p.length > 1 ? p.filter(x => x.id !== id) : p));
  };

  const setPlayerName = (id: string, value: string) => {
    setPlayers(p => p.map(x => (x.id === id ? { ...x, name: value } : x)));
  };

  const handleCreate = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      alert('Tournament name is required');
      return;
    }

    const validPlayers = players.map(p => ({ ...p, name: p.name.trim() })).filter(p => p.name);
    if (validPlayers.length === 0) {
      alert('Add at least one player');
      return;
    }

    const playerIds = validPlayers.map(p => p.id);
    const playerNamesById = Object.fromEntries(validPlayers.map(p => [p.id, p.name]));

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
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="bg-green-700 p-4 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto flex items-center gap-4">
          <Link href="/" className="p-2 hover:bg-green-600 rounded">
            ←
          </Link>
          <h1 className="text-xl font-bold">New Tournament</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto p-4 pb-24 space-y-6">
        <section className="bg-gray-800 rounded-xl p-4">
          <label className="block text-sm text-gray-300 mb-2">Tournament name</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder='e.g., "Boys Trip 2026"'
            className="w-full p-3 bg-gray-700 rounded-lg"
          />

          <label className="block text-sm text-gray-300 mb-2 mt-4">Number of rounds</label>
          <input
            type="number"
            min={1}
            max={10}
            value={numRounds}
            onChange={e => setNumRounds(parseInt(e.target.value || '1', 10))}
            className="w-full p-3 bg-gray-700 rounded-lg"
          />
          <p className="text-xs text-gray-500 mt-2">You can add rounds later as you play.</p>
        </section>

        <section className="bg-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold">Players</h2>
            {players.length < 12 && (
              <button onClick={addPlayer} className="text-sm text-green-400 hover:text-green-300">
                + Add
              </button>
            )}
          </div>

          <div className="space-y-3">
            {players.map((p, idx) => (
              <div key={p.id} className="flex gap-2">
                <input
                  value={p.name}
                  onChange={e => setPlayerName(p.id, e.target.value)}
                  placeholder={`Player ${idx + 1}`}
                  className="flex-1 p-3 bg-gray-700 rounded-lg"
                />
                {players.length > 1 && (
                  <button
                    onClick={() => removePlayer(p.id)}
                    className="p-3 bg-red-900/50 text-red-300 rounded-lg hover:bg-red-900"
                    aria-label="Remove player"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        <button
          onClick={handleCreate}
          className="w-full p-4 bg-green-600 hover:bg-green-700 rounded-xl text-xl font-bold"
        >
          🏆 Create Tournament
        </button>
      </main>
    </div>
  );
}
