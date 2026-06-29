'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'framer-motion';
import { T } from '@/components/yardage/tokens';
import { shouldShowTabBar, normalizePath } from './shouldShowTabBar';

// ── Inline icons — no lucide-react, stroke currentColor, strokeWidth 1.5 ─────
// Icon style matches src/app/players/page.tsx: viewBox "0 0 24 24", no fill,
// strokeLinecap/round, strokeLinejoin/round, aria-hidden.

function HomeIcon() {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function CalendarClockIcon() {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <circle cx="15" cy="16" r="3" />
      <path d="M15 14v2l1 1" />
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

// ── Tab definitions ───────────────────────────────────────────────────────────

const TABS = [
  { href: '/', label: 'Home', Icon: HomeIcon },
  { href: '/players', label: 'Partners', Icon: UsersIcon },
  { href: '/tee-time', label: 'Tee times', Icon: CalendarClockIcon },
  { href: '/profile', label: 'Profile', Icon: ProfileIcon },
] as const;

// ── Component ─────────────────────────────────────────────────────────────────

export default function FloatingTabBar() {
  const pathname = usePathname();

  if (!shouldShowTabBar(pathname)) return null;

  const normalizedPath = normalizePath(pathname);

  return (
    // Outer wrapper: fixed, full-width, pointer-events pass-through in the
    // margins so taps on page content behind the bar still work.
    <div
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 'calc(12px + env(safe-area-inset-bottom))',
        zIndex: 40,
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
        padding: '0 16px',
      }}
    >
      {/* Pill — one-time entrance; pointerEvents restored here */}
      <motion.nav
        aria-label="Primary"
        initial={{ y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={T.springSoft}
        style={{
          pointerEvents: 'auto',
          width: '100%',
          maxWidth: 420,
          background: T.paper,
          border: `1px solid ${T.hairline}`,
          borderRadius: 999,
          boxShadow:
            '0 6px 24px rgba(26,42,26,0.12), 0 1px 0 rgba(255,255,255,0.4) inset',
          padding: 6,
          display: 'flex',
          gap: 2,
          fontFamily: T.sans,
        }}
      >
        {TABS.map(({ href, label, Icon }) => {
          const active = href === normalizedPath;
          return (
            <Link
              key={href}
              href={href}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 3,
                minHeight: 52,
                borderRadius: 999,
                color: active ? T.ink : T.inkSoft,
                background: active ? T.paperDeep : 'transparent',
                border: active ? `1px solid ${T.paperEdge}` : '1px solid transparent',
                fontSize: 10.5,
                textDecoration: 'none',
                transition: 'color 120ms, background 120ms, border-color 120ms',
              }}
            >
              <Icon />
              <span>{label}</span>
            </Link>
          );
        })}
      </motion.nav>
    </div>
  );
}
