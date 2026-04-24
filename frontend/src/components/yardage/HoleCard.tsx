'use client';

import { useRef } from 'react';
import { motion, PanInfo } from 'framer-motion';
import { HoleInfo } from '@/lib/types';
import { Waveform } from './VoiceOrb';

function clubSuggestion(yards: number) {
  if (yards < 80) return { club: 'SW', note: 'short-side miss is okay' };
  if (yards < 110) return { club: 'PW', note: 'smooth tempo' };
  if (yards < 135) return { club: '9i', note: 'take one extra' };
  if (yards < 155) return { club: '8i', note: 'trust the breeze' };
  if (yards < 175) return { club: '7i', note: 'smooth, not hard' };
  if (yards < 195) return { club: '6i', note: 'stay committed' };
  if (yards < 215) return { club: '5i', note: 'let it chase' };
  if (yards < 235) return { club: '4i', note: 'tee it higher' };
  if (yards < 265) return { club: 'hybrid', note: 'rip the fairway' };
  return { club: 'driver', note: 'big, easy one' };
}

export default function HoleCard({
  hole,
  total,
  onPrev,
  onNext,
  onTap,
}: {
  hole: HoleInfo;
  total: number;
  onPrev?: () => void;
  onNext?: () => void;
  onTap?: () => void;
}) {
  const yards = hole.yards ?? 0;
  const center = yards;
  const front = Math.max(0, Math.round(yards * 0.94));
  const back = Math.round(yards * 1.08);
  const { club, note } = clubSuggestion(center);
  const draggedRef = useRef(false);

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    draggedRef.current = true;
    setTimeout(() => {
      draggedRef.current = false;
    }, 320);
    const threshold = 60;
    if (info.offset.x < -threshold && onNext) onNext();
    else if (info.offset.x > threshold && onPrev) onPrev();
  };

  return (
    <motion.section
      key={hole.number}
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.18}
      onDragEnd={handleDragEnd}
      onClick={() => {
        if (draggedRef.current) return;
        onTap?.();
      }}
      className="sheet p-5"
      style={{ touchAction: 'pan-y', cursor: 'grab' }}
    >
      {/* Masthead strip */}
      <div className="flex items-start justify-between">
        <div>
          <div className="mono text-[9px] tracking-[0.24em]" style={{ color: 'var(--pencil)' }}>
            HOLE · {hole.number} OF {total}
          </div>
          <div className="display mt-0.5 leading-none" style={{ fontSize: 64 }}>
            <span style={{ color: 'var(--accent)' }}>{hole.number}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="mono text-[9px] tracking-[0.24em]" style={{ color: 'var(--pencil)' }}>
            PAR
          </div>
          <div className="display mt-0.5 leading-none" style={{ fontSize: 48 }}>
            {hole.par}
          </div>
        </div>
      </div>

      {/* Abstract yardage-book fairway illustration */}
      <div
        className="mt-4 rounded-2xl overflow-hidden relative"
        style={{ background: 'var(--paper-deep)', border: '1px solid var(--hairline)' }}
      >
        <svg viewBox="0 0 320 170" className="w-full block" aria-hidden>
          <defs>
            <pattern id="grain" width="4" height="4" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="0.3" fill="#8a8470" opacity="0.45" />
            </pattern>
          </defs>
          {/* tee */}
          <g transform="translate(30,140)">
            <rect x="-8" y="-3" width="16" height="6" fill="var(--ink)" opacity="0.65" rx="1" />
            <text x="0" y="18" textAnchor="middle" className="mono" fontSize="8" fill="var(--pencil)">
              TEE
            </text>
          </g>
          {/* fairway curve — hand-drawn feel */}
          <path
            d="M30 140 C80 125 80 90 120 75 C170 58 200 65 230 55 C260 46 280 38 295 32"
            stroke="var(--ink)"
            strokeOpacity="0.1"
            strokeWidth="22"
            fill="none"
            strokeLinecap="round"
          />
          <path
            d="M30 140 C80 125 80 90 120 75 C170 58 200 65 230 55 C260 46 280 38 295 32"
            stroke="url(#grain)"
            strokeWidth="22"
            fill="none"
            strokeLinecap="round"
          />
          {/* fairway outline - pencil stroke */}
          <path
            d="M30 140 C80 125 80 90 120 75 C170 58 200 65 230 55 C260 46 280 38 295 32"
            stroke="var(--ink)"
            strokeOpacity="0.22"
            strokeWidth="0.8"
            strokeDasharray="0.5 3"
            fill="none"
            strokeLinecap="round"
          />
          {/* green */}
          <ellipse cx="295" cy="32" rx="20" ry="11" fill="var(--ink)" opacity="0.09" />
          <ellipse cx="295" cy="32" rx="20" ry="11" fill="none" stroke="var(--ink)" strokeOpacity="0.35" strokeWidth="0.8" strokeDasharray="0.5 2" />
          {/* flag */}
          <g transform="translate(295,32)">
            <line x1="0" y1="0" x2="0" y2="-26" stroke="var(--ink)" strokeWidth="1.2" strokeLinecap="round" />
            <path d="M0 -26 L14 -22 L0 -18 Z" fill="var(--accent)" />
            <circle r="2.2" fill="var(--ink)" />
          </g>
          {/* player dot — pulsing */}
          <g transform="translate(120,75)">
            <circle r="7" fill="var(--accent)" opacity="0.15">
              <animate attributeName="r" values="5;8;5" dur="2.2s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.15;0.05;0.15" dur="2.2s" repeatCount="indefinite" />
            </circle>
            <circle r="3" fill="var(--accent)" />
          </g>
          {/* yardage callouts — printed markers */}
          <text x="30" y="160" className="mono" fontSize="7" fill="var(--pencil)">
            0
          </text>
          <text x="120" y="95" className="mono" fontSize="7" fill="var(--pencil)" textAnchor="middle">
            YOU
          </text>
        </svg>
      </div>

      {/* Yardages to pin */}
      <div className="mt-4 grid grid-cols-3 gap-2">
        <YardCell label="Front" yards={front} dot="var(--flag-front)" />
        <YardCell label="Center" yards={center} dot="var(--flag-center)" ringed />
        <YardCell label="Back" yards={back} dot="var(--flag-back)" />
      </div>

      {/* Caddy panel */}
      <div
        className="mt-4 p-4 rounded-2xl"
        style={{ background: 'var(--paper-deep)', border: '1px solid var(--hairline)' }}
      >
        <div className="flex items-start gap-3">
          <div
            className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center serif text-[13px]"
            style={{ background: 'var(--ink)', color: 'var(--paper)' }}
          >
            F
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="mono text-[9px] tracking-[0.24em]" style={{ color: 'var(--pencil)' }}>
                CADDY · FLUFF
              </span>
              <Waveform />
              <span className="mono text-[9px]" style={{ color: 'var(--pencil)' }}>
                0:06
              </span>
            </div>
            <div className="serif-italic text-[18px] leading-snug mt-1">
              &ldquo;Smooth {club} — {note}.&rdquo;
            </div>
          </div>
          <div className="shrink-0 flex flex-col items-end">
            <div
              className="rounded-full px-3 py-1"
              style={{ background: 'var(--ink)', color: 'var(--paper)' }}
            >
              <span className="serif-italic text-[16px]">{club}</span>
            </div>
            <div className="mono text-[9px] mt-1" style={{ color: 'var(--pencil)' }}>
              CLUB
            </div>
          </div>
        </div>
      </div>

      {/* swipe hint */}
      <div className="mt-3 flex items-center justify-center gap-2">
        <span className="mono text-[9px] tracking-[0.24em]" style={{ color: 'var(--pencil-soft)' }}>
          SWIPE FOR NEXT HOLE
        </span>
      </div>
    </motion.section>
  );
}

function YardCell({
  label,
  yards,
  dot,
  ringed,
}: {
  label: string;
  yards: number;
  dot: string;
  ringed?: boolean;
}) {
  return (
    <div
      className="rounded-xl p-3 text-center"
      style={{ background: 'var(--paper)', border: '1px solid var(--hairline)' }}
    >
      <div className="h-[2px] rounded-full mb-2" style={{ background: dot }} />
      <div className="mono text-[9px] tracking-[0.22em] flex items-center justify-center gap-1.5" style={{ color: 'var(--pencil)' }}>
        <span
          className="flag-dot"
          style={{ background: dot, border: ringed ? '1.5px solid var(--ink)' : undefined }}
        />
        {label.toUpperCase()}
      </div>
      <div className="display text-[30px] mt-1 leading-none">{yards || '—'}</div>
      <div className="mono text-[9px]" style={{ color: 'var(--pencil)' }}>
        YDS
      </div>
    </div>
  );
}
