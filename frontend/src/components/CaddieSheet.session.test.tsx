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
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";

// ── Mocks ──
vi.mock("@/lib/caddie/api", () => ({
  sessionVoice: vi.fn(),
  sessionRecommend: vi.fn(),
  talkToCaddie: vi.fn(),
  fetchRecommendation: vi.fn(),
}));
vi.mock("@/lib/storage", () => ({ getGolferProfile: vi.fn(() => null) }));
vi.mock("@/lib/caddie/clubs", () => ({ buildClubMap: vi.fn(() => ({})) }));

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
  sessionVoice,
  sessionRecommend,
  talkToCaddie,
  fetchRecommendation,
} from "@/lib/caddie/api";
import { transcribeBlob } from "@/lib/voice/deepgram";
import type { CaddieRecommendation } from "@/lib/caddie/types";

const sessionVoiceMock = vi.mocked(sessionVoice);
const sessionRecommendMock = vi.mocked(sessionRecommend);
const talkToCaddieMock = vi.mocked(talkToCaddie);
const fetchRecommendationMock = vi.mocked(fetchRecommendation);
const transcribeMock = vi.mocked(transcribeBlob);

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

describe("CaddieSheet — session voice path carries the real persona id", () => {
  it("sends the transcript to /session/voice with personality_id + round_id", async () => {
    transcribeMock.mockResolvedValueOnce({ transcript: "what club from here?" } as never);
    sessionVoiceMock.mockResolvedValueOnce({ response: "Easy 7. Center of the green." });
    const props = renderSheet();

    fireEvent.click(screen.getByLabelText("Start recording"));
    fireEvent.click(await screen.findByLabelText("Stop recording"));

    await waitFor(() => expect(sessionVoiceMock).toHaveBeenCalledTimes(1));
    expect(sessionVoiceMock).toHaveBeenCalledWith({
      round_id: "round-123",
      transcript: "what club from here?",
      personality_id: "strategist",
      hole_number: 3,
    });
    expect(talkToCaddieMock).not.toHaveBeenCalled();
    expect(await screen.findByText("Easy 7. Center of the green.")).toBeTruthy();
    // Local display history still updates (server owns the canonical ledger).
    expect(props.onUpdateConvHistory).toHaveBeenCalledWith([
      { role: "user", content: "what club from here?" },
      { role: "assistant", content: "Easy 7. Center of the green." },
    ]);
  });

  it("falls back to stateless /caddie/voice when the session call fails", async () => {
    transcribeMock.mockResolvedValueOnce({ transcript: "lay up or go?" } as never);
    sessionVoiceMock.mockRejectedValueOnce(new Error("404"));
    talkToCaddieMock.mockResolvedValueOnce({ response: "Lay up to 95." });
    renderSheet();

    fireEvent.click(screen.getByLabelText("Start recording"));
    fireEvent.click(await screen.findByLabelText("Stop recording"));

    await waitFor(() => expect(talkToCaddieMock).toHaveBeenCalledTimes(1));
    expect(talkToCaddieMock).toHaveBeenCalledWith(
      expect.objectContaining({
        transcript: "lay up or go?",
        personality_id: "strategist", // real backend id, never "steve"
        hole_number: 3,
      }),
    );
    expect(await screen.findByText("Lay up to 95.")).toBeTruthy();
  });
});

describe("CaddieSheet — live dictation (specs/caddie-live-dictation-plan.md)", () => {
  it("shows live words while speaking and sends the LIVE transcript — no blob upload, no Transcribing", async () => {
    sessionVoiceMock.mockResolvedValueOnce({ response: "Smooth 8-iron." });
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

    await waitFor(() => expect(sessionVoiceMock).toHaveBeenCalledTimes(1));
    expect(sessionVoiceMock).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: "what club from 150" }),
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
    sessionVoiceMock.mockResolvedValueOnce({ response: "Lay up to 95." });
    renderSheet();

    fireEvent.click(screen.getByLabelText("Start recording"));
    fireEvent.click(await screen.findByLabelText("Stop recording"));

    await waitFor(() => expect(sessionVoiceMock).toHaveBeenCalledTimes(1));
    expect(transcribeMock).toHaveBeenCalledTimes(1);
    expect(sessionVoiceMock).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: "lay up or go?" }),
    );
  });

  it("falls back when live errored mid-utterance even with partial text", async () => {
    transcribeMock.mockResolvedValueOnce({ transcript: "full sentence from blob" } as never);
    sessionVoiceMock.mockResolvedValueOnce({ response: "Got it." });
    renderSheet();

    fireEvent.click(screen.getByLabelText("Start recording"));
    await waitFor(() => expect(liveState.instances).toHaveLength(1));
    const live = liveState.instances[0];
    act(() => {
      live.events.onInterim?.("full sen"); // partial before the socket died
      live.events.onError?.(new Error("ws dropped"));
    });

    fireEvent.click(screen.getByLabelText("Stop recording"));

    await waitFor(() => expect(sessionVoiceMock).toHaveBeenCalledTimes(1));
    expect(transcribeMock).toHaveBeenCalledTimes(1); // authoritative fallback
    expect(sessionVoiceMock).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: "full sentence from blob" }),
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
    expect(sessionVoiceMock).not.toHaveBeenCalled();
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
