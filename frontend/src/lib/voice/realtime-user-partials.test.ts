// @vitest-environment jsdom
//
// Live user-speech visualization (specs/live-transcription-plan.md §3.2/§3.3):
// `conversation.item.input_audio_transcription.delta` — previously swallowed
// by realtime.ts's `default:` case — now accumulates and renders a user
// PARTIAL, so the golfer sees their own words appear as they speak instead of
// only after the turn commits. This suite pins the new lifecycle: accumulate,
// order via peek (never consume — realtime-dedup.test.ts's R5/R6 still own
// the "final is the sole order-consumer" pin), retract on drop, and leave
// every existing guard (pre-open gate, dedupe, no-input clarifier) untouched.
//
// Same fake-WebRTC harness as realtime-dedup.test.ts.

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
import {
  installFakeWebRTC,
  uninstallFakeWebRTC,
  getLastPc,
  makeClient,
  driveClarifierResponse,
} from './realtime-test-fakes';

beforeEach(() => {
  installFakeWebRTC();
  (voiceEvent as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  uninstallFakeWebRTC();
});

function userMessages(onMessage: ReturnType<typeof vi.fn>): RealtimeMessage[] {
  return onMessage.mock.calls.map(([m]) => m as RealtimeMessage).filter((m) => m.role === 'user');
}

function assistantMessages(onMessage: ReturnType<typeof vi.fn>): RealtimeMessage[] {
  return onMessage.mock.calls.map(([m]) => m as RealtimeMessage).filter((m) => m.role === 'assistant');
}

// Reused verbatim from realtime-dedup.test.ts's R8(a) — a content-classified
// priming echo (hazard-list branch C of isPrimingEcho), NOT exact-string
// matched, so it holds regardless of the minted prompt.
const ECHO_TEXT = 'This hole: trees, trees, trees, bunker, bunker.';

describe('RealtimeCaddieClient — user transcription .delta partials (live text)', () => {
  it('accumulates delta text under one item id, emitting a growing partial with each delta', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-1' });
    dc.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item-1', delta: 'what' });
    dc.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item-1', delta: ' club' });
    dc.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item-1', delta: ' here' });

    const partials = userMessages(onMessage);
    expect(partials.every((m) => m.partial)).toBe(true);
    expect(partials.map((m) => m.text)).toEqual(['what', 'what club', 'what club here']);
    expect(partials.every((m) => m.id === 'item-1')).toBe(true);

    client.stop();
  });

  it('orders the user partial (and its later final) BEFORE the assistant reply, even with response deltas interleaved', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-1' });
    dc.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item-1', delta: 'what' });
    dc.emit({ type: 'response.created', response: { id: 'resp-1' } });
    dc.emit({ type: 'response.output_audio_transcript.delta', response_id: 'resp-1', delta: "You've got 150." });
    dc.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item-1', delta: ' club' });
    dc.emit({ type: 'response.done', response_id: 'resp-1' });
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'what club',
    });

    const userPartials = userMessages(onMessage).filter((m) => m.partial);
    const userFinal = userMessages(onMessage).find((m) => !m.partial)!;
    const assistantFinal = assistantMessages(onMessage).find((m) => !m.partial)!;

    expect(userPartials.every((m) => m.order === userFinal.order)).toBe(true);
    expect(userFinal.order).toBeLessThan(assistantFinal.order);

    client.stop();
  });

  it('pre-open gate: a delta arriving before the mic is attached is dropped (warm/withheld session)', async () => {
    const onMessage = vi.fn();
    const client = new RealtimeCaddieClient(
      { mode: 'setup', personalityId: 'classic', withholdMic: true },
      { onMessage },
    );
    await client.start();
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-1' });
    dc.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item-1', delta: 'hello' });

    expect(onMessage).not.toHaveBeenCalled();

    client.stop();
  });

  it('a late delta after .completed is inert — no partial resurrected for an already-processed item (R3 interplay)', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-1' });
    dc.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item-1', delta: 'what club' });
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'what club here',
    });

    onMessage.mockClear();
    dc.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item-1', delta: ' extra' });

    expect(onMessage).not.toHaveBeenCalled();

    client.stop();
  });

  it('priming-echo: emission stops once the accumulated text classifies as an echo, and the .completed drop retracts the emitted partial', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-echo' });
    // Not yet echo-shaped (only 2 hazard segments < HAZARD_SEGMENT_MIN) — emits.
    dc.emit({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-echo',
      delta: 'This hole: trees, trees,',
    });
    const afterFirst = userMessages(onMessage);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].partial).toBe(true);

    onMessage.mockClear();
    // Completes the echo shape (5 hazard segments) — the delta handler keeps
    // ACCUMULATING but stops EMITTING this and any further frame.
    dc.emit({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-echo',
      delta: ' trees, bunker, bunker.',
    });
    expect(userMessages(onMessage)).toHaveLength(0);

    // .completed remains the sole authority that drops the turn — it also
    // retracts the partial the UI already saw (§3.3), so a hallucinated echo
    // never lingers on screen as live text.
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-echo',
      transcript: ECHO_TEXT,
    });
    const retraction = userMessages(onMessage).find((m) => !m.partial);
    expect(retraction).toBeDefined();
    expect(retraction!.text).toBe('');

    client.stop();
  });

  it('.failed retracts a partial that was emitted for the item', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-f' });
    dc.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item-f', delta: 'seven iron' });
    expect(userMessages(onMessage).filter((m) => m.partial)).toHaveLength(1);

    onMessage.mockClear();
    dc.emit({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'item-f' });

    const retraction = userMessages(onMessage).find((m) => !m.partial);
    expect(retraction).toBeDefined();
    expect(retraction!.text).toBe('');

    client.stop();
  });

  it('an empty .completed transcript retracts a partial that was emitted for the item', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-e' });
    dc.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item-e', delta: 'uh' });
    expect(userMessages(onMessage).filter((m) => m.partial)).toHaveLength(1);

    onMessage.mockClear();
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-e',
      transcript: '',
    });

    const retraction = userMessages(onMessage).find((m) => !m.partial);
    expect(retraction).toBeDefined();
    expect(retraction!.text).toBe('');

    client.stop();
  });

  it('a partial with NO prior emission produces no retraction noise on an empty completed (no-op guard)', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    // No speech_started/.delta at all for this item — nothing was ever shown.
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-never-seen',
      transcript: '',
    });

    expect(userMessages(onMessage)).toHaveLength(0);

    client.stop();
  });

  it('deltas never classify input or release/suppress a held clarifier response — the no-input clarifier hold is untouched', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'blip-A' });
    // A delta on the blip item BEFORE the response — if a delta wrongly
    // called setInputClass('real')/resolveHeldFor, the clarifier below would
    // release/emit instead of staying held pending classification.
    dc.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'blip-A', delta: 'uh' });
    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'blip-B' });
    driveClarifierResponse(dc, 'resp-partial-a4');
    dc.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'blip-A', transcript: '' });
    dc.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'blip-B', transcript: '' });

    // Same outcome as the dedup suite's R8(b) with no deltas in play at
    // all — proving the deltas above changed nothing about the hold/suppress
    // decision.
    expect(assistantMessages(onMessage)).toHaveLength(0);
    expect(voiceEvent).toHaveBeenCalledWith('caddie', 'realtime_noinput_clarifier_suppressed', expect.anything());

    client.stop();
  });

  it('terminal teardown: stop() mid-partial transitions status to closed without throwing or re-emitting the partial', async () => {
    // realtime.ts itself does NOT settle an outstanding user partial in
    // place on teardown — that in-place "caret stops blinking, text stays"
    // settle is explicitly the CONSUMER's job (specs/live-transcription-plan
    // .md §3.3/§3.5: useCaddieLiveSession.ts / useVoiceCaddie.ts settle their
    // OWN rendered state on terminal status), tested in those hooks' own
    // suites. This test only pins realtime.ts's side of the contract: an
    // outstanding partial at teardown is harmless — stop() is safe, status
    // reaches 'closed', and nothing about the last-emitted partial is
    // resurrected or duplicated.
    const onMessage = vi.fn();
    const onStatus = vi.fn();
    const client = new RealtimeCaddieClient({ mode: 'setup', personalityId: 'classic' }, { onMessage, onStatus });
    await client.start();
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-orphan' });
    dc.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item-orphan', delta: 'mid utter' });
    const lastPartial = userMessages(onMessage).at(-1)!;
    expect(lastPartial.partial).toBe(true);

    expect(() => client.stop()).not.toThrow();
    expect(onStatus).toHaveBeenLastCalledWith('closed');
    // Double-stop idempotent, same posture as the dedup suite's detach test.
    expect(() => client.stop()).not.toThrow();
  });
});
