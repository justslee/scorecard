'use client';

import { motion } from 'framer-motion';
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

export default function HoleCard({ hole, total }: { hole: HoleInfo; total: number }) {
  const yards = hole.yards ?? 0;
  const center = yards;
  const front = Math.max(0, Math.round(yards * 0.94));
  const back = Math.round(yards * 1.08);
  const { club, note } = clubSuggestion(center);

  return (
    <motion.section
      key={hole.number}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      className="sheet p-5"
    >
      {/* Masthead strip */}
      <div className="flex items-start justify-between">
        <div>
          <div className="eyebrow">Hole · {hole.number}/{total}</div>
          <div className="display text-[52px] leading-none mt-1">
            <span style={{ color: 'var(--accent)' }}>{hole.number}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="eyebrow">Par</div>
          <div className="display text-[40px] leading-none mt-1">{hole.par}</div>
        </div>
      </div>

      {/* Illustration — simple abstract fairway */}
      <div className="mt-4 rounded-2xl overflow-hidden" style={{ background: 'var(--paper-deep)', border: '1px solid var(--hairline)' }}>
        <svg viewBox="0 0 320 160" className="w-full" style={{ display: 'block' }} aria-hidden>
          {/* fairway */}
          <defs>
            <pattern id="grain" width="4" height="4" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="0.3" fill="#a8a28f" opacity="0.35" />
            </pattern>
          </defs>
          <path d="M30 135 C70 110 60 80 110 65 C160 50 190 58 220 50 C250 42 270 35 285 32" stroke="var(--ink)" strokeWidth="18" strokeLinecap="round" fill="none" opacity="0.08" />
          <path d="M30 135 C70 110 60 80 110 65 C160 50 190 58 220 50 C250 42 270 35 285 32" stroke="url(#grain)" strokeWidth="18" strokeLinecap="round" fill="none" />
          {/* green */}
          <ellipse cx="285" cy="32" rx="22" ry="12" fill="var(--ink)" opacity="0.1" />
          {/* flag */}
          <g transform="translate(285,32)">
            <line x1="0" y1="0" x2="0" y2="-24" stroke="var(--ink)" strokeWidth="1" />
            <path d="M0 -24 L14 -20 L0 -16 Z" fill="var(--accent)" />
            <circle r="2" fill="var(--ink)" />
          </g>
          {/* tee marker */}
          <g transform="translate(30,135)">
            <circle r="4" fill="var(--ink)" opacity="0.6" />
            <circle r="1.5" fill="var(--paper)" />
          </g>
          {/* player dot */}
          <g transform="translate(110,65)">
            <circle r="5" fill="var(--accent)" opacity="0.25" />
            <circle r="2.5" fill="var(--accent)" />
          </g>
        </svg>
      </div>

      {/* Yardages to pin */}
      <div className="mt-4 grid grid-cols-3 gap-2">
        <YardCell label="Front" yards={front} dot="var(--flag-front)" />
        <YardCell label="Center" yards={center} dot="var(--flag-center)" ringed />
        <YardCell label="Back" yards={back} dot="var(--flag-back)" />
      </div>

      {/* Caddy panel */}
      <div className="mt-4 p-4 rounded-2xl" style={{ background: 'var(--paper-deep)', border: '1px solid var(--hairline)' }}>
        <div className="flex items-start gap-3">
          <div className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center serif" style={{ background: 'var(--ink)', color: 'var(--paper)' }}>
            F
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="eyebrow">Caddy · Fluff</span>
              <Waveform />
              <span className="mono text-[10px]" style={{ color: 'var(--pencil)' }}>
                0:06
              </span>
            </div>
            <div className="serif-italic text-[18px] leading-snug mt-1">
              &ldquo;Smooth {club} — {note}.&rdquo;
            </div>
          </div>
          <div className="shrink-0 flex flex-col items-end">
            <div className="pill pill-ink">{club}</div>
            <div className="mono text-[10px] mt-1" style={{ color: 'var(--pencil)' }}>
              CLUB
            </div>
          </div>
        </div>
      </div>
    </motion.section>
  );
}

function YardCell({ label, yards, dot, ringed }: { label: string; yards: number; dot: string; ringed?: boolean }) {
  return (
    <div className="rounded-xl p-3 text-center" style={{ background: 'var(--paper)', border: '1px solid var(--hairline)' }}>
      <div className="h-0.5 rounded-full mb-2" style={{ background: dot }} />
      <div className="eyebrow flex items-center justify-center gap-1.5">
        <span className="flag-dot" style={{ background: dot, border: ringed ? '1.5px solid var(--ink)' : undefined }} />
        {label}
      </div>
      <div className="display text-[28px] mt-1">{yards || '—'}</div>
      <div className="mono text-[10px]" style={{ color: 'var(--pencil)' }}>
        YDS
      </div>
    </div>
  );
}
