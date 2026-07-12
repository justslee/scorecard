// @vitest-environment jsdom
//
// RealtimeCaddieClient's no-input clarifier suppression
// (specs/caddie-noise-clarification-reply-plan.md). Mocks RTCPeerConnection +
// mediaDevices (neither exists in jsdom) — same minimal fake plumbing as
// realtime-warm.test.ts — so the correlation/hold/release/suppress wiring can
// be driven deterministically via emitted data-channel events.
//
// THE load-bearing test in this file is scenario 4 — "real but garbled input
// is NEVER swallowed" — the never-swallow-a-legit-reply guarantee the plan is
// built around.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/caddie/api', () => ({
  startRealtimeSession: vi.fn(async () => ({ client_secret: 'secret-caddie' })),
  startSetupSession: vi.fn(async () => ({ client_secret: 'secret-setup' })),
}));

vi.mock('@/lib/voice/telemetry', () => ({
  voiceEvent: vi.fn(),
}));

import { RealtimeCaddieClient, type RealtimeMessage } from './realtime';
import { voiceEvent } from '@/lib/voice/telemetry';

// ── Fake WebRTC plumbing (mirrors realtime-warm.test.ts) ────────────────────

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

const CANONICAL_CLARIFIER = "Didn't catch that — say again?";

async function makeClient(onMessage: (m: RealtimeMessage) => void) {
  const client = new RealtimeCaddieClient({ mode: 'setup', personalityId: 'classic' }, { onMessage });
  await client.start();
  return client;
}

/** Drive a full clarifier-shaped response: response.created + streamed deltas
 *  + done, WITHOUT ever sending the triggering transcript. */
function driveClarifierResponse(dc: FakeDataChannel, respId: string) {
  dc.emit({ type: 'response.created', response: { id: respId } });
  for (const word of CANONICAL_CLARIFIER.split(' ')) {
    dc.emit({
      type: 'response.output_audio_transcript.delta',
      response_id: respId,
      delta: word + ' ',
    });
  }
  dc.emit({ type: 'response.done', response_id: respId });
}

