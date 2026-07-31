/**
 * Adapter test for DeepgramLiveTranscriber's `token` constructor option
 * (specs/live-transcription-plan.md §4.4) — added so lib/voice/live-stt.ts's
 * factory can reuse the token its own /api/voice/live-session mint already
 * returned, instead of a second /api/voice/live-token round trip.
 *
 * Deliberately a SEPARATE file from deepgram-live.test.ts, which is scoped
 * to the pure parser only (its header: "the streaming path itself... is
 * verified manually on device") — this test exists to pin the ONE new
 * behavior this bundle adds to that class, not to re-litigate that scope.
 *
 * `window` is undefined in vitest's default 'node' environment, so
 * lib/api.ts's getAuthToken() short-circuits to null immediately — no jsdom
 * needed (matches lib/shot-stats.test.ts's pattern).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const pcmMock = vi.hoisted(() => {
  class FakePcmCapture {
    static isSupported = vi.fn(() => true);
    start = vi.fn(async () => {});
    stop = vi.fn();
  }
  return { FakePcmCapture };
});
vi.mock('./pcm-capture', () => ({ PcmCapture: pcmMock.FakePcmCapture }));

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  url: string;
  protocols: string[];
  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }
  send() {}
  close() {}
  triggerOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

function fakeStream(): MediaStream {
  return {} as MediaStream;
}

async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', '');
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://localhost:8000');
  vi.stubGlobal('WebSocket', FakeWebSocket);
  FakeWebSocket.instances = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('DeepgramLiveTranscriber — pre-fetched token option', () => {
  it('a pre-fetched token skips the /live-token network call entirely', async () => {
    const fetchMock = vi.fn(); // must NEVER be called
    vi.stubGlobal('fetch', fetchMock);

    const { DeepgramLiveTranscriber } = await import('./deepgram-live');
    const t = new DeepgramLiveTranscriber(
      {},
      { token: { access_token: 'prefetched_tok', expires_in: 60 } },
    );
    const startP = t.start(fakeStream());
    await flushMicrotasks();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].protocols).toEqual(['token', 'prefetched_tok']);

    FakeWebSocket.instances[0].triggerOpen();
    await startP;
  });

  it('omitting the token self-fetches via /live-token exactly as before this option existed', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'self_fetched_tok', expires_in: 60 }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { DeepgramLiveTranscriber } = await import('./deepgram-live');
    const t = new DeepgramLiveTranscriber({});
    const startP = t.start(fakeStream());
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/voice/live-token'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(FakeWebSocket.instances[0].protocols).toEqual(['token', 'self_fetched_tok']);

    FakeWebSocket.instances[0].triggerOpen();
    await startP;
  });
});
