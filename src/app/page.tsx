'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AuthButtons from '@/components/AuthButtons';
import { Round, Tournament } from '@/lib/types';
import { deleteRound, deleteTournament, getRounds, getTournaments, initializeStorage } from '@/lib/storage';
import { motion, AnimatePresence } from 'framer-motion';
import { Flag, Settings, Trophy, Home as HomeIcon, Plus, User, ChartBar } from 'lucide-react';
import SwipeableRow from '@/components/SwipeableRow';
import RoundSummary from '@/components/RoundSummary';

export default function Home() {
  const [rounds, setRounds] = useState<Round[]>([]);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [summaryRound, setSummaryRound] = useState<Round | null>(null);

  useEffect(() => {
    initializeStorage();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRounds(getRounds());
    setTournaments(getTournaments());
    setLoaded(true);
  }, []);

  const handleDeleteRound = (id: string) => {
    deleteRound(id);
    setRounds(getRounds());
    setTournaments(getTournaments());
  };

  const handleDeleteTournament = (id: string) => {
    deleteTournament(id);
    setTournaments(getTournaments());
    setRounds(getRounds());
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
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-emerald-500/80" />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="max-w-2xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-baseline gap-2">
              <h1 className="text-xl font-semibold tracking-tight">Scorecard</h1>
              <Flag className="h-4 w-4 text-zinc-400" aria-hidden="true" />
            </div>
            <div className="flex items-center gap-2">
              <AuthButtons />
              <Link href="/settings" className="btn btn-icon" aria-label="Settings">
                <Settings className="h-5 w-5" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </div>
        <div className="header-divider" />
      </header>

      <main className="max-w-2xl mx-auto px-4 pt-5 pb-28">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="mb-6"
        >
          <Link href="/round/new" className="btn btn-primary w-full">
            + Start New Round
          </Link>
          <p className="mt-3 text-sm text-zinc-400 leading-relaxed">
            Quick scoring, fast totals, and optional scorecard scanning.
          </p>
        </motion.div>

        <section className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-zinc-400 tracking-wide uppercase">Tournaments</h2>
            <Link href="/tournament/new" className="text-sm text-emerald-400 hover:text-emerald-300 transition-colors">
              + New
            </Link>
          </div>

          {tournaments.length === 0 ? (
            <div className="card p-5">
              <p className="text-zinc-400">No tournaments yet.</p>
              <p className="text-sm text-zinc-500 mt-1">
                Create one to group rounds and track multiple players.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {tournaments.map((t, index) => (
                <motion.div
                  key={t.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, delay: index * 0.05 }}
                >
                  <SwipeableRow onDelete={() => handleDeleteTournament(t.id)}>
                    <Link
                      href={`/tournament/${t.id}`}
                      className="block card card-hover p-5"
                    >
                      <div className="flex justify-between items-start gap-3">
                        <div>
                          <h3 className="font-semibold text-lg tracking-tight flex items-center gap-2">
                            <Trophy className="h-5 w-5 text-zinc-300" aria-hidden="true" />
                            <span>{t.name}</span>
                          </h3>
                          <p className="text-zinc-400 text-sm mt-1">
                            {t.playerIds.length} players • {t.roundIds.length} rounds
                          </p>
                        </div>
                        {t.numRounds ? (
                          <span className="px-3 py-1 rounded-full text-xs bg-white/7 border border-white/10 text-zinc-300">
                            {t.roundIds.length}/{t.numRounds}
                          </span>
                        ) : null}
                      </div>
                    </Link>
                  </SwipeableRow>
                </motion.div>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-zinc-400 tracking-wide uppercase">Recent Rounds</h2>
          </div>

          {rounds.length === 0 ? (
            <div className="card p-8 text-center">
              <div className="flex justify-center">
                <Flag className="h-12 w-12 text-zinc-600" aria-hidden="true" />
              </div>
              <p className="mt-4 text-zinc-300 font-medium">No rounds yet</p>
              <p className="mt-1 text-sm text-zinc-500">Start your first round to begin tracking scores.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {rounds.map((round, index) => (
                <motion.div
                  key={round.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, delay: index * 0.05 }}
                >
                  <SwipeableRow onDelete={() => handleDeleteRound(round.id)}>
                    <Link href={`/round/${round.id}`}>
                      <motion.div
                        whileTap={{ scale: 0.98, opacity: 0.9 }}
                        transition={{ type: "spring", stiffness: 400, damping: 25 }}
                        className="card card-hover p-5 cursor-pointer active:bg-white/10"
                      >
                        <div className="flex justify-between items-start gap-3">
                          <div className="flex-1 min-w-0">
                            <h3 className="font-semibold text-lg tracking-tight">{round.courseName}</h3>
                            <p className="text-zinc-400 text-sm">{formatDate(round.date)}</p>
                            <p className="text-zinc-500 text-sm mt-1 line-clamp-1">
                              {round.players.map((p) => p.name).join(', ')}
                            </p>
                          </div>

                          <div className="flex items-center gap-2 flex-shrink-0">
                            <span
                              className={`px-3 py-1 rounded-full text-xs border ${
                                round.status === 'active'
                                  ? 'bg-amber-500/10 border-amber-400/20 text-amber-200'
                                  : 'bg-white/5 border-white/10 text-zinc-300'
                              }`}
                            >
                              {round.status === 'active' ? 'In Progress' : 'Complete'}
                            </span>
                            {round.status === 'completed' && (
                              <motion.button
                                whileTap={{ scale: 0.9 }}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setSummaryRound(round);
                                }}
                                className="btn btn-icon text-emerald-300 hover:text-emerald-200 hover:bg-emerald-500/10 border-emerald-400/20"
                                aria-label="View summary"
                                title="View Summary"
                              >
                                <ChartBar className="h-5 w-5" aria-hidden="true" />
                              </motion.button>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    </Link>
                  </SwipeableRow>
                </motion.div>
              ))}
            </div>
          )}
        </section>
      </main>

      <footer className="fixed bottom-0 left-0 right-0 backdrop-blur-xl bg-zinc-950/60 border-t border-white/10">
        <div className="max-w-2xl mx-auto flex justify-around px-2 py-2">
          <Link href="/" className="flex flex-col items-center p-2 text-emerald-300">
            <HomeIcon className="h-5 w-5" aria-hidden="true" />
            <span className="text-[11px] font-medium">Home</span>
          </Link>
          <Link
            href="/round/new"
            className="flex flex-col items-center p-2 text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            <Plus className="h-5 w-5" aria-hidden="true" />
            <span className="text-[11px] font-medium">New</span>
          </Link>
          <Link
            href="/profile"
            className="flex flex-col items-center p-2 text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            <User className="h-5 w-5" aria-hidden="true" />
            <span className="text-[11px] font-medium">Profile</span>
          </Link>
        </div>
      </footer>

      {/* Round Summary Modal */}
      <AnimatePresence>
        {summaryRound && (
          <motion.div
            key="summary"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
          >
            <RoundSummary round={summaryRound} onClose={() => setSummaryRound(null)} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
