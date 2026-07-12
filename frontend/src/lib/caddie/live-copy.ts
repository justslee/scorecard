/**
 * Pure copy helpers for the live-mode (Realtime) caddie sheet
 * (specs/caddie-voice-reliability-hardening-plan.md §3).
 *
 * Extracted from CaddieSheet.tsx so the empty-state hint and the footer's
 * status label can be tested together against a single invariant: the empty
 * state must never claim the caddy "is listening" while the footer claims
 * "speaking" — status goes 'speaking' the instant audio starts playing (a
 * held clarifier can hold that state for up to ~2s), and two honest-states
 * claims disagreeing on screen at once is exactly the no-fake-data /
 * honest-states bug this closes.
 */

import type { RealtimeStatus } from '@/lib/voice/realtime';

/** Live-mode (Realtime) status → calm footer copy
 *  (specs/caddie-realtime-slice-c1-plan.md §5). Mirrors
 *  VoiceRoundSetupRealtime's STATUS_LABEL. */
export const LIVE_STATUS_LABEL: Record<RealtimeStatus, string> = {
  idle: 'Connecting…',
  connecting: 'Connecting…',
  connected: 'Ready — go ahead',
  listening: 'Listening…',
  speaking: 'Caddie speaking…',
  closed: 'Ended',
  error: "Couldn't connect",
};

/**
 * The empty-transcript hint shown in the live-mode body before any messages
 * exist. Must agree with `LIVE_STATUS_LABEL[status]` — in particular, while
 * the footer says "Caddie speaking…" (status === 'speaking', audio IS
 * playing), the empty state must not claim the caddy "is listening".
 *
 * `closed`/`error` need no dedicated branch here: `paused` flips true on
 * suspend before either status is reached live, and the classic-mode
 * fallback swaps the whole body out within the same render — so those
 * statuses never actually reach this helper in practice.
 */
export function liveEmptyStateHint(status: RealtimeStatus, paused: boolean, name: string): string {
  if (paused) return 'Paused — tap resume below to keep talking.';
  if (status === 'connecting' || status === 'idle') return `Connecting to ${name}…`;
  if (status === 'speaking') return `${name} is speaking.`;
  return `Go ahead — ${name} is listening.`;
}
