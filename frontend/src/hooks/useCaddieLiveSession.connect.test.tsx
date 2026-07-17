// @vitest-environment jsdom
//
// useCaddieLiveSession — the pre-connect connect state machine
// (specs/caddie-live-p0-connect-hole-plan.md §2, Bug A: the "Ask caddie"
// orb/pill sometimes stalled at "Connecting…" and silently reverted).
// Deterministic + offline: the RealtimeCaddieClient and warm-session manager
// are both faked (same FakeRealtimeCaddieClient pattern as
// useDetachedCaddieLive.test.tsx / lib/voice/realtime-test-fakes.ts) and
// timers are fake — no real getUserMedia/RTCPeerConnection/sockets.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const voiceEventSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/voice/telemetry", () => ({
  voiceEvent: voiceEventSpy,
  flushVoiceEvents: vi.fn(),
}));

const realtimeMock = vi.hoisted(() => {
  type Events = {
    onStatus?: (s: string) => void;
    onMessage?: (m: unknown) => void;
    onError?: (e: Error) => void;
    onMinted?: () => void;
  };
  class FakeRealtimeCaddieClient {
    static instances: FakeRealtimeCaddieClient[] = [];
    opts: Record<string, unknown>;
    events: Events;
    currentStatus = "connecting";
    stopped = false;
    start = vi.fn(async () => {});
    attachMic = vi.fn(async () => {});
    setMuted = vi.fn();
    // Mirrors the REAL RealtimeCaddieClient.stop(): terminal, synchronously
    // emits onStatus('closed') via whatever `events` is CURRENTLY bound.
    stop = vi.fn(() => {
      if (this.stopped) return;
      this.stopped = true;
      this.currentStatus = "closed";
      this.events.onStatus?.("closed");
    });
    sendText = vi.fn();
    sendContext = vi.fn();
    sendOpener = vi.fn();
    setEvents = vi.fn((e: Events) => {
      this.events = e;
    });
    setToolContext = vi.fn();
    emitCurrentStatus = vi.fn(() => {
      this.events.onStatus?.(this.currentStatus);
    });
    constructor(opts: Record<string, unknown>, events: Events = {}) {
      this.opts = opts;
      this.events = events;
      FakeRealtimeCaddieClient.instances.push(this);
    }
    emitStatus(s: string) {
      this.currentStatus = s;
      this.events.onStatus?.(s);
    }
    emitMessage(m: unknown) {
      this.events.onMessage?.(m);
    }
    emitMinted() {
      this.events.onMinted?.();
    }
    emitError(e: Error) {
      this.events.onError?.(e);
    }
  }
  return { FakeRealtimeCaddieClient };
});
vi.mock("@/lib/voice/realtime", () => ({
  RealtimeCaddieClient: realtimeMock.FakeRealtimeCaddieClient,
}));

const warmSessionMock = vi.hoisted(() => ({
  takeWarm: vi.fn((): InstanceType<typeof realtimeMock.FakeRealtimeCaddieClient> | null => null),
}));
vi.mock("@/lib/voice/warm-session", () => ({
  warmSession: warmSessionMock,
}));

import { useCaddieLiveSession, type UseCaddieLiveSessionOptions } from "./useCaddieLiveSession";
import { LIVE_MINT_BUDGET_MS, LIVE_CONNECT_BUDGET_MS } from "@/lib/caddie/transport";

function baseOptions(overrides: Partial<UseCaddieLiveSessionOptions> = {}): UseCaddieLiveSessionOptions {
  return {
    active: true,
    roundId: "round-1",
    personaId: "strategist",
    holeNumber: 3,
    holePar: 4,
    holeYards: 401,
    ...overrides,
  };
}

/** Drains pending microtasks + advances fake timers by 0 — mirrors
 *  useDetachedCaddieLive.test.tsx's helper exactly. */
