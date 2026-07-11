// @vitest-environment jsdom
//
// CaddieOrbSheet — the generic caddie-orb sheet host
// (specs/orb-s2-context-contract-teetime-plan.md §9). Drives the real
// component with the bus (`openLooper`) and registry (`registerCaddieContext`)
// used for real; only the network/mic/haptics/TTS edges are mocked.

import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

// framer-motion — strip animation so AnimatePresence mounts/unmounts
// synchronously (same rationale + pattern as CaddieSheet.session.test.tsx).
// Component identity is memoized per tag — the Proxy's `get` trap fires on
// EVERY JSX access (`<motion.div>` re-reads the property every render);
// returning a fresh component function there would give React a new
// component IDENTITY each render, forcing an unmount+remount instead of an
// update (a real footgun: stale captured DOM nodes, effects re-firing).
vi.mock("framer-motion", () => {
  const passthroughTags = new Set(["div", "button", "span", "svg", "path"]);
  const cache = new Map<string, React.ForwardRefExoticComponent<Record<string, unknown>>>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        if (!passthroughTags.has(tag)) return undefined;
        const cached = cache.get(tag);
        if (cached) return cached;
        const Passthrough = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
          const {
            initial: _initial,
            animate: _animate,
            exit: _exit,
            transition: _transition,
            ...rest
          } = props;
          return React.createElement(tag, { ...rest, ref });
        });
        Passthrough.displayName = `motion.${tag}`;
        cache.set(tag, Passthrough);
        return Passthrough;
      },
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
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
  talkToCaddie: vi.fn(),
  talkToCaddieStream: vi.fn(),
  BeforeFirstByteError: MockBeforeFirstByteError,
}));

// Synchronous stand-in — same rationale as CaddieSheet.session.test.tsx: the
// real hook coalesces via rAF/a timer fallback (exercised for real in
// stream-buffer.test.ts); driving THIS file's ladder through a real scheduler
// is an unnecessary race.
vi.mock("@/lib/caddie/stream-buffer", () => ({
  useStreamBuffer: (onFlush: (chunk: string) => void) => ({
    push: (delta: string) => onFlush(delta),
    flush: () => {},
    cancel: () => {},
  }),
}));

const hapticMock = vi.fn();
vi.mock("@/lib/haptics", () => ({ haptic: (...args: unknown[]) => hapticMock(...args) }));

vi.mock("@/hooks/useSheetTTS", () => ({
  useSheetTTS: () => ({
    unlock: vi.fn(),
    speak: vi.fn(),
    beginStream: vi.fn(),
    enqueue: vi.fn(),
    endStream: vi.fn(),
    stop: vi.fn(),
    isSpeaking: false,
  }),
}));

// A controllable fake dictation hook — real React state so the component's
// re-renders on listening/interim changes behave like the genuine hook,
// while start/stopAndResolve/cancel are fully test-driven.
const H = vi.hoisted(() => ({
  startFn: vi.fn(async () => {}),
  stopAndResolveFn: vi.fn(async (): Promise<string | null> => null),
  cancelFn: vi.fn(),
  lastOptions: null as { surface?: string; getKeyterms?: () => readonly string[] } | null,
}));
vi.mock("@/hooks/useLooperDictation", () => ({
  useLooperDictation: (opts: { surface?: string; getKeyterms?: () => readonly string[] }) => {
    H.lastOptions = opts;
    const [listening, setListening] = React.useState(false);
    return {
      listening,
      interim: "",
      micError: null,
      start: async () => {
        await H.startFn();
        setListening(true);
      },
      stopAndResolve: async () => {
        setListening(false);
        return H.stopAndResolveFn();
      },
      cancel: () => {
        H.cancelFn();
        setListening(false);
      },
    };
  },
}));

import CaddieOrbSheet from "./CaddieOrbSheet";
import { talkToCaddie, talkToCaddieStream } from "@/lib/caddie/api";
import { openLooper } from "@/lib/looper-bus";
import {
  registerCaddieContext,
  onCaddieOrbState,
  getCaddieContext,
  type CaddieTaskContext,
  type CaddieSurfaceContext,
  type TaskParse,
  type TaskAck,
} from "@/lib/caddie-context";

const talkToCaddieMock = vi.mocked(talkToCaddie);
const talkToCaddieStreamMock = vi.mocked(talkToCaddieStream);

/** Fires the mic tap by clicking the shell's mic button, resolving through
 *  the given transcript via the controllable dictation mock. */
