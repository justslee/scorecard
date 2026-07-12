// @vitest-environment jsdom
//
// RealtimeCaddieClient's withholdMic / attachMic() preload path
// (specs/caddie-preload-plan.md). Mocks RTCPeerConnection + mediaDevices —
// neither exists in jsdom — so the warm lifecycle can be driven deterministically.
//
// THE load-bearing test in this file is "never fires onMessage for a
// transcript event received before attachMic()" — the executable version of
// the plan's forbidden-shortcut guard: a warm session must be STRUCTURALLY
// incapable of surfacing a phantom transcript, not merely unlikely to.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/caddie/api', () => ({
  startRealtimeSession: vi.fn(async () => ({ client_secret: 'secret-caddie' })),
  startSetupSession: vi.fn(async () => ({ client_secret: 'secret-setup' })),
}));

import { RealtimeCaddieClient, type RealtimeMessage, type RealtimeStatus } from './realtime';

// ── Fake WebRTC plumbing ─────────────────────────────────────────────────

class FakeSender {
  track: MediaStreamTrack | null;
  replaceTrack = vi.fn(async (t: MediaStreamTrack | null) => {
    this.track = t;
  });
  constructor(track: MediaStreamTrack | null = null) {
    this.track = track;
  }
}

class FakeTransceiver {
  sender: FakeSender;
  constructor(track: MediaStreamTrack | null = null) {
    this.sender = new FakeSender(track);
  }
}

class FakeDataChannel {
  onmessage: ((e: { data: string }) => void) | null = null;
  readyState: 'open' | 'closed' = 'open';
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 'closed';
  });
  /** Test helper — simulate an incoming Realtime server event. */
  emit(evt: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(evt) });
  }
}

class FakePeerConnection {
  connectionState: RTCPeerConnectionState = 'new';
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((e: { streams: MediaStream[] }) => void) | null = null;
  transceivers: FakeTransceiver[] = [];
  dataChannel: FakeDataChannel | null = null;
  closed = false;

  addTransceiver = vi.fn((_kind: string, _opts?: unknown) => {
    const tr = new FakeTransceiver(null);
    this.transceivers.push(tr);
    return tr as unknown as RTCRtpTransceiver;
  });

  addTrack = vi.fn((track: MediaStreamTrack, _stream: MediaStream) => {
    const tr = new FakeTransceiver(track);
    this.transceivers.push(tr);
    return tr.sender as unknown as RTCRtpSender;
  });

  getTransceivers = vi.fn(() => this.transceivers as unknown as RTCRtpTransceiver[]);

  createDataChannel = vi.fn((_label: string) => {
    this.dataChannel = new FakeDataChannel();
    return this.dataChannel as unknown as RTCDataChannel;
  });

  createOffer = vi.fn(async () => ({ type: 'offer' as RTCSdpType, sdp: 'fake-offer-sdp' }));
  setLocalDescription = vi.fn(async () => {});
  setRemoteDescription = vi.fn(async () => {});
  close = vi.fn(() => {
    this.closed = true;
  });

  /** Test helper — simulate ICE/DTLS reaching 'connected'. */
  goConnected() {
    this.connectionState = 'connected';
    this.onconnectionstatechange?.();
  }
}

function fakeTrack(): MediaStreamTrack {
  return { stop: vi.fn(), enabled: true } as unknown as MediaStreamTrack;
}

function fakeStream(): MediaStream {
  const track = fakeTrack();
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
}

let lastPc: FakePeerConnection | null = null;

// A real `class` (not an arrow-fn factory) so `new RTCPeerConnection()` in
// realtime.ts works — constructors that explicitly return an object override
// the default `this`, which is how this hands back the tracked FakePeerConnection.
class RTCPeerConnectionMock {
  constructor() {
    lastPc = new FakePeerConnection();
    return lastPc as unknown as RTCPeerConnectionMock;
  }
}

