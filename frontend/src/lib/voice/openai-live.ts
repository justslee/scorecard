/**
 * OpenAI gpt-live-transcribe live-STT transcriber — the Part C dictation
 * engine (specs/live-transcription-plan.md §4.3), flagged OFF by default
 * (server-side `LIVE_STT_ENGINE`, default "deepgram" — this class is only
 * ever constructed by lib/voice/live-stt.ts's factory once the flag is on).
 *
 * Honors the EXACT DeepgramLiveEvents contract (deepgram-live.ts) so the six
 * dictation call sites need zero UI changes: {onInterim, onFinal,
 * onUtteranceEnd, onError} + static isSupported() + start(stream)/stop().
 *
 * Transport: WebSocket + ephemeral-secret subprotocol auth (browsers cannot
 * set an Authorization header on a WebSocket — the same problem Deepgram's
 * 'token' subprotocol already solves, see deepgram-live.ts). Proven in
 * WKWebView for Deepgram's handshake; UNPROVEN for OpenAI's specific
 * handshake until the iOS sim proof (specs/live-transcription-plan.md §6).
 * Audio uplink is base64 PCM16 @ 24kHz — ~2x Deepgram's iOS linear16@16kHz
 * uplink (§6's bandwidth honesty note); the flag stays off pending the A/B
 * (§7) and that on-device proof.
 */

import { fetchAPI } from '../api';
import { PcmCapture } from './pcm-capture';
import type { DeepgramLiveEvents } from './deepgram-live';
// Type-only — erased at compile time, so importing this ONE shared
// definition back from live-stt.ts (which itself imports the OpenAILiveTranscriber
// VALUE from this file) creates no runtime circular dependency
// (specs/live-transcription-plan.md §9 — the shared-types pair).
import type { LiveSttSession } from './live-stt';

const OPENAI_TRANSCRIBE_WS_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';

// GA transcription-session required input rate (session.audio.input.format
// = {type:"audio/pcm", rate:24000}) — distinct from Deepgram's 16kHz PCM
// path; PcmCapture's targetRate constructor param exists for exactly this.
const OPENAI_LIVE_STT_SAMPLE_RATE = 24000;

/** base64-encode a chunk of Int16 PCM samples (little-endian) for the
 *  `input_audio_buffer.append` WS frame. Chunked String.fromCharCode calls
 *  avoid blowing the call-stack argument limit on a large chunk. */
