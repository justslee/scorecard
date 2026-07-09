// Unit tests for the SSE caddie-reply streaming reader
// (specs/voice-streaming-replies-plan.md). Drives `streamCaddieReply`
// against a mocked global `fetch` returning a real `ReadableStream` so the
// incremental parse/timeout/abort wiring is the unit under test — no network,
// no DOM (this module has no React dependency).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../api", () => ({
  API_BASE: "http://localhost:8000",
  authHeaders: vi.fn(async () => ({})),
  fetchAPI: vi.fn(),
}));

// api.ts imports this at module scope for sessionRecommend (untouched here);
// stub it so the module loads without pulling in real IndexedDB access.
vi.mock("./hole-intel-cache", () => ({
  saveLastRecommendation: vi.fn(async () => {}),
}));

import { streamCaddieReply, BeforeFirstByteError } from "./api";

const CALM_REPLY_ERROR = "Couldn't reach your caddie — give that another try.";

// ── SSE stream test helpers ─────────────────────────────────────────────────

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface ControllableStream {
  stream: ReadableStream<Uint8Array>;
  push: (text: string) => void;
  close: () => void;
  error: (e: unknown) => void;
}

function makeControllableStream(): ControllableStream {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    stream,
    push: (text: string) => ctrl.enqueue(encoder.encode(text)),
    close: () => ctrl.close(),
    error: (e: unknown) => ctrl.error(e),
  };
}

/** Stub `global.fetch` to resolve with a streaming Response backed by
 *  `state`. Mirrors real fetch: aborting the request signal errors the body
 *  stream (so `reader.read()` rejects), same as a real aborted fetch would. */
