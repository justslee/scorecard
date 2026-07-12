'use client';

// SPIKE (specs/passive-shot-tracking-spike.md) — throwaway feasibility
// prototype. Gated end-to-end behind NEXT_PUBLIC_SPIKE_PASSIVE_SHOTS=1,
// ABSENT/OFF in every env — this component renders nothing at all when the
// flag isn't exactly "1", so it is a structural no-op in every real build.
//
// What this does: feeds the round page's ALREADY-RUNNING GPS positions
// (RoundPageClient's GPSWatcher) into the pure dwell→move→dwell classifier
// (lib/spike/shot-drift.ts). When it fires a draft, this shows a quiet
// on-paper banner and STOPS THERE — it never writes a shot, never calls the
// backend, never auto-scores anything. Confirming hands off into the
// EXISTING "Ask caddie" voice affordance (the round page's pill →
// setCaddieOpen(true), passed in as onOpenCaddie), which already routes
// through the realtime `record_shot` tool. This component owns no write
// path of its own.
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { T } from '@/components/yardage/tokens';
import { haptic } from '@/lib/haptics';
import type { Position } from '@/lib/gps';
import {
  advance,
  createDriftState,
  resetAnchor,
  type DraftSuggestion,
  type DriftState,
} from '@/lib/spike/shot-drift';

export interface PassiveShotDraftBannerProps {
  /** Latest GPS position from the round page's existing GPSWatcher. Pass
   *  the same stream already driving the live rangefinder — no second
   *  watcher, no extra battery cost, no extra permission. */
  position: Position | null;
  /** Opens the EXISTING voice affordance for this route (the round page's
   *  "Ask caddie" pill). This banner never invokes voice or the backend
   *  itself — it only hands off. */
  onOpenCaddie: () => void;
}

/** Structural kill-switch, checked once per mount — off in every real env. */
function spikeEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SPIKE_PASSIVE_SHOTS === '1';
}

export function PassiveShotDraftBanner({ position, onOpenCaddie }: PassiveShotDraftBannerProps) {
  const driftRef = useRef<DriftState | null>(null);
  const [suggestion, setSuggestion] = useState<DraftSuggestion | null>(null);

  useEffect(() => {
    if (!spikeEnabled() || !position) return;
    const sample = {
      lat: position.lat,
      lng: position.lng,
      accuracy: position.accuracy,
      speed: position.speed,
      timestamp: position.timestamp ?? Date.now(),
    };
    if (!driftRef.current) {
      driftRef.current = createDriftState(sample);
      return;
    }
    const { state, suggestion: fired } = advance(driftRef.current, sample);
    driftRef.current = state;
    if (fired) {
      setSuggestion(fired);
      haptic('light'); // quiet nudge — never a modal, never a sound
    }
    // position is an object literal from the caller on every update; compare
    // on its scalar fields so this effect fires exactly once per real fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position?.lat, position?.lng, position?.timestamp]);

  const dismiss = () => {
    if (driftRef.current) {
      const sample = driftRef.current.smoothedPos;
      driftRef.current = resetAnchor(driftRef.current, {
        ...sample,
        timestamp: Date.now(),
      });
    }
    setSuggestion(null);
  };

  const confirm = () => {
    dismiss(); // re-anchor either way — see lib/spike/shot-drift.ts DriftState.anchor doc
    onOpenCaddie(); // hands into the EXISTING voice path; never writes a shot itself
  };

  if (!spikeEnabled()) return null;

  return (
    <AnimatePresence>
      {suggestion && (
        <motion.button
          key="passive-shot-draft"
          onClick={confirm}
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={T.springSoft}
          style={{
            position: 'absolute',
            // Sits just under the round page's top chrome (back button row,
            // ~zIndex 30) rather than fighting it for the same strip.
            top: 'max(64px, calc(env(safe-area-inset-top) + 56px))',
            left: 16,
            right: 16,
            zIndex: 21,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 14px',
            borderRadius: 14,
            border: `1px solid ${T.hairline}`,
            background: T.paper,
            boxShadow: '0 8px 24px rgba(26,42,26,0.14)',
            textAlign: 'left',
            cursor: 'pointer',
          }}
          aria-label="Log a shot draft"
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: suggestion.kind === 'rode' ? T.pencilSoft : T.accent,
              flexShrink: 0,
            }}
          />
          <span style={{ flex: 1, fontFamily: T.sans, fontSize: 13, color: T.ink, lineHeight: 1.35 }}>
            {suggestion.kind === 'rode' ? (
              <>Rode ~{suggestion.estimatedYards}y — probably not a shot. Hold <em style={{ fontFamily: T.serif, fontStyle: 'italic' }}>Ask caddie</em> if it was.</>
            ) : (
              <>You&apos;ve moved ~{suggestion.estimatedYards}y — hold <em style={{ fontFamily: T.serif, fontStyle: 'italic' }}>Ask caddie</em> and say the club to log it.</>
            )}
          </span>
          <span
            role="button"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              dismiss();
            }}
            style={{
              flexShrink: 0,
              width: 22,
              height: 22,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '50%',
              color: T.pencil,
              fontFamily: T.sans,
              fontSize: 14,
            }}
          >
            ×
          </span>
        </motion.button>
      )}
    </AnimatePresence>
  );
}
