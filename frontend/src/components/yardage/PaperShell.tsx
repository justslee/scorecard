'use client';

import { ReactNode } from 'react';

export default function PaperShell({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`paper ${className}`}>
      <div className="paper-content">{children}</div>
    </div>
  );
}

export function Masthead({
  eyebrow,
  title,
  trailing,
}: {
  eyebrow?: string;
  title: string;
  trailing?: ReactNode;
}) {
  return (
    <header className="hair-bot pt-6 pb-5 px-5">
      <div className="max-w-xl mx-auto">
        <div className="flex items-end justify-between gap-3">
          <div className="flex-1 min-w-0">
            {eyebrow && <div className="eyebrow mb-2">{eyebrow}</div>}
            <h1 className="display text-[40px] leading-[0.95]">{title}</h1>
          </div>
          {trailing && <div className="shrink-0">{trailing}</div>}
        </div>
      </div>
    </header>
  );
}

export function FlagMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 3v18" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M6 4c3.5-1 6 1.5 9 0.5V10c-3 1-5.5-1.5-9-0.5V4Z" fill="currentColor" opacity="0.85" />
      <circle cx="6" cy="21" r="1.4" fill="currentColor" />
    </svg>
  );
}
