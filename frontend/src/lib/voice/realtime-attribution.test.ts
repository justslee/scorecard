// @vitest-environment jsdom
//
// RealtimeCaddieClient's candidate-SET attribution (edge 1,
// specs/caddie-voice-reliability-hardening-plan.md §1) — the fix for the
// VAD-blip-mid-real-turn attribution race: a phantom noise `speech_started`
// landing between a REAL turn's commit and its `response.created` used to
// steal sole attribution via `pendingSpeechItems.pop()`, so a legit garbled
// transcript's clarifier reply got silently suppressed. Suppression now
// requires ALL candidates in the response's snapshot to be provably noinput —
// strictly more conservative than the old single-trigger rule.
//
// Orderings A1/A2/A5/A6 are RED against the unfixed single-trigger code (see
// each test's comment); A3/A4/A7 are regression guards that already passed
// and must keep passing. The entire existing realtime-noinput.test.ts is the
// bit-identical-for-single-candidate regression harness and is NOT modified.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/caddie/api', () => ({
  startRealtimeSession: vi.fn(async () => ({ client_secret: 'secret-caddie' })),
  startSetupSession: vi.fn(async () => ({ client_secret: 'secret-setup' })),
}));

vi.mock('@/lib/voice/telemetry', () => ({
  voiceEvent: vi.fn(),
}));

import type { RealtimeMessage } from './realtime';
import { voiceEvent } from '@/lib/voice/telemetry';
import {
  installFakeWebRTC,
  uninstallFakeWebRTC,
  getLastPc,
  makeClient,
  driveClarifierResponse,
  CANONICAL_CLARIFIER,
} from './realtime-test-fakes';

