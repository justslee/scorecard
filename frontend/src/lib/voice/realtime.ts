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
  getSessionCarries,
  getSessionBend,
  getSessionPlayerProfile,
  getSessionShotDistance,
  getSessionGreenRead,
  type RealtimeSessionToken,
} from '@/lib/caddie/api';
import { MessageOrderTracker } from '@/lib/voice/realtime-ordering';
import { IdleTimer, REALTIME_IDLE_DISCONNECT_MS } from '@/lib/voice/idle-timer';
import { voiceEvent } from '@/lib/voice/telemetry';
import { isPrimingEcho } from '@/lib/voice/priming-echo';
import { isNoInputClarifier, couldBecomeClarifier, NOINPUT_RESOLVE_GRACE_MS } from '@/lib/voice/noinput-clarifier';

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
  /** Defense-in-depth (specs/caddie-stale-hole-live-plan.md §3.8): the hole the
   *  client believes it is on AT MINT TIME, so the minted instructions'
   *  situation block and `get_conditions` default are also right from the
   *  first turn. Strictly additive — the load-bearing fix is the client-side
   *  `sendContext()` re-anchor (§3.4-3.5), which corrects even a warm-pool
   *  session minted before the hole was known. Optional/back-compatible. */
  currentHole?: number;
}

// ── Tool dispatch ────────────────────────────────────────────────────────

/** Exported for tests — verifies each tool hits the same session endpoint the
 *  text sheet uses (e.g. record_shot → POST /caddie/session/shot dual-write). */
