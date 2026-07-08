// @vitest-environment jsdom
//
// telemetry.ts (specs/fix-ios-voicetel-flush-dropped-plan.md) — deterministic
// tests for the batch/immediate-flush scheduler + pagehide/visibilitychange
// listeners. Controls the scheduler (fake timers only where explicitly
// noted, always paired with vi.useRealTimers()); the module is imported ONCE
// at top level so its document/window listeners aren't re-registered per
// test (that would make flush counts nondeterministic).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  API_BASE: "http://test.local",
  authHeaders: vi.fn(async () => ({ Authorization: "Bearer test-token" })),
}));

import { authHeaders } from "@/lib/api";
import { voiceEvent, flushVoiceEvents } from "./telemetry";

const FLUSH_AFTER_MS = 8_000;

const authHeadersMock = vi.mocked(authHeaders);

function jsonResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

function parseBody(call: unknown[]): { events: Array<Record<string, unknown>> } {
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe("voice telemetry", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    authHeadersMock.mockReset();
    authHeadersMock.mockImplementation(async () => ({ Authorization: "Bearer test-token" }));
  });

  afterEach(async () => {
    // Drain any queued events with a healthy fetch so state never leaks
    // across tests, then make sure we're back on real timers.
    fetchMock.mockImplementation(async () => jsonResponse());
    await flushVoiceEvents();
    vi.useRealTimers();
  });

  it("1. batch timer flushes non-immediate events (no real 8s wait)", async () => {
    vi.useFakeTimers();
    voiceEvent("dictation", "resolved_live", { ms: 10 });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FLUSH_AFTER_MS);
    vi.useRealTimers();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = parseBody(fetchMock.mock.calls[0]);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ surface: "dictation", event: "resolved_live", ms: 10 });
  });

  it("2. count trigger — 12 non-immediate events flush exactly once with no timer advance", async () => {
    for (let i = 0; i < 12; i++) {
      voiceEvent("dictation", "resolved_live", { ms: i });
    }
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = parseBody(fetchMock.mock.calls[0]);
    expect(body.events).toHaveLength(12);
  });

  it("3. a failure event with flush:true flushes immediately", async () => {
    voiceEvent("dictation", "mic_error", { detail: "NotAllowedError", flush: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = parseBody(fetchMock.mock.calls[0]);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ event: "mic_error", detail: "NotAllowedError" });
  });

  it("4. immediate flush drains the whole queue (ride-alongs), in order", async () => {
    voiceEvent("dictation", "live_start_ok");
    voiceEvent("dictation", "resolved_live", { ms: 5 });
    expect(fetchMock).not.toHaveBeenCalled();
    voiceEvent("dictation", "mic_error", { detail: "boom", flush: true });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = parseBody(fetchMock.mock.calls[0]);
    expect(body.events).toHaveLength(3);
    expect(body.events.map((e) => e.event)).toEqual(["live_start_ok", "resolved_live", "mic_error"]);
  });

  it("5. the flush flag never appears in the POSTed payload", async () => {
    voiceEvent("dictation", "mic_error", { detail: "boom", flush: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = parseBody(fetchMock.mock.calls[0]);
    for (const evt of body.events) {
      expect(Object.keys(evt).every((k) => ["surface", "event", "detail", "ms"].includes(k))).toBe(true);
      expect(evt).not.toHaveProperty("flush");
    }
  });

  it("6. pagehide triggers a flush", async () => {
    voiceEvent("dictation", "resolved_live", { ms: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = parseBody(fetchMock.mock.calls[0]);
    expect(body.events[0]).toMatchObject({ event: "resolved_live" });
  });

  it("7. visibilitychange -> hidden still triggers a flush (existing behavior preserved)", async () => {
    voiceEvent("dictation", "resolved_live", { ms: 2 });
    expect(fetchMock).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("8. authenticated header, content-type, url, and keepalive are preserved on flush", async () => {
    voiceEvent("dictation", "mic_error", { detail: "boom", flush: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith("/api/voice/telemetry")).toBe(true);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init.keepalive).toBe(true);
  });

  it("9. never throws when fetch rejects, and the queue is not wedged afterward", async () => {
    fetchMock.mockRejectedValue(new Error("network"));
    expect(() => voiceEvent("s", "e", { flush: true })).not.toThrow();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Subsequent event with a healthy fetch still flushes.
    fetchMock.mockImplementation(async () => jsonResponse());
    voiceEvent("s", "e2", { flush: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const body = parseBody(fetchMock.mock.calls[1]);
    expect(body.events[0]).toMatchObject({ event: "e2" });
  });

  it("10. never throws when authHeaders rejects, swallowed with no fetch, and module still works after", async () => {
    authHeadersMock.mockRejectedValueOnce(new Error("auth boom"));
    expect(() => voiceEvent("s", "e", { flush: true })).not.toThrow();

    // Give the rejected flush a tick to settle; it must not have called fetch.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();

    // Module still works afterward — a subsequent flush with healthy auth succeeds.
    authHeadersMock.mockImplementation(async () => ({ Authorization: "Bearer test-token" }));
    voiceEvent("s", "e2", { flush: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
