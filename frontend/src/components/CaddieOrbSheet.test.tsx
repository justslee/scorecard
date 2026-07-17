// @vitest-environment jsdom
//
// CaddieOrbSheet — the generic caddie-orb sheet host
// (specs/orb-s2-context-contract-teetime-plan.md §9). Drives the real
// component with the bus (`openLooper`) and registry (`registerCaddieContext`)
// used for real; only the network/mic/haptics/TTS edges are mocked.

import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

// jsdom in this repo doesn't ship window.localStorage (same gap as
// CaddieOrb.test.tsx) — stub a minimal in-memory implementation so
// persona.ts's readLocalPersonaId/writeLocalPersonaId (touched once
// CaddieOrbSheet consumes useCaddiePersona) has something to read/write.
function makeLocalStorage() {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      Object.keys(store).forEach((k) => delete store[k]);
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (n: number) => Object.keys(store)[n] ?? null,
  };
}

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
  // persona.ts (pulled in transitively once CaddieOrbSheet consumes
  // useCaddiePersona) imports these three from this SAME mocked module —
  // without them the import chain breaks at test-import time. Defaults are
  // failure-tolerant (empty list / no server preference) so persona
  // resolution falls through to localStorage / "classic" exactly like a
  // fresh, logged-out device; individual tests override per-case.
  fetchPersonalities: vi.fn(async () => []),
  getCaddieProfile: vi.fn(async () => ({ preferred_personality_id: null })),
  updateCaddieProfile: vi.fn(async () => ({})),
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

// Hoisted so tests can assert what the sheet spoke (was an inline throwaway
// `vi.fn()` — a fresh one per render, un-assertable across the module).
const { speakMock } = vi.hoisted(() => ({ speakMock: vi.fn() }));
vi.mock("@/hooks/useSheetTTS", () => ({
  useSheetTTS: () => ({
    unlock: vi.fn(),
    speak: speakMock,
    beginStream: vi.fn(),
    enqueue: vi.fn(),
    endStream: vi.fn(),
    stop: vi.fn(),
    isSpeaking: false,
  }),
}));

// CaddieOrbSheet now reads usePathname() (route-change hygiene, §2i) — a
// controllable mock so the route-change test can simulate navigation without
// a real app router context.
const { pathnameMock } = vi.hoisted(() => ({ pathnameMock: vi.fn(() => "/tee-time") }));
vi.mock("next/navigation", () => ({ usePathname: () => pathnameMock() }));

