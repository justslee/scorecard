// @vitest-environment jsdom
//
// CaddieSheet — live mode reliability, GLITCH-DURING-ANSWER classes
// (specs/caddie-experience-harness-plan.md §4, dim 6 "reliability" /
// dim 1 "no dupes"). Existing Slice D/E coverage (CaddieSheet.realtime.test.tsx)
// fires reconnect/hole-change events strictly BETWEEN turns — nothing there
// covers a drop or a hole change WHILE an assistant answer is still
// STREAMING (a partial bubble in flight). This file fills that gap.
//
// Scaffolding is copied verbatim from CaddieSheet.realtime.test.tsx (same
// framer-motion passthrough, inert classic-path deps, hoisted
// FakeRealtimeCaddieClient, `vi.mock("@/lib/voice/realtime", ...)`,
// `warmSession.takeWarm` mock). `realtime.ts` / `realtime-ordering.ts` are
// NEVER imported for real here — `@/lib/voice/realtime` is mocked out
// entirely and every fabricated message uses a UNIQUE id EXCEPT the one
// deliberate partial->final pair in test 3 (id "a1", partial:true then
// partial:false — the ordinary, always-on streaming-coalesce UX every
// realtime turn already relies on). This file never asserts the DEDUP
// LANE's transport-level "double-emit" semantics (the same message
// delivered TWICE by realtime.ts due to a connection/session bug,
// specs/caddie-realtime-double-emit-plan.md) — that is out of scope here
// (plan §7) and untouched by anything below.
//
// Manual mutation drill (performed once during development of this file,
// mirrors backend/tests/eval/README.md's drill): in useCaddieLiveSession
// .ts's `upsert`, replace the id-merge (`prev.findIndex((x) => x.id ===
// applied.id)` + in-place replace) with an unconditional append
// (`[...prev, applied]`). Confirmed: `cd frontend && npx vitest run
// src/components/CaddieSheet.realtime-glitch.test.tsx` goes RED on test 3
// only (`getAllByText("Smooth 7-iron.")` finds 2 elements instead of 1 —
// the finalize event duplicates the bubble instead of updating it in
// place); tests 1/2/4 stay green under this specific mutant because none of
// them re-emit the SAME id twice within one client's lifetime. Reverted to
// confirm green again (see the PR description for the captured red output).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import * as React from "react";

// ── framer-motion passthrough — identical to CaddieSheet.realtime.test.tsx ──
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

// ── Classic-path deps CaddieSheet always imports — stubbed inert. ──
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
vi.mock("@/lib/voice/tts-pref", () => ({
  getSheetTtsEnabled: () => false,
  setSheetTtsEnabled: vi.fn(),
}));
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

// ── The live-mode flag — TRUE for this whole file (only the live path has
// a streaming-partial concept). ──
vi.mock("@/lib/voice/live-mode-pref", () => ({
  getCaddieLiveMode: () => true,
}));

// ── Fake RealtimeCaddieClient — same shape as CaddieSheet.realtime.test.tsx.
// `@/lib/voice/realtime` is mocked out ENTIRELY; nothing here ever imports
// the real realtime.ts/realtime-ordering.ts (hard constraint — a parallel
// lane owns those files' internals). ──
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

import CaddieSheet from "./CaddieSheet";
import { useDetachedCaddieLive } from "@/hooks/useDetachedCaddieLive";
import type { CaddiePersonalityInfo } from "@/lib/caddie/types";

const PERSONAS: CaddiePersonalityInfo[] = [
  { id: "strategist", name: "The Strategist", description: "Numbers", avatar: "📊", response_style: "brief", traits: [] },
];

/**
 * Host — the real owner of the live session post-detach
 * (specs/caddie-detach-and-language-pin-plan.md, Item B §B6 T2). Mirrors
 * RoundPageClient's wiring — see CaddieSheet.realtime.test.tsx's identically
 * named/documented Host for the full rationale (synchronous render-phase
 * `start()`, moved-up fallback seeding effect). Copied verbatim per this
 * file's existing "scaffolding copied from CaddieSheet.realtime.test.tsx"
 * convention (top-of-file note).
 */
