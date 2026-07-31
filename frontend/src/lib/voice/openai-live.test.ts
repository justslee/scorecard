/**
 * Adapter unit tests for OpenAILiveTranscriber (specs/live-transcription-plan.md
 * §4.3) — event mapping, the utterance-end guard, and the session.update
 * defense-in-depth frame. WebSocket + PcmCapture are faked (no real audio
 * hardware / network); fetch is stubbed so /api/voice/live-session never
 * hits a real network.
 *
 * `window` is undefined in vitest's default 'node' environment, so
 * lib/api.ts's getAuthToken() short-circuits to null immediately (no Clerk
 * polling) — no jsdom needed here, matching lib/shot-stats.test.ts's pattern.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const pcmMock = vi.hoisted(() => {
  class FakePcmCapture {
    static instances: FakePcmCapture[] = [];
    static isSupported = vi.fn(() => true);
    targetRate: number;
    onChunk: ((c: Int16Array) => void) | null = null;
    start = vi.fn(async (_stream: MediaStream, onChunk: (c: Int16Array) => void) => {
      this.onChunk = onChunk;
    });
    stop = vi.fn();
    constructor(targetRate?: number) {
      this.targetRate = targetRate ?? 16000;
      FakePcmCapture.instances.push(this);
    }
  }
  return { FakePcmCapture };
});
vi.mock('./pcm-capture', () => ({ PcmCapture: pcmMock.FakePcmCapture }));

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  url: string;
  protocols: string[];

  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  // ── Test helpers ──
  triggerOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  triggerMessage(evt: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(evt) });
  }
  triggerError() {
    this.onerror?.();
  }
}

function fakeStream(): MediaStream {
  return {} as MediaStream;
}

/** Drain the async chain inside fetchAPI (getAuthToken -> fetch -> res.json())
 *  deterministically without real timers. */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', '');
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://localhost:8000');
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ engine: 'openai', access_token: 'ek_test', expires_in: 60, model: 'gpt-live-transcribe' }),
      text: async () => '',
    })),
  );
  FakeWebSocket.instances = [];
  pcmMock.FakePcmCapture.instances = [];
  pcmMock.FakePcmCapture.isSupported.mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('OpenAILiveTranscriber.isSupported', () => {
  it('true when both WebSocket and PcmCapture are available', async () => {
    const { OpenAILiveTranscriber } = await import('./openai-live');
    expect(OpenAILiveTranscriber.isSupported()).toBe(true);
  });

  it('false when PcmCapture is unsupported', async () => {
    pcmMock.FakePcmCapture.isSupported.mockReturnValue(false);
    const { OpenAILiveTranscriber } = await import('./openai-live');
    expect(OpenAILiveTranscriber.isSupported()).toBe(false);
  });
});

describe('OpenAILiveTranscriber.start', () => {
  it('POSTs /api/voice/live-session with keyterms, then opens the WS with the openai-insecure-api-key subprotocol', async () => {
    const { OpenAILiveTranscriber } = await import('./openai-live');
    const t = new OpenAILiveTranscriber({}, { keyterms: ['dave', 'pebble beach'] });
    const startP = t.start(fakeStream());

    // Let the mint POST resolve.
    await flushMicrotasks();

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/voice/live-session'),
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.keyterms).toEqual(['dave', 'pebble beach']);

    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe('wss://api.openai.com/v1/realtime?intent=transcription');
    expect(ws.protocols).toEqual(['realtime', 'openai-insecure-api-key.ek_test']);

    ws.triggerOpen();
    await startP;
  });

  it('sends a session.update frame on open, mirroring silence_duration_ms=1200 (deepgram-live.ts parity)', async () => {
    const { OpenAILiveTranscriber } = await import('./openai-live');
    const t = new OpenAILiveTranscriber({}, { keyterms: ['dave'] });
    const startP = t.start(fakeStream());
    await flushMicrotasks();

    const ws = FakeWebSocket.instances[0];
    ws.triggerOpen();
    await startP;

    const sessionUpdate = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'session.update');
    expect(sessionUpdate).toBeDefined();
    expect(sessionUpdate.session.type).toBe('transcription');
    expect(sessionUpdate.session.audio.input.format).toEqual({ type: 'audio/pcm', rate: 24000 });
    expect(sessionUpdate.session.audio.input.transcription.keywords).toEqual(['dave']);
    expect(sessionUpdate.session.audio.input.turn_detection.silence_duration_ms).toBe(1200);
    // The free-text prompt is deliberately NOT re-sent client-side (server-composed only).
    expect(sessionUpdate.session.audio.input.transcription.prompt).toBeUndefined();
  });

  it('starts PcmCapture at 24kHz (not Deepgram\'s 16kHz) and streams base64 PCM append frames', async () => {
    const { OpenAILiveTranscriber } = await import('./openai-live');
    const t = new OpenAILiveTranscriber({});
    const startP = t.start(fakeStream());
    await flushMicrotasks();
    const ws = FakeWebSocket.instances[0];
    ws.triggerOpen();
    await startP;

    const pcm = pcmMock.FakePcmCapture.instances[0];
    expect(pcm.targetRate).toBe(24000);
    expect(pcm.start).toHaveBeenCalledTimes(1);

    // Simulate a PCM chunk arriving from PcmCapture.
    pcm.onChunk?.(new Int16Array([0, 100, -100]));
    const appendFrame = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === 'input_audio_buffer.append');
    expect(appendFrame).toBeDefined();
    expect(typeof appendFrame.audio).toBe('string');
    expect(appendFrame.audio.length).toBeGreaterThan(0);
  });

  it('rejects (and fires onError) on an unexpected engine in the response — defensive guard', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ engine: 'deepgram', access_token: 'dg_test', expires_in: 60 }),
        text: async () => '',
      })),
    );
    const { OpenAILiveTranscriber } = await import('./openai-live');
    const t = new OpenAILiveTranscriber({});
    await expect(t.start(fakeStream())).rejects.toThrow(/engine=deepgram/);
  });

  it('rejects (and fires onError) on a WS error', async () => {
    const onError = vi.fn();
    const { OpenAILiveTranscriber } = await import('./openai-live');
    const t = new OpenAILiveTranscriber({ onError });
    const startP = t.start(fakeStream());
    await flushMicrotasks();
    const ws = FakeWebSocket.instances[0];
    ws.triggerError();
    await expect(startP).rejects.toThrow();
    expect(onError).toHaveBeenCalled();
  });
});

