// @vitest-environment jsdom
//
// CaddieSheet — hands-free conversational loop
// (specs/caddie-conversational-loop-plan.md). Dedicated file so its
// `vi.useFakeTimers()` cannot leak a dead stub into `CaddieSheet.session.test.tsx`
// or any other jsdom suite (tasks/lessons.md 2026-07-07). Every timer- and
// TTS-driven transition is hand-controlled — the `useSheetTTS` mock captures
// `onPlaybackEnd` and exposes `firePlaybackEnd()`; grace/dead-air delays are
// advanced via `vi.advanceTimersByTime`, never a real setTimeout.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import * as React from "react";

// Mirror the module-scope constants in CaddieSheet.tsx exactly (not exported
// — these are the plan's §3.2 constants, duplicated here so the test asserts
// against the real values rather than re-deriving them).
const REARM_GRACE_MS = 400;
const DEAD_AIR_MS = 6000;
const MAX_EMPTY_STREAK = 2;
void MAX_EMPTY_STREAK; // documents the third-arm-blocked assertions below

// ── framer-motion passthrough (identical to CaddieSheet.session.test.tsx —
// jsdom has no rAF, and AnimatePresence mode="wait" otherwise defers mounts
// unpredictably under it). ──
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
// Synchronous stand-in — no rAF/timer dependency in the streaming render path
// (mirrors CaddieSheet.session.test.tsx; the real coalescer has its own
// fake-timer test in stream-buffer.test.ts).
vi.mock("@/lib/caddie/stream-buffer", () => ({
  useStreamBuffer: (onFlush: (chunk: string) => void) => ({
    push: (delta: string) => onFlush(delta),
    flush: () => {},
    cancel: () => {},
  }),
}));

// The speaker pref — forced ON by default (this whole file tests the
// hands-free loop, which is implicit-armed only when the speaker is on).
const enabledState = { value: true };
vi.mock("@/lib/voice/tts-pref", () => ({
  getSheetTtsEnabled: () => enabledState.value,
  setSheetTtsEnabled: vi.fn(),
}));

// useSheetTTS — a CAPTURING mock: records the latest `onPlaybackEnd`/
// `onSpeakStart` the component registered (mirrors the real hook's
// ref-mirror pattern) so tests fire them by hand via `firePlaybackEnd()` /
// `fireSpeakStart()`. `isSpeaking` is a plain field the test can flip
// directly, read fresh on every render (a `rerender()` is needed to observe
// a change, exactly like a real state update would).
//
// beginStream/enqueue/endStream are the sentence-pipelining queue API
// (specs/caddie-realtime-conversation-plan.md §6.5.4, Slice A2) — every
// scripted reply in THIS file is a single short token with no trailing
// whitespace, so it never crosses a mid-stream sentence boundary; completion
// always falls back to the plain speak() call these assertions check —
// exactly the old, pre-A2 behavior. Stubbed here only so the component
// doesn't crash calling them.
const ttsState = vi.hoisted(() => ({
  isSpeaking: false,
  onPlaybackEnd: null as null | (() => void),
  onSpeakStart: null as null | (() => void),
  speakSpy: vi.fn(),
  unlockSpy: vi.fn(),
  stopSpy: vi.fn(),
  beginStreamSpy: vi.fn(),
  enqueueSpy: vi.fn(),
  endStreamSpy: vi.fn(),
}));
vi.mock("@/hooks/useSheetTTS", () => ({
  useSheetTTS: (opts?: { onPlaybackEnd?: () => void; onSpeakStart?: () => void }) => {
    ttsState.onPlaybackEnd = opts?.onPlaybackEnd ?? null;
    ttsState.onSpeakStart = opts?.onSpeakStart ?? null;
    return {
      unlock: ttsState.unlockSpy,
      speak: ttsState.speakSpy,
      beginStream: ttsState.beginStreamSpy,
      enqueue: ttsState.enqueueSpy,
      endStream: ttsState.endStreamSpy,
      stop: ttsState.stopSpy,
      isSpeaking: ttsState.isSpeaking,
    };
  },
}));