beforeEach(() => {
  installFakeWebRTC();
  // `voiceEvent` is a plain vi.fn() from the vi.mock() factory (not a spy on
  // a real implementation) — restoreAllMocks() in uninstallFakeWebRTC() below
  // doesn't clear its call history, so several tests here assert
  // `not.toHaveBeenCalledWith(...suppression...)` against a clean slate.
  (voiceEvent as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  uninstallFakeWebRTC();
});

function assistantMessages(onMessage: ReturnType<typeof vi.fn>): RealtimeMessage[] {
  return onMessage.mock.calls.map(([m]) => m as RealtimeMessage).filter((m) => m.role === 'assistant');
}

function userMessages(onMessage: ReturnType<typeof vi.fn>): RealtimeMessage[] {
  return onMessage.mock.calls.map(([m]) => m as RealtimeMessage).filter((m) => m.role === 'user');
}

describe('RealtimeCaddieClient — attribution-race candidate sets (edge 1)', () => {
  it('A1: real turn (A) + phantom blip (B); B resolves noinput AFTER A resolves real ⇒ clarifier is NOT suppressed', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-A' });
    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-B' }); // phantom blip mid-window
    driveClarifierResponse(dc, 'resp-1');
    expect(onMessage).not.toHaveBeenCalled();

    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-A',
      transcript: 'scars of god',
    });
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-B',
      transcript: '',
    });

    const assistantMsgs = assistantMessages(onMessage);
    expect(assistantMsgs.length).toBeGreaterThan(0);
    const finalAssistant = assistantMsgs.find((m) => !m.partial);
    expect(finalAssistant?.text).toContain('say again');

    const userMsgs = userMessages(onMessage);
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].text).toBe('scars of god');

    expect(voiceEvent).not.toHaveBeenCalledWith(
      'caddie',
      'realtime_noinput_clarifier_suppressed',
      expect.anything(),
    );

    client.stop();
  });

  it("A2: B's noinput transcript arrives BEFORE A's real one ⇒ not suppressed at B (aggregate pending); released when A resolves", async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-A' });
    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-B' });
    driveClarifierResponse(dc, 'resp-1');
    expect(onMessage).not.toHaveBeenCalled();

    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-B',
      transcript: '',
    });
    // Still pending — A hasn't classified, so the aggregate cannot be
    // 'noinput' yet. Nothing should have been suppressed or emitted.
    expect(onMessage).not.toHaveBeenCalled();
    expect(voiceEvent).not.toHaveBeenCalledWith(
      'caddie',
      'realtime_noinput_clarifier_suppressed',
      expect.anything(),
    );

    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-A',
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
  });

  it('A3 (regression): blip (A) then real (B), real-last ordering ⇒ released — already worked pre-fix', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-A' });
    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-B' });
    driveClarifierResponse(dc, 'resp-1');
    expect(onMessage).not.toHaveBeenCalled();

    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-B',
      transcript: 'scars of god',
    });

    const assistantMsgs = assistantMessages(onMessage);
    expect(assistantMsgs.length).toBeGreaterThan(0);
    const finalAssistant = assistantMsgs.find((m) => !m.partial);
    expect(finalAssistant?.text).toContain('say again');

    client.stop();
  });

  it('A4 (regression guard): two blips, both resolve noinput ⇒ suppressed — the shipped phantom-clarifier fix must not regress', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-A' });
    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-B' });
    driveClarifierResponse(dc, 'resp-1');

    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-A',
      transcript: '',
    });
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-B',
      transcript: '',
    });

    expect(assistantMessages(onMessage)).toHaveLength(0);
    expect(voiceEvent).toHaveBeenCalledWith(
      'caddie',
      'realtime_noinput_clarifier_suppressed',
      expect.objectContaining({ detail: expect.stringMatching(/^len=\d+$/) }),
    );

    client.stop();
  });

  it("A5: A's real transcript classifies BEFORE response.created, then a blip (B) ⇒ aggregate already 'real' — never held, first delta emits immediately", async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-A' });
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-A',
      transcript: 'scars of god',
    });
    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-B' }); // blip after A classifies
    dc.emit({ type: 'response.created', response: { id: 'resp-1' } });
    dc.emit({
      type: 'response.output_audio_transcript.delta',
      response_id: 'resp-1',
      delta: CANONICAL_CLARIFIER.split(' ')[0] + ' ',
    });

    // Emitted on the FIRST delta — never held, because the aggregate is
    // already 'real' (item-A was classified before response.created).
    const assistantMsgs = assistantMessages(onMessage);
    expect(assistantMsgs.length).toBeGreaterThan(0);

    client.stop();
  });

  it("A6: candidates [A,B]; B resolves noinput, A never resolves; done arrives; grace timer fires ⇒ released (err-keep)", async () => {
    vi.useFakeTimers();
    try {
      const onMessage = vi.fn();
      const client = await makeClient(onMessage);
      const dc = getLastPc()!.dataChannel!;

      dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-A' });
      dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-B' });
      dc.emit({ type: 'response.created', response: { id: 'resp-1' } });
      for (const word of CANONICAL_CLARIFIER.split(' ')) {
        dc.emit({ type: 'response.output_audio_transcript.delta', response_id: 'resp-1', delta: word + ' ' });
      }
      dc.emit({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item-B',
        transcript: '',
      });
      dc.emit({ type: 'response.done', response_id: 'resp-1' });
      expect(onMessage).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2000);

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

  it('A7 (regression guard): a real transcript for an item in NO candidate set is a no-op on holds', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-A' });
    driveClarifierResponse(dc, 'resp-1');
    expect(onMessage).not.toHaveBeenCalled();

    // A stray transcript for an item that was never a candidate of anything
    // (e.g. a late/duplicate event) must not disturb the still-held response.
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-ghost',
      transcript: 'hello there',
    });
    expect(assistantMessages(onMessage)).toHaveLength(0);

    // resp-1 still resolves normally off its real candidate.
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-A',
      transcript: 'scars of god',
    });
    const assistantMsgs = assistantMessages(onMessage);
    expect(assistantMsgs.length).toBeGreaterThan(0);
    const finalAssistant = assistantMsgs.find((m) => !m.partial);
    expect(finalAssistant?.text).toContain('say again');

    client.stop();
  });
});
