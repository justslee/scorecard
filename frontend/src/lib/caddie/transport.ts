/**
 * CaddieTransport — the degradation ladder for the in-round voice orb.
 *
 *   Tier 1  realtime  — OpenAI Realtime WebRTC burst (hold-to-talk, spoken replies)
 *   Tier 2  text      — the existing CaddieSheet (Deepgram STT + Claude text)
 *   Tier 3  offline   — static recommendation card from the IndexedDB
 *                       HoleIntelBundle cached at session start
 *
 * Tier 1 fails DOWN to tier 2 when the mint takes >3s or the WebRTC
 * connection fails (flaky course cell); losing the network entirely drops to
 * tier 3. Downgrades are SILENT — the orb simply opens the next surface down
 * (Northstar: calm, no error toasts).
 *
 * This module is a PURE state machine (reducer + mapping helpers). All side
 * effects — starting the WebRTC client, arming the 3s mint deadline, opening
 * sheets — are injected by the caller (hooks/useVoiceCaddie.ts), so every
 * transition is unit-testable without a browser.
 */

import type { RealtimeMessage, RealtimeStatus } from '@/lib/voice/realtime';
import type { VoiceState, VoiceTurn } from '@/components/yardage/Voice';

// ── Ladder state ─────────────────────────────────────────────────────────

/** If the backend hasn't returned a mint within this budget, drop to tier 2. */
export const MINT_DEADLINE_MS = 3000;

export type TransportTier = 'realtime' | 'text' | 'offline';

/** Connection phase within the realtime tier (idle between bursts is normal). */
export type TransportPhase = 'idle' | 'minting' | 'connecting' | 'live';

export interface TransportState {
  tier: TransportTier;
  phase: TransportPhase;
  /** Why we degraded (diagnostics only — never shown to the player). */
  downgradeReason: string | null;
}

export const INITIAL_TRANSPORT_STATE: TransportState = {
  tier: 'realtime',
  phase: 'idle',
  downgradeReason: null,
};

export type TransportEvent =
  | { type: 'PRESS' } //             orb pressed → begin a burst (mint starts)
  | { type: 'MINT_OK' } //           ephemeral secret arrived within budget
  | { type: 'MINT_TIMEOUT' } //      mint exceeded MINT_DEADLINE_MS → tier 2
  | { type: 'CONNECTED' } //         WebRTC peer connection is live
  | { type: 'CONNECT_FAILED' } //    ICE/SDP failure before going live → tier 2
  | { type: 'REALTIME_ERROR' } //    fatal error mid-burst → tier 2
  | { type: 'DISCONNECTED' } //      clean close (90s idle) — stay on tier 1
  | { type: 'WENT_OFFLINE' } //      navigator offline → tier 3
  | { type: 'BACK_ONLINE' } //       network restored → climb back to tier 1
  | { type: 'RETRY_REALTIME' }; //   silent tier-1 retry (e.g. on hole change)

const degrade = (reason: string): TransportState => ({
  tier: 'text',
  phase: 'idle',
  downgradeReason: reason,
});

/** Pure transition function — the whole ladder lives here. */
export function transportReducer(
  state: TransportState,
  event: TransportEvent,
): TransportState {
  // Network loss/restore outranks everything else.
  if (event.type === 'WENT_OFFLINE') {
    return { tier: 'offline', phase: 'idle', downgradeReason: 'offline' };
  }
  if (event.type === 'BACK_ONLINE') {
    // Climb back to the top of the ladder — the next press retries realtime.
    return state.tier === 'offline' ? { ...INITIAL_TRANSPORT_STATE } : state;
  }

  switch (state.tier) {
    case 'realtime':
      switch (event.type) {
        case 'PRESS':
          // Warm connection → nothing to do; cold → the caller mints.
          return state.phase === 'live' || state.phase === 'connecting' || state.phase === 'minting'
            ? state
            : { ...state, phase: 'minting' };
        case 'MINT_OK':
          return state.phase === 'minting' ? { ...state, phase: 'connecting' } : state;
        case 'MINT_TIMEOUT':
          return state.phase === 'minting' ? degrade('mint_timeout') : state;
        case 'CONNECTED':
          return { ...state, phase: 'live' };
        case 'CONNECT_FAILED':
          return state.phase === 'live' ? state : degrade('connect_failed');
        case 'REALTIME_ERROR':
          return degrade('realtime_error');
        case 'DISCONNECTED':
          // Clean idle close — the burst ended, the tier is still healthy.
          return { ...state, phase: 'idle' };
        default:
          return state;
      }
    case 'text':
      // Only an explicit retry climbs back to tier 1; everything else stays
      // calm on the text sheet (no flapping mid-round).
      return event.type === 'RETRY_REALTIME' ? { ...INITIAL_TRANSPORT_STATE } : state;
    case 'offline':
      // Only BACK_ONLINE (handled above) leaves tier 3.
      return state;
  }
}

/** Which surface an orb press should open in the given state. */
export function surfaceForTier(tier: TransportTier): 'voice' | 'text' | 'offline' {
  if (tier === 'realtime') return 'voice';
  return tier;
}

// ── Realtime ↔ yardage-book UI mapping ──────────────────────────────────

/**
 * Map the Realtime client's connection status onto the VoiceSheet's four
 * visual states. `held` = the player is holding the mic (hold-to-talk), which
 * reads as "listening" even before server VAD confirms speech.
 */
export function mapStatusToVoiceState(status: RealtimeStatus, held: boolean): VoiceState {
  switch (status) {
    case 'connecting':
      return 'thinking'; // calm "one sec" while the burst spins up
    case 'listening':
      return 'listening';
    case 'speaking':
      return 'speaking';
    case 'connected':
      return held ? 'listening' : 'idle';
    case 'idle':
    case 'closed':
    case 'error':
    default:
      return 'idle';
  }
}

/**
 * Map the live Realtime transcript onto the VoiceSheet's turn list.
 * Messages arrive pre-sorted by conversation order (see realtime-ordering.ts);
 * empty partials are dropped so the sheet never renders a blank bubble.
 */
export function messagesToTurns(messages: RealtimeMessage[]): VoiceTurn[] {
  return messages
    .filter((m) => m.text.trim().length > 0)
    .map((m) => ({ role: m.role === 'user' ? ('user' as const) : ('caddy' as const), text: m.text }));
}
