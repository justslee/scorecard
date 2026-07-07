// Raw-PCM mic capture via WebAudio — the bulletproof live-dictation path for
// platforms whose MediaRecorder can't produce a stream Deepgram's socket can
// decode (iOS WKWebView records audio/mp4/AAC; two MediaRecorders on one
// stream is also exactly where AVFoundation gets flaky). One AudioContext tap
// → linear16 @16kHz chunks → ws.send. Coexists safely with the VoiceRecorder
// fallback blob (WebAudio taps don't contend with a MediaRecorder).
//
// The resampler + WAV encoder are exported pure functions (unit-tested).

/** Linear-interpolation resample of one Float32 block to 16 kHz Int16 PCM. */
export function downsampleTo16k(input: Float32Array, inputRate: number): Int16Array {
  const TARGET = 16000;
  if (input.length === 0) return new Int16Array(0);
  if (inputRate === TARGET) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) out[i] = floatToInt16(input[i]);
    return out;
  }
  const ratio = inputRate / TARGET;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = floatToInt16(input[i0] * (1 - frac) + input[i1] * frac);
  }
  return out;
}

function floatToInt16(v: number): number {
  const clamped = Math.max(-1, Math.min(1, v));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

/** RIFF/WAV wrapper for accumulated 16 kHz mono Int16 chunks (batch fallback). */
export function encodeWav16kMono(chunks: Int16Array[]): Blob {
  const RATE = 16000;
  const totalSamples = chunks.reduce((n, c) => n + c.length, 0);
  const dataBytes = totalSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);
  let off = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      view.setInt16(off, c[i], true);
      off += 2;
    }
  }
  return new Blob([buf], { type: "audio/wav" });
}

/**
 * Live PCM tap on an existing MediaStream. Prefers AudioWorklet (off-main-
 * thread); falls back to ScriptProcessorNode where worklets are unavailable.
 */
export class PcmCapture {
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private onChunk: ((pcm: Int16Array) => void) | null = null;

  static isSupported(): boolean {
    return typeof window !== "undefined" && typeof AudioContext !== "undefined";
  }

  async start(stream: MediaStream, onChunk: (pcm: Int16Array) => void): Promise<void> {
    this.onChunk = onChunk;
    const ctx = new AudioContext();
    this.ctx = ctx;
    // iOS creates suspended contexts outside a gesture — we're inside one
    // (the mic tap), but resume defensively.
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    this.source = source;
    const rate = ctx.sampleRate;

    const handleBlock = (block: Float32Array) => {
      const pcm = downsampleTo16k(block, rate);
      if (pcm.length > 0) this.onChunk?.(pcm);
    };

    if (typeof AudioWorkletNode !== "undefined" && ctx.audioWorklet) {
      try {
        // Inline worklet module (static export — no separate asset to serve).
        const moduleSrc = `
          class PcmTap extends AudioWorkletProcessor {
            process(inputs) {
              const ch = inputs[0] && inputs[0][0];
              if (ch && ch.length) this.port.postMessage(ch.slice(0));
              return true;
            }
          }
          registerProcessor("pcm-tap", PcmTap);
        `;
        const url = URL.createObjectURL(new Blob([moduleSrc], { type: "application/javascript" }));
        try {
          await ctx.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        const node = new AudioWorkletNode(ctx, "pcm-tap", {
          numberOfInputs: 1,
          numberOfOutputs: 0,
        });
        node.port.onmessage = (e) => handleBlock(e.data as Float32Array);
        source.connect(node);
        this.worklet = node;
        return;
      } catch {
        // fall through to ScriptProcessor
      }
    }

    // Deprecated but universal fallback.
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (e) => handleBlock(e.inputBuffer.getChannelData(0));
    source.connect(processor);
    // Some engines require the processor to reach the destination to tick;
    // route through a zero-gain node so nothing is audible.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    processor.connect(mute);
    mute.connect(ctx.destination);
    this.processor = processor;
  }

  stop(): void {
    this.onChunk = null;
    try {
      this.worklet?.port.close();
      this.worklet?.disconnect();
    } catch {
      /* already gone */
    }
    try {
      this.processor?.disconnect();
    } catch {
      /* already gone */
    }
    try {
      this.source?.disconnect();
    } catch {
      /* already gone */
    }
    void this.ctx?.close().catch(() => {});
    this.worklet = null;
    this.processor = null;
    this.source = null;
    this.ctx = null;
  }
}