// A controllable fake dictation hook — real React state so the component's
// re-renders on listening/interim changes behave like the genuine hook,
// while start/stopAndResolve/cancel are fully test-driven. `micError` and an
// externally-triggerable "unexpected drop" (dropListening) are additive for
// the tap-to-talk-inversion promotion tests (§2e triggers b/c) — every
// pre-existing test that never touches them is unaffected (both default
// inert: micError starts null, dropListening is simply never called).
const H = vi.hoisted(() => {
  const micErrorListeners = new Set<(e: string | null) => void>();
  let listeningSetter: ((v: boolean) => void) | null = null;
  return {
    startFn: vi.fn(async () => {}),
    stopAndResolveFn: vi.fn(async (): Promise<string | null> => null),
    cancelFn: vi.fn(),
    lastOptions: null as { surface?: string; getKeyterms?: () => readonly string[] } | null,
    micErrorListeners,
    triggerMicError: (e: string | null) => {
      for (const cb of micErrorListeners) cb(e);
    },
    setListeningSetter: (fn: ((v: boolean) => void) | null) => {
      listeningSetter = fn;
    },
    /** Simulates the mic dying underneath the session WITHOUT going through
     *  stopAndResolve/cancel — the "unexpected listening drop" promotion
     *  trigger (c) is specifically about telling THIS apart from an
     *  intentional stop. */
    dropListening: () => listeningSetter?.(false),
  };
});
vi.mock("@/hooks/useLooperDictation", () => ({
  useLooperDictation: (opts: { surface?: string; getKeyterms?: () => readonly string[] }) => {
    H.lastOptions = opts;
    const [listening, setListening] = React.useState(false);
    const [micError, setMicError] = React.useState<string | null>(null);
    React.useEffect(() => {
      H.micErrorListeners.add(setMicError);
      H.setListeningSetter(setListening);
      return () => {
        H.micErrorListeners.delete(setMicError);
        H.setListeningSetter(null);
      };
    }, []);
    return {
      listening,
      interim: "",
      micError,
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
import { talkToCaddie, talkToCaddieStream, getCaddieProfile } from "@/lib/caddie/api";
import { openLooper, looperContextForPath, sendLooperDockedGesture } from "@/lib/looper-bus";
import {
  registerCaddieContext,
  onCaddieOrbState,
  getCaddieOrbState,
  setCaddieOrbState,
  getCaddieOrbCaption,
  setCaddieOrbCaption,
  getCaddieContext,
  type CaddieTaskContext,
  type CaddieSurfaceContext,
  type CaddieConverseContext,
  type TaskParse,
  type TaskAck,
} from "@/lib/caddie-context";

const talkToCaddieMock = vi.mocked(talkToCaddie);
const talkToCaddieStreamMock = vi.mocked(talkToCaddieStream);
const getCaddieProfileMock = vi.mocked(getCaddieProfile);

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

function registerConverse(overrides: Partial<CaddieConverseContext> = {}): CaddieConverseContext {
  const ctx: CaddieConverseContext = {
    id: "my-card",
    kind: "converse",
    copy: {
      title: "Your card",
      hint: "Ask about your game — what to work on, trends, your clubs.",
    },
    getGrounding: vi.fn(() => null),
    ...overrides,
  };
  cleanupCtx = registerCaddieContext(ctx);
  return ctx;
}

beforeEach(() => {
  vi.clearAllMocks();
  H.stopAndResolveFn.mockResolvedValue(null);
  vi.stubGlobal("localStorage", makeLocalStorage());
});

afterEach(() => {
  cleanupCtx?.();
  cleanupCtx = null;
  vi.unstubAllGlobals();
  cleanup();
  pathnameMock.mockReturnValue("/tee-time");
  // caddie-context orb state/caption are module-level singletons — reset so
  // a docked-presentation test never bleeds into the next test's mount.
  setCaddieOrbState("idle");
  setCaddieOrbCaption(null);
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

    // Regression guard (designer BLOCK, orb-s2): the sheet must greet with the
    // TASK's own copy on the very first summon render — not the generic
    // converse title. Reads `boundId` state, not the one-render-late ref.
    expect(await screen.findByText("Where are we playing?")).toBeTruthy();

    await speak("saturday-ish ok");

    expect(
      await screen.findByText("Here's what I got — Saturday-ish. Say it again to correct, or fix it in the form."),
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

  it("registered converse (my-card) greets with its OWN title + hint, not the generic copy", async () => {
    // Regression guard (designer BLOCK, orb-s4): a kind:"converse" context
    // (e.g. /profile's "my-card") must render its registered copy in the sheet.
    // Before the fix the sheet only read copy off task contexts, so the golfer
    // saw the generic "What can I do for you?" on his own stats page.
    registerConverse();

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: false }));

    expect(await screen.findByText("Your card")).toBeTruthy();
    expect(
      await screen.findByText("Ask about your game — what to work on, trends, your clubs."),
    ).toBeTruthy();
  });

  it("converse (my-card): threads getGrounding() into the request as stats_context", async () => {
    // Regression guard (cycle 84 orb-wiring audit): the my-card converse
    // context's whole value is grounding the caddie in the golfer's REAL
    // stats. The host must pass getGrounding()'s output through to the model as
    // `stats_context`. If this wire silently breaks, the caddie answers with no
    // numbers and no error — the exact silent-wrong-behavior sibling of the
    // My-Card COPY bug. Pin it end-to-end through the real converse lane.
    const grounding = "GROUNDING BLOCK — driver avg 262y (n=14), 3 rounds.";
    registerConverse({ getGrounding: vi.fn(() => grounding) });
    talkToCaddieStreamMock.mockImplementationOnce(async (_params, opts) => {
      opts.onToken("Work on your wedges.");
      return "Work on your wedges.";
    });

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: false }));
    await speak("what should I practice");

    await waitFor(() => expect(talkToCaddieStreamMock).toHaveBeenCalledTimes(1));
    const [params] = talkToCaddieStreamMock.mock.calls[0];
    expect(params.stats_context).toBe(grounding);
  });

  it("general lane (no converse ctx): sends NO stats_context (honest — no stats to cite)", async () => {
    // The converse of the guard above: with no registered converse context the
    // host must NOT invent a grounding block — general Q&A stays ungrounded.
    talkToCaddieStreamMock.mockImplementationOnce(async (_params, opts) => {
      opts.onToken("Sure.");
      return "Sure.";
    });

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: false }));
    await speak("tell me a golf fact");

    await waitFor(() => expect(talkToCaddieStreamMock).toHaveBeenCalledTimes(1));
    const [params] = talkToCaddieStreamMock.mock.calls[0];
    expect(params.stats_context).toBeUndefined();
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

  it("course-detail summon (real looperContextForPath) opens the general sheet — not swallowed by the legacy courses floor", async () => {
    render(<CaddieOrbSheet />);
    const ctx = looperContextForPath("/courses/pebble-beach"); // resolves to "general"
    act(() => openLooper({ context: ctx, listening: false }));
    expect(await screen.findByLabelText("Close Looper")).toBeTruthy();
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

describe("CaddieOrbSheet — A3: expectReply mic-reopen (fake timers)", () => {
  // Dedicated beforeEach/afterEach scoped to THIS describe only — fake timers
  // must never leak into the other describes in this shared file
  // (tasks/lessons.md 2026-07-07, the CaddieSheet.session.test.tsx incident).

  /** Drains pending microtasks (async continuations past a mocked `await`)
   *  without ever touching a real timer — safe under `vi.useFakeTimers()`. */
  async function flush(times = 8) {
    for (let i = 0; i < times; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  /** A fake-timer-safe stand-in for the shared `speak()` helper (which uses
   *  `waitFor`'s real-timer polling — unsafe once fake timers are active). */
  async function speakFake(transcript: string) {
    H.stopAndResolveFn.mockResolvedValueOnce(transcript);
    fireEvent.click(screen.getByLabelText("Start talking"));
    await flush();
    fireEvent.click(screen.getByLabelText("Stop and send"));
    await flush();
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("expectReply:true && dispatched:false → dictation.start() fires again ~900ms later while the sheet stays open", async () => {
    const applySpy = vi.fn((): TaskAck => ({ line: "Which one?", dispatched: false, expectReply: true }));
    registerTask({ apply: applySpy });

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "tee-time", listening: false }));
    await flush();

    await speakFake("the brooklyn one");
    await flush();
    expect(screen.getByText("Which one?")).toBeTruthy();

    const startsBefore = H.startFn.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    await flush();

    expect(H.startFn.mock.calls.length).toBe(startsBefore + 1);
  });

  it("sheet closed BEFORE the 900ms beat → no restart (gen/open guard makes the race inert)", async () => {
    const applySpy = vi.fn((): TaskAck => ({ line: "Which one?", dispatched: false, expectReply: true }));
    registerTask({ apply: applySpy });

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "tee-time", listening: false }));
    await flush();

    await speakFake("the brooklyn one");
    await flush();

    const startsBefore = H.startFn.mock.calls.length;
    act(() => {
      fireEvent.click(screen.getByLabelText("Close Looper"));
    });
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    await flush();

    expect(H.startFn.mock.calls.length).toBe(startsBefore);
  });

  it("context unregistered BEFORE the 900ms beat (host's unmount hygiene closes the sheet) → no restart", async () => {
    const applySpy = vi.fn((): TaskAck => ({ line: "Which one?", dispatched: false, expectReply: true }));
    registerTask({ apply: applySpy });

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "tee-time", listening: false }));
    await flush();

    await speakFake("the brooklyn one");
    await flush();

    const startsBefore = H.startFn.mock.calls.length;
    act(() => cleanupCtx?.());
    cleanupCtx = null;
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    await flush();

    expect(H.startFn.mock.calls.length).toBe(startsBefore);
  });

  it("expectReply absent (undefined) → byte-identical to today: no reopen after the same 900ms window", async () => {
    const applySpy = vi.fn((): TaskAck => ({ line: "Got it.", dispatched: false }));
    registerTask({ apply: applySpy });

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "tee-time", listening: false }));
    await flush();

    await speakFake("just some prefs");
    await flush();

    const startsBefore = H.startFn.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    await flush();

    expect(H.startFn.mock.calls.length).toBe(startsBefore);
  });
});

