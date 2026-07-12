// Full-screen overlay registry (specs/caddie-orb-map-mode-ghost-plan.md).
//
// A full-screen overlay that OWNS the screen (CourseSearch today) registers
// on mount / unregisters on unmount; the omnipresent CaddieOrb subscribes and
// renders NOTHING while ≥1 overlay is registered — truly absent, not merely
// out-stacked (a transparent map-mode overlay cannot occlude an opaque orb).
// Module-level Set + tiny subscription in the spirit of caddie-context.ts:
// pure (no window, no React), SSR-inert, unit-testable, no provider threading.
//
// Opt-in ONLY: normal scrimmed/opaque sheets that already stack above the orb
// (PlayerModal, VoiceRoundSetupRealtime's backdrop, the round/new and
// tournament picker scrims — all z52 per 6ff2b0a) must NOT register; the
// scrim-dims-the-orb behavior there is intentional.

const overlays = new Set<symbol>();
const listeners = new Set<(active: boolean) => void>();

function notifyIfFlipped(before: boolean): void {
  const after = overlays.size > 0;
  if (after === before) return;
  for (const cb of listeners) cb(after);
}

/**
 * Register a full-screen overlay. Returns the unregister fn. Each call mints
 * a unique token, so a StrictMode double-register just stacks two tokens, and
 * a stale or duplicate unregister (Set.delete of an absent token) is a no-op
 * that can never clobber a live overlay.
 */
export function registerFullscreenOverlay(): () => void {
  const token = Symbol("fullscreen-overlay");
  const before = overlays.size > 0;
  overlays.add(token);
  notifyIfFlipped(before);
  return () => {
    const before = overlays.size > 0;
    overlays.delete(token);
    notifyIfFlipped(before);
  };
}

/** True while ≥1 full-screen overlay is registered. */
export function isFullscreenOverlayActive(): boolean {
  return overlays.size > 0;
}

/** Subscribe to active-flag FLIPS (never per-registration churn). Returns the unsubscribe. */
export function onFullscreenOverlayChange(cb: (active: boolean) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
