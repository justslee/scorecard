// @vitest-environment jsdom
//
// CaddieSheet session-path wiring (agentic caddie P1).
//
// The sheet must be session-first — /caddie/session/voice + /session/recommend
// with the REAL persona id — and silently fall back to the stateless
// /caddie/voice + /caddie/recommend path when there is no session (legacy /
// offline rounds) or a session call fails. These tests drive the real
// component with the backend + mic mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act, configure } from "@testing-library/react";

// The streaming ladder's progressive render relies on a REAL setTimeout
// fallback (jsdom has no requestAnimationFrame — see lib/caddie/stream-buffer.ts).
// Under a full parallel `vitest run` (many jsdom environments contending for
// CPU), that real timer can legitimately take longer than testing-library's
// default 1000ms polling window to fire — a false-negative flake, not a logic
// bug (these tests pass reliably in isolation). Widen the window generously;
// this doesn't mask a real failure, it just gives slow CI/parallel runs headroom.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 10000 });

// ── Mocks ──
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

// useSheetTTS — spied directly so "tts.speak called exactly once with the
// full text" is a clean assertion, independent of the localStorage-gated
// mute pref (default OFF) and the real speakCaddieReply fetch.
const ttsSpeakSpy = vi.fn();
const ttsUnlockSpy = vi.fn();
const ttsStopSpy = vi.fn();
vi.mock("@/hooks/useSheetTTS", () => ({
  useSheetTTS: () => ({
    unlock: ttsUnlockSpy,
    speak: ttsSpeakSpy,
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

/** Emits `tokens` progressively (a real tick between each, so tests can
 *  observe the rAF-coalesced partial render before the full text lands) and
 *  resolves with the joined string. `onToken` lives at `opts.onToken` on
 *  both streaming wrappers' second argument. Reserved for the ONE test that
 *  actually asserts an intermediate render — every other streaming-mock use
 *  should prefer `emitTokensSync` below, which has no real-timer dependency
 *  and so isn't sensitive to scheduling delays under a loaded, parallel
 *  `vitest run` (CaddieSheet's own rAF-fallback flush, exercised for real,
 *  is dependency enough). */
async function emitTokensProgressively(
  opts: { onToken: (delta: string) => void },
  tokens: string[],
): Promise<string> {
  let full = "";
  for (const t of tokens) {
    await new Promise((r) => setTimeout(r, 0));
    opts.onToken(t);
    full += t;
  }
  return full;
}

/** Emits `tokens` synchronously (no artificial macrotask delay between them —
 *  `async` only for the Promise<string> return shape, no `await` inside) and
 *  resolves with the joined string — the low-flake default for streaming
 *  mocks that only need the FINAL text, not an observed intermediate one. */
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

function renderSheet(overrides: Partial<React.ComponentProps<typeof CaddieSheet>> = {}) {
  const props: React.ComponentProps<typeof CaddieSheet> = {
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
    transcribeMock.mockResolvedValueOnce({ transcript: "what club from here?" } as never);
    sessionVoiceStreamMock.mockImplementationOnce((_params, opts) =>
      emitTokensProgressively(opts, ["Easy 7. ", "Center of the green."]),
    );
    const props = renderSheet();

    fireEvent.click(screen.getByLabelText("Start recording"));
    fireEvent.click(await screen.findByLabelText("Stop recording"));

    await waitFor(() => expect(sessionVoiceStreamMock).toHaveBeenCalledTimes(1));
    expect(sessionVoiceStreamMock).toHaveBeenCalledWith(
      { round_id: "round-123", transcript: "what club from here?", personality_id: "strategist", hole_number: 3 },
      expect.objectContaining({ onToken: expect.any(Function) }),
    );
    expect(talkToCaddieStreamMock).not.toHaveBeenCalled();
    expect(talkToCaddieMock).not.toHaveBeenCalled();

    // Progressive: the first chunk renders before the second one lands.
    expect(await screen.findByText(/Easy 7\./)).toBeTruthy();
    expect(await screen.findByText("Easy 7. Center of the green.")).toBeTruthy();

    // History updates with the FULL text only, once the stream resolves.
    expect(props.onUpdateConvHistory).toHaveBeenCalledWith([
      { role: "user", content: "what club from here?" },
      { role: "assistant", content: "Easy 7. Center of the green." },
    ]);
    // TTS fires exactly once, with the complete text.
    expect(ttsSpeakSpy).toHaveBeenCalledTimes(1);
    expect(ttsSpeakSpy).toHaveBeenCalledWith("Easy 7. Center of the green.", "strategist");
  });

  it("tier 1 -> tier 2: a pre-first-token session failure falls back to /caddie/voice/stream (still streaming)", async () => {
    transcribeMock.mockResolvedValueOnce({ transcript: "lay up or go?" } as never);
    sessionVoiceStreamMock.mockRejectedValueOnce(new MockBeforeFirstByteError());
    talkToCaddieStreamMock.mockImplementationOnce((_params, opts) => emitTokensSync(opts, ["Lay up to 95."]));
    renderSheet();

    fireEvent.click(screen.getByLabelText("Start recording"));
    fireEvent.click(await screen.findByLabelText("Stop recording"));

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
    transcribeMock.mockResolvedValueOnce({ transcript: "what now?" } as never);
    sessionVoiceStreamMock.mockRejectedValueOnce(new MockBeforeFirstByteError());
    talkToCaddieStreamMock.mockRejectedValueOnce(new MockBeforeFirstByteError());
    talkToCaddieMock.mockResolvedValueOnce({ response: "Take the 8-iron." });
    renderSheet();

    fireEvent.click(screen.getByLabelText("Start recording"));
    fireEvent.click(await screen.findByLabelText("Stop recording"));

    await waitFor(() => expect(talkToCaddieMock).toHaveBeenCalledTimes(1));
    expect(talkToCaddieMock).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: "what now?", personality_id: "strategist", hole_number: 3 }),
    );
    expect(await screen.findByText("Take the 8-iron.")).toBeTruthy();
    expect(ttsSpeakSpy).toHaveBeenCalledTimes(1);
    expect(ttsSpeakSpy).toHaveBeenCalledWith("Take the 8-iron.", "strategist");
  });

  it("a POST-first-token failure is TERMINAL — no fallback, partial discarded, calm error shown, TTS never fires", async () => {
    transcribeMock.mockResolvedValueOnce({ transcript: "what club?" } as never);
    sessionVoiceStreamMock.mockImplementationOnce(async (_params, opts) => {
      opts.onToken("Partial reply "); // a token already rendered...
      throw new Error("mid-stream failure — not a BeforeFirstByteError");
    });
    renderSheet();

    fireEvent.click(screen.getByLabelText("Start recording"));
    fireEvent.click(await screen.findByLabelText("Stop recording"));

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
    transcribeMock.mockResolvedValueOnce({ transcript: "what club?" } as never);
    talkToCaddieStreamMock.mockImplementationOnce((_params, opts) => emitTokensSync(opts, ["Smooth 6."]));
    renderSheet({ sessionActive: false });

    fireEvent.click(screen.getByLabelText("Start recording"));
    fireEvent.click(await screen.findByLabelText("Stop recording"));

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
