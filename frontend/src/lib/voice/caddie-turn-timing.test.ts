// caddie-turn-timing (specs/caddie-realtime-telemetry-plan.md §5) — pure,
// deterministic: a scripted `now()` and injected `emit`/`flush` spies, no
// sockets, no getUserMedia, no real clock.

import { describe, it, expect, vi } from "vitest";
import { createCaddieTurnTimer } from "./caddie-turn-timing";

/** Pops the next scripted timestamp on each call — throws if exhausted (a
 *  test bug, not a swallowed telemetry failure). */
function scriptedNow(values: number[]): () => number {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error("scriptedNow exhausted");
    return values[i++];
  };
}

describe("createCaddieTurnTimer", () => {
  it("full classic turn — emits exactly four legs with the exact ms", () => {
    const emit = vi.fn();
    const flush = vi.fn();
    const timer = createCaddieTurnTimer({
      surface: "caddie-turn",
      now: scriptedNow([0, 120, 700, 1400]),
      emit,
      flush,
    });

    timer.markEos(); // t=0
    timer.markTranscript(); // t=120
    timer.markFirstToken(); // t=700
    timer.markFirstAudio(); // t=1400

    expect(emit).toHaveBeenCalledTimes(4);
    expect(emit).toHaveBeenNthCalledWith(1, "caddie-turn", "caddie.eos_to_transcript", { ms: 120 });
    expect(emit).toHaveBeenNthCalledWith(2, "caddie-turn", "caddie.transcript_to_first_token", { ms: 580 });
    expect(emit).toHaveBeenNthCalledWith(3, "caddie-turn", "caddie.first_token_to_first_audio", { ms: 700 });
    expect(emit).toHaveBeenNthCalledWith(4, "caddie-turn", "caddie.eos_to_first_audio", { ms: 1400 });
  });

  it("immediate flush — not called on the first three marks; called exactly once right after the headline emit", () => {
    const calls: string[] = [];
    const emit = vi.fn((_surface: string, event: string) => {
      calls.push(`emit:${event}`);
    });
    const flush = vi.fn(() => {
      calls.push("flush");
    });
    const timer = createCaddieTurnTimer({
      surface: "caddie-turn",
      now: scriptedNow([0, 120, 700, 1400]),
      emit,
      flush,
    });

    timer.markEos();
    expect(flush).not.toHaveBeenCalled();
    timer.markTranscript();
    expect(flush).not.toHaveBeenCalled();
    timer.markFirstToken();
    expect(flush).not.toHaveBeenCalled();

    timer.markFirstAudio();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(calls[calls.length - 1]).toBe("flush");
    expect(calls[calls.length - 2]).toBe("emit:caddie.eos_to_first_audio");
  });

  it("realtime two-mark turn — emits ONLY the headline + one flush, no text legs", () => {
    const emit = vi.fn();
    const flush = vi.fn();
    const timer = createCaddieTurnTimer({
      surface: "caddie-rt",
      now: scriptedNow([0, 1800]),
      emit,
      flush,
    });

    timer.markEos();
    timer.markFirstAudio();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("caddie-rt", "caddie.eos_to_first_audio", { ms: 1800 });
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("incomplete turn — markEos + markTranscript only emits just eos_to_transcript, no headline, no flush", () => {
    const emit = vi.fn();
    const flush = vi.fn();
    const timer = createCaddieTurnTimer({
      surface: "caddie-turn",
      now: scriptedNow([0, 200]),
      emit,
      flush,
    });

    timer.markEos();
    timer.markTranscript();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("caddie-turn", "caddie.eos_to_transcript", { ms: 200 });
    expect(flush).not.toHaveBeenCalled();
  });

  it("reset per turn — two markEos cycles don't cross-contaminate", () => {
    const emit = vi.fn();
    const flush = vi.fn();
    const timer = createCaddieTurnTimer({
      surface: "caddie-turn",
      // Turn 1: eos@0, transcript@100, firstToken@300, firstAudio@600
      // Turn 2: eos@5000, transcript@5050, firstToken@5150, firstAudio@5400
      now: scriptedNow([0, 100, 300, 600, 5000, 5050, 5150, 5400]),
      emit,
      flush,
    });

    timer.markEos();
    timer.markTranscript();
    timer.markFirstToken();
    timer.markFirstAudio();
    expect(emit).toHaveBeenCalledTimes(4);
    emit.mockClear();
    flush.mockClear();

    timer.markEos();
    timer.markTranscript();
    timer.markFirstToken();
    timer.markFirstAudio();

    expect(emit).toHaveBeenCalledTimes(4);
    expect(emit).toHaveBeenNthCalledWith(1, "caddie-turn", "caddie.eos_to_transcript", { ms: 50 });
    expect(emit).toHaveBeenNthCalledWith(2, "caddie-turn", "caddie.transcript_to_first_token", { ms: 100 });
    expect(emit).toHaveBeenNthCalledWith(3, "caddie-turn", "caddie.first_token_to_first_audio", { ms: 250 });
    expect(emit).toHaveBeenNthCalledWith(4, "caddie-turn", "caddie.eos_to_first_audio", { ms: 400 });
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("sanity clamp — a non-positive leg emits nothing", () => {
    const emit = vi.fn();
    const flush = vi.fn();
    const timer = createCaddieTurnTimer({
      surface: "caddie-turn",
      now: scriptedNow([100, 100]), // eos and transcript at the exact same instant -> ms=0
      emit,
      flush,
    });

    timer.markEos();
    timer.markTranscript();

    expect(emit).not.toHaveBeenCalled();
  });

  it("sanity clamp — a leg over 60000ms emits nothing", () => {
    const emit = vi.fn();
    const flush = vi.fn();
    const timer = createCaddieTurnTimer({
      surface: "caddie-turn",
      now: scriptedNow([0, 70_000]),
      emit,
      flush,
    });

    timer.markEos();
    timer.markTranscript();

    expect(emit).not.toHaveBeenCalled();
  });

  it("failure isolation — a throwing emit/flush never throws, and subsequent marks still work", () => {
    const emit = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("emit boom");
      })
      .mockImplementationOnce(() => {
        throw new Error("emit boom 2");
      });
    const flush = vi.fn(() => {
      throw new Error("flush boom");
    });
    const timer = createCaddieTurnTimer({
      surface: "caddie-turn",
      now: scriptedNow([0, 120, 700, 1400]),
      emit,
      flush,
    });

    expect(() => timer.markEos()).not.toThrow();
    expect(() => timer.markTranscript()).not.toThrow(); // emit throws here — swallowed
    expect(() => timer.markFirstToken()).not.toThrow(); // emit throws here too — swallowed
    expect(() => timer.markFirstAudio()).not.toThrow(); // emit + flush throw — swallowed

    // Telemetry failing this turn must not wedge the timer for the next one.
    const emit2 = vi.fn();
    const flush2 = vi.fn();
    const timer2 = createCaddieTurnTimer({
      surface: "caddie-turn",
      now: scriptedNow([2000, 2100]),
      emit: emit2,
      flush: flush2,
    });
    expect(() => timer2.markEos()).not.toThrow();
    expect(() => timer2.markTranscript()).not.toThrow();
    expect(emit2).toHaveBeenCalledWith("caddie-turn", "caddie.eos_to_transcript", { ms: 100 });
  });
});
