/**
 * Fallback-ladder tests for createLiveTranscriber (specs/live-transcription
 * -plan.md §4.4) — the genuine part of "genuinely falls back": DeepgramLive
 * Transcriber and OpenAILiveTranscriber are both faked so this suite proves
 * the LADDER LOGIC itself (which class gets constructed, with what args, and
 * when the fallback telemetry fires) independent of either engine's own
 * internals (already covered by deepgram-live.test.ts / openai-live.test.ts).
 *
 * `window` is undefined in vitest's default 'node' environment, so
 * lib/api.ts's getAuthToken() short-circuits to null immediately — no jsdom
 * needed (matches lib/shot-stats.test.ts's pattern).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const voiceEventMock = vi.hoisted(() => vi.fn());
vi.mock('./telemetry', () => ({ voiceEvent: voiceEventMock }));

const deepgramMock = vi.hoisted(() => {
  class FakeDeepgramLiveTranscriber {
    static instances: FakeDeepgramLiveTranscriber[] = [];
    opts: Record<string, unknown>;
    start = vi.fn(async () => {});
    stop = vi.fn();
    constructor(_events: unknown, opts: Record<string, unknown> = {}) {
      this.opts = opts;
      FakeDeepgramLiveTranscriber.instances.push(this);
    }
  }
  return { FakeDeepgramLiveTranscriber };
});
vi.mock('./deepgram-live', () => ({
  DeepgramLiveTranscriber: deepgramMock.FakeDeepgramLiveTranscriber,
}));

const openaiMock = vi.hoisted(() => {
  class FakeOpenAILiveTranscriber {
    static instances: FakeOpenAILiveTranscriber[] = [];
    static nextStartResult: 'resolve' | 'reject' = 'resolve';
    opts: Record<string, unknown>;
    start = vi.fn(async () => {
      if (FakeOpenAILiveTranscriber.nextStartResult === 'reject') {
        throw new Error('openai start failed');
      }
    });
    stop = vi.fn();
    constructor(_events: unknown, opts: Record<string, unknown> = {}) {
      this.opts = opts;
      FakeOpenAILiveTranscriber.instances.push(this);
    }
  }
  return { FakeOpenAILiveTranscriber };
});
vi.mock('./openai-live', () => ({ OpenAILiveTranscriber: openaiMock.FakeOpenAILiveTranscriber }));

function fakeStream(): MediaStream {
  return {} as MediaStream;
}

function stubLiveSessionFetch(response: Record<string, unknown> | 'reject') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (response === 'reject') throw new Error('network down');
      return { ok: true, status: 200, json: async () => response, text: async () => '' };
    }),
  );
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', '');
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://localhost:8000');
  deepgramMock.FakeDeepgramLiveTranscriber.instances = [];
  openaiMock.FakeOpenAILiveTranscriber.instances = [];
  openaiMock.FakeOpenAILiveTranscriber.nextStartResult = 'resolve';
  voiceEventMock.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('createLiveTranscriber — engine routing', () => {
  it('engine "deepgram" (default) constructs DeepgramLiveTranscriber reusing the already-minted token — no OpenAI construction, no fallback telemetry', async () => {
    stubLiveSessionFetch({ engine: 'deepgram', access_token: 'dg_tok', expires_in: 60 });
    const { createLiveTranscriber } = await import('./live-stt');

    const t = createLiveTranscriber({}, { keyterms: ['dave'] });
    await t.start(fakeStream());

    expect(deepgramMock.FakeDeepgramLiveTranscriber.instances).toHaveLength(1);
    const dg = deepgramMock.FakeDeepgramLiveTranscriber.instances[0];
    expect(dg.opts.token).toEqual({ access_token: 'dg_tok', expires_in: 60 });
    expect(dg.opts.keyterms).toEqual(['dave']);
    expect(dg.start).toHaveBeenCalledTimes(1);
    expect(openaiMock.FakeOpenAILiveTranscriber.instances).toHaveLength(0);
    expect(voiceEventMock).not.toHaveBeenCalledWith('caddie', 'live_engine_fallback', expect.anything());
  });

  it('engine "openai" success: constructs + starts OpenAILiveTranscriber only — Deepgram never constructed', async () => {
    stubLiveSessionFetch({ engine: 'openai', access_token: 'ek_tok', expires_in: 60, model: 'gpt-live-transcribe' });
    const { createLiveTranscriber } = await import('./live-stt');

    const t = createLiveTranscriber({}, { keyterms: ['dave'] });
    await t.start(fakeStream());

    expect(openaiMock.FakeOpenAILiveTranscriber.instances).toHaveLength(1);
    expect(openaiMock.FakeOpenAILiveTranscriber.instances[0].start).toHaveBeenCalledTimes(1);
    expect(deepgramMock.FakeDeepgramLiveTranscriber.instances).toHaveLength(0);
    expect(voiceEventMock).not.toHaveBeenCalledWith('caddie', 'live_engine_fallback', expect.anything());
  });

  it('engine "openai" FAILURE (flag-on-with-a-bad-key): genuinely falls back to Deepgram via the legacy self-fetch path, with fallback telemetry', async () => {
    stubLiveSessionFetch({ engine: 'openai', access_token: 'ek_bad', expires_in: 60 });
    openaiMock.FakeOpenAILiveTranscriber.nextStartResult = 'reject';
    const { createLiveTranscriber } = await import('./live-stt');

    const t = createLiveTranscriber({}, { keyterms: ['dave'] });
    await t.start(fakeStream());

    // The reviewer's exact test: OpenAI attempted, failed, and Deepgram
    // interims STILL work via a genuine fallback construction + start().
    expect(openaiMock.FakeOpenAILiveTranscriber.instances).toHaveLength(1);
    expect(openaiMock.FakeOpenAILiveTranscriber.instances[0].stop).toHaveBeenCalled(); // torn down
    expect(deepgramMock.FakeDeepgramLiveTranscriber.instances).toHaveLength(1);
    const dg = deepgramMock.FakeDeepgramLiveTranscriber.instances[0];
    // Legacy self-fetch path — no reused token from the failed openai mint.
    expect(dg.opts.token).toBeUndefined();
    expect(dg.opts.keyterms).toEqual(['dave']);
    expect(dg.start).toHaveBeenCalledTimes(1);
    expect(voiceEventMock).toHaveBeenCalledWith(
      'caddie',
      'live_engine_fallback',
      expect.objectContaining({ detail: expect.stringContaining('openai_start_failed') }),
    );
  });

  it('the /live-session mint call itself failing falls back to Deepgram (self-fetch), with fallback telemetry', async () => {
    stubLiveSessionFetch('reject');
    const { createLiveTranscriber } = await import('./live-stt');

    const t = createLiveTranscriber({}, { keyterms: ['dave'] });
    await t.start(fakeStream());

    expect(openaiMock.FakeOpenAILiveTranscriber.instances).toHaveLength(0);
    expect(deepgramMock.FakeDeepgramLiveTranscriber.instances).toHaveLength(1);
    const dg = deepgramMock.FakeDeepgramLiveTranscriber.instances[0];
    expect(dg.opts.token).toBeUndefined();
    expect(dg.start).toHaveBeenCalledTimes(1);
    expect(voiceEventMock).toHaveBeenCalledWith(
      'caddie',
      'live_engine_fallback',
      expect.objectContaining({ detail: expect.stringContaining('mint_failed') }),
    );
  });
});

describe('createLiveTranscriber().stop()', () => {
  it('delegates to whichever inner transcriber was actually constructed (deepgram path)', async () => {
    stubLiveSessionFetch({ engine: 'deepgram', access_token: 'dg_tok', expires_in: 60 });
    const { createLiveTranscriber } = await import('./live-stt');
    const t = createLiveTranscriber({});
    await t.start(fakeStream());
    t.stop();
    expect(deepgramMock.FakeDeepgramLiveTranscriber.instances[0].stop).toHaveBeenCalled();
  });

  it('delegates to whichever inner transcriber was actually constructed (openai path)', async () => {
    stubLiveSessionFetch({ engine: 'openai', access_token: 'ek_tok', expires_in: 60 });
    const { createLiveTranscriber } = await import('./live-stt');
    const t = createLiveTranscriber({});
    await t.start(fakeStream());
    t.stop();
    expect(openaiMock.FakeOpenAILiveTranscriber.instances[0].stop).toHaveBeenCalled();
  });

  it('is a no-op if called before start() ever resolved (never throws)', async () => {
    stubLiveSessionFetch({ engine: 'deepgram', access_token: 'dg_tok', expires_in: 60 });
    const { createLiveTranscriber } = await import('./live-stt');
    const t = createLiveTranscriber({});
    expect(() => t.stop()).not.toThrow();
  });
});