describe("CaddieOrbSheet — persona threading", () => {
  // Owner crux: ONE coherent caddie presence (voice + name + greeting) across
  // every surface — the orb must never silently discard the golfer's chosen
  // persona (specs/caddie-orb-persona-consistency-plan.md §1.7).
  //
  // "scorecard_anon_caddie_persona" is the namespaced localStorage key
  // (multiuser-p0-client-identity, specs/multi-user-epic-plan.md §3.5) —
  // no signed-in user in this test env (window.Clerk unset, no persisted
  // scorecard_last_user_id) resolves to the "anon" namespace.

  it("selected persona reaches the streaming converse call", async () => {
    window.localStorage.setItem("scorecard_anon_caddie_persona", "hype");
    talkToCaddieStreamMock.mockImplementationOnce(async (_params, opts) => {
      opts.onToken("Let's go.");
      return "Let's go.";
    });

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: false }));
    await speak("what's a good warmup?");

    await waitFor(() => expect(talkToCaddieStreamMock).toHaveBeenCalledTimes(1));
    const [params] = talkToCaddieStreamMock.mock.calls[0];
    expect(params).toEqual(expect.objectContaining({ personality_id: "hype" }));
  });

  it("selected persona reaches the JSON fallback", async () => {
    window.localStorage.setItem("scorecard_anon_caddie_persona", "hype");
    talkToCaddieStreamMock.mockImplementationOnce(async () => {
      throw new MockBeforeFirstByteError();
    });
    talkToCaddieMock.mockResolvedValueOnce({ response: "Fallback answer." });

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: false }));
    await speak("tell me a fact");

    await waitFor(() => expect(talkToCaddieMock).toHaveBeenCalledTimes(1));
    const [params] = talkToCaddieMock.mock.calls[0];
    expect(params).toEqual(expect.objectContaining({ personality_id: "hype" }));
  });

  it("TTS speaks in the selected persona's voice", async () => {
    window.localStorage.setItem("scorecard_anon_caddie_persona", "hype");
    talkToCaddieStreamMock.mockImplementationOnce(async (_params, opts) => {
      opts.onToken("Let's go.");
      return "Let's go.";
    });

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: false }));
    await speak("what's a good warmup?");

    await waitFor(() => expect(screen.getByText("Let's go.")).toBeTruthy());
    await waitFor(() => expect(speakMock).toHaveBeenCalledWith("Let's go.", "hype"));
  });

  it("fallback floor: no localStorage + no server preference sends classic (regression pin)", async () => {
    getCaddieProfileMock.mockResolvedValueOnce({
      handicap: null,
      preferred_personality_id: null,
      rounds_analyzed: 0,
    });
    talkToCaddieStreamMock.mockImplementationOnce(async (_params, opts) => {
      opts.onToken("Sure.");
      return "Sure.";
    });

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: false }));
    await speak("tell me a golf fact");

    await waitFor(() => expect(talkToCaddieStreamMock).toHaveBeenCalledTimes(1));
    const [params] = talkToCaddieStreamMock.mock.calls[0];
    expect(params).toEqual(expect.objectContaining({ personality_id: "classic" }));
  });

  it("server preference wins over localStorage (documented resolution order, end-to-end through the orb)", async () => {
    window.localStorage.setItem("scorecard_anon_caddie_persona", "hype");
    getCaddieProfileMock.mockResolvedValueOnce({
      handicap: null,
      preferred_personality_id: "professor",
      rounds_analyzed: 3,
    });
    talkToCaddieStreamMock.mockImplementationOnce(async (_params, opts) => {
      opts.onToken("Let's think this through.");
      return "Let's think this through.";
    });

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: false }));
    // Let the profile-resolution microtask (Promise.allSettled) settle before
    // sending — this is what "server wins" actually depends on.
    await waitFor(() => expect(getCaddieProfileMock).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await speak("what club should I hit?");

    await waitFor(() => expect(talkToCaddieStreamMock).toHaveBeenCalledTimes(1));
    const [params] = talkToCaddieStreamMock.mock.calls[0];
    expect(params).toEqual(expect.objectContaining({ personality_id: "professor" }));
  });
});