describe('RealtimeCaddieClient — no-input clarifier suppression', () => {
  it('1. noise turn, transcript resolves AFTER done ⇒ suppressed (onMessage never called with an assistant message)', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = lastPc!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-A' });
    driveClarifierResponse(dc, 'resp-1');
    expect(onMessage).not.toHaveBeenCalled(); // held — never surfaced pre-classification

    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-A',
      transcript: '',
    });

    const assistantCalls = onMessage.mock.calls.filter(([m]) => m.role === 'assistant');
    expect(assistantCalls).toHaveLength(0);
    expect(voiceEvent).toHaveBeenCalledWith(
      'caddie',
      'realtime_noinput_clarifier_suppressed',
      expect.objectContaining({ detail: expect.stringMatching(/^len=\d+$/) }),
    );

    client.stop();
  });

  it('2. transcript ("") arrives BEFORE done ⇒ suppressed', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = lastPc!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-A' });
    dc.emit({ type: 'response.created', response: { id: 'resp-1' } });
    for (const word of CANONICAL_CLARIFIER.split(' ')) {
      dc.emit({ type: 'response.output_audio_transcript.delta', response_id: 'resp-1', delta: word + ' ' });
    }
    // Transcript resolves BEFORE done.
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-A',
      transcript: '',
    });
    dc.emit({ type: 'response.done', response_id: 'resp-1' });

    const assistantCalls = onMessage.mock.calls.filter(([m]) => m.role === 'assistant');
    expect(assistantCalls).toHaveLength(0);

    client.stop();
  });

  it('3. priming-echo transcript ⇒ suppressed (exercises the isPrimingEcho integration)', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = lastPc!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-echo' });
    driveClarifierResponse(dc, 'resp-1');

    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-echo',
      transcript:
        "Player's clubs: GW, LW, PW, SW, Driver. This hole: trees, trees, trees, bunker, bunker, trees, trees. " +
        'Golf vocabulary: birdie, bogey, double bogey, eagle, albatross, mulligan, gimme, up and down, fairway, ' +
        'tee box, pitching wedge, sand wedge, lob wedge, gap wedge, hybrid, 3-wood, 5-wood, driver, putter, ' +
        'yardage, dogleg, carry, layup, pin high.',
    });

    const assistantCalls = onMessage.mock.calls.filter(([m]) => m.role === 'assistant');
    expect(assistantCalls).toHaveLength(0);

    client.stop();
  });

  it('4. real-but-garbled turn ⇒ clarifier EMITTED — the load-bearing never-swallow test', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = lastPc!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-A' });
    driveClarifierResponse(dc, 'resp-1');
    expect(onMessage).not.toHaveBeenCalled();

    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-A',
      transcript: 'scars of god',
    });

    // A user bubble for the garbled transcript AND the clarifier response,
    // finalized (partial: false) at some point.
    const assistantMsgs = onMessage.mock.calls.map(([m]) => m).filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThan(0);
    const finalAssistant = assistantMsgs.find((m) => !m.partial);
    expect(finalAssistant?.text).toContain('say again');

    const userMsgs = onMessage.mock.calls.map(([m]) => m).filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].text).toBe('scars of god');

    client.stop();
  });

  it('5. normal answer streams as partials immediately, before the transcript resolves', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = lastPc!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-A' });
    dc.emit({ type: 'response.created', response: { id: 'resp-1' } });
    dc.emit({ type: 'response.output_audio_transcript.delta', response_id: 'resp-1', delta: "You've got 152" });

    // Emitted on the FIRST delta — no hold, because the text already diverges
    // from clarifier-shape (digit).
    const assistantMsgs = onMessage.mock.calls.map(([m]) => m).filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThan(0);
    expect(assistantMsgs[0].text).toBe("You've got 152");

    client.stop();
  });

  it('6. typed text: even a clarifier-shaped reply is emitted (unconditional — no correlation)', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = lastPc!.dataChannel!;

    client.sendText('what club');
    dc.emit({ type: 'response.created', response: { id: 'resp-1' } });
    for (const word of CANONICAL_CLARIFIER.split(' ')) {
      dc.emit({ type: 'response.output_audio_transcript.delta', response_id: 'resp-1', delta: word + ' ' });
    }
    dc.emit({ type: 'response.done', response_id: 'resp-1' });

    const assistantMsgs = onMessage.mock.calls.map(([m]) => m).filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThan(0);
    const finalAssistant = assistantMsgs.find((m) => !m.partial);
    expect(finalAssistant?.text).toContain('say again');

    client.stop();
  });

  it('7. grace timeout: done, transcript never arrives, advance 2000ms ⇒ emitted', async () => {
    vi.useFakeTimers();
    try {
      const onMessage = vi.fn();
      const client = await makeClient(onMessage);
      const dc = lastPc!.dataChannel!;

      dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-A' });
      driveClarifierResponse(dc, 'resp-1');
      expect(onMessage).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2000);

      const assistantMsgs = onMessage.mock.calls.map(([m]) => m).filter((m) => m.role === 'assistant');
      expect(assistantMsgs.length).toBeGreaterThan(0);
      const finalAssistant = assistantMsgs.find((m) => !m.partial);
      expect(finalAssistant?.text).toContain('say again');

      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('8. transcription.failed ⇒ released/emitted', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = lastPc!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-A' });
    driveClarifierResponse(dc, 'resp-1');
    expect(onMessage).not.toHaveBeenCalled();

    dc.emit({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'item-A',
    });

    const assistantMsgs = onMessage.mock.calls.map(([m]) => m).filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThan(0);
    const finalAssistant = assistantMsgs.find((m) => !m.partial);
    expect(finalAssistant?.text).toContain('say again');

    client.stop();
  });

  it('9. two rapid noise turns both suppressed; a subsequent real turn emits with correct ordering', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = lastPc!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-1' });
    driveClarifierResponse(dc, 'resp-1');
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: '',
    });

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-2' });
    driveClarifierResponse(dc, 'resp-2');
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-2',
      transcript: '',
    });

    expect(onMessage.mock.calls.filter(([m]) => m.role === 'assistant')).toHaveLength(0);

    // A real turn now — user bubble + answer both surface, user before reply.
    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-3' });
    dc.emit({ type: 'response.created', response: { id: 'resp-3' } });
    dc.emit({ type: 'response.output_audio_transcript.delta', response_id: 'resp-3', delta: 'Driver. Favor left.' });
    dc.emit({ type: 'response.done', response_id: 'resp-3' });
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-3',
      transcript: 'what club here',
    });

    const rendered = onMessage.mock.calls.map(([m]) => m as RealtimeMessage);
    const userMsg = rendered.find((m) => m.role === 'user');
    const assistantMsg = rendered.find((m) => m.role === 'assistant' && !m.partial);
    expect(userMsg?.text).toBe('what club here');
    expect(assistantMsg?.text).toBe('Driver. Favor left.');
    expect(userMsg!.order).toBeLessThan(assistantMsg!.order);

    client.stop();
  });

  it('10. withheld-mic pre-open: events dropped as before (!this.opened unchanged)', async () => {
    const onMessage = vi.fn();
    const client = new RealtimeCaddieClient(
      { mode: 'setup', personalityId: 'classic', withholdMic: true },
      { onMessage },
    );
    await client.start();
    const dc = lastPc!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-A' });
    driveClarifierResponse(dc, 'resp-1');
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-A',
      transcript: '',
    });

    expect(onMessage).not.toHaveBeenCalled();

    client.stop();
  });
});
