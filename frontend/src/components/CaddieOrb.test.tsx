// @vitest-environment jsdom
// The omnipresent CaddieOrb — tap-to-talk inversion
// (specs/caddie-orb-tap-to-talk-inversion-plan.md §3/§5a). Owner directive,
// v1.1.10 field test: TAP now starts talking immediately (docked, no sheet);
// HOLD opens the full chat sheet. Pointer mechanics (drift-cancel, hold
// timer, onContextMenu) are migrated verbatim from the pre-inversion
// convention this file used to pin — only the ACTIONS the two gestures fire
// are swapped.

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/tee-time" }));
vi.mock("@/lib/haptics", () => ({ haptic: vi.fn() }));

const { useReducedMotionMock } = vi.hoisted(() => ({
  useReducedMotionMock: vi.fn(() => false),
}));

// motion.button's `animate` prop drives the confirming/listening pulses (§3c)
// — forward it as an inspectable data attribute so the test can assert on
// the actual keyframes the component computed, without depending on
// framer-motion's real animation runtime (jsdom has no rAF).
vi.mock("framer-motion", () => {
  const passthroughTags = new Set(["div", "button"]);
  // Memoized per tag — the Proxy's `get` trap fires on EVERY JSX access
  // (`<motion.button>` re-reads `motion.button` every render); creating a
  // fresh component function there would give React a new component
  // IDENTITY each render, forcing an unmount+remount instead of an update
  // (stale DOM node references in tests, state never visibly flushed).
  const cache = new Map<string, React.ForwardRefExoticComponent<Record<string, unknown>>>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        if (!passthroughTags.has(tag)) return undefined;
        const cached = cache.get(tag);
        if (cached) return cached;
        const Passthrough = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
          const { initial: _initial, animate, transition, ...rest } = props;
          return React.createElement(tag, {
            ...rest,
            ref,
            "data-animate": JSON.stringify(animate),
            "data-transition": JSON.stringify(transition),
          });
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
    useReducedMotion: () => useReducedMotionMock(),
  };
});

import CaddieOrb from "./CaddieOrb";
import { onLooperOpen, onLooperDockedGesture, type LooperOpenDetail, type LooperDockedGesture } from "@/lib/looper-bus";
import { setCaddieOrbState, setCaddieOrbCaption } from "@/lib/caddie-context";
import { registerFullscreenOverlay } from "@/lib/fullscreen-overlay";

const IDLE_LABEL = "Talk to your caddie — tap to talk, hold to open chat";
const LISTENING_LABEL = "Caddie listening — tap to send, hold to cancel";
const CONNECTING_LABEL = "Caddie connecting — hold to cancel";

// jsdom in this repo doesn't ship window.localStorage — stub a minimal
// in-memory implementation so the one-time-intro guards in CaddieOrb (which
// touch localStorage in a useEffect) have something to read/write.
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

