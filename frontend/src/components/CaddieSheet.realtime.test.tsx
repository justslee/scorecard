// @vitest-environment jsdom
//
// CaddieSheet — live mode (Realtime transport), Slice C1
// (specs/caddie-realtime-slice-c1-plan.md §7). Deterministic only: the
// Realtime client and the warm-session manager are both mocked to a
// controllable fake — no real getUserMedia/RTCPeerConnection/sockets ever
// touch this suite. `realtime-ordering.ts` (sortByOrder) is NOT mocked — the
// transcript-order assertion exercises the real ordering logic.
//
// This file must NOT weaken CaddieSheet.handsfree.test.tsx /
// CaddieSheet.session.test.tsx — they cover the classic (flag-off) path and
// stay unmodified; the flag defaults OFF there so their world is unchanged.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import * as React from "react";

// ── framer-motion passthrough — identical to CaddieSheet.handsfree.test.tsx ──
vi.mock("framer-motion", () => {
  const passthroughTags = new Set([
    "div", "button", "span", "svg", "path", "circle", "rect", "img", "a", "input",
  ]);
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        if (!passthroughTags.has(tag)) return undefined;
        const Passthrough = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
          const {
            initial: _initial,
            animate: _animate,
            exit: _exit,
            transition: _transition,
            whileTap: _whileTap,
            drag: _drag,
            dragListener: _dragListener,
            dragControls: _dragControls,
            dragConstraints: _dragConstraints,
            dragElastic: _dragElastic,
            onDragEnd: _onDragEnd,
            layout: _layout,
            ...rest
          } = props;
          return React.createElement(tag, { ...rest, ref });
        });
        Passthrough.displayName = `motion.${tag}`;
        return Passthrough;
      },
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useDragControls: () => ({ start: () => {} }),
  };
});

// ── Classic-path deps CaddieSheet always imports — stubbed inert (this
// suite never drives the classic ladder except in the fallback cases, and
// those never reach the network). ──
const { MockBeforeFirstByteError } = vi.hoisted(() => {
  class MockBeforeFirstByteError extends Error {
    constructor(message = "No reply yet — trying another way.") {
      super(message);
      this.name = "BeforeFirstByteError";
    }
  }
  return { MockBeforeFirstByteError };
});
vi.mock("@/lib/caddie/api", () => ({
  sessionRecommend: vi.fn(),
  talkToCaddie: vi.fn(),
  fetchRecommendation: vi.fn(),
  sessionVoiceStream: vi.fn(),
  talkToCaddieStream: vi.fn(),
  BeforeFirstByteError: MockBeforeFirstByteError,
}));
vi.mock("@/lib/storage", () => ({ getGolferProfile: vi.fn(() => null) }));
vi.mock("@/lib/caddie/clubs", () => ({ buildClubMap: vi.fn(() => ({})) }));
vi.mock("@/lib/caddie/stream-buffer", () => ({
  useStreamBuffer: (onFlush: (chunk: string) => void) => ({
    push: (delta: string) => onFlush(delta),
    flush: () => {},
    cancel: () => {},
  }),
}));
// Hoisted so Slice E tests can assert the live_suspend/live_resume markers
// (specs/caddie-realtime-slice-e-plan.md §9).
const voiceEventSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/voice/telemetry", () => ({
  voiceEvent: voiceEventSpy,
  flushVoiceEvents: vi.fn(),
}));
vi.mock("@/lib/voice/deepgram", () => ({
  VoiceRecorder: class {
    static isSupported() {
      return true;
    }
    start = vi.fn();
    stop = vi.fn();
    cancel = vi.fn();
    getStream = vi.fn(() => ({}) as MediaStream);
  },
  transcribeBlob: vi.fn(),
}));
vi.mock("@/lib/voice/deepgram-live", () => ({
  DeepgramLiveTranscriber: class {
    static isSupported() {
      return true;
    }
    stop = vi.fn();
    async start() {}
  },
}));

// The speaker pref (classic-path only) — default off, irrelevant here.
vi.mock("@/lib/voice/tts-pref", () => ({
  getSheetTtsEnabled: () => false,
  setSheetTtsEnabled: vi.fn(),
}));

// useSheetTTS — spied so assertion 8 ("no TTS in live") is a clean check.
const ttsSpeakSpy = vi.fn();
const ttsBeginStreamSpy = vi.fn();
const ttsEnqueueSpy = vi.fn();
const ttsEndStreamSpy = vi.fn();
vi.mock("@/hooks/useSheetTTS", () => ({
  useSheetTTS: () => ({
    unlock: vi.fn(),
    speak: ttsSpeakSpy,
    beginStream: ttsBeginStreamSpy,
    enqueue: ttsEnqueueSpy,
    endStream: ttsEndStreamSpy,
    stop: vi.fn(),
    isSpeaking: false,
  }),
}));

// ── The live-mode flag — TRUE by default in this file (the live suite);
// flipped false for the single "flag OFF" test (#7). ──
const liveModeState = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/voice/live-mode-pref", () => ({
  getCaddieLiveMode: () => liveModeState.value,
}));

