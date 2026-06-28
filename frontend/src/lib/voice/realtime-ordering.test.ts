import { describe, it, expect } from 'vitest';
import { MessageOrderTracker, sortByOrder } from './realtime-ordering';

/**
 * Simulates the Realtime event stream feeding RealtimeCaddieClient.handleEvent,
 * accumulating messages in *arrival* order (as the data channel delivers them),
 * each tagged with the order key the tracker assigns. Rendering sorts by that
 * key — this is exactly what the components do.
 */
type Evt =
  // itemId mirrors the real `evt.item_id` carried by both speech_started and the
  // transcript; omit it to model an event with no id (FIFO fallback path).
  | { kind: 'speech_started'; itemId?: string }
  | { kind: 'response_created'; responseId: string }
  | { kind: 'assistant_delta'; responseId: string; delta: string }
  | { kind: 'user_transcript'; id: string; text: string }
  | { kind: 'typed_user'; id: string; text: string };

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  order: number;
}

function run(events: Evt[]): Msg[] {
  const tracker = new MessageOrderTracker();
  const byId = new Map<string, Msg>();
  const arrival: Msg[] = [];

  const upsert = (m: Msg) => {
    if (byId.has(m.id)) {
      Object.assign(byId.get(m.id)!, m);
    } else {
      byId.set(m.id, m);
      arrival.push(byId.get(m.id)!);
    }
  };

  for (const e of events) {
    switch (e.kind) {
      case 'speech_started':
        tracker.noteUserTurnStarted(e.itemId);
        break;
      case 'response_created':
        tracker.orderForResponse(e.responseId);
        break;
      case 'assistant_delta': {
        const existing = byId.get(e.responseId);
        const order = existing ? existing.order : tracker.orderForResponse(e.responseId);
        upsert({
          id: e.responseId,
          role: 'assistant',
          text: (existing?.text ?? '') + e.delta,
          order,
        });
        break;
      }
      case 'user_transcript':
        // In the real handler, the rendered id IS the item_id — pass it for the
        // identity-matched lookup.
        upsert({ id: e.id, role: 'user', text: e.text, order: tracker.orderForUserTranscript(e.id) });
        break;
      case 'typed_user':
        upsert({ id: e.id, role: 'user', text: e.text, order: tracker.orderForTypedUser() });
        break;
    }
  }
  return sortByOrder(arrival);
}