describe("CaddieOrbSheet — speakerLabel (cross-surface identity label)", () => {
  // Designer's authoritative lane→label semantics
  // (specs/caddie-cross-surface-identity-label-plan.md §"Designer's lane→label
  // semantics"): task lane is always "Looper" (the app doing a job); converse/
  // general lane with a non-classic persona attributes the reply caption to
  // the short persona name.

  it("general/converse lane + non-classic persona: reply caption shows the short persona name", async () => {
    window.localStorage.setItem("scorecard_anon_caddie_persona", "hype");
    talkToCaddieStreamMock.mockImplementationOnce(async (_params, opts) => {
      opts.onToken("Let's go get it.");
      return "Let's go get it.";
    });

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: false }));
    await speak("what's a good warmup?");

    expect(await screen.findByText("Let's go get it.")).toBeTruthy();
    expect(screen.getByText("Hype Man")).toBeTruthy();
  });

  it("task lane + non-classic persona: reply caption stays 'Looper'", async () => {
    window.localStorage.setItem("scorecard_anon_caddie_persona", "hype");
    const applySpy = vi.fn((): TaskAck => ({ line: "Saturday morning — on it.", dispatched: true }));
    registerTask({ parse: vi.fn(async () => taskParse({ hasSignal: true, confidence: 0.9 })), apply: applySpy });

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "tee-time", listening: false }));
    await speak("saturday morning");

    expect(await screen.findByText("Saturday morning — on it.")).toBeTruthy();
    // Both the kicker and this reply caption read "Looper" for the task lane.
    expect(screen.getAllByText("Looper").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("Hype Man")).toBeNull();
  });

  it("classic persona (explicit): reply caption stays 'Looper'", async () => {
    window.localStorage.setItem("scorecard_anon_caddie_persona", "classic");
    talkToCaddieStreamMock.mockImplementationOnce(async (_params, opts) => {
      opts.onToken("Sure thing.");
      return "Sure thing.";
    });

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: false }));
    await speak("what's my handicap trend");

    expect(await screen.findByText("Sure thing.")).toBeTruthy();
    expect(screen.getAllByText("Looper").length).toBeGreaterThanOrEqual(2);
  });

  it("unresolved/logged-out (no persona seeded): reply caption stays 'Looper'", async () => {
    talkToCaddieStreamMock.mockImplementationOnce(async (_params, opts) => {
      opts.onToken("Sure.");
      return "Sure.";
    });

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: false }));
    await speak("tell me a golf fact");

    expect(await screen.findByText("Sure.")).toBeTruthy();
    expect(screen.getAllByText("Looper").length).toBeGreaterThanOrEqual(2);
  });
});

