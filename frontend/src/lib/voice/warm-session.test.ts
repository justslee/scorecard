// warm-session.ts — the shared preload manager (specs/caddie-preload-plan.md).
//
// Pure lifecycle tests: a fake RealtimeCaddieClient factory stands in for
// real WebRTC, and fake timers drive the connect deadline. No DOM needed —
// isOnline/isHidden are injected too, so this runs in the default 'node' env.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WarmSessionManager,
  WARM_CONNECT_DEADLINE_MS,
  type WarmIntent,
} from './warm-session';
import type {
  RealtimeCaddieEvents,
  RealtimeCaddieOptions,
  RealtimeStatus,
} from './realtime';

/** Stands in for RealtimeCaddieClient — captures the events the manager wired
 *  up so a test can drive onStatus/onMinted deterministically. */
class FakeClient {
  stop = vi.fn();
  constructor(
    public opts: RealtimeCaddieOptions,
    public events: RealtimeCaddieEvents,
  ) {}
  start = vi.fn(async () => {});
  emitStatus(status: RealtimeStatus) {
    this.events.onStatus?.(status);
  }
  emitMinted() {
    this.events.onMinted?.();
  }
}

function makeManager(overrides: { isOnline?: () => boolean; isHidden?: () => boolean } = {}) {
  const clients: FakeClient[] = [];
  const createClient = vi.fn((opts: RealtimeCaddieOptions, events: RealtimeCaddieEvents) => {
    const c = new FakeClient(opts, events);
    clients.push(c);
    return c as unknown as import('./realtime').RealtimeCaddieClient;
  });
  const manager = new WarmSessionManager({
    isOnline: overrides.isOnline ?? (() => true),
    isHidden: overrides.isHidden ?? (() => false),
    createClient,
  });
  return { manager, clients, createClient };
}

const SETUP: WarmIntent = { kind: 'setup', personalityId: 'classic' };
const CADDIE_A: WarmIntent = { kind: 'caddie', roundId: 'round-1', personalityId: 'classic' };
const CADDIE_B: WarmIntent = { kind: 'caddie', roundId: 'round-2', personalityId: 'classic' };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('WarmSessionManager — state transitions', () => {
  it('starts DORMANT, moves to WARMING on warm(), then WARM once connected', () => {
    const { manager, clients } = makeManager();
    expect(manager.getState()).toBe('dormant');

    manager.warm(SETUP);
    expect(manager.getState()).toBe('warming');
    expect(clients).toHaveLength(1);
    expect(clients[0].opts).toMatchObject({ mode: 'setup', personalityId: 'classic', withholdMic: true });

    clients[0].emitStatus('connected');
    expect(manager.getState()).toBe('warm');
  });

  it('creates a caddie-mode client with the round id for a caddie intent', () => {
    const { manager, clients } = makeManager();
    manager.warm(CADDIE_A);
    expect(clients[0].opts).toMatchObject({
      mode: 'caddie',
      roundId: 'round-1',
      personalityId: 'classic',
      withholdMic: true,
    });
  });

  it('warm() never calls getUserMedia-adjacent setup — client is created with withholdMic true always', () => {
    const { manager, clients } = makeManager();
    manager.warm(SETUP);
    expect(clients[0].opts.withholdMic).toBe(true);
  });
});

describe('WarmSessionManager — idempotent warm', () => {
  it('a second warm() with the SAME intent while WARMING/WARM is a no-op (StrictMode-safe)', () => {
    const { manager, clients } = makeManager();
    manager.warm(SETUP);
    manager.warm(SETUP);
    manager.warm(SETUP);
    expect(clients).toHaveLength(1); // only one client ever created
    expect(manager.getState()).toBe('warming');
  });

  it('re-attaches a new observer on a repeated same-intent warm() call', () => {
    const { manager, clients } = makeManager();
    const first = vi.fn();
    const second = vi.fn();
    manager.warm(SETUP, { onStatus: first });
    manager.warm(SETUP, { onStatus: second }); // idempotent, but observer swaps

    clients[0].emitStatus('connecting');
    expect(second).toHaveBeenCalledWith('connecting');
    expect(first).not.toHaveBeenCalled();
  });
});

