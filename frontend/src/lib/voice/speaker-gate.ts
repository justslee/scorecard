/**
 * SpeakerGate — the pure decision core of a Target-Speaker VAD (TSVAD) gate
 * (specs/voice-target-speaker-spike-plan.md, Tier-2).
 *
 * SPIKE SCOPE: this is the ONLY piece of the target-speaker feature that is
 * pure, deterministic, and unit-testable WITHOUT a model dependency. It is NOT
 * wired into the live voice path — the shipped mic-to-caddie flow is unchanged.
 * It exists so the gate policy (cosine-similarity threshold + hysteresis) can be
 * proven and reviewed before we commit to bundling an on-device speaker-embedding
 * model (see the spike report for the model/latency/cost assessment).
 *
 * The real feature would, per audio frame window (~0.5-1s):
 *   1. run a VAD front-end (is anyone speaking at all?),
 *   2. if yes, extract a speaker embedding for that window with a small
 *      pretrained model (on-device),
 *   3. feed the embedding here; `accept()` decides whether it's the ENROLLED
 *      owner (open the mic to the caddie) or someone else (hold).
 *
 * Enrollment produces the reference embedding once (~5-10s of the owner's
 * speech, averaged/L2-normalised) and stores it on-device; it never leaves the
 * phone. This module is agnostic to how the embedding was produced.
 *
 * Everything here is synchronous, dependency-free, and side-effect-free.
 */

/**
 * Cosine similarity of two equal-length vectors, in [-1, 1] (1 = identical
 * direction). Speaker embeddings are compared by direction, so this — not
 * Euclidean distance — is the standard verification metric.
 *
 * Returns 0 for a zero-magnitude vector (undefined direction) rather than NaN,
 * so a silent/degenerate window can never spuriously "match".
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: length mismatch (${a.length} vs ${b.length})`,
    );
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Default cosine thresholds. Speaker-verification systems pick an operating
 * point near the Equal-Error-Rate (EER); for on-device ECAPA/Resemblyzer-class
 * embeddings a cosine ~0.5-0.7 is a common accept point. These are PLACEHOLDER
 * defaults for the spike — the real values MUST be calibrated on the owner's
 * enrollment + the chosen model (see spike report). We bias toward NOT locking
 * the owner out: `openAt` is the accept point; `closeAt` sits below it so a
 * borderline follow-up doesn't chatter the gate (hysteresis).
 */
export const DEFAULT_SPEAKER_GATE = {
  /** Similarity at/above which a CLOSED gate opens (enrolled speaker present). */
  openAt: 0.62,
  /** Similarity below which an OPEN gate closes. Must be ≤ openAt. */
  closeAt: 0.5,
} as const;

export interface SpeakerGateOptions {
  /** Reference embedding from enrollment (need not be pre-normalised). */
  reference: readonly number[];
  openAt?: number;
  closeAt?: number;
}

export interface GateDecision {
  /** True once this window's similarity crosses the open/close policy. */
  open: boolean;
  /** The raw cosine similarity for this window (for telemetry/tuning). */
  similarity: number;
}

/**
 * Stateful gate with hysteresis. Feed it the embedding of each speech window;
 * it returns whether the mic should currently be OPEN to the caddie.
 *
 * Hysteresis: it takes `openAt` to open but stays open until similarity drops
 * below the lower `closeAt`. This prevents flapping mid-utterance where a word
 * or two dips in similarity — matching how a human "keeps listening" once the
 * owner has clearly started talking, and closing only when it's clearly not him.
 */
export class SpeakerGate {
  private readonly reference: readonly number[];
  private readonly openAt: number;
  private readonly closeAt: number;
  private isOpen = false;

  constructor(opts: SpeakerGateOptions) {
    if (opts.reference.length === 0) {
      throw new Error("SpeakerGate: reference embedding is empty");
    }
    const openAt = opts.openAt ?? DEFAULT_SPEAKER_GATE.openAt;
    const closeAt = opts.closeAt ?? DEFAULT_SPEAKER_GATE.closeAt;
    if (closeAt > openAt) {
      throw new Error(
        `SpeakerGate: closeAt (${closeAt}) must be <= openAt (${openAt})`,
      );
    }
    this.reference = opts.reference;
    this.openAt = openAt;
    this.closeAt = closeAt;
  }

  /**
   * Decide for one speech-window embedding. Pure w.r.t. the input, but advances
   * the gate's open/closed state (hysteresis), so call it once per window in
   * order.
   */
  accept(embedding: readonly number[]): GateDecision {
    const similarity = cosineSimilarity(embedding, this.reference);
    if (this.isOpen) {
      if (similarity < this.closeAt) this.isOpen = false;
    } else if (similarity >= this.openAt) {
      this.isOpen = true;
    }
    return { open: this.isOpen, similarity };
  }

  /** Current gate state without consuming a window (e.g. on a silence frame). */
  get open(): boolean {
    return this.isOpen;
  }

  /** Force closed — e.g. VAD reports silence, or the session resets. */
  reset(): void {
    this.isOpen = false;
  }
}
