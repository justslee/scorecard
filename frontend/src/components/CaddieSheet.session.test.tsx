// @vitest-environment jsdom
//
// CaddieSheet session-path wiring (agentic caddie P1).
//
// The sheet must be session-first — /caddie/session/voice + /session/recommend
// with the REAL persona id — and silently fall back to the stateless
// /caddie/voice + /caddie/recommend path when there is no session (legacy /
// offline rounds) or a session call fails. These tests drive the real
// component with the backend + mic mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import * as React from "react";

// ── Mocks ──
//
// framer-motion — CaddieSheet wraps EVERY phase transition in
// `AnimatePresence mode="wait"` (VoiceBody's "answered" bubble sits behind
// one). Real framer-motion animations depend on requestAnimationFrame,
// which jsdom doesn't implement; `mode="wait"` specifically DEFERS mounting
// new content until the previous keyed element's exit animation resolves —
// under jsdom's rAF gap that resolution can be inconsistent, which was
// bleeding into these tests as an unrelated source of flakiness (content
// never appearing within the poll window, independent of any app-state
// bug). Strip animation entirely: render children immediately, no timing
// dependency left at all.
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

// `@/lib/caddie/stream-buffer` is mocked to a SYNCHRONOUS stand-in (push
// delivers immediately, no scheduled frame at all). The real hook coalesces
// via `window.requestAnimationFrame`/a timer fallback — exercised for real,
// deterministically, under fake timers in `stream-buffer.test.ts`. Driving
// CaddieSheet's ladder tests through the REAL scheduler was flaky under a
// full parallel `vitest run`: a real setTimeout/rAF-fallback flush can
// legitimately lose the race against CPU contention across ~70 concurrent
// jsdom suites, and widening testing-library's poll window just masked it
// intermittently rather than fixing it. Removing the real timer from this
// file's critical path removes the race outright.
//
// BeforeFirstByteError must be a REAL class (not vi.fn()) — CaddieSheet's
// ladder does `instanceof BeforeFirstByteError` checks against the SAME
// mocked module, so the class identity must match exactly. vi.hoisted() so
// both the (hoisted) vi.mock factory below AND test bodies can construct it.
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
    push: (delta: string) => onFlush(delta), // synchronous — no scheduled frame, no real timer
    flush: () => {},
    cancel: () => {},
  }),
}));

// useSheetTTS — spied directly so "tts.speak called exactly once with the
// full text" is a clean assertion, independent of the localStorage-gated
// mute pref (default OFF) and the real speakCaddieReply fetch.
//
// beginStream/enqueue/endStream are the sentence-pipelining queue API
// (specs/caddie-realtime-conversation-plan.md §6.5.4, Slice A2) — every
// reply in THIS file is short enough to stay under CaddieSheet's
// MIN_TTS_CHUNK_CHARS merge threshold, so nothing is ever pipelined
// mid-stream and completion always falls back to the plain tts.speak() call
// these assertions check — exactly the old, pre-A2 behavior. Stubbed here
// only so the component doesn't crash calling them.
const ttsSpeakSpy = vi.fn();
const ttsUnlockSpy = vi.fn();
const ttsStopSpy = vi.fn();
const ttsBeginStreamSpy = vi.fn();
const ttsEnqueueSpy = vi.fn();
const ttsEndStreamSpy = vi.fn();
vi.mock("@/hooks/useSheetTTS", () => ({
  useSheetTTS: () => ({
    unlock: ttsUnlockSpy,
    speak: ttsSpeakSpy,
    beginStream: ttsBeginStreamSpy,
    enqueue: ttsEnqueueSpy,
    endStream: ttsEndStreamSpy,
    stop: ttsStopSpy,
    isSpeaking: false,
  }),
}));

const startSpy = vi.fn().mockResolvedValue(undefined);
const stopSpy = vi.fn();
const cancelSpy = vi.fn();
vi.mock("@/lib/voice/deepgram", () => ({
  VoiceRecorder: class {
    static isSupported() {
      return true;
    }
    start = startSpy;
    stop = stopSpy;
    cancel = cancelSpy;
    getStream = vi.fn(() => ({}) as MediaStream);
  },
  transcribeBlob: vi.fn(),
}));

