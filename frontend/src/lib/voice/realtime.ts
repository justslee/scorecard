/**
 * OpenAI Realtime WebRTC client for the conversational caddie.
 *
 * The browser opens a peer connection directly to OpenAI using a 60-second
 * ephemeral client_secret minted by our backend at /api/realtime/session.
 *
 * Flow per turn:
 *   - mic audio streams to OpenAI
 *   - OpenAI speaks back (audio plays through a hidden <audio> element)
 *   - tool calls arrive on the data channel; we dispatch them to FastAPI and
 *     post the result back to the model
 */

import {
  startRealtimeSession,
  startSetupSession,
  recordShot,
  sessionRecommend,
  getSessionStatus,
  type RealtimeSessionToken,
} from '@/lib/caddie/api';
import { MessageOrderTracker } from '@/lib/voice/realtime-ordering';

// ── Public types ─────────────────────────────────────────────────────────

export type RealtimeStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'speaking'
  | 'listening'
  | 'closed'
  | 'error';

export interface RealtimeMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  partial?: boolean;
  /**
   * Stable conversation-order key. Render sorted by this — NOT arrival order —
   * because the user's transcript event lands after the reply it triggered.
   * See lib/voice/realtime-ordering.ts.
   */
  order: number;
}

export interface RealtimeCaddieEvents {
  onStatus?: (status: RealtimeStatus) => void;
  onMessage?: (msg: RealtimeMessage) => void;
  onToolCall?: (name: string, args: unknown) => void;
  onError?: (err: Error) => void;
}

export interface RealtimeCaddieOptions {
  /** Required in 'caddie' mode; unused in 'setup' mode (no round exists yet). */
  roundId?: string;
  personalityId: string;
  /** 'caddie' (default) = in-round caddie; 'setup' = round-less voice round setup. */
  mode?: 'caddie' | 'setup';
}

// ── Tool dispatch ────────────────────────────────────────────────────────