export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { roundId: string; holeYards?: number | null; yardageBasis?: string | null },
): Promise<unknown> {
  switch (name) {
    case 'get_recommendation': {
      // No-fake-data (specs/caddie-numbers-coherence-plan.md §2.1 — root
      // cause of the "125" incident): the live session's resolved yardage +
      // basis, the SAME numbers `buildHoleContextText` already anchors the
      // model with, ride along so the engine's solve and the model's
      // narration can never disagree — never the old fake `yards=400`
      // backend default when the model omits distance_yards.
      return await sessionRecommend({
        round_id: ctx.roundId,
        hole_number: Number(args.hole_number),
        distance_yards: args.distance_yards != null ? Number(args.distance_yards) : undefined,
        yards: ctx.holeYards ?? undefined,
        yardage_basis: ctx.yardageBasis ?? undefined,
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
      // Real along-path carries from the round session's mapped hazards
      // (caddie-tool-loop-parity) — the same carries_payload the text tool
      // loop resolves. Honest empties: available:false when the course isn't
      // mapped, an explicit empty list + note when the hole has no in-play
      // hazards. The persona must never invent a carry number.
      return await getSessionCarries(ctx.roundId, Number(args.hole_number));
    }
    case 'get_bend': {
      // Where/how far the fairway bends — the same bend_payload the text
      // tool loop resolves. Honest empties: available:false when the
      // centerline isn't mapped (distinct from a measured-straight hole).
      // The persona must never invent a dogleg direction or a distance.
      return await getSessionBend(
        ctx.roundId,
        args.hole_number != null ? Number(args.hole_number) : undefined,
      );
    }
    case 'get_shot_distance': {
      // Ball-flight physics for ONE shot (carry/roll/total for a club, or
      // plays-like for a target) — the same shot_distance_payload the text
      // tool loop resolves. The persona must speak these numbers verbatim
      // (PHYSICS_GROUNDING_RULE), never do distance arithmetic itself.
      return await getSessionShotDistance({
        round_id: ctx.roundId,
        hole_number: args.hole_number != null ? Number(args.hole_number) : undefined,
        club: args.club != null ? String(args.club) : undefined,
        target_yards: args.target_yards != null ? Number(args.target_yards) : undefined,
      });
    }
    case 'get_green_read': {
      // Which side of the green leaves the uphill putt — the same
      // green_read_payload the text tool loop resolves. The persona must
      // speak the side verbatim (GREEN_GROUNDING_RULE), never translate a
      // compass slope direction to left/right itself.
      return await getSessionGreenRead({
        round_id: ctx.roundId,
        hole_number: args.hole_number != null ? Number(args.hole_number) : undefined,
      });
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
  // Silent-placeholder AudioContext for the warm path (closed on cleanup).
  private silentCtx: AudioContext | null = null;
  // withholdMic warming is adopted (see attachMic()). Set for BOTH paths (for
  // symmetry) even though only the withheld path needs the later replaceTrack.
  private micTransceiver: RTCRtpTransceiver | null = null;
  // Live partial text by role+response_id to coalesce streamed deltas.
  private partials: Map<string, RealtimeMessage> = new Map();
  // Hands out stable conversation-order keys so the user's turn renders before
  // the reply it triggered, despite the transcript event arriving last.
  private order = new MessageOrderTracker();

  // ── No-input clarifier suppression (specs/caddie-noise-clarification-reply-plan.md) ──
  // Speech turns whose transcript hasn't been classified yet, oldest→newest.
  // Consumed at response.created (most-recent wins, list cleared) to correlate
  // a response with the input turn that triggered it.
  private pendingSpeechItems: string[] = [];
  // item_id → 'real' (non-empty, non-echo transcript) | 'noinput' (empty or
  // priming echo). Written at input_audio_transcription.completed / .failed.
  // Bounded (MAX_INPUT_CLASS_ENTRIES) so an orphaned blip that never becomes
  // anyone's candidate can't grow this for the life of the session — see
  // setInputClass()/evictInputClassOverflow() (specs/caddie-voice-reliability-hardening-plan.md §2).
  private inputClassByItem: Map<string, 'real' | 'noinput'> = new Map();
  private static readonly MAX_INPUT_CLASS_ENTRIES = 64;
  // response_id → the FULL SET of speech item_ids that were candidate
  // triggers for it (a phantom VAD blip mid-real-turn can steal the single
  // most-recent slot — see classifyCandidates() below). Absent = unconditional
  // (typed text, opener, tool follow-up, unknown) — those are NEVER held.
  // An item is a candidate of at most ONE response (the array is snapshotted
  // and pendingSpeechItems cleared at response.created), so pruning a
  // response's entries here can never affect another response
  // (specs/caddie-voice-reliability-hardening-plan.md §1/§2).
  private triggerItemsByResponse: Map<string, string[]> = new Map();
  // Responses whose deltas are being HELD (not yet emitted) pending input
  // classification; `timer` is the finalize-grace release timer.
  private heldResponses: Map<string, { finalized: boolean; timer: ReturnType<typeof setTimeout> | null }> = new Map();
  // response.create messages WE sent (sendText / sendOpener / tool output)
  // whose response.created hasn't arrived yet — those are unconditional.
  private selfTriggeredResponses = 0;

  // Live getter for this turn's resolved hole yardage + basis
  // (specs/caddie-numbers-coherence-plan.md §2.1) — set via setToolContext()
  // by the owning hook (useCaddieLiveSession's holeContextRef), read fresh on
  // every tool dispatch so a hole change or a GPS fix mid-round is reflected
  // immediately, without reconstructing the client.
  private toolContextProvider: (() => { holeYards?: number | null; yardageBasis?: string | null }) | null = null;

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
              current_hole: this.opts.currentHole,
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
        // Preload path: negotiate the audio m-line with a SILENT SYNTHESIZED
        // track (an unconnected AudioContext destination — no getUserMedia,
        // so the iOS mic-permission dialog cannot fire, and the track carries
        // pure silence). attachMic() later replaceTrack()s the real mic in.
        // Why not a track-less transceiver: WebKit doesn't reliably TRANSMIT
        // after replaceTrack on a sender that never had a track (the
        // v1.0.739 'setup voice still deaf' report) — replacing an EXISTING
        // track is the well-supported path everywhere.
        try {
          this.silentCtx = new AudioContext();
          const dest = this.silentCtx.createMediaStreamDestination();
          const silentTrack = dest.stream.getAudioTracks()[0];
          const sender = this.pc.addTrack(silentTrack, dest.stream);
          this.micTransceiver =
            this.pc.getTransceivers().find((t) => t.sender === sender) ?? null;
        } catch {
          // No AudioContext (ancient webview) — fall back to the track-less
          // m-line; attachMic still works on standards-compliant engines.
          this.micTransceiver = this.pc.addTransceiver('audio', { direction: 'sendrecv' });
        }
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
      // A client-triggered response must never be blamed on a stale speech
      // item (specs/caddie-noise-clarification-reply-plan.md §2.3).
      this.selfTriggeredResponses += 1;
      this.pendingSpeechItems = [];
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

  /** Push an authoritative, SILENT context item into the running conversation
   *  (no response.create, no transcript bubble) — re-anchors the model to the
   *  current hole after a hole change or before the opening turn
   *  (specs/caddie-stale-hole-live-plan.md §2/§3.1). */
  sendContext(text: string): void {
    this.idle.touch();
    if (this.dc?.readyState === 'open') {
      this.dc.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text }],
        },
      }));
      // No response.create — silent re-anchor, used on the model's NEXT turn.
    }
  }

  /** Inject the caddie-authored opening greeting: a system-role instruction item
   *  plus response.create so the model SPEAKS the opener in its own voice.
   *  Unlike sendText: role is system (never fabricates a player turn) and NO
   *  local onMessage is emitted — the assistant bubble comes from the model's
   *  own transcript events. Unlike sendContext: it does trigger a response. */
  sendOpener(text: string): void {
    this.idle.touch();
    if (this.dc?.readyState === 'open') {
      this.dc.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] },
      }));
      // Same unconditional treatment as sendText — an opener is never a
      // no-input clarifier candidate.
      this.selfTriggeredResponses += 1;
      this.pendingSpeechItems = [];
      this.dc.send(JSON.stringify({ type: 'response.create' }));
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
      const placeholder = this.micTransceiver.sender.track;
      await this.micTransceiver.sender.replaceTrack(track);
      // Retire the silent placeholder + its context — the real mic owns the
      // sender now.
      try { placeholder?.stop(); } catch { /* gone */ }
      void this.silentCtx?.close().catch(() => {});
      this.silentCtx = null;
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

  /** Bind the live hole-yardage/basis getter (specs/caddie-numbers-coherence
   *  -plan.md §2.1) — the owning surface's OWN resolved-yardage ref, so
   *  `get_recommendation` dispatch always reads the current value, not a
   *  snapshot taken at construction/adoption time. */
  setToolContext(getCtx: () => { holeYards?: number | null; yardageBasis?: string | null }): void {
    this.toolContextProvider = getCtx;
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
    void this.silentCtx?.close().catch(() => {});
    this.silentCtx = null;
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
    // No-input clarifier suppression state — same lifecycle as partials/order.
    for (const held of this.heldResponses.values()) {
      if (held.timer) clearTimeout(held.timer);
    }
    this.heldResponses.clear();
    this.pendingSpeechItems = [];
    this.inputClassByItem.clear();
    this.triggerItemsByResponse.clear();
    this.selfTriggeredResponses = 0;
  }

  private setStatus(status: RealtimeStatus) {
    this.currentStatus = status;
    this.events.onStatus?.(status);
  }

  private handleEvent(raw: string) {
    // A data-channel message already queued when stop() ran still fires this
    // callback (dc.onmessage isn't synchronously unbound by cleanup()). Drop
    // it: cleanup() nulls this.dc, so a null dc means "post-teardown" —
    // otherwise idle.touch() below would re-arm the 90s timer on a dead
    // client (specs/caddie-voice-reliability-hardening-plan.md §4b).
    if (!this.dc) return;
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
        // Correlate this response with the speech turn that triggered it
        // (specs/caddie-noise-clarification-reply-plan.md §2.3) — used by the
        // no-input clarifier hold below. A client-triggered response
        // (sendText / sendOpener / tool follow-up) is unconditional.
        if (respId) {
          if (this.selfTriggeredResponses > 0) {
            this.selfTriggeredResponses -= 1;
          } else {
            // Snapshot the WHOLE pending set as candidates — NOT just the
            // most-recent pop() — so a phantom VAD blip landing between a
            // real turn's commit and this event can't steal sole attribution
            // (specs/caddie-voice-reliability-hardening-plan.md §1).
            const candidates = this.pendingSpeechItems.slice();
            this.pendingSpeechItems = []; // stale items must never leak forward
            if (candidates.length > 0) this.triggerItemsByResponse.set(String(respId), candidates);
          }
        }
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
        const cls = this.classifyCandidates(id);
        // Hold ONLY while the correlated speech turn(s) are not yet proven
        // real AND the text so far still reads as a pure ask-again clarifier.
        // Everything else emits exactly as before
        // (specs/caddie-noise-clarification-reply-plan.md §4). A response with
        // no candidate set (unconditional) always classifies 'real' here, so
        // it's never held. Status still goes 'speaking' — audio IS playing
        // either way.
        if (cls !== 'real' && couldBecomeClarifier(updated.text)) {
          if (!this.heldResponses.has(id)) this.heldResponses.set(id, { finalized: false, timer: null });
        } else {
          if (this.heldResponses.has(id)) this.releaseHeld(id, /* emitFinal */ false); // diverged — flush partial
          this.events.onMessage?.(updated);
        }
        this.setStatus('speaking');
        break;
      }
      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done':
      case 'response.output_text.done':
      case 'response.done': {
        if (!this.opened) break; // dropped while withheld — see delta case above
        // GA `response.done` carries the id at `evt.response.id` (same shape
        // `response.created` already parses) — extend the fallback chain so
        // dropping `output_audio_transcript.done` doesn't strand a partial
        // forever (specs/caddie-voice-reliability-hardening-plan.md §4a).
        const id = String(
          evt.response_id ||
            evt.item_id ||
            (evt.response as { id?: string } | undefined)?.id ||
            'assistant-current',
        );
        const existing = this.partials.get(id);
        if (existing) {
          const held = this.heldResponses.get(id);
          if (held && !held.finalized) {
            // First `done` for a held response — decide now, or arm the
            // grace timer if any candidate's transcript hasn't landed yet
            // (specs/caddie-noise-clarification-reply-plan.md §4).
            const cls = this.classifyCandidates(id);
            if (cls === 'noinput' && isNoInputClarifier(existing.text, false)) {
              this.suppressHeld(id);
            } else if (cls === 'pending') {
              held.finalized = true;
              held.timer = setTimeout(() => this.releaseHeld(id, true), NOINPUT_RESOLVE_GRACE_MS);
            } else {
              // 'real', or noinput-but-not-a-clarifier — emit final below, as today.
              this.releaseHeld(id, false);
              const final: RealtimeMessage = { ...existing, partial: false };
              this.partials.delete(id);
              this.events.onMessage?.(final);
            }
          } else if (!held) {
            const final: RealtimeMessage = { ...existing, partial: false };
            this.partials.delete(id);
            this.events.onMessage?.(final);
            this.finishResponse(id); // never held — no releaseHeld/suppressHeld to prune via
          }
          // else: `held.finalized` already true — a second `done` for the
          // same id (e.g. output_audio_transcript.done then response.done).
          // Inert: the grace timer is already armed (or the hold already
          // resolved and `partials`/`heldResponses` were cleared, so
          // `existing` above would be undefined and we wouldn't be here).
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
        // Classify ONCE, before the existing render logic below — feeds the
        // no-input clarifier correlation (specs/caddie-noise-clarification-reply-plan.md
        // §2.3). "Real" = non-empty and not a priming echo.
        const real = Boolean(text) && !isPrimingEcho(text);
        if (itemId) {
          this.setInputClass(itemId, real ? 'real' : 'noinput');
          this.resolveHeldFor(itemId); // releases or suppresses any held response
        }
        if (text && isPrimingEcho(text)) {
          // gpt-4o-transcribe hallucinating transcription.prompt back as the
          // transcript on a VAD false-trigger (specs/caddie-context-leak-plan.md)
          // — drop before orderForUserTranscript. Ordering-safe: reservations
          // are identity-keyed (realtime-ordering.ts), so the unconsumed
          // speech_started slot for this item_id is simply never looked up.
          voiceEvent('caddie', 'realtime_priming_echo_dropped', { detail: `len=${text.length}` });
          break;
        }
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
      case 'conversation.item.input_audio_transcription.failed': {
        // A failed transcription may have been a genuine garbled utterance —
        // err-keep: classify 'real' so any held clarifier releases immediately
        // instead of waiting out the grace timer.
        if (!this.opened) break;
        const itemId = evt.item_id ? String(evt.item_id) : undefined;
        if (itemId) {
          this.setInputClass(itemId, 'real');
          this.resolveHeldFor(itemId);
        }
        break;
      }
      case 'input_audio_buffer.speech_started': {
        // The user's turn has begun — reserve its order slot now (keyed by the
        // item_id the transcript will carry) so phantom/empty VAD starts can't
        // desync ordering, before the model's response and its late transcript.
        this.order.noteUserTurnStarted(evt.item_id ? String(evt.item_id) : undefined);
        // Track this speech turn as a candidate trigger for the response it's
        // about to prompt (specs/caddie-noise-clarification-reply-plan.md §2.3).
        // No item_id → push nothing; that response becomes unconditional (err-keep).
        if (evt.item_id) this.pendingSpeechItems.push(String(evt.item_id));
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
        const errPayload = evt.error as { type?: string; code?: string; message?: string } | undefined;
        const message = errPayload?.message || 'Realtime error';
        // Breadcrumb only (specs/caddie-stale-hole-live-plan.md observability
        // follow-up) — a rejected conversation.item.create (e.g. the
        // sendContext role:"system" re-anchor) surfaces here as a data-channel
        // `error` event and previously no-op'd with no signal. This does NOT
        // change control flow: no teardown, no role:"user" fallback (yet) —
        // just makes a rejection visible in telemetry. type/code/message only,
        // never the client_secret or any other session data.
        voiceEvent('caddie', 'realtime_dc_error', {
          detail: `type=${errPayload?.type ?? 'unknown'} code=${errPayload?.code ?? 'unknown'} message=${message}`,
        });
        this.events.onError?.(new Error(message));
        break;
      }
      default:
        // ignore — many events (audio/transcription deltas, response.created, etc.) are fine to drop
        break;
    }
  }

  // ── No-input clarifier hold/release/suppress helpers ────────────────────
  // (specs/caddie-noise-clarification-reply-plan.md §4;
  //  specs/caddie-voice-reliability-hardening-plan.md §1/§2)

  /** Aggregate classification of a response's candidate trigger set:
   *  'real' if ANY candidate is proven real (incl. a `.failed` err-keep);
   *  'noinput' only if EVERY candidate is proven noinput; 'pending'
   *  otherwise. A response with no candidate set at all (unconditional —
   *  typed text, opener, tool follow-up) also classifies 'real' here, so the
   *  delta/done branches' `cls !== 'real'` checks naturally never hold it —
   *  same behavior as the old `trigger !== undefined` guard.
   *  Strictly more conservative than the old single-trigger rule: suppression
   *  now requires ALL candidates provably noinput, so a real utterance
   *  anywhere in the attribution window can never have its clarifier
   *  swallowed (specs/caddie-voice-reliability-hardening-plan.md §1). */
  private classifyCandidates(respId: string): 'real' | 'noinput' | 'pending' {
    const candidates = this.triggerItemsByResponse.get(respId);
    if (!candidates || candidates.length === 0) return 'real';
    let anyPending = false;
    for (const itemId of candidates) {
      const cls = this.inputClassByItem.get(itemId);
      if (cls === 'real') return 'real';
      if (cls === undefined) anyPending = true;
    }
    return anyPending ? 'pending' : 'noinput';
  }

  /** Idempotent per-response cleanup, called from every resolution point
   *  (done-branch final-emit, releaseHeld, suppressHeld). Deletes the
   *  response's candidates' `inputClassByItem` entries and the
   *  `triggerItemsByResponse` entry itself — an item is a candidate of at
   *  most ONE response, so this can never delete state another response
   *  still needs to read (specs/caddie-voice-reliability-hardening-plan.md §2). */
  private finishResponse(respId: string): void {
    const candidates = this.triggerItemsByResponse.get(respId);
    if (candidates) {
      for (const itemId of candidates) this.inputClassByItem.delete(itemId);
    }
    this.triggerItemsByResponse.delete(respId);
  }

  /** True iff `itemId` is still a candidate of some not-yet-resolved
   *  response — evictInputClassOverflow() must never remove it even past
   *  the cap (specs/caddie-voice-reliability-hardening-plan.md §2). In
   *  practice `triggerItemsByResponse` holds ~0-1 live entries, so this scan
   *  is trivial. */
  private isLiveCandidate(itemId: string): boolean {
    for (const candidates of this.triggerItemsByResponse.values()) {
      if (candidates.includes(itemId)) return true;
    }
    return false;
  }

  /** Write an item's input classification, then enforce
   *  MAX_INPUT_CLASS_ENTRIES — belt-and-braces for orphans that never became
   *  anyone's candidate (finishResponse already prunes the normal case).
   *  Evicts oldest-first (Map insertion order), skipping any item still
   *  referenced by a live candidate set. */
  private setInputClass(itemId: string, cls: 'real' | 'noinput'): void {
    this.inputClassByItem.set(itemId, cls);
    while (this.inputClassByItem.size > RealtimeCaddieClient.MAX_INPUT_CLASS_ENTRIES) {
      let evicted = false;
      for (const key of this.inputClassByItem.keys()) {
        if (this.isLiveCandidate(key)) continue;
        this.inputClassByItem.delete(key);
        evicted = true;
        break;
      }
      // Everything remaining is a live candidate — correctness wins over the
      // advisory cap; stop rather than evict state edge-1 still needs.
      if (!evicted) break;
    }
  }

  /** Clear the hold's timer + bookkeeping for `id`, then emit its accumulated
   *  partial (and a non-partial final if `emitFinal`). Used when a hold
   *  resolves to real input, diverges from clarifier-shape mid-stream, or the
   *  grace timer times out — every case where the response should surface. */
  private releaseHeld(id: string, emitFinal: boolean): void {
    const held = this.heldResponses.get(id);
    if (held?.timer) clearTimeout(held.timer);
    this.heldResponses.delete(id);
    this.finishResponse(id);
    const msg = this.partials.get(id);
    if (!msg) return;
    this.events.onMessage?.(msg);
    if (emitFinal) {
      const final: RealtimeMessage = { ...msg, partial: false };
      this.partials.delete(id);
      this.events.onMessage?.(final);
    }
  }

  /** Clear the hold's timer + bookkeeping for `id`, drop its accumulated
   *  partial WITHOUT ever emitting it, and log a length-only telemetry
   *  breadcrumb — the actual suppression (mirrors
   *  `realtime_priming_echo_dropped`'s privacy posture: never the text itself). */
  private suppressHeld(id: string): void {
    const held = this.heldResponses.get(id);
    if (held?.timer) clearTimeout(held.timer);
    this.heldResponses.delete(id);
    this.finishResponse(id);
    const msg = this.partials.get(id);
    this.partials.delete(id);
    voiceEvent('caddie', 'realtime_noinput_clarifier_suppressed', { detail: `len=${msg?.text.length ?? 0}` });
  }

  /** Called when a speech turn's input classifies (transcription.completed or
   *  .failed). Scans held responses whose candidate set CONTAINS this item
   *  and — for any that already finalized (their `done` already arrived) —
   *  recomputes the aggregate: 'real' → release; 'noinput' + clarifier-shaped
   *  → suppress; 'pending' → keep waiting (grace timer stays armed). A held
   *  response that hasn't finalized yet (still streaming) is left alone; the
   *  done case decides once it arrives. */
  private resolveHeldFor(itemId: string): void {
    for (const [respId, held] of this.heldResponses) {
      const candidates = this.triggerItemsByResponse.get(respId);
      if (!candidates || !candidates.includes(itemId)) continue;
      if (!held.finalized) continue;
      const cls = this.classifyCandidates(respId);
      if (cls === 'pending') continue; // still waiting on another candidate
      const msg = this.partials.get(respId);
      if (cls === 'noinput' && msg && isNoInputClarifier(msg.text, false)) {
        this.suppressHeld(respId);
      } else {
        this.releaseHeld(respId, true);
      }
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
      const toolCtx = this.toolContextProvider?.() ?? {};
      output = await dispatchTool(name, args, {
        roundId: this.opts.roundId ?? '',
        holeYards: toolCtx.holeYards,
        yardageBasis: toolCtx.yardageBasis,
      });
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
      // A tool follow-up is never a no-input clarifier candidate either.
      this.selfTriggeredResponses += 1;
      this.pendingSpeechItems = [];
      this.dc.send(JSON.stringify({ type: 'response.create' }));
    }
  }
}
