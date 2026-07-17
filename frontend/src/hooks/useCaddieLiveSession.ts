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
 * Honest degradation (never a dead sheet, never a silent "Connecting…"
 * stall — specs/caddie-live-p0-connect-hole-plan.md §2): a pre-connect
 * failure (mint takes longer than `LIVE_MINT_BUDGET_MS`, the whole attempt
 * exceeds `LIVE_CONNECT_BUDGET_MS`, or the connection closes/errors before
 * ever reaching `connected`) gets ONE quiet auto cold-mint retry
 * (`liveState "retrying"`); a second such failure lands in the honest
 * terminal `liveState "connect-failed"` (tap-to-retry via `retryConnect()`
 * — PERSISTS `liveOn`, no silent revert). Only `attachMic()` rejecting with
 * a mic-permission error (`NotAllowedError`/`NotFoundError`/`SecurityError`)
 * flips `fellBack` immediately, with zero retries (retrying a denied
 * getUserMedia can never succeed). The caller (CaddieSheet) then renders the
 * classic tap-to-talk path with a calm "Tap-to-talk mode" indicator instead
 * of this hook's live transcript view.
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
  type ScoreEntryResult,
} from "@/lib/voice/realtime";
import { warmSession } from "@/lib/voice/warm-session";
import { sortByOrder } from "@/lib/voice/realtime-ordering";
import { LIVE_MINT_BUDGET_MS, LIVE_CONNECT_BUDGET_MS } from "@/lib/caddie/transport";
import { REALTIME_IDLE_DISCONNECT_MS } from "@/lib/voice/idle-timer";
import {
  buildOpeningGreetingInstruction,
  buildHoleContextText,
  type OpeningShot,
  type HoleContext,
} from "@/lib/caddie/opening-turn";
import { voiceEvent } from "@/lib/voice/telemetry";

/**
 * "retrying" — the one quiet auto-retry (fresh cold client) is in flight,
 * pre-connected only. "connect-failed" — the honest terminal tap-to-retry
 * state, distinct from "fallback": it PERSISTS `liveOn` (no silent revert to
 * "Ask caddie") — only mic-permission denial and post-connected reconnect
 * exhaustion (Slice D) still land in "fallback" (specs/caddie-live-p0
 * -connect-hole-plan.md §2.1).
 */
