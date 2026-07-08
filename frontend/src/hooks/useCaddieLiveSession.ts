"use client";

/**
 * useCaddieLiveSession — Realtime transport lifecycle for CaddieSheet's live
 * mode (specs/caddie-realtime-slice-c1-plan.md §3).
 *
 * A THIRD consumer of the same public warm-pool seams already used by
 * VoiceRoundSetupRealtime (round setup) and useVoiceCaddie (the round-page
 * orb): `warmSession.takeWarm` → `setEvents`/`emitCurrentStatus`/`attachMic`,
 * or a cold `new RealtimeCaddieClient(...)` → `start()`. This hook never
 * touches realtime.ts / warm-session.ts / realtime-ordering.ts internals —
 * it only calls their existing public methods.
 *
 * Honest degradation (never a dead sheet): if the mint takes longer than
 * `MINT_DEADLINE_MS`, or the connection closes/errors before ever reaching
 * `connected`, or `attachMic()` rejects (mic permission denied), `fellBack`
 * flips true. The caller (CaddieSheet) then renders the classic tap-to-talk
 * path with a calm "Tap-to-talk mode" indicator instead of this hook's live
 * transcript view.
 *
 * Opening turn: once the client has both connected at least once AND the mic
 * has been attached/acquired, `resolveOpeningShot()` (parent-owned GPS) is
 * awaited exactly once per activation; a resolved shot is spoken as the
 * caddie's first turn via the existing `sendText` seam (which already
 * surfaces it as a user bubble) — never a new realtime.ts method.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  RealtimeCaddieClient,
  type RealtimeCaddieEvents,
  type RealtimeMessage,
  type RealtimeStatus,
} from "@/lib/voice/realtime";
import { warmSession } from "@/lib/voice/warm-session";
import { sortByOrder } from "@/lib/voice/realtime-ordering";
import { MINT_DEADLINE_MS } from "@/lib/caddie/transport";
import { buildOpeningTurnText, type OpeningShot } from "@/lib/caddie/opening-turn";

export type CaddieLiveState = "connecting" | "live" | "fallback";

export interface UseCaddieLiveSessionOptions {
  /** Gate: flag ON && sessionActive && sheet open && navigator.onLine
   *  (the caller computes this — see CaddieSheet.tsx). */
  active: boolean;
  roundId: string;
  personaId: string;
  resolveOpeningShot?: () => Promise<OpeningShot | null>;
}

export interface UseCaddieLiveSessionResult {
  liveState: CaddieLiveState;
  /** True once this activation has fallen back to the classic path. */
  fellBack: boolean;
  /** Already sortByOrder'd — render as-is. */
  messages: RealtimeMessage[];
  status: RealtimeStatus;
  muted: boolean;
  toggleMute: () => void;
  /** Tear the live client down (e.g. on sheet close). */
  stop: () => void;
}