describe("CaddieOrb", () => {
  let received: LooperOpenDetail[];
  let gestures: LooperDockedGesture[];
  let off: () => void;
  let offGesture: () => void;
  // Suppression tests mint a fullscreen-overlay token; if a test forgets to
  // unregister it (or fails before reaching its own cleanup), this catches
  // the leak so module state never bleeds into the next test.
  let pendingUnreg: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    useReducedMotionMock.mockReturnValue(false);
    received = [];
    gestures = [];
    off = onLooperOpen((d) => received.push(d));
    offGesture = onLooperDockedGesture((g) => gestures.push(g));
    vi.stubGlobal("localStorage", makeLocalStorage());
  });
  afterEach(() => {
    off();
    offGesture();
    if (pendingUnreg) {
      pendingUnreg();
      pendingUnreg = null;
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
    cleanup();
    // caddie-context is module-level singleton state — reset it so a test
    // that left the orb "listening"/captioned never bleeds into the next
    // test's initial render (getCaddieOrbState()/getCaddieOrbCaption() seed
    // useState on mount).
    setCaddieOrbState("idle");
    setCaddieOrbCaption(null);
  });

  it("renders on a SHOW route with the idle aria-label", () => {
    render(<CaddieOrb />);
    expect(screen.getByLabelText(IDLE_LABEL)).toBeTruthy();
  });

  it("tap starts talking immediately: docked + listening, no sheet", () => {
    render(<CaddieOrb />);
    const orb = screen.getByLabelText(IDLE_LABEL);
    fireEvent.pointerDown(orb, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(orb);
    expect(received).toEqual([{ context: "tee-time", listening: true, presentation: "docked" }]);
  });

  it("long-press opens the full chat sheet, not listening (and pointer-up after doesn't double-fire)", () => {
    render(<CaddieOrb />);
    const orb = screen.getByLabelText(IDLE_LABEL);
    fireEvent.pointerDown(orb, { clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(400);
    fireEvent.pointerUp(orb);
    expect(received).toEqual([{ context: "tee-time", listening: false, presentation: "full" }]);
  });

  it("finger drift cancels the press entirely", () => {
    render(<CaddieOrb />);
    const orb = screen.getByLabelText(IDLE_LABEL);
    // jsdom's synthetic pointer events drop clientX/Y — construct MouseEvents
    // (which carry coordinates) with pointer event types instead.
    fireEvent(orb, new MouseEvent("pointerdown", { clientX: 10, clientY: 10, bubbles: true }));
    fireEvent(orb, new MouseEvent("pointermove", { clientX: 10, clientY: 40, bubbles: true })); // scrolling
    vi.advanceTimersByTime(400);
    fireEvent(orb, new MouseEvent("pointerup", { bubbles: true }));
    expect(received).toEqual([]);
  });

  it("confirming orb state pulses the orb, then returns to rest on idle", () => {
    render(<CaddieOrb />);
    const orb = screen.getByLabelText(IDLE_LABEL);
    expect(JSON.parse(orb.getAttribute("data-animate")!)).toEqual({ scale: 1, opacity: 1 });

    act(() => setCaddieOrbState("confirming"));
    expect(JSON.parse(orb.getAttribute("data-animate")!)).toEqual({ scale: [1, 1.12, 1], opacity: 1 });
    expect(JSON.parse(orb.getAttribute("data-transition")!)).toEqual({ duration: 0.5, ease: "easeOut" });

    act(() => setCaddieOrbState("idle"));
    expect(JSON.parse(orb.getAttribute("data-animate")!)).toEqual({ scale: 1, opacity: 1 });
  });

  it("listening orb state pulses at the 2.6s cadence and swaps the aria-label", () => {
    render(<CaddieOrb />);
    act(() => setCaddieOrbState("listening"));
    const orb = screen.getByLabelText(LISTENING_LABEL);
    expect(JSON.parse(orb.getAttribute("data-animate")!)).toEqual({ scale: [1, 1.06, 1], opacity: 1 });
    // JSON.stringify (the mock's serialization for the inspectable data
    // attribute) turns Infinity into null — this pins the ACTUAL wire value,
    // not a rewritten expectation; `repeat: Infinity` is what the component
    // really passes (asserted structurally, not through this lossy channel).
    expect(JSON.parse(orb.getAttribute("data-transition")!)).toEqual({
      duration: 2.6,
      repeat: null,
      ease: "easeInOut",
    });
  });

  it("connecting never pulses (mic-privacy: no indicator before the mic is actually hot)", () => {
    render(<CaddieOrb />);
    act(() => setCaddieOrbState("connecting"));
    const orb = screen.getByLabelText(CONNECTING_LABEL);
    expect(JSON.parse(orb.getAttribute("data-animate")!)).toEqual({ scale: 1, opacity: 1 });
  });

  it("reduced motion + listening renders a static (non-animating) orb — no pulse keyframes", () => {
    useReducedMotionMock.mockReturnValue(true);
    render(<CaddieOrb />);
    act(() => setCaddieOrbState("listening"));
    const orb = screen.getByLabelText(LISTENING_LABEL);
    expect(JSON.parse(orb.getAttribute("data-animate")!)).toEqual({ scale: 1, opacity: 1 });
  });

  it("tapping while docked (listening) sends a 'send' gesture, not a new looper:open summon", () => {
    render(<CaddieOrb />);
    act(() => setCaddieOrbState("listening"));
    const orb = screen.getByLabelText(LISTENING_LABEL);
    fireEvent.pointerDown(orb, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(orb);
    expect(gestures).toEqual(["send"]);
    expect(received).toEqual([]);
  });

  it("holding while docked (listening) sends a 'cancel' gesture, not a looper:open summon", () => {
    render(<CaddieOrb />);
    act(() => setCaddieOrbState("listening"));
    const orb = screen.getByLabelText(LISTENING_LABEL);
    fireEvent.pointerDown(orb, { clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(400);
    fireEvent.pointerUp(orb);
    expect(gestures).toEqual(["cancel"]);
    expect(received).toEqual([]);
  });

  it("a mid-press connecting→listening flip doesn't change what a HOLD already in flight does", () => {
    // pressStateRef is captured at pointerdown — orbState changing under an
    // in-flight press must not retroactively change the gesture it fires.
    render(<CaddieOrb />);
    act(() => setCaddieOrbState("connecting"));
    const orb = screen.getByLabelText(CONNECTING_LABEL);
    fireEvent.pointerDown(orb, { clientX: 10, clientY: 10 });
    act(() => setCaddieOrbState("listening")); // flips mid-press
    vi.advanceTimersByTime(400);
    fireEvent.pointerUp(screen.getByLabelText(LISTENING_LABEL));
    // Still reads as "docked" either way (connecting AND listening both are)
    // — the cancel gesture fires, never a stale idle-hold looper:open.
    expect(gestures).toEqual(["cancel"]);
    expect(received).toEqual([]);
  });

  it("shows the docked caption the host publishes", () => {
    render(<CaddieOrb />);
    act(() => {
      setCaddieOrbState("listening");
      setCaddieOrbCaption("Hearing…");
    });
    expect(screen.getByText("Hearing…")).toBeTruthy();
  });

  it("hidden-while-docked: a full-screen overlay opening during a docked session sends a cancel gesture", () => {
    render(<CaddieOrb />);
    act(() => setCaddieOrbState("listening"));

    let unreg!: () => void;
    act(() => {
      unreg = registerFullscreenOverlay();
    });
    pendingUnreg = unreg;
    expect(gestures).toEqual(["cancel"]);

    act(() => unreg());
    pendingUnreg = null;
  });

  it("suppresses (renders null) while a full-screen overlay is registered, and returns when it unregisters", () => {
    render(<CaddieOrb />);
    expect(screen.getByLabelText(IDLE_LABEL)).toBeTruthy();

    let unreg!: () => void;
    act(() => {
      unreg = registerFullscreenOverlay();
    });
    expect(screen.queryByLabelText(IDLE_LABEL)).toBeNull();

    act(() => unreg());
    expect(screen.getByLabelText(IDLE_LABEL)).toBeTruthy();
  });

  it("an overlay registered before mount defers (not burns) the one-time intro flag", () => {
    let unreg!: () => void;
    act(() => {
      unreg = registerFullscreenOverlay();
    });
    pendingUnreg = unreg; // safety net if an assertion below throws

    render(<CaddieOrb />);
    // Suppressed: absent from the DOM, and the intro effect never ran.
    expect(screen.queryByLabelText(IDLE_LABEL)).toBeNull();
    expect(window.localStorage.getItem("looper.caddieOrbIntroSeen")).toBeNull();

    act(() => unreg());
    pendingUnreg = null;
    expect(screen.getByLabelText(IDLE_LABEL)).toBeTruthy();

    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByText("Your caddie moved here")).toBeTruthy();
    expect(window.localStorage.getItem("looper.caddieOrbIntroSeen")).toBe("1");
  });

  it("the inverted-gesture re-teach chip fires ONCE, sequenced after the moved-here intro, then never again", () => {
    render(<CaddieOrb />);

    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByText("Your caddie moved here")).toBeTruthy();
    expect(screen.queryByText("Tap to talk - hold to open chat")).toBeNull();

    act(() => vi.advanceTimersByTime(3200)); // moved-here hides at t=3200
    expect(screen.queryByText("Your caddie moved here")).toBeNull();
    expect(screen.queryByText("Tap to talk - hold to open chat")).toBeNull(); // not yet — shows at t=3400

    act(() => vi.advanceTimersByTime(200)); // t=3400
    expect(screen.getByText("Tap to talk - hold to open chat")).toBeTruthy();
    expect(window.localStorage.getItem("looper.tapHoldInvertedSeen")).toBe("1");

    act(() => vi.advanceTimersByTime(3200)); // hides at t=6600
    expect(screen.queryByText("Tap to talk - hold to open chat")).toBeNull();
  });
});