async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { roundId: string },
): Promise<unknown> {
  switch (name) {
    case 'get_recommendation': {
      return await sessionRecommend({
        round_id: ctx.roundId,
        hole_number: Number(args.hole_number),
        distance_yards: args.distance_yards != null ? Number(args.distance_yards) : undefined,
      });
    }
    case 'record_shot': {
      return await recordShot({
        round_id: ctx.roundId,
        hole_number: Number(args.hole_number),
        club: String(args.club),
        distance_yards: Number(args.distance_yards),
        result: args.result != null ? String(args.result) : undefined,
      });
    }
    case 'get_session_status': {
      return await getSessionStatus(ctx.roundId);
    }
    case 'set_round_setup': {
      // Handled entirely on the client: the component builds + creates the round
      // from these args via onToolCall. Just ack so the model can wrap up.
      return { ok: true };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Client ───────────────────────────────────────────────────────────────

// GA WebRTC connect endpoint. (Legacy used `${REALTIME_BASE}?model=…`; GA puts
// the model in the minted session, so the browser POSTs the SDP offer to /calls.)
const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

export class RealtimeCaddieClient {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private localStream: MediaStream | null = null;
  private token: RealtimeSessionToken | null = null;
  private events: RealtimeCaddieEvents;
  private opts: RealtimeCaddieOptions;
  // Live partial text by role+response_id to coalesce streamed deltas.
  private partials: Map<string, RealtimeMessage> = new Map();
  // Hands out stable conversation-order keys so the user's turn renders before
  // the reply it triggered, despite the transcript event arriving last.
  private order = new MessageOrderTracker();

  constructor(opts: RealtimeCaddieOptions, events: RealtimeCaddieEvents = {}) {
    this.opts = opts;
    this.events = events;
  }

  async start(): Promise<void> {
    if (this.pc) return;
    this.setStatus('connecting');
    try {
      this.token =
        this.opts.mode === 'setup'
          ? await startSetupSession({ personality_id: this.opts.personalityId })
          : await startRealtimeSession({
              round_id: this.opts.roundId ?? '',
              personality_id: this.opts.personalityId,
            });

      this.pc = new RTCPeerConnection();
      this.pc.onconnectionstatechange = () => {
        const state = this.pc?.connectionState;
        if (state === 'connected') this.setStatus('connected');
        else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
          this.setStatus('closed');
        }
      };

      // Remote audio sink — a SINGLE, controlled, in-DOM element.
      // iOS WKWebView only reliably renders a remote WebRTC track through an
      // <audio> element that is ATTACHED to the document. A detached autoplay
      // element (the previous code) can leave the track to also be rendered by
      // the audio session, producing two slightly-offset copies — the "two
      // overlapping voices" the owner hears. Keep exactly one hidden, inline,
      // autoplaying sink, set srcObject once, and remove it on cleanup so a
      // reconnect (e.g. warm preload) never stacks a second sink.
      this.audioEl = document.createElement('audio');
      this.audioEl.autoplay = true;
      this.audioEl.setAttribute('playsinline', ''); // inline playback on iOS WKWebView
      this.audioEl.style.display = 'none';
      document.body.appendChild(this.audioEl);
      this.pc.ontrack = (e) => {
        // Idempotent: only (re)assign if it's a different stream, so a second
        // ontrack can't introduce another playback of the same audio.
        if (this.audioEl && this.audioEl.srcObject !== e.streams[0]) {
          this.audioEl.srcObject = e.streams[0];
        }
      };

      // Mic — echo cancellation is ESSENTIAL: without it the phone speaker's
      // caddie audio is picked up by the mic, transcribed as the user's turn, and
      // the model replies to its own echo (garbled, out-of-order conversation).
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      this.localStream.getTracks().forEach((t) => this.pc!.addTrack(t, this.localStream!));

      // Events
      this.dc = this.pc.createDataChannel('oai-events');
      this.dc.onmessage = (e) => this.handleEvent(e.data);

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      const sdpResp = await fetch(REALTIME_CALLS_URL, {
        method: 'POST',
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${this.token.client_secret}`,
          'Content-Type': 'application/sdp',
        },
      });
      if (!sdpResp.ok) throw new Error(`Realtime SDP exchange failed: ${sdpResp.status} ${await sdpResp.text()}`);
      const answer = { type: 'answer' as RTCSdpType, sdp: await sdpResp.text() };
      await this.pc.setRemoteDescription(answer);
    } catch (err) {
      this.setStatus('error');
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
      this.cleanup();
      throw err;
    }
  }

  /** Send a typed text message (alternative to voice input). */
  sendText(text: string): void {
    const open = this.dc?.readyState === 'open';
    if (open) {
      this.dc!.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        },
      }));
      this.dc!.send(JSON.stringify({ type: 'response.create' }));
    }
    // Surface the typed line in the transcript regardless of channel state (so
    // the user always sees what they typed), ordered before the reply it
    // triggers. Centralized here so ordering matches the voice path.
    if (text) {
      this.events.onMessage?.({
        id: `user-typed-${Date.now()}`,
        role: 'user',
        text,
        partial: false,
        order: this.order.orderForTypedUser(),
      });
    }
  }

  /** Toggle mic mute (audio still flows from server, but server VAD won't pick up the user). */
  setMuted(muted: boolean): void {
    this.localStream?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  }

  /** Silence the caddie's voice output — used while the session is warming in the
   *  background (preloaded) so the greeting doesn't play before the sheet opens. */
  setOutputMuted(muted: boolean): void {
    if (this.audioEl) this.audioEl.muted = muted;
  }

  /** True once a peer connection exists (connecting or live) — used to decide
   *  whether a warm preload already established the session. */
  isActive(): boolean {
    return this.pc !== null;
  }

  isMuted(): boolean {
    const tracks = this.localStream?.getAudioTracks() ?? [];
    return tracks.length > 0 && tracks.every((t) => !t.enabled);
  }

  stop(): void {
    this.cleanup();
    this.setStatus('closed');
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private cleanup() {
    try { this.dc?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    this.localStream?.getTracks().forEach((t) => t.stop());
    if (this.audioEl) {
      try { this.audioEl.srcObject = null; } catch {}
      // Remove the element from the DOM so reconnects don't stack sinks.
      try { this.audioEl.remove(); } catch {}
    }
    this.dc = null;
    this.pc = null;
    this.localStream = null;
    this.audioEl = null;
    this.partials.clear();
    this.order.reset();
  }

  private setStatus(status: RealtimeStatus) {
    this.events.onStatus?.(status);
  }

  private handleEvent(raw: string) {
    let evt: { type: string; [k: string]: unknown };
    try { evt = JSON.parse(raw); } catch { return; }

    switch (evt.type) {
      case 'response.created': {
        // Reserve the response's order slot as soon as it begins — before its
        // deltas (and before the user transcript that triggered it) arrive.
        const respId = (evt.response as { id?: string } | undefined)?.id;
        if (respId) this.order.orderForResponse(String(respId));
        break;
      }
      case 'response.audio_transcript.delta':
      case 'response.output_audio_transcript.delta': {
        const id = String(evt.response_id || evt.item_id || 'assistant-current');
        const delta = String(evt.delta || '');
        const existing =
          this.partials.get(id) ??
          ({ id, role: 'assistant', text: '', partial: true, order: this.order.orderForResponse(id) } as RealtimeMessage);
        const updated: RealtimeMessage = { ...existing, text: existing.text + delta, partial: true };
        this.partials.set(id, updated);
        this.events.onMessage?.(updated);
        this.setStatus('speaking');
        break;
      }
      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done':
      case 'response.output_text.done':
      case 'response.done': {
        const id = String(evt.response_id || evt.item_id || 'assistant-current');
        const existing = this.partials.get(id);
        if (existing) {
          const final: RealtimeMessage = { ...existing, partial: false };
          this.partials.delete(id);
          this.events.onMessage?.(final);
        }
        this.setStatus('connected');
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const itemId = evt.item_id ? String(evt.item_id) : undefined;
        const id = itemId ?? `user-${Date.now()}`;
        const text = String(evt.transcript || '');
        if (text) {
          this.events.onMessage?.({
            id,
            role: 'user',
            text,
            partial: false,
            // Identity-matched to this turn's speech_started by item_id.
            order: this.order.orderForUserTranscript(itemId),
          });
        }
        break;
      }
      case 'input_audio_buffer.speech_started': {
        // The user's turn has begun — reserve its order slot now (keyed by the
        // item_id the transcript will carry) so phantom/empty VAD starts can't
        // desync ordering, before the model's response and its late transcript.
        this.order.noteUserTurnStarted(evt.item_id ? String(evt.item_id) : undefined);
        this.setStatus('listening');
        break;
      }
      case 'input_audio_buffer.speech_stopped': {
        this.setStatus('connected');
        break;
      }
      case 'response.function_call_arguments.done': {
        void this.runTool(evt);
        break;
      }
      case 'error': {
        const message = (evt.error as { message?: string } | undefined)?.message || 'Realtime error';
        this.events.onError?.(new Error(message));
        break;
      }
      default:
        // ignore — many events (audio/transcription deltas, response.created, etc.) are fine to drop
        break;
    }
  }

  private async runTool(evt: Record<string, unknown>): Promise<void> {
    const name = String(evt.name || '');
    const callId = String(evt.call_id || '');
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(String(evt.arguments || '{}'));
    } catch {
      args = {};
    }
    this.events.onToolCall?.(name, args);

    let output: unknown;
    try {
      output = await dispatchTool(name, args, { roundId: this.opts.roundId ?? '' });
    } catch (e) {
      output = { error: e instanceof Error ? e.message : String(e) };
    }

    if (this.dc?.readyState === 'open') {
      this.dc.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify(output),
        },
      }));
      this.dc.send(JSON.stringify({ type: 'response.create' }));
    }
  }
}
