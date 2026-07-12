// @vitest-environment jsdom
//
// RealtimeCaddieClient's correlation-map lifecycle (edge 2) + the two audit
// findings (edge 4a/4b) — specs/caddie-voice-reliability-hardening-plan.md
// §2/§4. L1 and O1 (in realtime-ordering.test.ts) are RED against the
// unfixed code — the maps grow unbounded for the life of the session. L2/L3
// are regression guards proving the new pruning/caps never break the
// suppress/release decisions edge 1 depends on.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/caddie/api', () => ({
  startRealtimeSession: vi.fn(async () => ({ client_secret: 'secret-caddie' })),
  startSetupSession: vi.fn(async () => ({ client_secret: 'secret-setup' })),
}));

vi.mock('@/lib/voice/telemetry', () => ({
  voiceEvent: vi.fn(),
}));

import { RealtimeCaddieClient, type RealtimeMessage } from './realtime';
import { REALTIME_IDLE_DISCONNECT_MS } from './idle-timer';
import { voiceEvent } from '@/lib/voice/telemetry';
import {
  installFakeWebRTC,
  uninstallFakeWebRTC,
  getLastPc,
  makeClient,
  driveClarifierResponse,
  type FakeDataChannel,
} from './realtime-test-fakes';

// Mirrors realtime.ts's private RealtimeCaddieClient.MAX_INPUT_CLASS_ENTRIES —
// TS privacy is compile-time only, so this is the same runtime cap.
const MAX_INPUT_CLASS_ENTRIES = 64;

beforeEach(() => {
  installFakeWebRTC();
  // See realtime-attribution.test.ts — voiceEvent's call history survives
  // restoreAllMocks() (it's a plain vi.fn(), not a spy), so tests asserting
  // `not.toHaveBeenCalledWith(...suppression...)` need an explicit clear.
  (voiceEvent as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  uninstallFakeWebRTC();
});

function assistantMessages(onMessage: ReturnType<typeof vi.fn>): RealtimeMessage[] {
  return onMessage.mock.calls.map(([m]) => m as RealtimeMessage).filter((m) => m.role === 'assistant');
}

type PrivateFields = {
  triggerItemsByResponse: Map<string, string[]>;
  heldResponses: Map<string, unknown>;
  partials: Map<string, unknown>;
  inputClassByItem: Map<string, unknown>;
};

/** Drive one full, non-clarifier turn: speech_started -> response.created ->
 *  a delta that reads nothing like a clarifier -> done -> real transcript. */
function driveNormalTurn(dc: FakeDataChannel, i: number): void {
  const itemId = `item-${i}`;
  const respId = `resp-${i}`;
  dc.emit({ type: 'input_audio_buffer.speech_started', item_id: itemId });
  dc.emit({ type: 'response.created', response: { id: respId } });
  dc.emit({ type: 'response.output_audio_transcript.delta', response_id: respId, delta: `You've got ${150 + i} to the pin.` });
  dc.emit({ type: 'response.done', response_id: respId });
  dc.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript: `what club here ${i}`,
  });
}