describe('OpenAILiveTranscriber — event mapping', () => {
  async function startedTranscriber(events: Record<string, unknown> = {}) {
    const { OpenAILiveTranscriber } = await import('./openai-live');
    const t = new OpenAILiveTranscriber(events);
    const startP = t.start(fakeStream());
    await flushMicrotasks();
    const ws = FakeWebSocket.instances[0];
    ws.triggerOpen();
    await startP;
    return { t, ws };
  }

  it('.delta accumulates and fires onInterim with accumulatedFinals + current delta', async () => {
    const onInterim = vi.fn();
    const { ws } = await startedTranscriber({ onInterim });

    ws.triggerMessage({ type: 'conversation.item.input_audio_transcription.delta', delta: 'what' });
    ws.triggerMessage({ type: 'conversation.item.input_audio_transcription.delta', delta: ' club' });

    expect(onInterim.mock.calls.map((c) => c[0])).toEqual(['what', 'what club']);
  });

  it('.completed appends to accumulatedFinals, clears the current delta, and fires onFinal', async () => {
    const onInterim = vi.fn();
    const onFinal = vi.fn();
    const { ws } = await startedTranscriber({ onInterim, onFinal });

    ws.triggerMessage({ type: 'conversation.item.input_audio_transcription.delta', delta: 'what club' });
    ws.triggerMessage({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'what club here',
    });
    expect(onFinal).toHaveBeenCalledWith('what club here');

    // A NEW delta after .completed starts fresh (current cleared) but keeps
    // accumulating onto the settled final — append-only, no rewrite flicker.
    onInterim.mockClear();
    ws.triggerMessage({ type: 'conversation.item.input_audio_transcription.delta', delta: 'seven iron' });
    expect(onInterim).toHaveBeenCalledWith('what club here seven iron');
  });

  it('speech_stopped fires onUtteranceEnd ONLY if something was heard (deepgram-live.ts:305 parity)', async () => {
    const onUtteranceEnd = vi.fn();
    const { ws } = await startedTranscriber({ onUtteranceEnd });

    // Nothing heard yet — silence-only speech_stopped must NOT fire.
    ws.triggerMessage({ type: 'input_audio_buffer.speech_stopped' });
    expect(onUtteranceEnd).not.toHaveBeenCalled();

    ws.triggerMessage({ type: 'conversation.item.input_audio_transcription.delta', delta: 'fore' });
    ws.triggerMessage({ type: 'input_audio_buffer.speech_stopped' });
    expect(onUtteranceEnd).toHaveBeenCalledTimes(1);
  });

  it('malformed JSON on the WS never throws', async () => {
    const { ws } = await startedTranscriber({});
    expect(() => ws.triggerMessage.call(ws, undefined as unknown as Record<string, unknown>)).not.toThrow();
    expect(() => ws.onmessage?.({ data: 'not valid json {' })).not.toThrow();
  });
});

describe('OpenAILiveTranscriber.stop', () => {
  it('stops PcmCapture and closes the WS, resetting accumulation', async () => {
    const { OpenAILiveTranscriber } = await import('./openai-live');
    const t = new OpenAILiveTranscriber({});
    const startP = t.start(fakeStream());
    await flushMicrotasks();
    const ws = FakeWebSocket.instances[0];
    ws.triggerOpen();
    await startP;

    const pcm = pcmMock.FakePcmCapture.instances[0];
    t.stop();
    expect(pcm.stop).toHaveBeenCalled();
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
  });
});
