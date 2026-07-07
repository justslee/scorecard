/**
 * Deepgram live-streaming transcriber for on-course voice score entry.
 *
 * Provides INTERIM transcript display while the user speaks — the same role
 * that window.SpeechRecognition used to fill on desktop, but implemented via
 * Deepgram's streaming WebSocket so it works inside iOS Capacitor WKWebView
 * (where Web Speech API is unavailable).
 *
 * Architecture:
 *   Browser                         Our backend          Deepgram
 *   ──────────────────────────────  ───────────────────  ──────────────────
 *   POST /api/voice/live-token  →   grant_live_token()  → short-lived token
 *   new WebSocket(wss://…, ["token", token])  ──────────────────────────→
 *   MediaRecorder chunks  ──────────────────────────────────────────────→
 *   ←──────── interim / final Results JSON ─────────────────────────────
 *
 * The authoritative final transcript flows through the existing VoiceRecorder →
 * /api/voice/transcribe → /api/voice/parse-scores path and is NOT changed here.
 * The live path is display-only; failures degrade silently.
 *
 * Structure mirrors lib/voice/realtime.ts and lib/voice/deepgram.ts.
 */

import { fetchAPI } from '../api';

import { PcmCapture } from './pcm-capture';
import { keytermQuery } from './keyterms';

// ── Constants ────────────────────────────────────────────────────────────────

// wss URL for Deepgram streaming. Query params mirror the one-shot transcribe
// call so model + formatting are consistent across both paths.
const DEEPGRAM_WS_BASE =
  'wss://api.deepgram.com/v1/listen' +
  '?model=nova-3' +
  '&smart_format=true' +
  '&punctuate=true' +
  '&interim_results=true' +
  // End-of-speech signal (fires after this much trailing silence) — powers
  // auto-send in the sheets (specs/voice-agent-audit.md P1.3).
  '&utterance_end_ms=1200' +
  '&language=en-US';

/** Containerized (webm/opus via MediaRecorder) lets Deepgram auto-detect;
 *  the raw-PCM path must declare its encoding explicitly. */
function wsUrlFor(transport: 'webm' | 'pcm', keyterms: readonly string[]): string {
  const base =
    transport === 'pcm'
      ? DEEPGRAM_WS_BASE + '&encoding=linear16&sample_rate=16000&channels=1'
      : DEEPGRAM_WS_BASE;
  // nova-3 keyterm prompting — bias toward golf/context vocabulary.
  return base + keytermQuery(keyterms);
}

/** webm/opus MediaRecorder is the efficient path (Chrome/Android); anything
 *  else (iOS WKWebView records mp4/AAC, which the live socket can't reliably
 *  decode — and a second MediaRecorder on one stream is flaky there anyway)
 *  streams raw PCM tapped via WebAudio. */
function pickTransport(): 'webm' | 'pcm' | null {
  if (
    typeof MediaRecorder !== 'undefined' &&
    typeof MediaRecorder.isTypeSupported === 'function' &&
    MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
  ) {
    return 'webm';
  }
  if (PcmCapture.isSupported()) return 'pcm';
  return null;
}

// How often to slice MediaRecorder chunks and ship them over the WS (ms).
const TIMESLICE_MS = 250;

// ── Types ────────────────────────────────────────────────────────────────────

export interface DeepgramLiveEvents {
  /** Fires frequently while the user speaks with the running accumulated text. */
  onInterim?: (text: string) => void;
  /** Deepgram detected end-of-speech (~1.2s of trailing silence). Only fires
   *  when SOMETHING was heard — silence alone never triggers it here. */
  onUtteranceEnd?: () => void;
  /** Fires when Deepgram finalises a speech segment (is_final = true). */
  onFinal?: (text: string) => void;
  /** Fires on token-fetch or WebSocket error; the final path is unaffected. */
  onError?: (e: Error) => void;
}

interface LiveTokenResponse {
  access_token: string;
  expires_in: number;
}

// ── Pure helper (exported for unit tests) ────────────────────────────────────

/**
 * Parse a raw Deepgram streaming Results message.
 *
 * Returns {transcript, isFinal} or null when the message is not a Results
 * event, carries an empty transcript, or cannot be parsed as JSON.
 * This function NEVER throws — callers may call it unconditionally.
 */
export function parseDeepgramLiveMessage(
  raw: string,
): { transcript: string; isFinal: boolean } | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    typeof msg !== 'object' ||
    msg === null ||
    !('channel' in msg)
  ) {
    return null;
  }

  const record = msg as Record<string, unknown>;
  const channel = record['channel'];
  if (typeof channel !== 'object' || channel === null) return null;

  const alternatives = (channel as Record<string, unknown>)['alternatives'];
  if (!Array.isArray(alternatives) || alternatives.length === 0) return null;

  const first = alternatives[0] as Record<string, unknown>;
  const transcript = typeof first['transcript'] === 'string' ? first['transcript'] : '';

  // Empty transcript (Deepgram sends these for silence); nothing to display.
  if (!transcript) return null;

  const isFinal = record['is_final'] === true;
  return { transcript, isFinal };
}

// ── Mime picker (mirrors deepgram.ts) ────────────────────────────────────────

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return undefined;
}

// ── DeepgramLiveTranscriber ───────────────────────────────────────────────────

