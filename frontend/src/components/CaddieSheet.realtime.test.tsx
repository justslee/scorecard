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
vi.mock("@/lib/voice/telemetry", () => ({
  voiceEvent: vi.fn(),
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
    opts: Record<string, unknown>;
    events: Events;
    currentStatus = "connecting";
    start = vi.fn(async () => {});
    attachMic = vi.fn(async () => {});
    setMuted = vi.fn();
    stop = vi.fn();
    sendText = vi.fn();
    setEvents = vi.fn((e: Events) => {
      this.events = e;
    });
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
import type { CaddiePersonalityInfo } from "@/lib/caddie/types";

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
  ttsSpeakSpy.mockClear();
  ttsBeginStreamSpy.mockClear();
  ttsEnqueueSpy.mockClear();
  ttsEndStreamSpy.mockClear();
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
  it("sends the opening turn once connected, via the buildOpeningTurnText string; honest-idle when no shot resolves", async () => {
    const resolveOpeningShot = vi.fn(async () => ({ distanceYards: 150 }));
    renderSheet({ resolveOpeningShot });
    await flush();

    const client = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => client.emitStatus("connected"));
    await flush();

    expect(client.sendText).toHaveBeenCalledTimes(1);
    expect(client.sendText).toHaveBeenCalledWith(
      "I'm about 150 yards from the pin. What should I hit or do on this next shot?",
    );
  });

  it("does not send an opening turn when resolveOpeningShot resolves null (honest idle)", async () => {
    const resolveOpeningShot = vi.fn(async () => null);
    renderSheet({ resolveOpeningShot });
    await flush();

    const client = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => client.emitStatus("connected"));
    await flush();

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
