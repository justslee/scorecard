'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, ChevronRight, Mic, Plus, X } from 'lucide-react';
import {
  Course,
  Player,
  Round,
  SavedPlayer,
  TeeOption,
  createDefaultCourse,
} from '@/lib/types';
import { getCourses, saveCourse, saveRound, getSavedPlayers } from '@/lib/storage';
import PaperShell from '@/components/yardage/PaperShell';
import VoiceOrb, { Waveform } from '@/components/yardage/VoiceOrb';

type GameOption = {
  id: 'stroke' | 'match' | 'skins' | 'nassau' | 'stableford' | 'wolf' | 'bestBall' | 'none';
  label: string;
  subtitle: string;
  tag?: string;
};

const GAMES: GameOption[] = [
  { id: 'stroke', label: 'Stroke play', subtitle: 'Lowest total wins.', tag: 'Solo OK' },
  { id: 'match', label: 'Match play', subtitle: 'Hole-by-hole, head to head.', tag: '1v1' },
  { id: 'skins', label: 'Skins', subtitle: 'Win a hole outright, take the pot.', tag: '$ per hole' },
  { id: 'nassau', label: 'Nassau', subtitle: 'Three bets — front, back, 18.', tag: 'Classic' },
  { id: 'stableford', label: 'Stableford', subtitle: 'Points per hole. Birdies worth more.', tag: 'Solo OK' },
  { id: 'wolf', label: 'Wolf', subtitle: 'Tee-order rotation. Lone wolf bonus.', tag: '4P only' },
  { id: 'bestBall', label: 'Best ball', subtitle: 'Lowest per team on each hole.', tag: 'Teams' },
  { id: 'none', label: 'No stakes', subtitle: 'Just a quiet round. Bragging rights only.' },
];

type StakeOption = { value: number; label: string };
const STAKES: StakeOption[] = [
  { value: 2, label: '$2' },
  { value: 5, label: '$5' },
  { value: 10, label: '$10' },
  { value: 20, label: '$20' },
];

const SCRIPT_STEPS: Array<{ kind: 'you' | 'caddy'; text: string; wait: number }> = [
  { kind: 'you', text: 'Start a round at Harding — whites, me and Jack.', wait: 1400 },
  { kind: 'caddy', text: 'Whites at Harding, you and Jack. Any stakes today?', wait: 1200 },
  { kind: 'you', text: 'Skins, five dollars.', wait: 1200 },
  { kind: 'caddy', text: 'Got it. Skins at five. Anything else, or ready to tee off?', wait: 800 },
];

