'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Round, Tournament } from '@/lib/types';
import { addPlayerToTournament, getRound, getRounds, getTournament } from '@/lib/storage';
import TournamentLeaderboard from '@/components/TournamentLeaderboard';
import TournamentGamesPanel from '@/components/TournamentGamesPanel';
import { AnimatePresence, motion } from 'framer-motion';
import { Flag, X, Trophy, Gamepad2 } from 'lucide-react';

export default function TournamentPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [addingPlayer, setAddingPlayer] = useState(false);
  const [newPlayerName, setNewPlayerName] = useState('');
  const [activeTab, setActiveTab] = useState<'leaderboard' | 'games' | 'rounds'>('leaderboard');

  const refresh = () => {
    if (!id) return;
    const t = getTournament(id);
    setTournament(t);
    if (t) {
      const linked = t.roundIds.map((rid) => getRound(rid)).filter(Boolean) as Round[];
      const byTid = getRounds().filter((r) => r.tournamentId === t.id);
      const merged = [...linked, ...byTid.filter((r) => !linked.some((l) => l.id === r.id))];
      setRounds(merged);
    } else {
      setRounds([]);
    }
    setLoaded(true);
  };

  useEffect(() => {
    refresh();
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
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-emerald-500/80" />
      </div>
    );
  }

  if (!tournament) {
    return (
      <div className="min-h-screen px-6 py-8">
        <Link href="/" className="text-emerald-400 hover:text-emerald-300 transition-colors">
          ← Back
        </Link>
        <p className="mt-6 text-zinc-300">Tournament not found.</p>
      </div>
    );
  }

  const addRoundHref = `/tournament/${tournament.id}/round/new`;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <Link href="/" className="btn btn-icon" aria-label="Back">
              ←
            </Link>
            <div className="min-w-0">
              <h1 className="text-base sm:text-lg font-semibold tracking-tight truncate">{tournament.name}</h1>
              <div className="text-xs text-zinc-400">
                {tournament.playerIds.length} players • {rounds.length}/{tournament.numRounds ?? rounds.length} rounds
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => {
                setAddingPlayer(true);
                setNewPlayerName('');
              }}
              className="btn btn-secondary"
            >
              + Player
            </button>
            <Link href={addRoundHref} className="btn btn-primary">
              + Round
            </Link>
          </div>
        </div>
        <div className="header-divider" />
      </header>

      <main className="max-w-2xl mx-auto px-4 pt-5 pb-24 space-y-4">
        <AnimatePresence initial={false}>
          {addingPlayer && (
            <motion.section
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.16 }}
              className="card p-5"
            >
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h2 className="text-sm font-medium text-zinc-400 tracking-wide uppercase">Add player</h2>
                  <p className="text-lg font-semibold tracking-tight">New tournament player</p>
                </div>
                <button onClick={() => setAddingPlayer(false)} className="btn btn-icon" aria-label="Close">
                  <X className="h-5 w-5" aria-hidden="true" />
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  value={newPlayerName}
                  onChange={(e) => setNewPlayerName(e.target.value)}
                  placeholder="Player name"
                  className="flex-1 px-4 py-3 rounded-2xl bg-white/5 border border-white/10 focus:bg-white/7"
                />
                <button
                  onClick={() => {
                    const name = newPlayerName.trim();
                    if (!name) return;
                    addPlayerToTournament(tournament.id, { id: crypto.randomUUID(), name });
                    setAddingPlayer(false);
                    setNewPlayerName('');
                    refresh();
                  }}
                  className="btn btn-primary"
                >
                  Add
                </button>
              </div>
              <p className="text-xs text-zinc-500 mt-2">
                Added players will show up on the leaderboard and will be included in future rounds.
              </p>
            </motion.section>
          )}
        </AnimatePresence>

        {/* Tabs */}
        <div className="pill-tabs flex gap-1 mb-4">
          <button
            onClick={() => setActiveTab('leaderboard')}
            className={`pill-tab flex items-center gap-1.5 ${activeTab === 'leaderboard' ? 'pill-tab-active text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            <Trophy className="w-3.5 h-3.5" />
            Leaderboard
          </button>
          <button
            onClick={() => setActiveTab('games')}
            className={`pill-tab flex items-center gap-1.5 ${activeTab === 'games' ? 'pill-tab-active text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            <Gamepad2 className="w-3.5 h-3.5" />
            Games
          </button>
          <button
            onClick={() => setActiveTab('rounds')}
            className={`pill-tab flex items-center gap-1.5 ${activeTab === 'rounds' ? 'pill-tab-active text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            <Flag className="w-3.5 h-3.5" />
            Rounds
          </button>
        </div>

        <AnimatePresence mode="wait">
          {activeTab === 'leaderboard' && (
            <motion.div
              key="leaderboard"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18 }}
            >
              <TournamentLeaderboard tournament={tournament} rounds={roundsSorted} />
            </motion.div>
          )}

          {activeTab === 'games' && (
            <motion.div
              key="games"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18 }}
            >
              <TournamentGamesPanel tournament={tournament} rounds={roundsSorted} onUpdate={refresh} />
            </motion.div>
          )}

          {activeTab === 'rounds' && (
            <motion.div
              key="rounds"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18 }}
            >
              <section className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-medium text-zinc-400 tracking-wide uppercase">Rounds</h2>
              <p className="text-lg font-semibold tracking-tight">Play history</p>
            </div>
            <Link href={addRoundHref} className="text-sm text-emerald-400 hover:text-emerald-300 transition-colors">
              + Add
            </Link>
          </div>

          {roundsSorted.length === 0 ? (
            <div className="text-center py-10 text-zinc-400">
              <div className="flex justify-center mb-2">
                <Flag className="h-10 w-10 text-zinc-600" aria-hidden="true" />
              </div>
              <div className="text-zinc-300 font-medium">No rounds yet</div>
              <div className="text-sm text-zinc-500 mt-1">Start round one when you’re ready.</div>
              <div className="mt-5">
                <Link href={addRoundHref} className="btn btn-primary">
                  Start Round 1
                </Link>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {roundsSorted.map((r, idx) => (
                <Link key={r.id} href={`/round/${r.id}`} className="block card card-hover p-5 bg-white/3">
                  <div className="flex justify-between items-start gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold tracking-tight truncate">
                        Round {idx + 1}: {r.courseName}
                        {r.teeName ? ` (${r.teeName})` : ''}
                      </div>
                      <div className="text-sm text-zinc-400">{formatDate(r.date)}</div>
                      <div className="text-xs text-zinc-500 mt-1 truncate">{r.players.map((p) => p.name).join(', ')}</div>
                    </div>
                    <span
                      className={`px-3 py-1 rounded-full text-xs border ${
                        r.status === 'active'
                          ? 'bg-amber-500/10 border-amber-400/20 text-amber-200'
                          : 'bg-white/5 border-white/10 text-zinc-300'
                      }`}
                    >
                      {r.status === 'active' ? 'In Progress' : 'Complete'}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
              </section>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
