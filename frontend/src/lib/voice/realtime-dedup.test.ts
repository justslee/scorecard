// @vitest-environment jsdom
//
// The zombie-session double-emit regression harness
// (specs/caddie-realtime-double-emit-plan.md §5.2). R1/R3/R7 are RED against
// the code before the fix (see the PR notes for the pre-fix failure output);
// GREEN after Part A (abort guard) + Part C (id-keyed single-emit guard +
// per-response tool-batch coalescing). Same mock/fake pattern as
// realtime-lifecycle.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/caddie/api', () => ({
  startRealtimeSession: vi.fn(async () => ({ client_secret: 'secret-caddie' })),
  startSetupSession: vi.fn(async () => ({ client_secret: 'secret-setup' })),
  getSessionStatus: vi.fn(async () => ({ ok: true })),
  getSessionConditions: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/lib/voice/telemetry', () => ({
  voiceEvent: vi.fn(),
}));

import { RealtimeCaddieClient, type RealtimeMessage } from './realtime';
import { startSetupSession } from '@/lib/caddie/api';
import { voiceEvent } from '@/lib/voice/telemetry';
import {
  installFakeWebRTC,
  uninstallFakeWebRTC,
  getLastPc,
  getAllPcs,
  makeClient,
  driveClarifierResponse,
  deferred,
  type FakeDataChannel,
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

/** Drain the tool-dispatch microtask chain (dispatchTool await + the
 *  runTool continuation) deterministically without real timers. */
async function flushMicrotasks(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('RealtimeCaddieClient — zombie-session resurrection (Part A, root cause)', () => {
  it('R1: stop() during the mint await does not resurrect a live pc (RED first — the root cause)', async () => {
    const d = deferred<{ client_secret: string }>();
    (startSetupSession as ReturnType<typeof vi.fn>).mockImplementationOnce(() => d.promise);

    const onStatus = vi.fn();
    const client = new RealtimeCaddieClient({ mode: 'setup', personalityId: 'classic' }, { onStatus });
    const startP = client.start(); // don't await — mint is in flight
    client.stop();
    const callsAtStop = onStatus.mock.calls.length;
    expect(onStatus).toHaveBeenLastCalledWith('closed');

    // The mint now resolves — pre-fix, startInner() sails on and builds a
    // full second live connection nobody references.
    d.resolve({ client_secret: 'secret-setup' });
    await startP;
    await flushMicrotasks();

    expect(getAllPcs()).toHaveLength(0);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0); // no SDP exchange
    // No status after 'closed' — an abort must stay silent (no 'error').
    expect(onStatus.mock.calls.length).toBe(callsAtStop);
    expect(voiceEvent).toHaveBeenCalledWith('caddie', 'realtime_start_aborted');
  });

  it('R2: a successor + a resurrected predecessor mint -> exactly ONE live pc (the successor\'s)', async () => {
    const dA = deferred<{ client_secret: string }>();
    (startSetupSession as ReturnType<typeof vi.fn>).mockImplementationOnce(() => dA.promise);

    const onStatusA = vi.fn();
    const clientA = new RealtimeCaddieClient({ mode: 'setup', personalityId: 'classic' }, { onStatus: onStatusA });
    const startAP = clientA.start(); // mint pending
    clientA.stop();

    const onStatusB = vi.fn();
    const clientB = new RealtimeCaddieClient({ mode: 'setup', personalityId: 'classic' }, { onStatus: onStatusB });
    await clientB.start(); // instant default mint — fully connects

    dA.resolve({ client_secret: 'secret-a' });
    await startAP;
    await flushMicrotasks();

    expect(getAllPcs()).toHaveLength(1); // B's only — A never resurrected

    // B's dc is still correctly wired (not stale from a swapped instance).
    const dc = getLastPc()!.dataChannel!;
    const onMessage = vi.fn();
    clientB.setEvents({ onMessage, onStatus: onStatusB });
    dc.emit({ type: 'response.created', response: { id: 'resp-1' } });
    dc.emit({ type: 'response.output_audio_transcript.delta', response_id: 'resp-1', delta: 'hello' });
    dc.emit({ type: 'response.done', response_id: 'resp-1' });
    const final = assistantMessages(onMessage).find((m) => !m.partial);
    expect(final?.text).toBe('hello');
  });
});

describe('RealtimeCaddieClient — id-keyed single-emit guard (Part C)', () => {
  it('R3: duplicate input_audio_transcription.completed (same item_id) commits exactly ONE user turn (RED first)', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-1' });
    dc.emit({ type: 'response.created', response: { id: 'resp-1' } });
    dc.emit({ type: 'response.output_audio_transcript.delta', response_id: 'resp-1', delta: "You've got 150 to the pin." });
    dc.emit({ type: 'response.done', response_id: 'resp-1' });
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'what club here',
    });
    // Re-delivery of the IDENTICAL event — the zombie-session/GA-retry shape.
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'what club here',
    });

    const users = userMessages(onMessage);
    expect(users).toHaveLength(1);
    const assistantFinal = assistantMessages(onMessage).find((m) => !m.partial);
    expect(users[0].order).toBeLessThan(assistantFinal!.order);

    client.stop();
  });

  it('R4: a rapid legit follow-up (distinct item ids, identical text) is KEPT — two user bubbles, two finals', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    for (const i of [1, 2]) {
      dc.emit({ type: 'input_audio_buffer.speech_started', item_id: `item-${i}` });
      dc.emit({ type: 'response.created', response: { id: `resp-${i}` } });
      dc.emit({ type: 'response.output_audio_transcript.delta', response_id: `resp-${i}`, delta: 'Smooth 7-iron.' });
      dc.emit({ type: 'response.done', response_id: `resp-${i}` });
      dc.emit({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: `item-${i}`,
        transcript: 'what club here',
      });
    }

    expect(userMessages(onMessage)).toHaveLength(2); // NOT a text-keyed dedup
    expect(assistantMessages(onMessage).filter((m) => !m.partial)).toHaveLength(2);

    client.stop();
  });

  it('R5: input transcription .delta events never commit a user message (final-only pin)', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-1' });
    dc.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item-1', delta: 'what' });
    dc.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'item-1', delta: ' club' });
    expect(userMessages(onMessage)).toHaveLength(0);

    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'what club here',
    });
    expect(userMessages(onMessage)).toHaveLength(1);

    client.stop();
  });

  it('R6: response deltas arriving BEFORE the transcript still order the user turn first', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-1' });
    dc.emit({ type: 'response.created', response: { id: 'resp-1' } });
    dc.emit({ type: 'response.output_audio_transcript.delta', response_id: 'resp-1', delta: "You've got 150." });
    dc.emit({ type: 'response.done', response_id: 'resp-1' });
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'what club here',
    });

    const user = userMessages(onMessage)[0];
    const assistantFinal = assistantMessages(onMessage).find((m) => !m.partial);
    expect(user.order).toBeLessThan(assistantFinal!.order);

    client.stop();
  });

  it('R9: a second `done` for a finalized response emits nothing new; a late delta after finalize is also inert', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'response.created', response: { id: 'resp-1' } });
    dc.emit({ type: 'response.output_audio_transcript.delta', response_id: 'resp-1', delta: "You've got 150." });
    dc.emit({ type: 'response.output_audio_transcript.done', response_id: 'resp-1' });
    dc.emit({ type: 'response.done', response_id: 'resp-1' }); // second done, same response

    const finals = assistantMessages(onMessage).filter((m) => !m.partial);
    expect(finals).toHaveLength(1);

    onMessage.mockClear();
    dc.emit({ type: 'response.audio_transcript.delta', response_id: 'resp-1', delta: ' more text' });
    expect(onMessage).not.toHaveBeenCalled(); // finalize closes the late-delta-resurrects-a-partial hole

    client.stop();
  });

  it('R10: two speech_started events sharing an item_id (VAD re-trigger) then one completed still commits exactly ONE user turn', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-1' });
    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-1' }); // re-trigger, same item
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'what club here',
    });

    const users = userMessages(onMessage);
    expect(users).toHaveLength(1);
    expect(users[0].order).toBeGreaterThan(0);

    client.stop();
  });
});

