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
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { T } from '@/components/yardage/tokens';
import { shouldShowCaddieOrb, isSetupCtaRoute } from '@/components/nav/shouldShowCaddieOrb';
import { shouldShowTabBar } from '@/components/nav/shouldShowTabBar';
import { openLooper, looperContextForPath, sendLooperDockedGesture } from '@/lib/looper-bus';
import { haptic } from '@/lib/haptics';
import {
  getCaddieOrbState,
  onCaddieOrbState,
  getCaddieOrbCaption,
  onCaddieOrbCaption,
  type CaddieOrbState,
} from '@/lib/caddie-context';
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
/** Owner directive, v1.1.10 field test — one-time re-teach of the inverted
 *  gesture (specs/caddie-orb-tap-to-talk-inversion-plan.md §5a). */
const INVERT_INTRO_SEEN_KEY = 'looper.tapHoldInvertedSeen';

/** True while the orb should read as "docked" — a live/connecting session
 *  the golfer is talking straight into, no sheet chrome. */
function isDockedState(s: CaddieOrbState): boolean {
  return s === 'listening' || s === 'connecting';
}

/** Shared chip treatment — the "Your caddie moved here" intro, the inverted-
 *  gesture re-teach, and the docked live caption all render through this ONE
 *  component so they stay visually identical and mutually exclusive via
 *  AnimatePresence. Purely informational (role="status") — must never
 *  intercept touches, so pointerEvents stays "none". */
