// @vitest-environment jsdom
//
// Integration test for the conversational (agentic) round-setup loop. The pure
// reducer is unit-tested separately; this drives the REAL component state machine
// (autoStart → record → transcribe → parse → ask → record → parse → complete →
// confirm) with the mic + backend mocked, so the wiring the reviewer couldn't
// exercise headlessly (effects, the auto-parse guard, the ask→record loop, the
// mounted guard) is covered. Aligns with "QA must test critical flows".

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// ── Mocks ──
vi.mock("@/lib/api", () => ({ fetchAPI: vi.fn() }));

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
  },
  transcribeBlob: vi.fn(),
}));

import VoiceRoundSetup from "./VoiceRoundSetup";
import { fetchAPI } from "@/lib/api";
import { transcribeBlob } from "@/lib/voice/deepgram";

const fetchAPIMock = vi.mocked(fetchAPI);
const transcribeMock = vi.mocked(transcribeBlob);

beforeEach(() => {
  vi.clearAllMocks();
  startSpy.mockResolvedValue(undefined);
  stopSpy.mockResolvedValue(new Blob());
});

async function tapStopMic() {
  // In the listening phase the mic button toggles recording off.
  const mic = await screen.findByLabelText("Stop recording");
  fireEvent.click(mic);
}

describe("VoiceRoundSetup — conversational loop", () => {
  it("asks for the missing course, then completes and confirms the merged round", async () => {
    const onSetupRound = vi.fn();

    // Turn 1 answer → players only; Turn 2 answer → the course.
    transcribeMock
      .mockResolvedValueOnce({ transcript: "playing with Dan and Matt" } as never)
      .mockResolvedValueOnce({ transcript: "Pebble Beach" } as never);

    // Backend: turn 1 incomplete (needs course); turn 2 complete.
    fetchAPIMock
      .mockResolvedValueOnce({
        courseName: "",
        playerNames: ["Dan", "Matt"],
        missing: ["course"],
        followUpQuestion: "Which course today?",
        complete: false,
      } as never)
      .mockResolvedValueOnce({
        courseName: "Pebble Beach",
        playerNames: ["Dan", "Matt"],
        missing: [],
        followUpQuestion: null,
        complete: true,
      } as never);

    render(<VoiceRoundSetup autoStart onSetupRound={onSetupRound} onClose={() => {}} />);

    // autoStart begins recording.
    await waitFor(() => expect(startSpy).toHaveBeenCalledTimes(1));

    // Turn 1: stop → transcribe → auto-parse → caddie asks for the course.
    await tapStopMic();
    expect(await screen.findByText("Which course today?")).toBeTruthy();
    // It re-opened the mic for the answer (single-tap loop).
    await waitFor(() => expect(startSpy).toHaveBeenCalledTimes(2));

    // The 2nd parse must carry what we know + which field we're answering.
    await waitFor(() => expect(fetchAPIMock).toHaveBeenCalledTimes(1));

    // Turn 2: answer the course → complete → confirm screen.
    await tapStopMic();
    const startBtn = await screen.findByText("Start round");
    await waitFor(() => expect(fetchAPIMock).toHaveBeenCalledTimes(2));

    const secondBody = JSON.parse(
      (fetchAPIMock.mock.calls[1][1] as { body: string }).body,
    );
    expect(secondBody.expecting).toBe("course");
    expect(secondBody.current.playerNames).toEqual(["Dan", "Matt"]);

    // Confirm → the merged round is handed off.
    fireEvent.click(startBtn);
    expect(onSetupRound).toHaveBeenCalledWith({
      courseName: "Pebble Beach",
      playerNames: ["Dan", "Matt"],
      teeName: undefined,
    });

    cleanup();
  });

  it("completes in one shot when the first utterance is already complete", async () => {
    const onSetupRound = vi.fn();
    transcribeMock.mockResolvedValueOnce({
      transcript: "Pebble Beach with Dan",
    } as never);
    fetchAPIMock.mockResolvedValueOnce({
      courseName: "Pebble Beach",
      playerNames: ["Dan"],
      missing: [],
      followUpQuestion: null,
      complete: true,
    } as never);

    render(<VoiceRoundSetup autoStart onSetupRound={onSetupRound} onClose={() => {}} />);
    await waitFor(() => expect(startSpy).toHaveBeenCalledTimes(1));

    await tapStopMic();
    const startBtn = await screen.findByText("Start round");
    fireEvent.click(startBtn);
    expect(onSetupRound).toHaveBeenCalledWith({
      courseName: "Pebble Beach",
      playerNames: ["Dan"],
      teeName: undefined,
    });
    // Only one round-trip — no follow-up.
    expect(fetchAPIMock).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
