/**
 * Live-STT engine factory + fallback ladder (specs/live-transcription-plan.md
 * §4.4) — the ONE place the six dictation call sites construct a live
 * transcriber, so the server-side `LIVE_STT_ENGINE` flag flips which vendor
 * runs without touching a single call site.
 *
 * Contract: `createLiveTranscriber(events, opts)` returns synchronously (a
 * drop-in replacement for `new DeepgramLiveTranscriber(events, opts)`) — all
 * the engine-decision + fallback network work happens lazily inside the
 * returned object's own `start(stream)`, exactly matching every existing
 * call site's `const t = new DeepgramLiveTranscriber(...); await t.start(stream)`
 * shape.
 *
 * Fallback ladder — GENUINELY falls back, not just on paper:
 *   engine:"deepgram" (default/unset) -> DeepgramLiveTranscriber, reusing
 *     the token the SAME /live-session response already minted (no second
 *     network round trip).
 *   engine:"openai"   -> OpenAILiveTranscriber.start(); on ANY failure
 *     (mint, WS handshake, first-frame/PcmCapture error) -> Deepgram via the
 *     LEGACY /live-token path (self-fetches its own token), + telemetry
 *     `live_engine_fallback`.
 *   The /live-session mint call itself failing (network, 500, misconfigured
 *     flag) -> same Deepgram/legacy-path fallback.
 * Only if THAT Deepgram attempt also fails does the caller's existing
 * `liveFailed` -> blob-recorder fallback engage, same as today.
 */

import { fetchAPI } from '../api';
import { voiceEvent } from './telemetry';
import { DeepgramLiveTranscriber, type DeepgramLiveEvents } from './deepgram-live';
import { OpenAILiveTranscriber } from './openai-live';

/** The shared shape every dictation call site drives — extracted from
 *  DeepgramLiveTranscriber's existing instance contract (deepgram-live.ts). */
export interface LiveTranscriber {
  start(stream: MediaStream): Promise<void>;
  stop(): void;
}

interface LiveSttSessionResponse {
  engine: 'deepgram' | 'openai';
  access_token: string;
  expires_in: number;
  model?: string;
}

class FlaggedLiveTranscriber implements LiveTranscriber {
  private events: DeepgramLiveEvents;
  private keyterms: readonly string[];
  private inner: LiveTranscriber | null = null;

  constructor(events: DeepgramLiveEvents, opts?: { keyterms?: readonly string[] }) {
    this.events = events;
    this.keyterms = opts?.keyterms ?? [];
  }

  async start(stream: MediaStream): Promise<void> {
    let session: LiveSttSessionResponse;
    try {
      session = await fetchAPI<LiveSttSessionResponse>('/api/voice/live-session', {
        method: 'POST',
        body: JSON.stringify({ keyterms: [...this.keyterms] }),
      });
    } catch {
      // The mint endpoint itself failed (network, 500, a misconfigured
      // flag) — fall back straight to the legacy Deepgram path, which
      // self-fetches its own token via /live-token independently.
      voiceEvent('caddie', 'live_engine_fallback', { detail: 'reason=mint_failed' });
      return this.startDeepgramFallback(stream);
    }

    if (session.engine === 'openai') {
      const openai = new OpenAILiveTranscriber(this.events, { keyterms: this.keyterms });
      try {
        await openai.start(stream);
        this.inner = openai;
        return;
      } catch {
        // ANY failure — mint, WS handshake, first-frame error — falls back
        // to Deepgram. This is the exact ladder the reviewer tests
        // flag-on-with-a-bad-key against.
        try {
          openai.stop();
        } catch {
          /* already torn down */
        }
        voiceEvent('caddie', 'live_engine_fallback', { detail: 'reason=openai_start_failed' });
        return this.startDeepgramFallback(stream);
      }
    }

    // engine === "deepgram" (default/unset) — reuse the already-minted
    // token from THIS response; no second network call.
    const deepgram = new DeepgramLiveTranscriber(this.events, {
      keyterms: this.keyterms,
      token: { access_token: session.access_token, expires_in: session.expires_in },
    });
    this.inner = deepgram;
    return deepgram.start(stream);
  }

  /** Always goes through the LEGACY /live-token path (self-fetch) — never
   *  retries /live-session, so a broken openai-engine mint can't loop. */
  private async startDeepgramFallback(stream: MediaStream): Promise<void> {
    const deepgram = new DeepgramLiveTranscriber(this.events, { keyterms: this.keyterms });
    this.inner = deepgram;
    return deepgram.start(stream);
  }

  stop(): void {
    this.inner?.stop();
    this.inner = null;
  }
}

/**
 * Construct a live transcriber. Drop-in replacement for
 * `new DeepgramLiveTranscriber(events, opts)` at every dictation call site —
 * the engine (Deepgram default, or OpenAI behind the server-side
 * `LIVE_STT_ENGINE=openai` flag, with a genuine fallback to Deepgram on any
 * OpenAI failure) is decided lazily inside `start(stream)`.
 */
export function createLiveTranscriber(
  events: DeepgramLiveEvents,
  opts?: { keyterms?: readonly string[] },
): LiveTranscriber {
  return new FlaggedLiveTranscriber(events, opts);
}
