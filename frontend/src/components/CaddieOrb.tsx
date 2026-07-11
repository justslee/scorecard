'use client';

// The omnipresent caddie orb (specs/omnipresent-caddie-orb-plan.md, slice S1).
//
// This is a PURE PLACEMENT MIGRATION of the voice invocation that used to
// live centered in FloatingTabBar's island (LooperOrb). Same bus, same
// haptics, same pointer semantics — only WHERE it renders changes: fixed
// bottom-right, on every page shouldShowCaddieOrb() allows, clear of the
// nav island when the island is on screen.
//
// Pill/orb interplay: on `/round/[id]` shouldShowCaddieOrb() is false — the
// round page's own floating "Ask caddie" pill (RoundPageClient.tsx, ~line
// 2110) is the caddie invocation there, so this orb steps aside rather than
// showing a second mic.
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { T } from '@/components/yardage/tokens';
import { shouldShowCaddieOrb } from '@/components/nav/shouldShowCaddieOrb';
import { shouldShowTabBar } from '@/components/nav/shouldShowTabBar';
import { openLooper, looperContextForPath } from '@/lib/looper-bus';
import { haptic } from '@/lib/haptics';

/** Long-press threshold — past this, the orb opens the caddie already listening. */
const ORB_HOLD_MS = 350;
/** Finger drift beyond this cancels the press (scrolling past the orb). */
const ORB_DRIFT_PX = 12;

/** Extra clearance above the safe-area inset when the floating tab island is on screen. */
const ISLAND_CLEARANCE_PX = 74;

const INTRO_SEEN_KEY = 'looper.caddieOrbIntroSeen';

// DESIGNER-OWNED: caddie mark — evolve from the L-medallion into the caddie
// glyph per designer review. Kept as its own sub-component so the mark can
// be swapped without touching placement/interaction code.
function CaddieMark() {
  return (
    <span
      aria-hidden="true"
      style={{
        fontFamily: T.serif,
        fontStyle: 'italic',
        fontSize: 24,
        lineHeight: 1,
      }}
    >
      L
    </span>
  );
}

export default function CaddieOrb() {
  const pathname = usePathname();
  const show = shouldShowCaddieOrb(pathname);
  const clearance = shouldShowTabBar(pathname) ? ISLAND_CLEARANCE_PX : 0;

  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldFired = useRef(false);
  const downAt = useRef<{ x: number; y: number } | null>(null);

  const [showIntro, setShowIntro] = useState(false);

  // One-time "Your caddie moved here" caption — first render where the orb
  // is shown, then never again. Guarded to useEffect for SSR safety.
  useEffect(() => {
    if (!show) return;
    if (typeof window === 'undefined') return;
    try {
      if (window.localStorage.getItem(INTRO_SEEN_KEY)) return;
      window.localStorage.setItem(INTRO_SEEN_KEY, '1');
    } catch {
      // localStorage unavailable (private mode, SSR quirks) — skip the intro.
      return;
    }
    // Defer the state update out of the effect body (react-hooks/set-state-in-effect).
    const show2 = setTimeout(() => setShowIntro(true), 0);
    const hide = setTimeout(() => setShowIntro(false), 3200);
    return () => {
      clearTimeout(show2);
      clearTimeout(hide);
    };
  }, [show]);

  if (!show) return null;

  const clearHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };

  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        zIndex: 50,
        bottom: `calc(12px + env(safe-area-inset-bottom) + ${clearance}px)`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 8,
      }}
    >
      <AnimatePresence>
        {showIntro && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={T.springSoft}
            style={{
              fontFamily: T.serif,
              fontStyle: 'italic',
              fontSize: 14,
              color: T.inkSoft,
              background: T.paper,
              border: `1px solid ${T.hairline}`,
              borderRadius: 999,
              padding: '6px 14px',
              whiteSpace: 'nowrap',
              boxShadow: '0 4px 14px rgba(26,42,26,0.14)',
            }}
          >
            Your caddie moved here
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        aria-label="Talk to your caddie"
        initial={{ scale: 0.85, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={T.springSoft}
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
          width: 54,
          height: 54,
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
          touchAction: 'none',
          WebkitUserSelect: 'none',
          userSelect: 'none',
        }}
      >
        <CaddieMark />
      </motion.button>
    </div>
  );
}
