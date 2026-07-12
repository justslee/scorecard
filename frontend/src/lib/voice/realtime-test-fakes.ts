// Shared fake RTCPeerConnection/mediaDevices plumbing for the realtime.ts
// hardening test suites (realtime-attribution.test.ts,
// realtime-lifecycle.test.ts — specs/caddie-voice-reliability-hardening-plan.md).
//
// Mirrors the local copies in realtime-noinput.test.ts / realtime-warm.test.ts
// EXACTLY (same fake shapes, same stubbed globals) — those two suites keep
// their own local copies unmodified so this extraction is zero-churn to the
// shipped regression harness. Import this module ONLY from the new suites.

import { vi } from 'vitest';
import { RealtimeCaddieClient, type RealtimeMessage } from './realtime';

export class FakeSender {
  track: MediaStreamTrack | null;
  replaceTrack = vi.fn(async (t: MediaStreamTrack | null) => {
    this.track = t;
  });
  constructor(track: MediaStreamTrack | null = null) {
    this.track = track;
  }
}

export class FakeTransceiver {
  sender: FakeSender;
  constructor(track: MediaStreamTrack | null = null) {
    this.sender = new FakeSender(track);
  }
}

export class FakeDataChannel {
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

export class FakePeerConnection {
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

export function fakeTrack(): MediaStreamTrack {
  return { stop: vi.fn(), enabled: true } as unknown as MediaStreamTrack;
}

export function fakeStream(): MediaStream {
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

/** Call from `beforeEach` — stubs RTCPeerConnection / fetch / mediaDevices. */
export function installFakeWebRTC(): void {
  lastPc = null;
  vi.stubGlobal('RTCPeerConnection', RTCPeerConnectionMock);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => 'fake-answer-sdp',
    })),
  );
  vi.stubGlobal('navigator', {
    onLine: true,
    mediaDevices: {
      getUserMedia: vi.fn(async () => fakeStream()),
    },
  });
}

/** Call from `afterEach` — pairs with installFakeWebRTC(). */
export function uninstallFakeWebRTC(): void {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  lastPc = null;
}

/** The FakePeerConnection created by the most recent `new RTCPeerConnection()`. */
export function getLastPc(): FakePeerConnection | null {
  return lastPc;
}

export const CANONICAL_CLARIFIER = "Didn't catch that — say again?";

export async function makeClient(onMessage: (m: RealtimeMessage) => void): Promise<RealtimeCaddieClient> {
  const client = new RealtimeCaddieClient({ mode: 'setup', personalityId: 'classic' }, { onMessage });
  await client.start();
  return client;
}

/** Drive a full clarifier-shaped response: response.created + streamed deltas
 *  + done, WITHOUT ever sending the triggering transcript. */
export function driveClarifierResponse(dc: FakeDataChannel, respId: string): void {
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