function OrbChip({ children }: { children: ReactNode }) {
  return (
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
        pointerEvents: 'none',
      }}
    >
      {children}
    </motion.div>
  );
}

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
  // Captured at pointerdown so a mid-press connecting→listening flip can't
  // change what the hold-timer/tap handlers below do — both read THIS, never
  // the live `orbState` (specs/caddie-orb-tap-to-talk-inversion-plan.md §3b).
  const pressStateRef = useRef<'idle' | 'docked'>('idle');

  const [showIntro, setShowIntro] = useState(false);
  const [showInvertIntro, setShowInvertIntro] = useState(false);
  // Whether the "moved here" intro fired THIS mount — sequences the
  // re-teach chip after it (never both on screen at once) rather than
  // racing them.
  const introFiredRef = useRef(false);

  const reduceMotion = useReducedMotion();

  // Orb state (idle/connecting/listening/thinking/confirming) — the single
  // channel the docked host (CaddieOrbSheet) uses to tell the orb what the
  // mic is actually doing. `confirming`/`docked` below are pure derivations,
  // never independent state, so they can never drift from `orbState`.
  const [orbState, setOrbState] = useState<CaddieOrbState>(getCaddieOrbState);
  useEffect(() => onCaddieOrbState(setOrbState), []);
  const confirming = orbState === 'confirming';
  const docked = isDockedState(orbState);

  // Docked live caption (host → orb, one-way) — "Hearing…", a quoted
  // interim, or the no-speech self-heal copy. Rendered via OrbChip below,
  // mutually exclusive with the intro/re-teach chips.
  const [caption, setCaption] = useState(getCaddieOrbCaption);
  useEffect(() => onCaddieOrbCaption(setCaption), []);

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
    introFiredRef.current = true;
    // Defer the state update out of the effect body (react-hooks/set-state-in-effect).
    const show2 = setTimeout(() => setShowIntro(true), 0);
    const hide = setTimeout(() => setShowIntro(false), 3200);
    return () => {
      clearTimeout(show2);
      clearTimeout(hide);
    };
  }, [visible]);

  // One-time inverted-gesture re-teach (owner directive, v1.1.10 field test
  // — §5a). Byte-for-byte modeled on the intro effect above (burn-once,
  // SSR-guarded, deferred setState); runs in the SAME commit right after it,
  // so `introFiredRef` is already current when this reads it: waits out the
  // moved-here chip (3400ms) if that one just fired this mount, otherwise
  // shows immediately (a returning golfer who already saw "moved here").
  useEffect(() => {
    if (!visible) return;
    if (typeof window === 'undefined') return;
    try {
      if (window.localStorage.getItem(INVERT_INTRO_SEEN_KEY)) return;
      window.localStorage.setItem(INVERT_INTRO_SEEN_KEY, '1');
    } catch {
      return;
    }
    const delay = introFiredRef.current ? 3400 : 0;
    const show2 = setTimeout(() => setShowInvertIntro(true), delay);
    const hide = setTimeout(() => setShowInvertIntro(false), delay + 3200);
    return () => {
      clearTimeout(show2);
      clearTimeout(hide);
    };
  }, [visible]);

  // Hidden-while-docked cancel (§3e) — a full-screen overlay (CourseSearch)
  // or a nav onto a shouldShowCaddieOrb-false route can make the orb vanish
  // out from under a hot mic; without this the golfer would have no way to
  // stop it. The host's own pathname effect (CaddieOrbSheet §2i) is the
  // belt to this suspenders.
  useEffect(() => {
    if (!visible && docked) sendLooperDockedGesture('cancel');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, orbState]);

  if (!visible) return null;

  const clearHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };

  const ariaLabel =
    orbState === 'listening'
      ? 'Caddie listening — tap to send, hold to cancel'
      : orbState === 'connecting'
        ? 'Caddie connecting — hold to cancel'
        : 'Talk to your caddie — tap to talk, hold to open chat';

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
        {showIntro ? (
          <OrbChip key="intro">Your caddie moved here</OrbChip>
        ) : showInvertIntro ? (
          <OrbChip key="invert-intro">Tap to talk - hold to open chat</OrbChip>
        ) : caption != null ? (
          <OrbChip key="docked-caption">{caption}</OrbChip>
        ) : null}
      </AnimatePresence>

      <motion.button
        aria-label={ariaLabel}
        initial={{ scale: 0.85, opacity: 0 }}
        animate={{
          scale: confirming
            ? [1, 1.12, 1]
            : orbState === 'listening' && !reduceMotion
              ? [1, 1.06, 1]
              : 1,
          opacity: 1,
        }}
        transition={
          confirming
            ? { duration: 0.5, ease: 'easeOut' }
            : orbState === 'listening' && !reduceMotion
              ? { duration: 2.6, repeat: Infinity, ease: 'easeInOut' }
              : T.springSoft
        }
        onPointerDown={(e) => {
          heldFired.current = false;
          downAt.current = { x: e.clientX, y: e.clientY };
          clearHold();
          // Captured NOW — the hold timer's own callback (350ms later) reads
          // this, not the live orbState, so a mid-press connecting→listening
          // flip can't change what the press means (§3b).
          pressStateRef.current = docked ? 'docked' : 'idle';
          holdTimer.current = setTimeout(() => {
            holdTimer.current = null;
            heldFired.current = true;
            if (pressStateRef.current === 'docked') {
              // Docked hold = cancel: release the mic, collapse to idle. No
              // confirm flash — a light haptic is the whole beat.
              haptic('light');
              sendLooperDockedGesture('cancel');
            } else {
              // Idle/confirming hold = open the full chat sheet, not listening
              // (today's tap payload, now on hold).
              haptic('medium');
              openLooper({ context: looperContextForPath(pathname), listening: false, presentation: 'full' });
            }
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
          if (pressStateRef.current === 'docked') {
            // Docked tap = send now — the SAME handler onUtteranceEnd's
            // auto-send goes through (handleMicTap's listening branch).
            haptic('light');
            sendLooperDockedGesture('send');
          } else {
            // Idle tap = start talking immediately: docked presentation,
            // listening true — no sheet, orb pulse is the only feedback.
            haptic('light');
            openLooper({ context: looperContextForPath(pathname), listening: true, presentation: 'docked' });
          }
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
          // owned entirely by the `confirming`/`listening` scale pulses
          // above. Reduced-motion listening gets a static printed double
          // ring instead (prepended below) — the only other thing gated on
          // prefers-reduced-motion.
          background: `radial-gradient(circle at 32% 26%, ${T.inkSoft} 0%, ${T.ink} 62%)`,
          color: T.paper,
          border: `1px solid ${T.hairline}`,
          boxShadow: [
            ...(orbState === 'listening' && reduceMotion
              ? [`0 0 0 2.5px ${T.paper}`, `0 0 0 4px ${T.ink}`] // printed double ring — zero animation
              : []),
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
