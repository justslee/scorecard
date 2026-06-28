'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RealtimeCaddieClient,
  type RealtimeMessage,
  type RealtimeStatus,
} from '@/lib/voice/realtime';
import { sortByOrder } from '@/lib/voice/realtime-ordering';

export interface UseRealtimeCaddieOptions {
  roundId: string;
  personalityId: string;
}

export interface UseRealtimeCaddieResult {
  status: RealtimeStatus;
  messages: RealtimeMessage[];
  error: Error | null;
  isMuted: boolean;
  start: () => Promise<void>;
  stop: () => void;
  toggleMute: () => void;
  sendText: (text: string) => void;
}

export function useRealtimeCaddie(opts: UseRealtimeCaddieOptions): UseRealtimeCaddieResult {
  const [status, setStatus] = useState<RealtimeStatus>('idle');
  const [messages, setMessages] = useState<RealtimeMessage[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const clientRef = useRef<RealtimeCaddieClient | null>(null);

  const upsertMessage = useCallback((msg: RealtimeMessage) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === msg.id);
      const merged = idx === -1 ? [...prev, msg] : prev.map((m, j) => (j === idx ? msg : m));
      // Conversation order, not arrival order — the user transcript event lands
      // after the reply it triggered. See lib/voice/realtime-ordering.ts.
      return sortByOrder(merged);
    });
  }, []);

  const start = useCallback(async () => {
    if (clientRef.current) return;
    setError(null);
    const client = new RealtimeCaddieClient(opts, {
      onStatus: setStatus,
      onMessage: upsertMessage,
      onError: setError,
    });
    clientRef.current = client;
    try {
      await client.start();
    } catch {
      clientRef.current = null;
    }
  }, [opts, upsertMessage]);

  const stop = useCallback(() => {
    clientRef.current?.stop();
    clientRef.current = null;
    setStatus('idle');
  }, []);

  const toggleMute = useCallback(() => {
    if (!clientRef.current) return;
    const next = !isMuted;
    clientRef.current.setMuted(next);
    setIsMuted(next);
  }, [isMuted]);

  const sendText = useCallback((text: string) => {
    // The client emits the typed user line via onMessage (with a proper order
    // key), so it sorts correctly relative to the reply — no manual upsert here.
    clientRef.current?.sendText(text);
  }, []);

  useEffect(() => {
    return () => {
      clientRef.current?.stop();
      clientRef.current = null;
    };
  }, []);

  return { status, messages, error, isMuted, start, stop, toggleMute, sendText };
}
