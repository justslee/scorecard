// rAF-coalesced token buffer for progressive SSE rendering
// (specs/voice-streaming-replies-plan.md §4.3 — NORTHSTAR: calm, not jittery).
//
// Anthropic deltas arrive in uneven bursts; appending each raw delta straight
// to React state stutters and thrashes re-renders. This coalesces bursts into
// ~1 flush per animation frame (~60fps ceiling) — a smooth, even fill rather
// than per-token flicker, with no re-render storm.
//
// Falls back to a ~16ms timer when requestAnimationFrame isn't available
// (jsdom/vitest has no rAF; also a defensive net for any WKWebView build
// missing it) — same coalescing behavior, just timer-driven.

import { useCallback, useEffect, useRef } from "react";

// Deliberately scoped to `window.requestAnimationFrame` rather than the bare
// global identifier: `vi.useFakeTimers()` (Sinon under the hood) can install
// a `requestAnimationFrame` polyfill onto `globalThis` in a plain Node test
// environment (no `window` at all) that outlives `vi.useRealTimers()` within
// the same worker process — a bare-identifier check would pick up that dead
// stub in an unrelated jsdom test file and silently never fire. `window`'s
// OWN property is real jsdom state, immune to a different file's Node-global patch.
function scheduleFrame(cb: () => void): number {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(cb);
  }
  return (typeof window !== "undefined" ? window : globalThis).setTimeout(cb, 16) as unknown as number;
}

function cancelFrame(id: number): void {
  if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(id);
  } else {
    clearTimeout(id);
  }
}

export interface StreamBuffer {
  /** Append a delta; schedules a coalesced flush if one isn't already pending. */
  push: (delta: string) => void;
  /** Flush any pending buffer synchronously — call once on `done` for a final,
   *  immediate paint before the caller sets the authoritative full text. */
  flush: () => void;
  /** Drop any pending (unflushed) buffer and cancel a scheduled flush, without
   *  calling onFlush — sheet close / abort / a new question superseding this one. */
  cancel: () => void;
}

/** onFlush is called with the coalesced chunk accumulated since the last flush. */
export function useStreamBuffer(onFlush: (chunk: string) => void): StreamBuffer {
  const pendingRef = useRef("");
  const frameRef = useRef<number | null>(null);
  // Ref-mirrored so push/flush/cancel stay referentially stable across
  // renders regardless of the caller's onFlush identity. Written in an
  // effect (never during render) — push()/flush() are only ever invoked from
  // async event handlers, never synchronously mid-render, so the one-tick
  // commit delay is safe.
  const onFlushRef = useRef(onFlush);
  useEffect(() => {
    onFlushRef.current = onFlush;
  }, [onFlush]);

  const flush = useCallback(() => {
    if (frameRef.current != null) {
      cancelFrame(frameRef.current);
      frameRef.current = null;
    }
    if (!pendingRef.current) return;
    const chunk = pendingRef.current;
    pendingRef.current = "";
    onFlushRef.current(chunk);
  }, []);

  const push = useCallback(
    (delta: string) => {
      pendingRef.current += delta;
      if (frameRef.current == null) {
        frameRef.current = scheduleFrame(() => {
          frameRef.current = null;
          flush();
        });
      }
    },
    [flush],
  );

  const cancel = useCallback(() => {
    if (frameRef.current != null) {
      cancelFrame(frameRef.current);
      frameRef.current = null;
    }
    pendingRef.current = "";
  }, []);

  return { push, flush, cancel };
}