describe("CaddieOrbSheet — converse no-re-greet invariant (specs/caddie-coherence-polish-plan.md §1)", () => {
  // The converse emptyHint renders only when turns.length === 0. Turns
  // persist across a RE-SUMMON while the sheet is already open (see the
  // "reset-on-open only on closed→open" describe above — pre-existing
  // coverage that pins the SESSION-continuity behavior); this test adds the
  // piece that block didn't check: the emptyHint specifically must never
  // reappear once turns.length > 0, mirroring the round page's already-
  // canonical no-re-greet contract (CaddieSheet.tsx:845).
  //
  // NOTE (verified against the actual code, not assumed): a full close() ->
  // reopen goes through `resetSession()` on the closed→open transition and
  // deliberately starts a FRESH conversation (turns cleared, hint legitimately
  // reappears) — that is pre-existing, intentional session-boundary behavior,
  // not a re-greet regression, and changing it would be a real session-
  // persistence behavior change out of scope for this copy-only nit.
  it("turns survive a re-summon while already open; the empty hint never reappears once turns.length > 0", async () => {
    talkToCaddieStreamMock.mockImplementationOnce(async (_params, opts) => {
      opts.onToken("An answer.");
      return "An answer.";
    });

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: false }));
    // Empty-hint visible pre-conversation.
    expect(screen.getByText("Tee times, courses, your game — ask me anything.")).toBeTruthy();

    await speak("first question");
    await waitFor(() => expect(talkToCaddieStreamMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("first question")).toBeTruthy();
    expect(await screen.findByText("An answer.")).toBeTruthy();
    // The hint is gone once a turn exists.
    expect(screen.queryByText("Tee times, courses, your game — ask me anything.")).toBeNull();

    // Re-summon while STILL open (not a close/reopen) — must not reset.
    act(() => openLooper({ context: "general", listening: false }));

    // The prior conversation survives — no re-greet.
    expect(screen.getByText("first question")).toBeTruthy();
    expect(screen.getByText("An answer.")).toBeTruthy();
    expect(screen.queryByText("Tee times, courses, your game — ask me anything.")).toBeNull();
  });
});