// Live dictation (specs/caddie-live-dictation-plan.md): a controllable fake
// so tests can fire onInterim/onFinal and force start() failures.
const liveState = vi.hoisted(() => ({
  instances: [] as Array<{
    events: {
      onInterim?: (t: string) => void;
      onFinal?: (t: string) => void;
      onError?: (e: Error) => void;
    };
    stop: ReturnType<typeof vi.fn>;
  }>,
  supported: true,
  startError: null as Error | null,
}));
vi.mock("@/lib/voice/deepgram-live", () => ({
  DeepgramLiveTranscriber: class {
    events: (typeof liveState.instances)[number]["events"];
    stop = vi.fn();
    constructor(events: (typeof liveState.instances)[number]["events"]) {
      this.events = events;
      liveState.instances.push(this);
    }
    static isSupported() {
      return liveState.supported;
    }
    async start() {
      if (liveState.startError) throw liveState.startError;
    }
  },
}));

import CaddieSheet from "./CaddieSheet";
import {
  sessionRecommend,
  talkToCaddie,
  fetchRecommendation,
  sessionVoiceStream,
  talkToCaddieStream,
} from "@/lib/caddie/api";
import { transcribeBlob } from "@/lib/voice/deepgram";
import type { CaddieRecommendation } from "@/lib/caddie/types";

const sessionRecommendMock = vi.mocked(sessionRecommend);
const talkToCaddieMock = vi.mocked(talkToCaddie);
const fetchRecommendationMock = vi.mocked(fetchRecommendation);
const transcribeMock = vi.mocked(transcribeBlob);
const sessionVoiceStreamMock = vi.mocked(sessionVoiceStream);
const talkToCaddieStreamMock = vi.mocked(talkToCaddieStream);

/**
 * A hand-controlled streaming mock: `mockImpl` is the `mockImplementationOnce`
 * body (captures `onToken`, returns a promise that only settles when the
 * TEST calls `resolve`/`reject`). `pushToken` calls the captured `onToken`
 * directly, from the test body, wrapped in `act()` by the caller — so the
 * test dictates EXACTLY when each token lands and gets a real render commit
 * to inspect in between, with zero dependency on any timer OR even a
 * microtask race (a bare `await Promise.resolve()` drains eagerly enough
 * that the whole mock can resolve before `findByText` ever gets to inspect
 * an intermediate state — this sidesteps that entirely). Use for any test
 * that needs to observe genuine mid-stream UI, not just the final text.
 */
function deferredStream() {
  let resolveFn!: (value: string) => void;
  let rejectFn!: (err: unknown) => void;
  let onTokenFn: ((delta: string) => void) | null = null;
  const promise = new Promise<string>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    mockImpl: (_params: unknown, opts: { onToken: (delta: string) => void }) => {
      onTokenFn = opts.onToken;
      return promise;
    },
    pushToken: (delta: string) => onTokenFn?.(delta),
    resolve: (full: string) => resolveFn(full),
    reject: (err: unknown) => rejectFn(err),
  };
}

/**
 * A promise the TEST resolves by hand — used to hold `resolveOpeningShot`'s
 * GPS fix pending so a test can interleave a user action (mic tap / a normal
 * askCaddie turn) INTO the multi-second gap before the auto opening turn's
 * continuation runs.
 */
function deferredValue<T>() {
  let resolveFn!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
}

/**
 * Drives the LIVE dictation path (not blob transcription) so `isTranscribing`
 * never flips true. `stopListening`'s blob branch only clears
 * `isTranscribing` in a `finally` that runs AFTER `askCaddie` fully settles —
 * for a test that holds a stream open (or observes any state before the
 * turn resolves), that masks the phase this describe block is testing
 * behind a stale "Transcribing…" for the whole turn. The live path never
 * sets it in the first place, sidestepping the whole class of issue.
 */
async function speakAndStop(transcript: string) {
  fireEvent.click(screen.getByLabelText("Start recording"));
  await waitFor(() => expect(liveState.instances).toHaveLength(1));
  act(() => liveState.instances[liveState.instances.length - 1].events.onFinal?.(transcript));
  fireEvent.click(screen.getByLabelText("Stop recording"));
}

/** Emits `tokens` synchronously (no yield of any kind between them —
 *  `async` only for the Promise<string> return shape) and resolves with the
 *  joined string — the default for streaming mocks that only need the FINAL
 *  text, not an observed intermediate one. */
