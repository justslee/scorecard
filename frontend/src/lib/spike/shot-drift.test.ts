// SPIKE (specs/passive-shot-tracking-spike.md) — unit tests for the pure
// GPS-delta classifier seam. This is the ONE piece of the spike worth unit
// tests (see plan §7); the gated banner/mount are exercised by hand on
// device/simulator (documented in the writeup).

import { describe, expect, it } from "vitest";
import {
  advance,
  createDriftState,
  resetAnchor,
  type DriftSample,
  type DriftState,
} from "./shot-drift";

const ANCHOR = { lat: 33.5, lng: -111.9 };
const METERS_PER_DEG_LAT = 111_320;

/** Offset a lat/lng point due north by `meters` (mean-latitude approx —
 *  plenty accurate at the tiny offsets these tests use). */
function north(pos: { lat: number; lng: number }, meters: number) {
  return { lat: pos.lat + meters / METERS_PER_DEG_LAT, lng: pos.lng };
}

/** Offset a lat/lng point due east by `meters`. */
function east(pos: { lat: number; lng: number }, meters: number) {
  const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((pos.lat * Math.PI) / 180);
  return { lat: pos.lat, lng: pos.lng + meters / metersPerDegLng };
}

function runAll(state: DriftState, samples: DriftSample[]) {
  let s = state;
  const suggestions = [];
  for (const sample of samples) {
    const r = advance(s, sample);
    s = r.state;
    if (r.suggestion) suggestions.push(r.suggestion);
  }
  return { state: s, suggestions };
}

