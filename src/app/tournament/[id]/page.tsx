'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Round, Tournament } from '@/lib/types';
import { getRound, getRounds, getTournament } from '@/lib/storage';
import TournamentLeaderboard from '@/components/TournamentLeaderboard';

export default function TournamentPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = () => {
    if (!id) return;
    const t = getTournament(id);
    setTournament(t);
    if (t) {
      // Prefer linked rounds, fallback to filter-by tournamentId
      const linked = t.roundIds.map(rid => getRound(rid)).filter(Boolean) as Round[];
      const byTid = getRounds().filter(r => r.tournamentId === t.id);
      const merged = [...linked, ...byTid.filter(r => !linked.some(l => l.id === r.id))];
      setRounds(merged);
    } else {
      setRounds([]);
    }
    setLoaded(true);
  };

  useEffect(() => {
    refresh();
    // Update when returning to tab / page
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };

  const roundsSorted = useMemo(() => {
    return [...rounds].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  }, [rounds]);

  if (!loaded) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-green-500" />
      </div>
    );
  }

  if (!tournament) {
    return (
      <div className="min-h-screen bg-gray-900 text-white p-6">
        <Link href="/" className="text-green-400">← Back</Link>
        <p className="mt-6 text-gray-300">Tournament not found.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="bg-green-700 p-4 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link href="/" className="p-2 hover:bg-green-600 rounded">←</Link>
            <div>
              <h1 className="text-xl font-bold">{tournament.name}</h1>
              <div className="text-xs text-green-100/80">
                {tournament.playerIds.length} players • {rounds.length}/{tournament.numRounds ?? rounds.length} rounds
              </div>
            </div>
          </div>
          <Link
            href={`/tournament/${tournament.id}/round/new`}
            className="px-3 py-2 bg-green-600 hover:bg-green-500 rounded-lg text-sm font-bold"
          >
            + Round
          </Link>
        </div>
      </header>

      <main className="max-w-2xl mx-auto p-4 pb-24 space-y-6">
        <TournamentLeaderboard tournament={tournament} rounds={roundsSorted} />

        <section className="bg-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold">Rounds</h2>
            <Link href={`/tournament/${tournament.id}/round/new`} className="text-sm text-green-400 hover:text-green-300">
              + Add Round
            </Link>
          </div>

          {roundsSorted.length === 0 ? (
            <div className="text-center py-10 text-gray-500">
              <div className="text-4xl mb-2">⛳</div>
              <div>No rounds yet.</div>
              <div className="mt-4">
                <Link
                  href={`/tournament/${tournament.id}/round/new`}
                  className="inline-block px-4 py-3 bg-green-600 hover:bg-green-700 rounded-lg font-bold"
                >
                  Start Round 1
                </Link>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {roundsSorted.map((r, idx) => (
                <Link
                  key={r.id}
                  href={`/round/${r.id}`}
                  className="block bg-gray-700/60 hover:bg-gray-700 rounded-lg p-4 transition-colors"
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-bold">Round {idx + 1}: {r.courseName}{r.teeName ? ` (${r.teeName})` : ''}</div>
                      <div className="text-sm text-gray-400">{formatDate(r.date)}</div>
                      <div className="text-xs text-gray-500 mt-1">{r.players.map(p => p.name).join(', ')}</div>
                    </div>
                    <span className={`px-3 py-1 rounded-full text-sm ${
                      r.status === 'active' ? 'bg-yellow-600 text-yellow-100' : 'bg-gray-600 text-gray-300'
                    }`}>
                      {r.status === 'active' ? '⏳ In Progress' : '✓ Complete'}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
