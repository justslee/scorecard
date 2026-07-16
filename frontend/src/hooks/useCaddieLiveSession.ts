"use client";

/**
 * useCaddieLiveSession — Realtime transport lifecycle for CaddieSheet's live
 * mode (specs/caddie-realtime-slice-c1-plan.md §3, extended by
 * specs/caddie-realtime-slice-d-plan.md for post-connected resilience).
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
 * awaited exactly once per activation; a resolved shot is spoken by the
 * model itself via the `sendOpener` seam (system-role instruction +
 * response.create, no local `onMessage` — never a fabricated user bubble;
 * specs/caddie-remove-seeded-question-plan.md).
 *
 * Slice D — post-connected resilience (specs/caddie-realtime-slice-d-plan.md):
 * realtime.ts collapses a clean 90s idle disconnect and an unexpected network
 * drop into the same `'closed'` status (no discriminator on the public event
 * surface). This hook keeps a local "last activity" clock to classify a
 * post-connected close as clean-idle (rest calmly) or a drop (attempt ONE
 * quiet cold-mint reconnect, preserving `messages`/`openedTurnRef`; a second
 * drop, the reconnect's own failure, or its deadline falls to the classic
 * tap-to-talk path). See §2/§3 of the plan for the full state machine.
 *
 * Slice E — idle suspend/resume (specs/caddie-realtime-slice-e-plan.md): a
 * clean-idle close used to be a dishonest dead-end (`liveState` stayed
 * `"live"` with a dead socket, no resume path). It now transitions to a
 * visible `"suspended"` state (transcript preserved) with a user-triggered
 * `resume()` that cold-mints a fresh client and continues the SAME
 * conversation (no re-greet, cross-client order offset applied) — reusing
 * Slice D's reconnecting sub-phase verbatim. `resume()` does NOT consume
 * Slice D's one-reconnect-per-activation budget; it RESETS it, so a real
 * drop after a resume still gets its own auto-reconnect (§3.4 of the plan).
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
import { REALTIME_IDLE_DISCONNECT_MS } from "@/lib/voice/idle-timer";
import {
  buildOpeningGreetingInstruction,
  buildHoleContextText,
  type OpeningShot,
  type HoleContext,
} from "@/lib/caddie/opening-turn";
import { voiceEvent } from "@/lib/voice/telemetry";

export type CaddieLiveState = "connecting" | "live" | "suspended" | "fallback";

/** Margin subtracted from REALTIME_IDLE_DISCONNECT_MS to absorb same-tick
 *  clock skew between this hook's activity mirror and realtime.ts's own
 *  IdleTimer — see specs/caddie-realtime-slice-d-plan.md §3. */
const IDLE_MARGIN_MS = 1500;

export interface UseCaddieLiveSessionOptions {
  /** Gate: flag ON && sessionActive && sheet open && navigator.onLine
   *  (the caller computes this — see CaddieSheet.tsx). */
  active: boolean;
  roundId: string;
  personaId: string;
  /** Current hole facts (specs/caddie-stale-hole-live-plan.md §3.3) — used to
   *  silently re-anchor the live session on connect and on every hole change
   *  so the caddie never answers from a stale minted hole. */
  holeNumber: number;
  holePar: number;
  /** Resolved yardage (lib/caddie/hole-yardage.ts) — null when nothing honest
   *  is known yet. NEVER the mock illustration constant. */
  holeYards: number | null;
  /** Provenance of `holeYards` — a flip (e.g. GPS acquired/lost) re-anchors
   *  the live session even when the hole number hasn't changed
   *  (specs/caddie-yardage-gps-selected-tee-plan.md §2.3). */
  yardageBasis?: 'gps' | 'tee-card' | 'tee-geom' | 'card' | null;
  teeName?: string | null;
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
  /** User-triggered resume from `liveState === "suspended"` — cold-mints a
   *  fresh client and continues the same conversation (no re-greet). */
  resume: () => void;
  /** Tear the live client down (e.g. on sheet close). */
  stop: () => void;
}

