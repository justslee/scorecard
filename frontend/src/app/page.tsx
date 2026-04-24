'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronRight, Mic, Search, Trophy, User, X } from 'lucide-react';
import { Round, Tournament, GolferProfile } from '@/lib/types';
import { getRounds, getTournaments, getGolferProfile, initializeStorage } from '@/lib/storage';
import PaperShell from '@/components/yardage/PaperShell';
import VoiceOrb from '@/components/yardage/VoiceOrb';
import AuthButtons from '@/components/AuthButtons';

type TeeTime = {
  id: string;
  courseName: string;
  city: string;
  time: string;
  priceUsd: number;
  distanceMiles: number;
  rating: number;
  cartIncluded: boolean;
};

function greetingFor(d: Date) {
  const h = d.getHours();
  if (h < 5) return 'Still up';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function scoringAverage(rounds: Round[]) {
  const completed = rounds.filter((r) => r.status === 'completed');
  if (!completed.length) return null;
  let total = 0;
  let count = 0;
  for (const r of completed) {
    const me = r.players[0];
    if (!me) continue;
    const strokes = r.scores.filter((s) => s.playerId === me.id && s.strokes != null).reduce((a, s) => a + (s.strokes ?? 0), 0);
    if (strokes > 0) {
      total += strokes;
      count += 1;
    }
  }
  return count ? Math.round((total / count) * 10) / 10 : null;
}

export default function Home() {
  const [rounds, setRounds] = useState<Round[]>([]);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [profile, setProfile] = useState<GolferProfile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [teeTimesOpen, setTeeTimesOpen] = useState(false);

  useEffect(() => {
    initializeStorage();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRounds(getRounds());
    setTournaments(getTournaments());
    setProfile(getGolferProfile());
    setLoaded(true);
  }, []);

  const greeting = useMemo(() => greetingFor(new Date()), []);
  const avg = useMemo(() => scoringAverage(rounds), [rounds]);
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  if (!loaded) {
    return (
      <PaperShell>
        <div className="min-h-screen flex items-center justify-center">
          <span className="eyebrow">Loading…</span>
        </div>
      </PaperShell>
    );
  }

  return (
    <PaperShell>
      {/* Masthead */}
      <header className="px-5 pt-6 pb-4">
        <div className="max-w-xl mx-auto">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <VoiceOrb size={18} active={false} />
              <span className="mono text-[11px] tracking-[0.2em] uppercase" style={{ color: 'var(--pencil)' }}>
                LOOPER
              </span>
            </div>
            <div className="flex items-center gap-2">
              <AuthButtons />
              <Link href="/profile" className="btn-ghost rounded-full px-3 py-1.5" aria-label="Profile">
                <User className="h-4 w-4" />
                <span className="text-xs">Profile</span>
              </Link>
            </div>
          </div>

          <div className="eyebrow mb-3">{today}</div>
          <h1 className="display text-[56px] leading-[0.95]">
            {greeting},
            <br />
            <span className="serif-italic" style={{ color: 'var(--accent)' }}>
              {profile?.name?.split(' ')[0] ?? 'Golfer'}.
            </span>
          </h1>
          <p className="mt-3 text-sm" style={{ color: 'var(--pencil)' }}>
            Gentle breeze, 62°. Fairways are soft — ball won&apos;t run out.
          </p>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-5 pb-24">
        {/* Primary CTA — Hey Caddy */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="sheet p-5 mt-4"
          style={{ background: 'var(--ink)', color: 'var(--paper)', borderColor: 'var(--ink)' }}
        >
          <div className="flex items-start gap-3">
            <div className="shrink-0 mt-1">
              <VoiceOrb size={22} active />
            </div>
            <div className="flex-1">
              <div className="eyebrow" style={{ color: 'var(--paper-edge)' }}>
                Hey caddy · Tap to talk
              </div>
              <div className="serif-italic text-[26px] leading-tight mt-1">
                &ldquo;Start a round at Harding, whites, me and Jack.&rdquo;
              </div>
              <div className="flex gap-2 mt-4">
                <Link href="/round/new" className="btn-accent text-[13px] px-4 py-2">
                  <Mic className="h-4 w-4" /> Start a round
                </Link>
                <Link href="/tournament/new" className="btn-paper text-[13px] px-4 py-2" style={{ background: 'transparent', color: 'var(--paper)', borderColor: 'rgba(244,241,234,0.25)' }}>
                  <Trophy className="h-4 w-4" /> Plan a tournament
                </Link>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Hero stats — handicap + scoring */}
        <section className="mt-6 grid grid-cols-2 gap-3">
          <div className="sheet p-4">
            <div className="eyebrow">Handicap</div>
            <div className="flex items-baseline gap-2 mt-1">
              <div className="display text-[40px]">
                {profile?.handicap ?? '—'}
              </div>
              <span className="mono text-xs" style={{ color: 'var(--pencil)' }}>
                idx
              </span>
            </div>
            <div className="text-xs mt-1" style={{ color: 'var(--pencil)' }}>
              {profile?.handicap != null ? 'trending down · 0.4' : 'Set in your profile'}
            </div>
          </div>
          <div className="sheet p-4">
            <div className="eyebrow">Scoring avg</div>
            <div className="flex items-baseline gap-2 mt-1">
              <div className="display text-[40px]">{avg ?? '—'}</div>
              <span className="mono text-xs" style={{ color: 'var(--pencil)' }}>
                {rounds.filter((r) => r.status === 'completed').length} rds
              </span>
            </div>
            <div className="text-xs mt-1" style={{ color: 'var(--pencil)' }}>
              {avg ? 'last 10 rounds' : 'No completed rounds yet'}
            </div>
          </div>
        </section>

        {/* Tee time finder */}
        <button
          type="button"
          onClick={() => setTeeTimesOpen(true)}
          className="mt-4 sheet w-full text-left p-4 flex items-center gap-4"
        >
          <div className="shrink-0 w-11 h-11 rounded-full flex items-center justify-center" style={{ background: 'var(--paper-deep)' }}>
            <Search className="h-5 w-5" style={{ color: 'var(--ink)' }} />
          </div>
          <div className="flex-1">
            <div className="eyebrow">Tee times near you</div>
            <div className="serif text-[18px] leading-tight mt-0.5">Find a slot — this weekend</div>
            <div className="text-xs mt-1" style={{ color: 'var(--pencil)' }}>
              8 courses · 42 times · 6:10a to 1:50p
            </div>
          </div>
          <ChevronRight className="h-5 w-5" style={{ color: 'var(--pencil)' }} />
        </button>

        {/* Trophy case tease — tournaments */}
        {tournaments.length > 0 && (
          <section className="mt-8">
            <div className="flex items-center justify-between mb-3">
              <div className="eyebrow">Trophy case</div>
              <Link href="/tournament/new" className="mono text-[11px]" style={{ color: 'var(--accent)' }}>
                + NEW
              </Link>
            </div>
            <div className="space-y-3">
              {tournaments.map((t) => (
                <Link key={t.id} href={`/tournament/${t.id}`} className="sheet block p-4 hover:bg-white/10">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Trophy className="h-4 w-4" style={{ color: 'var(--accent)' }} />
                        <span className="serif text-[20px] leading-tight truncate">{t.name}</span>
                      </div>
                      <div className="mono text-[11px]" style={{ color: 'var(--pencil)' }}>
                        {t.playerIds.length} PLAYERS · {t.roundIds.length}
                        {t.numRounds ? `/${t.numRounds}` : ''} ROUNDS
                      </div>
                    </div>
                    <ChevronRight className="h-5 w-5" style={{ color: 'var(--pencil)' }} />
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Recent rounds */}
        <section className="mt-8">
          <div className="flex items-center justify-between mb-3">
            <div className="eyebrow">Recent rounds</div>
            <Link href="/round/new" className="mono text-[11px]" style={{ color: 'var(--accent)' }}>
              + NEW ROUND
            </Link>
          </div>

          {rounds.length === 0 ? (
            <div className="sheet p-6 text-center">
              <div className="serif-italic text-[22px]" style={{ color: 'var(--pencil)' }}>
                Your first round is waiting.
              </div>
              <div className="mt-3">
                <Link href="/round/new" className="btn-ink">
                  Start a round
                </Link>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {rounds.slice(0, 6).map((r) => {
                const me = r.players[0];
                const total = me
                  ? r.scores.filter((s) => s.playerId === me.id && s.strokes != null).reduce((a, s) => a + (s.strokes ?? 0), 0)
                  : 0;
                const holesPlayed = me ? r.scores.filter((s) => s.playerId === me.id && s.strokes != null).length : 0;
                return (
                  <Link key={r.id} href={`/round/${r.id}`} className="flex items-center gap-4 py-3 hair-bot">
                    <div className="shrink-0 text-center" style={{ width: 54 }}>
                      <div className="display text-[26px] leading-none">{total || '—'}</div>
                      <div className="mono text-[10px] mt-1" style={{ color: 'var(--pencil)' }}>
                        {holesPlayed || 0} HOLES
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="serif text-[18px] truncate">{r.courseName}</div>
                      <div className="mono text-[11px]" style={{ color: 'var(--pencil)' }}>
                        {formatDate(r.date)} · {r.players.map((p) => p.name).join(' · ')}
                      </div>
                    </div>
                    <div>
                      <span className={`pill ${r.status === 'active' ? 'pill-accent' : ''}`} style={{ fontSize: 10 }}>
                        {r.status === 'active' ? 'LIVE' : 'DONE'}
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        {/* Footer mark */}
        <div className="mt-10 flex items-center justify-center gap-2">
          <span className="eyebrow">Looper</span>
          <span className="flag-dot" style={{ background: 'var(--accent)' }} />
          <span className="eyebrow">Yardage Book edition</span>
        </div>
      </main>

      {/* Tee time sheet */}
      <AnimatePresence>{teeTimesOpen && <TeeTimeSheet onClose={() => setTeeTimesOpen(false)} />}</AnimatePresence>
    </PaperShell>
  );
}

function TeeTimeSheet({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [players, setPlayers] = useState(2);
  const [results, setResults] = useState<TeeTime[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    const run = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/tee-times?q=${encodeURIComponent(query)}&date=${date}&players=${players}`);
        const json = await res.json();
        if (active) setResults(json.results ?? []);
      } finally {
        if (active) setLoading(false);
      }
    };
    const t = setTimeout(run, 160);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [query, date, players]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-40 flex items-end md:items-center justify-center"
      style={{ background: 'rgba(26,42,26,0.35)' }}
      onClick={onClose}
    >
      <motion.div
        onClick={(e) => e.stopPropagation()}
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 280, damping: 30 }}
        className="w-full md:max-w-xl md:rounded-[22px] rounded-t-[22px] overflow-hidden"
        style={{ background: 'var(--paper)', border: '1px solid var(--hairline)', maxHeight: '88vh' }}
      >
        <div className="px-5 pt-5 pb-4 hair-bot">
          <div className="flex items-center justify-between">
            <div>
              <div className="eyebrow">Tee times</div>
              <div className="serif text-[22px] leading-tight">Find a slot near you</div>
            </div>
            <button onClick={onClose} className="btn-icon" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="flex-1 min-w-[180px] relative">
              <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--pencil)' }} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Course or city"
                className="input-paper pl-9 py-2.5 text-sm"
              />
            </div>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="input-paper py-2.5 text-sm"
              style={{ width: 150 }}
            />
            <div className="inline-flex rounded-full overflow-hidden" style={{ border: '1px solid var(--hairline)' }}>
              {[1, 2, 3, 4].map((n) => (
                <button
                  key={n}
                  onClick={() => setPlayers(n)}
                  className="mono text-[12px] px-3 py-2"
                  style={{
                    background: players === n ? 'var(--ink)' : 'transparent',
                    color: players === n ? 'var(--paper)' : 'var(--ink)',
                  }}
                >
                  {n}P
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="overflow-y-auto px-5 py-3" style={{ maxHeight: '62vh' }}>
          {loading && <div className="eyebrow py-4 text-center">Searching…</div>}
          {!loading && results.length === 0 && (
            <div className="py-8 text-center">
              <div className="serif-italic text-[20px]" style={{ color: 'var(--pencil)' }}>
                No slots for these filters.
              </div>
            </div>
          )}
          <div className="space-y-0.5">
            {results.map((t) => (
              <div key={t.id} className="flex items-center gap-4 py-3 hair-bot">
                <div className="shrink-0 text-center" style={{ width: 62 }}>
                  <div className="serif text-[20px] leading-none">{t.time}</div>
                  <div className="mono text-[10px] mt-1" style={{ color: 'var(--pencil)' }}>
                    {t.distanceMiles} MI
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="serif text-[16px] truncate">{t.courseName}</div>
                  <div className="mono text-[11px] truncate" style={{ color: 'var(--pencil)' }}>
                    {t.city.toUpperCase()} · ★ {t.rating.toFixed(1)}
                    {t.cartIncluded ? ' · CART' : ''}
                  </div>
                </div>
                <div className="text-right">
                  <div className="serif text-[18px]">${t.priceUsd}</div>
                  <button className="mono text-[10px] px-2 py-1 rounded-full mt-1" style={{ background: 'var(--accent)', color: 'var(--paper)' }}>
                    BOOK
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="py-4 text-center">
            <span className="eyebrow">Mock data · demo booking</span>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