export type CaddieLiveState =
  | "connecting"
  | "retrying"
  | "live"
  | "suspended"
  | "fallback"
  | "connect-failed";

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
  /** Explicit spoken score-entry routing (specs/caddie-two-tier-routing-plan
   *  .md §9) — a PURE routing layer over the EXISTING /api/voice/parse-scores
   *  parser and the EXISTING score write path; threaded into the live
   *  session's tool-context provider so the `record_scores` tool can reach
   *  it. Undefined on a surface with no scorecard (e.g. round setup) —
   *  dispatchTool then returns an honest "not available on this screen"
   *  error rather than silently dropping the score. */
  enterScores?: (utterance: string, holeNumber?: number) => Promise<ScoreEntryResult>;
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
  /** User-triggered fresh attempt from `liveState === "connect-failed"` —
   *  resets the one-retry budget and cold-mints (specs/caddie-live-p0
   *  -connect-hole-plan.md §2.1). No-op from any other state. */
  retryConnect: () => void;
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
  enterScores,
}: UseCaddieLiveSessionOptions): UseCaddieLiveSessionResult {
  const [liveState, setLiveState] = useState<CaddieLiveState>("connecting");
  const [status, setStatus] = useState<RealtimeStatus>("idle");
  const [messages, setMessages] = useState<RealtimeMessage[]>([]);
  const [muted, setMuted] = useState(false);

  const clientRef = useRef<RealtimeCaddieClient | null>(null);
  const mountedRef = useRef(true);
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

  // ── Pre-connect retry state machine refs (specs/caddie-live-p0-connect
  // -hole-plan.md §2.2) — bugs A: the mint+ICE budget used to be ONE 3s
  // timer; below is the per-attempt 4s-mint/8s-attempt pair plus the
  // one-quiet-auto-retry bookkeeping. Pre-connected only — disjoint from the
  // Slice D reconnect refs above (those require `everConnectedRef` true;
  // these require it false — see plan §2.4 race 6). ──
  /** Identifies the CURRENT connect attempt — every timer/failure callback
   *  captures its own id at arm-time and no-ops if it's gone stale (a newer
   *  attempt superseded it, or `cancelled`/`fellBackRef`/`everConnectedRef`
   *  already resolved things). */
  const attemptIdRef = useRef(0);
  /** Guards `failPreConnect` idempotency for the CURRENT attempt — absorbs
   *  the double-fire when `attachMic()` both rejects AND pushes an 'error'
   *  status through `onStatus`/`onError` (plan §2.2 step 5/6). Reset at the
   *  top of every `startAttempt()`. */
  const attemptHandledRef = useRef(false);
  /** Mint-phase timer (attempt start → `onMinted`) — `LIVE_MINT_BUDGET_MS`. */
  const mintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Whole-attempt timer (attempt start → first `'connected'`) —
   *  `LIVE_CONNECT_BUDGET_MS`. Also the dead-warm-adoption watchdog: an
   *  adopted warm client never re-fires `onMinted`, so only this timer
   *  bounds it. */
  const attemptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** `Date.now()` when the current attempt was armed — telemetry `ms=`. */
  const attemptStartedAtRef = useRef(0);
  /** The ONE quiet auto-retry budget for THIS activation's pre-connect
   *  phase — flips true the first time `failPreConnect` retries; a second
   *  pre-connect failure then lands in the honest terminal
   *  `"connect-failed"` instead of looping. A human tap (`retryConnect()`)
   *  resets it, mirroring `doResume()` resetting Slice D's own budget. */
  const retryUsedRef = useRef(false);
  /** Mirror of `liveState === "connect-failed"` for use inside closures with
   *  stale `liveState` snapshots (mirrors `suspendedRef`'s pattern) —
   *  `doRetryConnect()` is only valid from this state. */
  const connectFailedRef = useRef(false);
  /** The activation effect's `doRetryConnect()` closure — the returned
   *  stable `retryConnect()` calls through this (mirrors `resumeImplRef`).
   *  Cleared in effect cleanup. */
  const retryConnectImplRef = useRef<(() => void) | null>(null);

  const resolveOpeningShotRef = useRef(resolveOpeningShot);
  useEffect(() => {
    resolveOpeningShotRef.current = resolveOpeningShot;
  }, [resolveOpeningShot]);

  /** Mirror of `enterScores` (specs/caddie-two-tier-routing-plan.md §9) —
   *  read live by `getToolContext` below, same pattern as `resolveOpening
   *  ShotRef`, so a later-mounted callback (e.g. RoundPageClient finishing
   *  its own setup) reaches every client this hook creates/adopts without a
   *  reconnect. */
  const enterScoresRef = useRef(enterScores);
  useEffect(() => {
    enterScoresRef.current = enterScores;
  }, [enterScores]);

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
   *  (specs/caddie-numbers-coherence-plan.md §2.1). `currentHole` rides
   *  along as the SAME single snapshot (specs/caddie-live-p0-connect-hole
   *  -plan.md §3.1) — the (hole, yards, basis) triple can never mix across
   *  a swipe landing between two separate reads, and `dispatchTool`
   *  (realtime.ts) overrides the model's possibly-stale `hole_number` arg
   *  with this live value for the six hole-scoped tools. */
  const getToolContext = useCallback(
    () => ({
      holeYards: holeContextRef.current.yards,
      yardageBasis: holeContextRef.current.basis,
      currentHole: holeContextRef.current.holeNumber,
      enterScores: enterScoresRef.current,
    }),
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Clears BOTH pre-connect attempt timers (plan §2.2) — the mint-phase
   *  4s timer and the whole-attempt 8s timer. */
  const clearAttemptTimers = useCallback(() => {
    if (mintTimerRef.current !== null) {
      clearTimeout(mintTimerRef.current);
      mintTimerRef.current = null;
    }
    if (attemptTimerRef.current !== null) {
      clearTimeout(attemptTimerRef.current);
      attemptTimerRef.current = null;
    }
  }, []);

  const clearReconnectDeadline = useCallback(() => {
    if (reconnectDeadlineRef.current !== null) {
      clearTimeout(reconnectDeadlineRef.current);
      reconnectDeadlineRef.current = null;
    }
  }, []);

  /** Fall to the classic path. Idempotent — the first caller wins. Terminal
   *  for THIS activation — unlike `"connect-failed"`, this ALSO releases
   *  `liveOn` via `useDetachedCaddieLive`'s auto-release effect (mic-deny,
   *  or post-connected Slice D reconnect exhaustion). Not gated by
   *  `attemptHandledRef` — a mic-deny classified from the outer attachMic
   *  catch must be able to override an already-in-flight generic pre-connect
   *  retry that a same-tick `onStatus`/`onError` may have already started
   *  (plan §2.2 step 6's "idempotency absorbs the double-fire": whichever
   *  fires first may have called `failPreConnect`, but `fallBack()` always
   *  wins and tears down whatever client is currently referenced). */
  const fallBack = useCallback(() => {
    if (fellBackRef.current) return;
    fellBackRef.current = true;
    clearAttemptTimers();
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
  }, [clearAttemptTimers, clearReconnectDeadline]);

  /** Clean-idle transition (plan §3.2): the socket is ALREADY fully stopped
   *  (realtime.ts's own IdleTimer already called stop()/cleanup()), so this
   *  detaches the dead client's handlers and surfaces a visible, calm
   *  "suspended" state instead of leaving `liveState` dishonestly at "live"
   *  with a dead client. `messages`/`openedTurnRef`/`everConnectedRef` are
   *  all left intact — resume continues the same conversation. */
  const suspend = useCallback(() => {
    suspendedRef.current = true;
    reconnectingRef.current = false; // defensive; clean-idle can't be mid-reconnect
    clearAttemptTimers();
    clearReconnectDeadline();
    const dead = clientRef.current;
    dead?.setEvents({}); // public seam — stop any late event re-entering onStatus
    clientRef.current = null; // socket already stopped by realtime.ts's IdleTimer
    if (mountedRef.current) setLiveState("suspended");
    voiceEvent("caddie", "live_suspend", { flush: true });
  }, [clearAttemptTimers, clearReconnectDeadline]);

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
      attemptIdRef.current = 0;
      attemptHandledRef.current = false;
      attemptStartedAtRef.current = 0;
      retryUsedRef.current = false;
      connectFailedRef.current = false;
      clearAttemptTimers();
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
    attemptIdRef.current = 0;
    attemptHandledRef.current = false;
    attemptStartedAtRef.current = 0;
    retryUsedRef.current = false;
    connectFailedRef.current = false;
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
            clearAttemptTimers();
            voiceEvent("caddie", "live_connect_connected", {
              detail: `attempt=${attemptIdRef.current}`,
              ms: Date.now() - attemptStartedAtRef.current,
            });
            // A pre-connect retry (liveState "retrying") lands here too —
            // openedTurnRef is still false on a first-ever connect (even a
            // retried one), so maybeFireOpeningTurn() below fires the
            // opener normally (plan §2.1).
            setLiveState((prev) => (prev === "fallback" || prev === "connect-failed" ? prev : "live"));
          }
          anchorHole(); // silent re-anchor BEFORE the opening turn — corrects a stale (e.g. warm-pool) mint
          maybeFireOpeningTurn();
          return;
        }

        if (s === "closed" || s === "error") {
          if (!everConnectedRef.current) {
            failPreConnect(s === "closed" ? "status_closed" : "status_error");
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
      onError: (err) => {
        if (cancelled) return;
        if (everConnectedRef.current) return;
        // Pre-connect only. `onError` carries the actual Error, so it is the
        // one place that can classify mic-permission denial — a genuine
        // getUserMedia rejection can never succeed on a retry, so it must
        // fall back immediately rather than consume the one quiet retry
        // (plan §2.2 step 6). This can race `onStatus`'s generic
        // `failPreConnect` call for the SAME failure (both fire
        // synchronously, back to back, from realtime.ts's own catch
        // blocks) — `fallBack()` is intentionally NOT gated by
        // `attemptHandledRef`, so it always wins and tears down whatever
        // client is currently referenced (including a just-started retry).
        const name = err instanceof Error ? err.name : "";
        if (name === "NotAllowedError" || name === "NotFoundError" || name === "SecurityError") {
          fallBack();
        } else {
          failPreConnect("client_error");
        }
      },
      onMinted: () => {
        if (cancelled || !mountedRef.current || fellBackRef.current) return;
        if (mintTimerRef.current !== null) {
          clearTimeout(mintTimerRef.current);
          mintTimerRef.current = null;
        }
        voiceEvent("caddie", "live_connect_minted", {
          detail: `attempt=${attemptIdRef.current} path=cold`,
          ms: Date.now() - attemptStartedAtRef.current,
        });
      },
    };

    /** One pre-connect connect attempt (plan §2.2 step 1) — arms the two
     *  phase timers (`LIVE_MINT_BUDGET_MS`/`LIVE_CONNECT_BUDGET_MS`) and, for
     *  `'auto-retry'`/`'user-retry'`, ALSO performs the connect itself: a
     *  fresh COLD client (never `takeWarm` on retry — the warm pool is
     *  already consumed mid-round, same reasoning as Slice D's
     *  `startReconnect`). `'initial'` only arms the timers — the existing
     *  warm-adopt-or-cold-mint IIFE below performs THAT connect, so its
     *  first attempt shares the identical warm-adopt path a plain (non-retry)
     *  connect always had. */
    const startAttempt = (kind: "initial" | "auto-retry" | "user-retry") => {
      attemptIdRef.current += 1;
      const myAttemptId = attemptIdRef.current;
      attemptHandledRef.current = false;
      clearAttemptTimers();
      const t0 = Date.now();
      attemptStartedAtRef.current = t0;
      const pathLabel = kind === "initial" ? "cold" : kind;
      const stale = () =>
        cancelled || fellBackRef.current || everConnectedRef.current || myAttemptId !== attemptIdRef.current;

      mintTimerRef.current = setTimeout(() => {
        mintTimerRef.current = null;
        if (stale()) return;
        voiceEvent("caddie", "live_connect_mint_timeout", {
          detail: `attempt=${myAttemptId} path=${pathLabel}`,
          ms: Date.now() - t0,
        });
        failPreConnect("mint_timeout");
      }, LIVE_MINT_BUDGET_MS);
      attemptTimerRef.current = setTimeout(() => {
        attemptTimerRef.current = null;
        if (stale()) return;
        voiceEvent("caddie", "live_connect_attempt_timeout", {
          detail: `attempt=${myAttemptId} path=${pathLabel}`,
          ms: Date.now() - t0,
        });
        failPreConnect("attempt_timeout");
      }, LIVE_CONNECT_BUDGET_MS);

      if (kind === "initial") return; // the warm-adopt-or-cold-mint IIFE below connects this attempt

      const client = new RealtimeCaddieClient(
        { roundId, personalityId: personaId, currentHole: holeContextRef.current.holeNumber },
        events,
      );
      client.setToolContext(getToolContext);
      clientRef.current = client;
      void (async () => {
        try {
          await client.start();
        } catch {
          if (!stale()) failPreConnect("start_reject");
          return;
        }
        if (stale()) return;
        try {
          await client.attachMic();
        } catch (err) {
          if (cancelled || fellBackRef.current) return;
          const name = err instanceof Error ? err.name : "";
          if (name === "NotAllowedError" || name === "NotFoundError" || name === "SecurityError") {
            // Mic-deny is classified UNCONDITIONALLY (not gated by `stale()`
            // / `everConnectedRef`) — the underlying transport can already
            // be `'connected'` (e.g. a warm-adopted client whose connection
            // was live before the sheet ever opened) by the time the FIRST
            // real `getUserMedia()` call (this one) is denied. Retrying a
            // denied permission can never succeed either way.
            fallBack();
          } else if (!stale()) {
            failPreConnect("warm_dead");
          }
          return;
        }
        if (stale()) return;
        micReadyRef.current = true;
        if (mutedRef.current) client.setMuted(true);
        maybeFireOpeningTurn();
      })();
    };

    /** One phase of a pre-connect attempt failed before ever reaching
     *  `'connected'` (plan §2.2 step 5) — idempotent per attempt via
     *  `attemptHandledRef`. Tears down the current client (detach before
     *  stop — same belt as `fallBack()`), then either fires the ONE quiet
     *  auto-retry (fresh cold client) or lands in the honest terminal
     *  `"connect-failed"` (persists `liveOn` — deliberately NEVER calls
     *  `fallBack()` here). */
    const failPreConnect = (reason: string) => {
      if (attemptHandledRef.current) return;
      attemptHandledRef.current = true;
      clearAttemptTimers();
      clientRef.current?.setEvents({});
      clientRef.current?.stop();
      clientRef.current = null;
      if (!retryUsedRef.current) {
        retryUsedRef.current = true;
        if (mountedRef.current) setLiveState("retrying");
        voiceEvent("caddie", "live_connect_retry", { detail: `reason=${reason}` });
        startAttempt("auto-retry");
      } else {
        connectFailedRef.current = true;
        if (mountedRef.current) setLiveState("connect-failed");
        voiceEvent("caddie", "live_connect_failed", { detail: `reason=${reason}`, flush: true });
      }
    };

    /** User-triggered fresh attempt from `"connect-failed"` (plan §2.2 step
     *  7) — resets the one-retry budget (a human tap delineates a new
     *  burst, mirroring `doResume()`'s reset of Slice D's own budget). */
    const doRetryConnect = () => {
      if (!connectFailedRef.current) return; // only valid from connect-failed
      connectFailedRef.current = false;
      retryUsedRef.current = false;
      if (mountedRef.current) {
        setLiveState("connecting");
        setStatus("connecting"); // immediate honest feedback on the tap
      }
      voiceEvent("caddie", "live_connect_user_retry");
      startAttempt("user-retry");
    };
    retryConnectImplRef.current = doRetryConnect;

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
      }, LIVE_CONNECT_BUDGET_MS);
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
      }, LIVE_CONNECT_BUDGET_MS);
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

    startAttempt("initial");
    const initialAttemptId = attemptIdRef.current;
    const initialStale = () =>
      cancelled || fellBackRef.current || everConnectedRef.current || initialAttemptId !== attemptIdRef.current;

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
        // Already minted (adopted, not freshly connecting) — never re-fires
        // onMinted, so clear the mint sub-timer manually and log path=warm
        // (plan §2.2 step 3). The 8s attempt timer keeps running until
        // 'connected' — that IS the dead-warm watchdog.
        if (mintTimerRef.current !== null) {
          clearTimeout(mintTimerRef.current);
          mintTimerRef.current = null;
        }
        voiceEvent("caddie", "live_connect_minted", { detail: `attempt=${initialAttemptId} path=warm` });
        warm.emitCurrentStatus(); // paint the current state immediately
        try {
          await warm.attachMic();
        } catch (err) {
          if (cancelled || fellBackRef.current) return;
          const name = err instanceof Error ? err.name : "";
          if (name === "NotAllowedError" || name === "NotFoundError" || name === "SecurityError") {
            // Mic-deny is classified UNCONDITIONALLY (not gated by
            // `initialStale()`/`everConnectedRef`) — a warm-adopted client's
            // underlying transport can already be `'connected'` (painted by
            // `emitCurrentStatus()` above) by the time this FIRST real
            // `getUserMedia()` call is denied. Never retried either way.
            fallBack();
          } else if (!initialStale()) {
            failPreConnect("warm_dead"); // half-built/dead warm client
          }
          return;
        }
        if (initialStale()) return;
        micReadyRef.current = true;
        maybeFireOpeningTurn();
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
      } catch {
        if (!initialStale()) failPreConnect("start_reject");
        return;
      }
      if (initialStale()) return;
      try {
        // A cold (non-withheld) client already has `opened = true` from
        // construction, so this is a no-op on the real client (realtime.ts's
        // `if (this.opened) return;` guard) — called uniformly so "mic
        // ready" means the same thing on both the warm and cold branches.
        await client.attachMic();
      } catch (err) {
        if (cancelled || fellBackRef.current) return;
        const name = err instanceof Error ? err.name : "";
        if (name === "NotAllowedError" || name === "NotFoundError" || name === "SecurityError") {
          fallBack(); // mic-deny — never retried, unconditional (see warm branch above)
        } else if (!initialStale()) {
          failPreConnect("warm_dead"); // dead/half-built client
        }
        return;
      }
      if (initialStale()) return;
      micReadyRef.current = true;
      maybeFireOpeningTurn();
    })();

    return () => {
      cancelled = true;
      clearAttemptTimers();
      clearReconnectDeadline();
      // Detach before stop() — same belt as fallBack()/`!active` above
      // (specs/caddie-realtime-double-emit-plan.md §2 Part B).
      clientRef.current?.setEvents({});
      clientRef.current?.stop();
      clientRef.current = null;
      resumeImplRef.current = null;
      retryConnectImplRef.current = null;
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

  const retryConnect = useCallback(() => {
    retryConnectImplRef.current?.();
  }, []);

  const stop = useCallback(() => {
    clearAttemptTimers();
    clearReconnectDeadline();
    // Detach BEFORE stop() — same belt as fallBack()/suspend()/the `!active`
    // branch/the effect cleanup (specs/caddie-realtime-double-emit-plan.md
    // §2 Part B). Without this, a connected client's stop() synchronously
    // emits onStatus('closed') while `events` is still bound; with
    // everConnectedRef true and recent activity, the still-attached
    // onStatus handler misreads that as an unexpected drop and calls
    // startReconnect() — minting a brand-new client (full getUserMedia) that
    // this function's own `clientRef.current = null` below then orphans past
    // every teardown belt. A caller-invoked stop() is always a deliberate,
    // terminal end — it must never resurrect a live mic
    // (specs/caddie-detach-and-language-pin-plan.md, post-end orphaned-mic
    // fix).
    clientRef.current?.setEvents({});
    clientRef.current?.stop();
    clientRef.current = null;
  }, [clearAttemptTimers, clearReconnectDeadline]);

  return {
    liveState,
    fellBack: liveState === "fallback",
    messages,
    status,
    muted,
    toggleMute,
    resume,
    retryConnect,
    stop,
  };
}