describe('WarmSessionManager — intent switch', () => {
  it('a DIFFERENT intent tears down the stale client and warms the new one', () => {
    const { manager, clients } = makeManager();
    manager.warm(CADDIE_A);
    expect(manager.getState()).toBe('warming');

    manager.warm(CADDIE_B);
    expect(clients[0].stop).toHaveBeenCalledTimes(1); // stale round-1 client torn down
    expect(clients).toHaveLength(2);
    expect(clients[1].opts).toMatchObject({ roundId: 'round-2' });
    expect(manager.getState()).toBe('warming');
  });
});

describe('WarmSessionManager — no adoption before idle close', () => {
  it('the client closing (e.g. its own 90s IdleTimer) with nobody adopting resets to DORMANT', () => {
    const { manager, clients } = makeManager();
    manager.warm(SETUP);
    clients[0].emitStatus('connected');
    expect(manager.getState()).toBe('warm');

    clients[0].emitStatus('closed'); // observed close — the client's own IdleTimer fired
    expect(manager.getState()).toBe('dormant');
  });

  it('a mid-warm error also resets to DORMANT via onError → teardown', () => {
    const { manager, clients } = makeManager();
    manager.warm(SETUP);
    clients[0].events.onError?.(new Error('boom'));
    expect(manager.getState()).toBe('dormant');
    expect(clients[0].stop).toHaveBeenCalled();
  });
});

describe('WarmSessionManager — takeWarm', () => {
  it('WARM matching intent → returns the client and moves to CONSUMED', () => {
    const { manager, clients } = makeManager();
    manager.warm(CADDIE_A);
    clients[0].emitStatus('connected');
    expect(manager.getState()).toBe('warm');

    const taken = manager.takeWarm(CADDIE_A);
    expect(taken).toBe(clients[0]);
    expect(manager.getState()).toBe('consumed');
    // A second take (mismatch now — intent cleared) returns null.
    expect(manager.takeWarm(CADDIE_A)).toBeNull();
  });

  it('WARMING matching intent → also returns the client (caller sees "Connecting…")', () => {
    const { manager, clients } = makeManager();
    manager.warm(CADDIE_A);
    expect(manager.getState()).toBe('warming');

    const taken = manager.takeWarm(CADDIE_A);
    expect(taken).toBe(clients[0]);
    expect(manager.getState()).toBe('consumed');
  });

  it('a MISMATCHED intent returns null and leaves the warm client untouched', () => {
    const { manager, clients } = makeManager();
    manager.warm(CADDIE_A);
    clients[0].emitStatus('connected');

    expect(manager.takeWarm(CADDIE_B)).toBeNull();
    expect(manager.getState()).toBe('warm'); // untouched
    expect(clients[0].stop).not.toHaveBeenCalled();
  });

  it('DORMANT → takeWarm always returns null (nothing to hand off)', () => {
    const { manager } = makeManager();
    expect(manager.takeWarm(SETUP)).toBeNull();
  });

  it('cancels the connect deadline once consumed — a late deadline fire is a no-op', () => {
    const { manager, clients } = makeManager();
    manager.warm(CADDIE_A);
    manager.takeWarm(CADDIE_A);
    vi.advanceTimersByTime(WARM_CONNECT_DEADLINE_MS + 100);
    expect(clients[0].stop).not.toHaveBeenCalled(); // caller owns it now, no manager teardown
  });
});

