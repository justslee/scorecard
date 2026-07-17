// @vitest-environment jsdom
//
// useDetachedCaddieLive — the detached-live-session wrapper hook
// (specs/caddie-detach-and-language-pin-plan.md, Item B, §B6 T1/T5).
// Composes the REAL `useCaddieLiveSession` (not mocked) with its transport
// dependencies (RealtimeCaddieClient, warm-session) faked — same style as
// CaddieSheet.realtime.test.tsx, since this wrapper is a thin gate on top of
// that hook, not a reimplementation of its transport logic.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("@/lib/voice/telemetry", () => ({
  voiceEvent: vi.fn(),
  flushVoiceEvents: vi.fn(),
}));

const liveModeState = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/voice/live-mode-pref", () => ({
  getCaddieLiveMode: () => liveModeState.value,
}));

const realtimeMock = vi.hoisted(() => {
  type Events = {
    onStatus?: (s: string) => void;
    onMessage?: (m: unknown) => void;
    onError?: (e: Error) => void;
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
    // Mirrors the REAL RealtimeCaddieClient.stop() (realtime.ts): terminal,
    // and synchronously emits onStatus('closed') via whatever `events` is
    // CURRENTLY bound at call time — exactly the mechanism the orphaned-mic
    // regression (post-end zombie mic) depends on: a caller that stops a
    // connected client WITHOUT detaching first lets this synchronous
    // 'closed' re-enter the still-attached onStatus handler.
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

import { useDetachedCaddieLive, type UseDetachedCaddieLiveOptions } from "./useDetachedCaddieLive";
import { REALTIME_IDLE_DISCONNECT_MS } from "@/lib/voice/idle-timer";

function baseOptions(overrides: Partial<UseDetachedCaddieLiveOptions> = {}): UseDetachedCaddieLiveOptions {
  return {
    roundId: "round-1",
    personaId: "strategist",
    holeNumber: 3,
    holePar: 4,
    holeYards: 401,
    sheetOpen: true,
    eligible: true,
    ...overrides,
  };
}

/** Drains pending microtasks (async continuations past a mocked `await`),
 *  plus one macrotask tick — the fallback auto-release effect defers its
 *  setState via `setTimeout(..., 0)` (react-hooks/set-state-in-effect),
 *  which a microtask-only flush never reaches. Fake-timer aware: under
 *  `vi.useFakeTimers()` a real `setTimeout` never resolves on its own, so
 *  advance the fake clock instead of awaiting a real one. */
async function flush(times = 8) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  if (vi.isFakeTimers()) {
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
  } else {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  liveModeState.value = true;
  warmSessionMock.takeWarm.mockReset();
  warmSessionMock.takeWarm.mockReturnValue(null);
  realtimeMock.FakeRealtimeCaddieClient.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useDetachedCaddieLive — start/stop lifecycle", () => {
  it("start() activates the gate and mints exactly once", async () => {
    const { result } = renderHook((props) => useDetachedCaddieLive(props), {
      initialProps: baseOptions(),
    });
    expect(result.current.liveOn).toBe(false);

    act(() => result.current.start());
    await flush();

    expect(result.current.liveOn).toBe(true);
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(1);
  });

  it("start() is a no-op when not eligible", async () => {
    const { result } = renderHook((props) => useDetachedCaddieLive(props), {
      initialProps: baseOptions({ eligible: false }),
    });

    act(() => result.current.start());
    await flush();

    expect(result.current.liveOn).toBe(false);
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(0);
  });

  it("sheet close does NOT stop the session — no stop() call, messages preserved", async () => {
    const { result, rerender } = renderHook((props) => useDetachedCaddieLive(props), {
      initialProps: baseOptions({ sheetOpen: true }),
    });

    act(() => result.current.start());
    await flush();
    const client = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => client.emitStatus("connected"));
    await flush();
    act(() => {
      client.emitMessage({ id: "m1", role: "user", text: "What club from 150?", partial: false, order: 1 });
    });
    await flush();

    // Sheet closes — this is the whole feature: the session must survive.
    rerender(baseOptions({ sheetOpen: false }));
    await flush();

    expect(client.stop).not.toHaveBeenCalled();
    expect(result.current.liveOn).toBe(true);
    expect(result.current.session.messages).toHaveLength(1);
  });

  it("end() calls session.stop() then flips the gate off (liveOn false)", async () => {
    const { result } = renderHook((props) => useDetachedCaddieLive(props), {
      initialProps: baseOptions(),
    });

    act(() => result.current.start());
    await flush();
    const client = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => client.emitStatus("connected"));
    await flush();

    act(() => result.current.end());
    await flush();

    // Instant mic cut — the client's stop() is called directly.
    expect(client.stop).toHaveBeenCalled();
    expect(result.current.liveOn).toBe(false);
    // Gate flip also drives the inner hook's own `!active` teardown belt —
    // messages/status reset for the next activation.
    expect(result.current.session.messages).toEqual([]);
  });

  it("end() does NOT resurrect a client — post-end orphaned-mic regression (setEvents({}) detaches before stop(), so the synchronous 'closed' emission can't re-enter onStatus -> startReconnect)", async () => {
    // Reproduces the exact production shape: a CONNECTED client with RECENT
    // activity (mic attached, a message just landed) — the conditions under
    // which useCaddieLiveSession's onStatus handler classifies a 'closed'
    // as an unexpected DROP (not idle) and calls startReconnect(), UNLESS
    // the client's handlers were detached first. Before the fix, this test
    // fails: instances.length becomes 2 (a resurrected, live-mic client) and
    // client.setEvents is never called before client.stop().
    const { result } = renderHook((props) => useDetachedCaddieLive(props), {
      initialProps: baseOptions(),
    });

    act(() => result.current.start());
    await flush();
    const client = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => client.emitStatus("connected"));
    await flush();
    // Recent activity — the same signal (onStatus 'connected'/'listening'/
    // 'speaking', or a message) that makes the hook's clean-idle-vs-drop
    // classifier read "not idle" (i.e. classifiable as a resurrecting drop
    // if the reconnect cascade were allowed to fire at all).
    act(() => {
      client.emitMessage({ id: "m1", role: "user", text: "What club from 150?", partial: false, order: 1 });
    });
    await flush();

    act(() => result.current.end());
    await flush();

    // The load-bearing assertion: setEvents({}) fired BEFORE the call that
    // triggers stop()'s synchronous 'closed' emission (proven by call order,
    // not just "was called" — the whole bug is about ORDERING).
    const setEventsOrder = client.setEvents.mock.invocationCallOrder;
    const stopOrder = client.stop.mock.invocationCallOrder;
    expect(setEventsOrder.length).toBeGreaterThan(0);
    expect(stopOrder.length).toBeGreaterThan(0);
    expect(Math.min(...setEventsOrder)).toBeLessThan(Math.min(...stopOrder));
    // detach was to `{}` specifically (no lingering onStatus/onMessage).
    expect(client.setEvents).toHaveBeenCalledWith({});

    // No resurrection: exactly ONE client ever constructed across the whole
    // lifecycle — no startReconnect-minted second client, no second
    // getUserMedia-equivalent attachMic call.
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(1);
    expect(client.attachMic).toHaveBeenCalledTimes(1); // never re-attached
    expect(result.current.liveOn).toBe(false);
  });

  it("pre-connected close retries ONCE then lands connect-failed — persists liveOn (no silent revert), even while closed (specs/caddie-live-p0-connect-hole-plan.md §2.1: a plain pre-connected 'closed' is no longer an immediate fallback — the one quiet auto-retry runs first)", async () => {
    const { result, rerender } = renderHook((props) => useDetachedCaddieLive(props), {
      initialProps: baseOptions({ sheetOpen: true }),
    });

    act(() => result.current.start());
    await flush();

    // Sheet closes before the connect ever resolves.
    rerender(baseOptions({ sheetOpen: false }));
    await flush();

    const client1 = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    // Never connected + 'closed' -> ONE quiet auto cold-mint retry — a
    // fresh SECOND client, not an immediate fallback.
    act(() => client1.emitStatus("closed"));
    await flush();

    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(2);
    expect(result.current.session.liveState).toBe("retrying");
    expect(result.current.liveOn).toBe(true);
    expect(client1.stop).toHaveBeenCalled();

    const client2 = realtimeMock.FakeRealtimeCaddieClient.instances[1];
    act(() => client2.emitStatus("closed"));
    await flush();

    // The retry ALSO failed -> the honest terminal `connect-failed`, which
    // deliberately PERSISTS liveOn (the silent revert to "Ask caddie" this
    // plan kills) — no auto-release even though the sheet is closed.
    expect(result.current.session.liveState).toBe("connect-failed");
    expect(result.current.liveOn).toBe(true); // NOT released
    expect(client2.stop).toHaveBeenCalled();
  });

  it("connect-failed while OPEN also does not auto-release liveOn (CaddieSheet renders the classic body in place)", async () => {
    const { result } = renderHook((props) => useDetachedCaddieLive(props), {
      initialProps: baseOptions({ sheetOpen: true }),
    });

    act(() => result.current.start());
    await flush();
    const client1 = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => client1.emitStatus("closed"));
    await flush();
    const client2 = realtimeMock.FakeRealtimeCaddieClient.instances[1];
    act(() => client2.emitStatus("closed"));
    await flush();

    expect(result.current.session.liveState).toBe("connect-failed");
    expect(result.current.liveOn).toBe(true); // NOT auto-released
  });

  it("true fallback (mic-deny) still auto-releases liveOn while closed (next open retries live fresh) — unlike connect-failed above", async () => {
    const { result, rerender } = renderHook((props) => useDetachedCaddieLive(props), {
      initialProps: baseOptions({ sheetOpen: true }),
    });

    act(() => result.current.start());
    const client = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    // Set up the mic-permission denial BEFORE flushing so it's in place
    // when the connect IIFE reaches `await client.attachMic()`.
    client.attachMic.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    await flush();

    expect(result.current.session.liveState).toBe("fallback");
    // fellBack while OPEN does not auto-release (CaddieSheet renders the
    // classic body in place) — same contract as before this plan.
    expect(result.current.liveOn).toBe(true);

    rerender(baseOptions({ sheetOpen: false }));
    await flush();

    expect(result.current.liveOn).toBe(false); // auto-released
    expect(client.stop).toHaveBeenCalled();
    // Mic-deny is never retried — exactly one client ever constructed.
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(1);
  });

  it("suspended (idle) persists across a sheet close — liveOn stays true", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook((props) => useDetachedCaddieLive(props), {
      initialProps: baseOptions({ sheetOpen: true }),
    });

    act(() => result.current.start());
    await flush();
    const client = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => client.emitStatus("connected"));
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(REALTIME_IDLE_DISCONNECT_MS);
    });
    act(() => client.emitStatus("closed")); // clean idle -> suspend
    await flush();

    expect(result.current.isSuspended).toBe(true);

    rerender(baseOptions({ sheetOpen: false }));
    await flush();

    expect(result.current.liveOn).toBe(true);
    expect(result.current.isSuspended).toBe(true);
  });

  it("hole-swipe mid-session: the tool-context provider reads the LIVE hole, not the one captured at connect (specs/caddie-live-p0-connect-hole-plan.md §3.1 — Bug B)", async () => {
    const { result, rerender } = renderHook((props) => useDetachedCaddieLive(props), {
      initialProps: baseOptions({ holeNumber: 1, holeYards: 350, sheetOpen: true }),
    });

    act(() => result.current.start());
    await flush();
    const client = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => client.emitStatus("connected"));
    await flush();

    expect(client.setToolContext).toHaveBeenCalledTimes(1);
    const getCtx = client.setToolContext.mock.calls[0][0] as () => {
      holeYards: number | null;
      yardageBasis: string | null;
      currentHole: number;
    };
    expect(getCtx()).toEqual({ holeYards: 350, yardageBasis: null, currentHole: 1 });

    // Swipe to hole 2 — no reconnect, SAME client/provider.
    rerender(baseOptions({ holeNumber: 2, holeYards: 402, sheetOpen: true }));
    await flush();

    expect(getCtx()).toEqual({ holeYards: 402, yardageBasis: null, currentHole: 2 });
  });
});

describe("useDetachedCaddieLive — route-change/unmount (T5)", () => {
  it("unmounting the host while live stops the client and detaches events; no further delivery", async () => {
    const { result, unmount } = renderHook((props) => useDetachedCaddieLive(props), {
      initialProps: baseOptions(),
    });

    act(() => result.current.start());
    await flush();
    const client = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => client.emitStatus("connected"));
    await flush();

    unmount();
    await flush();

    expect(client.setEvents).toHaveBeenCalledWith({});
    expect(client.stop).toHaveBeenCalled();

    // A message emitted after unmount must not throw or resurrect anything —
    // the detached client's handlers are gone.
    expect(() => client.emitMessage({ id: "late", role: "user", text: "late", partial: false, order: 1 })).not.toThrow();
  });
});
