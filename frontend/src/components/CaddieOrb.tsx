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
//
// Full-screen overlay suppression (specs/caddie-orb-map-mode-ghost-plan.md):
// the orb also renders NOTHING while a registered full-screen overlay
// (CourseSearch) owns the screen — see fullscreen-overlay.ts.
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { T } from '@/components/yardage/tokens';
import { shouldShowCaddieOrb, isSetupCtaRoute } from '@/components/nav/shouldShowCaddieOrb';
import { shouldShowTabBar } from '@/components/nav/shouldShowTabBar';
import { openLooper, looperContextForPath } from '@/lib/looper-bus';
import { haptic } from '@/lib/haptics';
import { onCaddieOrbState } from '@/lib/caddie-context';
import { isFullscreenOverlayActive, onFullscreenOverlayChange } from '@/lib/fullscreen-overlay';

/** Long-press threshold — past this, the orb opens the caddie already listening. */
const ORB_HOLD_MS = 350;
/** Finger drift beyond this cancels the press (scrolling past the orb). */
const ORB_DRIFT_PX = 12;

/** Extra clearance above the safe-area inset when the floating tab island is on screen. */
const ISLAND_CLEARANCE_PX = 74;
/** Extra clearance above the safe-area inset on setup pages with a full-width
 *  sticky bottom CTA (`/round/new`'s "Tee off", `/tournament/new`'s "Create
 *  tournament") — neither shows the tab island, so without this the orb
 *  would sit on top of the CTA. Exact px is designer-tuned later (S5). */
const STICKY_CTA_CLEARANCE_PX = 92;

const INTRO_SEEN_KEY = 'looper.caddieOrbIntroSeen';

// Final caddie mark: the serif-italic "L" — Looper's identity mark, already
// used on Home. This IS the caddie glyph (Looper = caddie), not a
// placeholder; a new symbol would break identity continuity. Kept as its own
// sub-component so placement/interaction code can change independently of it.
function CaddieMark() {
  return (
    <span
      aria-hidden="true"
      style={{
        fontFamily: T.serif,
        fontStyle: 'italic',
        fontSize: 24,
        lineHeight: 1,
        // Optical centering: the italic serif cap reads slightly right-heavy
        // in a perfect circle.
        transform: 'translateX(-1px)',
      }}
    >
      L
    </span>
  );
}

export default function CaddieOrb() {
  const pathname = usePathname();
  const show = shouldShowCaddieOrb(pathname);
  // Tab island beats setup-CTA clearance when (hypothetically) both apply —
  // they don't today (setup pages never show the tab bar), but the priority
  // is explicit rather than accidental.
  const clearance = shouldShowTabBar(pathname)
    ? ISLAND_CLEARANCE_PX
    : isSetupCtaRoute(pathname)
      ? STICKY_CTA_CLEARANCE_PX
      : 0;

  // Full-screen overlay suppression (specs/caddie-orb-map-mode-ghost-plan.md):
  // while a registered overlay owns the screen the orb is truly ABSENT — a
  // transparent overlay (CourseSearch map mode) cannot occlude it, so
  // out-stacking is not enough. Lazy-initialized from the getter so there is
  // no first-paint flash if an overlay is already live when the orb mounts.
  const [overlayActive, setOverlayActive] = useState(isFullscreenOverlayActive);
  useEffect(() => onFullscreenOverlayChange(setOverlayActive), []);
  const visible = show && !overlayActive;

  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldFired = useRef(false);
  const downAt = useRef<{ x: number; y: number } | null>(null);

  const [showIntro, setShowIntro] = useState(false);

  // Confirming beat (specs/orb-s2-context-contract-teetime-plan.md §6) — a
  // one-shot success pulse when the host (CaddieOrbSheet) applies a task and
  // arms the page's own dispatch. Additive only: no pointer/placement/
  // visibility change. The sheet covers the orb while open (z 61 vs 50), so
  // this pulse mainly lands visibly as the sheet slides away during the
  // 1400ms beat / phase change; the haptic (fired by the host) is primary.
  const [confirming, setConfirming] = useState(false);
  useEffect(() => onCaddieOrbState((s) => setConfirming(s === 'confirming')), []);

  // One-time "Your caddie moved here" caption — first render where the orb
  // is shown, then never again. Guarded to useEffect for SSR safety.
  useEffect(() => {
    if (!visible) return;
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
  }, [visible]);

  if (!visible) return null;

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
            role="status"
            aria-live="polite"
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
              // Purely informational (role="status") — must never intercept
              // touches. Without this it overlays inputs/CTAs beneath it for
              // ~3.2s on first run and silently swallows taps.
              pointerEvents: 'none',
            }}
          >
            Your caddie moved here
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        aria-label="Talk to your caddie"
        initial={{ scale: 0.85, opacity: 0 }}
        animate={{ scale: confirming ? [1, 1.12, 1] : 1, opacity: 1 }}
        transition={confirming ? { duration: 0.5, ease: 'easeOut' } : T.springSoft}
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
          // S5 resting-depth/glow treatment (owner feedback): a subtle radial
          // ink gradient + a layered shadow stack read as a raised dome
          // instead of a flat disc. The ambient halo is ONE static layer in
          // this shadow list (no extra DOM, no animation) — it must NOT
          // pulse, since a breathing glow reads as a SaaS "AI thinking"
          // indicator, which NORTHSTAR rules out. State-change motion stays
          // owned entirely by the `confirming` scale pulse above; there is
          // nothing here to gate on prefers-reduced-motion.
          background: `radial-gradient(circle at 32% 26%, ${T.inkSoft} 0%, ${T.ink} 62%)`,
          color: T.paper,
          border: `1px solid ${T.hairline}`,
          boxShadow: [
            '0 6px 18px rgba(26,42,26,0.28)',           // unchanged — elevation off the page
            '0 0 16px rgba(244,241,234,0.12)',          // ambient halo — T.paper @ 12%, 0 spread (invisible on paper, a soft aura over dark map surfaces)
            'inset 0 1px 1px rgba(244,241,234,0.35)',   // paper-toned top rim highlight (was pure white)
            'inset 0 -2px 3px rgba(0,0,0,0.28)',        // bottom inner shadow — completes the raised-dome read
          ].join(', '),
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