export function useCaddieLiveSession({
  active,
  roundId,
  personaId,
  holeNumber,
  holePar,
  holeYards,
  yardageBasis = null,
  teeName = null,
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
  /** The hole number this activation's live session was last re-anchored to
   *  (specs/caddie-stale-hole-live-plan.md §3.3-3.5). Null = never anchored
   *  yet this activation (connect covers it). Guards against a redundant
   *  `sendContext` when the hole-change effect re-runs at the same hole. */
  const anchoredHoleRef = useRef<number | null>(null);
  /** The yardage basis this activation last re-anchored to (specs/
   *  caddie-yardage-gps-selected-tee-plan.md §2.3) — a flip at the SAME hole
   *  (e.g. GPS acquired mid-hole) also triggers a silent re-anchor. */
  const anchoredBasisRef = useRef<UseCaddieLiveSessionOptions["yardageBasis"]>(null);

  // ── Slice D reconnect state machine refs ──────────────────────────────
  /** One reconnect per activation — bounds a flapping signal to a single
   *  quiet re-mint instead of an unbounded silent loop (plan §2 "one
   *  reconnect per activation"). */
  const reconnectUsedRef = useRef(false);
  /** True while a reconnect attempt is in flight. */
  const reconnectingRef = useRef(false);
  /** True once a reconnect has begun this activation — gates the order
   *  offset in `upsert` (§2.3). Never cleared mid-activation. */
  const reconnectedRef = useRef(false);
  const reconnectDeadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Date.now() of last observed activity — the hook-local idle mirror
   *  used to classify a post-connected close as clean-idle vs. a drop (§3). */
  const lastActivityAtRef = useRef(0);
  /** Cross-client transcript ordering (§2.3): a fresh reconnect client's
   *  MessageOrderTracker restarts near 0, so incoming messages are offset
   *  by `maxOrderRef + 1` (captured at reconnect time) to sort strictly
   *  after everything the dead client already produced. */
  const orderOffsetRef = useRef(0);
  const maxOrderRef = useRef(0);
  /** Mirror of `muted` so a reconnect's fresh client can re-apply it. */
  const mutedRef = useRef(false);

  // ── Slice E idle suspend/resume refs ───────────────────────────────────
  /** Mirror of `liveState==='suspended'` for use inside `onStatus`/callbacks
   *  (plan §2.2). Reset on (re)activation like the others. */
  const suspendedRef = useRef(false);
  /** The activation effect's `doResume()` closure (needs `events`/
   *  `cancelled`/`roundId`/`personaId`) — the returned stable `resume()`
   *  calls through this. Cleared in effect cleanup (plan §2.2/§3.3). */
  const resumeImplRef = useRef<(() => void) | null>(null);

  const resolveOpeningShotRef = useRef(resolveOpeningShot);
  useEffect(() => {
    resolveOpeningShotRef.current = resolveOpeningShot;
  }, [resolveOpeningShot]);

  /** Mirror of the current hole facts — read by the connect/reconnect/resume
   *  callbacks (empty dep arrays) so they always re-anchor to the LATEST
   *  hole, not the one captured at mount (specs/caddie-stale-hole-live-plan.md
   *  §3.3). */
  const holeContextRef = useRef<HoleContext>({
    holeNumber, par: holePar, yards: holeYards, basis: yardageBasis, teeName,
  });
  useEffect(() => {
    holeContextRef.current = { holeNumber, par: holePar, yards: holeYards, basis: yardageBasis, teeName };
  }, [holeNumber, holePar, holeYards, yardageBasis, teeName]);

  /** Stable getter bound to every client this hook creates/adopts
   *  (`client.setToolContext(...)`) — reads `holeContextRef` live, so
   *  `get_recommendation` dispatch always carries THIS turn's resolved
   *  yardage/basis, the same values `anchorHole()` feeds `buildHoleContextText`
   *  (specs/caddie-numbers-coherence-plan.md §2.1). */
  const getToolContext = useCallback(
    () => ({ holeYards: holeContextRef.current.yards, yardageBasis: holeContextRef.current.basis }),
    [],
  );

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

  const clearReconnectDeadline = useCallback(() => {
    if (reconnectDeadlineRef.current !== null) {
      clearTimeout(reconnectDeadlineRef.current);
      reconnectDeadlineRef.current = null;
    }
  }, []);

  /** Fall to the classic path. Idempotent — the first caller wins. */
  const fallBack = useCallback(() => {
    if (fellBackRef.current) return;
    fellBackRef.current = true;
    clearMintDeadline();
    clearReconnectDeadline();
    reconnectingRef.current = false;
    if (mountedRef.current) setLiveState("fallback");
    // Detach BEFORE stop() — mirrors startReconnect()'s dead?.setEvents({})
    // pattern (specs/caddie-realtime-double-emit-plan.md §2 Part B). Without
    // this, a client that is still mid-mint (e.g. the 3s deadline raced
    // start()) keeps this activation's `onMessage: upsert` bound; any late
    // event it delivers after fallBack() would otherwise still land in
    // `messages` via mountedRef alone.
    clientRef.current?.setEvents({});
    clientRef.current?.stop();
    clientRef.current = null;
  }, [clearMintDeadline, clearReconnectDeadline]);

  /** Clean-idle transition (plan §3.2): the socket is ALREADY fully stopped
   *  (realtime.ts's own IdleTimer already called stop()/cleanup()), so this
   *  detaches the dead client's handlers and surfaces a visible, calm
   *  "suspended" state instead of leaving `liveState` dishonestly at "live"
   *  with a dead client. `messages`/`openedTurnRef`/`everConnectedRef` are
   *  all left intact — resume continues the same conversation. */
  const suspend = useCallback(() => {
    suspendedRef.current = true;
    reconnectingRef.current = false; // defensive; clean-idle can't be mid-reconnect
    clearMintDeadline();
    clearReconnectDeadline();
    const dead = clientRef.current;
    dead?.setEvents({}); // public seam — stop any late event re-entering onStatus
    clientRef.current = null; // socket already stopped by realtime.ts's IdleTimer
    if (mountedRef.current) setLiveState("suspended");
    voiceEvent("caddie", "live_suspend", { flush: true });
  }, [clearMintDeadline, clearReconnectDeadline]);

  const upsert = useCallback((m: RealtimeMessage) => {
    if (!mountedRef.current) return;
    lastActivityAtRef.current = Date.now();
    // Cross-client ordering (§2.3): once a reconnect has begun this
    // activation, every incoming message (including intra-turn
    // partial→final updates of the same id) gets the same fixed offset so
    // the new client's session sorts strictly after the preserved one.
    const applied: RealtimeMessage = reconnectedRef.current
      ? { ...m, order: m.order + orderOffsetRef.current }
      : m;
    maxOrderRef.current = Math.max(maxOrderRef.current, applied.order);
    setMessages((prev) => {
      const i = prev.findIndex((x) => x.id === applied.id);
      const merged = i === -1 ? [...prev, applied] : prev.map((x, j) => (j === i ? applied : x));
      // Conversation order, not arrival order — see lib/voice/realtime-ordering.ts.
      return sortByOrder(merged);
    });
  }, []);

  /** Silently re-anchors the live session to the current hole
   *  (specs/caddie-stale-hole-live-plan.md §2/§3.4-3.5) — no `response.create`,
   *  so the caddie never spontaneously chatters on a hole change; it simply
   *  stops being wrong the next time asked. Called on every connect
   *  transition (before the opening turn) and on every hole change while
   *  connected. No-op before the client has ever connected or when the hole
   *  context isn't known yet. */
  const anchorHole = useCallback(() => {
    const h = holeContextRef.current;
    if (!clientRef.current || !everConnectedRef.current || !h) return;
    clientRef.current.sendContext(buildHoleContextText(h));
    anchoredHoleRef.current = h.holeNumber;
    anchoredBasisRef.current = h.basis ?? null;
  }, []);

  /** Fires the opening turn exactly once, once BOTH the mic is ready and the
   *  client has connected at least once (order-independent — whichever
   *  happens second calls this and both guards are already true). A no-op
   *  on a Slice D reconnect success (openedTurnRef already set — see plan
   *  §2.1's "no re-greet" transition). */
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
      lastActivityAtRef.current = Date.now();
      // Cheap breadcrumb (specs/caddie-stale-hole-live-plan.md §3.9) — confirms
      // GPS-vs-tee split on real rounds without changing opening-shot.ts logic.
      voiceEvent("caddie", "opening_shot", {
        detail: `fromTee=${!!shot.fromTee} distanceYards=${shot.distanceYards}`,
      });
      clientRef.current?.sendOpener(buildOpeningGreetingInstruction(shot));
    })();
  }, []);

  useEffect(() => {
    if (!active) {
      // Reset so the NEXT activation starts clean.
      fellBackRef.current = false;
      everConnectedRef.current = false;
      micReadyRef.current = false;
      openedTurnRef.current = false;
      reconnectUsedRef.current = false;
      reconnectingRef.current = false;
      reconnectedRef.current = false;
      orderOffsetRef.current = 0;
      maxOrderRef.current = 0;
      lastActivityAtRef.current = 0;
      mutedRef.current = false;
      suspendedRef.current = false;
      anchoredHoleRef.current = null;
      clearMintDeadline();
      clearReconnectDeadline();
      // Detach before stop() — same belt as fallBack()/effect cleanup below
      // (specs/caddie-realtime-double-emit-plan.md §2 Part B).
      clientRef.current?.setEvents({});
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
    reconnectUsedRef.current = false;
    reconnectingRef.current = false;
    reconnectedRef.current = false;
    orderOffsetRef.current = 0;
    maxOrderRef.current = 0;
    lastActivityAtRef.current = 0;
    mutedRef.current = false;
    suspendedRef.current = false;
    anchoredHoleRef.current = null;
    setLiveState("connecting");
    setStatus("idle");
    setMessages([]);
    setMuted(false);

    const events: RealtimeCaddieEvents = {
      onStatus: (s) => {
        if (cancelled || !mountedRef.current) return;
        // Once fallen back, ignore all further statuses — including the
        // 'closed' fallBack()'s own stop() emits — so we never re-enter
        // (plan §2.1).
        if (fellBackRef.current) return;
        setStatus(s);
        if (s === "connected" || s === "listening" || s === "speaking") {
          lastActivityAtRef.current = Date.now();
        }

        if (reconnectingRef.current) {
          // Sub-phase: the fresh cold-mint client from startReconnect().
          if (s === "connected") {
            clearReconnectDeadline();
            reconnectingRef.current = false;
            setLiveState((prev) => (prev === "fallback" ? prev : "live"));
            if (mutedRef.current) clientRef.current?.setMuted(true);
            anchorHole(); // silent re-anchor — the resumed/reconnected server session may be stale
            maybeFireOpeningTurn(); // no-op — openedTurnRef already set
          } else if (s === "closed" || s === "error") {
            fallBack();
          }
          return;
        }

        if (s === "connected") {
          if (!everConnectedRef.current) {
            everConnectedRef.current = true;
            clearMintDeadline();
            setLiveState((prev) => (prev === "fallback" ? prev : "live"));
          }
          anchorHole(); // silent re-anchor BEFORE the opening turn — corrects a stale (e.g. warm-pool) mint
          maybeFireOpeningTurn();
          return;
        }

        if (s === "closed" || s === "error") {
          if (!everConnectedRef.current) {
            fallBack();
            return;
          }
          // Post-connected close/error (§3). realtime.ts exposes no
          // clean-vs-unexpected discriminator, so classify via the local
          // activity mirror: a genuine idle disconnect can only occur after
          // ≥90s during which this hook observed no activity either.
          // 'error' is always unexpected (idle never routes through error).
          const isCleanIdle =
            s === "closed" &&
            Date.now() - lastActivityAtRef.current >= REALTIME_IDLE_DISCONNECT_MS - IDLE_MARGIN_MS;
          if (isCleanIdle) {
            suspend();
            return; // visible "suspended" state — see suspend() above
          }
          if (reconnectUsedRef.current) {
            fallBack();
          } else {
            reconnectUsedRef.current = true;
            startReconnect();
          }
        }
      },
      // Gate on the same closure flags the other handlers already use
      // (specs/caddie-realtime-double-emit-plan.md §2 Part B) — `upsert`
      // alone only checks `mountedRef`, which stays true across sheet
      // open/close (CaddieSheet stays mounted), so an undetached zombie
      // client's messages would otherwise still land in `messages`.
      onMessage: (m) => {
        if (cancelled || fellBackRef.current) return;
        upsert(m);
      },
      onError: () => {
        if (cancelled) return;
        if (!everConnectedRef.current) fallBack();
      },
    };

    /** ONE quiet cold-mint reconnect after a post-connected drop (plan §2.2).
     *  Detaches the dead client's handlers before stopping it so its own
     *  'closed' can't re-enter onStatus and be misread as a reconnect
     *  failure. Preserves messages/openedTurnRef/everConnectedRef/
     *  micReadyRef — only the transport is replaced. */
    const startReconnect = () => {
      reconnectingRef.current = true;
      reconnectedRef.current = true;
      orderOffsetRef.current = maxOrderRef.current + 1;
      const dead = clientRef.current;
      dead?.setEvents({});
      dead?.stop();
      reconnectDeadlineRef.current = setTimeout(() => {
        reconnectDeadlineRef.current = null;
        if (!cancelled && !fellBackRef.current) fallBack();
      }, MINT_DEADLINE_MS);
      // Always cold — the warm pool is already consumed mid-round (plan §2.2).
      // currentHole (§3.8, defense-in-depth): read live off holeContextRef so
      // a reconnect mints with the hole current AT THAT MOMENT, not the hole
      // at activation. The connect-time anchorHole() above is still the
      // load-bearing correction.
      const client = new RealtimeCaddieClient(
        { roundId, personalityId: personaId, currentHole: holeContextRef.current.holeNumber },
        events,
      );
      client.setToolContext(getToolContext);
      clientRef.current = client;
      void (async () => {
        try {
          await client.start();
          if (cancelled || fellBackRef.current) return;
          await client.attachMic();
          if (cancelled || fellBackRef.current) return;
          micReadyRef.current = true; // already true; kept uniform
          if (mutedRef.current) client.setMuted(true);
        } catch {
          if (!cancelled && !fellBackRef.current) fallBack();
        }
      })();
    };

    /** User-triggered resume from `suspended` (plan §3.3). Mirrors
     *  `startReconnect()` with three deliberate differences: it is
     *  user-triggered (not from an idle/drop signal), it transitions FROM
     *  suspended, and it does NOT set `reconnectUsedRef` — it RESETS it, so
     *  a real drop after a resume still gets its own auto-reconnect (§3.4:
     *  the budget bounds a silent flapping loop within one automatic burst;
     *  a human tap delineates a new burst, so there is no loop to bound
     *  across it). Reuses the SAME reconnecting sub-phase as
     *  startReconnect() — the fresh client's connected/closed/error are
     *  handled by the existing `if (reconnectingRef.current)` branch above. */
    const doResume = () => {
      if (!suspendedRef.current) return; // only from suspended
      if (reconnectingRef.current) return; // guard double-tap re-entrancy
      suspendedRef.current = false;
      reconnectUsedRef.current = false; // resumed burst gets its OWN one-shot budget
      reconnectingRef.current = true;
      reconnectedRef.current = true;
      orderOffsetRef.current = maxOrderRef.current + 1; // resumed turns sort strictly after
      if (mountedRef.current) {
        setLiveState("live"); // continuity — status flickers connecting -> ready
        setStatus("connecting"); // immediate honest feedback on the tap, no "Ended" flash
      }
      voiceEvent("caddie", "live_resume");
      reconnectDeadlineRef.current = setTimeout(() => {
        reconnectDeadlineRef.current = null;
        if (!cancelled && !fellBackRef.current) fallBack();
      }, MINT_DEADLINE_MS);
      // Always cold — the warm pool is already consumed mid-round (same as reconnect).
      // currentHole (§3.8, defense-in-depth) — read live off holeContextRef.
      const client = new RealtimeCaddieClient(
        { roundId, personalityId: personaId, currentHole: holeContextRef.current.holeNumber },
        events,
      );
      client.setToolContext(getToolContext);
      clientRef.current = client;
      void (async () => {
        try {
          await client.start();
          if (cancelled || fellBackRef.current) return;
          await client.attachMic();
          if (cancelled || fellBackRef.current) return;
          micReadyRef.current = true;
          if (mutedRef.current) client.setMuted(true);
        } catch {
          if (!cancelled && !fellBackRef.current) fallBack();
        }
      })();
    };
    resumeImplRef.current = doResume;

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
        warm.setToolContext(getToolContext);
        warm.emitCurrentStatus(); // paint the current state immediately
        try {
          await warm.attachMic();
          if (cancelled || fellBackRef.current) return;
          micReadyRef.current = true;
          maybeFireOpeningTurn();
        } catch {
          if (!cancelled && !fellBackRef.current) fallBack(); // mic-deny (or a half-built warm client)
        }
        return;
      }

      // Cold mint — presence of `roundId` (no `mode` field) selects caddie
      // mode, exactly as useVoiceCaddie's startBurst().
      // currentHole (§3.8, defense-in-depth) — read live off holeContextRef.
      const client = new RealtimeCaddieClient(
        { roundId, personalityId: personaId, currentHole: holeContextRef.current.holeNumber },
        events,
      );
      client.setToolContext(getToolContext);
      clientRef.current = client;
      try {
        await client.start();
        if (cancelled || fellBackRef.current) return;
        // A cold (non-withheld) client already has `opened = true` from
        // construction, so this is a no-op on the real client (realtime.ts's
        // `if (this.opened) return;` guard) — called uniformly so "mic
        // ready" means the same thing on both the warm and cold branches.
        await client.attachMic();
        if (cancelled || fellBackRef.current) return;
        micReadyRef.current = true;
        maybeFireOpeningTurn();
      } catch {
        if (!cancelled && !fellBackRef.current) fallBack();
      }
    })();

    return () => {
      cancelled = true;
      clearMintDeadline();
      clearReconnectDeadline();
      // Detach before stop() — same belt as fallBack()/`!active` above
      // (specs/caddie-realtime-double-emit-plan.md §2 Part B).
      clientRef.current?.setEvents({});
      clientRef.current?.stop();
      clientRef.current = null;
      resumeImplRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, roundId, personaId]);

  // Re-anchor on every hole change OR yardage-basis flip while the live
  // session is connected (specs/caddie-stale-hole-live-plan.md §3.5,
  // extended by specs/caddie-yardage-gps-selected-tee-plan.md §2.3 — a GPS
  // fix acquired/lost mid-hole re-grounds the caddie even when the hole
  // number hasn't changed). `anchoredHoleRef`/`anchoredBasisRef` make a
  // re-run with neither actually changed a no-op, which also prevents a
  // double-refresh race with the connect-time anchor above (both converge on
  // the same refs). If the session hasn't connected yet, `anchorHole()`
  // early-returns and the refs stay null — the eventual connect anchors the
  // then-current hole/basis read live from `holeContextRef`, so nothing
  // needs to be queued here.
  useEffect(() => {
    if (!active) return;
    if (anchoredHoleRef.current === null) return; // never anchored yet this activation → connect covers it
    const holeChanged = holeNumber !== anchoredHoleRef.current;
    const basisChanged = (yardageBasis ?? null) !== (anchoredBasisRef.current ?? null);
    if (!holeChanged && !basisChanged) return; // neither changed → no double-refresh
    anchorHole();
  }, [active, holeNumber, yardageBasis, anchorHole]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    if (!next) lastActivityAtRef.current = Date.now(); // unmuting = activity (§3)
    mutedRef.current = next;
    clientRef.current?.setMuted(next);
    setMuted(next);
  }, [muted]);

  const resume = useCallback(() => {
    resumeImplRef.current?.();
  }, []);

  const stop = useCallback(() => {
    clearMintDeadline();
    clearReconnectDeadline();
    clientRef.current?.stop();
    clientRef.current = null;
  }, [clearMintDeadline, clearReconnectDeadline]);

  return {
    liveState,
    fellBack: liveState === "fallback",
    messages,
    status,
    muted,
    toggleMute,
    resume,
    stop,
  };
}