describe('RealtimeCaddieClient — R8: shipped guards still fire with dedup active', () => {
  const ECHO_TEXT = 'This hole: trees, trees, trees, bunker, bunker.';

  it('(a) priming echo: a re-delivered identical completed event stays fully inert (breadcrumb count stays 1)', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-echo' });
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-echo',
      transcript: ECHO_TEXT,
    });
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-echo',
      transcript: ECHO_TEXT,
    });

    expect(userMessages(onMessage)).toHaveLength(0);
    const echoBreadcrumbs = (voiceEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[1] === 'realtime_priming_echo_dropped',
    );
    expect(echoBreadcrumbs).toHaveLength(1); // the dedup makes the duplicate fully inert

    client.stop();
  });

  it('(b) no-input clarifier: two blips both empty ⇒ suppressed, zero assistant emits', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc: FakeDataChannel = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'blip-A' });
    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'blip-B' });
    driveClarifierResponse(dc, 'resp-a4');
    dc.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'blip-A', transcript: '' });
    dc.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'blip-B', transcript: '' });

    expect(assistantMessages(onMessage)).toHaveLength(0);
    expect(voiceEvent).toHaveBeenCalledWith('caddie', 'realtime_noinput_clarifier_suppressed', expect.anything());

    client.stop();
  });

  it('(c) a real turn amid a blip: clarifier released, never swallowed', async () => {
    const onMessage = vi.fn();
    const client = await makeClient(onMessage);
    const dc: FakeDataChannel = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-C' });
    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-D' });
    driveClarifierResponse(dc, 'resp-a1');
    dc.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-C',
      transcript: 'scars of god',
    });
    dc.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item-D', transcript: '' });

    const finalAssistant = assistantMessages(onMessage).find((m) => !m.partial);
    expect(finalAssistant?.text).toContain('say again');
    expect(voiceEvent).not.toHaveBeenCalledWith(
      'caddie',
      'realtime_noinput_clarifier_suppressed',
      expect.anything(),
    );

    client.stop();
  });
});