export default function NewRound() {
  const router = useRouter();

  const [courses, setCourses] = useState<Course[]>([]);
  const [savedPlayers, setSavedPlayers] = useState<SavedPlayer[]>([]);

  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [selectedTeeId, setSelectedTeeId] = useState<string>('');
  const [players, setPlayers] = useState<Player[]>([]);
  const [holes, setHoles] = useState<9 | 18>(18);
  const [transport, setTransport] = useState<'walk' | 'cart'>('cart');
  const [game, setGame] = useState<GameOption>(GAMES[0]);
  const [stake, setStake] = useState<number>(5);

  const [sheet, setSheet] = useState<null | 'course' | 'tee' | 'players' | 'game' | 'holes' | 'transport'>(null);

  // Conversation state — scripted auto-play
  const [turns, setTurns] = useState<Array<{ kind: 'you' | 'caddy'; text: string }>>([]);
  const [activeSpeaker, setActiveSpeaker] = useState<'you' | 'caddy' | null>(null);
  const [currentTyping, setCurrentTyping] = useState<string>('');

  useEffect(() => {
    setCourses(getCourses());
    setSavedPlayers(getSavedPlayers());
    // seed demo defaults if local state is empty
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPlayers([
      { id: crypto.randomUUID(), name: 'You' },
      { id: crypto.randomUUID(), name: 'Jack' },
    ]);
  }, []);

  // Scripted voice demo
  useEffect(() => {
    let cancelled = false;
    let i = 0;
    const run = async () => {
      while (!cancelled && i < SCRIPT_STEPS.length) {
        const step = SCRIPT_STEPS[i];
        setActiveSpeaker(step.kind);
        setCurrentTyping('');
        // type out
        for (let c = 1; c <= step.text.length; c++) {
          if (cancelled) return;
          setCurrentTyping(step.text.slice(0, c));
          await new Promise((r) => setTimeout(r, 22));
        }
        if (cancelled) return;
        setTurns((prev) => [...prev, { kind: step.kind, text: step.text }]);
        setCurrentTyping('');

        // apply the voice effect to state mid-script
        if (step.text.toLowerCase().includes('skins')) {
          setGame(GAMES.find((g) => g.id === 'skins')!);
          setStake(5);
        }
        if (step.text.toLowerCase().includes('harding')) {
          const match = courses.find((c) => c.name.toLowerCase().includes('harding'));
          if (match) {
            setSelectedCourse(match);
            if (match.tees?.length) setSelectedTeeId(match.tees[0].id);
          }
        }

        await new Promise((r) => setTimeout(r, step.wait));
        i++;
      }
      if (!cancelled) setActiveSpeaker(null);
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [courses]);

  const teeOptions: TeeOption[] = selectedCourse?.tees ?? [];
  const selectedTee = teeOptions.find((t) => t.id === selectedTeeId);

  const canTeeOff = Boolean(selectedCourse && players.filter((p) => p.name.trim()).length > 0);

  const handleTeeOff = () => {
    if (!selectedCourse) return;
    const validPlayers = players.filter((p) => p.name.trim());
    if (validPlayers.length === 0) return;

    const tee = selectedCourse.tees?.find((t) => t.id === selectedTeeId);
    const holesToUse = holes === 9 ? (tee?.holes ?? selectedCourse.holes).slice(0, 9) : tee?.holes ?? selectedCourse.holes;

    const round: Round = {
      id: crypto.randomUUID(),
      courseId: selectedCourse.id,
      courseName: selectedCourse.name,
      teeId: tee?.id,
      teeName: tee?.name,
      date: new Date().toISOString(),
      players: validPlayers.map((p) => ({ ...p, name: p.name.trim() })),
      scores: [],
      holes: holesToUse,
      games: [],
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    saveRound(round);
    router.push(`/round/${round.id}`);
  };

  return (
    <PaperShell>
      {/* Top chrome */}
      <div className="px-5 pt-5 pb-2 hair-bot flex items-center justify-between">
        <Link href="/" className="btn-icon" aria-label="Back">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="eyebrow">Round setup</div>
        <button
          className="btn-icon"
          aria-label="Mic"
          onClick={() => {
            setTurns([]);
            setActiveSpeaker(null);
          }}
        >
          <Mic className="h-4 w-4" />
        </button>
      </div>

      <main className="max-w-xl mx-auto px-5 pt-4 pb-32">
        {/* Conversation surface */}
        <section className="mb-5">
          <div className="eyebrow mb-2">Hey caddy</div>

          <div className="space-y-3">
            {turns.map((t, i) => (
              <TurnBubble key={i} kind={t.kind} text={t.text} />
            ))}
            {activeSpeaker && currentTyping && (
              <TurnBubble kind={activeSpeaker} text={currentTyping} typing />
            )}
          </div>

          {/* Quick replies */}
          {!activeSpeaker && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                className="pill"
                onClick={() => {
                  setTurns((t) => [...t, { kind: 'you', text: 'Make it ten dollars a skin.' }, { kind: 'caddy', text: 'Done — $10 a skin.' }]);
                  setStake(10);
                }}
              >
                Make it $10 a skin
              </button>
              <button
                className="pill"
                onClick={() => setTurns((t) => [...t, { kind: 'you', text: 'Add a Nassau.' }, { kind: 'caddy', text: 'Nassau on top of skins.' }])}
              >
                Add a Nassau
              </button>
              <button
                className="pill"
                onClick={() => setTurns((t) => [...t, { kind: 'you', text: 'Actually, no stakes today.' }, { kind: 'caddy', text: 'No stakes. Friendly round.' }])}
              >
                Actually, no stakes
              </button>
              <button className="pill pill-accent">
                <Mic className="h-3 w-3" /> Say something else
              </button>
            </div>
          )}
        </section>

        <div className="rule-editorial my-6" />

        {/* Picker rows */}
        <section>
          <div className="eyebrow mb-3">The plan</div>

          <div className="sheet">
            <PickerRow
              label="Course"
              value={selectedCourse?.name ?? 'Pick a course'}
              hint='"Harding Park" · "the muni"'
              onClick={() => setSheet('course')}
            />
            <PickerRow
              label="Tees"
              value={selectedTee?.name ? `${selectedTee.name} · ${teeTotalYards(selectedTee)}y` : '—'}
              hint='"off the whites"'
              onClick={() => setSheet('tee')}
              disabled={!selectedCourse || !teeOptions.length}
            />
            <PickerRow
              label="Players"
              value={
                players.filter((p) => p.name.trim()).map((p) => p.name).join(' · ') ||
                'Just you'
              }
              hint='"add Jack" · "me and Sam"'
              onClick={() => setSheet('players')}
            />
            <PickerRow
              label="Game"
              value={game.id === 'none' ? 'No stakes' : game.label + (game.id !== 'stroke' && stake ? ` · $${stake}` : '')}
              hint='"skins at five" · "match play"'
              onClick={() => setSheet('game')}
            />
            <PickerRow
              label="Holes"
              value={`${holes} holes`}
              hint='"play nine" · "front only"'
              onClick={() => setSheet('holes')}
            />
            <PickerRow
              label="Transport"
              value={transport === 'walk' ? 'Walking' : 'Cart'}
              hint='"we are walking"'
              onClick={() => setTransport(transport === 'walk' ? 'cart' : 'walk')}
              last
            />
          </div>
        </section>

        {/* Caddy pep talk */}
        {canTeeOff && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
            className="mt-6 sheet p-4"
            style={{ background: 'var(--paper-deep)' }}
          >
            <div className="eyebrow mb-1">Caddy · on the bag</div>
            <div className="serif-italic text-[22px] leading-tight">
              &ldquo;Trust the swing we warmed up with. First one&apos;s a handshake — don&apos;t overcook it.&rdquo;
            </div>
          </motion.div>
        )}
      </main>

      {/* Sticky tee off CTA */}
      <div
        className="fixed bottom-0 left-0 right-0 px-5 pt-3 pb-5 hair-top"
        style={{ background: 'color-mix(in oklab, var(--paper) 92%, transparent)', backdropFilter: 'blur(10px)' }}
      >
        <div className="max-w-xl mx-auto flex items-center gap-3">
          <div className="flex-1 mono text-[11px]" style={{ color: 'var(--pencil)' }}>
            {selectedCourse
              ? `${selectedCourse.name} · ${players.filter((p) => p.name.trim()).length} PLAYER${players.filter((p) => p.name.trim()).length === 1 ? '' : 'S'}`
              : 'Pick a course to tee off'}
          </div>
          <button
            onClick={handleTeeOff}
            disabled={!canTeeOff}
            className="btn-ink text-[15px] px-6 py-3"
            style={{ opacity: canTeeOff ? 1 : 0.5 }}
          >
            Tee off →
          </button>
        </div>
      </div>

      {/* Sheets */}
      <AnimatePresence>
        {sheet === 'course' && (
          <BottomSheet title="Pick a course" onClose={() => setSheet(null)}>
            <div className="space-y-0.5">
              {courses.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    setSelectedCourse(c);
                    if (c.tees?.length) setSelectedTeeId(c.tees[0].id);
                    setSheet(null);
                  }}
                  className="w-full text-left flex items-center py-3 hair-bot"
                >
                  <div className="flex-1">
                    <div className="serif text-[17px]">{c.name}</div>
                    <div className="mono text-[11px]" style={{ color: 'var(--pencil)' }}>
                      {c.holes.length} HOLES · PAR {c.holes.reduce((s, h) => s + h.par, 0)}
                      {c.location ? ` · ${c.location.toUpperCase()}` : ''}
                    </div>
                  </div>
                  <ChevronRight className="h-5 w-5" style={{ color: 'var(--pencil)' }} />
                </button>
              ))}
              <button
                onClick={() => {
                  const name = prompt('New course name?')?.trim();
                  if (!name) return;
                  const c = createDefaultCourse(name);
                  saveCourse(c);
                  setCourses((prev) => [...prev, c]);
                  setSelectedCourse(c);
                  if (c.tees?.length) setSelectedTeeId(c.tees[0].id);
                  setSheet(null);
                }}
                className="w-full text-left flex items-center py-3"
              >
                <Plus className="h-4 w-4 mr-2" style={{ color: 'var(--accent)' }} />
                <span className="serif text-[17px]" style={{ color: 'var(--accent)' }}>
                  New custom course
                </span>
              </button>
            </div>
          </BottomSheet>
        )}

        {sheet === 'tee' && teeOptions.length > 0 && (
          <BottomSheet title="Pick tees" onClose={() => setSheet(null)}>
            <div className="space-y-0.5">
              {teeOptions.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    setSelectedTeeId(t.id);
                    setSheet(null);
                  }}
                  className="w-full text-left flex items-center py-3 hair-bot"
                >
                  <span
                    className="flag-dot mr-3"
                    style={{ background: teeColor(t.name) }}
                  />
                  <div className="flex-1">
                    <div className="serif text-[17px]">{t.name}</div>
                    <div className="mono text-[11px]" style={{ color: 'var(--pencil)' }}>
                      {teeTotalYards(t)}Y{t.rating ? ` · RTG ${t.rating}` : ''}
                      {t.slope ? ` · SLP ${t.slope}` : ''}
                    </div>
                  </div>
                  {selectedTeeId === t.id && <span className="pill pill-accent">selected</span>}
                </button>
              ))}
            </div>
          </BottomSheet>
        )}

        {sheet === 'players' && (
          <BottomSheet title="Players" onClose={() => setSheet(null)}>
            <div className="space-y-2">
              {players.map((p, idx) => (
                <div key={p.id} className="flex items-center gap-2">
                  <input
                    value={p.name}
                    onChange={(e) => {
                      const next = [...players];
                      next[idx] = { ...p, name: e.target.value };
                      setPlayers(next);
                    }}
                    placeholder={`Player ${idx + 1}`}
                    className="input-paper"
                  />
                  {players.length > 1 && (
                    <button
                      onClick={() => setPlayers(players.filter((x) => x.id !== p.id))}
                      className="btn-icon"
                      aria-label="Remove"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}
              <button
                onClick={() => setPlayers([...players, { id: crypto.randomUUID(), name: '' }])}
                className="btn-ghost w-full"
                disabled={players.length >= 6}
              >
                <Plus className="h-4 w-4" /> Add player
              </button>

              {savedPlayers.length > 0 && (
                <div className="mt-4">
                  <div className="eyebrow mb-2">Your network</div>
                  <div className="flex flex-wrap gap-2">
                    {savedPlayers.slice(0, 8).map((sp) => (
                      <button
                        key={sp.id}
                        onClick={() => {
                          if (players.some((p) => p.id === sp.id)) return;
                          const emptyIdx = players.findIndex((p) => !p.name.trim());
                          const filled = { id: sp.id, name: sp.name, handicap: sp.handicap };
                          if (emptyIdx >= 0) {
                            const next = [...players];
                            next[emptyIdx] = filled;
                            setPlayers(next);
                          } else if (players.length < 6) {
                            setPlayers([...players, filled]);
                          }
                        }}
                        className="pill"
                      >
                        {sp.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </BottomSheet>
        )}

        {sheet === 'game' && (
          <BottomSheet title="Game" onClose={() => setSheet(null)}>
            <div className="space-y-0.5">
              {GAMES.map((g) => (
                <button
                  key={g.id}
                  onClick={() => {
                    setGame(g);
                    if (g.id === 'stroke' || g.id === 'none') setSheet(null);
                  }}
                  className="w-full text-left flex items-center gap-3 py-3 hair-bot"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <div className="serif text-[17px]">{g.label}</div>
                      {g.tag && (
                        <span className="mono text-[9px] px-1.5 py-0.5 rounded" style={{ background: 'var(--paper-deep)', color: 'var(--pencil)' }}>
                          {g.tag.toUpperCase()}
                        </span>
                      )}
                    </div>
                    <div className="text-[13px]" style={{ color: 'var(--pencil)' }}>
                      {g.subtitle}
                    </div>
                  </div>
                  {game.id === g.id && <span className="pill pill-accent">selected</span>}
                </button>
              ))}

              {game.id !== 'stroke' && game.id !== 'none' && (
                <div className="pt-3">
                  <div className="eyebrow mb-2">Stake</div>
                  <div className="flex gap-2 flex-wrap">
                    {STAKES.map((s) => (
                      <button
                        key={s.value}
                        onClick={() => setStake(s.value)}
                        className={`pill ${stake === s.value ? 'pill-accent' : ''}`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                  <div className="mt-4">
                    <button onClick={() => setSheet(null)} className="btn-ink w-full">
                      Lock it in
                    </button>
                  </div>
                </div>
              )}
            </div>
          </BottomSheet>
        )}

        {sheet === 'holes' && (
          <BottomSheet title="How many holes?" onClose={() => setSheet(null)}>
            <div className="flex gap-2">
              {[9, 18].map((n) => (
                <button
                  key={n}
                  onClick={() => {
                    setHoles(n as 9 | 18);
                    setSheet(null);
                  }}
                  className={`flex-1 py-6 rounded-xl ${holes === n ? 'btn-ink' : 'btn-paper'}`}
                >
                  <div className="display text-[32px]">{n}</div>
                  <div className="mono text-[10px] mt-1">HOLES</div>
                </button>
              ))}
            </div>
          </BottomSheet>
        )}
      </AnimatePresence>
    </PaperShell>
  );
}

function TurnBubble({ kind, text, typing }: { kind: 'you' | 'caddy'; text: string; typing?: boolean }) {
  const you = kind === 'you';
  return (
    <div className={`flex gap-3 ${you ? '' : 'items-start'}`}>
      <div className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center serif text-[14px]" style={{
        background: you ? 'var(--ink)' : 'var(--paper-deep)',
        color: you ? 'var(--paper)' : 'var(--ink)',
        border: you ? 'none' : '1px solid var(--hairline)',
      }}>
        {you ? 'Y' : 'C'}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="eyebrow">{you ? 'You' : 'Caddy · Fluff'}</span>
          {typing && <Waveform />}
        </div>
        <div className="serif-italic text-[20px] leading-snug" style={{ color: 'var(--ink)' }}>
          {text}
          {typing && <span style={{ color: 'var(--accent)' }}>│</span>}
        </div>
      </div>
    </div>
  );
}

function PickerRow({
  label,
  value,
  hint,
  onClick,
  disabled,
  last,
}: {
  label: string;
  value: string;
  hint?: string;
  onClick?: () => void;
  disabled?: boolean;
  last?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-full text-left flex items-center gap-4 px-4 py-3.5 ${last ? '' : 'hair-bot'} disabled:opacity-50`}
    >
      <div className="mono text-[10px] uppercase tracking-[0.2em] w-[76px] shrink-0" style={{ color: 'var(--pencil)' }}>
        {label}
      </div>
      <div className="flex-1 min-w-0">
        <div className="serif text-[17px] truncate">{value}</div>
        {hint && (
          <div className="serif-italic text-[12px] truncate" style={{ color: 'var(--pencil)' }}>
            {hint}
          </div>
        )}
      </div>
      <ChevronRight className="h-4 w-4" style={{ color: 'var(--pencil)' }} />
    </button>
  );
}

function BottomSheet({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-40 flex items-end md:items-center justify-center"
      style={{ background: 'rgba(26,42,26,0.3)' }}
      onClick={onClose}
    >
      <motion.div
        onClick={(e) => e.stopPropagation()}
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 280, damping: 30 }}
        className="w-full md:max-w-xl md:rounded-[22px] rounded-t-[22px]"
        style={{ background: 'var(--paper)', border: '1px solid var(--hairline)', maxHeight: '82vh' }}
      >
        <div className="flex items-center justify-between px-5 py-4 hair-bot">
          <div className="serif text-[20px]">{title}</div>
          <button onClick={onClose} className="btn-icon" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5 overflow-y-auto" style={{ maxHeight: '70vh' }}>
          {children}
        </div>
      </motion.div>
    </motion.div>
  );
}

function teeTotalYards(t: TeeOption) {
  if (t.totalYards) return t.totalYards;
  return t.holes.reduce((s, h) => s + (h.yards ?? 0), 0) || '—';
}

function teeColor(name: string) {
  const n = name.toLowerCase();
  if (n.includes('black') || n.includes('champ')) return '#1a2a1a';
  if (n.includes('blue') || n.includes('back')) return '#5d7285';
  if (n.includes('white') || n.includes('middle')) return '#ddd6c5';
  if (n.includes('gold') || n.includes('senior')) return '#8a6f2f';
  if (n.includes('red') || n.includes('forward')) return '#a8553f';
  return '#6b6558';
}
