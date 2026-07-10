import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  SpeakerGate,
  DEFAULT_SPEAKER_GATE,
} from "./speaker-gate";

describe("cosineSimilarity", () => {
  it("is 1 for identical direction (scale-invariant)", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("is -1 for opposite direction", () => {
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1);
  });

  it("returns 0 (not NaN) for a zero-magnitude vector", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("throws on length mismatch", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/length mismatch/);
  });
});

describe("SpeakerGate", () => {
  // A reference "voiceprint"; near-parallel vectors = the owner, divergent = others.
  const reference = [1, 0, 0, 0];
  const owner = [0.98, 0.1, 0.05, 0.05]; // ~0.99 cosine
  const partner = [0, 1, 0, 0]; // ~0 cosine

  it("opens when the enrolled speaker is present", () => {
    const gate = new SpeakerGate({ reference });
    const d = gate.accept(owner);
    expect(d.open).toBe(true);
    expect(d.similarity).toBeGreaterThan(DEFAULT_SPEAKER_GATE.openAt);
  });

  it("stays closed for a different speaker", () => {
    const gate = new SpeakerGate({ reference });
    const d = gate.accept(partner);
    expect(d.open).toBe(false);
    expect(d.similarity).toBeLessThan(DEFAULT_SPEAKER_GATE.closeAt);
  });

  it("hysteresis: a mid-utterance dip between closeAt and openAt keeps it open", () => {
    const gate = new SpeakerGate({ reference, openAt: 0.7, closeAt: 0.4 });
    // Clearly the owner → opens.
    expect(gate.accept([1, 0, 0, 0]).open).toBe(true);
    // A window at ~0.5 cosine (below openAt, above closeAt): must NOT close.
    const dip = [1, 1, 0, 0]; // cosine = 1/sqrt(2) ≈ 0.707 ... make it lower:
    // Use a vector at ~0.5 cosine to the reference [1,0,0,0]:
    const midDip = [0.5, 0.866, 0, 0]; // cosine ≈ 0.5
    expect(cosineSimilarity(midDip, reference)).toBeCloseTo(0.5, 1);
    void dip;
    expect(gate.accept(midDip).open).toBe(true); // hysteresis holds it open
  });

  it("hysteresis: closes only when similarity drops below closeAt", () => {
    const gate = new SpeakerGate({ reference, openAt: 0.7, closeAt: 0.4 });
    expect(gate.accept([1, 0, 0, 0]).open).toBe(true);
    expect(gate.accept([0, 1, 0, 0]).open).toBe(false); // cosine 0 < closeAt
  });

  it("hysteresis: a borderline first window (between thresholds) does NOT open", () => {
    const gate = new SpeakerGate({ reference, openAt: 0.7, closeAt: 0.4 });
    const midDip = [0.5, 0.866, 0, 0]; // ≈0.5, below openAt
    expect(gate.accept(midDip).open).toBe(false);
  });

  it("reset() forces the gate closed", () => {
    const gate = new SpeakerGate({ reference });
    gate.accept(owner);
    expect(gate.open).toBe(true);
    gate.reset();
    expect(gate.open).toBe(false);
  });

  it("rejects an empty reference embedding", () => {
    expect(() => new SpeakerGate({ reference: [] })).toThrow(/empty/);
  });

  it("rejects closeAt above openAt", () => {
    expect(() => new SpeakerGate({ reference, openAt: 0.4, closeAt: 0.7 })).toThrow(
      /closeAt/,
    );
  });
});