// Stage-timing telemetry (specs/caddie-realtime-telemetry-plan.md §5) — mock
// the bus the timer emits/flushes through, so this suite can assert the four
// `caddie-turn` markers land with plausible ms on a real (unmocked)
// createCaddieTurnTimer, driven by a scripted `performance.now`.
const telemetryState = vi.hoisted(() => ({
  voiceEvent: vi.fn(),
  flushVoiceEvents: vi.fn(),
}));
vi.mock("@/lib/voice/telemetry", () => ({
  voiceEvent: (...args: unknown[]) => telemetryState.voiceEvent(...args),
  flushVoiceEvents: (...args: unknown[]) => telemetryState.flushVoiceEvents(...args),
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

const liveState = vi.hoisted(() => ({
  instances: [] as Array<{
    events: {
      onInterim?: (t: string) => void;
      onFinal?: (t: string) => void;
      onUtteranceEnd?: () => void;
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
import { sessionVoiceStream } from "@/lib/caddie/api";
import { transcribeBlob } from "@/lib/voice/deepgram";
import type { CaddiePersonalityInfo } from "@/lib/caddie/types";

const sessionVoiceStreamMock = vi.mocked(sessionVoiceStream);
const transcribeMock = vi.mocked(transcribeBlob);

const PERSONAS: CaddiePersonalityInfo[] = [
  {
    id: "strategist",
    name: "The Strategist",
    description: "Numbers",
    avatar: "📊",
    response_style: "brief",
    traits: [],
  },
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
    // No resolveOpeningShot — the auto opening reco is out of scope for this
    // file (it composes with the loop via the SAME onPlaybackEnd wiring
    // covered generically here; caddie-auto-shot-reco-plan.md's own tests
    // cover its firing rules).
    ...overrides,
  };
}

function renderSheet(overrides: Partial<React.ComponentProps<typeof CaddieSheet>> = {}) {
  const props = buildProps(overrides);
  const utils = render(<CaddieSheet {...props} />);
  return { ...utils, props };
}

/** Fires the captured `onPlaybackEnd` by hand — never a real TTS/audio event. */
function firePlaybackEnd() {
  act(() => {
    ttsState.onPlaybackEnd?.();
  });
}

/** Fires the captured `onSpeakStart` by hand — simulates a real speak()'s
 *  play() resolving, without a real HTMLAudioElement. */
function fireSpeakStart() {
  act(() => {
    ttsState.onSpeakStart?.();
  });
}

/** Drains pending microtasks (async continuations past a mocked `await`)
 *  without ever touching a real timer — safe under `vi.useFakeTimers()`. */
async function flush(times = 8) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** Emits `tokens` synchronously and resolves with the joined string. */
async function emitTokensSync(opts: { onToken: (delta: string) => void }, tokens: string[]): Promise<string> {
  let full = "";
  for (const t of tokens) {
    opts.onToken(t);
    full += t;
  }
  return full;
}

/** Drives a MANUAL (tap-started) turn via the live dictation path. */
async function speakAndStop(transcript: string) {
  fireEvent.click(screen.getByLabelText("Start recording"));
  await flush();
  const live = liveState.instances[liveState.instances.length - 1];
  act(() => live.events.onFinal?.(transcript));
  fireEvent.click(screen.getByLabelText("Stop recording"));
  await flush();
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useFakeTimers();
  enabledState.value = true;
  ttsState.isSpeaking = false;
  ttsState.onPlaybackEnd = null;
  ttsState.onSpeakStart = null;
  telemetryState.voiceEvent.mockReset();
  telemetryState.flushVoiceEvents.mockReset();
  startSpy.mockResolvedValue(undefined);
  stopSpy.mockResolvedValue(new Blob());
  liveState.instances.length = 0;
  liveState.supported = true;
  liveState.startError = null;
});

afterEach(() => {
  // Drain anything this test forgot to flush before swapping back to real
  // timers — a fake-clock reference must never leak across jsdom files
  // (tasks/lessons.md 2026-07-07, the CaddieSheet.session.test.tsx incident).
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  cleanup();
});

describe("CaddieSheet — hands-free conversational loop (specs/caddie-conversational-loop-plan.md)", () => {
  it("(1) re-arms the mic REARM_GRACE_MS after playback ends", async () => {
    renderSheet();

    firePlaybackEnd();
    expect(startSpy).not.toHaveBeenCalled(); // grace window, not yet
    await act(async () => {
      vi.advanceTimersByTime(REARM_GRACE_MS);
    });
    await flush();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Stop recording")).toBeTruthy(); // phase: listening
  });

  it("(2) does not arm before the grace delay, arms exactly at it", async () => {
    renderSheet();

    firePlaybackEnd();
    await act(async () => {
      vi.advanceTimersByTime(REARM_GRACE_MS - 1);
    });
    await flush();
    expect(startSpy).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("(3) never re-arms when the speaker pref is off", async () => {
    enabledState.value = false;
    renderSheet();
    await flush(); // let the mount effect read the (false) pref

    firePlaybackEnd();
    await act(async () => {
      vi.advanceTimersByTime(REARM_GRACE_MS);
    });
    await flush();

    expect(startSpy).not.toHaveBeenCalled();
  });

  it("(4) drops out on dead air after an auto re-arm — calm idle, no error, and no further re-arm", async () => {
    renderSheet();

    firePlaybackEnd();
    await act(async () => {
      vi.advanceTimersByTime(REARM_GRACE_MS);
    });
    await flush();
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Stop recording")).toBeTruthy();

    // Total silence — no onInterim ever fires.
    await act(async () => {
      vi.advanceTimersByTime(DEAD_AIR_MS);
    });
    await flush();

    expect(cancelSpy).toHaveBeenCalled(); // recorder released, no ask
    expect(screen.getByLabelText("Start recording")).toBeTruthy(); // back to idle mic
    expect(screen.getByText("Tap to speak")).toBeTruthy(); // calm idle copy
    expect(screen.queryByText(/No speech detected/)).toBeNull(); // no error/red

    // Dropped out — a further playback-end must not re-arm.
    firePlaybackEnd();
    await act(async () => {
      vi.advanceTimersByTime(REARM_GRACE_MS);
    });
    await flush();
    expect(startSpy).toHaveBeenCalledTimes(1); // unchanged
  });

  it("(4b) onInterim cancels the dead-air timer — speech in flight is never dropped for silence", async () => {
    renderSheet();

    firePlaybackEnd();
    await act(async () => {
      vi.advanceTimersByTime(REARM_GRACE_MS);
    });
    await flush();
    const live = liveState.instances[liveState.instances.length - 1];

    act(() => live.events.onInterim?.("what"));
    await act(async () => {
      vi.advanceTimersByTime(DEAD_AIR_MS); // would have dropped out, but interim cancelled it
    });
    await flush();

    expect(screen.getByLabelText("Stop recording")).toBeTruthy(); // still listening
    expect(screen.queryByText("Tap to speak")).toBeNull();
  });

  it("(5) drops out after two consecutive loop-armed empty listens", async () => {
    transcribeMock.mockResolvedValue({ transcript: "" } as never);
    renderSheet();

    // First loop-armed listen — ambient noise trips UtteranceEnd, nothing usable.
    firePlaybackEnd();
    await act(async () => {
      vi.advanceTimersByTime(REARM_GRACE_MS);
    });
    await flush();
    expect(liveState.instances).toHaveLength(1);
    act(() => liveState.instances[0].events.onUtteranceEnd?.());
    await flush();

    expect(screen.queryByText(/No speech detected/)).toBeNull(); // still calm — 1 of 2
    expect(screen.getByText("Tap to speak")).toBeTruthy();

    // Second loop-armed listen, also empty.
    firePlaybackEnd();
    await act(async () => {
      vi.advanceTimersByTime(REARM_GRACE_MS);
    });
    await flush();
    expect(liveState.instances).toHaveLength(2);
    act(() => liveState.instances[1].events.onUtteranceEnd?.());
    await flush();

    expect(screen.queryByText(/No speech detected/)).toBeNull(); // still calm — dropped out, not errored
    expect(screen.getByText("Tap to speak")).toBeTruthy();

    // Dropped out — a third playback-end must not arm a 3rd listen.
    firePlaybackEnd();
    await act(async () => {
      vi.advanceTimersByTime(REARM_GRACE_MS);
    });
    await flush();
    expect(liveState.instances).toHaveLength(2); // unchanged
  });

  it("(6) barge-in stops playback, clears the pending grace timer, and opens the mic manually", async () => {
    const { rerender, props } = renderSheet();

    firePlaybackEnd(); // schedules a grace timer — do NOT advance it
    ttsState.isSpeaking = true;
    rerender(<CaddieSheet {...props} />); // pick up the new isSpeaking value

    fireEvent.click(screen.getByLabelText("Start recording")); // tap while "speaking"
    await flush();

    expect(ttsState.stopSpy).toHaveBeenCalledTimes(1); // playback interrupted
    expect(startSpy).toHaveBeenCalledTimes(1); // the manual tap opened the mic
    expect(screen.getByLabelText("Stop recording")).toBeTruthy();

    // The pending grace timer was cleared by the barge-in — advancing past it
    // must NOT open a second recorder.
    await act(async () => {
      vi.advanceTimersByTime(REARM_GRACE_MS);
    });
    await flush();
    expect(startSpy).toHaveBeenCalledTimes(1); // unchanged
  });

  it("(7a) closing the sheet clears a pending grace timer — no leaked re-arm", async () => {
    const { rerender, props } = renderSheet();

    firePlaybackEnd(); // grace timer pending, not yet fired
    rerender(<CaddieSheet {...props} open={false} />);
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(REARM_GRACE_MS + DEAD_AIR_MS);
    });
    await flush();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("(7b) closing the sheet mid-listen cancels the recorder and clears the dead-air timer — no leak", async () => {
    const { rerender, props } = renderSheet();

    firePlaybackEnd();
    await act(async () => {
      vi.advanceTimersByTime(REARM_GRACE_MS);
    });
    await flush();
    expect(startSpy).toHaveBeenCalledTimes(1); // loop-armed listen open, dead-air timer running

    rerender(<CaddieSheet {...props} open={false} />);
    await flush();
    expect(cancelSpy).toHaveBeenCalled(); // close cancels the open recorder

    const startCallsAfterClose = startSpy.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(DEAD_AIR_MS);
    });
    await flush();
    expect(startSpy.mock.calls.length).toBe(startCallsAfterClose); // dead-air timer didn't fire/leak
  });

  it("(8) happy multi-turn loop: playback-end re-arms repeatedly, and a successful turn resets the empty-streak", async () => {
    sessionVoiceStreamMock.mockImplementationOnce((_params, opts) => emitTokensSync(opts, ["Turn one."]));
    renderSheet();

    // Turn one — manual tap (not loop-armed).
    await speakAndStop("what club?");
    expect(screen.getByText("Turn one.")).toBeTruthy();
    expect(ttsState.speakSpy).toHaveBeenCalledTimes(1);

    // Turn one's playback ends -> the loop re-arms.
    firePlaybackEnd();
    await act(async () => {
      vi.advanceTimersByTime(REARM_GRACE_MS);
    });
    await flush();
    expect(liveState.instances).toHaveLength(2); // manual + loop-armed
    expect(screen.getByLabelText("Stop recording")).toBeTruthy();

    // The golfer speaks turn two into the loop-armed listen.
    sessionVoiceStreamMock.mockImplementationOnce((_params, opts) => emitTokensSync(opts, ["Turn two."]));
    act(() => liveState.instances[1].events.onFinal?.("what now?"));
    act(() => liveState.instances[1].events.onUtteranceEnd?.());
    await flush();
    expect(screen.getByText("Turn two.")).toBeTruthy();
    expect(ttsState.speakSpy).toHaveBeenCalledTimes(2);

    // Turn two's playback ends -> re-arms again (the loop keeps going).
    firePlaybackEnd();
    await act(async () => {
      vi.advanceTimersByTime(REARM_GRACE_MS);
    });
    await flush();
    expect(liveState.instances).toHaveLength(3);

    // This 3rd loop-armed listen ends empty. The streak was reset to 0 by
    // turn two's success, so ONE empty listen must NOT drop the loop out.
    transcribeMock.mockResolvedValueOnce({ transcript: "" } as never);
    act(() => liveState.instances[2].events.onUtteranceEnd?.());
    await flush();
    expect(screen.getByText("Tap to speak")).toBeTruthy();
    expect(screen.queryByText(/No speech detected/)).toBeNull();

    // Still armed (not dropped out) — a further playback-end re-arms a 4th time.
    firePlaybackEnd();
    await act(async () => {
      vi.advanceTimersByTime(REARM_GRACE_MS);
    });
    await flush();
    expect(liveState.instances).toHaveLength(4);
  });

  // ── Designer follow-up: the auto re-arm must not wipe the just-spoken
  // answer off screen (specs/caddie-conversational-loop-plan.md §3.3/§3.7
  // amendment). ──

  it("(9) persists the opening auto-reco answer across the loop's auto re-arm (first turn)", async () => {
    sessionVoiceStreamMock.mockImplementationOnce((_params, opts) =>
      emitTokensSync(opts, ["Smooth 7-iron, 143 to the flag."]),
    );
    const resolveOpeningShot = vi.fn().mockResolvedValue({ distanceYards: 143 });
    renderSheet({ resolveOpeningShot, convHistory: [] });
    await flush();

    expect(screen.getByText(/Smooth 7-iron, 143 to the flag\./)).toBeTruthy();
    expect(ttsState.speakSpy).toHaveBeenCalledTimes(1);

    // The loop re-arms the mic after playback ends.
    firePlaybackEnd();
    await act(async () => {
      vi.advanceTimersByTime(REARM_GRACE_MS);
    });
    await flush();

    expect(screen.getByLabelText("Stop recording")).toBeTruthy(); // mic reopened
    // The answer the golfer just heard is STILL on screen — this is the bug:
    // it used to vanish the instant the mic reopened.
    expect(screen.getByText(/Smooth 7-iron, 143 to the flag\./)).toBeTruthy();
  });

  it("(10) persists a LATER turn's answer across the loop's auto re-arm, and hides the follow-up/clear CTAs while listening", async () => {
    sessionVoiceStreamMock.mockImplementationOnce((_params, opts) => emitTokensSync(opts, ["Turn one."]));
    renderSheet();
    await speakAndStop("what club?");
    expect(screen.getByText("Turn one.")).toBeTruthy();

    firePlaybackEnd();
    await act(async () => {
      vi.advanceTimersByTime(REARM_GRACE_MS);
    });
    await flush();
    expect(liveState.instances).toHaveLength(2);

    sessionVoiceStreamMock.mockImplementationOnce((_params, opts) => emitTokensSync(opts, ["Turn two."]));
    act(() => liveState.instances[1].events.onFinal?.("what now?"));
    act(() => liveState.instances[1].events.onUtteranceEnd?.());
    await flush();
    expect(screen.getByText("Turn two.")).toBeTruthy();

    // Loop re-arms a THIRD time — turn two's answer must survive it.
    firePlaybackEnd();
    await act(async () => {
      vi.advanceTimersByTime(REARM_GRACE_MS);
    });
    await flush();

    expect(screen.getByLabelText("Stop recording")).toBeTruthy();
    expect(screen.getByText("Turn two.")).toBeTruthy(); // the assertion this bug broke
    // The follow-up/clear CTAs sit on the now-persisting answer card — they
    // must not stay live while a new turn is already in flight.
    expect(screen.queryByText("Ask follow-up")).toBeNull();
  });

  it("(11) a MANUAL mic tap still clears the persisted answer immediately (no loop-armed carryover)", async () => {
    sessionVoiceStreamMock.mockImplementationOnce((_params, opts) => emitTokensSync(opts, ["Turn one."]));
    renderSheet();
    await speakAndStop("what club?");
    expect(screen.getByText("Turn one.")).toBeTruthy();

    // The golfer taps the mic themselves — NOT the loop's playback-end
    // re-arm — while the answer is still showing.
    fireEvent.click(screen.getByLabelText("Start recording"));
    await flush();

    expect(screen.getByLabelText("Stop recording")).toBeTruthy(); // listening
    expect(screen.queryByText("Turn one.")).toBeNull(); // manual tap clears it, unlike a loop re-arm
  });

  it("(12) the mic label is never the contradictory 'Tap to ask again' during the auto re-arm grace window", async () => {
    sessionVoiceStreamMock.mockImplementationOnce((_params, opts) => emitTokensSync(opts, ["Turn one."]));
    renderSheet();
    await speakAndStop("what club?");
    expect(screen.getByText("Turn one.")).toBeTruthy();

    firePlaybackEnd(); // grace timer pending — mic not reopened yet
    await flush();

    // Hands-free is armed and about to reopen the mic on its own; telling
    // the golfer to "tap to ask again" here would be the exact contradiction
    // the owner asked to remove.
    expect(screen.queryByText("Tap to ask again")).toBeNull();
    expect(screen.getByText("Tap to interrupt")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(REARM_GRACE_MS);
    });
    await flush();
    expect(screen.getByLabelText("Stop recording")).toBeTruthy(); // now actually listening
  });

  it("(13) a loop-armed listen that ends with nothing said drops the persisted answer and settles to plain idle", async () => {
    // Guards the empty-streak/dead-air abandonment path against the fix
    // above: once a re-armed listen concludes WITHOUT a new turn, the stale
    // answer must not linger forever — it reverts to the same calm idle as
    // before this change, rather than a permanent "Tap to interrupt" ghost.
    sessionVoiceStreamMock.mockImplementationOnce((_params, opts) => emitTokensSync(opts, ["Turn one."]));
    renderSheet();
    await speakAndStop("what club?");
    expect(screen.getByText("Turn one.")).toBeTruthy();

    firePlaybackEnd();
    await act(async () => {
      vi.advanceTimersByTime(REARM_GRACE_MS);
    });
    await flush();
    expect(screen.getByText("Turn one.")).toBeTruthy(); // still there while listening

    // This re-armed listen ends empty (ambient noise, nothing usable).
    act(() => liveState.instances[1].events.onUtteranceEnd?.());
    await flush();

    expect(screen.getByText("Tap to speak")).toBeTruthy(); // plain idle, no ghost answer
    expect(screen.queryByText("Turn one.")).toBeNull();
    expect(screen.queryByText(/No speech detected/)).toBeNull(); // still calm, not an error
  });

  // specs/caddie-realtime-telemetry-plan.md §5 — the classic-path wiring
  // proof: a real (unmocked) createCaddieTurnTimer, driven end-to-end
  // through a hands-free turn, with only the telemetry bus mocked and
  // `performance.now` scripted for deterministic ms.
  it("(14) emits the four caddie-turn stage-timing markers with plausible ms, and flushes each stage-timing leg immediately", async () => {
    sessionVoiceStreamMock.mockImplementationOnce((_params, opts) => emitTokensSync(opts, ["Turn one."]));

    const nowSpy = vi.spyOn(performance, "now");
    nowSpy
      .mockReturnValueOnce(0) // markEos — top of stopListening
      .mockReturnValueOnce(150) // markTranscript — finalText resolved
      .mockReturnValueOnce(500) // markFirstToken — first streamed token
      .mockReturnValue(1200); // markFirstAudio — TTS play() resolves (fireSpeakStart)

    renderSheet();
    await speakAndStop("what club?");
    expect(screen.getByText("Turn one.")).toBeTruthy();

    // Text legs (eos_to_transcript, transcript_to_first_token) are already in
    // by the time the transcript+streamed reply have landed — each one flushed
    // immediately as it emitted, independent of first audio.
    expect(telemetryState.voiceEvent).toHaveBeenCalledWith("caddie-turn", "caddie.eos_to_transcript", { ms: 150 });
    expect(telemetryState.voiceEvent).toHaveBeenCalledWith("caddie-turn", "caddie.transcript_to_first_token", { ms: 350 });
    expect(telemetryState.flushVoiceEvents).toHaveBeenCalledTimes(2);

    fireSpeakStart(); // simulates the real speak()'s play() resolving

    expect(telemetryState.voiceEvent).toHaveBeenCalledWith("caddie-turn", "caddie.first_token_to_first_audio", {
      ms: 700,
    });
    expect(telemetryState.voiceEvent).toHaveBeenCalledWith("caddie-turn", "caddie.eos_to_first_audio", { ms: 1200 });
    expect(telemetryState.voiceEvent).toHaveBeenCalledTimes(4);
    expect(telemetryState.flushVoiceEvents).toHaveBeenCalledTimes(3); // + one terminal flush for the two audio legs
  });
});