async function emitTokensSync(opts: { onToken: (delta: string) => void }, tokens: string[]): Promise<string> {
  let full = "";
  for (const t of tokens) {
    opts.onToken(t);
    full += t;
  }
  return full;
}

const REC: CaddieRecommendation = {
  club: "7-iron",
  target_yards: 152,
  raw_yards: 150,
  aim_point: { description: "center of green" },
  reasoning: ["Wind is helping off the right."],
  miss_side: { preferred: "left", description: "short-side right is dead", avoid: "right" },
  adjustments: [],
  confidence: 0.8,
  aggressiveness: "moderate",
};

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
    personas: [
      {
        id: "classic",
        name: "The Classic Caddie",
        description: "Traditional",
        avatar: "🏌️",
        response_style: "conversational",
        traits: [],
      },
      {
        id: "strategist",
        name: "The Strategist",
        description: "Numbers",
        avatar: "📊",
        response_style: "brief",
        traits: [],
      },
      {
        id: "hype",
        name: "The Hype Man",
        description: "Energy",
        avatar: "🔥",
        response_style: "conversational",
        traits: [],
      },
    ],
    onSelectPersona: vi.fn(),
    ...overrides,
  };
}

function renderSheet(overrides: Partial<React.ComponentProps<typeof CaddieSheet>> = {}) {
  const props = buildProps(overrides);
  render(<CaddieSheet {...props} />);
  return props;
}

async function requestRecommendation(distance = "152") {
  fireEvent.click(screen.getByText("Distance"));
  fireEvent.change(screen.getByPlaceholderText("e.g. 155"), { target: { value: distance } });
  fireEvent.click(screen.getByText("Advise"));
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  startSpy.mockResolvedValue(undefined);
  stopSpy.mockResolvedValue(new Blob());
  liveState.instances.length = 0;
  liveState.supported = true;
  liveState.startError = null;
});

// A settled mock promise's continuation (the `askCaddie` code after `await
// sessionVoiceStream(...)`) resolves OUTSIDE of any React "discrete event" —
// React's scheduler is free to defer that commit. If a test's `it()` returns
// before that work is fully flushed, the NEXT test's `beforeEach` cleanup()
// unmounts while it's still pending, which can bleed timing into the next
// test — repeat the drain a few ticks and unmount HERE (not just in the
// next test's beforeEach) so nothing crosses a test boundary still pending.
afterEach(async () => {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  cleanup();
});

describe("CaddieSheet — session-first recommendation", () => {
  it("uses /session/recommend with the round id when a session is active", async () => {
    sessionRecommendMock.mockResolvedValueOnce(REC);
    renderSheet();
    await requestRecommendation();

    await waitFor(() => expect(sessionRecommendMock).toHaveBeenCalledTimes(1));
    expect(sessionRecommendMock).toHaveBeenCalledWith({
      round_id: "round-123",
      hole_number: 3,
      distance_yards: 152,
      par: 4,
      yards: 401,
    });
    expect(fetchRecommendationMock).not.toHaveBeenCalled();
    expect(await screen.findByText("7-iron")).toBeTruthy();
  });

  it("stays on the stateless path when no session exists (legacy/offline)", async () => {
    fetchRecommendationMock.mockResolvedValueOnce(REC);
    renderSheet({ sessionActive: false });
    await requestRecommendation();

    await waitFor(() => expect(fetchRecommendationMock).toHaveBeenCalledTimes(1));
    expect(sessionRecommendMock).not.toHaveBeenCalled();
    expect(await screen.findByText("7-iron")).toBeTruthy();
  });

  it("falls back to the stateless path when the session call fails", async () => {
    sessionRecommendMock.mockRejectedValueOnce(new Error("session expired"));
    fetchRecommendationMock.mockResolvedValueOnce(REC);
    renderSheet();
    await requestRecommendation();

    await waitFor(() => expect(fetchRecommendationMock).toHaveBeenCalledTimes(1));
    expect(sessionRecommendMock).toHaveBeenCalledTimes(1);
    // The player still gets the answer — silent downgrade, no error surface.
    expect(await screen.findByText("7-iron")).toBeTruthy();
  });
});

