'use client';

import { useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'framer-motion';
import { T } from '@/components/yardage/tokens';
import { shouldShowTabBar, normalizePath } from './shouldShowTabBar';
import { openLooper, looperContextForPath } from '@/lib/looper-bus';
import { haptic } from '@/lib/haptics';

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

function CoursesIcon() {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 21V4" />
      <path d="M6 4l11 2.5L6 10" />
    </svg>
  );
}

// ── Tab definitions ───────────────────────────────────────────────────────────

// Partners left the bar for the center Looper orb (specs/looper-orb-plan.md);
// its entry point lives on Home, /players stays routable.
const TABS_LEFT = [
  { href: '/', label: 'Home', Icon: HomeIcon },
  { href: '/courses', label: 'Courses', Icon: CoursesIcon },
] as const;
const TABS_RIGHT = [
  { href: '/tee-time', label: 'Tee times', Icon: CalendarClockIcon },
  { href: '/profile', label: 'Profile', Icon: ProfileIcon },
] as const;

/** Long-press threshold — past this, the orb opens Looper already listening. */
const ORB_HOLD_MS = 350;
/** Finger drift beyond this cancels the press (scrolling past the bar). */
const ORB_DRIFT_PX = 12;

/** The raised center orb — tap summons Looper, long-press starts listening. */
function LooperOrb({ pathname }: { pathname: string }) {
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldFired = useRef(false);
  const downAt = useRef<{ x: number; y: number } | null>(null);

  const clearHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };

  return (
    <button
      aria-label="Talk to Looper"
      onPointerDown={(e) => {
        heldFired.current = false;
        downAt.current = { x: e.clientX, y: e.clientY };
        clearHold();
        holdTimer.current = setTimeout(() => {
          holdTimer.current = null;
          heldFired.current = true;
          haptic('medium');
          openLooper({ context: looperContextForPath(pathname), listening: true });
        }, ORB_HOLD_MS);
      }}
      onPointerMove={(e) => {
        const d = downAt.current;
        if (!d) return;
        if (Math.abs(e.clientX - d.x) > ORB_DRIFT_PX || Math.abs(e.clientY - d.y) > ORB_DRIFT_PX) {
          clearHold(); // drifted — a scroll, not a press
          downAt.current = null;
        }
      }}
      onPointerUp={() => {
        const wasPending = holdTimer.current !== null;
        clearHold();
        downAt.current = null;
        if (heldFired.current) return; // long-press already summoned
        if (!wasPending) return; // press was cancelled by drift
        haptic('light');
        openLooper({ context: looperContextForPath(pathname), listening: false });
      }}
      onPointerCancel={() => {
        clearHold();
        downAt.current = null;
      }}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        // Raised out of the pill — the one element that breaks the island's
        // top edge, so Looper reads as the app's center of gravity.
        alignSelf: 'center',
        width: 54,
        height: 54,
        marginTop: -22,
        borderRadius: 999,
        background: T.ink,
        color: T.paper,
        border: `1px solid ${T.hairline}`,
        boxShadow: '0 6px 18px rgba(26,42,26,0.28), 0 1px 0 rgba(255,255,255,0.25) inset',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        flexShrink: 0,
        fontFamily: T.serif,
        fontStyle: 'italic',
        fontSize: 24,
        lineHeight: 1,
        touchAction: 'none',
        WebkitUserSelect: 'none',
        userSelect: 'none',
      }}
    >
      L
    </button>
  );
}

function TabLink({
  href,
  label,
  Icon,
  active,
}: {
  href: string;
  label: string;
  Icon: () => React.ReactElement;
  active: boolean;
}) {
  return (
    <Link
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
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
    </Link>
  );
}

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
        {TABS_LEFT.map((tab) => (
          <TabLink key={tab.href} {...tab} active={tab.href === normalizedPath} />
        ))}
        <LooperOrb pathname={pathname} />
        {TABS_RIGHT.map((tab) => (
          <TabLink key={tab.href} {...tab} active={tab.href === normalizedPath} />
        ))}
      </motion.nav>
    </div>
  );
}
