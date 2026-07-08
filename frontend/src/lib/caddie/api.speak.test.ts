// Unit tests for speakCaddieReply's platform branch (specs/fix-ios-tts-playback-plan.md
// Part A) — the fetch bypass / explicit-type Blob reconstruction that fixes the
// iOS `NotSupportedError`. This can't live in useSheetTTS.test.ts, which mocks
// speakCaddieReply wholesale.

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

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
  },
  CapacitorHttp: {
    request: vi.fn(),
  },
}));

import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { speakCaddieReply } from "./api";

const isNativePlatformMock = vi.mocked(Capacitor.isNativePlatform);
const capacitorHttpRequestMock = vi.mocked(CapacitorHttp.request);

afterEach(() => {
  vi.unstubAllGlobals();
  isNativePlatformMock.mockReset().mockReturnValue(false);
  capacitorHttpRequestMock.mockReset();
});

beforeEach(() => {
  isNativePlatformMock.mockReturnValue(false);
});

describe("speakCaddieReply — web path", () => {
  it("always re-types the body as audio/mpeg, even from an untyped/empty-type response", async () => {
    const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04]); // fake mp3-ish bytes
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const blob = await speakCaddieReply("hello there", "classic");

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("audio/mpeg");
    expect(blob.size).toBe(bytes.byteLength);
    expect(capacitorHttpRequestMock).not.toHaveBeenCalled();
  });

  it("rejects on a non-2xx response and never returns a blob", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 502,
      text: async () => "bad gateway",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(speakCaddieReply("hello there", "classic")).rejects.toThrow(/Speak failed \(502\)/);
  });
});

describe("speakCaddieReply — native path", () => {
  beforeEach(() => {
    isNativePlatformMock.mockReturnValue(true);
  });

  it("bypasses fetch and reconstructs a typed Blob from CapacitorHttp's base64 response", async () => {
    const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0xff]);
    const base64 = Buffer.from(bytes).toString("base64");
    capacitorHttpRequestMock.mockResolvedValue({ status: 200, data: base64, headers: {}, url: "" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const blob = await speakCaddieReply("hello there", "classic");

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("audio/mpeg");
    expect(blob.size).toBe(bytes.byteLength);
    expect(fetchMock).not.toHaveBeenCalled();

    expect(capacitorHttpRequestMock).toHaveBeenCalledTimes(1);
    const call = capacitorHttpRequestMock.mock.calls[0][0];
    expect(call.method).toBe("POST");
    expect(call.responseType).toBe("blob");
    expect(call.data).toEqual({ text: "hello there", personality_id: "classic" });
  });

  it("rejects on a non-2xx status and produces no blob", async () => {
    capacitorHttpRequestMock.mockResolvedValue({
      status: 502,
      data: "c29tZSBlcnJvcg==",
      headers: {},
      url: "",
    });

    await expect(speakCaddieReply("hello there", "classic")).rejects.toThrow(/Speak failed \(502\)/);
  });
});