function stubStreamingFetch(state: ControllableStream) {
  const fetchMock = vi.fn((_url: string, opts?: RequestInit) => {
    const signal = opts?.signal;
    if (signal) {
      if (signal.aborted) {
        state.error(new DOMException("The operation was aborted.", "AbortError"));
      } else {
        signal.addEventListener("abort", () => {
          state.error(new DOMException("The operation was aborted.", "AbortError"));
        });
      }
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      body: state.stream,
      text: async () => "",
    } as unknown as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Stub `global.fetch` to resolve with a non-streaming (getReader-absent)
 *  Response whose full body text is `raw` — the WKWebView safety-net path. */
function stubBufferedFetch(raw: string, ok = true, status = 200) {
  const fetchMock = vi.fn(() =>
    Promise.resolve({
      ok,
      status,
      body: null,
      text: async () => raw,
    } as unknown as Response),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Attach the rejection/fulfillment handler SYNCHRONOUSLY, right after the
 *  promise is created — before any timer advances or stream pushes that
 *  might settle it — so Node never sees an unhandled rejection in between
 *  (a benign but noisy `PromiseRejectionHandledWarning` otherwise). */
function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("streamCaddieReply — getReader path", () => {
  it("(a) accumulates tokens in order, calls onToken per delta, resolves the full text on done", async () => {
    const s = makeControllableStream();
    stubStreamingFetch(s);
    const onToken = vi.fn();

    const pending = streamCaddieReply(
      "/caddie/session/voice/stream",
      { round_id: "r1", transcript: "hi" },
      { onToken, firstTokenTimeoutMs: 8_000, idleTimeoutMs: 10_000 },
    );

    s.push(sseFrame("token", "Easy "));
    s.push(sseFrame("token", "7-iron."));
    s.push(sseFrame("done", {}));
    s.close();

    await expect(pending).resolves.toBe("Easy 7-iron.");
    expect(onToken).toHaveBeenNthCalledWith(1, "Easy ");
    expect(onToken).toHaveBeenNthCalledWith(2, "7-iron.");
  });

  it("(b) no first token before firstTokenTimeoutMs -> BeforeFirstByteError (fallback-eligible)", async () => {
    const s = makeControllableStream();
    stubStreamingFetch(s);

    const pending = streamCaddieReply(
      "/caddie/voice/stream",
      { transcript: "hi" },
      { onToken: vi.fn(), firstTokenTimeoutMs: 8_000, idleTimeoutMs: 10_000 },
    );
    const outcome = settle(pending);
    await vi.advanceTimersByTimeAsync(8_000);
    const result = await outcome;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(BeforeFirstByteError);
  });

  it("(c) idle timeout AFTER the first token -> terminal calm error, NOT BeforeFirstByteError", async () => {
    const s = makeControllableStream();
    stubStreamingFetch(s);
    const onToken = vi.fn();

    const pending = streamCaddieReply(
      "/caddie/voice/stream",
      { transcript: "hi" },
      { onToken, firstTokenTimeoutMs: 8_000, idleTimeoutMs: 10_000 },
    );
    const outcome = settle(pending);

    s.push(sseFrame("token", "Easy "));
    await vi.waitFor(() => expect(onToken).toHaveBeenCalledTimes(1));

    // Dead air for the full idle window — no second token, no done, no error.
    await vi.advanceTimersByTimeAsync(10_000);

    const result = await outcome;
    expect(result.ok).toBe(false);
    const err = (!result.ok && result.error) as Error;
    expect(err).not.toBeInstanceOf(BeforeFirstByteError);
    expect(err.message).toBe(CALM_REPLY_ERROR);
  });

  it("(c2) a live stream that keeps emitting tokens past idleTimeoutMs does NOT time out (no whole-body timeout)", async () => {
    const s = makeControllableStream();
    stubStreamingFetch(s);
    const onToken = vi.fn();

    const pending = streamCaddieReply(
      "/caddie/voice/stream",
      { transcript: "hi" },
      { onToken, firstTokenTimeoutMs: 8_000, idleTimeoutMs: 10_000 },
    );

    s.push(sseFrame("token", "One "));
    await vi.waitFor(() => expect(onToken).toHaveBeenCalledTimes(1));
    // Advance most of the idle window, then emit again BEFORE it fires — the
    // idle timer resets on every token, so this must never time out.
    await vi.advanceTimersByTimeAsync(9_000);
    s.push(sseFrame("token", "two "));
    await vi.waitFor(() => expect(onToken).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(9_000);
    s.push(sseFrame("token", "three."));
    s.push(sseFrame("done", {}));
    s.close();

    await expect(pending).resolves.toBe("One two three.");
  });

  it("(d) a mid-stream `error` event (after a token) -> terminal calm error, message is the SSE copy, never str(e)", async () => {
    const s = makeControllableStream();
    stubStreamingFetch(s);
    const onToken = vi.fn();
    const SSE_CALM_COPY = "The caddie lost that one — give it another go.";

    const pending = streamCaddieReply(
      "/caddie/voice/stream",
      { transcript: "hi" },
      { onToken, firstTokenTimeoutMs: 8_000, idleTimeoutMs: 10_000 },
    );
    const outcome = settle(pending);

    s.push(sseFrame("token", "Partial "));
    await vi.waitFor(() => expect(onToken).toHaveBeenCalledTimes(1));
    s.push(sseFrame("error", SSE_CALM_COPY));
    s.close();

    const result = await outcome;
    expect(result.ok).toBe(false);
    const err = (!result.ok && result.error) as Error;
    expect(err).not.toBeInstanceOf(BeforeFirstByteError);
    expect(err.message).toBe(SSE_CALM_COPY);
    expect(err.message).not.toMatch(/traceback|exception|Error:/i);
  });

  it("(d2) an `error` event BEFORE any token -> BeforeFirstByteError (fallback-eligible)", async () => {
    const s = makeControllableStream();
    stubStreamingFetch(s);
    const SSE_CALM_COPY = "The caddie lost that one — give it another go.";

    const pending = streamCaddieReply(
      "/caddie/voice/stream",
      { transcript: "hi" },
      { onToken: vi.fn(), firstTokenTimeoutMs: 8_000, idleTimeoutMs: 10_000 },
    );
    const outcome = settle(pending);
    s.push(sseFrame("error", SSE_CALM_COPY));
    s.close();

    const result = await outcome;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(BeforeFirstByteError);
  });

  it("(e) an external signal abort propagates as-is, never normalized to calm, whether pre- or post-token", async () => {
    // Pre-token abort.
    const s1 = makeControllableStream();
    stubStreamingFetch(s1);
    const external1 = new AbortController();
    const pending1 = streamCaddieReply(
      "/caddie/voice/stream",
      { transcript: "hi" },
      { onToken: vi.fn(), firstTokenTimeoutMs: 8_000, idleTimeoutMs: 10_000, signal: external1.signal },
    );
    const outcome1 = settle(pending1);
    external1.abort(new Error("caller cancelled"));
    const result1 = await outcome1;
    expect(result1.ok).toBe(false);
    const err1 = (!result1.ok && result1.error) as Error;
    expect(err1).not.toBeInstanceOf(BeforeFirstByteError);
    expect(err1.message).not.toBe(CALM_REPLY_ERROR);

    // Post-token abort (sheet closed / new question while text is on screen).
    const s2 = makeControllableStream();
    stubStreamingFetch(s2);
    const onToken2 = vi.fn();
    const external2 = new AbortController();
    const pending2 = streamCaddieReply(
      "/caddie/voice/stream",
      { transcript: "hi" },
      { onToken: onToken2, firstTokenTimeoutMs: 8_000, idleTimeoutMs: 10_000, signal: external2.signal },
    );
    const outcome2 = settle(pending2);
    s2.push(sseFrame("token", "Easy "));
    await vi.waitFor(() => expect(onToken2).toHaveBeenCalledTimes(1));
    external2.abort(new Error("caller cancelled"));
    const result2 = await outcome2;
    expect(result2.ok).toBe(false);
    const err2 = (!result2.ok && result2.error) as Error;
    expect(err2).not.toBeInstanceOf(BeforeFirstByteError);
    expect(err2.message).not.toBe(CALM_REPLY_ERROR);
  });

  it("(f2) a `status` keepalive frame re-arms the first-token watchdog and invokes onStatus — a tool turn longer than firstTokenTimeoutMs still succeeds", async () => {
    const s = makeControllableStream();
    stubStreamingFetch(s);
    const onToken = vi.fn();
    const onStatus = vi.fn();

    const pending = streamCaddieReply(
      "/caddie/session/voice/stream",
      { round_id: "r1", transcript: "what carries the left bunker?" },
      { onToken, onStatus, firstTokenTimeoutMs: 8_000, idleTimeoutMs: 10_000 },
    );

    // 6s in: no token yet, but the server signals a tool round is running.
    await vi.advanceTimersByTimeAsync(6_000);
    s.push(sseFrame("status", "checking the numbers"));
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("checking the numbers"));

    // Another 6s of silence — 12s total, past the original 8s deadline, but
    // the status frame re-armed the watchdog so the stream must still be live.
    await vi.advanceTimersByTimeAsync(6_000);
    s.push(sseFrame("token", "245 carries it."));
    s.push(sseFrame("done", {}));
    s.close();

    await expect(pending).resolves.toBe("245 carries it.");
    expect(onToken).toHaveBeenCalledWith("245 carries it.");
  });

  it("(f3) a `status` frame AFTER the first token re-arms the idle watchdog", async () => {
    const s = makeControllableStream();
    stubStreamingFetch(s);
    const onToken = vi.fn();
    const onStatus = vi.fn();

    const pending = streamCaddieReply(
      "/caddie/session/voice/stream",
      { round_id: "r1", transcript: "hi" },
      { onToken, onStatus, firstTokenTimeoutMs: 8_000, idleTimeoutMs: 10_000 },
    );

    s.push(sseFrame("token", "Let me check. "));
    await vi.waitFor(() => expect(onToken).toHaveBeenCalledTimes(1));

    // 9s of dead air, then a status frame (tool round) resets the idle timer;
    // another 9s later the reply lands — 18s of no tokens total, no timeout.
    await vi.advanceTimersByTimeAsync(9_000);
    s.push(sseFrame("status", "checking the numbers"));
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(9_000);
    s.push(sseFrame("token", "It's 245."));
    s.push(sseFrame("done", {}));
    s.close();

    await expect(pending).resolves.toBe("Let me check. It's 245.");
  });

  it("(f) a non-2xx response is pre-first-token -> BeforeFirstByteError", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        body: null,
        text: async () => "Internal Server Error",
      } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = streamCaddieReply(
      "/caddie/voice/stream",
      { transcript: "hi" },
      { onToken: vi.fn(), firstTokenTimeoutMs: 8_000, idleTimeoutMs: 10_000 },
    );
    const result = await settle(pending);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(BeforeFirstByteError);
  });
});

describe("streamCaddieReply — getReader-absent fallback (WKWebView safety net)", () => {
  it("(g) reads the full buffered body and resolves with the completed reply — onToken never called (non-progressive)", async () => {
    const raw = sseFrame("token", "Take the ") + sseFrame("token", "8-iron.") + sseFrame("done", {});
    stubBufferedFetch(raw);
    const onToken = vi.fn();

    const result = await streamCaddieReply(
      "/caddie/voice/stream",
      { transcript: "hi" },
      { onToken, firstTokenTimeoutMs: 8_000, idleTimeoutMs: 10_000 },
    );

    expect(result).toBe("Take the 8-iron.");
    expect(onToken).not.toHaveBeenCalled();
  });

  it("(h) buffered fallback with a mid-stream error frame after tokens -> terminal calm error", async () => {
    const SSE_CALM_COPY = "The caddie lost that one — give it another go.";
    const raw = sseFrame("token", "Partial ") + sseFrame("error", SSE_CALM_COPY);
    stubBufferedFetch(raw);

    const pending = streamCaddieReply(
      "/caddie/voice/stream",
      { transcript: "hi" },
      { onToken: vi.fn(), firstTokenTimeoutMs: 8_000, idleTimeoutMs: 10_000 },
    );
    const result = await settle(pending);
    expect(result.ok).toBe(false);
    const err = (!result.ok && result.error) as Error;
    expect(err).not.toBeInstanceOf(BeforeFirstByteError);
    expect(err.message).toBe(SSE_CALM_COPY);
  });
});
