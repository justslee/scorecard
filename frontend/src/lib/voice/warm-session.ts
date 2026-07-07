/**
 * warm-session.ts — the ONE shared warm-connect manager for the setup sheet
 * and the in-round orb (specs/caddie-preload-plan.md).
 *
 * Preloads a Realtime WebRTC session ahead of the user's tap so "Connecting…"
 * becomes rare (< ~500ms on a warmed open) instead of the full mint → connect
 * path running on every open.
 *
 * STRUCTURAL SAFETY: every client this manager creates is constructed with
 * `withholdMic: true` (lib/voice/realtime.ts) — no getUserMedia call, no audio
 * transmitted, transcript events dropped — until the surface that adopts it
 * via takeWarm() calls attachMic() itself. This manager NEVER calls
 * attachMic(); it only mints + connects, output-muted and mic-less.
 *
 * States: DORMANT (initial) → WARMING → WARM → CONSUMED (handed to a caller
 * via takeWarm(), never reused). The 90s idle cutoff is the client's OWN
 * IdleTimer (REALTIME_IDLE_DISCONNECT_MS, lib/voice/idle-timer.ts) — this
 * manager only OBSERVES the resulting 'closed' status and resets to DORMANT.
 * One authoritative timer; no second countdown racing it.
 */

import {
  RealtimeCaddieClient,
  type RealtimeCaddieEvents,
  type RealtimeCaddieOptions,
  type RealtimeStatus,
} from '@/lib/voice/realtime';
import { MINT_DEADLINE_MS } from '@/lib/caddie/transport';

export type WarmIntent =
  | { kind: 'setup'; personalityId: string }
  | { kind: 'caddie'; roundId: string; personalityId: string };

type WarmState = 'dormant' | 'warming' | 'warm' | 'consumed';

/** If a warm connect hasn't gone live by this budget, tear it down rather than
 *  leave a stale mint sitting around — no user is waiting on a warm attempt,
 *  so there's nothing to "degrade"; the next open just cold-starts. Reuses the
 *  cold path's own mint budget (lib/caddie/transport.ts) — one number, not two. */
export const WARM_CONNECT_DEADLINE_MS = MINT_DEADLINE_MS;

export interface WarmObserver {
  /** Ephemeral secret minted — mirrors RealtimeCaddieEvents.onMinted. */
  onMinted?: () => void;
  /** Connection status changes — mirrors RealtimeCaddieEvents.onStatus. */
  onStatus?: (status: RealtimeStatus) => void;
}

type Schedule = (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
type Cancel = (handle: ReturnType<typeof setTimeout>) => void;

function sameIntent(a: WarmIntent, b: WarmIntent): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'setup' && b.kind === 'setup') return a.personalityId === b.personalityId;
  if (a.kind === 'caddie' && b.kind === 'caddie') {
    return a.roundId === b.roundId && a.personalityId === b.personalityId;
  }
  return false;
}

export interface WarmSessionDeps {
  schedule?: Schedule;
  cancel?: Cancel;
  /** Injectable so tests can drive offline/online without real `navigator`. */
  isOnline?: () => boolean;
  /** Injectable so tests can drive backgrounded/foregrounded without real `document`. */
  isHidden?: () => boolean;
  /** Injectable client factory — tests substitute a fake client to avoid real WebRTC. */
  createClient?: (opts: RealtimeCaddieOptions, events: RealtimeCaddieEvents) => RealtimeCaddieClient;
}

export class WarmSessionManager {
  private state: WarmState = 'dormant';
  private intent: WarmIntent | null = null;
  private client: RealtimeCaddieClient | null = null;
  private observer: WarmObserver | null = null;
  private deadlineHandle: ReturnType<typeof setTimeout> | null = null;

  private readonly schedule: Schedule;
  private readonly cancelFn: Cancel;
  private readonly isOnline: () => boolean;
  private readonly isHidden: () => boolean;
  private readonly createClient: (
    opts: RealtimeCaddieOptions,
    events: RealtimeCaddieEvents,
  ) => RealtimeCaddieClient;