// ── Fake RealtimeCaddieClient — controllable stand-in for BOTH the warm and
// cold construction paths (mirrors the fake-peer style in
// realtime-warm.test.ts / the injected-createClient style in
// warm-session.test.ts). Real `sortByOrder` (realtime-ordering.ts) is NOT
// mocked, so `emitMessage` exercises real conversation ordering. ──
const realtimeMock = vi.hoisted(() => {
  type Events = {
    onStatus?: (s: string) => void;
    onMessage?: (m: unknown) => void;
    onError?: (e: Error) => void;
  };
  class FakeRealtimeCaddieClient {
    static instances: FakeRealtimeCaddieClient[] = [];
    // Slice D Gap-2 test support: queue a custom `start()` implementation
    // (e.g. a manually-controlled deferred promise) for the NEXT constructed
    // instance. Consumed (shifted) once per construction; defaults to the
    // instantly-resolving stub when empty.
    static pendingStartImpls: Array<() => Promise<void>> = [];
    opts: Record<string, unknown>;
    events: Events;
    currentStatus = "connecting";
    start: ReturnType<typeof vi.fn>;
    attachMic = vi.fn(async () => {});
    setMuted = vi.fn();
    stop = vi.fn();
    sendText = vi.fn();
    sendContext = vi.fn();
    sendOpener = vi.fn();
    setEvents = vi.fn((e: Events) => {
      this.events = e;
    });
    emitCurrentStatus = vi.fn(() => {
      this.events.onStatus?.(this.currentStatus);
    });
    constructor(opts: Record<string, unknown>, events: Events = {}) {
      this.opts = opts;
      this.events = events;
      const impl = FakeRealtimeCaddieClient.pendingStartImpls.shift();
      this.start = vi.fn(impl ?? (async () => {}));
      FakeRealtimeCaddieClient.instances.push(this);
    }
    emitStatus(s: string) {
      this.currentStatus = s;
      this.events.onStatus?.(s);
    }
    emitMessage(m: unknown) {
      this.events.onMessage?.(m);
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

import CaddieSheet from "./CaddieSheet";
import type { CaddiePersonalityInfo, VoiceCaddieMessage } from "@/lib/caddie/types";
import { REALTIME_IDLE_DISCONNECT_MS } from "@/lib/voice/idle-timer";

type FakeClient = InstanceType<typeof realtimeMock.FakeRealtimeCaddieClient>;

const PERSONAS: CaddiePersonalityInfo[] = [
  { id: "strategist", name: "The Strategist", description: "Numbers", avatar: "📊", response_style: "brief", traits: [] },
];

function buildProps(
  overrides: Partial<React.ComponentProps<typeof CaddieSheet>> = {},
): React.ComponentProps<typeof CaddieSheet> {
  return {
    open: true,
    onClose: vi.fn(),
    caddy: { id: "strategist", name: "The Strategist", initial: "S", tag: "Numbers first" },
    accent: "#3a4a8a",
    holeNumber: 3,
    holePar: 4,
    holeYards: 401,
    convHistory: [],
    onUpdateConvHistory: vi.fn(),
    roundId: "round-123",
    sessionActive: true,
    personaId: "strategist",
    personas: PERSONAS,
    onSelectPersona: vi.fn(),
    ...overrides,
  };
}

function renderSheet(overrides: Partial<React.ComponentProps<typeof CaddieSheet>> = {}) {
  const props = buildProps(overrides);
  const utils = render(<CaddieSheet {...props} />);
  return { ...utils, props };
}

/**
 * Like renderSheet, but `onUpdateConvHistory` actually feeds the updated
 * history back into `convHistory` via a rerender — the real parent
 * (RoundPageClient) lifts this state, but the plain `vi.fn()` spy used
 * elsewhere in this file never loops it back, which is fine for
 * call-args-only assertions but not for a test that needs the seeded
 * fallback transcript to actually render.
 */
function renderControlledSheet(overrides: Partial<React.ComponentProps<typeof CaddieSheet>> = {}) {
  const props = buildProps(overrides);
  let rerenderFn: (ui: React.ReactElement) => void = () => {};
  const onUpdateConvHistory = vi.fn((history: VoiceCaddieMessage[]) => {
    props.convHistory = history;
    rerenderFn(<CaddieSheet {...props} />);
  });
  props.onUpdateConvHistory = onUpdateConvHistory;
  const utils = render(<CaddieSheet {...props} />);
  rerenderFn = utils.rerender;
  return { ...utils, props };
}

/** Drains pending microtasks (async continuations past a mocked `await`). */
async function flush(times = 8) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  liveModeState.value = true;
  warmSessionMock.takeWarm.mockReset();
  warmSessionMock.takeWarm.mockReturnValue(null);
  realtimeMock.FakeRealtimeCaddieClient.instances = [];
  realtimeMock.FakeRealtimeCaddieClient.pendingStartImpls = [];
  ttsSpeakSpy.mockClear();
  ttsBeginStreamSpy.mockClear();
  ttsEnqueueSpy.mockClear();
  ttsEndStreamSpy.mockClear();
  voiceEventSpy.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CaddieSheet live mode — adopt-warm path", () => {
  it("adopts a warm client: setEvents + emitCurrentStatus called, attachMic called exactly once", async () => {
    const warm = new realtimeMock.FakeRealtimeCaddieClient({}, {}) as FakeClient;
    warm.currentStatus = "connected";
    warmSessionMock.takeWarm.mockReturnValue(warm);

    renderSheet();
    await flush();

    expect(warm.setEvents).toHaveBeenCalled();
    expect(warm.emitCurrentStatus).toHaveBeenCalled();
    expect(warm.attachMic).toHaveBeenCalledTimes(1);
    // The cold path must not ALSO fire — only the adopted warm instance exists.
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toEqual([warm]);
  });
});

describe("CaddieSheet live mode — cold-mint path", () => {
  it("constructs RealtimeCaddieClient with {roundId, personalityId}; start() + attachMic called once", async () => {
    renderSheet({ roundId: "round-abc", personaId: "hype" });
    await flush();

    const instances = realtimeMock.FakeRealtimeCaddieClient.instances;
    expect(instances).toHaveLength(1);
    expect(instances[0].opts).toMatchObject({ roundId: "round-abc", personalityId: "hype" });
    expect(instances[0].opts).not.toHaveProperty("mode");
    expect(instances[0].start).toHaveBeenCalledTimes(1);
    expect(instances[0].attachMic).toHaveBeenCalledTimes(1);
  });
});

describe("CaddieSheet live mode — opening turn", () => {
  it("sends the opening turn once connected, via sendOpener wrapping the greeting; never a fabricated user turn; honest-idle when no shot resolves", async () => {
    const resolveOpeningShot = vi.fn(async () => ({ distanceYards: 150 }));
    renderSheet({ resolveOpeningShot });
    await flush();

    const client = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => client.emitStatus("connected"));
    await flush();

    expect(client.sendOpener).toHaveBeenCalledTimes(1);
    expect(client.sendOpener).toHaveBeenCalledWith(
      expect.stringContaining("About 150 to the pin from here. Want a read on the shot?"),
    );
    // Authorship lock — no fabricated user turn goes through sendText.
    expect(client.sendText).not.toHaveBeenCalled();
  });

  it("opening turn carries the hole: connect silently re-anchors (sendContext) BEFORE the spoken opener (sendOpener)", async () => {
    // specs/caddie-stale-hole-live-plan.md §3.4/§3.6/§7 — the connect-time
    // re-anchor is sent first (silent, no response.create), then the spoken
    // opener. Uses buildProps' default holeNumber:3/holePar:4/holeYards:401.
    const resolveOpeningShot = vi.fn(async () => ({ distanceYards: 150 }));
    renderSheet({ resolveOpeningShot });
    await flush();

    const client = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => client.emitStatus("connected"));
    await flush();

    expect(client.sendContext).toHaveBeenCalledTimes(1);
    const contextText = client.sendContext.mock.calls[0][0] as string;
    expect(contextText).toContain("hole 3");
    expect(contextText).toContain("par 4");
    expect(contextText).toContain("401");
    // The existing sendOpener assertion (unchanged) plus ordering: sendContext
    // fires strictly before sendOpener on the same client.
    expect(client.sendOpener).toHaveBeenCalledWith(
      expect.stringContaining("About 150 to the pin from here. Want a read on the shot?"),
    );
    expect(client.sendContext.mock.invocationCallOrder[0]).toBeLessThan(
      client.sendOpener.mock.invocationCallOrder[0],
    );
  });

  it("no double-refresh at connect: exactly one sendContext on connect (the hole-change effect adds no second item for the same hole)", async () => {
    renderSheet();
    await flush();
    const client = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => client.emitStatus("connected"));
    await flush();

    expect(client.sendContext).toHaveBeenCalledTimes(1);
  });

  it("hole-change refresh fires EXACTLY once per change", async () => {
    const { rerender, props } = renderSheet();
    await flush();
    const client = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => client.emitStatus("connected"));
    await flush();
    expect(client.sendContext).toHaveBeenCalledTimes(1); // connect anchor (hole 3)

    // Hole change 3 -> 4: exactly one more sendContext, for hole 4.
    rerender(<CaddieSheet {...props} holeNumber={4} holePar={4} holeYards={380} />);
    await flush();
    expect(client.sendContext).toHaveBeenCalledTimes(2);
    expect(client.sendContext.mock.calls[1][0] as string).toContain("hole 4");

    // Same hole re-rendered again: no additional sendContext.
    rerender(<CaddieSheet {...props} holeNumber={4} holePar={4} holeYards={380} />);
    await flush();
    expect(client.sendContext).toHaveBeenCalledTimes(2);

    // Hole change 4 -> 5: exactly one more.
    rerender(<CaddieSheet {...props} holeNumber={5} holePar={3} holeYards={178} />);
    await flush();
    expect(client.sendContext).toHaveBeenCalledTimes(3);
    expect(client.sendContext.mock.calls[2][0] as string).toContain("hole 5");
  });

  it("does not send an opening turn when resolveOpeningShot resolves null (honest idle)", async () => {
    const resolveOpeningShot = vi.fn(async () => null);
    renderSheet({ resolveOpeningShot });
    await flush();

    const client = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => client.emitStatus("connected"));
    await flush();

    expect(client.sendOpener).not.toHaveBeenCalled();
    expect(client.sendText).not.toHaveBeenCalled();
  });
});