describe("CaddieSheet — streaming ladder (specs/voice-streaming-replies-plan.md)", () => {
  it("tier 1: streams the reply from /session/voice/stream, renders progressively, updates history, speaks once", async () => {
    const stream = deferredStream();
    sessionVoiceStreamMock.mockImplementationOnce(stream.mockImpl);
    const props = renderSheet();

    await speakAndStop("what club from here?");

    await waitFor(() => expect(sessionVoiceStreamMock).toHaveBeenCalledTimes(1));
    expect(sessionVoiceStreamMock).toHaveBeenCalledWith(
      {
        round_id: "round-123",
        transcript: "what club from here?",
        personality_id: "strategist",
        hole_number: 3,
        // Plumbed by specs/caddie-yardage-gps-selected-tee-plan.md §2.3 — the
        // resolved yardage + its provenance ride along on every turn.
        distance_to_green_yards: undefined,
        hole_yards: 401,
        yardage_basis: undefined,
        tee_name: undefined,
      },
      expect.objectContaining({ onToken: expect.any(Function) }),
    );
    expect(talkToCaddieStreamMock).not.toHaveBeenCalled();
    expect(talkToCaddieMock).not.toHaveBeenCalled();

    // Progressive: the first chunk renders BEFORE the second one lands —
    // test-driven, not timer-driven, so there's no race to observe it.
    act(() => stream.pushToken("Easy 7. "));
    expect(await screen.findByText("Easy 7.", { exact: false })).toBeTruthy();
    expect(screen.queryByText("Easy 7. Center of the green.")).toBeNull(); // not yet — second chunk hasn't landed

    act(() => {
      stream.pushToken("Center of the green.");
      stream.resolve("Easy 7. Center of the green.");
    });
    expect(await screen.findByText("Easy 7. Center of the green.")).toBeTruthy();

    // History updates with the FULL text only, once the stream resolves.
    expect(props.onUpdateConvHistory).toHaveBeenCalledWith([
      { role: "user", content: "what club from here?" },
      { role: "assistant", content: "Easy 7. Center of the green." },
    ]);
    // TTS fires exactly once, with the complete text. "Easy 7. " completes a
    // sentence boundary mid-stream, but it's under MIN_TTS_CHUNK_CHARS so it
    // merges with the rest rather than pipelining as its own chunk — the
    // exact old single-call behavior (specs/caddie-realtime-conversation-plan.md §6.5.4).
    expect(ttsSpeakSpy).toHaveBeenCalledTimes(1);
    expect(ttsSpeakSpy).toHaveBeenCalledWith("Easy 7. Center of the green.", "strategist");
    expect(ttsEnqueueSpy).not.toHaveBeenCalled();
  });

  it("does NOT mount the follow-up/clear CTAs or re-arm the mic mid-stream — only once the reply is complete", async () => {
    const stream = deferredStream();
    sessionVoiceStreamMock.mockImplementationOnce(stream.mockImpl);
    renderSheet();

    await speakAndStop("what club?");

    await waitFor(() => expect(sessionVoiceStreamMock).toHaveBeenCalledTimes(1));

    // Mid-stream: the first chunk is on screen, but the reply isn't done yet.
    act(() => stream.pushToken("Take the "));
    expect(await screen.findByText("Take the", { exact: false })).toBeTruthy();
    expect(screen.queryByText("Ask follow-up")).toBeNull();
    expect(screen.queryByLabelText("Start recording")).toBeNull(); // mic not re-armed
    expect(screen.queryByLabelText("Stop recording")).toBeNull();

    // Once the stream completes, the CTAs mount and the mic re-arms.
    act(() => {
      stream.pushToken("8-iron.");
      stream.resolve("Take the 8-iron.");
    });
    expect(await screen.findByText("Take the 8-iron.")).toBeTruthy();
    expect(await screen.findByText("Ask follow-up")).toBeTruthy();
    expect(await screen.findByLabelText("Start recording")).toBeTruthy();
  });

  it("tier 1 -> tier 2: a pre-first-token session failure falls back to /caddie/voice/stream (still streaming)", async () => {
    sessionVoiceStreamMock.mockRejectedValueOnce(new MockBeforeFirstByteError());
    talkToCaddieStreamMock.mockImplementationOnce((_params, opts) => emitTokensSync(opts, ["Lay up to 95."]));
    renderSheet();

    await speakAndStop("lay up or go?");

    await waitFor(() => expect(talkToCaddieStreamMock).toHaveBeenCalledTimes(1));
    expect(talkToCaddieStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: "lay up or go?", personality_id: "strategist", hole_number: 3 }),
      expect.objectContaining({ onToken: expect.any(Function) }),
    );
    expect(talkToCaddieMock).not.toHaveBeenCalled(); // tier 2 succeeded — tier 3 never runs
    expect(await screen.findByText("Lay up to 95.")).toBeTruthy();
    expect(ttsSpeakSpy).toHaveBeenCalledTimes(1);
  });

  it("tier 1 -> tier 2 -> tier 3: both streaming tiers fail pre-first-token, lands on the non-streaming fallback", async () => {
    sessionVoiceStreamMock.mockRejectedValueOnce(new MockBeforeFirstByteError());
    talkToCaddieStreamMock.mockRejectedValueOnce(new MockBeforeFirstByteError());
    talkToCaddieMock.mockResolvedValueOnce({ response: "Take the 8-iron." });
    renderSheet();

    await speakAndStop("what now?");

    await waitFor(() => expect(talkToCaddieMock).toHaveBeenCalledTimes(1));
    expect(talkToCaddieMock).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: "what now?", personality_id: "strategist", hole_number: 3 }),
    );
    expect(await screen.findByText("Take the 8-iron.")).toBeTruthy();
    expect(ttsSpeakSpy).toHaveBeenCalledTimes(1);
    expect(ttsSpeakSpy).toHaveBeenCalledWith("Take the 8-iron.", "strategist");
  });

  it("a POST-first-token failure is TERMINAL — no fallback, partial discarded, calm error shown, TTS never fires", async () => {
    sessionVoiceStreamMock.mockImplementationOnce(async (_params, opts) => {
      opts.onToken("Partial reply "); // a token already rendered...
      throw new Error("mid-stream failure — not a BeforeFirstByteError");
    });
    renderSheet();

    await speakAndStop("what club?");

    // Never falls through to a lower tier once a token has rendered.
    await waitFor(() => expect(sessionVoiceStreamMock).toHaveBeenCalledTimes(1));
    expect(talkToCaddieStreamMock).not.toHaveBeenCalled();
    expect(talkToCaddieMock).not.toHaveBeenCalled();

    // humanizeVoiceError passes short, human-looking messages through as-is
    // (only raw/machine-looking text falls back to the generic calm copy).
    expect(await screen.findByText("mid-stream failure — not a BeforeFirstByteError")).toBeTruthy();
    expect(screen.queryByText(/Partial reply/)).toBeNull(); // discarded, not left on screen
    expect(ttsSpeakSpy).not.toHaveBeenCalled(); // gated on `done` — never fires on a terminal failure
  });

  it("skips tier 1 entirely when there is no session (legacy/offline rounds)", async () => {
    talkToCaddieStreamMock.mockImplementationOnce((_params, opts) => emitTokensSync(opts, ["Smooth 6."]));
    renderSheet({ sessionActive: false });

    await speakAndStop("what club?");

    await waitFor(() => expect(talkToCaddieStreamMock).toHaveBeenCalledTimes(1));
    expect(sessionVoiceStreamMock).not.toHaveBeenCalled();
    expect(await screen.findByText("Smooth 6.")).toBeTruthy();
  });
});

