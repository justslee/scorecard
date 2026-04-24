'use client';

import { motion } from 'framer-motion';

export default function VoiceOrb({
  active = false,
  size = 28,
  onClick,
}: {
  active?: boolean;
  size?: number;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative inline-flex items-center justify-center"
      style={{ width: size + 8, height: size + 8 }}
      aria-label="Voice caddy"
    >
      <motion.span
        className="absolute inset-0 rounded-full"
        style={{ background: 'var(--accent)' }}
        animate={active ? { scale: [1, 1.18, 1], opacity: [0.25, 0.1, 0.25] } : { scale: 1, opacity: 0.18 }}
        transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
      />
      <span
        className="relative rounded-full"
        style={{
          width: size,
          height: size,
          background: 'var(--accent)',
          boxShadow: '0 0 0 2px var(--paper)',
        }}
      />
    </button>
  );
}

export function Waveform({ active = true }: { active?: boolean }) {
  return (
    <div className="inline-flex items-center gap-[3px]" style={{ height: 18 }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="wave-bar"
          style={{
            animationDelay: `${i * 0.12}s`,
            animationPlayState: active ? 'running' : 'paused',
          }}
        />
      ))}
    </div>
  );
}
