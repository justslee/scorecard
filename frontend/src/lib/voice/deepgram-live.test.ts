/**
 * Unit tests for parseDeepgramLiveMessage — the pure parser extracted from
 * DeepgramLiveTranscriber so it can be verified headlessly without a WS or mic.
 *
 * The streaming path itself (token fetch, WS, MediaRecorder) requires device
 * hardware and a live Deepgram connection; those are verified manually on device.
 *
 * DO NOT modify lib/voice/deepgram-live.ts to make these tests pass.
 */

import { describe, it, expect } from 'vitest';
import { parseDeepgramLiveMessage } from './deepgram-live';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMsg(transcript: string, is_final: boolean): string {
  return JSON.stringify({
    channel: { alternatives: [{ transcript }] },
    is_final,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('parseDeepgramLiveMessage', () => {
  it('parses an interim result (is_final = false)', () => {
    const result = parseDeepgramLiveMessage(makeMsg('Justin four', false));
    expect(result).toEqual({ transcript: 'Justin four', isFinal: false });
  });

  it('parses a final result (is_final = true)', () => {
    const result = parseDeepgramLiveMessage(makeMsg('Justin four Bob five', true));
    expect(result).toEqual({ transcript: 'Justin four Bob five', isFinal: true });
  });

  it('returns null for an empty-transcript message', () => {
    const result = parseDeepgramLiveMessage(makeMsg('', false));
    expect(result).toBeNull();
  });

  it('returns null for malformed JSON without throwing', () => {
    expect(() => parseDeepgramLiveMessage('not valid json {')).not.toThrow();
    expect(parseDeepgramLiveMessage('not valid json {')).toBeNull();
  });

  it('returns null for a Deepgram metadata/non-Results message', () => {
    // Deepgram sends metadata frames that lack the 'channel' key.
    const metaMsg = JSON.stringify({ type: 'Metadata', transaction_key: 'abc' });
    expect(parseDeepgramLiveMessage(metaMsg)).toBeNull();
  });

  it('returns null for a message with an empty alternatives array', () => {
    const msg = JSON.stringify({
      channel: { alternatives: [] },
      is_final: false,
    });
    expect(parseDeepgramLiveMessage(msg)).toBeNull();
  });

  it('is_final defaults to false when key is absent', () => {
    // If Deepgram omits is_final (unlikely but possible), treat as interim.
    const msg = JSON.stringify({
      channel: { alternatives: [{ transcript: 'hello' }] },
    });
    const result = parseDeepgramLiveMessage(msg);
    expect(result).toEqual({ transcript: 'hello', isFinal: false });
  });
});