function Host(props: React.ComponentProps<typeof CaddieSheet>) {
  const detached = useDetachedCaddieLive({
    roundId: props.roundId,
    personaId: props.personaId,
    holeNumber: props.holeNumber,
    holePar: props.holePar,
    holeYards: props.holeYards,
    yardageBasis: props.yardageBasis,
    teeName: props.teeName,
    resolveOpeningShot: props.resolveOpeningShot,
    sheetOpen: props.open,
    eligible: props.sessionActive,
  });
  if (props.open) detached.start();

  const seededFallbackRef = React.useRef(false);
  React.useEffect(() => {
    if (!(detached.liveOn && detached.session.fellBack)) return;
    if (seededFallbackRef.current) return;
    if (detached.session.messages.length === 0) return;
    if (props.convHistory.length > 0) return;
    seededFallbackRef.current = true;
    const seeded = detached.session.messages
      .filter((m) => !m.partial && m.text.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.text }));
    props.onUpdateConvHistory(seeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detached.liveOn, detached.session.fellBack, detached.session.messages, props.convHistory.length]);
  React.useEffect(() => {
    if (!detached.liveOn) seededFallbackRef.current = false;
  }, [detached.liveOn]);

  return (
    <CaddieSheet
      {...props}
      live={detached.session}
      liveOn={detached.liveOn}
      onEndLive={detached.end}
    />
  );
}

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
    live: {
      liveState: "connecting",
      fellBack: false,
      messages: [],
      status: "idle",
      muted: false,
      toggleMute: vi.fn(),
      resume: vi.fn(),
      retryConnect: vi.fn(),
      stop: vi.fn(),
    },
    liveOn: false,
    onEndLive: vi.fn(),
    ...overrides,
  };
}

function renderSheet(overrides: Partial<React.ComponentProps<typeof CaddieSheet>> = {}) {
  const props = buildProps(overrides);
  const utils = render(<Host {...props} />);
  return { ...utils, props };
}

/** Like renderSheet, but `onUpdateConvHistory` loops the updated history back
 *  into `convHistory` via a rerender (mirrors CaddieSheet.realtime.test.tsx's
 *  identically-named helper) — needed for the fallback-seed effect's output
 *  to actually become visible in the classic VoiceBody, which renders from
 *  the `convHistory` PROP, not `live.messages` directly. */
