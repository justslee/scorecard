'use client';

/**
 * useVoiceCaddie — hold-to-talk realtime caddie for the round screen orb.
 *
 * Owns the side effects around the pure transport ladder
 * (lib/caddie/transport.ts):
 *   press()   → tier 1: mint + connect the WebRTC burst (3s mint deadline),
 *               unmute the mic while held; tier 2/3: report which fallback
 *               surface to open (CaddieSheet / offline card).
 *   release() → mute the mic (server VAD finishes the turn; the model replies
 *               aloud). The connection stays warm for follow-ups and
 *               auto-disconnects after 90s idle (lib/voice/idle-timer.ts).
 *
 * Every completed turn is appended to the round's shared caddie_messages
 * ledger (POST /caddie/session/message) so the text sheet shares history.
 * Downgrades are SILENT — no error toasts, the next surface just opens.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  RealtimeCaddieClient,
  type RealtimeMessage,
  type RealtimeStatus,
} from '@/lib/voice/realtime';
import { warmSession } from '@/lib/voice/warm-session';
import { sortByOrder } from '@/lib/voice/realtime-ordering';
import { appendSessionMessage } from '@/lib/caddie/api';
import { createCaddieTurnTimer } from '@/lib/voice/caddie-turn-timing';
import {
  INITIAL_TRANSPORT_STATE,
  MINT_DEADLINE_MS,
  mapStatusToVoiceState,
  messagesToTurns,
  surfaceForTier,
  transportReducer,
  type TransportTier,
} from '@/lib/caddie/transport';
import type { VoiceState, VoiceTurn } from '@/components/yardage/Voice';

export interface UseVoiceCaddieOptions {
  roundId: string;
  personaId: string;
  /** False for local/offline rounds or before the caddie session starts —
   *  presses go straight to the text sheet (tier 2). */
  enabled: boolean;
  currentHole: number;
  /** Tier 2: open the existing CaddieSheet (Deepgram + Claude text). */
  onDegradeToText: () => void;
  /** Tier 3: open the offline recommendation card (IndexedDB bundle). */
  onOffline: () => void;
}

export interface UseVoiceCaddieResult {
  voiceState: VoiceState;
  turns: VoiceTurn[];
  tier: TransportTier;
  /** Preload a mic-withheld Realtime session so the next press is instant.
   *  Call once when the caddie session becomes available — NOT on every
   *  render (see RoundPageClient's one-shot effect). */
  warm: () => void;
  /** Press the orb/mic. Returns which surface the press opened. */
  press: () => 'voice' | 'text' | 'offline';
  /** Release the mic — mutes input; the model replies aloud. */
  release: () => void;
  /** Hard-stop the burst (leave round). */
  stop: () => void;
}