describe("CaddieSheet live mode — transcript order", () => {
  it("renders bubbles in sortByOrder order, not arrival order", async () => {
    renderSheet();
    await flush();
    const client = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => client.emitStatus("connected"));
    await flush();

    // Arrives OUT of conversation order: the reply (order 2) lands before the
    // user's own transcript (order 1) — exactly the real Realtime skew
    // sortByOrder exists to fix (see lib/voice/realtime-ordering.ts).
    act(() => {
      client.emitMessage({ id: "reply-1", role: "assistant", text: "Smooth 7-iron.", partial: false, order: 2 });
      client.emitMessage({ id: "user-1", role: "user", text: "What club from 150?", partial: false, order: 1 });
    });
    await flush();

    const bubbles = screen.getAllByText(/Smooth 7-iron\.|What club from 150\?/);
    expect(bubbles.map((el) => el.textContent)).toEqual(["What club from 150?", "Smooth 7-iron."]);
  });
});

describe("CaddieSheet live mode — mute", () => {
  it("tapping the mute control calls client.setMuted(true) then setMuted(false)", async () => {
    renderSheet();
    await flush();
    const client = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => client.emitStatus("connected"));
    await flush();

    const muteBtn = screen.getByLabelText("Mute");
    fireEvent.click(muteBtn);
    expect(client.setMuted).toHaveBeenNthCalledWith(1, true);

    const unmuteBtn = screen.getByLabelText("Unmute");
    fireEvent.click(unmuteBtn);
    expect(client.setMuted).toHaveBeenNthCalledWith(2, false);
  });
});