async function flush(times = 8) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  await act(async () => {
    vi.advanceTimersByTime(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  warmSessionMock.takeWarm.mockReset();
  warmSessionMock.takeWarm.mockReturnValue(null);
  realtimeMock.FakeRealtimeCaddieClient.instances = [];
  voiceEventSpy.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useCaddieLiveSession — pre-connect connect state machine (Bug A)", () => {
  it("mint stall (>4s) -> ONE quiet auto-retry -> a second stall lands connect-failed; the first client was detached before stop(), never a third client", async () => {
    const { result } = renderHook((props) => useCaddieLiveSession(props), {
      initialProps: baseOptions(),
    });
    await flush();

    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(1);
    const client1 = realtimeMock.FakeRealtimeCaddieClient.instances[0];

    await advance(LIVE_MINT_BUDGET_MS);

    expect(result.current.liveState).toBe("retrying");
    expect(client1.setEvents).toHaveBeenCalledWith({}); // detached before stop
    expect(client1.stop).toHaveBeenCalled();
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(2);

    const client2 = realtimeMock.FakeRealtimeCaddieClient.instances[1];
    await advance(LIVE_MINT_BUDGET_MS);

    expect(result.current.liveState).toBe("connect-failed");
    expect(result.current.fellBack).toBe(false); // connect-failed is NOT fallback
    expect(client2.stop).toHaveBeenCalled();
    // No third client — the budget is ONE retry, not a loop.
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(2);
  });

  it("minted-then-ICE-stall: onMinted clears the mint sub-timer, but the whole-attempt 8s timer still fires and retries once", async () => {
    const { result } = renderHook((props) => useCaddieLiveSession(props), {
      initialProps: baseOptions(),
    });
    await flush();
    const client1 = realtimeMock.FakeRealtimeCaddieClient.instances[0];

    act(() => client1.emitMinted());
    // Advancing PAST the mint budget is now inert (timer was cleared) — no
    // retry fires from the mint sub-timer alone.
    await advance(LIVE_MINT_BUDGET_MS);
    expect(result.current.liveState).toBe("connecting");
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(1);

    // ICE never completes — the whole-attempt 8s budget still bounds it.
    await advance(LIVE_CONNECT_BUDGET_MS - LIVE_MINT_BUDGET_MS);
    expect(result.current.liveState).toBe("retrying");
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(2);
  });

  it("retry success -> live: the SECOND client's connect resolves before its retry timers fire; opener fires once, anchorHole (sendContext) sent", async () => {
    const resolveOpeningShot = vi.fn(async () => ({ distanceYards: 150, fromTee: false }));
    const { result } = renderHook((props) => useCaddieLiveSession(props), {
      initialProps: baseOptions({ resolveOpeningShot }),
    });
    await flush();
    const client1 = realtimeMock.FakeRealtimeCaddieClient.instances[0];

    await advance(LIVE_MINT_BUDGET_MS); // -> retrying, client2 constructed
    expect(result.current.liveState).toBe("retrying");
    const client2 = realtimeMock.FakeRealtimeCaddieClient.instances[1];

    act(() => client2.emitStatus("connected"));
    await flush();

    expect(result.current.liveState).toBe("live");
    expect(client2.sendContext).toHaveBeenCalledTimes(1); // anchorHole
    expect(client2.sendOpener).toHaveBeenCalledTimes(1); // opener fires once
    // client1 never reached connected — no opener/anchor from it.
    expect(client1.sendContext).not.toHaveBeenCalled();
    expect(client1.sendOpener).not.toHaveBeenCalled();

    // Advancing well past both budgets after connecting is inert.
    await advance(LIVE_CONNECT_BUDGET_MS * 2);
    expect(result.current.liveState).toBe("live");
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(2);
  });

  it("late 'connected'/'closed' from the ABANDONED attempt-1 client after a retry has started: no state change, no message delivery", async () => {
    const { result } = renderHook((props) => useCaddieLiveSession(props), {
      initialProps: baseOptions(),
    });
    await flush();
    const client1 = realtimeMock.FakeRealtimeCaddieClient.instances[0];

    await advance(LIVE_MINT_BUDGET_MS); // -> retrying, client1 detached+stopped
    expect(result.current.liveState).toBe("retrying");
    const messagesBefore = result.current.messages;

    // A stray late event from the abandoned client 1 (detached events = {}
    // in the real client; here we simulate the belt failing by calling the
    // captured events object directly is impossible since it was reset to
    // {} — emitStatus/emitMessage on client1 route through client1.events,
    // which IS {} post-detach, so these are no-ops by construction).
    act(() => {
      client1.emitStatus("connected");
      client1.emitMessage({ id: "late", role: "assistant", text: "stale", partial: false, order: 99 });
    });
    await flush();

    expect(result.current.liveState).toBe("retrying"); // unchanged
    expect(result.current.messages).toEqual(messagesBefore); // no delivery
  });

  it("dead-warm adoption (adopted client immediately paints 'closed') -> ONE cold retry; takeWarm is NOT re-called on the retry", async () => {
    const deadWarm = new realtimeMock.FakeRealtimeCaddieClient({ withholdMic: true });
    deadWarm.currentStatus = "closed"; // dead on arrival
    warmSessionMock.takeWarm.mockReturnValueOnce(deadWarm);

    const { result } = renderHook((props) => useCaddieLiveSession(props), {
      initialProps: baseOptions(),
    });
    await flush();

    expect(warmSessionMock.takeWarm).toHaveBeenCalledTimes(1);
    // emitCurrentStatus() replays 'closed' immediately on adoption ->
    // pre-connected 'closed' -> ONE quiet cold retry.
    expect(result.current.liveState).toBe("retrying");
    // The retry is ALWAYS cold — takeWarm must not be called again.
    expect(warmSessionMock.takeWarm).toHaveBeenCalledTimes(1);
    // Exactly one REAL (non-warm-adopted) client instance was constructed by
    // the retry path.
    const coldRetryClients = realtimeMock.FakeRealtimeCaddieClient.instances.filter((c) => c !== deadWarm);
    expect(coldRetryClients).toHaveLength(1);
  });

  it("mic-deny (NotAllowedError) -> immediate fallback, zero retries, zero further getUserMedia", async () => {
    const { result } = renderHook((props) => useCaddieLiveSession(props), {
      initialProps: baseOptions(),
    });
    const client1 = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    client1.attachMic.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    await flush();

    expect(result.current.liveState).toBe("fallback");
    expect(result.current.fellBack).toBe(true);
    // Zero retries — exactly one client ever constructed.
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(1);
    expect(client1.attachMic).toHaveBeenCalledTimes(1);

    // Advancing past both budgets does nothing further — fallback is terminal.
    await advance(LIVE_CONNECT_BUDGET_MS * 2);
    expect(result.current.liveState).toBe("fallback");
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(1);
  });

  it("retryConnect() from connect-failed starts a fresh attempt with a reset budget; a second failure now retries again before landing back at connect-failed", async () => {
    const { result } = renderHook((props) => useCaddieLiveSession(props), {
      initialProps: baseOptions(),
    });
    await flush();
    await advance(LIVE_MINT_BUDGET_MS); // -> retrying (client2)
    await advance(LIVE_MINT_BUDGET_MS); // -> connect-failed (client1, client2 both failed)
    expect(result.current.liveState).toBe("connect-failed");
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(2);

    act(() => result.current.retryConnect());
    await flush();

    expect(result.current.liveState).toBe("connecting");
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(3); // fresh cold client

    // The reset budget means THIS attempt also gets its own one quiet retry.
    await advance(LIVE_MINT_BUDGET_MS);
    expect(result.current.liveState).toBe("retrying");
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(4);
  });

  it("retryConnect() is a no-op from every other state", async () => {
    const { result } = renderHook((props) => useCaddieLiveSession(props), {
      initialProps: baseOptions(),
    });
    await flush();
    expect(result.current.liveState).toBe("connecting");

    act(() => result.current.retryConnect());
    await flush();
    expect(result.current.liveState).toBe("connecting"); // unchanged
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(1); // no new attempt

    const client1 = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => client1.emitStatus("connected"));
    await flush();
    expect(result.current.liveState).toBe("live");

    act(() => result.current.retryConnect());
    await flush();
    expect(result.current.liveState).toBe("live"); // still unchanged
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(1);
  });

  it("telemetry breadcrumbs use enum-valued detail only — never a secret/round-content-shaped payload", async () => {
    const { result } = renderHook((props) => useCaddieLiveSession(props), {
      initialProps: baseOptions(),
    });
    await flush();
    await advance(LIVE_MINT_BUDGET_MS); // -> retrying
    await advance(LIVE_MINT_BUDGET_MS); // -> connect-failed
    expect(result.current.liveState).toBe("connect-failed");

    const events = voiceEventSpy.mock.calls.map(([surface, event, data]) => ({ surface, event, data }));
    expect(events.length).toBeGreaterThan(0);
    for (const { surface, event, data } of events) {
      expect(surface).toBe("caddie");
      expect(typeof event).toBe("string");
      // No client_secret, token, transcript, or free-text content — every
      // `detail` is `key=enumvalue` pairs only (space-separated).
      const detail = (data as { detail?: string } | undefined)?.detail;
      if (detail !== undefined) {
        expect(detail).not.toMatch(/secret|token|transcript/i);
        for (const pair of detail.split(" ")) {
          expect(pair).toMatch(/^[a-z_]+=[a-zA-Z0-9_.-]+$/);
        }
      }
    }
    // The specific connect-machine event names fired during this scenario.
    const names = events.map((e) => e.event);
    expect(names).toContain("live_connect_retry");
    expect(names).toContain("live_connect_failed");
  });

  it("stop()/unmount mid-retry: timers cleared, the in-flight retry client is detached+stopped, no further construction", async () => {
    const { result, unmount } = renderHook((props) => useCaddieLiveSession(props), {
      initialProps: baseOptions(),
    });
    await flush();
    await advance(LIVE_MINT_BUDGET_MS); // -> retrying, client2 constructed
    expect(result.current.liveState).toBe("retrying");
    const client2 = realtimeMock.FakeRealtimeCaddieClient.instances[1];
    expect(client2.stop).not.toHaveBeenCalled();

    unmount();
    await flush();

    expect(client2.setEvents).toHaveBeenCalledWith({});
    expect(client2.stop).toHaveBeenCalled();

    // Advancing past both budgets post-unmount constructs nothing further.
    await advance(LIVE_CONNECT_BUDGET_MS * 2);
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(2);
  });

  it("stop() called explicitly (not unmount) mid-retry also detaches+stops the in-flight retry client", async () => {
    const { result } = renderHook((props) => useCaddieLiveSession(props), {
      initialProps: baseOptions(),
    });
    await flush();
    await advance(LIVE_MINT_BUDGET_MS); // -> retrying
    const client2 = realtimeMock.FakeRealtimeCaddieClient.instances[1];

    act(() => result.current.stop());
    await flush();

    expect(client2.setEvents).toHaveBeenCalledWith({});
    expect(client2.stop).toHaveBeenCalled();
  });
});