describe('RealtimeCaddieClient — R7: per-response tool-batch coalescing (Part C)', () => {
  it('R7: a multi-tool response sends EXACTLY ONE response.create, after both outputs (RED first)', async () => {
    const onMessage = vi.fn();
    const client = new RealtimeCaddieClient(
      { mode: 'caddie', roundId: 'round-1', personalityId: 'classic' },
      { onMessage },
    );
    await client.start();
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-1' });
    dc.emit({ type: 'response.created', response: { id: 'resp-1' } });
    dc.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'resp-1',
      call_id: 'call-1',
      name: 'get_session_status',
      arguments: '{}',
    });
    dc.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'resp-1',
      call_id: 'call-2',
      name: 'get_conditions',
      arguments: '{}',
    });
    await flushMicrotasks();

    const sends = dc.send.mock.calls.map(([raw]) => JSON.parse(raw as string) as { type: string; item?: { type?: string } });
    const outputIdxs = sends
      .map((s, i) => (s.type === 'conversation.item.create' && s.item?.type === 'function_call_output' ? i : -1))
      .filter((i) => i >= 0);
    const createIdxs = sends.map((s, i) => (s.type === 'response.create' ? i : -1)).filter((i) => i >= 0);

    expect(outputIdxs).toHaveLength(2);
    expect(createIdxs).toHaveLength(1); // exactly ONE response.create for the whole batch
    expect(createIdxs[0]).toBeGreaterThan(Math.max(...outputIdxs)); // create fires after both outputs

    client.stop();
  });

  it('control: a single-tool turn still sends exactly one output + one create (byte-parity with today)', async () => {
    const onMessage = vi.fn();
    const client = new RealtimeCaddieClient(
      { mode: 'caddie', roundId: 'round-1', personalityId: 'classic' },
      { onMessage },
    );
    await client.start();
    const dc = getLastPc()!.dataChannel!;

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-1' });
    dc.emit({ type: 'response.created', response: { id: 'resp-1' } });
    dc.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'resp-1',
      call_id: 'call-1',
      name: 'get_session_status',
      arguments: '{}',
    });
    await flushMicrotasks();

    const sends = dc.send.mock.calls.map(([raw]) => JSON.parse(raw as string) as { type: string; item?: { type?: string } });
    expect(sends.filter((s) => s.type === 'conversation.item.create' && s.item?.type === 'function_call_output')).toHaveLength(1);
    expect(sends.filter((s) => s.type === 'response.create')).toHaveLength(1);

    client.stop();
  });

  it('defensive fallback: a tool call with no response_id still fires its own response.create', async () => {
    const onMessage = vi.fn();
    const client = new RealtimeCaddieClient(
      { mode: 'caddie', roundId: 'round-1', personalityId: 'classic' },
      { onMessage },
    );
    await client.start();
    const dc = getLastPc()!.dataChannel!;

    dc.emit({
      type: 'response.function_call_arguments.done',
      call_id: 'call-1',
      name: 'get_session_status',
      arguments: '{}',
      // no response_id
    });
    await flushMicrotasks();

    const sends = dc.send.mock.calls.map(([raw]) => JSON.parse(raw as string) as { type: string });
    expect(sends.filter((s) => s.type === 'response.create')).toHaveLength(1);

    client.stop();
  });
});

describe('RealtimeCaddieClient — detached-live end() mid-mint (specs/caddie-detach-and-language-pin-plan.md §B6 T4)', () => {
  it('end() mid-mint (setEvents({})+stop): resolved mint does not resurrect pc, no late message reaches the detached handlers; double-stop idempotent', async () => {
    // Mirrors the exact composition useDetachedCaddieLive.end() performs on
    // top of useCaddieLiveSession's public stop() — detach handlers before
    // stopping the transport, same belt as fallBack()/the effect cleanup use
    // throughout realtime.ts's own teardown paths (R1 above pins the
    // underlying abort-guard root cause this composes on top of).
    const d = deferred<{ client_secret: string }>();
    (startSetupSession as ReturnType<typeof vi.fn>).mockImplementationOnce(() => d.promise);

    const onMessage = vi.fn();
    const onStatus = vi.fn();
    const client = new RealtimeCaddieClient({ mode: 'setup', personalityId: 'classic' }, { onMessage, onStatus });
    const startP = client.start(); // mint in flight — end() fires before it resolves

    client.setEvents({});
    client.stop();
    // Double-stop idempotent — a race between an explicit end() and the
    // inner hook's own `!active` teardown belt calling stop() again must
    // never throw or re-emit.
    expect(() => client.stop()).not.toThrow();

    // The mint now resolves — a resurrection bug would sail on and build a
    // full second live connection nobody references.
    d.resolve({ client_secret: 'secret-setup' });
    await startP;
    await flushMicrotasks();

    expect(getAllPcs()).toHaveLength(0); // resolved mint did not resurrect a pc
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled(); // no late message reaches the (detached) handlers
  });
});