describe("CaddieSheet — live dictation (specs/caddie-live-dictation-plan.md)", () => {
  it("shows live words while speaking and sends the LIVE transcript — no blob upload, no Transcribing", async () => {
    sessionVoiceStreamMock.mockImplementationOnce((_params, opts) => emitTokensSync(opts, ["Smooth 8-iron."]));
    renderSheet();

    fireEvent.click(screen.getByLabelText("Start recording"));
    await waitFor(() => expect(liveState.instances).toHaveLength(1));
    const live = liveState.instances[0];

    act(() => live.events.onInterim?.("what club"));
    expect(await screen.findByText("“what club”")).toBeTruthy();
    act(() => {
      live.events.onInterim?.("what club from 150");
      live.events.onFinal?.("what club from 150");
    });

    fireEvent.click(screen.getByLabelText("Stop recording"));

    await waitFor(() => expect(sessionVoiceStreamMock).toHaveBeenCalledTimes(1));
    expect(sessionVoiceStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: "what club from 150" }),
      expect.objectContaining({ onToken: expect.any(Function) }),
    );
    // The whole point: no batch transcription, no "Transcribing…" dead state.
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Transcribing…")).toBeNull();
    expect(cancelSpy).toHaveBeenCalled(); // mic released on the live path too
    expect(await screen.findByText("Smooth 8-iron.")).toBeTruthy();
  });

  it("falls back to the blob upload when the live socket fails to start", async () => {
    liveState.startError = new Error("ws down");
    transcribeMock.mockResolvedValueOnce({ transcript: "lay up or go?" } as never);
    sessionVoiceStreamMock.mockImplementationOnce((_params, opts) => emitTokensSync(opts, ["Lay up to 95."]));
    renderSheet();

    fireEvent.click(screen.getByLabelText("Start recording"));
    fireEvent.click(await screen.findByLabelText("Stop recording"));

    await waitFor(() => expect(sessionVoiceStreamMock).toHaveBeenCalledTimes(1));
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    expect(sessionVoiceStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: "lay up or go?" }),
      expect.objectContaining({ onToken: expect.any(Function) }),
    );
  });

  it("falls back when live errored mid-utterance even with partial text", async () => {
    transcribeMock.mockResolvedValueOnce({ transcript: "full sentence from blob" } as never);
    sessionVoiceStreamMock.mockImplementationOnce((_params, opts) => emitTokensSync(opts, ["Got it."]));
    renderSheet();

    fireEvent.click(screen.getByLabelText("Start recording"));
    await waitFor(() => expect(liveState.instances).toHaveLength(1));
    const live = liveState.instances[0];
    act(() => {
      live.events.onInterim?.("full sen"); // partial before the socket died
      live.events.onError?.(new Error("ws dropped"));
    });

    fireEvent.click(screen.getByLabelText("Stop recording"));

    await waitFor(() => expect(sessionVoiceStreamMock).toHaveBeenCalledTimes(1));
    expect(transcribeMock).toHaveBeenCalledTimes(1); // authoritative fallback
    expect(sessionVoiceStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: "full sentence from blob" }),
      expect.objectContaining({ onToken: expect.any(Function) }),
    );
  });

  it("shows the no-speech error when live heard nothing and the blob is empty too", async () => {
    transcribeMock.mockResolvedValueOnce({ transcript: "  " } as never);
    renderSheet();

    fireEvent.click(screen.getByLabelText("Start recording"));
    fireEvent.click(await screen.findByLabelText("Stop recording"));

    expect(
      await screen.findByText("No speech detected. Tap the mic to try again."),
    ).toBeTruthy();
    expect(sessionVoiceStreamMock).not.toHaveBeenCalled();
  });
});