describe("shot-drift classifier", () => {
  it("1. straight 240y walk between dwells → one 'walked' suggestion ~240y", () => {
    const anchorSample: DriftSample = { ...ANCHOR, timestamp: 0, accuracy: 5 };
    const state = createDriftState(anchorSample);

    const samples: DriftSample[] = [];
    let t = 0;
    // Walking pace ~1.5 m/s, sampled every 3s, covering ~220m (~240y).
    const WALK_SPEED = 1.5;
    const STEP_M = WALK_SPEED * 3;
    const STEPS = 49; // 49 * 4.5m ≈ 220.5m ≈ 241y
    for (let i = 1; i <= STEPS; i++) {
      t += 3000;
      samples.push({ ...north(ANCHOR, i * STEP_M), timestamp: t, accuracy: 6, speed: WALK_SPEED });
    }
    // Stop and dwell — well past the 10s sustained-rest threshold.
    const finalPos = north(ANCHOR, STEPS * STEP_M);
    for (let i = 0; i < 8; i++) {
      t += 3000;
      samples.push({ ...finalPos, timestamp: t, accuracy: 6, speed: 0 });
    }

    const { suggestions } = runAll(state, samples);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].kind).toBe("walked");
    // Coarse by design (spec Q3: ±10-20y) — assert it lands in the
    // ballpark of the actual 241y walk, not an exact match.
    expect(suggestions[0].estimatedYards).toBeGreaterThan(200);
    expect(suggestions[0].estimatedYards).toBeLessThan(270);
  });

  it("2. tee-box jitter (±8m noise, no displacement) → none", () => {
    const anchorSample: DriftSample = { ...ANCHOR, timestamp: 0, accuracy: 5 };
    const state = createDriftState(anchorSample);

    // Deterministic small oscillation around the anchor — never a real move.
    const jitterMeters = [8, -8, 5, -6, 7, -4, 3, -8, 6, -5, 4, -7, 8, -3, 5];
    const samples: DriftSample[] = jitterMeters.map((m, i) => ({
      ...north(ANCHOR, m),
      timestamp: (i + 1) * 4000,
      accuracy: 6,
      // No `speed` — exercises the raw position/time fallback path.
    }));

    const { suggestions } = runAll(state, samples);
    expect(suggestions).toHaveLength(0);
  });

  it("3. cart-speed trace → 'rode'", () => {
    const anchorSample: DriftSample = { ...ANCHOR, timestamp: 0, accuracy: 5 };
    const state = createDriftState(anchorSample);

    const samples: DriftSample[] = [];
    let t = 0;
    const CART_SPEED = 6; // m/s — well above the 4.5 m/s cart threshold
    const STEP_M = CART_SPEED * 2;
    const STEPS = 23; // ~276m ≈ 302y
    for (let i = 1; i <= STEPS; i++) {
      t += 2000;
      samples.push({ ...north(ANCHOR, i * STEP_M), timestamp: t, accuracy: 6, speed: CART_SPEED });
    }
    const finalPos = north(ANCHOR, STEPS * STEP_M);
    for (let i = 0; i < 8; i++) {
      t += 3000;
      samples.push({ ...finalPos, timestamp: t, accuracy: 6, speed: 0 });
    }

    const { suggestions } = runAll(state, samples);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].kind).toBe("rode");
  });

  it("4. zigzag search path → suggestion uses straight-line, fires once", () => {
    const anchorSample: DriftSample = { ...ANCHOR, timestamp: 0, accuracy: 5 };
    const state = createDriftState(anchorSample);

    const samples: DriftSample[] = [];
    let t = 0;
    let cursor = ANCHOR;
    let pathLengthM = 0;
    const FORWARD_STEP_M = 5;
    const LATERAL_M = 12; // wide side-to-side search sweep
    const STEPS = 40;
    for (let i = 1; i <= STEPS; i++) {
      t += 3000;
      let next = north(cursor, FORWARD_STEP_M);
      // Oscillate laterally, net zero over each pair of steps, so the FINAL
      // lateral offset is exactly 0 — isolates "straight-line == forward
      // distance only" from any residual lateral term.
      next = east(next, i % 2 === 0 ? -LATERAL_M : LATERAL_M);
      pathLengthM += Math.sqrt(
        (FORWARD_STEP_M) ** 2 + LATERAL_M ** 2,
      ); // each leg's actual (longer) path length
      samples.push({ ...next, timestamp: t, accuracy: 6, speed: 1.2 });
      cursor = next;
    }
    // Stop and dwell at the final (net-zero-lateral) position.
    const finalPos = cursor;
    for (let i = 0; i < 8; i++) {
      t += 3000;
      samples.push({ ...finalPos, timestamp: t, accuracy: 6, speed: 0 });
    }

    const { suggestions } = runAll(state, samples);
    expect(suggestions).toHaveLength(1);

    const forwardOnlyYards = Math.round(FORWARD_STEP_M * STEPS * 1.09361);
    const pathLengthYards = Math.round(pathLengthM * 1.09361);
    // The zigzag path is meaningfully longer than the straight-line forward
    // distance — proves the two are actually different in this fixture.
    expect(pathLengthYards).toBeGreaterThan(forwardOnlyYards + 50);
    // The suggestion tracks the straight-line (forward-only) distance, not
    // the longer path actually walked.
    expect(suggestions[0].estimatedYards).toBeGreaterThan(forwardOnlyYards - 20);
    expect(suggestions[0].estimatedYards).toBeLessThan(forwardOnlyYards + 20);
    expect(suggestions[0].estimatedYards).toBeLessThan(pathLengthYards - 30);
  });

  it("5. accuracy>25m samples are ignored (state untouched)", () => {
    const anchorSample: DriftSample = { ...ANCHOR, timestamp: 0, accuracy: 5 };
    const state = createDriftState(anchorSample);

    const noisy: DriftSample = {
      ...north(ANCHOR, 1000), // would otherwise read as a huge, instant move
      timestamp: 5000,
      accuracy: 30, // over the 25m gate
      speed: 20,
    };
    const result = advance(state, noisy);

    expect(result.suggestion).toBeNull();
    // Dropped whole — same state reference, not just "no suggestion".
    expect(result.state).toBe(state);
  });

  it("6. resetAnchor prevents re-fire until explicitly called", () => {
    const anchorSample: DriftSample = { ...ANCHOR, timestamp: 0, accuracy: 5 };
    let state = createDriftState(anchorSample);

    function walkAndDwell(from: { lat: number; lng: number }, startT: number, yards: number) {
      const meters = yards * 0.9144;
      const speed = 1.5;
      const stepM = speed * 3;
      const steps = Math.ceil(meters / stepM);
      const out: DriftSample[] = [];
      let t = startT;
      for (let i = 1; i <= steps; i++) {
        t += 3000;
        out.push({ ...north(from, i * stepM), timestamp: t, accuracy: 6, speed });
      }
      const finalPos = north(from, steps * stepM);
      for (let i = 0; i < 8; i++) {
        t += 3000;
        out.push({ ...finalPos, timestamp: t, accuracy: 6, speed: 0 });
      }
      return { samples: out, finalPos, finalT: t };
    }

    // First walk fires a suggestion.
    const first = walkAndDwell(ANCHOR, 0, 240);
    const r1 = runAll(state, first.samples);
    expect(r1.suggestions).toHaveLength(1);
    state = r1.state;
    expect(state.suggested).toBe(true);

    // Keep walking further (another 150y) WITHOUT resetting — latched, so
    // no second suggestion even though displacement from the ORIGINAL
    // anchor is now well past the threshold again.
    const second = walkAndDwell(first.finalPos, first.finalT, 150);
    const r2 = runAll(state, second.samples);
    expect(r2.suggestions).toHaveLength(0);
    state = r2.state;

    // Confirm/dismiss: re-anchor at wherever they are now.
    const lastSample = second.samples[second.samples.length - 1];
    state = resetAnchor(state, lastSample);
    expect(state.suggested).toBe(false);

    // The SAME kind of walk now fires again from the new anchor.
    const third = walkAndDwell(second.finalPos, second.finalT, 240);
    const r3 = runAll(state, third.samples);
    expect(r3.suggestions).toHaveLength(1);
  });
});
