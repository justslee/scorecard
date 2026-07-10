/**
 * Unit tests for the caller-voice client functions — thin wrappers around
 * GET/PUT /api/tee-times/caller-voice (Option B picker, no voice cloning;
 * specs/voice-clone-caller-plan.md §2B/§3).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api", () => ({
  fetchAPI: vi.fn(),
  API_BASE: "http://test.local",
  authHeaders: vi.fn(async () => ({})),
}));

import { getCallerVoice, setCallerVoice } from "./client";
import { fetchAPI } from "@/lib/api";

const mockFetchAPI = vi.mocked(fetchAPI);

beforeEach(() => {
  mockFetchAPI.mockReset();
});

describe("getCallerVoice", () => {
  it("GETs /api/tee-times/caller-voice and returns the response as-is", async () => {
    const response = {
      voice: "cedar",
      saved: null,
      options: [{ voice: "cedar", label: "Cedar — natural, conversational (recommended)" }],
    };
    mockFetchAPI.mockResolvedValue(response);

    const out = await getCallerVoice();

    expect(mockFetchAPI).toHaveBeenCalledWith("/api/tee-times/caller-voice");
    expect(out).toEqual(response);
  });
});

describe("setCallerVoice", () => {
  it("PUTs the chosen voice as JSON and returns the response", async () => {
    const response = { voice: "marin", saved: "marin", options: [] };
    mockFetchAPI.mockResolvedValue(response);

    const out = await setCallerVoice("marin");

    expect(mockFetchAPI).toHaveBeenCalledWith("/api/tee-times/caller-voice", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice: "marin" }),
    });
    expect(out).toEqual(response);
  });

  it("propagates a rejection (e.g. 422 from an invalid voice) instead of swallowing it", async () => {
    mockFetchAPI.mockRejectedValue(new Error("422: Unknown voice"));

    await expect(setCallerVoice("not-a-real-voice")).rejects.toThrow("422");
  });
});
