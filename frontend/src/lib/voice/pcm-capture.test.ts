import { describe, it, expect } from "vitest";
import { downsampleTo16k, encodeWav16kMono } from "./pcm-capture";

describe("downsampleTo16k", () => {
  it("passes through at 16k with float→int16 conversion", () => {
    const out = downsampleTo16k(new Float32Array([0, 0.5, -0.5, 1, -1]), 16000);
    expect(Array.from(out)).toEqual([0, 16384, -16384, 32767, -32768]);
  });

  it("halves sample count from 32k", () => {
    const input = new Float32Array(3200); // 100ms at 32k
    const out = downsampleTo16k(input, 32000);
    expect(out.length).toBe(1600); // 100ms at 16k
  });

  it("resamples 48k (the common iOS/desktop rate) to a third", () => {
    const input = new Float32Array(4800);
    input.fill(0.25);
    const out = downsampleTo16k(input, 48000);
    expect(out.length).toBe(1600);
    // Constant signal survives interpolation.
    expect(out[0]).toBe(Math.round(0.25 * 0x7fff));
    expect(out[out.length - 1]).toBe(Math.round(0.25 * 0x7fff));
  });

  it("clamps out-of-range floats", () => {
    const out = downsampleTo16k(new Float32Array([2.0, -2.0]), 16000);
    expect(out[0]).toBe(32767);
    expect(out[1]).toBe(-32768);
  });

  it("handles empty input", () => {
    expect(downsampleTo16k(new Float32Array(0), 48000).length).toBe(0);
  });
});

describe("encodeWav16kMono", () => {
  it("produces a valid RIFF header with correct sizes", async () => {
    const chunk = new Int16Array([1, -1, 100, -100]);
    const blob = encodeWav16kMono([chunk]);
    expect(blob.type).toBe("audio/wav");
    const buf = new Uint8Array(await blob.arrayBuffer());
    const str = (o: number, n: number) => String.fromCharCode(...buf.slice(o, o + n));
    expect(str(0, 4)).toBe("RIFF");
    expect(str(8, 4)).toBe("WAVE");
    expect(str(36, 4)).toBe("data");
    const view = new DataView(buf.buffer);
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint32(40, true)).toBe(8); // 4 samples * 2 bytes
    expect(view.getInt16(44, true)).toBe(1); // first sample round-trips
  });

  it("concatenates multiple chunks", async () => {
    const blob = encodeWav16kMono([new Int16Array([1, 2]), new Int16Array([3])]);
    const view = new DataView(await blob.arrayBuffer());
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(48, true)).toBe(3); // third sample after the header
  });
});