describe('MessageOrderTracker — voice-setup chat ordering', () => {
  it('renders the user line BEFORE the reply it triggered, despite the transcript arriving last', () => {
    // The exact owner-reported bug: "hello" → caddie replies → deltas stream in
    // FIRST, the user transcript completes LAST.
    const rendered = run([
      { kind: 'speech_started', itemId: 'item_user1' },
      { kind: 'response_created', responseId: 'resp1' },
      { kind: 'assistant_delta', responseId: 'resp1', delta: 'Hi! ' },
      { kind: 'assistant_delta', responseId: 'resp1', delta: 'What are we playing?' },
      { kind: 'user_transcript', id: 'item_user1', text: 'hello' },
    ]);

    expect(rendered.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(rendered[0].text).toBe('hello');
    expect(rendered[1].text).toBe('Hi! What are we playing?');
  });

  it('still orders user-before-assistant when response.created is never seen (lazy assign on first delta)', () => {
    const rendered = run([
      { kind: 'speech_started' },
      { kind: 'assistant_delta', responseId: 'resp1', delta: 'Sure.' },
      { kind: 'user_transcript', id: 'u1', text: 'pebble beach' },
    ]);
    expect(rendered.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('keeps multiple turns in strict conversational order', () => {
    const rendered = run([
      // turn 1
      { kind: 'speech_started', itemId: 'u1' },
      { kind: 'response_created', responseId: 'r1' },
      { kind: 'assistant_delta', responseId: 'r1', delta: 'Which course?' },
      { kind: 'user_transcript', id: 'u1', text: 'hello' },
      // turn 2 — answer arrives, then its transcript, then the reply
      { kind: 'speech_started', itemId: 'u2' },
      { kind: 'response_created', responseId: 'r2' },
      { kind: 'assistant_delta', responseId: 'r2', delta: 'Great, and who else?' },
      { kind: 'user_transcript', id: 'u2', text: 'pebble' },
    ]);

    expect(rendered.map((m) => m.text)).toEqual([
      'hello',
      'Which course?',
      'pebble',
      'Great, and who else?',
    ]);
  });

  it('survives phantom/empty/VAD-bounced speech_started without desyncing later turns (item_id identity)', () => {
    // The reviewer-flagged regression: a speech_started that produces NO
    // consuming transcript (VAD false-start / empty transcript) must not shift a
    // later turn's order. With FIFO matching this corrupted ordering for the rest
    // of the session ("reply above the user line" again); with item_id keying the
    // leaked reservation is simply never looked up.
    const rendered = run([
      // phantom: VAD fired, item p0 reserved, but no transcript ever comes
      { kind: 'speech_started', itemId: 'p0' },
      // turn A — real
      { kind: 'speech_started', itemId: 'a' },
      { kind: 'response_created', responseId: 'rA' },
      { kind: 'assistant_delta', responseId: 'rA', delta: 'Reply A' },
      { kind: 'user_transcript', id: 'a', text: 'turn A' },
      // turn B — real; its transcript must NOT grab the stale phantom slot
      { kind: 'speech_started', itemId: 'b' },
      { kind: 'response_created', responseId: 'rB' },
      { kind: 'assistant_delta', responseId: 'rB', delta: 'Reply B' },
      { kind: 'user_transcript', id: 'b', text: 'turn B' },
    ]);

    expect(rendered.map((m) => m.text)).toEqual([
      'turn A',
      'Reply A',
      'turn B',
      'Reply B',
    ]);
  });

  it('coalesces streamed deltas under one id and one stable order key', () => {
    const rendered = run([
      { kind: 'speech_started' },
      { kind: 'response_created', responseId: 'r1' },
      { kind: 'assistant_delta', responseId: 'r1', delta: 'a' },
      { kind: 'assistant_delta', responseId: 'r1', delta: 'b' },
      { kind: 'assistant_delta', responseId: 'r1', delta: 'c' },
      { kind: 'user_transcript', id: 'u1', text: 'hi' },
    ]);
    expect(rendered).toHaveLength(2);
    expect(rendered[1].text).toBe('abc');
  });

  it('orders a typed user message before its reply', () => {
    const rendered = run([
      { kind: 'typed_user', id: 'u1', text: 'what club from 150?' },
      { kind: 'response_created', responseId: 'r1' },
      { kind: 'assistant_delta', responseId: 'r1', delta: 'Seven iron.' },
    ]);
    expect(rendered.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(rendered[0].text).toBe('what club from 150?');
  });

  it('falls back to a fresh slot when a transcript has no reserved speech_started', () => {
    // No speech_started before the transcript (e.g. a dropped event) — must still
    // get a monotonic order and not throw.
    const rendered = run([
      { kind: 'user_transcript', id: 'u1', text: 'orphan' },
      { kind: 'response_created', responseId: 'r1' },
      { kind: 'assistant_delta', responseId: 'r1', delta: 'ok' },
    ]);
    expect(rendered.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('sortByOrder', () => {
  it('does not mutate its input and is stable for equal keys', () => {
    const input = [
      { id: 'b', order: 2 },
      { id: 'a', order: 1 },
      { id: 'c', order: 2 },
    ];
    const out = sortByOrder(input);
    expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    // original untouched
    expect(input.map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('MessageOrderTracker.reset', () => {
  it('clears reserved slots and response keys', () => {
    const t = new MessageOrderTracker();
    t.noteUserTurnStarted();
    t.orderForResponse('r1');
    t.reset();
    // After reset, a fresh response should start the sequence again (=== 1).
    expect(t.orderForResponse('r2')).toBe(1);
  });
});