describe("CaddieSheet live mode — fallback (never a dead sheet)", () => {
  it("mint-timeout: advancing past MINT_DEADLINE_MS before 'connected' falls to classic mode", async () => {
    vi.useFakeTimers();
    renderSheet();
    // Let the cold-mint promise microtask settle (start() resolves, but no
    // 'connected' status is ever emitted) before advancing the mint timer.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByLabelText("Start recording")).toBeTruthy();
    expect(screen.getByText("Tap-to-talk mode")).toBeTruthy();
  });

  it("connect-fail: status 'closed' before ever connecting falls to classic mode", async () => {
    renderSheet();
    await flush();
    const client = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => client.emitStatus("closed"));
    await flush();

    expect(screen.getByLabelText("Start recording")).toBeTruthy();
    expect(screen.getByText("Tap-to-talk mode")).toBeTruthy();
  });

  it("mic-deny: a rejected attachMic() on the adopted warm client falls to classic mode", async () => {
    const warm = new realtimeMock.FakeRealtimeCaddieClient({}, {}) as FakeClient;
    warm.currentStatus = "connected";
    warm.attachMic.mockRejectedValue(new Error("NotAllowedError"));
    warmSessionMock.takeWarm.mockReturnValue(warm);

    renderSheet();
    await flush();

    expect(screen.getByLabelText("Start recording")).toBeTruthy();
    expect(screen.getByText("Tap-to-talk mode")).toBeTruthy();
  });
});

describe("CaddieSheet live mode — offline at open (spec §9)", () => {
  it("renders the CLASSIC mic (never a dead 'Connecting…' body) when navigator.onLine is false at open", async () => {
    const onLineSpy = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    try {
      liveModeState.value = true;
      renderSheet();
      // The live hook must not activate and the sheet must show the classic
      // tap-to-talk mic — reviewer-caught dead-sheet bug: liveActive omitted
      // navigator.onLine, leaving LiveVoiceBody stuck on "Connecting…" with
      // the classic path gated off.
      expect(await screen.findByLabelText("Start recording")).toBeTruthy();
      expect(screen.queryByText(/Connecting/)).toBeNull();
      expect(warmSessionMock.takeWarm).not.toHaveBeenCalled();
    } finally {
      onLineSpy.mockRestore();
    }
  });
});

describe("CaddieSheet live mode — flag OFF (silent-rider invariant)", () => {
  it("never constructs a client or calls takeWarm; renders the classic UI", async () => {
    liveModeState.value = false;
    renderSheet();
    await flush();

    expect(warmSessionMock.takeWarm).not.toHaveBeenCalled();
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(0);
    expect(screen.getByLabelText("Start recording")).toBeTruthy();
    expect(screen.queryByText("Tap-to-talk mode")).toBeNull();
  });
});

