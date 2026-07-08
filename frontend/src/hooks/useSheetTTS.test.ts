// @vitest-environment jsdom
//
// useSheetTTS (specs/voice-tts-sheet-replies-plan.md §8). jsdom doesn't
// implement HTMLMediaElement.prototype.play/pause or URL.createObjectURL, so
// each is stubbed per test.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const speakCaddieReplyMock = vi.fn();
vi.mock("@/lib/caddie/api", () => ({
  speakCaddieReply: (...args: unknown[]) => speakCaddieReplyMock(...args),
}));

const enabledState = { value: true };
vi.mock("@/lib/voice/tts-pref", () => ({
  getSheetTtsEnabled: () => enabledState.value,
  setSheetTtsEnabled: vi.fn(),
}));

const voiceEventMock = vi.fn();
vi.mock("@/lib/voice/telemetry", () => ({
  voiceEvent: (...args: unknown[]) => voiceEventMock(...args),
}));

import { useSheetTTS } from "./useSheetTTS";

function makeBlob(): Blob {
  return new Blob(["fake-mp3"], { type: "audio/mpeg" });
}

describe("useSheetTTS", () => {
  let playSpy: ReturnType<typeof vi.fn>;
  let pauseSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    enabledState.value = true;
    speakCaddieReplyMock.mockReset();
    voiceEventMock.mockReset();

    playSpy = vi.fn().mockResolvedValue(undefined);
    pauseSpy = vi.fn();
    window.HTMLMediaElement.prototype.play = playSpy as unknown as () => Promise<void>;
    window.HTMLMediaElement.prototype.pause = pauseSpy as unknown as () => void;
    window.URL.createObjectURL = vi.fn(() => "blob:mock-url");
    window.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("speak() is a no-op when the mute pref is off", () => {
    enabledState.value = false;
    const { result } = renderHook(() => useSheetTTS());

    act(() => result.current.speak("Nice drive.", "classic"));

    expect(speakCaddieReplyMock).not.toHaveBeenCalled();
    expect(result.current.isSpeaking).toBe(false);
  });

  it("speak() is a no-op for empty/whitespace text", () => {
    const { result } = renderHook(() => useSheetTTS());

    act(() => result.current.speak("   ", "classic"));

    expect(speakCaddieReplyMock).not.toHaveBeenCalled();
  });

  it("unlock() is idempotent", () => {
    const { result } = renderHook(() => useSheetTTS());

    act(() => result.current.unlock());
    const audioCountAfterFirst = document.querySelectorAll("audio").length;
    const playCallsAfterFirst = playSpy.mock.calls.length;

    act(() => result.current.unlock());

    expect(document.querySelectorAll("audio").length).toBe(audioCountAfterFirst);
    expect(document.querySelectorAll("audio").length).toBe(1);
    // Idempotent: the bless-play-then-pause dance only runs once.
    expect(playSpy.mock.calls.length).toBe(playCallsAfterFirst);
  });

  it("a second speak() aborts the first in-flight fetch and only the second plays", async () => {
    let resolveFirst: (b: Blob) => void = () => {};
    const firstPromise = new Promise<Blob>((resolve) => {
      resolveFirst = resolve;
    });
    speakCaddieReplyMock.mockImplementationOnce(() => firstPromise);
    speakCaddieReplyMock.mockImplementationOnce(async () => makeBlob());

    const { result } = renderHook(() => useSheetTTS());
    act(() => result.current.unlock());
    const playCallsAfterUnlock = playSpy.mock.calls.length; // unlock() itself blesses with one play()

    act(() => result.current.speak("First reply.", "classic"));
    expect(speakCaddieReplyMock).toHaveBeenCalledTimes(1);
    const firstSignal = speakCaddieReplyMock.mock.calls[0][2] as AbortSignal;
    expect(firstSignal.aborted).toBe(false);

    act(() => result.current.speak("Second reply.", "classic"));

    // Starting the second speak() must abort the first's fetch signal.
    expect(firstSignal.aborted).toBe(true);

    await waitFor(() => expect(speakCaddieReplyMock).toHaveBeenCalledTimes(2));
    // Only the second speak()'s blob actually plays — one new play() call.
    await waitFor(() => expect(playSpy.mock.calls.length).toBe(playCallsAfterUnlock + 1));

    // The stale first fetch resolving late must not resurrect playback.
    resolveFirst(makeBlob());
    await new Promise((r) => setTimeout(r, 0));
    expect(playSpy.mock.calls.length).toBe(playCallsAfterUnlock + 1);
  });

  it("a rejected play() does not throw out of speak()", async () => {
    speakCaddieReplyMock.mockResolvedValue(makeBlob());
    playSpy.mockRejectedValue(new DOMException("blocked", "NotAllowedError"));

    const { result } = renderHook(() => useSheetTTS());
    act(() => result.current.unlock());

    expect(() => act(() => result.current.speak("Hello.", "classic"))).not.toThrow();

    await waitFor(() =>
      expect(voiceEventMock).toHaveBeenCalledWith("sheet-tts", "speak_failed", expect.any(Object)),
    );
    expect(result.current.isSpeaking).toBe(false);
  });

  // specs/caddie-conversational-loop-plan.md §3.3 — `onPlaybackEnd` is the
  // single signal the hands-free loop re-arms on. It MUST fire only on the
  // audio element's native `ended` event, never on `pause` (stop() / a new
  // speak() / barge-in) — a double-arm from re-firing on `pause` would make
  // the loop uncontrollable.
  it("onPlaybackEnd fires on the audio element's native 'ended' event", async () => {
    speakCaddieReplyMock.mockResolvedValue(makeBlob());
    const onPlaybackEnd = vi.fn();
    const { result } = renderHook(() => useSheetTTS({ onPlaybackEnd }));

    act(() => result.current.unlock());
    act(() => result.current.speak("Nice drive.", "classic"));
    await waitFor(() => expect(result.current.isSpeaking).toBe(true));

    const el = document.querySelector("audio")!;
    act(() => el.dispatchEvent(new Event("ended")));

    expect(onPlaybackEnd).toHaveBeenCalledTimes(1);
    expect(result.current.isSpeaking).toBe(false);
  });

  it("onPlaybackEnd does NOT fire on a dispatched 'pause' event (stop() / barge-in)", async () => {
    speakCaddieReplyMock.mockResolvedValue(makeBlob());
    const onPlaybackEnd = vi.fn();
    const { result } = renderHook(() => useSheetTTS({ onPlaybackEnd }));

    act(() => result.current.unlock());
    act(() => result.current.speak("Nice drive.", "classic"));
    await waitFor(() => expect(result.current.isSpeaking).toBe(true));

    const el = document.querySelector("audio")!;
    act(() => el.dispatchEvent(new Event("pause")));

    expect(onPlaybackEnd).not.toHaveBeenCalled();
    expect(result.current.isSpeaking).toBe(false);

    // stop() itself pauses the element — also must not fire onPlaybackEnd.
    act(() => result.current.stop());
    act(() => el.dispatchEvent(new Event("pause")));
    expect(onPlaybackEnd).not.toHaveBeenCalled();
  });

  // specs/fix-ios-tts-playback-plan.md Part B — prime the shared element with
  // a REAL decodable silent source inside the gesture, and make sure that
  // prime clip can never spuriously re-arm the hands-free loop.
  describe("gesture-unlock priming (fix-ios-tts-playback-plan)", () => {
    it("(b) unlock() synchronously sets a non-empty silent-audio src on the element", () => {
      const { result } = renderHook(() => useSheetTTS());

      act(() => result.current.unlock());

      const src = document.querySelector("audio")!.getAttribute("src");
      expect(src).toBeTruthy();
      expect(src).toMatch(/^data:audio/);
    });

    it("(c) unlock() then speak() reuses the SAME element (count stays 1) and plays the blob URL src", async () => {
      speakCaddieReplyMock.mockResolvedValue(makeBlob());
      const { result } = renderHook(() => useSheetTTS());

      act(() => result.current.unlock());
      expect(document.querySelectorAll("audio").length).toBe(1);

      act(() => result.current.speak("Nice drive.", "classic"));
      await waitFor(() => expect(result.current.isSpeaking).toBe(true));

      expect(document.querySelectorAll("audio").length).toBe(1);
      const el = document.querySelector("audio")!;
      expect(el.getAttribute("src")).toBe("blob:mock-url");
      expect(playSpy).toHaveBeenCalled();
    });

    it("(d) a new speak() while speaking, stop(), and a dispatched 'pause' all leave onPlaybackEnd uncalled", async () => {
      speakCaddieReplyMock.mockResolvedValue(makeBlob());
      const onPlaybackEnd = vi.fn();
      const { result } = renderHook(() => useSheetTTS({ onPlaybackEnd }));

      act(() => result.current.unlock());
      act(() => result.current.speak("First reply.", "classic"));
      await waitFor(() => expect(result.current.isSpeaking).toBe(true));

      // Barge-in: a new speak() pauses the currently-playing element first.
      act(() => result.current.speak("Second reply.", "classic"));
      await waitFor(() => expect(result.current.isSpeaking).toBe(true));
      expect(onPlaybackEnd).not.toHaveBeenCalled();

      act(() => result.current.stop());
      expect(onPlaybackEnd).not.toHaveBeenCalled();

      const el = document.querySelector("audio")!;
      act(() => el.dispatchEvent(new Event("pause")));
      expect(onPlaybackEnd).not.toHaveBeenCalled();
    });

    it("(e) a natural 'ended' after a real speak() still calls onPlaybackEnd exactly once", async () => {
      speakCaddieReplyMock.mockResolvedValue(makeBlob());
      const onPlaybackEnd = vi.fn();
      const { result } = renderHook(() => useSheetTTS({ onPlaybackEnd }));

      act(() => result.current.unlock());
      act(() => result.current.speak("Nice drive.", "classic"));
      await waitFor(() => expect(result.current.isSpeaking).toBe(true));

      const el = document.querySelector("audio")!;
      act(() => el.dispatchEvent(new Event("ended")));

      expect(onPlaybackEnd).toHaveBeenCalledTimes(1);
    });

    it("(e-guard) a dispatched 'ended' from priming only (unlock, no speak) does NOT call onPlaybackEnd", () => {
      const onPlaybackEnd = vi.fn();
      const { result } = renderHook(() => useSheetTTS({ onPlaybackEnd }));

      act(() => result.current.unlock());

      const el = document.querySelector("audio")!;
      act(() => el.dispatchEvent(new Event("ended")));

      expect(onPlaybackEnd).not.toHaveBeenCalled();
    });

    it("(f) a rejected prime play() emits voiceEvent('sheet-tts', 'prime_failed', {detail})", async () => {
      // NOT `new DOMException(...)`: jsdom's DOMException fails `instanceof
      // Error` (a documented jsdom gap — real WebKit's does not, which is why
      // prod telemetry correctly showed `detail=NotSupportedError`), so the
      // `err instanceof Error ? err.name : "unknown"` guard would report
      // "unknown" here under jsdom. A plain Error with `.name` set exercises
      // the same code path deterministically in this test environment.
      const rejection = new Error("x");
      rejection.name = "NotAllowedError";
      playSpy.mockRejectedValue(rejection);
      const { result } = renderHook(() => useSheetTTS());

      act(() => result.current.unlock());

      await waitFor(() =>
        expect(voiceEventMock).toHaveBeenCalledWith("sheet-tts", "prime_failed", {
          detail: "NotAllowedError",
        }),
      );
    });
  });
});
