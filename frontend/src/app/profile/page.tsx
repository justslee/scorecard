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
      <header className="sticky top-0 z-20 hair-bot" style={{ background: 'color-mix(in oklab, var(--paper) 88%, transparent)', backdropFilter: 'blur(10px)' }}>
        <div className="max-w-xl mx-auto px-4 py-3 flex items-center gap-2">
          <Link href="/" className="btn-icon" aria-label="Back">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="flex-1 min-w-0 text-center eyebrow">Player profile</div>
          <button onClick={handleSave} className="btn-ink px-4 py-1.5 text-xs">
            {saved ? 'Saved' : 'Save'}
          </button>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-5 pt-6 pb-24">
        {/* Identity masthead */}
        <section className="flex items-start gap-4">
          <div className="shrink-0 w-16 h-16 rounded-full flex items-center justify-center serif text-[28px]" style={{ background: 'var(--ink)', color: 'var(--paper)' }}>
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="eyebrow">Member</div>
            <div className="display text-[36px] leading-[1]">
              {profile.name ? (
                <span>{profile.name}</span>
              ) : (
                <span className="serif-italic" style={{ color: 'var(--pencil)' }}>
                  Unnamed golfer
                </span>
              )}
            </div>
            {profile.homeCourse && (
              <div className="mono text-[11px] mt-1" style={{ color: 'var(--pencil)' }}>
                HOME · {profile.homeCourse.toUpperCase()}
              </div>
            )}
          </div>
        </section>

        {/* Stats strip */}
        <section className="mt-6 grid grid-cols-3 gap-2">
          <StatCell eyebrow="Handicap" value={profile.handicap ?? '—'} sub="idx" />
          <StatCell eyebrow="Scoring avg" value={stats.avg ?? '—'} sub={stats.rounds ? `${stats.rounds} rounds` : ''} />
          <StatCell eyebrow="Best round" value={stats.best ?? '—'} sub="strokes" />
        </section>

        {/* Hole by hole tally */}
        <section className="mt-4 sheet p-4">
          <div className="eyebrow mb-3">Career tally</div>
          <div className="flex items-end justify-between gap-3">
            <TallyBar label="Birdies" count={stats.birdies} color="var(--accent)" />
            <TallyBar label="Pars" count={stats.pars} color="var(--ink)" />
            <TallyBar label="Bogeys" count={stats.bogeys} color="var(--flag-back)" />
          </div>
        </section>

        {/* Info inputs */}
        <section className="mt-6 sheet p-5">
          <div className="eyebrow mb-4">Golfer info</div>

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

        {/* Club distances — the yardage book itself */}
        <section className="mt-4 sheet p-5">
          <div className="flex items-end justify-between mb-3">
            <div>
              <div className="eyebrow">Club distances</div>
              <div className="serif text-[20px] leading-tight mt-0.5">The bag</div>
            </div>
            <div className="mono text-[10px]" style={{ color: 'var(--pencil)' }}>
              YARDS · OPTIONAL
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {CLUBS.map((c) => {
              const v = profile.clubDistances[c.key];
              return (
                <div key={c.key} className="rounded-xl p-3 text-center" style={{ background: 'var(--paper-deep)', border: '1px solid var(--hairline)' }}>
                  <div className="eyebrow">{c.label}</div>
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
                    className="w-full text-center display text-[22px] bg-transparent outline-none"
                  />
                  <div className="mono text-[10px]" style={{ color: 'var(--pencil)' }}>
                    YDS
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Players + shortcuts */}
        <section className="mt-4 space-y-0.5">
          <Link href="/players" className="sheet block p-4 flex items-center gap-3">
            <div className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center" style={{ background: 'var(--paper-deep)' }}>
              <Users className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <div className="serif text-[17px]">My players</div>
              <div className="mono text-[11px]" style={{ color: 'var(--pencil)' }}>
                GOLF BUDDIES · GROUP HISTORY
              </div>
            </div>
            <ChevronRight className="h-4 w-4" style={{ color: 'var(--pencil)' }} />
          </Link>

          <Link href="/settings" className="sheet block p-4 flex items-center gap-3">
            <div className="flex-1">
              <div className="serif text-[17px]">Settings</div>
              <div className="mono text-[11px]" style={{ color: 'var(--pencil)' }}>
                API KEYS · INTEGRATIONS
              </div>
            </div>
            <ChevronRight className="h-4 w-4" style={{ color: 'var(--pencil)' }} />
          </Link>
        </section>

        <div className="mt-8 mb-4">
          <button onClick={handleSave} className="btn-ink w-full">
            {saved ? 'Saved ✓' : 'Save profile'}
          </button>
        </div>

        <div className="mono text-[10px] text-center" style={{ color: 'var(--pencil)' }}>
          STORED LOCALLY IN YOUR BROWSER
        </div>
      </main>
    </PaperShell>
  );
}

function StatCell({ eyebrow, value, sub }: { eyebrow: string; value: number | string; sub?: string }) {
  return (
    <div className="sheet p-3 text-center">
      <div className="eyebrow">{eyebrow}</div>
      <div className="display text-[30px] mt-1 leading-none">{value}</div>
      {sub && (
        <div className="mono text-[10px] mt-1" style={{ color: 'var(--pencil)' }}>
          {sub.toUpperCase()}
        </div>
      )}
    </div>
  );
}

function TallyBar({ label, count, color }: { label: string; count: number; color: string }) {
  const height = Math.min(60, Math.max(8, count * 2));
  return (
    <div className="flex-1 flex flex-col items-center gap-1.5">
      <div className="display text-[22px]" style={{ color }}>
        {count}
      </div>
      <div style={{ width: '100%', height, background: color, borderRadius: 4, opacity: 0.8 }} />
      <div className="eyebrow">{label}</div>
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
      <label className="eyebrow block mb-1.5">{label}</label>
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
