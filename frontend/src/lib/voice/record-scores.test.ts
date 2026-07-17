// @vitest-environment jsdom
//
// record_scores — the live-session acceptance test named in specs/caddie-two
// -tier-routing-plan.md §11 (QA contract fold-in, eng-lead review 2026-07-17):
// a live mid-round session where the model calls the `record_scores` tool
// must reach the REAL routing seam (`resolveScoreEntry`) through the full
// wiring chain — RealtimeCaddieClient -> dispatchTool -> ctx.enterScores —
// fire the parse-scores request, write through the score-write callback on
// the FIRST call (no confirmation round-trip), and never touch the
// get_strategy brain. Same fake/mock pattern as realtime-dedup.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/caddie/api', () => ({
  startRealtimeSession: vi.fn(async () => ({ client_secret: 'secret-caddie' })),
  startSetupSession: vi.fn(async () => ({ client_secret: 'secret-setup' })),
  sessionStrategy: vi.fn(async () => {
    throw new Error('sessionStrategy must never be called for a record_scores turn');
  }),
}));

vi.mock('@/lib/voice/telemetry', () => ({
  voiceEvent: vi.fn(),
}));

import { RealtimeCaddieClient } from './realtime';
import { sessionStrategy } from '@/lib/caddie/api';
import { resolveScoreEntry, type ParseScoresResponse, type ScoreEntryPlayer } from '@/lib/caddie/score-entry';
import { installFakeWebRTC, uninstallFakeWebRTC, getLastPc } from './realtime-test-fakes';

beforeEach(() => {
  installFakeWebRTC();
});

afterEach(() => {
  uninstallFakeWebRTC();
});

/** Drain the tool-dispatch microtask chain (dispatchTool await + the runTool
 *  continuation) deterministically without real timers — mirrors realtime-
 *  dedup.test.ts's helper of the same name. */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

const PLAYERS: ScoreEntryPlayer[] = [
  { id: 'p1', name: 'Justin' },
  { id: 'p2', name: 'Mike' },
];

describe('record_scores — live session, end-to-end through the real routing seam', () => {
  it('model calls record_scores mid-round -> parse-scores fired with playerNames/hole/par -> handleSetScore invoked with the write -> sessionStrategy never called -> no confirmation round-trip', async () => {
    const onMessage = vi.fn();
    const client = new RealtimeCaddieClient(
      { mode: 'caddie', roundId: 'round-1', personalityId: 'classic' },
      { onMessage },
    );
    await client.start();
    const dc = getLastPc()!.dataChannel!;

    const handleSetScore = vi.fn();
    const parseScores = vi.fn(
      async (body: { transcript: string; playerNames: string[]; hole: number; par: number }): Promise<ParseScoresResponse> => ({
        hole: body.hole,
        scores: { Justin: 5 },
        confidence: 0.9,
      }),
    );

    // The REAL routing glue (specs/caddie-two-tier-routing-plan.md §9) — a
    // hand-rolled fake here would only prove dispatchTool forwards args, not
    // that the whole chain reaches the real parser + write path.
    client.setToolContext(() => ({
      enterScores: (utterance: string, holeNumber?: number) =>
        resolveScoreEntry(utterance, holeNumber ?? 7, 4, PLAYERS, handleSetScore, parseScores),
    }));

    dc.emit({ type: 'input_audio_buffer.speech_started', item_id: 'item-1' });
    dc.emit({ type: 'response.created', response: { id: 'resp-1' } });
    dc.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'resp-1',
      call_id: 'call-1',
      name: 'record_scores',
      arguments: JSON.stringify({ utterance: 'put me down for a 5' }),
    });
    await flushMicrotasks();

    // 1. The real parse-scores request fired with playerNames/hole/par.
    expect(parseScores).toHaveBeenCalledTimes(1);
    expect(parseScores).toHaveBeenCalledWith({
      transcript: 'put me down for a 5',
      playerNames: ['Justin', 'Mike'],
      hole: 7,
      par: 4,
    });

    // 2. The EXISTING write path fired — on THIS call, not a second one.
    expect(handleSetScore).toHaveBeenCalledTimes(1);
    expect(handleSetScore).toHaveBeenCalledWith('p1', 6, 5); // hole 7 -> idx 6

    // 3. The tool output reaching the model names the hole and score.
    const outputs = dc.send.mock.calls
      .map(([raw]) => JSON.parse(raw as string) as { type: string; item?: { type?: string; output?: string } })
      .filter((s) => s.type === 'conversation.item.create' && s.item?.type === 'function_call_output');
    expect(outputs).toHaveLength(1);
    const toolOutput = JSON.parse(outputs[0].item!.output!);
    expect(toolOutput).toEqual({ hole: 7, recorded: { Justin: 5 }, unmatched: [], confidence: 0.9 });

    // 4. The brain was never touched by a score-entry turn.
    expect(sessionStrategy).not.toHaveBeenCalled();

    // 5. No confirmation round-trip: exactly one response.create closes the
    // turn (the model's brief in-flow acknowledgment), not a second tool
    // call waiting on a player confirmation.
    const creates = dc.send.mock.calls
      .map(([raw]) => JSON.parse(raw as string) as { type: string })
      .filter((s) => s.type === 'response.create');
    expect(creates).toHaveLength(1);

    client.stop();
  });

  it('low-confidence parse writes nothing and never calls the brain either', async () => {
    const onMessage = vi.fn();
    const client = new RealtimeCaddieClient(
      { mode: 'caddie', roundId: 'round-1', personalityId: 'classic' },
      { onMessage },
    );
    await client.start();
    const dc = getLastPc()!.dataChannel!;

    const handleSetScore = vi.fn();
    const parseScores = vi.fn(async (): Promise<ParseScoresResponse> => ({
      hole: 7,
      scores: { Justin: 5 },
      confidence: 0.2, // below the guard threshold
    }));

    client.setToolContext(() => ({
      enterScores: (utterance: string, holeNumber?: number) =>
        resolveScoreEntry(utterance, holeNumber ?? 7, 4, PLAYERS, handleSetScore, parseScores),
    }));

    dc.emit({ type: 'response.created', response: { id: 'resp-2' } });
    dc.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'resp-2',
      call_id: 'call-2',
      name: 'record_scores',
      arguments: JSON.stringify({ utterance: 'mumble mumble' }),
    });
    await flushMicrotasks();

    expect(handleSetScore).not.toHaveBeenCalled();
    expect(sessionStrategy).not.toHaveBeenCalled();

    const outputs = dc.send.mock.calls
      .map(([raw]) => JSON.parse(raw as string) as { type: string; item?: { type?: string; output?: string } })
      .filter((s) => s.type === 'conversation.item.create' && s.item?.type === 'function_call_output');
    const toolOutput = JSON.parse(outputs[0].item!.output!);
    expect(toolOutput).toEqual({ error: "couldn't make out the scores", heard: 'mumble mumble' });

    client.stop();
  });
});
