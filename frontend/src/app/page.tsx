'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, Mic, Search, X } from 'lucide-react';
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

function formatRoundDate(iso: string) {
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
    const strokes = r.scores
      .filter((s) => s.playerId === me.id && s.strokes != null)
      .reduce((a, s) => a + (s.strokes ?? 0), 0);
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
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase();
  const activeRound = rounds.find((r) => r.status === 'active');
  const latestTournament = tournaments[0];

  if (!loaded) {
    return (
      <PaperShell>
        <div className="min-h-screen flex items-center justify-center">
          <span className="eyebrow">Loading…</span>
        </div>
      </PaperShell>
    );
  }

  const firstName = profile?.name?.split(' ')[0] ?? 'Golfer';

  return (
    <PaperShell>
      {/* Top band — volume masthead */}
      <div className="px-6 pt-5 pb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <VoiceOrb size={14} active={false} />
          <span className="mono text-[10px] tracking-[0.24em]" style={{ color: 'var(--pencil)' }}>
            LOOPER · VOL I
          </span>
        </div>
        <div className="flex items-center gap-1">
          <AuthButtons />
          <Link href="/profile" className="mono text-[10px] tracking-[0.22em] px-2 py-1" style={{ color: 'var(--ink)' }}>
            PROFILE
          </Link>
        </div>
      </div>

      {/* Editorial masthead */}
      <header className="px-6 pt-2 pb-6 hair-bot">
        <div className="max-w-xl mx-auto">
          <div className="mono text-[10px] tracking-[0.22em]" style={{ color: 'var(--pencil)' }}>
            {today}
          </div>
          <h1 className="mt-3 display leading-[0.92]" style={{ fontSize: 'clamp(48px, 11vw, 72px)' }}>
            {greeting},<br />
            <span className="serif-italic" style={{ color: 'var(--accent)' }}>
              {firstName}.
            </span>
          </h1>
          <p className="mt-3 text-[14px] serif-italic" style={{ color: 'var(--pencil)' }}>
            Gentle breeze, 62°. Fairways are soft — ball won&rsquo;t run out.
          </p>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-6 pb-24">
        {/* Primary CTA — fully on-paper, big serif quote */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24 }}
          className="pt-6 pb-6 hair-bot"
        >
          <div className="flex items-start gap-3">
            <div className="shrink-0 mt-2">
              <VoiceOrb size={20} active />
            </div>
            <div className="flex-1 min-w-0">
              <div className="eyebrow">Hey caddy</div>
              <div
                className="serif-italic mt-1 leading-[1.05]"
                style={{ fontSize: 'clamp(26px, 5.4vw, 34px)' }}
              >
                &ldquo;Start a round at Harding, whites,<br className="hidden sm:block" />
                me and Jack.&rdquo;
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link href="/round/new" className="btn-ink text-[13px] px-4 py-2">
                  <Mic className="h-3.5 w-3.5" /> Start a round
                </Link>
                <Link href="/tournament/new" className="btn-paper text-[13px] px-4 py-2">
                  Plan a tournament
                </Link>
                <button
                  onClick={() => setTeeTimesOpen(true)}
                  className="btn-paper text-[13px] px-4 py-2"
                >
                  <Search className="h-3.5 w-3.5" /> Tee times
                </button>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Resume active round */}
        {activeRound && (
          <Link
            href={`/round/${activeRound.id}`}
            className="pt-5 pb-5 hair-bot flex items-center gap-4 group"
          >
            <div className="shrink-0 text-center" style={{ width: 56 }}>
              <div className="mono text-[10px] tracking-[0.22em]" style={{ color: 'var(--accent)' }}>
                LIVE
              </div>
              <div className="display text-[24px] leading-none mt-1">
                {activeRound.scores.filter((s) => s.strokes != null).length || 0}
              </div>
              <div className="mono text-[9px] mt-1" style={{ color: 'var(--pencil)' }}>
                SCORES
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="eyebrow">Resume</div>
              <div className="serif text-[22px] leading-tight truncate">{activeRound.courseName}</div>
              <div className="mono text-[10px]" style={{ color: 'var(--pencil)' }}>
                {activeRound.players.map((p) => p.name).join(' · ').toUpperCase()}
              </div>
            </div>
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        )}

        {/* Hero stats — editorial two-up */}
        <section className="pt-6 pb-6 hair-bot grid grid-cols-2 gap-6">
          <Stat label="Handicap" value={profile?.handicap ?? '—'} sub="idx · last 20" />
          <Stat label="Scoring avg" value={avg ?? '—'} sub={`${rounds.filter((r) => r.status === 'completed').length} rounds`} />
        </section>

        {/* Tee time finder — minimal row, not a card */}
        <button
          type="button"
          onClick={() => setTeeTimesOpen(true)}
          className="w-full pt-5 pb-5 hair-bot text-left flex items-center gap-4 group"
        >
          <div className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center" style={{ background: 'var(--paper-deep)' }}>
            <Search className="h-4 w-4" />
          </div>
          <div className="flex-1">
            <div className="eyebrow">Tee times near you</div>
            <div className="serif text-[20px] leading-tight mt-0.5">Find a slot — this weekend</div>
          </div>
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </button>

        {/* Trophy case — only if a tournament exists */}
        {latestTournament && (
          <Link
            href={`/tournament/${latestTournament.id}`}
            className="pt-5 pb-5 hair-bot flex items-center gap-4 group"
          >
            <div className="shrink-0 display text-[42px] leading-none" style={{ color: 'var(--accent)', width: 56 }}>
              {toRoman(tournaments.length) || 'I'}
            </div>
            <div className="flex-1 min-w-0">
              <div className="eyebrow">Trophy case</div>
              <div className="serif text-[20px] leading-tight truncate">{latestTournament.name}</div>
              <div className="mono text-[10px]" style={{ color: 'var(--pencil)' }}>
                {latestTournament.playerIds.length} PLAYERS · {latestTournament.roundIds.length}
                {latestTournament.numRounds ? `/${latestTournament.numRounds}` : ''} ROUNDS
              </div>
            </div>
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        )}

        {/* Recent rounds */}
        <section className="pt-6">
          <div className="flex items-end justify-between mb-1">
            <div className="eyebrow">Recent rounds</div>
            <Link href="/round/new" className="mono text-[10px] tracking-[0.22em]" style={{ color: 'var(--accent)' }}>
              + NEW
            </Link>
          </div>

          {rounds.length === 0 ? (
            <div className="py-10 text-center">
              <div className="serif-italic text-[22px]" style={{ color: 'var(--pencil)' }}>
                Your first round is waiting.
              </div>
              <Link href="/round/new" className="btn-ink mt-4 inline-flex">
                Start a round
              </Link>
            </div>
          ) : (
            <div>
              {rounds.slice(0, 8).map((r) => {
                const me = r.players[0];
                const total = me
                  ? r.scores
                      .filter((s) => s.playerId === me.id && s.strokes != null)
                      .reduce((a, s) => a + (s.strokes ?? 0), 0)
                  : 0;
                const holesPlayed = me
                  ? r.scores.filter((s) => s.playerId === me.id && s.strokes != null).length
                  : 0;
                const par = r.holes.slice(0, holesPlayed).reduce((s, h) => s + h.par, 0);
                const toPar = total && par ? total - par : 0;
                return (
                  <Link key={r.id} href={`/round/${r.id}`} className="flex items-center gap-4 py-4 hair-bot group">
                    <div className="shrink-0 text-right" style={{ width: 60 }}>
                      <div className="display text-[28px] leading-none">{total || '—'}</div>
                      <div
                        className="mono text-[10px] mt-1"
                        style={{ color: toPar < 0 ? 'var(--accent)' : 'var(--pencil)' }}
                      >
                        {total ? (toPar === 0 ? 'E' : toPar > 0 ? `+${toPar}` : toPar) : ''}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="serif text-[17px] truncate">{r.courseName}</div>
                      <div className="mono text-[10px]" style={{ color: 'var(--pencil)' }}>
                        {formatRoundDate(r.date).toUpperCase()} · {r.players.map((p) => p.name).join(' · ').toUpperCase()}
                      </div>
                    </div>
                    <div className="shrink-0">
                      {r.status === 'active' ? (
                        <span className="mono text-[9px] tracking-[0.22em]" style={{ color: 'var(--accent)' }}>
                          LIVE
                        </span>
                      ) : (
                        <span className="mono text-[9px] tracking-[0.22em]" style={{ color: 'var(--pencil)' }}>
                          SIGNED
                        </span>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        {/* Colophon */}
        <div className="mt-10 mb-2 text-center">
          <div className="mono text-[9px] tracking-[0.28em]" style={{ color: 'var(--pencil)' }}>
            LOOPER · THE YARDAGE BOOK
          </div>
          <div className="serif-italic text-[13px] mt-1" style={{ color: 'var(--pencil)' }}>
            made for quiet rounds
          </div>
        </div>
      </main>

      <AnimatePresence>{teeTimesOpen && <TeeTimeSheet onClose={() => setTeeTimesOpen(false)} />}</AnimatePresence>
    </PaperShell>
  );
}

function Stat({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div>
      <div className="eyebrow">{label}</div>
      <div className="display text-[56px] leading-none mt-2">{value}</div>
      {sub && (
        <div className="mono text-[10px] mt-2" style={{ color: 'var(--pencil)' }}>
          {sub.toUpperCase()}
        </div>
      )}
    </div>
  );
}

function toRoman(n: number): string {
  if (!n || n < 1) return '';
  const map: Array<[number, string]> = [
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  let x = n;
  for (const [v, s] of map) {
    while (x >= v) {
      out += s;
      x -= v;
    }
  }
  return out;
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
      style={{ background: 'rgba(26,42,26,0.32)' }}
      onClick={onClose}
    >
      <motion.div
        onClick={(e) => e.stopPropagation()}
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 280, damping: 30 }}
        className="w-full md:max-w-xl md:rounded-[24px] rounded-t-[24px] overflow-hidden"
        style={{ background: 'var(--paper)', border: '1px solid var(--hairline)', maxHeight: '88vh' }}
      >
        {/* Grabber */}
        <div className="flex items-center justify-center pt-3 pb-1">
          <span style={{ width: 44, height: 4, borderRadius: 999, background: 'var(--hairline-strong)' }} />
        </div>

        <div className="px-6 pt-2 pb-4 hair-bot">
          <div className="flex items-center justify-between">
            <div>
              <div className="eyebrow">Tee times</div>
              <div className="serif-italic text-[28px] leading-tight">Find a slot.</div>
            </div>
            <button onClick={onClose} className="btn-icon" aria-label="Close">
              <X className="h-4 w-4" />
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
                  className="mono text-[11px] px-3 py-2"
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

        <div className="overflow-y-auto px-6 py-2" style={{ maxHeight: '62vh' }}>
          {loading && <div className="eyebrow py-6 text-center">Searching…</div>}
          {!loading && results.length === 0 && (
            <div className="py-10 text-center">
              <div className="serif-italic text-[20px]" style={{ color: 'var(--pencil)' }}>
                No slots for these filters.
              </div>
            </div>
          )}
          {results.map((t) => (
            <div key={t.id} className="flex items-center gap-4 py-4 hair-bot">
              <div className="shrink-0 text-center" style={{ width: 64 }}>
                <div className="serif text-[22px] leading-none">{t.time}</div>
                <div className="mono text-[10px] mt-1" style={{ color: 'var(--pencil)' }}>
                  {t.distanceMiles} MI
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="serif text-[16px] truncate">{t.courseName}</div>
                <div className="mono text-[10px] truncate" style={{ color: 'var(--pencil)' }}>
                  {t.city.toUpperCase()} · ★ {t.rating.toFixed(1)}
                  {t.cartIncluded ? ' · CART' : ''}
                </div>
              </div>
              <div className="text-right">
                <div className="serif text-[18px]">${t.priceUsd}</div>
                <button
                  className="mono text-[10px] tracking-[0.22em] px-2 py-1 rounded-full mt-1"
                  style={{ background: 'var(--accent)', color: 'var(--paper)' }}
                >
                  BOOK
                </button>
              </div>
            </div>
          ))}
          <div className="py-5 text-center">
            <span className="mono text-[9px] tracking-[0.28em]" style={{ color: 'var(--pencil)' }}>
              MOCK DATA · DEMO BOOKING
            </span>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
