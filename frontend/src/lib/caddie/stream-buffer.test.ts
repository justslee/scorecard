// @vitest-environment jsdom
//
// useStreamBuffer (specs/voice-streaming-replies-plan.md §4.3) — the
// rAF-coalesced token buffer CaddieSheet/LooperSheet render streaming
// replies through. Isolated here with fake timers so the coalescing
// behavior itself is deterministic; CaddieSheet.session.test.tsx mocks this
// module entirely (a synchronous stand-in) so the ladder/CTA-gating tests
// never depend on a real scheduler tick — see that file's header comment
// for why (a cross-file real-timer race under full-suite parallel load).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStreamBuffer } from "./stream-buffer";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Drain any timers this test forgot to flush before swapping back —
  // real timers must never be left holding a fake-clock reference (the
  // exact cross-file leak class that bit CaddieSheet.session.test.tsx).
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("useStreamBuffer", () => {
  it("coalesces multiple synchronous pushes into ONE flush", () => {
    const onFlush = vi.fn();
    const { result } = renderHook(() => useStreamBuffer(onFlush));

    act(() => {
      result.current.push("a");
      result.current.push("b");
      result.current.push("c");
    });
    expect(onFlush).not.toHaveBeenCalled(); // not yet — still waiting on the scheduled frame

    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith("abc");
  });

  it("flush() delivers the pending buffer synchronously and cancels the scheduled frame", () => {
    const onFlush = vi.fn();
    const { result } = renderHook(() => useStreamBuffer(onFlush));

    act(() => {
      result.current.push("x");
    });
    act(() => {
      result.current.flush();
    });
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith("x");

    // The scheduled frame was cancelled by flush() — advancing timers must
    // not deliver a second, empty flush.
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("flush() with nothing pending is a no-op", () => {
    const onFlush = vi.fn();
    const { result } = renderHook(() => useStreamBuffer(onFlush));

    act(() => {
      result.current.flush();
    });
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("cancel() drops the pending buffer without ever calling onFlush", () => {
    const onFlush = vi.fn();
    const { result } = renderHook(() => useStreamBuffer(onFlush));

    act(() => {
      result.current.push("dropped");
      result.current.cancel();
    });
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("a push AFTER a flush schedules a fresh frame (buffer isn't stuck 'done')", () => {
    const onFlush = vi.fn();
    const { result } = renderHook(() => useStreamBuffer(onFlush));

    act(() => {
      result.current.push("first");
    });
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(onFlush).toHaveBeenNthCalledWith(1, "first");

    act(() => {
      result.current.push("second");
    });
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(onFlush).toHaveBeenNthCalledWith(2, "second");
    expect(onFlush).toHaveBeenCalledTimes(2);
  });

  it("onFlush identity changes across renders don't lose in-flight pushes (ref-mirrored, effect-committed)", () => {
    const onFlushA = vi.fn();
    const onFlushB = vi.fn();
    const { result, rerender } = renderHook(({ onFlush }) => useStreamBuffer(onFlush), {
      initialProps: { onFlush: onFlushA },
    });

    act(() => {
      result.current.push("a");
    });
    rerender({ onFlush: onFlushB });
    act(() => {
      vi.runOnlyPendingTimers();
    });

    // Whichever callback identity was current at flush time received it —
    // the important invariant is exactly one of them got called exactly once.
    const totalCalls = onFlushA.mock.calls.length + onFlushB.mock.calls.length;
    expect(totalCalls).toBe(1);
  });
});
