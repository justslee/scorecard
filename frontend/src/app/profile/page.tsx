'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ChevronRight, Users } from 'lucide-react';
import { GolferProfile, Round } from '@/lib/types';
import { getGolferProfile, getRounds, saveGolferProfile } from '@/lib/storage';
import PaperShell from '@/components/yardage/PaperShell';

type ClubKey = keyof GolferProfile['clubDistances'];

const CLUBS: { key: ClubKey; label: string }[] = [
  { key: 'driver', label: 'Driver' },
  { key: 'threeWood', label: '3-wood' },
  { key: 'fiveWood', label: '5-wood' },
  { key: 'hybrid', label: 'Hybrid' },
  { key: 'fourIron', label: '4-iron' },
  { key: 'fiveIron', label: '5-iron' },
  { key: 'sixIron', label: '6-iron' },
  { key: 'sevenIron', label: '7-iron' },
  { key: 'eightIron', label: '8-iron' },
  { key: 'nineIron', label: '9-iron' },
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
  const [rounds, setRounds] = useState<Round[]>([]);

  useEffect(() => {
    const fromStorage = getGolferProfile();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (fromStorage) setProfile(fromStorage);
    setRounds(getRounds());
  }, []);

  const stats = useMemo(() => {
    const completed = rounds.filter((r) => r.status === 'completed');
    if (!completed.length) return { avg: null as number | null, rounds: 0, best: null as number | null, birdies: 0, pars: 0, bogeys: 0 };
    let total = 0;
    let count = 0;
    let best: number | null = null;
    let birdies = 0;
    let pars = 0;
    let bogeys = 0;
    for (const r of completed) {
      const me = r.players[0];
      if (!me) continue;
      const myScores = r.scores.filter((s) => s.playerId === me.id && s.strokes != null);
      const strokes = myScores.reduce((a, s) => a + (s.strokes ?? 0), 0);
      if (strokes > 0) {
        total += strokes;
        count += 1;
        if (best === null || strokes < best) best = strokes;
      }
      for (const sc of myScores) {
        const hole = r.holes.find((h) => h.number === sc.holeNumber);
        if (!hole) continue;
        const diff = (sc.strokes ?? 0) - hole.par;
        if (diff <= -1) birdies += 1;
        else if (diff === 0) pars += 1;
        else if (diff === 1) bogeys += 1;
      }
    }
    return {
      avg: count ? Math.round((total / count) * 10) / 10 : null,
      rounds: count,
      best,
      birdies,
      pars,
      bogeys,
    };
  }, [rounds]);

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

  const initials = profile.name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('') || 'G';

  return (
    <PaperShell>
      {/* Top chrome */}
      <header
        className="sticky top-0 z-20 hair-bot"
        style={{ background: 'color-mix(in oklab, var(--paper) 88%, transparent)', backdropFilter: 'blur(10px)' }}
      >
        <div className="max-w-xl mx-auto px-6 py-3 flex items-center gap-2">
          <Link href="/" className="btn-icon" aria-label="Back">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="flex-1 min-w-0 text-center mono text-[10px] tracking-[0.24em]" style={{ color: 'var(--pencil)' }}>
            PLAYER PROFILE
          </div>
          <button onClick={handleSave} className="btn-ink px-4 py-1.5 text-[12px]">
            {saved ? 'Saved' : 'Save'}
          </button>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-6 pt-6 pb-24">
        {/* Identity masthead — editorial */}
        <section className="hair-bot pb-6">
          <div className="mono text-[10px] tracking-[0.24em]" style={{ color: 'var(--pencil)' }}>
            MEMBER · EST. {new Date().getFullYear()}
          </div>
          <div className="flex items-start gap-4 mt-3">
            <div
              className="shrink-0 w-[72px] h-[72px] rounded-full flex items-center justify-center"
              style={{ background: 'var(--ink)', color: 'var(--paper)' }}
            >
              <span className="serif text-[30px]">{initials}</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="display leading-[0.95]" style={{ fontSize: 'clamp(40px, 9vw, 52px)' }}>
                {profile.name || (
                  <span className="serif-italic" style={{ color: 'var(--pencil)' }}>
                    Unnamed golfer
                  </span>
                )}
              </div>
              {profile.homeCourse && (
                <div className="mono text-[10px] tracking-[0.22em] mt-2" style={{ color: 'var(--pencil)' }}>
                  HOME · {profile.homeCourse.toUpperCase()}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Stats strip — editorial three-up */}
        <section className="pt-6 pb-6 hair-bot grid grid-cols-3 gap-6">
          <StatCell label="Handicap" value={profile.handicap ?? '—'} sub="idx" />
          <StatCell label="Scoring avg" value={stats.avg ?? '—'} sub={stats.rounds ? `${stats.rounds} rounds` : ''} />
          <StatCell label="Best round" value={stats.best ?? '—'} sub="strokes" />
        </section>

        {/* Career tally */}
        <section className="pt-6 pb-6 hair-bot">
          <div className="mono text-[10px] tracking-[0.24em] mb-3" style={{ color: 'var(--pencil)' }}>
            CAREER TALLY
          </div>
          <div className="flex items-end justify-between gap-4">
            <TallyBar label="Birdies" count={stats.birdies} color="var(--accent)" />
            <TallyBar label="Pars" count={stats.pars} color="var(--ink)" />
            <TallyBar label="Bogeys" count={stats.bogeys} color="var(--flag-back)" />
          </div>
        </section>

        {/* Info inputs */}
        <section className="pt-6 pb-6 hair-bot">
          <div className="mono text-[10px] tracking-[0.24em] mb-3" style={{ color: 'var(--pencil)' }}>
            GOLFER INFO
          </div>
          <div className="space-y-3">
            <LabeledInput
              label="Name"
              value={profile.name}
              onChange={(v) => setProfile((p) => ({ ...p, name: v }))}
              placeholder="Your name"
            />
            <LabeledInput
              label="Handicap index"
              value={profile.handicap == null ? '' : String(profile.handicap)}
              onChange={(v) => setProfile((p) => ({ ...p, handicap: parseOptionalNumber(v) }))}
              placeholder="e.g. 12.4"
              inputMode="decimal"
            />
            <LabeledInput
              label="Home course"
              value={profile.homeCourse ?? ''}
              onChange={(v) => setProfile((p) => ({ ...p, homeCourse: v }))}
              placeholder="e.g. Harding Park"
            />
          </div>
        </section>

        {/* Club distances — The bag */}
        <section className="pt-6 pb-6 hair-bot">
          <div className="flex items-end justify-between mb-3">
            <div>
              <div className="mono text-[10px] tracking-[0.24em]" style={{ color: 'var(--pencil)' }}>
                CLUB DISTANCES
              </div>
              <div className="display text-[32px] leading-tight mt-1">The bag</div>
            </div>
            <div className="mono text-[10px] tracking-[0.22em]" style={{ color: 'var(--pencil)' }}>
              YARDS · OPTIONAL
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {CLUBS.map((c) => {
              const v = profile.clubDistances[c.key];
              return (
                <div
                  key={c.key}
                  className="rounded-xl p-3 text-center"
                  style={{ background: 'var(--paper-deep)', border: '1px solid var(--hairline)' }}
                >
                  <div className="mono text-[9px] tracking-[0.22em]" style={{ color: 'var(--pencil)' }}>
                    {c.label.toUpperCase()}
                  </div>
                  <input
                    inputMode="numeric"
                    value={v ?? ''}
                    onChange={(e) => {
                      const n = parseOptionalNumber(e.target.value);
                      setProfile((p) => ({
                        ...p,
                        clubDistances: { ...p.clubDistances, [c.key]: n === null ? undefined : n },
                      }));
                    }}
                    placeholder="—"
                    className="w-full text-center display text-[26px] bg-transparent outline-none mt-0.5"
                  />
                  <div className="mono text-[9px]" style={{ color: 'var(--pencil)' }}>
                    YDS
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Shortcuts */}
        <section className="pt-4">
          <Link href="/players" className="flex items-center gap-4 py-4 hair-bot group">
            <div
              className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center"
              style={{ background: 'var(--paper-deep)' }}
            >
              <Users className="h-4 w-4" />
            </div>
            <div className="flex-1">
              <div className="serif text-[17px] leading-tight">My players</div>
              <div className="mono text-[10px] tracking-[0.22em]" style={{ color: 'var(--pencil)' }}>
                GOLF BUDDIES · GROUP HISTORY
              </div>
            </div>
            <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" style={{ color: 'var(--pencil)' }} />
          </Link>

          <Link href="/settings" className="flex items-center gap-4 py-4 hair-bot group">
            <div className="flex-1">
              <div className="serif text-[17px] leading-tight">Settings</div>
              <div className="mono text-[10px] tracking-[0.22em]" style={{ color: 'var(--pencil)' }}>
                API KEYS · INTEGRATIONS
              </div>
            </div>
            <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" style={{ color: 'var(--pencil)' }} />
          </Link>
        </section>

        <div className="mt-10 mb-4">
          <button onClick={handleSave} className="btn-ink w-full py-3.5">
            <span className="serif-italic text-[16px]">{saved ? 'Saved' : 'Save profile'}</span>
          </button>
        </div>

        <div className="mono text-[9px] tracking-[0.28em] text-center" style={{ color: 'var(--pencil)' }}>
          STORED LOCALLY · ON THIS DEVICE
        </div>
      </main>
    </PaperShell>
  );
}

function StatCell({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div>
      <div className="mono text-[10px] tracking-[0.22em]" style={{ color: 'var(--pencil)' }}>
        {label.toUpperCase()}
      </div>
      <div className="display mt-2 leading-none" style={{ fontSize: 'clamp(36px, 8vw, 48px)' }}>
        {value}
      </div>
      {sub && (
        <div className="mono text-[9px] tracking-[0.22em] mt-2" style={{ color: 'var(--pencil)' }}>
          {sub.toUpperCase()}
        </div>
      )}
    </div>
  );
}

function TallyBar({ label, count, color }: { label: string; count: number; color: string }) {
  const height = Math.min(72, Math.max(6, count * 2));
  return (
    <div className="flex-1 flex flex-col items-center gap-2">
      <div className="display text-[26px] leading-none" style={{ color }}>
        {count}
      </div>
      <div style={{ width: '100%', height, background: color, borderRadius: 3, opacity: 0.85 }} />
      <div className="mono text-[9px] tracking-[0.22em]" style={{ color: 'var(--pencil)' }}>
        {label.toUpperCase()}
      </div>
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  inputMode?: 'text' | 'decimal' | 'numeric';
}) {
  return (
    <div>
      <label className="mono text-[10px] tracking-[0.22em] block mb-1.5" style={{ color: 'var(--pencil)' }}>
        {label.toUpperCase()}
      </label>
      <input
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="input-paper"
      />
    </div>
  );
}
