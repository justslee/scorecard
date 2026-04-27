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
  recordShot,
  sessionRecommend,
  getSessionStatus,
  type RealtimeSessionToken,
} from '@/lib/caddie/api';

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
}

export interface RealtimeCaddieEvents {
  onStatus?: (status: RealtimeStatus) => void;
  onMessage?: (msg: RealtimeMessage) => void;
  onToolCall?: (name: string, args: unknown) => void;
  onError?: (err: Error) => void;
}

export interface RealtimeCaddieOptions {
  roundId: string;
  personalityId: string;
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
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Client ───────────────────────────────────────────────────────────────

const REALTIME_BASE = 'https://api.openai.com/v1/realtime';

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

  constructor(opts: RealtimeCaddieOptions, events: RealtimeCaddieEvents = {}) {
    this.opts = opts;
    this.events = events;
  }

  async start(): Promise<void> {
    if (this.pc) return;
    this.setStatus('connecting');
    try {
      this.token = await startRealtimeSession({
        round_id: this.opts.roundId,
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

      // Remote audio sink
      this.audioEl = document.createElement('audio');
      this.audioEl.autoplay = true;
      this.pc.ontrack = (e) => {
        if (this.audioEl) this.audioEl.srcObject = e.streams[0];
      };

      // Mic
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.localStream.getTracks().forEach((t) => this.pc!.addTrack(t, this.localStream!));

      // Events
      this.dc = this.pc.createDataChannel('oai-events');
      this.dc.onmessage = (e) => this.handleEvent(e.data);

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      const sdpResp = await fetch(`${REALTIME_BASE}?model=${encodeURIComponent(this.token.model)}`, {
        method: 'POST',
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${this.token.client_secret}`,
          'Content-Type': 'application/sdp',
          'OpenAI-Beta': 'realtime=v1',
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
    if (!this.dc || this.dc.readyState !== 'open') return;
    this.dc.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    }));
    this.dc.send(JSON.stringify({ type: 'response.create' }));
  }

  /** Toggle mic mute (audio still flows from server, but server VAD won't pick up the user). */
  setMuted(muted: boolean): void {
    this.localStream?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
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
    }
    this.dc = null;
    this.pc = null;
    this.localStream = null;
    this.audioEl = null;
    this.partials.clear();
  }

  private setStatus(status: RealtimeStatus) {
    this.events.onStatus?.(status);
  }

  private handleEvent(raw: string) {
    let evt: { type: string; [k: string]: unknown };
    try { evt = JSON.parse(raw); } catch { return; }

    switch (evt.type) {
      case 'response.audio_transcript.delta': {
        const id = String(evt.response_id || evt.item_id || 'assistant-current');
        const delta = String(evt.delta || '');
        const existing = this.partials.get(id) ?? { id, role: 'assistant', text: '', partial: true };
        const updated: RealtimeMessage = { ...existing, text: existing.text + delta, partial: true };
        this.partials.set(id, updated);
        this.events.onMessage?.(updated);
        this.setStatus('speaking');
        break;
      }
      case 'response.audio_transcript.done':
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
        const id = String(evt.item_id || `user-${Date.now()}`);
        const text = String(evt.transcript || '');
        if (text) {
          this.events.onMessage?.({ id, role: 'user', text, partial: false });
        }
        break;
      }
      case 'input_audio_buffer.speech_started': {
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
      output = await dispatchTool(name, args, { roundId: this.opts.roundId });
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