describe('WarmSessionManager — offline / hidden teardown', () => {
  it('warm() no-ops entirely while offline', () => {
    const { manager, clients } = makeManager({ isOnline: () => false });
    manager.warm(SETUP);
    expect(clients).toHaveLength(0);
    expect(manager.getState()).toBe('dormant');
  });

  it('warm() no-ops entirely while backgrounded (document hidden)', () => {
    const { manager, clients } = makeManager({ isHidden: () => true });
    manager.warm(SETUP);
    expect(clients).toHaveLength(0);
    expect(manager.getState()).toBe('dormant');
  });

  it('handleOffline() tears down a warm/warming client mid-flight', () => {
    const { manager, clients } = makeManager();
    manager.warm(SETUP);
    manager.handleOffline();
    expect(clients[0].stop).toHaveBeenCalledTimes(1);
    expect(manager.getState()).toBe('dormant');
  });

  it('handleHidden() (visibilitychange → hidden) tears down a warm client — iOS suspends WebRTC in the background', () => {
    const { manager, clients } = makeManager();
    manager.warm(CADDIE_A);
    clients[0].emitStatus('connected');
    manager.handleHidden();
    expect(clients[0].stop).toHaveBeenCalledTimes(1);
    expect(manager.getState()).toBe('dormant');
  });
});

describe('WarmSessionManager — connect deadline', () => {
  it('never reaching WARM within the deadline tears down back to DORMANT — no user waiting', () => {
    const { manager, clients } = makeManager();
    manager.warm(SETUP);
    vi.advanceTimersByTime(WARM_CONNECT_DEADLINE_MS - 1);
    expect(manager.getState()).toBe('warming');

    vi.advanceTimersByTime(1);
    expect(manager.getState()).toBe('dormant');
    expect(clients[0].stop).toHaveBeenCalledTimes(1);
  });

  it('reaching WARM before the deadline cancels it — no stray teardown later', () => {
    const { manager, clients } = makeManager();
    manager.warm(SETUP);
    clients[0].emitStatus('connected');
    vi.advanceTimersByTime(WARM_CONNECT_DEADLINE_MS + 1000);
    expect(manager.getState()).toBe('warm');
    expect(clients[0].stop).not.toHaveBeenCalled();
  });
});

describe('WarmSessionManager — teardown()', () => {
  it('is a safe no-op when nothing is warm', () => {
    const { manager } = makeManager();
    expect(() => manager.teardown()).not.toThrow();
    expect(manager.getState()).toBe('dormant');
  });

  it('stops the client and resets state when called mid-warm', () => {
    const { manager, clients } = makeManager();
    manager.warm(SETUP);
    manager.teardown();
    expect(clients[0].stop).toHaveBeenCalledTimes(1);
    expect(manager.getState()).toBe('dormant');
  });

  it('after takeWarm() consumed the client, teardown() does NOT double-stop it', () => {
    const { manager, clients } = makeManager();
    manager.warm(SETUP);
    manager.takeWarm(SETUP);
    manager.teardown();
    expect(clients[0].stop).not.toHaveBeenCalled();
  });

  it('does NOT recurse when stop() synchronously re-fires onStatus("closed") — the real client does this', () => {
    // Designer-review crash: teardown() → client.stop() → onStatus('closed')
    // → onClientStatus → teardown() → … blew the call stack on any failing
    // warm connect. State must flip to DORMANT before stop() so the
    // re-entrant call no-ops.
    const { manager, clients } = makeManager();
    manager.warm(SETUP);
    const client = clients[0];
    client.stop.mockImplementation(() => {
      client.emitStatus('closed'); // synchronous, like the real cleanup()
    });
    expect(() => manager.teardown()).not.toThrow();
    expect(client.stop).toHaveBeenCalledTimes(1);
    expect(manager.getState()).toBe('dormant');
  });

  it('does NOT recurse when a mid-warm failure status triggers teardown and stop() re-fires "closed"', () => {
    const { manager, clients } = makeManager();
    manager.warm(SETUP);
    const client = clients[0];
    client.stop.mockImplementation(() => {
      client.emitStatus('closed');
    });
    // A failing warm connect surfaces as onStatus('error') → onClientStatus
    // → teardown() → stop() → synchronous 'closed' → must no-op.
    expect(() => client.emitStatus('error')).not.toThrow();
    expect(client.stop).toHaveBeenCalledTimes(1);
    expect(manager.getState()).toBe('dormant');
  });
});