async function speak(transcript: string) {
  H.stopAndResolveFn.mockResolvedValueOnce(transcript);
  fireEvent.click(screen.getByLabelText("Start talking"));
  await waitFor(() => expect(screen.getByLabelText("Stop and send")).toBeTruthy());
  fireEvent.click(screen.getByLabelText("Stop and send"));
}

function taskParse(overrides: Partial<TaskParse> = {}): TaskParse {
  return {
    transcript: "hello",
    hasSignal: true,
    confidence: 0.9,
    ack: "an ack",
    payload: { some: "payload" },
    ...overrides,
  };
}

let cleanupCtx: (() => void) | null = null;

function registerTask(overrides: Partial<CaddieTaskContext> = {}): CaddieTaskContext {
  const ctx: CaddieTaskContext = {
    id: "tee-time",
    kind: "task",
    copy: {
      title: "Where are we playing?",
      hint: "Tell me when and where.",
      nudge: "Want me to set that tee-time search up?",
    },
    parse: vi.fn(async () => taskParse()),
    apply: vi.fn((): TaskAck => ({ line: "Got it.", dispatched: false })),
    ...overrides,
  };
  cleanupCtx = registerCaddieContext(ctx);
  return ctx;
}

function registerSurface(overrides: Partial<CaddieSurfaceContext> = {}): CaddieSurfaceContext {
  const ctx: CaddieSurfaceContext = {
    id: "courses",
    kind: "surface",
    summon: vi.fn(),
    ...overrides,
  };
  cleanupCtx = registerCaddieContext(ctx);
  return ctx;
}

beforeEach(() => {
  vi.clearAllMocks();
  H.stopAndResolveFn.mockResolvedValue(null);
});

afterEach(() => {
  cleanupCtx?.();
  cleanupCtx = null;
  cleanup();
});

describe("CaddieOrbSheet — gate (b): low confidence blocks dispatch", () => {
  it("renders the confirm line, never calls apply, fires a warning haptic, no confirming orb state", async () => {
    const ctx = registerTask({
      parse: vi.fn(async () => taskParse({ hasSignal: true, confidence: 0.5, ack: "Saturday-ish" })),
    });
    const orbStates: string[] = [];
    onCaddieOrbState((s) => orbStates.push(s));

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "tee-time", listening: false }));
    await speak("saturday-ish ok");

    expect(
      await screen.findByText("Here's what I got — Saturday-ish. Say it again to correct, or edit below."),
    ).toBeTruthy();
    expect(ctx.apply).not.toHaveBeenCalled();
    expect(hapticMock).toHaveBeenCalledWith("warning");
    expect(hapticMock).not.toHaveBeenCalledWith("success");
    expect(orbStates).not.toContain("confirming");
  });
});

describe("CaddieOrbSheet — gate (a): no-signal falls through to converse", () => {
  it("routes to talkToCaddieStream, never calls apply, reply ends with the nudge, history excludes the in-flight utterance", async () => {
    const ctx = registerTask({
      parse: vi.fn(async () => taskParse({ hasSignal: false, confidence: 0.2 })),
    });
    talkToCaddieStreamMock.mockImplementationOnce(async (_params, opts) => {
      opts.onToken("A warmup answer.");
      return "A warmup answer.";
    });

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "tee-time", listening: false }));
    await speak("what's a good warmup?");

    await waitFor(() => expect(talkToCaddieStreamMock).toHaveBeenCalledTimes(1));
    const [params] = talkToCaddieStreamMock.mock.calls[0];
    expect(params.hole_number).toBeNull();
    expect(params.transcript).toBe("what's a good warmup?");
    expect(params.conversation_history).toEqual([]); // no prior turns — excludes THIS utterance

    expect(
      await screen.findByText(
        (_content, el) =>
          el?.children.length === 0 &&
          !!el?.textContent?.includes("A warmup answer.") &&
          !!el?.textContent?.includes("Want me to set that tee-time search up?"),
      ),
    ).toBeTruthy();
    expect(ctx.apply).not.toHaveBeenCalled();
  });
});

