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
  getSessionConditions,
  getSessionPlayerProfile,
  type RealtimeSessionToken,
} from '@/lib/caddie/api';
import { MessageOrderTracker } from '@/lib/voice/realtime-ordering';
import { IdleTimer, REALTIME_IDLE_DISCONNECT_MS } from '@/lib/voice/idle-timer';

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
  /** Fired once the ephemeral client_secret has been minted — the transport
   *  ladder uses this to cancel its 3s mint deadline (see lib/caddie/transport.ts). */
  onMinted?: () => void;
}

export interface RealtimeCaddieOptions {
  /** Required in 'caddie' mode; unused in 'setup' mode (no round exists yet). */
  roundId?: string;
  personalityId: string;
  /** 'caddie' (default) = in-round caddie; 'setup' = round-less voice round setup. */
  mode?: 'caddie' | 'setup';
  /**
   * Preload mode (lib/voice/warm-session.ts): mint + connect WITHOUT ever
   * calling getUserMedia. start() adds a track-less audio transceiver instead
   * of a mic track, and output stays muted. Nothing is "open" until a caller
   * invokes attachMic() — until then getUserMedia is never called, no audio
   * frame is transmitted, and transcript/assistant events are dropped. This is
   * the structural guarantee the forbidden mic-live warm shortcut lacked.
   */
  withholdMic?: boolean;
}

// ── Tool dispatch ────────────────────────────────────────────────────────

/** Exported for tests — verifies each tool hits the same session endpoint the
 *  text sheet uses (e.g. record_shot → POST /caddie/session/shot dual-write). */