describe("CaddieSheet live mode — no TTS in live", () => {
  it("never calls useSheetTTS.speak on the live happy path", async () => {
    const resolveOpeningShot = vi.fn(async () => ({ distanceYards: 150 }));
    renderSheet({ resolveOpeningShot });
    await flush();
    const client = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => client.emitStatus("connected"));
    await flush();
    act(() => {
      client.emitMessage({ id: "reply-1", role: "assistant", text: "Smooth 7.", partial: false, order: 2 });
    });
    await flush();

    expect(ttsSpeakSpy).not.toHaveBeenCalled();
    expect(ttsBeginStreamSpy).not.toHaveBeenCalled();
    expect(ttsEnqueueSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Slice D — post-connected resilience
// (specs/caddie-realtime-slice-d-plan.md §8). Deterministic, real timers
// unless noted — `sortByOrder` stays real throughout.
// ---------------------------------------------------------------------------

describe("CaddieSheet live mode — Slice D reconnect", () => {
  it("drop -> reconnect SUCCESS: transcript preserved + ordered, no re-greet, no fallback label", async () => {
    const resolveOpeningShot = vi.fn(async () => ({ distanceYards: 150 }));
    renderSheet({ resolveOpeningShot });
    await flush();

    const first = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => first.emitStatus("connected"));
    await flush();
    expect(first.sendOpener).toHaveBeenCalledTimes(1); // opening turn fired once

    act(() => {
      first.emitMessage({ id: "old-1", role: "user", text: "What club from 150?", partial: false, order: 1 });
      first.emitMessage({ id: "old-2", role: "assistant", text: "Smooth 7-iron.", partial: false, order: 2 });
    });
    await flush();

    // Unexpected drop shortly after activity (real timers, tiny elapsed) => reconnect.
    act(() => first.emitStatus("closed"));
    await flush();

    const instances = realtimeMock.FakeRealtimeCaddieClient.instances;
    expect(instances).toHaveLength(2); // exactly one cold-mint reconnect
    const second = instances[1];
    expect(second.start).toHaveBeenCalledTimes(1);
    expect(second.attachMic).toHaveBeenCalledTimes(1);
    // The dead client's handlers were detached before stop() — no re-entrancy.
    expect(first.setEvents).toHaveBeenCalledWith({});
    expect(first.stop).toHaveBeenCalled();

    act(() => second.emitStatus("connected"));
    await flush();
    act(() => {
      second.emitMessage({ id: "new-1", role: "user", text: "What about the wind?", partial: false, order: 1 });
      second.emitMessage({ id: "new-2", role: "assistant", text: "Take one more club.", partial: false, order: 2 });
    });
    await flush();

    // Cross-client ordering (§2.3): the reconnect client's own order (1,2)
    // is offset so it sorts strictly AFTER the preserved pre-drop turns.
    const bubbles = screen.getAllByText(
      /What club from 150\?|Smooth 7-iron\.|What about the wind\?|Take one more club\./,
    );
    expect(bubbles.map((el) => el.textContent)).toEqual([
      "What club from 150?",
      "Smooth 7-iron.",
      "What about the wind?",
      "Take one more club.",
    ]);

    expect(first.sendOpener).toHaveBeenCalledTimes(1); // still just the one opening turn
    expect(second.sendOpener).not.toHaveBeenCalled(); // no re-greet on the reconnect client
    expect(resolveOpeningShot).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Tap-to-talk mode")).toBeNull();
    expect(screen.getByLabelText("Mute")).toBeTruthy(); // still the live footer, not classic mic
  });

  it("drop -> reconnect re-anchors silently: second client's sendContext fires on its connect, sendOpener does NOT (no re-greet)", async () => {
    // specs/caddie-stale-hole-live-plan.md §3.4/§7 — a reconnect mints a
    // fresh (possibly stale) server session; the connect-time anchor still
    // silently re-anchors it, with no spoken re-greet.
    const resolveOpeningShot = vi.fn(async () => ({ distanceYards: 150 }));
    renderSheet({ resolveOpeningShot });
    await flush();

    const first = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => first.emitStatus("connected"));
    await flush();
    expect(first.sendContext).toHaveBeenCalledTimes(1); // connect anchor on the first client

    act(() => first.emitStatus("closed")); // unexpected drop -> reconnect
    await flush();

    const second = realtimeMock.FakeRealtimeCaddieClient.instances[1];
    act(() => second.emitStatus("connected"));
    await flush();

    expect(second.sendContext).toHaveBeenCalledTimes(1); // silent re-anchor
    expect(second.sendOpener).not.toHaveBeenCalled(); // no re-greet
  });

  it("drop -> reconnect FAIL -> classic fallback: mic usable, transcript preserved, no re-greet", async () => {
    const resolveOpeningShot = vi.fn(async () => ({ distanceYards: 150 }));
    renderControlledSheet({ resolveOpeningShot });
    await flush();

    const first = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => first.emitStatus("connected"));
    await flush();

    // Two full turns pre-drop — enough for the classic VoiceBody's history
    // list (which renders everything except the "current" last pair) to
    // surface at least one preserved turn.
    act(() => {
      first.emitMessage({ id: "old-1", role: "user", text: "What club from 150?", partial: false, order: 1 });
      first.emitMessage({ id: "old-2", role: "assistant", text: "Smooth 7-iron.", partial: false, order: 2 });
      first.emitMessage({ id: "old-3", role: "user", text: "And with the wind?", partial: false, order: 3 });
      first.emitMessage({ id: "old-4", role: "assistant", text: "Take one more club.", partial: false, order: 4 });
    });
    await flush();

    act(() => first.emitStatus("closed")); // unexpected drop -> reconnect
    await flush();

    const second = realtimeMock.FakeRealtimeCaddieClient.instances[1];
    act(() => second.emitStatus("closed")); // the reconnect itself fails
    await flush();

    expect(screen.getByLabelText("Start recording")).toBeTruthy();
    expect(screen.getByText("Tap-to-talk mode")).toBeTruthy();
    // The first preserved turn is on screen (VoiceBody's history bucket).
    expect(screen.getByText("What club from 150?")).toBeTruthy();
    expect(screen.getByText("Smooth 7-iron.")).toBeTruthy();
    // No re-greet: the classic auto-open effect never fired a second GPS
    // resolve/opening turn on top of the preserved conversation.
    expect(resolveOpeningShot).toHaveBeenCalledTimes(1);
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(2); // no third mint
  });

  it("fallback-during-pending-start (Gap 2): no resurrection, no second mint", async () => {
    vi.useFakeTimers();
    let resolveStart: () => void = () => {};
    realtimeMock.FakeRealtimeCaddieClient.pendingStartImpls.push(
      () => new Promise<void>((resolve) => { resolveStart = resolve; }),
    );

    renderSheet();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const first = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    expect(first.start).toHaveBeenCalledTimes(1);
    expect(first.attachMic).not.toHaveBeenCalled();

    // Mint deadline fires while start() is still pending -> classic fallback.
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByLabelText("Start recording")).toBeTruthy();
    expect(screen.getByText("Tap-to-talk mode")).toBeTruthy();

    // The long-pending start() now resolves — Gap 2 guard must stop the
    // continuation from resurrecting the dead client.
    await act(async () => {
      resolveStart();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(first.attachMic).not.toHaveBeenCalled(); // no resurrection
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(1); // no second mint
    expect(screen.getByLabelText("Start recording")).toBeTruthy(); // still classic mic
  });

  it("clean idle close does NOT reconnect or fall back", async () => {
    vi.useFakeTimers();
    const resolveOpeningShot = vi.fn(async () => ({ distanceYards: 150 }));
    renderSheet({ resolveOpeningShot });
    await flush();

    const first = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => first.emitStatus("connected"));
    await flush();
    expect(first.sendOpener).toHaveBeenCalledTimes(1);

    act(() => {
      first.emitMessage({ id: "old-1", role: "user", text: "What club from 150?", partial: false, order: 1 });
      first.emitMessage({ id: "old-2", role: "assistant", text: "Smooth 7-iron.", partial: false, order: 2 });
    });
    await flush();

    // Genuine silence for the full idle window — Date advances with the
    // fake timer, so the hook's local activity mirror elapses the threshold.
    await act(async () => {
      vi.advanceTimersByTime(REALTIME_IDLE_DISCONNECT_MS);
    });
    act(() => first.emitStatus("closed"));
    await flush();

    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(1); // no reconnect mint
    expect(screen.queryByText("Tap-to-talk mode")).toBeNull();
    // The live transcript stays visible — resting, not fallen back.
    expect(screen.getByText("What club from 150?")).toBeTruthy();
    expect(screen.getByText("Smooth 7-iron.")).toBeTruthy();
    expect(first.sendOpener).toHaveBeenCalledTimes(1); // not re-fired
  });
});

// ---------------------------------------------------------------------------
// Slice E — idle suspend/resume UX + telemetry
// (specs/caddie-realtime-slice-e-plan.md §9). Deterministic only —
// `sortByOrder` stays real; `voiceEventSpy` is the hoisted telemetry mock.
// ---------------------------------------------------------------------------

describe("CaddieSheet live mode — Slice E idle suspend/resume", () => {
  it("idle -> suspend sets the visible paused state and keeps messages", async () => {
    vi.useFakeTimers();
    renderSheet();
    await flush();

    const first = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => first.emitStatus("connected"));
    await flush();

    act(() => {
      first.emitMessage({ id: "old-1", role: "user", text: "What club from 150?", partial: false, order: 1 });
      first.emitMessage({ id: "old-2", role: "assistant", text: "Smooth 7-iron.", partial: false, order: 2 });
    });
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(REALTIME_IDLE_DISCONNECT_MS);
    });
    act(() => first.emitStatus("closed"));
    await flush();

    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(1); // no reconnect mint
    expect(screen.getByLabelText("Resume listening")).toBeTruthy();
    expect(screen.getByText("Paused — tap to resume")).toBeTruthy();
    expect(screen.queryByLabelText("Mute")).toBeNull();
    expect(screen.queryByText("Tap-to-talk mode")).toBeNull();
    expect(screen.getByText("What club from 150?")).toBeTruthy();
    expect(screen.getByText("Smooth 7-iron.")).toBeTruthy();
    expect(voiceEventSpy).toHaveBeenCalledWith("caddie", "live_suspend", { flush: true });
  });

  it("suspend -> resume -> live, no re-greet, order offset applied", async () => {
    vi.useFakeTimers();
    const resolveOpeningShot = vi.fn(async () => ({ distanceYards: 150 }));
    renderSheet({ resolveOpeningShot });
    await flush();

    const first = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => first.emitStatus("connected"));
    await flush();

    act(() => {
      first.emitMessage({ id: "old-1", role: "user", text: "What club from 150?", partial: false, order: 1 });
      first.emitMessage({ id: "old-2", role: "assistant", text: "Smooth 7-iron.", partial: false, order: 2 });
    });
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(REALTIME_IDLE_DISCONNECT_MS);
    });
    act(() => first.emitStatus("closed"));
    await flush();

    act(() => fireEvent.click(screen.getByLabelText("Resume listening")));
    await flush();

    const instances = realtimeMock.FakeRealtimeCaddieClient.instances;
    expect(instances).toHaveLength(2);
    const second = instances[1];
    expect(second.start).toHaveBeenCalledTimes(1);
    expect(second.attachMic).toHaveBeenCalledTimes(1);
    expect(second.sendOpener).not.toHaveBeenCalled(); // no re-greet
    expect(resolveOpeningShot).toHaveBeenCalledTimes(1); // still just the one opening turn
    expect(voiceEventSpy).toHaveBeenCalledWith("caddie", "live_resume");

    act(() => second.emitStatus("connected"));
    await flush();
    act(() => {
      second.emitMessage({ id: "new-1", role: "user", text: "What about the wind?", partial: false, order: 1 });
      second.emitMessage({ id: "new-2", role: "assistant", text: "Take one more club.", partial: false, order: 2 });
    });
    await flush();

    const bubbles = screen.getAllByText(
      /What club from 150\?|Smooth 7-iron\.|What about the wind\?|Take one more club\./,
    );
    expect(bubbles.map((el) => el.textContent)).toEqual([
      "What club from 150?",
      "Smooth 7-iron.",
      "What about the wind?",
      "Take one more club.",
    ]);

    expect(screen.getByLabelText("Mute")).toBeTruthy(); // back to the live footer
    expect(screen.queryByText("Paused — tap to resume")).toBeNull();
  });

  it("resume re-anchors silently: the resumed client's sendContext fires on its connect, sendOpener does NOT (no re-greet)", async () => {
    // specs/caddie-stale-hole-live-plan.md §3.4/§7 — Slice E resume mints a
    // fresh (possibly stale) server session too; the connect-time anchor
    // silently corrects it.
    vi.useFakeTimers();
    renderSheet();
    await flush();

    const first = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => first.emitStatus("connected"));
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(REALTIME_IDLE_DISCONNECT_MS);
    });
    act(() => first.emitStatus("closed"));
    await flush();

    act(() => fireEvent.click(screen.getByLabelText("Resume listening")));
    await flush();

    const second = realtimeMock.FakeRealtimeCaddieClient.instances[1];
    act(() => second.emitStatus("connected"));
    await flush();

    expect(second.sendContext).toHaveBeenCalledTimes(1);
    expect(second.sendOpener).not.toHaveBeenCalled(); // no re-greet
  });

  it("resume does not double-attach mic (double-tap guard)", async () => {
    vi.useFakeTimers();
    renderSheet();
    await flush();

    const first = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => first.emitStatus("connected"));
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(REALTIME_IDLE_DISCONNECT_MS);
    });
    act(() => first.emitStatus("closed"));
    await flush();

    const resumeBtn = screen.getByLabelText("Resume listening");
    act(() => {
      fireEvent.click(resumeBtn);
      fireEvent.click(resumeBtn);
    });
    await flush();

    const instances = realtimeMock.FakeRealtimeCaddieClient.instances;
    expect(instances).toHaveLength(2); // not 3
    expect(instances[1].attachMic).toHaveBeenCalledTimes(1);
  });

  it("suspend -> resume -> suspend-again cycle", async () => {
    vi.useFakeTimers();
    renderSheet();
    await flush();

    const first = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => first.emitStatus("connected"));
    await flush();
    act(() => {
      first.emitMessage({ id: "old-1", role: "user", text: "What club from 150?", partial: false, order: 1 });
      first.emitMessage({ id: "old-2", role: "assistant", text: "Smooth 7-iron.", partial: false, order: 2 });
    });
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(REALTIME_IDLE_DISCONNECT_MS);
    });
    act(() => first.emitStatus("closed"));
    await flush();

    act(() => fireEvent.click(screen.getByLabelText("Resume listening")));
    await flush();

    const second = realtimeMock.FakeRealtimeCaddieClient.instances[1];
    act(() => second.emitStatus("connected"));
    await flush();
    act(() => {
      second.emitMessage({ id: "new-1", role: "user", text: "What about the wind?", partial: false, order: 1 });
    });
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(REALTIME_IDLE_DISCONNECT_MS);
    });
    act(() => second.emitStatus("closed"));
    await flush();

    expect(screen.getByLabelText("Resume listening")).toBeTruthy();
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(2); // second suspend mints nothing
    expect(second.setEvents).toHaveBeenCalledWith({});
    expect(screen.getByText("What club from 150?")).toBeTruthy();
    expect(screen.getByText("Smooth 7-iron.")).toBeTruthy();
    expect(screen.getByText("What about the wind?")).toBeTruthy();
    expect(screen.queryByText("Tap-to-talk mode")).toBeNull();
  });

  it("resume FAILURE falls back to classic, preserving the pre-suspend transcript", async () => {
    vi.useFakeTimers();
    const resolveOpeningShot = vi.fn(async () => ({ distanceYards: 150 }));
    renderControlledSheet({ resolveOpeningShot });
    await flush();

    const first = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => first.emitStatus("connected"));
    await flush();

    act(() => {
      first.emitMessage({ id: "old-1", role: "user", text: "What club from 150?", partial: false, order: 1 });
      first.emitMessage({ id: "old-2", role: "assistant", text: "Smooth 7-iron.", partial: false, order: 2 });
      first.emitMessage({ id: "old-3", role: "user", text: "And with the wind?", partial: false, order: 3 });
      first.emitMessage({ id: "old-4", role: "assistant", text: "Take one more club.", partial: false, order: 4 });
    });
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(REALTIME_IDLE_DISCONNECT_MS);
    });
    act(() => first.emitStatus("closed"));
    await flush();

    act(() => fireEvent.click(screen.getByLabelText("Resume listening")));
    await flush();

    const second = realtimeMock.FakeRealtimeCaddieClient.instances[1];
    act(() => second.emitStatus("closed")); // the resumed client itself fails
    await flush();

    expect(screen.getByLabelText("Start recording")).toBeTruthy();
    expect(screen.getByText("Tap-to-talk mode")).toBeTruthy();
    expect(screen.getByText("What club from 150?")).toBeTruthy();
    expect(screen.getByText("Smooth 7-iron.")).toBeTruthy();
    expect(resolveOpeningShot).toHaveBeenCalledTimes(1); // no re-greet
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(2); // no third mint
  });

  it("a real drop AFTER a resume still gets its own auto-reconnect (budget not stolen)", async () => {
    vi.useFakeTimers();
    renderSheet();
    await flush();

    const first = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => first.emitStatus("connected"));
    await flush();

    // Idle-suspend, then resume.
    await act(async () => {
      vi.advanceTimersByTime(REALTIME_IDLE_DISCONNECT_MS);
    });
    act(() => first.emitStatus("closed"));
    await flush();
    act(() => fireEvent.click(screen.getByLabelText("Resume listening")));
    await flush();

    const second = realtimeMock.FakeRealtimeCaddieClient.instances[1];
    act(() => second.emitStatus("connected"));
    await flush();

    // Real drop shortly after activity (tiny elapsed -> classified as a
    // drop, not idle) -> the resumed burst gets its OWN auto-reconnect,
    // because doResume() reset reconnectUsedRef.
    act(() => second.emitStatus("closed"));
    await flush();

    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(3); // the auto-reconnect
    expect(screen.queryByText("Tap-to-talk mode")).toBeNull();

    // Definitive variant: a real drop consumes the FIRST burst's budget,
    // succeeds, then idle-suspend -> resume -> a SECOND real drop still
    // gets its own auto-reconnect (the reset composes across bursts).
    const third = realtimeMock.FakeRealtimeCaddieClient.instances[2];
    act(() => third.emitStatus("connected"));
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(REALTIME_IDLE_DISCONNECT_MS);
    });
    act(() => third.emitStatus("closed")); // idle-suspend again
    await flush();
    act(() => fireEvent.click(screen.getByLabelText("Resume listening")));
    await flush();

    const fourth = realtimeMock.FakeRealtimeCaddieClient.instances[3];
    act(() => fourth.emitStatus("connected"));
    await flush();
    act(() => fourth.emitStatus("closed")); // a second real drop, its own budget
    await flush();

    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(5);
    expect(screen.queryByText("Tap-to-talk mode")).toBeNull();
  });

  it("empty-transcript idle -> suspend: footer says paused, empty-state does NOT claim the caddy is listening", async () => {
    // No resolveOpeningShot passed (default undefined) -> no opening turn is
    // ever sent (honest idle, §786 in CaddieSheet.tsx), so the transcript
    // stays empty the whole time. Regression for the empty-state hint that
    // used to stay keyed on stale `status` and kept claiming "is listening"
    // even after the footer had already flipped to "Paused — tap to resume".
    vi.useFakeTimers();
    renderSheet();
    await flush();

    const first = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => first.emitStatus("connected"));
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(REALTIME_IDLE_DISCONNECT_MS);
    });
    act(() => first.emitStatus("closed"));
    await flush();

    expect(screen.getByText("Paused — tap to resume")).toBeTruthy();
    expect(screen.queryByText(/is listening/i)).toBeNull();
  });

  it("speaking with zero messages: empty state says the caddy is speaking, not listening (edge 3)", async () => {
    // Regression for the held-turn empty-state honesty bug
    // (specs/caddie-voice-reliability-hardening-plan.md §3): a held clarifier
    // pushes status to 'speaking' (audio IS playing) while the transcript is
    // still empty. The empty state must never contradict the footer's
    // "Caddie speaking…" claim with a fake "is listening" one.
    renderSheet();
    await flush();

    const client = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => client.emitStatus("speaking"));
    await flush();

    expect(screen.queryByText(/is listening/i)).toBeNull();
    expect(screen.getByText("The Strategist is speaking.")).toBeTruthy();
    expect(screen.getByText("Caddie speaking…")).toBeTruthy();

    // Back to 'connected' — the listening hint returns.
    act(() => client.emitStatus("connected"));
    await flush();

    expect(screen.queryByText(/is speaking\.$/i)).toBeNull();
    expect(screen.getByText("Go ahead — The Strategist is listening.")).toBeTruthy();
  });
});