describe("CaddieOrbSheet — gate (c): high confidence applies and beats", () => {
  it("calls apply once with the exact TaskParse; dispatched:true fires success haptic + confirming orb state", async () => {
    const parse = taskParse({ hasSignal: true, confidence: 0.9 });
    const applySpy = vi.fn((): TaskAck => ({ line: "Saturday morning — on it.", dispatched: true }));
    registerTask({ parse: vi.fn(async () => parse), apply: applySpy });
    const orbStates: string[] = [];
    onCaddieOrbState((s) => orbStates.push(s));

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "tee-time", listening: false }));
    await speak("saturday morning");

    await waitFor(() => expect(applySpy).toHaveBeenCalledTimes(1));
    expect(applySpy).toHaveBeenCalledWith(parse);
    expect(await screen.findByText("Saturday morning — on it.")).toBeTruthy();
    expect(hapticMock).toHaveBeenCalledWith("success");
    await waitFor(() => expect(orbStates).toContain("confirming"));
  });

  it("dispatched:false plays neither the success haptic nor the confirming beat", async () => {
    const parse = taskParse({ hasSignal: true, confidence: 0.9 });
    const applySpy = vi.fn((): TaskAck => ({ line: "Got it.", dispatched: false }));
    registerTask({ parse: vi.fn(async () => parse), apply: applySpy });
    const orbStates: string[] = [];
    onCaddieOrbState((s) => orbStates.push(s));

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "tee-time", listening: false }));
    await speak("just some prefs");

    expect(await screen.findByText("Got it.")).toBeTruthy();
    expect(hapticMock).not.toHaveBeenCalledWith("success");
    expect(orbStates).not.toContain("confirming");
  });
});

describe("CaddieOrbSheet — general lane parity", () => {
  it("no registration + summon general: default title, mic routes through the stream ladder", async () => {
    talkToCaddieStreamMock.mockImplementationOnce(async (_params, opts) => {
      opts.onToken("Sure thing.");
      return "Sure thing.";
    });

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: false }));

    expect(await screen.findByText("What can I do for you?")).toBeTruthy();
    await speak("what's my handicap trend");

    await waitFor(() => expect(talkToCaddieStreamMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Sure thing.")).toBeTruthy();
  });

  it("BeforeFirstByteError falls back to talkToCaddie", async () => {
    talkToCaddieStreamMock.mockImplementationOnce(async () => {
      throw new MockBeforeFirstByteError();
    });
    talkToCaddieMock.mockResolvedValueOnce({ response: "Fallback answer." });

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: false }));
    await speak("tell me a fact");

    await waitFor(() => expect(talkToCaddieMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Fallback answer.")).toBeTruthy();
  });
});

describe("CaddieOrbSheet — surface lane", () => {
  it("summons the surface context directly; no sheet opens", async () => {
    const surface = registerSurface();
    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "courses", listening: true }));

    await waitFor(() => expect(surface.summon).toHaveBeenCalledWith(true));
    expect(screen.queryByLabelText("Close Looper")).toBeNull();
  });
});

describe("CaddieOrbSheet — legacy courses floor", () => {
  it("no registration + summon courses: host renders nothing (the courses page owns its own listener)", async () => {
    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "courses", listening: false }));
    // Give any (incorrect) async open a tick to happen, then assert it didn't.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByLabelText("Close Looper")).toBeNull();
  });
});

describe("CaddieOrbSheet — unregister-while-open", () => {
  it("closes the task lane cleanly: dictation.cancel called, sheet closes", async () => {
    registerTask();
    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "tee-time", listening: false }));
    expect(await screen.findByLabelText("Close Looper")).toBeTruthy();

    act(() => cleanupCtx?.());
    cleanupCtx = null;

    await waitFor(() => expect(screen.queryByLabelText("Close Looper")).toBeNull());
    expect(H.cancelFn).toHaveBeenCalled();
  });
});

describe("CaddieOrbSheet — reset-on-open only on closed→open", () => {
  it("turns survive a re-summon while the sheet is already open", async () => {
    talkToCaddieStreamMock.mockImplementation(async (_params, opts) => {
      opts.onToken("An answer.");
      return "An answer.";
    });

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: false }));
    await speak("first question");
    await waitFor(() => expect(talkToCaddieStreamMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("first question")).toBeTruthy();

    // Re-summon while still open — must NOT clear the existing turn.
    act(() => openLooper({ context: "general", listening: false }));
    expect(screen.queryByText("first question")).toBeTruthy();
  });
});

describe("CaddieOrbSheet — no cross-page leakage guard", () => {
  it("getCaddieContext reflects the exclusive registry the host reads", () => {
    expect(getCaddieContext()).toBeNull();
    registerTask();
    expect(getCaddieContext()?.id).toBe("tee-time");
  });
});