export async function dispatchTool(
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
      // Same endpoint as the sheet's shot logging — dual-writes the session
      // history AND the durable shots table (feeds post-round learning).
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
    case 'get_conditions': {
      return await getSessionConditions(
        ctx.roundId,
        args.hole_number != null ? Number(args.hole_number) : undefined,
      );
    }
    case 'get_player_profile': {
      return await getSessionPlayerProfile(ctx.roundId);
    }
    case 'get_carries': {
      // P2 STUB — real per-(hole, tee) carries land in P3 (ingest-precomputed
      // PostGIS intersections). The instructions require the persona to say
      // carries aren't available here, never to invent a number.
      return {
        available: false,
        reason: 'Carry distances are not mapped for this course yet.',
      };
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

// Hard cap: ONE live Realtime connection per app, ever (cost + the iOS
// double-audio failure mode). Starting a new client stops any previous one.
let activeRealtimeClient: RealtimeCaddieClient | null = null;

export class RealtimeCaddieClient {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private localStream: MediaStream | null = null;
  private token: RealtimeSessionToken | null = null;
  private events: RealtimeCaddieEvents;
  private opts: RealtimeCaddieOptions;
  // Most recent status pushed to `events.onStatus` — lets an adopting surface
  // (warm-session.ts takeWarm()) repaint the CURRENT state immediately via
  // emitCurrentStatus() instead of waiting for the next status change.
  private currentStatus: RealtimeStatus = 'idle';
  // True once the mic is live (attachMic() has run, or withholdMic was never
  // set). While false: no getUserMedia has been called, no audio frame has
  // been sent, and handleEvent() drops transcript/assistant-transcript events
  // — the structural guarantee that a warm/preloaded session cannot leak a
  // phantom transcript before the user actually opens the mic.
  private opened: boolean;
  // The audio transceiver used to attach the mic without renegotiation once
  // withholdMic warming is adopted (see attachMic()). Set for BOTH paths (for
  // symmetry) even though only the withheld path needs the later replaceTrack.
  private micTransceiver: RTCRtpTransceiver | null = null;
  // Live partial text by role+response_id to coalesce streamed deltas.
  private partials: Map<string, RealtimeMessage> = new Map();
  // Hands out stable conversation-order keys so the user's turn renders before
  // the reply it triggered, despite the transcript event arriving last.
  private order = new MessageOrderTracker();
  // Cost control: disconnect after 90s with no conversation activity. The
  // connection is an ephemeral burst — a later press simply reconnects.
  private idle = new IdleTimer(() => this.stop(), REALTIME_IDLE_DISCONNECT_MS);

  // The in-flight start() — attachMic() must await it so an adoption that
  // happens mid-mint (takeWarm returns WARMING clients) never runs against a
  // half-built connection (null micTransceiver → mic silently never attached
  // → "won't listen": the v1.0.710 regression).
  private startPromise: Promise<void> | null = null;

  constructor(opts: RealtimeCaddieOptions, events: RealtimeCaddieEvents = {}) {
    this.opts = opts;
    this.events = events;
    this.opened = !opts.withholdMic;
  }

  async start(): Promise<void> {
    if (this.pc) return;
    if (!this.startPromise) {
      this.startPromise = this.startInner().finally(() => {
        this.startPromise = null;
      });
    }
    return this.startPromise;
  }

  private async startInner(): Promise<void> {
    if (this.pc) return;
    // Enforce the one-connection cap BEFORE any resources are acquired.
    if (activeRealtimeClient && activeRealtimeClient !== this) {
      activeRealtimeClient.stop();
    }
    // Module-level singleton registry, not a `self = this` alias — the cap
    // must outlive any one instance (round orb vs setup flow).
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    activeRealtimeClient = this;
    this.setStatus('connecting');
    try {
      this.token =
        this.opts.mode === 'setup'
          ? await startSetupSession({ personality_id: this.opts.personalityId })
          : await startRealtimeSession({
              round_id: this.opts.roundId ?? '',
              personality_id: this.opts.personalityId,
            });
      this.events.onMinted?.();

      this.pc = new RTCPeerConnection();
      this.pc.onconnectionstatechange = () => {
        const state = this.pc?.connectionState;
        if (state === 'connected') {
          this.idle.touch(); // arm the 90s idle disconnect from first connect
          this.setStatus('connected');
        } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
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

      if (this.opts.withholdMic) {
        // Preload path: add the audio m-line with NO track and skip
        // getUserMedia entirely — the iOS mic-permission dialog cannot fire
        // and zero audio frames are transmitted. attachMic() later calls
        // replaceTrack() on this SAME transceiver, so opening the mic needs
        // no renegotiation (no second createOffer/setLocalDescription).
        this.micTransceiver = this.pc.addTransceiver('audio', { direction: 'sendrecv' });
        this.setOutputMuted(true); // caddie stays silent until the sheet actually opens
      } else {
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
        const senders = this.localStream
          .getTracks()
          .map((t) => this.pc!.addTrack(t, this.localStream!));
        // Set for symmetry with the withheld path (unused today, but keeps
        // attachMic()'s replaceTrack() valid if ever called on a hot client).
        this.micTransceiver =
          this.pc.getTransceivers().find((tr) => tr.sender === senders[0]) ?? null;
      }

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
    this.idle.touch();
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
    // Unmuting = the player is (about to be) talking — that's activity.
    if (!muted) this.idle.touch();
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

  /**
   * Open the mic on a warm (withheld) session: acquire it now (THE ONLY
   * getUserMedia call for this client), attach it to the pre-negotiated audio
   * transceiver with replaceTrack() (no renegotiation), unmute output, and lift
   * the transcript gate. No-op if the mic is already open. Rejection (e.g.
   * permission denied) mirrors start()'s failure path — error status, onError,
   * cleanup, rethrow — so an adopting surface's EXISTING error handling (setup
   * sheet's error UI / orb's CONNECT_FAILED degrade) just works unchanged.
   */
  async attachMic(): Promise<void> {
    if (this.opened) return;
    try {
      // A WARMING client can be adopted mid-start() (mint in flight, pc and
      // micTransceiver not built yet). Wait for it — otherwise the track
      // below would never be attached and the model would hear NOTHING while
      // the UI reads connected (the v1.0.710 "won't listen" regression).
      const inFlight = this.startPromise;
      if (inFlight) await inFlight;

      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const track = this.localStream.getAudioTracks()[0];
      if (!track || !this.micTransceiver) {
        // Never "succeed" without a live mic path — a silent skip here is a
        // dead sheet that looks connected.
        throw new Error('attachMic: no mic track or negotiated transceiver');
      }
      await this.micTransceiver.sender.replaceTrack(track);
      this.opened = true;
      this.setOutputMuted(false);
      this.idle.touch();
    } catch (err) {
      this.setStatus('error');
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
      this.cleanup();
      throw err;
    }
  }

  /** Rebind event handlers — used when an adopting surface takes over a warm
   *  client that the manager created with its own (minimal) handlers. */
  setEvents(events: RealtimeCaddieEvents): void {
    this.events = events;
  }

  /** Re-emit the current status to whichever handler is bound RIGHT NOW — lets
   *  an adopting surface paint "Ready — go ahead" immediately after setEvents()
   *  instead of waiting for the next status transition (which may never come
   *  again if the connection is already settled). */
  emitCurrentStatus(): void {
    this.events.onStatus?.(this.currentStatus);
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
    this.idle.cancel();
    if (activeRealtimeClient === this) activeRealtimeClient = null;
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
    this.currentStatus = status;
    this.events.onStatus?.(status);
  }

  private handleEvent(raw: string) {
    let evt: { type: string; [k: string]: unknown };
    try { evt = JSON.parse(raw); } catch { return; }

    // Any conversation event counts as activity for the idle disconnect.
    this.idle.touch();

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
        // Belt for the withheld-mic warm path: even with output muted, drop
        // any pre-open greeting delta rather than surface it once opened.
        if (!this.opened) break;
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
        if (!this.opened) break; // dropped while withheld — see delta case above
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
        // THE invariant this guards: with the mic withheld, no audio is ever
        // sent, so this should never fire pre-open — but drop it anyway
        // rather than trust that alone (belt-and-braces, see the plan).
        if (!this.opened) break;
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
        // Same pre-open gate as the transcript events: a not-yet-adopted warm
        // session must never dispatch tools (defense in depth — no audio can
        // reach the model pre-open, so nothing should arrive here anyway).
        if (!this.opened) break;
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
