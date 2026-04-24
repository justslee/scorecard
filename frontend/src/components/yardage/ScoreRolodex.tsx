'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useMotionValue, animate } from 'framer-motion';
import { X } from 'lucide-react';
import { Player, HoleInfo } from '@/lib/types';

type Props = {
  open: boolean;
  players: Player[];
  hole: HoleInfo;
  initialStrokes: Record<string, number | null>;
  onClose: () => void;
  onSubmit: (next: Record<string, number>) => void;
};

const DIGITS = Array.from({ length: 13 }, (_, i) => i + 1); // 1..13

export default function ScoreRolodex({ open, players, hole, initialStrokes, onClose, onSubmit }: Props) {
  const [active, setActive] = useState(0);
  const [values, setValues] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!open) return;
    const seeded: Record<string, number> = {};
    for (const p of players) {
      seeded[p.id] = initialStrokes[p.id] ?? hole.par;
    }
    setValues(seeded);
    setActive(0);
  }, [open, players, hole.par, initialStrokes]);

  const me = players[active];
  const val = me ? values[me.id] ?? hole.par : hole.par;

  const setVal = (n: number) => {
    if (!me) return;
    setValues((v) => ({ ...v, [me.id]: Math.max(1, Math.min(13, n)) }));
  };

  const allScored = useMemo(
    () => players.every((p) => Number.isFinite(values[p.id])),
    [players, values]
  );

  const advance = () => {
    if (active < players.length - 1) setActive(active + 1);
    else onSubmit(values);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-end justify-center"
          style={{ background: 'rgba(26,42,26,0.32)' }}
          onClick={onClose}
        >
          <motion.div
            onClick={(e) => e.stopPropagation()}
            initial={{ y: 60, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 60, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 32 }}
            className="w-full md:max-w-xl rounded-t-[28px] md:rounded-[28px] overflow-hidden"
            style={{ background: 'var(--paper)', border: '1px solid var(--hairline)' }}
          >
            {/* Grabber */}
            <div className="flex items-center justify-center pt-3 pb-1">
              <span style={{ width: 44, height: 4, borderRadius: 999, background: 'var(--hairline-strong)' }} />
            </div>

            {/* Header */}
            <div className="px-6 pt-2 pb-4 flex items-start justify-between">
              <div>
                <div className="eyebrow">
                  Hole {hole.number} · Par {hole.par}
                </div>
                <div className="serif-italic text-[26px] leading-none mt-1">
                  Mark the card.
                </div>
              </div>
              <button onClick={onClose} className="btn-icon" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Player tabs */}
            <div className="px-6 pb-3 flex gap-1 overflow-x-auto">
              {players.map((p, i) => {
                const isActive = i === active;
                const done = Number.isFinite(values[p.id]);
                return (
                  <button
                    key={p.id}
                    onClick={() => setActive(i)}
                    className="shrink-0 px-3 py-2 rounded-full flex items-center gap-2 transition-all"
                    style={{
                      background: isActive ? 'var(--ink)' : 'var(--paper-deep)',
                      color: isActive ? 'var(--paper)' : 'var(--ink)',
                      border: `1px solid ${isActive ? 'var(--ink)' : 'var(--hairline)'}`,
                    }}
                  >
                    <span className="serif text-[14px] truncate max-w-[120px]">{p.name || `P${i + 1}`}</span>
                    {done && (
                      <span className="mono text-[11px]" style={{ color: isActive ? 'var(--paper)' : 'var(--pencil)' }}>
                        · {values[p.id]}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Rolodex wheel */}
            <div className="relative px-6 pb-2" style={{ background: 'var(--paper)' }}>
              <div className="relative mx-auto" style={{ maxWidth: 240 }}>
                <Wheel value={val} onChange={setVal} par={hole.par} />
                {/* center line */}
                <div
                  className="pointer-events-none absolute left-0 right-0"
                  style={{
                    top: '50%',
                    height: 1,
                    transform: 'translateY(-0.5px)',
                    background: 'var(--accent)',
                    opacity: 0.7,
                  }}
                />
                <div
                  className="pointer-events-none absolute left-0 right-0"
                  style={{
                    top: '50%',
                    transform: 'translateY(22px)',
                    height: 1,
                    background: 'var(--accent)',
                    opacity: 0.7,
                  }}
                />
              </div>
            </div>

            {/* Score readout */}
            <div className="px-6 pb-4 text-center">
              <div className="eyebrow">
                {me ? me.name.toUpperCase() : ''} · {scoreName(val, hole.par)}
              </div>
            </div>

            {/* Action row */}
            <div className="px-6 pb-6 pt-2 hair-top flex gap-2">
              <button
                onClick={() => setVal(hole.par)}
                className="btn-paper text-[13px] px-4 py-2.5"
              >
                Par
              </button>
              <button
                onClick={() => setVal(hole.par + 1)}
                className="btn-paper text-[13px] px-4 py-2.5"
              >
                Bogey
              </button>
              <button
                onClick={() => setVal(hole.par - 1)}
                className="btn-paper text-[13px] px-4 py-2.5"
              >
                Birdie
              </button>
              <div className="flex-1" />
              <button onClick={advance} className="btn-ink text-[14px] px-6 py-2.5">
                {active < players.length - 1 ? 'Next →' : allScored ? 'Sign hole' : 'Sign hole'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Wheel({ value, onChange, par }: { value: number; onChange: (n: number) => void; par: number }) {
  const itemH = 44;
  const y = useMotionValue(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = -(value - 1) * itemH;
    const controls = animate(y, target, { type: 'spring', stiffness: 300, damping: 30 });
    return () => controls.stop();
  }, [value, y]);

  const handleDrag = (_: unknown, info: { offset: { y: number } }) => {
    const target = -(value - 1) * itemH + info.offset.y;
    y.set(target);
  };

  const handleDragEnd = (_: unknown, info: { offset: { y: number }; velocity: { y: number } }) => {
    const settled = -(value - 1) * itemH + info.offset.y + info.velocity.y * 0.12;
    const snapped = Math.round(-settled / itemH) + 1;
    onChange(Math.max(1, Math.min(13, snapped)));
  };

  return (
    <div className="relative rolodex-wheel" style={{ height: itemH * 5, overflow: 'hidden' }}>
      <motion.div
        ref={ref}
        drag="y"
        dragConstraints={{ top: -(13 * itemH), bottom: 0 }}
        dragMomentum
        onDrag={handleDrag}
        onDragEnd={handleDragEnd}
        style={{ y, paddingTop: itemH * 2 }}
      >
        {DIGITS.map((n) => {
          const toPar = n - par;
          const accent = toPar < 0;
          return (
            <div
              key={n}
              className="flex items-center justify-center"
              style={{ height: itemH }}
              onClick={() => onChange(n)}
            >
              <span
                className="display"
                style={{
                  fontSize: n === value ? 56 : 28,
                  color: n === value ? (accent ? 'var(--accent)' : 'var(--ink)') : 'var(--pencil-soft)',
                  transition: 'font-size 180ms ease-out, color 180ms ease-out',
                }}
              >
                {n}
              </span>
            </div>
          );
        })}
      </motion.div>
    </div>
  );
}

function scoreName(strokes: number, par: number) {
  const d = strokes - par;
  if (d <= -3) return 'Albatross';
  if (d === -2) return 'Eagle';
  if (d === -1) return 'Birdie';
  if (d === 0) return 'Par';
  if (d === 1) return 'Bogey';
  if (d === 2) return 'Double';
  return `+${d}`;
}
