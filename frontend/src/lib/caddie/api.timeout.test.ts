// Unit tests for the voice-reply timeout/retry helper (specs/voice-reply-timeouts-plan.md,
// specs/voice-agent-audit.md #7). The module-level `fetchAPI` (from ../api) is mocked so the
// helper's timeout/retry/abort wiring is the unit under test — the fake respects the passed
// `signal` to simulate a real hang, same way the real fetch-based client would.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../api", () => ({
  API_BASE: "http://localhost:8000",
  authHeaders: vi.fn(async () => ({})),
  fetchAPI: vi.fn(),
}));

// api.ts imports this at module scope for sessionRecommend (untouched here); stub it so the
// module loads without pulling in real IndexedDB access.
vi.mock("./hole-intel-cache", () => ({
  saveLastRecommendation: vi.fn(async () => {}),
}));

import { fetchAPI } from "../api";
import { postWithTimeout, speakCaddieReply } from "./api";
import { humanizeVoiceError } from "./dictation";

const fetchAPIMock = vi.mocked(fetchAPI);
const CALM = "Couldn't reach your caddie — give that another try.";

/** A fetchAPI stand-in that hangs until its signal aborts, then rejects like a real fetch
 *  abort would (AbortError DOMException) — models the "genuine hang" case. */
function hangingFetchAPI() {
  return (_path: string, opts?: RequestInit) =>
    new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchAPIMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("postWithTimeout", () => {
  it("(a) resolves normally and leaves no open timer", async () => {
    fetchAPIMock.mockResolvedValueOnce({ response: "hi" });
    const result = await postWithTimeout("/caddie/voice", { transcript: "hi" }, { timeoutMs: 10_000 });
    expect(result).toEqual({ response: "hi" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("(b) times out into the calm error, never leaking AbortError/signal-aborted", async () => {
    fetchAPIMock.mockImplementationOnce(hangingFetchAPI());
    const pending = postWithTimeout("/caddie/voice", {}, { timeoutMs: 10_000 });
    const assertion = expect(pending).rejects.toThrow(CALM);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    const err = (await pending.catch((e: unknown) => e)) as Error;
    expect(err.message).not.toMatch(/AbortError|signal is aborted/i);
  });

  it("(c) retries once on a transient TypeError, then succeeds", async () => {
    fetchAPIMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ response: "hi" });
    const pending = postWithTimeout(
      "/caddie/voice",
      {},
      { timeoutMs: 10_000, retries: 1, backoffMs: 500 },
    );
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toEqual({ response: "hi" });
    expect(fetchAPIMock).toHaveBeenCalledTimes(2);
  });

  it("(d) does NOT retry on an HTTP error — rethrows verbatim", async () => {
    fetchAPIMock.mockRejectedValueOnce(new Error("API error: 500"));
    await expect(
      postWithTimeout("/caddie/voice", {}, { timeoutMs: 10_000, retries: 1 }),
    ).rejects.toThrow("API error: 500");
    expect(fetchAPIMock).toHaveBeenCalledTimes(1);
  });

  it("(e) clears its timer on both the success and HTTP-error paths (no open handles)", async () => {
    fetchAPIMock.mockResolvedValueOnce({ response: "hi" });
    await postWithTimeout("/caddie/voice", {}, { timeoutMs: 10_000 });
    expect(vi.getTimerCount()).toBe(0);

    fetchAPIMock.mockRejectedValueOnce(new Error("API error: 500"));
    await expect(
      postWithTimeout("/caddie/voice", {}, { timeoutMs: 10_000, retries: 1 }),
    ).rejects.toThrow("API error: 500");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("(f) propagates an external caller abort as-is (composition), never CALM, never retried", async () => {
    fetchAPIMock.mockImplementationOnce(hangingFetchAPI());
    const external = new AbortController();
    const pending = postWithTimeout(
      "/caddie/voice",
      {},
      { timeoutMs: 10_000, retries: 1, signal: external.signal },
    );
    external.abort(new Error("caller cancelled"));
    const err = (await pending.catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(DOMException);
    expect(err.message).not.toBe(CALM);
    expect(fetchAPIMock).toHaveBeenCalledTimes(1);
  });

  it("(g) invariant guard: the calm string survives humanizeVoiceError unchanged", () => {
    expect(humanizeVoiceError(CALM, "fallback")).toBe(CALM);
  });
});

describe("speakCaddieReply", () => {
  it("(h) times out at SPEAK_TIMEOUT_MS and clears its timer", async () => {
    const fetchMock = vi.fn((_url: string, opts?: RequestInit) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = speakCaddieReply("hello there", "classic");
    const assertion = expect(pending).rejects.toBeInstanceOf(DOMException);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("(h) composing an already-aborted external signal aborts immediately", async () => {
    const fetchMock = vi.fn((_url: string, opts?: RequestInit) =>
      new Promise((_resolve, reject) => {
        if (opts?.signal?.aborted) {
          reject(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        opts?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const external = new AbortController();
    external.abort();
    await expect(speakCaddieReply("hello there", "classic", external.signal)).rejects.toBeInstanceOf(
      DOMException,
    );
  });
});