describe("CaddieSheet — persona picker", () => {
  it("opens from the header and reports the chosen persona id", async () => {
    const props = renderSheet();

    fireEvent.click(screen.getByLabelText("Change caddie persona"));
    fireEvent.click(await screen.findByLabelText("Choose The Hype Man"));

    expect(props.onSelectPersona).toHaveBeenCalledWith("hype");
  });
});

describe("CaddieSheet — auto opening shot recommendation (specs/caddie-auto-shot-reco-plan.md)", () => {
  it("(a) fires exactly once on fresh open: seeds the caddie-authored greeting deterministically, no network turn, no fabricated user line, and (e) completes the same lifecycle as a normal reply", async () => {
    const resolveOpeningShot = vi.fn().mockResolvedValue({ distanceYards: 147 });
    const props = renderSheet({ resolveOpeningShot });

    await waitFor(() => expect(resolveOpeningShot).toHaveBeenCalledTimes(1));

    const greeting = "About 147 to the pin from here. Want a read on the shot?";
    expect(await screen.findByText(greeting)).toBeTruthy();

    // Core defect lock: no network turn for the opener, and no fabricated
    // user line in the seeded history — an assistant-only greeting.
    expect(sessionVoiceStreamMock).not.toHaveBeenCalled();
    expect(talkToCaddieStreamMock).not.toHaveBeenCalled();
    expect(talkToCaddieMock).not.toHaveBeenCalled();
    expect(props.onUpdateConvHistory).toHaveBeenCalledWith([{ role: "assistant", content: greeting }]);

    expect(ttsSpeakSpy).toHaveBeenCalledTimes(1);
    expect(ttsSpeakSpy).toHaveBeenCalledWith(greeting, "strategist");
    expect(ttsEnqueueSpy).not.toHaveBeenCalled();

    // (e) same completion lifecycle as a normal reply: follow-up mounts, mic re-arms.
    expect(await screen.findByText("Ask follow-up")).toBeTruthy();
    expect(await screen.findByLabelText("Start recording")).toBeTruthy();
  });

  it("(a-tee) fromTee:true resolves to the honest from-the-tee greeting (specs/caddie-opening-reco-from-tee-plan.md)", async () => {
    const resolveOpeningShot = vi.fn().mockResolvedValue({ distanceYards: 365, fromTee: true });
    const props = renderSheet({ resolveOpeningShot });

    await waitFor(() => expect(resolveOpeningShot).toHaveBeenCalledTimes(1));

    const greeting = "You're on the tee — about 365 to the pin. Want a read on the tee shot?";
    expect(await screen.findByText(greeting)).toBeTruthy();
    expect(screen.queryByText(/from here/)).toBeNull();

    // No network mocks called for the opener; history has no user role.
    expect(sessionVoiceStreamMock).not.toHaveBeenCalled();
    expect(talkToCaddieStreamMock).not.toHaveBeenCalled();
    expect(talkToCaddieMock).not.toHaveBeenCalled();
    expect(props.onUpdateConvHistory).toHaveBeenCalledWith([{ role: "assistant", content: greeting }]);
  });

  it("(b) does not fire with no active session — sheet opens idle", async () => {
    const resolveOpeningShot = vi.fn().mockResolvedValue({ distanceYards: 147 });
    renderSheet({ sessionActive: false, resolveOpeningShot });

    // Guard is synchronous (no GPS awaited) — assert immediately.
    expect(resolveOpeningShot).not.toHaveBeenCalled();
    expect(sessionVoiceStreamMock).not.toHaveBeenCalled();
    expect(talkToCaddieStreamMock).not.toHaveBeenCalled();
    expect(talkToCaddieMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Ask anything/)).toBeTruthy();
  });

  it("(b2) does not fire with no GPS fix, and is not retried", async () => {
    const resolveOpeningShot = vi.fn().mockResolvedValue(null);
    renderSheet({ resolveOpeningShot });

    await waitFor(() => expect(resolveOpeningShot).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(sessionVoiceStreamMock).not.toHaveBeenCalled();
    expect(talkToCaddieStreamMock).not.toHaveBeenCalled();
    expect(talkToCaddieMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Ask anything/)).toBeTruthy();
    expect(screen.queryByText(/on the tee/)).toBeNull(); // honest idle, no fabricated tee phrasing

    // Advance further ticks — no retry-spam.
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(resolveOpeningShot).toHaveBeenCalledTimes(1);
  });

  it("(c-i) does not re-fire on a re-render after the opening turn resolved", async () => {
    const resolveOpeningShot = vi.fn().mockResolvedValue({ distanceYards: 130 });
    const props = buildProps({ resolveOpeningShot });
    const { rerender } = render(<CaddieSheet {...props} />);

    await waitFor(() => expect(resolveOpeningShot).toHaveBeenCalledTimes(1));
    const greeting = "About 130 to the pin from here. Want a read on the shot?";
    expect(await screen.findByText(greeting)).toBeTruthy();

    rerender(<CaddieSheet {...props} accent="#000000" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(ttsSpeakSpy).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText(greeting)).toHaveLength(1);
    expect(resolveOpeningShot).toHaveBeenCalledTimes(1);
  });

  it("(c-ii) does not auto-fire when reopened onto an existing conversation", async () => {
    const resolveOpeningShot = vi.fn().mockResolvedValue({ distanceYards: 150 });
    renderSheet({
      resolveOpeningShot,
      convHistory: [
        { role: "user", content: "what club from here?" },
        { role: "assistant", content: "Easy 7." },
      ],
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(resolveOpeningShot).not.toHaveBeenCalled();
    expect(sessionVoiceStreamMock).not.toHaveBeenCalled();
  });

  it("(c2) fires exactly once under React.StrictMode double-effect invoke", async () => {
    const resolveOpeningShot = vi.fn().mockResolvedValue({ distanceYards: 120 });
    const props = buildProps({ resolveOpeningShot });

    render(
      <React.StrictMode>
        <CaddieSheet {...props} />
      </React.StrictMode>,
    );

    const greeting = "About 120 to the pin from here. Want a read on the shot?";
    expect(await screen.findByText(greeting)).toBeTruthy();
    expect(resolveOpeningShot).toHaveBeenCalledTimes(1);
    expect(ttsSpeakSpy).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText(greeting)).toHaveLength(1);
  });

  it("(d) the opener makes zero backend calls, even with the session stream primed to reject", async () => {
    sessionVoiceStreamMock.mockRejectedValueOnce(new Error("network gone"));
    const resolveOpeningShot = vi.fn().mockResolvedValue({ distanceYards: 165 });
    renderSheet({ resolveOpeningShot });

    await waitFor(() => expect(resolveOpeningShot).toHaveBeenCalledTimes(1));
    const greeting = "About 165 to the pin from here. Want a read on the shot?";
    expect(await screen.findByText(greeting)).toBeTruthy();
    // No network turn for the opener at all — the primed rejection never fires.
    expect(sessionVoiceStreamMock).not.toHaveBeenCalled();
    expect(screen.queryByText("network gone")).toBeNull();
    expect(ttsSpeakSpy).toHaveBeenCalledTimes(1);
    expect(ttsSpeakSpy).toHaveBeenCalledWith(greeting, "strategist");
    // The primed rejection is never consumed (no network call) — vi.clearAllMocks()
    // (beforeEach) does not drop a queued mockRejectedValueOnce implementation, so
    // reset explicitly here to avoid leaking it into the next test.
    sessionVoiceStreamMock.mockReset();
  });

  it("(f) does not stomp a user turn started while the GPS fix is still pending", async () => {
    // GPS fix stays pending until the test resolves it by hand — this is the
    // multi-second real-world gap a golfer can tap the mic and ask their own
    // question inside.
    const gps = deferredValue<{ distanceYards: number } | null>();
    const resolveOpeningShot = vi.fn(() => gps.promise);
    const userStream = deferredStream();
    sessionVoiceStreamMock.mockImplementationOnce(userStream.mockImpl);
    const props = renderSheet({ resolveOpeningShot });

    await waitFor(() => expect(resolveOpeningShot).toHaveBeenCalledTimes(1));

    // The golfer asks their own question WHILE the GPS fix is still pending.
    await speakAndStop("what's the wind?");
    await waitFor(() => expect(sessionVoiceStreamMock).toHaveBeenCalledTimes(1));
    expect(sessionVoiceStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: "what's the wind?" }),
      expect.objectContaining({ onToken: expect.any(Function) }),
    );

    // NOW the GPS fix resolves — the auto opening turn must NOT seed a
    // greeting over the in-flight/answered user turn.
    act(() => {
      gps.resolve({ distanceYards: 147 });
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(sessionVoiceStreamMock).toHaveBeenCalledTimes(1); // no second (auto) call
    expect(screen.queryByText(/About 147 to the pin/)).toBeNull(); // greeting never rendered
    expect(props.onUpdateConvHistory).not.toHaveBeenCalledWith([
      { role: "assistant", content: "About 147 to the pin from here. Want a read on the shot?" },
    ]); // opener never seeded
    expect(screen.getByText("what's the wind?", { exact: false })).toBeTruthy(); // user's transcript intact

    // The user's own turn is untouched by the abort and completes normally.
    act(() => {
      userStream.pushToken("Helping, 8mph.");
      userStream.resolve("Helping, 8mph.");
    });
    expect(await screen.findByText("Helping, 8mph.")).toBeTruthy();
    expect(await screen.findByText("Ask follow-up")).toBeTruthy();
    expect(await screen.findByLabelText("Start recording")).toBeTruthy();
    expect(ttsSpeakSpy).toHaveBeenCalledTimes(1);
    expect(ttsSpeakSpy).toHaveBeenCalledWith("Helping, 8mph.", "strategist");
  });
});
