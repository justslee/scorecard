// Pure copy-helper tests for edge 3 (held-turn empty-state copy honesty,
// specs/caddie-voice-reliability-hardening-plan.md §3). RED pre-fix for
// status='speaking': before this module existed, LiveVoiceBody's inline
// ternary had no 'speaking' branch, so the empty state kept claiming
// "is listening" while the footer already said "Caddie speaking…" — two
// honest-states claims disagreeing on screen at once.

import { describe, it, expect } from 'vitest';
import { LIVE_STATUS_LABEL, liveEmptyStateHint } from './live-copy';
import type { RealtimeStatus } from '@/lib/voice/realtime';

const ALL_STATUSES: RealtimeStatus[] = [
  'idle',
  'connecting',
  'connected',
  'speaking',
  'listening',
  'closed',
  'error',
];

describe('liveEmptyStateHint', () => {
  it('paused ⇒ the paused hint, regardless of status', () => {
    for (const status of ALL_STATUSES) {
      expect(liveEmptyStateHint(status, true, 'Scotty')).toBe(
        'Paused — tap resume below to keep talking.',
      );
    }
  });

  it('connecting/idle (not paused) ⇒ "Connecting to {name}…"', () => {
    expect(liveEmptyStateHint('connecting', false, 'Scotty')).toBe('Connecting to Scotty…');
    expect(liveEmptyStateHint('idle', false, 'Scotty')).toBe('Connecting to Scotty…');
  });

  it("speaking (not paused) ⇒ \"{name} is speaking.\" — NEW branch, never claims listening", () => {
    expect(liveEmptyStateHint('speaking', false, 'Scotty')).toBe('Scotty is speaking.');
  });

  it('connected/listening (not paused) ⇒ "Go ahead — {name} is listening."', () => {
    expect(liveEmptyStateHint('connected', false, 'Scotty')).toBe('Go ahead — Scotty is listening.');
    expect(liveEmptyStateHint('listening', false, 'Scotty')).toBe('Go ahead — Scotty is listening.');
  });

  it('closed/error (not paused) fall back to the listening hint — never reached live (paused/fallback swap first) but must not throw', () => {
    expect(liveEmptyStateHint('closed', false, 'Scotty')).toBe('Go ahead — Scotty is listening.');
    expect(liveEmptyStateHint('error', false, 'Scotty')).toBe('Go ahead — Scotty is listening.');
  });

  it('branch table: all 7 statuses × paused', () => {
    const table: Array<{ status: RealtimeStatus; paused: boolean; expected: string }> = [
      { status: 'idle', paused: false, expected: 'Connecting to Scotty…' },
      { status: 'idle', paused: true, expected: 'Paused — tap resume below to keep talking.' },
      { status: 'connecting', paused: false, expected: 'Connecting to Scotty…' },
      { status: 'connecting', paused: true, expected: 'Paused — tap resume below to keep talking.' },
      { status: 'connected', paused: false, expected: 'Go ahead — Scotty is listening.' },
      { status: 'connected', paused: true, expected: 'Paused — tap resume below to keep talking.' },
      { status: 'speaking', paused: false, expected: 'Scotty is speaking.' },
      { status: 'speaking', paused: true, expected: 'Paused — tap resume below to keep talking.' },
      { status: 'listening', paused: false, expected: 'Go ahead — Scotty is listening.' },
      { status: 'listening', paused: true, expected: 'Paused — tap resume below to keep talking.' },
      { status: 'closed', paused: false, expected: 'Go ahead — Scotty is listening.' },
      { status: 'closed', paused: true, expected: 'Paused — tap resume below to keep talking.' },
      { status: 'error', paused: false, expected: 'Go ahead — Scotty is listening.' },
      { status: 'error', paused: true, expected: 'Paused — tap resume below to keep talking.' },
    ];
    for (const { status, paused, expected } of table) {
      expect(liveEmptyStateHint(status, paused, 'Scotty')).toBe(expected);
    }
  });
});

describe('liveEmptyStateHint vs LIVE_STATUS_LABEL — the never-contradict invariant', () => {
  it('the empty-state hint never claims "listening" while the footer label claims "speaking"', () => {
    for (const status of ALL_STATUSES) {
      for (const paused of [false, true]) {
        const hint = liveEmptyStateHint(status, paused, 'Scotty');
        const footerLabel = LIVE_STATUS_LABEL[status];
        if (footerLabel === 'Caddie speaking…') {
          expect(hint.toLowerCase()).not.toContain('is listening');
        }
      }
    }
  });

  it('status=speaking, not paused: hint claims speaking and footer claims speaking — agree', () => {
    const hint = liveEmptyStateHint('speaking', false, 'Scotty');
    expect(hint).toBe('Scotty is speaking.');
    expect(LIVE_STATUS_LABEL.speaking).toBe('Caddie speaking…');
    expect(hint.toLowerCase()).not.toContain('is listening');
  });
});