export function useVoiceCaddie(opts: UseVoiceCaddieOptions): UseVoiceCaddieResult {
  const [transport, dispatch] = useReducer(transportReducer, INITIAL_TRANSPORT_STATE);
  const [status, setStatus] = useState<RealtimeStatus>('idle');
  const [messages, setMessages] = useState<RealtimeMessage[]>([]);
  const [held, setHeld] = useState(false);

  const clientRef = useRef<RealtimeCaddieClient | null>(null);
  const heldRef = useRef(false);
  const mintDeadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const everConnectedRef = useRef(false);
  const degradedRef = useRef(false);
  // Guards warm() so a re-render (or the effect firing more than once) never
  // stacks a second warm attempt; reset once the warm client closes/errors so
  // a later warm() can try again.
  const warmStartedRef = useRef(false);
  // Ledger bookkeeping: message ids already persisted to caddie_messages.
  const persistedIdsRef = useRef<Set<string>>(new Set());
  // Live copies for use inside client callbacks without re-creating the client
  // (assigned in an effect — render-time ref writes trip react-hooks/refs).
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  // Realtime-orb per-turn stage-timing telemetry (silent —
  // specs/caddie-realtime-telemetry-plan.md §1.6). Consumer-only: derived
  // from the status transitions realtime.ts already emits, never from
  // realtime.ts itself.
  const rtTurn = useRef(createCaddieTurnTimer({ surface: 'caddie-rt' })).current;
  const prevStatusRef = useRef<RealtimeStatus>('idle');

  const clearMintDeadline = useCallback(() => {
    if (mintDeadlineRef.current !== null) {
      clearTimeout(mintDeadlineRef.current);
      mintDeadlineRef.current = null;
    }
  }, []);

  const teardownClient = useCallback(() => {
    clearMintDeadline();
    // Detach before stop() — orb-path belt mirroring
    // useCaddieLiveSession.ts's startReconnect() pattern
    // (specs/caddie-realtime-double-emit-plan.md §2 Part B).
    clientRef.current?.setEvents({});
    clientRef.current?.stop();
    clientRef.current = null;
    everConnectedRef.current = false;
    warmStartedRef.current = false;
    warmSession.teardown(); // no-op if nothing warm/consumed
    setStatus('idle');
  }, [clearMintDeadline]);

  /** Silent downgrade to the text sheet — stop the burst, open the fallback. */
  const degradeToText = useCallback(
    (event: 'MINT_TIMEOUT' | 'CONNECT_FAILED' | 'REALTIME_ERROR') => {
      if (degradedRef.current) return;
      degradedRef.current = true;
      dispatch({ type: event });
      teardownClient();
      optsRef.current.onDegradeToText();
    },
    [teardownClient],
  );

  const upsertMessage = useCallback((msg: RealtimeMessage) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === msg.id);
      const merged = idx === -1 ? [...prev, msg] : prev.map((m, j) => (j === idx ? msg : m));
      // Conversation order, not arrival order — see lib/voice/realtime-ordering.ts.
      return sortByOrder(merged);
    });
  }, []);

  /** Shared connection-status handling for BOTH a cold burst's client and an
   *  adopted warm client — one ladder, one place it's driven from. */
  const handleConnectionStatus = useCallback(
    (s: RealtimeStatus) => {
      // A listening -> connected transition is unambiguously speech_stopped
      // (only speech_started sets 'listening') — the honest end-of-speech
      // instant for this path. The FIRST 'speaking' after that is first
      // audio; the timer's once-per-turn guard collapses the many 'speaking'
      // transitions within one response to a single emit + flush (§1.6).
      if (prevStatusRef.current === 'listening' && s === 'connected') {
        rtTurn.markEos();
      }
      if (s === 'speaking') {
        rtTurn.markFirstAudio();
      }
      prevStatusRef.current = s;

      setStatus(s);
      if (s === 'connected' && !everConnectedRef.current) {
        everConnectedRef.current = true;
        dispatch({ type: 'CONNECTED' });
        // Apply the CURRENT hold state — the player may have released
        // (or never released) while the connection was being set up.
        clientRef.current?.setMuted(!heldRef.current);
      }
      if (s === 'closed') {
        if (everConnectedRef.current) {
          // Clean close (90s idle disconnect) — tier stays healthy.
          dispatch({ type: 'DISCONNECTED' });
          clientRef.current = null;
          everConnectedRef.current = false;
          // Allow a fresh warm() so the NEXT press is also instant, not just
          // the first press of the session (review finding).
          warmStartedRef.current = false;
        } else {
          // Tier-1 failure condition #2: ICE/SDP failed before going live.
          degradeToText('CONNECT_FAILED');
        }
      }
      if (s === 'error') {
        if (!everConnectedRef.current) degradeToText('CONNECT_FAILED');
        else degradeToText('REALTIME_ERROR');
      }
    },
    // `rtTurn` (a useRef .current) is stable for the component's lifetime —
    // listed for exhaustiveness only.
    [degradeToText, rtTurn],
  );

  const startBurst = useCallback(() => {
    if (clientRef.current) return;
    degradedRef.current = false;
    dispatch({ type: 'PRESS' });

    // Tier-1 failure condition #1: mint slower than the 3s budget.
    mintDeadlineRef.current = setTimeout(() => {
      mintDeadlineRef.current = null;
      degradeToText('MINT_TIMEOUT');
    }, MINT_DEADLINE_MS);

    const client = new RealtimeCaddieClient(
      { roundId: optsRef.current.roundId, personalityId: optsRef.current.personaId },
      {
        onMinted: () => {
          clearMintDeadline();
          dispatch({ type: 'MINT_OK' });
        },
        onStatus: handleConnectionStatus,
        onMessage: upsertMessage,
      },
    );
    clientRef.current = client;
    client.start().catch(() => {
      // start() rejection (mint 4xx/5xx, mic denied, SDP failure) — degrade.
      degradeToText('CONNECT_FAILED');
    });
    // Mic live from the first frame of the hold (tracks start enabled).
  }, [clearMintDeadline, degradeToText, handleConnectionStatus, upsertMessage]);

  /** Preload a mic-withheld Realtime session (lib/voice/warm-session.ts) so a
   *  later press() can adopt it instead of cold-minting. Dispatches the SAME
   *  PRESS→MINT_OK→CONNECTED events a cold burst would — off the warm
   *  client's OBSERVED status — so transportReducer's phase tracks reality
   *  even though nothing has been pressed yet. No mic is ever attached here. */
  const warm = useCallback(() => {
    if (clientRef.current || warmStartedRef.current) return;
    warmStartedRef.current = true;
    dispatch({ type: 'PRESS' });
    warmSession.warm(
      { kind: 'caddie', roundId: optsRef.current.roundId, personalityId: optsRef.current.personaId },
      {
        onMinted: () => dispatch({ type: 'MINT_OK' }),
        onStatus: (s) => {
          if (s === 'connected') dispatch({ type: 'CONNECTED' });
          else if (s === 'closed' || s === 'error') {
            warmStartedRef.current = false; // allow a later warm() to retry
            dispatch({ type: 'DISCONNECTED' });
          }
        },
      },
    );
  }, []);

  /** Adopt a warm client at press-time: rebind handlers, repaint the current
   *  status, then open the mic — the ONLY getUserMedia call in this path. */
  const adoptWarmClient = useCallback(
    (client: RealtimeCaddieClient) => {
      degradedRef.current = false;
      dispatch({ type: 'PRESS' });
      dispatch({ type: 'MINT_OK' }); // already minted during warm — advance the ladder to match
      clientRef.current = client;
      client.setEvents({ onStatus: handleConnectionStatus, onMessage: upsertMessage });
      client.emitCurrentStatus(); // paint the CURRENT state (often already connected)
      client
        .attachMic()
        .then(() => {
          client.setMuted(!heldRef.current);
        })
        .catch(() => {
          // attachMic() already pushed status 'error' through the handler
          // above, which routes to degradeToText via handleConnectionStatus.
        });
    },
    [handleConnectionStatus, upsertMessage],
  );

  const press = useCallback((): 'voice' | 'text' | 'offline' => {
    // Fully offline → tier 3 immediately (no point minting).
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      dispatch({ type: 'WENT_OFFLINE' });
      optsRef.current.onOffline();
      return 'offline';
    }
    // No caddie session (local round / start failed) → the text sheet is the top tier.
    const surface = optsRef.current.enabled ? surfaceForTier(transport.tier) : 'text';
    if (surface === 'text') {
      optsRef.current.onDegradeToText();
      return 'text';
    }
    if (surface === 'offline') {
      optsRef.current.onOffline();
      return 'offline';
    }

    heldRef.current = true;
    setHeld(true);
    if (clientRef.current) {
      clientRef.current.setMuted(false); // warm connection — just open the mic
    } else {
      const warmClient = warmSession.takeWarm({
        kind: 'caddie',
        roundId: optsRef.current.roundId,
        personalityId: optsRef.current.personaId,
      });
      if (warmClient) {
        adoptWarmClient(warmClient);
      } else {
        startBurst();
      }
    }
    return 'voice';
  }, [adoptWarmClient, startBurst, transport.tier]);

  const release = useCallback(() => {
    heldRef.current = false;
    setHeld(false);
    clientRef.current?.setMuted(true);
  }, []);

  const stop = useCallback(() => {
    heldRef.current = false;
    setHeld(false);
    teardownClient();
  }, [teardownClient]);

  // ── Shared ledger: persist each completed turn pair ──
  useEffect(() => {
    if (!opts.enabled) return;
    const persisted = persistedIdsRef.current;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== 'assistant' || m.partial || !m.text.trim() || persisted.has(m.id)) continue;
      // Pair with the nearest preceding un-persisted user turn (may be absent
      // when the caddie speaks first).
      let userTurn: RealtimeMessage | undefined;
      for (let j = i - 1; j >= 0; j--) {
        const c = messages[j];
        if (c.role === 'user' && !persisted.has(c.id) && c.text.trim()) {
          userTurn = c;
          break;
        }
        if (c.role === 'assistant' && persisted.has(c.id)) break;
      }
      persisted.add(m.id);
      if (userTurn) persisted.add(userTurn.id);
      appendSessionMessage({
        round_id: opts.roundId,
        user_content: userTurn?.text,
        assistant_content: m.text,
        hole_number: opts.currentHole,
      }).catch(() => {
        // Fire-and-forget — the ledger is context, never a failure surface.
      });
    }
  }, [messages, opts.enabled, opts.roundId, opts.currentHole]);

  // ── Silent tier-1 retry on hole change (fresh cell, fresh chance) ──
  const lastHoleRef = useRef(opts.currentHole);
  useEffect(() => {
    if (opts.currentHole !== lastHoleRef.current) {
      lastHoleRef.current = opts.currentHole;
      if (transport.tier === 'text') dispatch({ type: 'RETRY_REALTIME' });
    }
  }, [opts.currentHole, transport.tier]);

  // ── Network transitions drive the ladder's top/bottom rungs ──
  useEffect(() => {
    const goOffline = () => {
      dispatch({ type: 'WENT_OFFLINE' });
      teardownClient();
    };
    const goOnline = () => dispatch({ type: 'BACK_ONLINE' });
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, [teardownClient]);

  // Disconnect when leaving the round screen — also tears down an un-adopted
  // warm session rather than leaving a billed zombie connection behind.
  useEffect(() => {
    return () => {
      clientRef.current?.stop();
      clientRef.current = null;
      warmSession.teardown();
    };
  }, []);

  return {
    voiceState: mapStatusToVoiceState(status, held),
    turns: messagesToTurns(messages),
    tier: transport.tier,
    warm,
    press,
    release,
    stop,
  };
}