describe("CaddieOrbSheet — long custom persona name: hint name matches caption name (specs/caddie-coherence-polish-plan.md §1/§4)", () => {
  it("emptyHint's persona name is the SAME truncated form as the reply caption's speakerLabel", async () => {
    // > 16 chars so captionPersonaName's word-boundary truncation kicks in —
    // exercises the exact overflow case NIT 1 fixes (CaddieOrbSheet.tsx:401
    // used to interpolate the untruncated caddy.name, disagreeing with the
    // caption's captionPersonaName(caddy.name) at :389/:753-equivalent).
    getCaddieProfileMock.mockResolvedValueOnce({
      handicap: null,
      preferred_personality_id: null,
      rounds_analyzed: 0,
    });
    vi.mocked((await import("@/lib/caddie/api")).fetchPersonalities).mockResolvedValueOnce([
      {
        id: "custom-long",
        name: "Sunday Money Maker Supreme",
        description: "Custom",
        avatar: "🏌️",
        response_style: "conversational",
        traits: [],
      },
    ]);
    window.localStorage.setItem("scorecard_anon_caddie_persona", "custom-long");
    talkToCaddieStreamMock.mockImplementationOnce(async (_params, opts) => {
      opts.onToken("Let's go get it.");
      return "Let's go get it.";
    });

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: false }));

    // Let persona resolution (fetchPersonalities + profile, Promise.allSettled) settle.
    await waitFor(() => expect(getCaddieProfileMock).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const hint = await screen.findByText(/here — tee times, courses, your game\. Ask me anything\./);
    const hintName = hint.textContent?.split(" here —")[0];
    expect(hintName).toBe("Sunday Money…"); // captionPersonaName truncation, word-boundary + ellipsis
    expect(hintName!.length).toBeLessThanOrEqual(17);

    await speak("what's a good warmup?");
    expect(await screen.findByText("Let's go get it.")).toBeTruthy();
    // Same resolved name attributes the reply caption — never disagree.
    expect(screen.getByText(hintName!)).toBeTruthy();
  });
});

describe("CaddieOrbSheet — no cross-page leakage guard", () => {
  it("getCaddieContext reflects the exclusive registry the host reads", () => {
    expect(getCaddieContext()).toBeNull();
    registerTask();
    expect(getCaddieContext()?.id).toBe("tee-time");
  });
});