describe('RealtimeCaddieClient — correlation-map lifecycle (edge 2)', () => {
  it('L1: 50 turns leave the correlation maps bounded', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    for (let i = 0; i < 50; i++) driveNormalTurn(dc, i);

    const priv = client as unknown as PrivateFields;
    expect(priv.triggerItemsByResponse.size).toBe(0);
    expect(priv.heldResponses.size).toBe(0);
    expect(priv.partials.size).toBe(0);
    expect(priv.inputClassByItem.size).toBeLessThanOrEqual(MAX_INPUT_CLASS_ENTRIES);

    client.stop();
  });

  it('L2: pruning does not break suppression/release across 20 mixed turns', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    for (let i = 0; i < 20; i++) driveNormalTurn(dc, i);
    onMessage.mockClear(); // the 20 warmup turns emit their own (unheld) messages — not under test here

    // Scenario A4 inline: two blips, both noinput ⇒ suppressed.
    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'blip-A' });
    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'blip-B' });
    driveClarifierResponse(dc, 'resp-a4');
    dc.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'blip-A', transcript: '' });
    dc.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'blip-B', transcript: '' });
    expect(assistantMessages(onMessage)).toHaveLength(0);
    expect(voiceEvent).toHaveBeenCalledWith(
      'caddie',
      'realtime_noinput_clarifier_suppressed',
      expect.anything(),
    );

    onMessage.mockClear();
    (voiceEvent as ReturnType<typeof vi.fn>).mockClear();

    // Scenario A1 inline: real turn amid a blip ⇒ released, never swallowed.
    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-C' });
    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-D' });
    driveClarifierResponse(dc, 'resp-a1');
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-C',
      transcript: 'scars of god',
    });
    dc.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-D', transcript: '' });

    const assistantMsgs = assistantMessages(onMessage);
    expect(assistantMsgs.length).toBeGreaterThan(0);
    const finalAssistant = assistantMsgs.find((m) => !m.partial);
    expect(finalAssistant?.text).toContain('say again');
    expect(voiceEvent).not.toHaveBeenCalledWith(
      'caddie',
      'realtime_noinput_clarifier_suppressed',
      expect.anything(),
    );

    client.stop();
  });

  it('L3: eviction never removes a live candidate', async () => {
    vi.useFakeTimers();
    try {
      const onMessage = vi.fn();
      const client = await makeClient(onMessage);
      const dc = getLastPc()!.dataChannel!;

      // A held clarifier with two candidates; resolve only one (noinput) —
      // the hold stays pending on the other, unresolved candidate.
      dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'live-A' });
      dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'live-B' });
      driveClarifierResponse(dc, 'resp-live');
      dc.emit({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'live-B',
        transcript: '',
      });
      expect(onMessage).not.toHaveBeenCalled(); // still pending on live-A

      // Push well past MAX_INPUT_CLASS_ENTRIES with unrelated, fully-resolved
      // turns — eviction pressure that must skip 'live-B' because it's still
      // referenced by resp-live's live candidate set.
      for (let i = 0; i < 90; i++) driveNormalTurn(dc, i);
      onMessage.mockClear(); // the 90 eviction-pressure turns emit their own messages — not under test here

      // Resolve the remaining candidate for real — must still release,
      // proving live-B's classification (and resp-live's candidate set)
      // survived the eviction pressure above.
      dc.emit({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'live-A',
        transcript: 'scars of god',
      });

      const assistantMsgs = assistantMessages(onMessage);
      expect(assistantMsgs.length).toBeGreaterThan(0);
      const finalAssistant = assistantMsgs.find((m) => !m.partial);
      expect(finalAssistant?.text).toContain('say again');
      expect(voiceEvent).not.toHaveBeenCalledWith(
        'caddie',
        'realtime_noinput_clarifier_suppressed',
        expect.anything(),
      );

      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RealtimeCaddieClient — audit findings (edge 4a/4b)', () => {
  it('4a: GA-shape response.done (id at evt.response.id, no top-level response_id/item_id) finalizes the partial', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'response.created', response: { id: 'resp-1' } });
    dc.emit({ type: 'response.output_audio_transcript.delta', response_id: 'resp-1', delta: "You've got 152." });
    // GA shape: only `response.id`, no top-level `response_id`/`item_id` —
    // if `output_audio_transcript.done` is ever dropped, this is the only
    // finalize signal (specs/caddie-voice-reliability-hardening-plan.md §4a).
    dc.emit({ type: 'response.done', response: { id: 'resp-1' } });

    const finalMsg = assistantMessages(onMessage).find((m) => !m.partial);
    expect(finalMsg).toBeTruthy();
    expect(finalMsg?.text).toBe("You've got 152.");

    client.stop();
  });

  it('4b: a data-channel message queued before stop() is dropped post-cleanup (no re-armed idle timer, no second "closed")', async () => {
    vi.useFakeTimers();
    try {
      const onMessage = vi.fn();
      const onStatus = vi.fn();
      const client = new RealtimeCaddieClient({ mode: 'setup', personalityId: 'classic' }, { onMessage, onStatus });
      await client.start();
      const dc = getLastPc()!.dataChannel!;

      client.stop();
      expect(onStatus).toHaveBeenCalledWith('closed');
      onStatus.mockClear();
      onMessage.mockClear();

      // The fake dc is retained by the test (real WebRTC would also still
      // fire onmessage for an already-queued frame) — handleEvent must no-op.
      dc.emit({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'late-item',
        transcript: 'late transcript',
      });
      dc.emit({ type: 'response.done', response_id: 'late-resp' });
      expect(onMessage).not.toHaveBeenCalled();

      // Without the dc-null guard, idle.touch() inside handleEvent would
      // re-arm the 90s timer on this dead client, firing a second stop()
      // (setStatus('closed') again) 90s later.
      vi.advanceTimersByTime(REALTIME_IDLE_DISCONNECT_MS + 1000);
      expect(onStatus).not.toHaveBeenCalledWith('closed');

      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