export class DeepgramLiveTranscriber {
  private events: DeepgramLiveEvents;
  private ws: WebSocket | null = null;
  private recorder: MediaRecorder | null = null;
  private pcm: PcmCapture | null = null;
  // Running accumulation of is_final segments so interim display shows the
  // full sentence so far, not just the current partial.
  private accumulatedFinals = '';
  private latestInterim = '';

  private keyterms: readonly string[];

  constructor(events: DeepgramLiveEvents, opts?: { keyterms?: readonly string[] }) {
    this.events = events;
    this.keyterms = opts?.keyterms ?? [];
  }

  /**
   * True when both WebSocket and MediaRecorder are available.
   * Static so callers can feature-detect before instantiating.
   */
  static isSupported(): boolean {
    return typeof WebSocket !== 'undefined' && pickTransport() !== null;
  }

  /**
   * Start streaming audio from an EXISTING MediaStream to Deepgram.
   *
   * Accepts a stream already opened by VoiceRecorder so we do NOT call
   * getUserMedia twice (which would request a second mic permission on some
   * devices and create an echo).
   *
   * Fetches a short-lived token from /api/voice/live-token, opens the WS,
   * then attaches a MediaRecorder in 250ms timeslice mode.
   *
   * Throws on token-fetch failure or WS error — caller should wrap in
   * try/catch and treat all failures as non-fatal (the final path is
   * authoritative; worst case = no live display, scoring unchanged).
   */
  async start(stream: MediaStream): Promise<void> {
    // Fetch a short-lived token from our backend (keeps the API key server-side).
    const { access_token: token } = await fetchAPI<LiveTokenResponse>(
      '/api/voice/live-token',
      { method: 'POST' },
    );

    const transport = pickTransport();
    if (!transport) throw new Error('No live-audio transport available');

    // Open the WebSocket. Deepgram browser auth uses the 'token' subprotocol
    // because browsers cannot set an Authorization header on a WebSocket.
    const ws = new WebSocket(wsUrlFor(transport, this.keyterms), ['token', token]);
    this.ws = ws;

    return new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        if (transport === 'pcm') {
          // Raw linear16 tapped via WebAudio (see pickTransport rationale).
          const pcm = new PcmCapture();
          this.pcm = pcm;
          pcm
            .start(stream, (chunk) => {
              if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(chunk.buffer);
              }
            })
            .then(resolve)
            .catch((err) => {
              this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
              reject(err instanceof Error ? err : new Error(String(err)));
            });
          return;
        }
        // webm/opus — chunk mic audio via MediaRecorder.
        const mimeType = pickMimeType();
        const recorder = new MediaRecorder(
          stream,
          mimeType ? { mimeType } : undefined,
        );
        this.recorder = recorder;

        recorder.ondataavailable = (e) => {
          if (
            e.data &&
            e.data.size > 0 &&
            this.ws?.readyState === WebSocket.OPEN
          ) {
            this.ws.send(e.data);
          }
        };

        recorder.onerror = () => {
          // MediaRecorder errors are non-fatal: the final path is unaffected.
          this.events.onError?.(new Error('MediaRecorder error'));
        };

        recorder.start(TIMESLICE_MS);
        resolve();
      };

      ws.onerror = () => {
        const err = new Error('Deepgram WebSocket error');
        this.events.onError?.(err);
        reject(err);
      };

      ws.onclose = () => {
        // Closed cleanly or by stop() — nothing to do.
      };

      ws.onmessage = (e) => {
        this.handleMessage(typeof e.data === 'string' ? e.data : '');
      };
    });
  }

  /**
   * Stop streaming. Stops the MediaRecorder, sends a CloseStream signal to
   * Deepgram, and closes the WebSocket.
   *
   * Does NOT stop the passed-in MediaStream — VoiceRecorder owns it and will
   * stop it when the authoritative recording finishes.
   */
  stop(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch { /* ignore */ }
    }
    try { this.pcm?.stop(); } catch { /* ignore */ }
    this.pcm = null;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch { /* ignore */ }
    }
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.recorder = null;
    this.accumulatedFinals = '';
    this.latestInterim = '';
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    // UtteranceEnd frames have no channel/alternatives — check them first.
    try {
      const frame = JSON.parse(raw) as { type?: string };
      if (frame && frame.type === 'UtteranceEnd') {
        // Guard: never auto-send silence — only fire when words were heard.
        if (this.accumulatedFinals || this.latestInterim) {
          this.events.onUtteranceEnd?.();
        }
        return;
      }
    } catch {
      /* fall through to the transcript parser */
    }
    const parsed = parseDeepgramLiveMessage(raw);
    if (!parsed) return;

    const { transcript, isFinal } = parsed;

    if (isFinal) {
      // Append to running accumulation; clear the in-progress interim.
      this.accumulatedFinals = [this.accumulatedFinals, transcript]
        .filter(Boolean)
        .join(' ');
      this.latestInterim = '';
      this.events.onFinal?.(this.accumulatedFinals);
    } else {
      // Interim: show accumulated finals + current partial so the user sees
      // the full in-progress sentence, not just the latest fragment.
      this.latestInterim = transcript;
      const display = [this.accumulatedFinals, this.latestInterim]
        .filter(Boolean)
        .join(' ');
      if (display) this.events.onInterim?.(display);
    }
  }
}