function base64FromInt16(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

export class OpenAILiveTranscriber {
  private events: DeepgramLiveEvents;
  private ws: WebSocket | null = null;
  private pcm: PcmCapture | null = null;
  private keyterms: readonly string[];
  // Same accumulation semantics as DeepgramLiveTranscriber
  // (deepgram-live.ts L318-333): running finals + the in-progress delta.
  // OpenAI deltas are APPEND-only (no rewrite flicker — designer note §8).
  private accumulatedFinals = '';
  private currentDelta = '';

  constructor(events: DeepgramLiveEvents, opts?: { keyterms?: readonly string[] }) {
    this.events = events;
    this.keyterms = opts?.keyterms ?? [];
  }

  /** True when both WebSocket and PcmCapture (WebAudio) are available. */
  static isSupported(): boolean {
    return typeof WebSocket !== 'undefined' && PcmCapture.isSupported();
  }

  /**
   * Start streaming audio from an EXISTING MediaStream to OpenAI's
   * transcription-session WS. Mints its own session (self-contained, same
   * posture as DeepgramLiveTranscriber's default self-fetch) — the caller
   * (lib/voice/live-stt.ts) only constructs this class after already having
   * observed `engine:"openai"` from its own /live-session call, but this
   * class re-mints rather than trust a stale/passed-in token, so it stays
   * usable standalone too.
   *
   * Throws (+ fires onError) on mint failure, an unexpected engine in the
   * response, WS handshake failure, or a PcmCapture start failure — the
   * caller (the fallback ladder in live-stt.ts) treats ALL of these as
   * "fall back to Deepgram", exactly like DeepgramLiveTranscriber's own
   * start() contract today.
   */
  async start(stream: MediaStream): Promise<void> {
    const session = await fetchAPI<LiveSttSession>('/api/voice/live-session', {
      method: 'POST',
      body: JSON.stringify({ keyterms: [...this.keyterms] }),
    });
    if (session.engine !== 'openai') {
      // Defensive only — the caller already observed engine:"openai"
      // before constructing this class; a flag flip mid-flight (or a
      // caller that constructs this class directly, bypassing the
      // factory) is the one case this guards against.
      throw new Error(`OpenAILiveTranscriber: server returned engine=${session.engine}`);
    }

    const ws = new WebSocket(OPENAI_TRANSCRIBE_WS_URL, [
      'realtime',
      `openai-insecure-api-key.${session.access_token}`,
    ]);
    this.ws = ws;

    return new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        // Defense-in-depth (specs/live-transcription-plan.md §4.2's
        // documented fallback shape): re-assert the session config as the
        // FIRST WS frame in case the mint only returned a bare secret
        // without actually applying our type:"transcription" payload —
        // unverified against a live key on this machine. Harmless no-op if
        // the mint already applied it. `prompt` is deliberately OMITTED
        // here (composed server-side only from closed-set constants, per
        // app/caddie/keyterms.py's posture) — `keywords` (a literal list,
        // no injection surface) is resent.
        try {
          ws.send(
            JSON.stringify({
              type: 'session.update',
              session: {
                type: 'transcription',
                audio: {
                  input: {
                    format: { type: 'audio/pcm', rate: OPENAI_LIVE_STT_SAMPLE_RATE },
                    transcription: {
                      model: session.model || 'gpt-live-transcribe',
                      languages: ['en'],
                      delay: 'low',
                      keywords: [...this.keyterms],
                    },
                    turn_detection: {
                      type: 'server_vad',
                      threshold: 0.5,
                      prefix_padding_ms: 300,
                      // Mirrors Deepgram's utterance_end_ms=1200
                      // (deepgram-live.ts:41) — preserves hands-free
                      // auto-send timing across the engine swap.
                      silence_duration_ms: 1200,
                    },
                  },
                },
              },
            }),
          );
        } catch {
          /* non-fatal — the mint-time config is the primary path */
        }

        const pcm = new PcmCapture(OPENAI_LIVE_STT_SAMPLE_RATE);
        this.pcm = pcm;
        pcm
          .start(stream, (chunk) => {
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.ws.send(
                JSON.stringify({
                  type: 'input_audio_buffer.append',
                  audio: base64FromInt16(chunk),
                }),
              );
            }
          })
          .then(resolve)
          .catch((err) => {
            const e = err instanceof Error ? err : new Error(String(err));
            this.events.onError?.(e);
            reject(e);
          });
      };

      ws.onerror = () => {
        const err = new Error('OpenAI live-STT WebSocket error');
        this.events.onError?.(err);
        reject(err);
      };

      ws.onclose = () => {
        // Closed cleanly or by stop() — nothing to do (mirrors deepgram-live.ts).
      };

      ws.onmessage = (e) => {
        this.handleMessage(typeof e.data === 'string' ? e.data : '');
      };
    });
  }

  /** Stop streaming. Does NOT stop the passed-in MediaStream (caller-owned,
   *  mirrors deepgram-live.ts's stop() contract exactly). */
  stop(): void {
    try {
      this.pcm?.stop();
    } catch {
      /* ignore */
    }
    this.pcm = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.accumulatedFinals = '';
    this.currentDelta = '';
  }

  // ── Private ───────────────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    let evt: { type?: string; [k: string]: unknown };
    try {
      evt = JSON.parse(raw);
    } catch {
      return;
    }

    switch (evt.type) {
      case 'conversation.item.input_audio_transcription.delta': {
        this.currentDelta += String(evt.delta || '');
        const display = [this.accumulatedFinals, this.currentDelta].filter(Boolean).join(' ');
        if (display) this.events.onInterim?.(display);
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = String(evt.transcript || '');
        if (transcript) {
          this.accumulatedFinals = [this.accumulatedFinals, transcript].filter(Boolean).join(' ');
        }
        this.currentDelta = '';
        if (this.accumulatedFinals) this.events.onFinal?.(this.accumulatedFinals);
        break;
      }
      case 'input_audio_buffer.speech_stopped': {
        // Same guard as deepgram-live.ts:305 — never auto-send silence,
        // only fire when something was actually heard this session.
        if (this.accumulatedFinals || this.currentDelta) this.events.onUtteranceEnd?.();
        break;
      }
      default:
        break;
    }
  }
}
