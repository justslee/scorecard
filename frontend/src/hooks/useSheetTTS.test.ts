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

    it("(g) onSpeakStart fires exactly once after a real speak()'s play() resolves", async () => {
      speakCaddieReplyMock.mockResolvedValue(makeBlob());
      const onSpeakStart = vi.fn();
      const { result } = renderHook(() => useSheetTTS({ onSpeakStart }));

      act(() => result.current.unlock());
      expect(onSpeakStart).not.toHaveBeenCalled(); // the silent prime clip must not fire it

      act(() => result.current.speak("Nice drive.", "classic"));
      await waitFor(() => expect(result.current.isSpeaking).toBe(true));

      expect(onSpeakStart).toHaveBeenCalledTimes(1);
    });

    it("(h) onSpeakStart does NOT fire for a superseded/aborted speak() — even if its play() resolves after the abort", async () => {
      // The first speak()'s fetch resolves immediately (so it reaches play()),
      // but its play() itself stays pending until the second speak() has
      // already superseded (aborted) it — exercising the post-await aborted
      // guard, not just the pre-play() stale-fetch guard.
      speakCaddieReplyMock.mockResolvedValueOnce(makeBlob());
      speakCaddieReplyMock.mockResolvedValueOnce(makeBlob());
      let resolveFirstPlay: () => void = () => {};
      const firstPlayPromise = new Promise<void>((resolve) => {
        resolveFirstPlay = resolve;
      });
      const onSpeakStart = vi.fn();
      const { result } = renderHook(() => useSheetTTS({ onSpeakStart }));

      act(() => result.current.unlock()); // consumes the default-resolved play() — not the once-pending one below
      const playCallsAfterUnlock = playSpy.mock.calls.length;

      // Make the NEXT play() call (the first speak()'s) stay pending until aborted.
      playSpy.mockImplementationOnce(() => firstPlayPromise);
      act(() => result.current.speak("First reply.", "classic"));
      await waitFor(() => expect(playSpy.mock.calls.length).toBe(playCallsAfterUnlock + 1));
      expect(onSpeakStart).not.toHaveBeenCalled(); // first speak's play() hasn't resolved yet

      // Second speak() supersedes the first while its play() is still pending.
      act(() => result.current.speak("Second reply.", "classic"));
      await waitFor(() => expect(onSpeakStart).toHaveBeenCalledTimes(1)); // only the second's play() fires it

      // The stale first play() resolving late must not fire a second,
      // mismatched onSpeakStart.
      resolveFirstPlay();
      await new Promise((r) => setTimeout(r, 0));
      expect(onSpeakStart).toHaveBeenCalledTimes(1);
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

  // Sentence-level TTS pipelining (specs/caddie-realtime-conversation-plan.md
  // §6.5.4, Slice A2) — the queued mode: beginStream()/enqueue()/endStream().
  // These prove the 6 hard invariants from the plan.
  describe("queued streaming mode (beginStream/enqueue/endStream)", () => {
    it("plays N chunks sequentially, back-to-back, on the SAME element", async () => {
      speakCaddieReplyMock.mockResolvedValue(makeBlob());
      const { result } = renderHook(() => useSheetTTS());

      act(() => result.current.unlock());
      const playCallsAfterUnlock = playSpy.mock.calls.length;

      act(() => result.current.beginStream());
      act(() => result.current.enqueue("One.", "classic"));
      await waitFor(() => expect(playSpy.mock.calls.length).toBe(playCallsAfterUnlock + 1));

      act(() => result.current.enqueue("Two.", "classic"));
      act(() => result.current.enqueue("Three.", "classic"));
      act(() => result.current.endStream());

      expect(document.querySelectorAll("audio").length).toBe(1); // one persistent element throughout

      const el = document.querySelector("audio")!;
      act(() => el.dispatchEvent(new Event("ended"))); // chunk 1 done
      await waitFor(() => expect(playSpy.mock.calls.length).toBe(playCallsAfterUnlock + 2));

      act(() => el.dispatchEvent(new Event("ended"))); // chunk 2 done
      await waitFor(() => expect(playSpy.mock.calls.length).toBe(playCallsAfterUnlock + 3));

      expect(speakCaddieReplyMock).toHaveBeenNthCalledWith(1, "One.", "classic", expect.anything());
      expect(speakCaddieReplyMock).toHaveBeenNthCalledWith(2, "Two.", "classic", expect.anything());
      expect(speakCaddieReplyMock).toHaveBeenNthCalledWith(3, "Three.", "classic", expect.anything());
    });

    it("onSpeakStart fires exactly once, on chunk 1 — never again for chunks 2/3", async () => {
      speakCaddieReplyMock.mockResolvedValue(makeBlob());
      const onSpeakStart = vi.fn();
      const { result } = renderHook(() => useSheetTTS({ onSpeakStart }));

      act(() => result.current.unlock());
      expect(onSpeakStart).not.toHaveBeenCalled();

      act(() => result.current.beginStream());
      act(() => result.current.enqueue("One.", "classic"));
      await waitFor(() => expect(result.current.isSpeaking).toBe(true));
      expect(onSpeakStart).toHaveBeenCalledTimes(1);

      act(() => result.current.enqueue("Two.", "classic"));
      act(() => result.current.endStream());
      const el = document.querySelector("audio")!;
      act(() => el.dispatchEvent(new Event("ended"))); // chunk 1 -> chunk 2
      await waitFor(() => expect(result.current.isSpeaking).toBe(true));

      expect(onSpeakStart).toHaveBeenCalledTimes(1); // still just once
    });

    it("onPlaybackEnd fires exactly once, only after the LAST chunk's ended — never between chunks", async () => {
      speakCaddieReplyMock.mockResolvedValue(makeBlob());
      const onPlaybackEnd = vi.fn();
      const { result } = renderHook(() => useSheetTTS({ onPlaybackEnd }));

      act(() => result.current.unlock());
      act(() => result.current.beginStream());
      act(() => result.current.enqueue("One.", "classic"));
      await waitFor(() => expect(result.current.isSpeaking).toBe(true));

      act(() => result.current.enqueue("Two.", "classic"));
      act(() => result.current.endStream()); // text is complete, but chunk 1 is still playing

      const el = document.querySelector("audio")!;
      act(() => el.dispatchEvent(new Event("ended"))); // chunk 1 done — chunk 2 still queued
      expect(onPlaybackEnd).not.toHaveBeenCalled(); // must NOT fire between chunks

      await waitFor(() => expect(result.current.isSpeaking).toBe(true)); // chunk 2 now playing
      act(() => el.dispatchEvent(new Event("ended"))); // chunk 2 (the last) done

      expect(onPlaybackEnd).toHaveBeenCalledTimes(1);
    });

    it("onPlaybackEnd waits for endStream() even if the queue drains first (a gap between chunks)", async () => {
      speakCaddieReplyMock.mockResolvedValue(makeBlob());
      const onPlaybackEnd = vi.fn();
      const { result } = renderHook(() => useSheetTTS({ onPlaybackEnd }));

      act(() => result.current.unlock());
      act(() => result.current.beginStream());
      act(() => result.current.enqueue("One.", "classic"));
      await waitFor(() => expect(result.current.isSpeaking).toBe(true));

      const el = document.querySelector("audio")!;
      act(() => el.dispatchEvent(new Event("ended"))); // queue now empty — but stream not marked ended yet
      expect(onPlaybackEnd).not.toHaveBeenCalled();
      expect(result.current.isSpeaking).toBe(false);

      // The rest of the reply arrives late.
      act(() => result.current.enqueue("Two.", "classic"));
      await waitFor(() => expect(result.current.isSpeaking).toBe(true));
      act(() => result.current.endStream());
      act(() => el.dispatchEvent(new Event("ended")));

      expect(onPlaybackEnd).toHaveBeenCalledTimes(1);
    });

    it("stop() mid-queue clears everything and never re-arms (no onPlaybackEnd)", async () => {
      speakCaddieReplyMock.mockResolvedValue(makeBlob());
      const onPlaybackEnd = vi.fn();
      const { result } = renderHook(() => useSheetTTS({ onPlaybackEnd }));

      act(() => result.current.unlock());
      act(() => result.current.beginStream());
      act(() => result.current.enqueue("One.", "classic"));
      await waitFor(() => expect(result.current.isSpeaking).toBe(true));
      act(() => result.current.enqueue("Two.", "classic"));

      act(() => result.current.stop());
      expect(result.current.isSpeaking).toBe(false);

      // A stray 'ended'/'pause' after stop() must not resurrect the turn.
      const el = document.querySelector("audio")!;
      act(() => el.dispatchEvent(new Event("ended")));
      act(() => el.dispatchEvent(new Event("pause")));
      expect(onPlaybackEnd).not.toHaveBeenCalled();

      // endStream() called late (a straggler from the aborted turn) must
      // also stay inert.
      act(() => result.current.endStream());
      expect(onPlaybackEnd).not.toHaveBeenCalled();
    });

    it("a barge-in speak() mid-queue clears the pending queue + aborts in-flight synths — no double-speak, no re-arm", async () => {
      let resolveSecond: (b: Blob) => void = () => {};
      const secondPromise = new Promise<Blob>((resolve) => {
        resolveSecond = resolve;
      });
      speakCaddieReplyMock.mockResolvedValueOnce(makeBlob()); // "One."
      speakCaddieReplyMock.mockImplementationOnce(() => secondPromise); // "Two." — stays pending
      speakCaddieReplyMock.mockResolvedValueOnce(makeBlob()); // the barge-in reply
      const onPlaybackEnd = vi.fn();
      const { result } = renderHook(() => useSheetTTS({ onPlaybackEnd }));

      act(() => result.current.unlock());
      act(() => result.current.beginStream());
      act(() => result.current.enqueue("One.", "classic"));
      await waitFor(() => expect(result.current.isSpeaking).toBe(true));
      act(() => result.current.enqueue("Two.", "classic")); // synth kicked off, stays pending
      await waitFor(() => expect(speakCaddieReplyMock).toHaveBeenCalledTimes(2));
      const secondSignal = speakCaddieReplyMock.mock.calls[1][2] as AbortSignal;
      expect(secondSignal.aborted).toBe(false);

      // Barge-in: a fresh whole-reply speak() interrupts mid-queue.
      act(() => result.current.speak("New question answer.", "classic"));
      expect(secondSignal.aborted).toBe(true); // the pending "Two." synth was aborted

      await waitFor(() => expect(speakCaddieReplyMock).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(result.current.isSpeaking).toBe(true));

      // The stale "Two." resolving late must never play or fire anything.
      resolveSecond(makeBlob());
      await new Promise((r) => setTimeout(r, 0));
      expect(speakCaddieReplyMock).toHaveBeenNthCalledWith(3, "New question answer.", "classic", expect.anything());

      const el = document.querySelector("audio")!;
      act(() => el.dispatchEvent(new Event("ended")));
      expect(onPlaybackEnd).toHaveBeenCalledTimes(1); // fires once, for the NEW (barge-in) turn only
    });

    it("no double-speak: the full text is spoken exactly once across chunks (no drop, no duplicate)", async () => {
      speakCaddieReplyMock.mockResolvedValue(makeBlob());
      const { result } = renderHook(() => useSheetTTS());

      act(() => result.current.unlock());
      act(() => result.current.beginStream());
      act(() => result.current.enqueue("Smooth 7-iron.", "classic"));
      act(() => result.current.enqueue("Aim left of the flag.", "classic"));
      act(() => result.current.endStream());

      await waitFor(() => expect(speakCaddieReplyMock).toHaveBeenCalledTimes(2));
      const spoken = speakCaddieReplyMock.mock.calls.map((c) => c[0]).join(" ");
      expect(spoken).toBe("Smooth 7-iron. Aim left of the flag.");
    });

    // Unified failure rule (post-review fix): ANY chunk failure — synth OR
    // play() — ends the turn immediately, with no re-arm and no further
    // chunks, matching pre-A2 all-or-nothing behavior.
    it("speak(): a synth failure never plays and never fires onPlaybackEnd (no re-arm)", async () => {
      speakCaddieReplyMock.mockRejectedValueOnce(new Error("network"));
      const onPlaybackEnd = vi.fn();
      const { result } = renderHook(() => useSheetTTS({ onPlaybackEnd }));

      act(() => result.current.unlock());
      const playCallsAfterUnlock = playSpy.mock.calls.length;
      act(() => result.current.speak("Nice drive.", "classic"));

      await waitFor(() =>
        expect(voiceEventMock).toHaveBeenCalledWith("sheet-tts", "speak_failed", expect.any(Object)),
      );
      expect(playSpy.mock.calls.length).toBe(playCallsAfterUnlock); // never played at all
      expect(result.current.isSpeaking).toBe(false);

      // A stray 'ended'/'pause' after the failure must not resurrect the turn.
      const el = document.querySelector("audio")!;
      act(() => el.dispatchEvent(new Event("ended")));
      act(() => el.dispatchEvent(new Event("pause")));
      expect(onPlaybackEnd).not.toHaveBeenCalled();
    });

    it("enqueue(): a mid-queue chunk synth failure truncates the queue — a later (already-synthesized) chunk never plays, the earlier chunk finishes naturally, and onPlaybackEnd never fires", async () => {
      let rejectSecond: (e: Error) => void = () => {};
      const secondPromise = new Promise<Blob>((_resolve, reject) => {
        rejectSecond = reject;
      });
      let resolveThird: (b: Blob) => void = () => {};
      const thirdPromise = new Promise<Blob>((resolve) => {
        resolveThird = resolve;
      });
      speakCaddieReplyMock.mockResolvedValueOnce(makeBlob()); // "One."
      speakCaddieReplyMock.mockImplementationOnce(() => secondPromise); // "Two." — fails
      speakCaddieReplyMock.mockImplementationOnce(() => thirdPromise); // "Three." — synths fine, must never play

      const onPlaybackEnd = vi.fn();
      const { result } = renderHook(() => useSheetTTS({ onPlaybackEnd }));

      act(() => result.current.unlock());
      const playCallsAfterUnlock = playSpy.mock.calls.length;
      act(() => result.current.beginStream());
      act(() => result.current.enqueue("One.", "classic"));
      await waitFor(() => expect(playSpy.mock.calls.length).toBe(playCallsAfterUnlock + 1)); // chunk 1 playing

      act(() => result.current.enqueue("Two.", "classic"));
      act(() => result.current.enqueue("Three.", "classic"));
      act(() => result.current.endStream());

      act(() => rejectSecond(new Error("network")));
      await waitFor(() =>
        expect(voiceEventMock).toHaveBeenCalledWith("sheet-tts", "speak_failed", expect.any(Object)),
      );

      // "Three." resolves successfully AFTER the truncation — it must still
      // never play (no skip-the-gap-and-continue).
      act(() => resolveThird(makeBlob()));
      await new Promise((r) => setTimeout(r, 0));

      // Chunk 1 (already playing when the failure happened) finishes
      // naturally — a clean, honest prefix.
      const el = document.querySelector("audio")!;
      act(() => el.dispatchEvent(new Event("ended")));

      expect(playSpy.mock.calls.length).toBe(playCallsAfterUnlock + 1); // still just chunk 1's play()
      expect(onPlaybackEnd).not.toHaveBeenCalled(); // no re-arm despite the honest prefix having played
      expect(result.current.isSpeaking).toBe(false);
    });

    it("enqueue()/speak() are no-ops when the mute pref is off — nothing synthesized, no queue built", () => {
      enabledState.value = false;
      const { result } = renderHook(() => useSheetTTS());

      act(() => result.current.beginStream());
      act(() => result.current.enqueue("One.", "classic"));
      act(() => result.current.endStream());

      expect(speakCaddieReplyMock).not.toHaveBeenCalled();
      expect(result.current.isSpeaking).toBe(false);
    });
  });
});
