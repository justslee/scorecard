'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Round } from '@/lib/types';
import { getRounds, deleteRound, initializeStorage } from '@/lib/storage';

export default function Home() {
  const [rounds, setRounds] = useState<Round[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    initializeStorage();
    setRounds(getRounds());
    setLoaded(true);
  }, []);

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirm('Delete this round?')) {
      deleteRound(id);
      setRounds(getRounds());
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  };

  if (!loaded) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-green-500"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Header */}
      <header className="bg-green-700 p-4 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto flex justify-between items-center">
          <h1 className="text-2xl font-bold">⛳ Scorecard</h1>
          <Link href="/settings" className="p-2 hover:bg-green-600 rounded">
            ⚙️
          </Link>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-2xl mx-auto p-4">
        {/* New Round Button */}
        <Link
          href="/round/new"
          className="block w-full p-6 bg-green-600 hover:bg-green-700 rounded-xl text-center text-xl font-bold mb-6 transition-colors"
        >
          + Start New Round
        </Link>

        {/* Recent Rounds */}
        <section>
          <h2 className="text-lg font-semibold text-gray-400 mb-3">Recent Rounds</h2>
          
          {rounds.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <p className="text-5xl mb-4">🏌️</p>
              <p>No rounds yet. Start your first round!</p>
            </div>
          ) : (
            <div className="space-y-3">
              {rounds.map(round => (
                <Link
                  key={round.id}
                  href={`/round/${round.id}`}
                  className="block bg-gray-800 rounded-lg p-4 hover:bg-gray-750 transition-colors"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <h3 className="font-bold text-lg">{round.courseName}</h3>
                      <p className="text-gray-400 text-sm">{formatDate(round.date)}</p>
                      <p className="text-gray-500 text-sm mt-1">
                        {round.players.map(p => p.name).join(', ')}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`px-3 py-1 rounded-full text-sm ${
                        round.status === 'active' 
                          ? 'bg-yellow-600 text-yellow-100' 
                          : 'bg-gray-600 text-gray-300'
                      }`}>
                        {round.status === 'active' ? '⏳ In Progress' : '✓ Complete'}
                      </span>
                      <button
                        onClick={(e) => handleDelete(round.id, e)}
                        className="p-2 text-red-400 hover:text-red-300 hover:bg-red-900/30 rounded"
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </main>

      {/* Footer */}
      <footer className="fixed bottom-0 left-0 right-0 bg-gray-800 border-t border-gray-700 p-2">
        <div className="max-w-2xl mx-auto flex justify-around">
          <Link href="/" className="flex flex-col items-center p-2 text-green-400">
            <span className="text-xl">🏠</span>
            <span className="text-xs">Home</span>
          </Link>
          <Link href="/round/new" className="flex flex-col items-center p-2 text-gray-400 hover:text-white">
            <span className="text-xl">➕</span>
            <span className="text-xs">New Round</span>
          </Link>
          <Link href="/settings" className="flex flex-col items-center p-2 text-gray-400 hover:text-white">
            <span className="text-xl">⚙️</span>
            <span className="text-xs">Settings</span>
          </Link>
        </div>
      </footer>
    </div>
  );
}