describe("CaddieOrbSheet — docked presentation (specs/caddie-orb-tap-to-talk-inversion-plan.md §2)", () => {
  it("docked open renders NO chrome, and traces connecting → listening via the orb-state publisher", async () => {
    const orbStates: string[] = [];
    onCaddieOrbState((s) => orbStates.push(s));

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: true, presentation: "docked" }));

    // No sheet chrome — the shell is gated `open && presentation === "full"`.
    expect(screen.queryByLabelText("Close Looper")).toBeNull();

    await waitFor(() => expect(H.startFn).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(orbStates).toContain("connecting"));
    await waitFor(() => expect(orbStates).toContain("listening"));
    expect(screen.queryByLabelText("Close Looper")).toBeNull(); // still no chrome
  });

  it("promotion (a): speaking while docked appends the turn and reveals the full sheet", async () => {
    talkToCaddieStreamMock.mockImplementationOnce(async (_params, opts) => {
      opts.onToken("Sure thing.");
      return "Sure thing.";
    });

    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: true, presentation: "docked" }));
    await waitFor(() => expect(H.startFn).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText("Close Looper")).toBeNull();

    H.stopAndResolveFn.mockResolvedValueOnce("what's a good warmup?");
    act(() => sendLooperDockedGesture("send"));

    await waitFor(() => expect(screen.getByLabelText("Close Looper")).toBeTruthy());
    expect(await screen.findByText("what's a good warmup?")).toBeTruthy();
    expect(await screen.findByText("Sure thing.")).toBeTruthy();
  });

  it("promotion (b): a real mic/connect error while docked promotes to the full sheet", async () => {
    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: true, presentation: "docked" }));
    await waitFor(() => expect(H.startFn).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText("Close Looper")).toBeNull();

    act(() => H.triggerMicError("Couldn't start the microphone."));

    await waitFor(() => expect(screen.getByLabelText("Close Looper")).toBeTruthy());
  });

  it("promotion (c): an unexpected listening drop (not send/cancel) while docked promotes to the full sheet", async () => {
    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: true, presentation: "docked" }));
    await waitFor(() => expect(H.startFn).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText("Close Looper")).toBeNull();

    act(() => H.dropListening());

    await waitFor(() => expect(screen.getByLabelText("Close Looper")).toBeTruthy());
  });

  it("docked cancel gesture closes cleanly: dictation.cancel called, no chrome, orb resets to idle", async () => {
    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: true, presentation: "docked" }));
    await waitFor(() => expect(H.startFn).toHaveBeenCalledTimes(1));

    act(() => sendLooperDockedGesture("cancel"));

    expect(H.cancelFn).toHaveBeenCalled();
    expect(screen.queryByLabelText("Close Looper")).toBeNull();
    await waitFor(() => expect(getCaddieOrbState()).toBe("idle"));
  });

  it("back-compat: a summon with no presentation field behaves exactly like presentation:'full' (today's default)", async () => {
    render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: false }));
    expect(await screen.findByLabelText("Close Looper")).toBeTruthy();
  });

  describe("no-speech self-heal (fake timers)", () => {
    // Dedicated fake timers, scoped to this describe only (tasks/lessons.md
    // 2026-07-07 — never let fake timers leak into other describes).
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    });

    /** Drains pending microtasks without touching a real timer. */
    async function flush(times = 8) {
      for (let i = 0; i < times; i++) {
        await act(async () => {
          await Promise.resolve();
        });
      }
    }

    it("bare silence while docked collapses to idle after 2500ms — no promotion, no chrome", async () => {
      render(<CaddieOrbSheet />);
      act(() => openLooper({ context: "general", listening: true, presentation: "docked" }));
      await act(async () => {
        vi.advanceTimersByTime(60); // the summon's own start() delay
      });
      await flush();
      expect(H.startFn).toHaveBeenCalledTimes(1);

      H.stopAndResolveFn.mockResolvedValueOnce(null); // nothing heard
      act(() => sendLooperDockedGesture("send"));
      await flush();

      expect(getCaddieOrbCaption()).toBe("Didn't catch that");
      expect(screen.queryByLabelText("Close Looper")).toBeNull(); // no promotion for silence

      await act(async () => {
        vi.advanceTimersByTime(2500);
      });
      await flush();

      expect(getCaddieOrbState()).toBe("idle");
      expect(getCaddieOrbCaption()).toBeNull();
      expect(screen.queryByLabelText("Close Looper")).toBeNull();
    });
  });
});

describe("CaddieOrbSheet — route-change hygiene (docked is page-scoped, §2i)", () => {
  it("navigating away while docked cancels the mic and resets to idle; full-sheet sessions are untouched by this path", async () => {
    const { rerender } = render(<CaddieOrbSheet />);
    act(() => openLooper({ context: "general", listening: true, presentation: "docked" }));
    await waitFor(() => expect(H.startFn).toHaveBeenCalledTimes(1));

    pathnameMock.mockReturnValue("/somewhere-else");
    rerender(<CaddieOrbSheet />);

    expect(H.cancelFn).toHaveBeenCalled();
    expect(screen.queryByLabelText("Close Looper")).toBeNull();
    await waitFor(() => expect(getCaddieOrbState()).toBe("idle"));
  });
});