export function useCaddieLiveSession({
  active,
  roundId,
  personaId,
  resolveOpeningShot,
}: UseCaddieLiveSessionOptions): UseCaddieLiveSessionResult {
  const [liveState, setLiveState] = useState<CaddieLiveState>("connecting");
  const [status, setStatus] = useState<RealtimeStatus>("idle");
  const [messages, setMessages] = useState<RealtimeMessage[]>([]);
  const [muted, setMuted] = useState(false);

  const clientRef = useRef<RealtimeCaddieClient | null>(null);
  const mountedRef = useRef(true);
  const mintDeadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const everConnectedRef = useRef(false);
  const micReadyRef = useRef(false);
  const openedTurnRef = useRef(false);
  const fellBackRef = useRef(false);

  const resolveOpeningShotRef = useRef(resolveOpeningShot);
  useEffect(() => {
    resolveOpeningShotRef.current = resolveOpeningShot;
  }, [resolveOpeningShot]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clearMintDeadline = useCallback(() => {
    if (mintDeadlineRef.current !== null) {
      clearTimeout(mintDeadlineRef.current);
      mintDeadlineRef.current = null;
    }
  }, []);

  /** Fall to the classic path. Idempotent — the first caller wins. */
  const fallBack = useCallback(() => {
    if (fellBackRef.current) return;
    fellBackRef.current = true;
    clearMintDeadline();
    if (mountedRef.current) setLiveState("fallback");
    clientRef.current?.stop();
    clientRef.current = null;
  }, [clearMintDeadline]);

  const upsert = useCallback((m: RealtimeMessage) => {
    if (!mountedRef.current) return;
    setMessages((prev) => {
      const i = prev.findIndex((x) => x.id === m.id);
      const merged = i === -1 ? [...prev, m] : prev.map((x, j) => (j === i ? m : x));
      // Conversation order, not arrival order — see lib/voice/realtime-ordering.ts.
      return sortByOrder(merged);
    });
  }, []);

  /** Fires the opening turn exactly once, once BOTH the mic is ready and the
   *  client has connected at least once (order-independent — whichever
   *  happens second calls this and both guards are already true). */
  const maybeFireOpeningTurn = useCallback(() => {
    if (openedTurnRef.current) return;
    if (!micReadyRef.current || !everConnectedRef.current) return;
    openedTurnRef.current = true;
    const resolve = resolveOpeningShotRef.current;
    if (!resolve) return; // parent opted out → live and simply listening
    void (async () => {
      const shot = await resolve();
      if (!mountedRef.current || fellBackRef.current) return;
      if (!shot) return; // no GPS fix → honest idle, exactly like the classic path
      clientRef.current?.sendText(buildOpeningTurnText(shot));
    })();
  }, []);

  useEffect(() => {
    if (!active) {
      // Reset so the NEXT activation starts clean.
      fellBackRef.current = false;
      everConnectedRef.current = false;
      micReadyRef.current = false;
      openedTurnRef.current = false;
      clearMintDeadline();
      clientRef.current?.stop();
      clientRef.current = null;
      setLiveState("connecting");
      setStatus("idle");
      setMessages([]);
      setMuted(false);
      return;
    }

    let cancelled = false;
    fellBackRef.current = false;
    everConnectedRef.current = false;
    micReadyRef.current = false;
    openedTurnRef.current = false;
    setLiveState("connecting");
    setStatus("idle");
    setMessages([]);
    setMuted(false);

    const events: RealtimeCaddieEvents = {
      onStatus: (s) => {
        if (cancelled || !mountedRef.current) return;
        setStatus(s);
        if (s === "connected") {
          if (!everConnectedRef.current) {
            everConnectedRef.current = true;
            clearMintDeadline();
            setLiveState((prev) => (prev === "fallback" ? prev : "live"));
          }
          maybeFireOpeningTurn();
        } else if ((s === "closed" || s === "error") && !everConnectedRef.current) {
          fallBack();
        }
      },
      onMessage: upsert,
      onError: () => {
        if (cancelled) return;
        if (!everConnectedRef.current) fallBack();
      },
    };

    mintDeadlineRef.current = setTimeout(() => {
      mintDeadlineRef.current = null;
      if (!everConnectedRef.current) fallBack();
    }, MINT_DEADLINE_MS);

    void (async () => {
      // Adopt a warm (mic-withheld) session if one is already up for this
      // exact intent. Stage-1 reality (specs/caddie-realtime-slice-c1-plan.md
      // §3.1): the "Ask caddie" one-mic guard already tears warm sessions
      // down before opening this sheet, so takeWarm usually returns null and
      // the sheet cold-mints — that is correct and safe. Still call takeWarm
      // first so the adopt path lights up for free once that's refined.
      const warm = warmSession.takeWarm({ kind: "caddie", roundId, personalityId: personaId });
      if (warm) {
        clientRef.current = warm;
        warm.setEvents(events);
        warm.emitCurrentStatus(); // paint the current state immediately
        try {
          await warm.attachMic();
          if (cancelled) return;
          micReadyRef.current = true;
          maybeFireOpeningTurn();
        } catch {
          if (!cancelled) fallBack(); // mic-deny (or a half-built warm client)
        }
        return;
      }

      // Cold mint — presence of `roundId` (no `mode` field) selects caddie
      // mode, exactly as useVoiceCaddie's startBurst().
      const client = new RealtimeCaddieClient({ roundId, personalityId: personaId }, events);
      clientRef.current = client;
      try {
        await client.start();
        if (cancelled) return;
        // A cold (non-withheld) client already has `opened = true` from
        // construction, so this is a no-op on the real client (realtime.ts's
        // `if (this.opened) return;` guard) — called uniformly so "mic
        // ready" means the same thing on both the warm and cold branches.
        await client.attachMic();
        if (cancelled) return;
        micReadyRef.current = true;
        maybeFireOpeningTurn();
      } catch {
        if (!cancelled) fallBack();
      }
    })();

    return () => {
      cancelled = true;
      clearMintDeadline();
      clientRef.current?.stop();
      clientRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, roundId, personaId]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    clientRef.current?.setMuted(next);
    setMuted(next);
  }, [muted]);

  const stop = useCallback(() => {
    clearMintDeadline();
    clientRef.current?.stop();
    clientRef.current = null;
  }, [clearMintDeadline]);

  return {
    liveState,
    fellBack: liveState === "fallback",
    messages,
    status,
    muted,
    toggleMute,
    stop,
  };
}