beforeEach(() => {
  vi.stubGlobal('RTCPeerConnection', RTCPeerConnectionMock);
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => 'fake-answer-sdp',
  })));
  vi.stubGlobal('navigator', {
    onLine: true,
    mediaDevices: {
      getUserMedia: vi.fn(async () => fakeStream()),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  lastPc = null;
});

describe('RealtimeCaddieClient — withholdMic preload', () => {
  it('start() with withholdMic never calls getUserMedia and adds a track-less transceiver', async () => {
    const client = new RealtimeCaddieClient(
      { mode: 'setup', personalityId: 'classic', withholdMic: true },
      {},
    );
    await client.start();

    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(lastPc!.addTransceiver).toHaveBeenCalledWith('audio', { direction: 'sendrecv' });
    expect(lastPc!.addTrack).not.toHaveBeenCalled();
    const tr = lastPc!.transceivers[0];
    expect(tr.sender.track).toBeNull();
  });

  it('start() WITHOUT withholdMic calls getUserMedia and attaches the mic track immediately (existing cold path unchanged)', async () => {
    const client = new RealtimeCaddieClient({ mode: 'setup', personalityId: 'classic' }, {});
    await client.start();

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(lastPc!.addTrack).toHaveBeenCalledTimes(1);
  });

  it('output is muted at warm start and unmuted only after attachMic()', async () => {
    const client = new RealtimeCaddieClient(
      { mode: 'setup', personalityId: 'classic', withholdMic: true },
      {},
    );
    await client.start();
    // The remote <audio> sink is created in start(); jsdom lets us inspect it
    // via the DOM directly since realtime.ts appends it to document.body.
    const audioEl = document.querySelector('audio');
    expect(audioEl).not.toBeNull();
    expect(audioEl!.muted).toBe(true);

    await client.attachMic();
    expect(audioEl!.muted).toBe(false);
  });

  it('attachMic() calls getUserMedia exactly once and replaceTrack()s the EXISTING sender — no second setLocalDescription (no renegotiation)', async () => {
    const client = new RealtimeCaddieClient(
      { mode: 'setup', personalityId: 'classic', withholdMic: true },
      {},
    );
    await client.start();
    expect(lastPc!.setLocalDescription).toHaveBeenCalledTimes(1);

    const tr = lastPc!.transceivers[0];
    await client.attachMic();

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(tr.sender.replaceTrack).toHaveBeenCalledTimes(1);
    expect(tr.sender.track).not.toBeNull();
    // Still exactly one negotiation — replaceTrack never triggers renegotiation.
    expect(lastPc!.setLocalDescription).toHaveBeenCalledTimes(1);
    expect(lastPc!.createOffer).toHaveBeenCalledTimes(1);
  });

  it('attachMic() is idempotent — calling it twice only acquires the mic once', async () => {
    const client = new RealtimeCaddieClient(
      { mode: 'setup', personalityId: 'classic', withholdMic: true },
      {},
    );
    await client.start();
    await client.attachMic();
    await client.attachMic();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  describe('transcript gating — THE forbidden-shortcut guard', () => {
    it('drops a user-transcript event that arrives BEFORE attachMic() — onMessage never fires', async () => {
      const onMessage = vi.fn();
      const client = new RealtimeCaddieClient(
        { mode: 'setup', personalityId: 'classic', withholdMic: true },
        { onMessage },
      );
      await client.start();

      // Simulate the server transcribing something (should be impossible in
      // production since no audio is ever sent pre-open — this test proves
      // the client-side gate holds even if it somehow arrived anyway).
      lastPc!.dataChannel!.emit({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item-1',
        transcript: 'phantom user turn from silence',
      });

      expect(onMessage).not.toHaveBeenCalled();
    });

    it('drops assistant transcript deltas/done that arrive BEFORE attachMic() (connect-time greeting)', async () => {
      const onMessage = vi.fn();
      const client = new RealtimeCaddieClient(
        { mode: 'setup', personalityId: 'classic', withholdMic: true },
        { onMessage },
      );
      await client.start();

      lastPc!.dataChannel!.emit({ type: 'response.created', response: { id: 'resp-1' } });
      lastPc!.dataChannel!.emit({
        type: 'response.output_audio_transcript.delta',
        response_id: 'resp-1',
        delta: 'Hey there',
      });
      lastPc!.dataChannel!.emit({
        type: 'response.output_audio_transcript.done',
        response_id: 'resp-1',
      });
      lastPc!.dataChannel!.emit({ type: 'response.done', response_id: 'resp-1' });

      expect(onMessage).not.toHaveBeenCalled();
    });

    it('delivers transcript events normally AFTER attachMic() opens the session', async () => {
      const messages: RealtimeMessage[] = [];
      const client = new RealtimeCaddieClient(
        { mode: 'setup', personalityId: 'classic', withholdMic: true },
        { onMessage: (m) => messages.push(m) },
      );
      await client.start();
      await client.attachMic();

      lastPc!.dataChannel!.emit({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item-2',
        transcript: 'Pebble with Dan and Matt',
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ role: 'user', text: 'Pebble with Dan and Matt' });
    });

    it('drops a priming-echo transcript AFTER attachMic() (never onMessage) but delivers a real transcript that follows it (specs/caddie-context-leak-plan.md)', async () => {
      const onMessage = vi.fn();
      const client = new RealtimeCaddieClient(
        { mode: 'setup', personalityId: 'classic', withholdMic: true },
        { onMessage },
      );
      await client.start();
      await client.attachMic();

      // gpt-4o-transcribe hallucinating transcription.prompt back on a VAD
      // false-trigger — the exact owner-reported echo shape.
      lastPc!.dataChannel!.emit({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item-echo',
        transcript:
          "Player's clubs: GW, LW, PW, SW, Driver. This hole: trees, trees, trees, bunker, bunker, trees, trees. " +
          'Golf vocabulary: birdie, bogey, double bogey, eagle, albatross, mulligan, gimme, up and down, fairway, ' +
          'tee box, pitching wedge, sand wedge, lob wedge, gap wedge, hybrid, 3-wood, 5-wood, driver, putter, ' +
          'yardage, dogleg, carry, layup, pin high.',
      });
      expect(onMessage).not.toHaveBeenCalled();

      lastPc!.dataChannel!.emit({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item-real',
        transcript: 'what club for this bunker?',
      });
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'user', text: 'what club for this bunker?' }),
      );
    });
  });

  describe('setEvents / emitCurrentStatus — adoption by a surface', () => {
    it('setEvents rebinds handlers so the NEW onStatus/onMessage receive subsequent events', async () => {
      const oldOnStatus = vi.fn();
      const newOnStatus = vi.fn();
      const client = new RealtimeCaddieClient(
        { mode: 'setup', personalityId: 'classic', withholdMic: true },
        { onStatus: oldOnStatus },
      );
      await client.start();
      client.setEvents({ onStatus: newOnStatus });

      lastPc!.goConnected();

      expect(newOnStatus).toHaveBeenCalledWith('connected');
      expect(oldOnStatus).not.toHaveBeenCalledWith('connected');
    });

    it('emitCurrentStatus() re-emits the CURRENT status to the bound handler immediately', async () => {
      const client = new RealtimeCaddieClient(
        { mode: 'setup', personalityId: 'classic', withholdMic: true },
        {},
      );
      await client.start();
      lastPc!.goConnected();

      const onStatus = vi.fn();
      client.setEvents({ onStatus });
      client.emitCurrentStatus();

      expect(onStatus).toHaveBeenCalledWith('connected' satisfies RealtimeStatus);
      expect(onStatus).toHaveBeenCalledTimes(1);
    });
  });

  describe('silent placeholder track — the v1.0.739 "still deaf" fix', () => {
    class FakeAudioContext {
      static instances: FakeAudioContext[] = [];
      closed = false;
      constructor() {
        FakeAudioContext.instances.push(this);
      }
      createMediaStreamDestination() {
        const track = fakeTrack();
        return { stream: { getAudioTracks: () => [track], getTracks: () => [track] } };
      }
      close = vi.fn(async () => {
        this.closed = true;
      });
    }

    it('warms with a SILENT synthesized track via addTrack (not a track-less transceiver), still no getUserMedia', async () => {
      vi.stubGlobal('AudioContext', FakeAudioContext);
      const client = new RealtimeCaddieClient(
        { mode: 'setup', personalityId: 'classic', withholdMic: true },
        {},
      );
      await client.start();
      expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
      expect(lastPc!.addTrack).toHaveBeenCalledTimes(1); // the silent placeholder
      expect(lastPc!.addTransceiver).not.toHaveBeenCalled();
    });

    it('attachMic REPLACES the placeholder (WebKit-safe path) and retires it', async () => {
      vi.stubGlobal('AudioContext', FakeAudioContext);
      const client = new RealtimeCaddieClient(
        { mode: 'setup', personalityId: 'classic', withholdMic: true },
        {},
      );
      await client.start();
      const sender = lastPc!.transceivers[0].sender;
      const placeholder = sender.track;
      expect(placeholder).not.toBeNull();
      await client.attachMic();
      expect(sender.replaceTrack).toHaveBeenCalledTimes(1);
      expect(sender.track).not.toBe(placeholder); // real mic in
      expect((placeholder as unknown as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalled();
      expect(FakeAudioContext.instances.at(-1)!.close).toHaveBeenCalled();
    });
  });

  describe('attachMic during an in-flight start() — the v1.0.710 "won\'t listen" regression', () => {
    it('waits for start() to finish and ATTACHES the track (never a silent skip)', async () => {
      // Make the mint hang until we release it, so attachMic() races start().
      const api = await import('@/lib/caddie/api');
      type Token = Awaited<ReturnType<typeof api.startSetupSession>>;
      let releaseMint!: (v: Token) => void;
      vi.mocked(api.startSetupSession).mockReturnValueOnce(
        new Promise<Token>((res) => { releaseMint = res; }),
      );

      const client = new RealtimeCaddieClient(
        { mode: 'setup', personalityId: 'classic', withholdMic: true },
        {},
      );
      const startP = client.start(); // mint pending — pc/transceiver NOT built yet

      // Adoption happens NOW (mic-button tap was itself the warm trigger).
      const attachP = client.attachMic();

      // Release the mint; start() builds the pc + track-less transceiver.
      releaseMint({ client_secret: 'secret-setup' } as Token);
      await startP;
      await attachP;

      const tr = lastPc!.transceivers[0];
      expect(tr.sender.replaceTrack).toHaveBeenCalledTimes(1);
      expect(tr.sender.track).not.toBeNull();
      // Gate lifted: a transcript event now reaches onMessage.
      const onMessage = vi.fn();
      client.setEvents({ onMessage });
      lastPc!.dataChannel!.emit({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'i1',
        transcript: 'blue tees today',
      });
      expect(onMessage).toHaveBeenCalled();
    });

    it('THROWS when no transceiver exists after start (never a connected-looking dead mic)', async () => {
      const client = new RealtimeCaddieClient(
        { mode: 'setup', personalityId: 'classic', withholdMic: true },
        { onError: vi.fn() },
      );
      // No start() at all — worst case: nothing was ever built.
      await expect(client.attachMic()).rejects.toThrow(/no mic track or negotiated transceiver/);
    });
  });
});
