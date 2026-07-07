import { describe, it, expect } from "vitest";
import { pickDictationTranscript, isEmptyTranscript } from "./dictation";

describe("pickDictationTranscript", () => {
  it("uses the live transcript when present and live did not fail", () => {
    expect(pickDictationTranscript("what club from 150", false)).toEqual({
      source: "live",
      transcript: "what club from 150",
    });
  });

  it("trims the live snapshot", () => {
    expect(pickDictationTranscript("  carry the bunker?  ", false).transcript).toBe(
      "carry the bunker?"
    );
  });

  it("falls back when the live path errored mid-utterance, even with partial text", () => {
    expect(pickDictationTranscript("what club", true).source).toBe("fallback");
  });

  it("falls back when live produced nothing (silence / unsupported)", () => {
    expect(pickDictationTranscript("", false).source).toBe("fallback");
    expect(pickDictationTranscript("   ", false).source).toBe("fallback");
  });
});

describe("isEmptyTranscript", () => {
  it("detects empty and whitespace-only transcripts", () => {
    expect(isEmptyTranscript("")).toBe(true);
    expect(isEmptyTranscript("   ")).toBe(true);
    expect(isEmptyTranscript("driver")).toBe(false);
  });
});