  constructor(deps: WarmSessionDeps = {}) {
    this.schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancelFn = deps.cancel ?? ((h) => clearTimeout(h));
    this.isOnline = deps.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine);
    this.isHidden = deps.isHidden ?? (() => typeof document !== 'undefined' && document.hidden);
    this.createClient =
      deps.createClient ?? ((opts, events) => new RealtimeCaddieClient(opts, events));
  }

  /** Current lifecycle state — exposed for tests and diagnostics. */
  getState(): WarmState {
    return this.state;
  }

  /**
   * Begin (or continue) warming a session for `intent`. No-ops while offline
   * or backgrounded (never warm a connection nobody can use yet, and iOS
   * suspends WebRTC in the background anyway). Idempotent for the SAME intent
   * while WARMING/WARM (StrictMode-safe double-invoke); a DIFFERENT intent
   * tears down the stale warm client first.
   */
  warm(intent: WarmIntent, observer?: WarmObserver): void {
    if (!this.isOnline() || this.isHidden()) return;

    if ((this.state === 'warming' || this.state === 'warm') && this.intent && sameIntent(this.intent, intent)) {
      if (observer) this.observer = observer;
      return;
    }
    if (this.state === 'warming' || this.state === 'warm') {
      this.teardown(); // switching intent — stop the stale warm client first
    }

    this.intent = intent;
    this.observer = observer ?? null;
    this.state = 'warming';

    const opts: RealtimeCaddieOptions =
      intent.kind === 'setup'
        ? { mode: 'setup', personalityId: intent.personalityId, withholdMic: true }
        : {
            mode: 'caddie',
            roundId: intent.roundId,
            personalityId: intent.personalityId,
            withholdMic: true,
          };

    const client = this.createClient(opts, {
      onMinted: () => this.observer?.onMinted?.(),
      onStatus: (status) => this.onClientStatus(status),
      onError: () => this.teardown(),
    });
    this.client = client;
    client.start().catch(() => this.teardown());

    this.deadlineHandle = this.schedule(() => {
      this.deadlineHandle = null;
      if (this.state === 'warming') this.teardown(); // never connected in time — no user waiting
    }, WARM_CONNECT_DEADLINE_MS);
  }

  /**
   * Hand the warm client to a caller. Returns it (and transitions to
   * CONSUMED) when WARM *or* still WARMING (the surface may briefly show
   * "Connecting…"). Returns null on a mismatched intent or DORMANT — the
   * caller falls back to its own cold path. Callers own the returned client
   * from here: setEvents(), emitCurrentStatus(), attachMic().
   */
  takeWarm(intent: WarmIntent): RealtimeCaddieClient | null {
    if (this.state !== 'warm' && this.state !== 'warming') return null;
    if (!this.intent || !sameIntent(this.intent, intent)) return null;

    const client = this.client;
    this.cancelDeadline();
    this.state = 'consumed';
    this.client = null;
    this.intent = null;
    this.observer = null;
    return client;
  }

  /** Stop any warm client and reset to DORMANT. Safe to call any time
   *  (offline, backgrounded, unmount, intent switch) — a no-op once the
   *  client has already been consumed or nothing is warming. */
  teardown(): void {
    this.cancelDeadline();
    // Detach + go DORMANT BEFORE stop(): stop() can fire onStatus('closed')
    // SYNCHRONOUSLY, which re-enters onClientStatus → teardown(). With the
    // state already cleared that re-entry no-ops instead of recursing
    // (designer-review crash: a failing warm connect on /round/new blew the
    // call stack on the first tap).
    const client = this.client;
    this.client = null;
    this.intent = null;
    this.observer = null;
    this.state = 'dormant';
    client?.stop();
  }

  /** Browser went offline mid-warm — never hold a billed zombie connection. */
  handleOffline(): void {
    this.teardown();
  }

  /** Backgrounded (visibilitychange → hidden) — iOS suspends WebRTC in the
   *  background; tear down rather than leave a stale/broken warm client. */
  handleHidden(): void {
    this.teardown();
  }

  private cancelDeadline(): void {
    if (this.deadlineHandle !== null) {
      this.cancelFn(this.deadlineHandle);
      this.deadlineHandle = null;
    }
  }

  private onClientStatus(status: RealtimeStatus): void {
    this.observer?.onStatus?.(status);
    if (status === 'connected') {
      if (this.state === 'warming') {
        this.state = 'warm';
        this.cancelDeadline();
      }
    } else if (status === 'closed' || status === 'error') {
      // Authoritative close — e.g. the client's own 90s IdleTimer expired
      // with nobody ever adopting it, or a mid-warm failure.
      if (this.state === 'warming' || this.state === 'warm') this.teardown();
    }
  }
}

/** The single shared instance both surfaces (setup sheet + orb) warm/adopt
 *  from — mirrors the module-level `activeRealtimeClient` singleton pattern
 *  in lib/voice/realtime.ts. */
export const warmSession = new WarmSessionManager();

// Real browser wiring — thin, unconditional teardown triggers. Guarded so
// this module stays importable where `window`/`document` don't exist (SSR,
// node-environment unit tests); the pure logic above is exercised directly
// via injected deps in warm-session.test.ts.
if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => warmSession.handleOffline());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) warmSession.handleHidden();
  });
}