function renderControlledSheet(overrides: Partial<React.ComponentProps<typeof CaddieSheet>> = {}) {
  const props = buildProps(overrides);
  let rerenderFn: (ui: React.ReactElement) => void = () => {};
  const onUpdateConvHistory = vi.fn((history: React.ComponentProps<typeof CaddieSheet>["convHistory"]) => {
    props.convHistory = history;
    rerenderFn(<Host {...props} />);
  });
  props.onUpdateConvHistory = onUpdateConvHistory;
  const utils = render(<Host {...props} />);
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
  warmSessionMock.takeWarm.mockReset();
  warmSessionMock.takeWarm.mockReturnValue(null);
  realtimeMock.FakeRealtimeCaddieClient.instances = [];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CaddieSheet live mode — glitch during a streaming answer", () => {
  it("1. reconnect mid-answer, SUCCESS: partial bubble preserved exactly once, no re-greet, sendContext once on reconnect, post-reconnect turn renders after it", async () => {
    renderSheet();
    await flush();

    const first = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => first.emitStatus("connected"));
    await flush();
    expect(first.sendContext).toHaveBeenCalledTimes(1); // connect anchor

    // A user question, then an assistant answer STREAMING (partial:true) —
    // never reaches response.done before the drop.
    act(() => {
      first.emitMessage({ id: "q1", role: "user", text: "What club from 150?", partial: false, order: 1 });
      first.emitMessage({ id: "a1", role: "assistant", text: "Smooth 7", partial: true, order: 2 });
    });
    await flush();
    expect(screen.getByText("Smooth 7")).toBeTruthy();

    // Drop mid-stream — 'closed' arrives before response.done ever fires.
    act(() => first.emitStatus("closed"));
    await flush();

    const instances = realtimeMock.FakeRealtimeCaddieClient.instances;
    expect(instances).toHaveLength(2); // exactly one cold-mint reconnect
    const second = instances[1];

    act(() => second.emitStatus("connected"));
    await flush();

    // The interrupted partial bubble renders EXACTLY once (not duplicated by
    // the reconnect) — still the same text it had when the drop occurred.
    expect(screen.getAllByText("Smooth 7")).toHaveLength(1);
    // No re-greet: sendOpener never fires on the reconnect client.
    expect(second.sendOpener).not.toHaveBeenCalled();
    // Silent re-anchor: exactly one sendContext on the reconnect's connect.
    expect(second.sendContext).toHaveBeenCalledTimes(1);

    // A fresh post-reconnect turn renders AFTER the preserved partial bubble.
    act(() => {
      second.emitMessage({ id: "q2", role: "user", text: "What about the wind?", partial: false, order: 1 });
      second.emitMessage({ id: "a2", role: "assistant", text: "Take one more club.", partial: false, order: 2 });
    });
    await flush();

    const bubbles = screen.getAllByText(
      /What club from 150\?|Smooth 7|What about the wind\?|Take one more club\./,
    );
    expect(bubbles.map((el) => el.textContent)).toEqual([
      "What club from 150?",
      "Smooth 7",
      "What about the wind?",
      "Take one more club.",
    ]);
  });

  it("2. reconnect mid-answer, FAIL -> classic fallback: mic usable (no dead 'Connecting…'), the completed pre-drop turn is preserved, the INTERRUPTED (never-finished) partial is honestly dropped rather than shown as a fake completed reply, no re-greet", async () => {
    // NOTE (deviation from plan §4 item 2's literal wording, documented in
    // the PR): CaddieSheet.tsx's fallback-seed effect (~line 304-306)
    // deliberately filters `!m.partial` when handing `live.messages` off to
    // the classic transcript — an answer that never finished streaming is
    // intentionally NOT carried over as if it were a real completed reply
    // (the same no-fake-data/honest-empty convention this whole harness
    // exists to protect: a permanently truncated "Smooth 7-ir" bubble would
    // be MORE misleading than showing nothing). So the meaningful assertion
    // here is: the last COMPLETE pre-drop turn survives, and the incomplete
    // partial is never fabricated into a finished-looking bubble.
    // Uses renderControlledSheet (not renderSheet) so the fallback-seed
    // effect's onUpdateConvHistory call actually loops back into the
    // `convHistory` prop the classic VoiceBody renders from — a plain
    // vi.fn() spy would seed nothing visible. VoiceBody shows
    // `convHistory.slice(0, -2)` as "history" (the last 2 seeded entries are
    // reserved for the classic ladder's own "current turn" display, which
    // this fallback path never populates) — so a full completed turn (q1,a1)
    // plus one more full message (q2) keeps q1/a1 OUT of that excluded
    // last-2 window, matching the pattern CaddieSheet.realtime.test.tsx's own
    // "drop -> reconnect FAIL -> classic fallback" test already relies on.
    renderControlledSheet();
    await flush();

    const first = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => first.emitStatus("connected"));
    await flush();

    act(() => {
      first.emitMessage({ id: "q1", role: "user", text: "What club from 150?", partial: false, order: 1 });
      first.emitMessage({ id: "a1", role: "assistant", text: "Smooth 7-iron.", partial: false, order: 2 });
      first.emitMessage({ id: "q2", role: "user", text: "And with the wind?", partial: false, order: 3 });
      first.emitMessage({ id: "a2", role: "assistant", text: "Take one more club.", partial: false, order: 4 });
      first.emitMessage({ id: "q3", role: "user", text: "What about a draw?", partial: false, order: 5 });
      first.emitMessage({ id: "a3", role: "assistant", text: "Add a", partial: true, order: 6 });
    });
    await flush();

    act(() => first.emitStatus("closed")); // drop mid-stream -> reconnect
    await flush();

    const second = realtimeMock.FakeRealtimeCaddieClient.instances[1];
    act(() => second.emitStatus("closed")); // the reconnect itself fails -> classic fallback
    await flush();

    // Usable classic mic — never a dead "Connecting…" body.
    expect(screen.getByLabelText("Start recording")).toBeTruthy();
    expect(screen.getByText("Tap-to-talk mode")).toBeTruthy();
    expect(screen.queryByText(/Connecting/)).toBeNull();

    // The completed pre-drop turns survive the fallback.
    expect(screen.getByText("What club from 150?")).toBeTruthy();
    expect(screen.getByText("Smooth 7-iron.")).toBeTruthy();
    // The interrupted (never-finished) partial is NOT shown as a fake
    // completed reply.
    expect(screen.queryByText("Add a")).toBeNull();

    // No re-greet anywhere in this whole sequence.
    expect(first.sendOpener).not.toHaveBeenCalled();
    expect(second.sendOpener).not.toHaveBeenCalled();
    expect(realtimeMock.FakeRealtimeCaddieClient.instances).toHaveLength(2); // no third mint
  });

  it("3. hole-change mid-answer: exactly one new-hole sendContext (no double-send), in-flight bubble text unchanged until it finalizes on response.done", async () => {
    const { rerender, props } = renderSheet();
    await flush();

    const client = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => client.emitStatus("connected"));
    await flush();
    expect(client.sendContext).toHaveBeenCalledTimes(1); // connect anchor (hole 3)

    // Assistant answer starts streaming...
    act(() => {
      client.emitMessage({ id: "q1", role: "user", text: "What club from 150?", partial: false, order: 1 });
      client.emitMessage({ id: "a1", role: "assistant", text: "Smooth 7", partial: true, order: 2 });
    });
    await flush();
    expect(screen.getByText("Smooth 7")).toBeTruthy();

    // ...the player walks to the next hole WHILE it's still streaming.
    rerender(<Host {...props} holeNumber={4} holePar={4} holeYards={380} />);
    await flush();

    // Exactly ONE new sendContext for the new hole — no double-send.
    expect(client.sendContext).toHaveBeenCalledTimes(2);
    expect(client.sendContext.mock.calls[1][0] as string).toContain("hole 4");

    // The in-flight bubble is untouched by the hole change.
    expect(screen.getByText("Smooth 7")).toBeTruthy();
    expect(screen.queryByText("Smooth 7-iron.")).toBeNull();

    // response.done arrives — the SAME id finalizes to the full text (still
    // exactly one bubble for this id, never a second one from the hole change).
    act(() => {
      client.emitMessage({ id: "a1", role: "assistant", text: "Smooth 7-iron.", partial: false, order: 2 });
    });
    await flush();
    expect(screen.getAllByText("Smooth 7-iron.")).toHaveLength(1);
    expect(screen.queryByText("Smooth 7")).toBeNull();
  });

  it("4. hole-change during the reconnect window: every sendContext the reconnect client sees reflects the NEW hole, never a stale re-anchor to the old one", async () => {
    // NOTE (deviation from plan §4 item 4's literal "fires once", documented
    // in the PR): a hole change that lands WHILE the reconnect client is
    // still mid-flight can legitimately produce TWO sendContext calls on
    // it — one from the hole-change effect firing immediately (clientRef
    // already points at the reconnecting client), one more from the
    // connect-time re-anchor once it reaches 'connected' (useCaddieLiveSession
    // .ts's onStatus handler always re-anchors on connect, unconditionally,
    // by design — "the resumed/reconnected server session may be stale").
    // Both calls are CORRECT (both carry the new hole) — this is a harmless
    // redundant send, not a stale-hole bug, and fixing the redundancy is a
    // hook-level behavior change out of scope for this SILENT harness item
    // (flagged for the eng-lead as a minor follow-up, not fixed here). The
    // invariant this test actually protects — the one dim-6/dim-1 property
    // that matters — is: NEVER a stale re-anchor to the OLD hole.
    const { rerender, props } = renderSheet();
    await flush();

    const first = realtimeMock.FakeRealtimeCaddieClient.instances[0];
    act(() => first.emitStatus("connected"));
    await flush();
    expect(first.sendContext).toHaveBeenCalledTimes(1); // connect anchor (hole 3)

    act(() => {
      first.emitMessage({ id: "q1", role: "user", text: "What club from 150?", partial: false, order: 1 });
      first.emitMessage({ id: "a1", role: "assistant", text: "Smooth 7", partial: true, order: 2 });
    });
    await flush();

    // Drop mid-stream -> reconnect begins (fresh cold-mint client in flight).
    act(() => first.emitStatus("closed"));
    await flush();
    const second = realtimeMock.FakeRealtimeCaddieClient.instances[1];

    // Hole change WHILE the reconnect is still in flight (before its
    // 'connected' status ever arrives).
    rerender(<Host {...props} holeNumber={5} holePar={3} holeYards={178} />);
    await flush();

    // The reconnect client finally connects.
    act(() => second.emitStatus("connected"));
    await flush();

    // At least one re-anchor sendContext fired on the reconnect client, and
    // EVERY one of them reflects the NEW hole (5) — never a stale re-anchor
    // to hole 3.
    expect(second.sendContext.mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of second.sendContext.mock.calls) {
      expect(call[0] as string).toContain("hole 5");
      expect(call[0] as string).not.toContain("hole 3");
    }
    expect(second.sendOpener).not.toHaveBeenCalled(); // still no re-greet
  });
});
