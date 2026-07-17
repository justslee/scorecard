// Pure copy-helper tests for edge 3 (held-turn empty-state copy honesty,
// specs/caddie-voice-reliability-hardening-plan.md §3). RED pre-fix for
// status='speaking': before this module existed, LiveVoiceBody's inline
// ternary had no 'speaking' branch, so the empty state kept claiming
// "is listening" while the footer already said "Caddie speaking…" — two
// honest-states claims disagreeing on screen at once.

import { describe, it, expect } from 'vitest';
import {
  LIVE_STATUS_LABEL,
  liveStatusLabel,
  liveEmptyStateHint,
  LIVE_CONNECT_RETRYING_LABEL,
  LIVE_CONNECT_FAILED_LABEL,
} from './live-copy';
import { captionPersonaName } from './persona';
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

// specs/caddie-live-p0-connect-hole-plan.md §2.3 — Bug A connect-stall UX.
describe('liveEmptyStateHint — retrying branch (Bug A)', () => {
  it('the new placeholder labels exist and are calm, non-alarming strings', () => {
    expect(typeof LIVE_CONNECT_RETRYING_LABEL).toBe('string');
    expect(LIVE_CONNECT_RETRYING_LABEL.length).toBeGreaterThan(0);
    expect(typeof LIVE_CONNECT_FAILED_LABEL).toBe('string');
    expect(LIVE_CONNECT_FAILED_LABEL.length).toBeGreaterThan(0);
  });

  it('retrying=true ⇒ a distinct "still connecting" hint, regardless of status', () => {
    for (const status of ALL_STATUSES) {
      expect(liveEmptyStateHint(status, false, 'Scotty', true)).toBe('Still connecting to Scotty…');
    }
  });

  it('paused still wins over retrying (paused is checked first)', () => {
    expect(liveEmptyStateHint('connecting', true, 'Scotty', true)).toBe(
      'Paused — tap resume below to keep talking.',
    );
  });

  it('retrying defaults to false — byte-identical to the pre-Bug-A behavior when omitted', () => {
    expect(liveEmptyStateHint('connecting', false, 'Scotty')).toBe('Connecting to Scotty…');
    expect(liveEmptyStateHint('listening', false, 'Scotty')).toBe('Go ahead — Scotty is listening.');
  });

  it('the retrying hint must not contradict the footer — footer still says "Connecting…" for status=connecting, never claims listening/speaking', () => {
    const hint = liveEmptyStateHint('connecting', false, 'Scotty', true);
    const footerLabel = liveStatusLabel('connecting', 'Scotty');
    expect(footerLabel).toBe('Connecting…');
    expect(hint.toLowerCase()).not.toContain('is listening');
    expect(hint.toLowerCase()).not.toContain('is speaking');
  });
});

describe('liveEmptyStateHint vs liveStatusLabel — the never-contradict invariant', () => {
  it('the empty-state hint never claims "listening" while the footer label claims "speaking"', () => {
    for (const status of ALL_STATUSES) {
      for (const paused of [false, true]) {
        const hint = liveEmptyStateHint(status, paused, 'Scotty');
        const footerLabel = liveStatusLabel(status, 'Scotty');
        if (footerLabel === 'Scotty is speaking…') {
          expect(hint.toLowerCase()).not.toContain('is listening');
        }
      }
    }
  });

  it('status=speaking, not paused: hint claims speaking and footer claims speaking — agree', () => {
    const hint = liveEmptyStateHint('speaking', false, 'Scotty');
    expect(hint).toBe('Scotty is speaking.');
    // Persona-named, not the old generic "Caddie speaking…" — cycle-133 nit
    // 2 (specs/caddie-coherence-polish-plan.md §2): a generic label two
    // lines above a persona-named transcript caption is exactly the
    // two-honest-states-disagree bug this module exists to prevent.
    expect(liveStatusLabel('speaking', 'Scotty')).toBe('Scotty is speaking…');
    expect(hint.toLowerCase()).not.toContain('is listening');
  });

  it('LIVE_STATUS_LABEL stays name-free (speaking is resolved only via liveStatusLabel)', () => {
    expect(LIVE_STATUS_LABEL.idle).toBe('Connecting…');
    expect(LIVE_STATUS_LABEL.connecting).toBe('Connecting…');
    expect(LIVE_STATUS_LABEL.connected).toBe('Ready — go ahead');
    expect(LIVE_STATUS_LABEL.listening).toBe('Listening…');
    expect(LIVE_STATUS_LABEL.closed).toBe('Ended');
    expect(LIVE_STATUS_LABEL.error).toBe("Couldn't connect");
  });
});

// specs/caddie-coherence-polish-plan.md §4 — the empty-hint name and the
// transcript speakerLabel must be byte-identical for a long (>16 char)
// custom persona name. Both CaddieSheet.tsx call sites resolve
// `captionPersonaName(caddy.name)` and pass that SAME value into
// `liveEmptyStateHint`/`liveStatusLabel` (footer) and `Transcript`'s
// `speakerLabel` prop (:1829) — this guards that the shared resolution,
// not two independent ones, is what both consumers see.
describe('long custom persona name — empty-hint/footer name matches transcript speakerLabel', () => {
  const longName = 'Sunday Money Maker Supreme'; // > 16 chars, multi-word
  const resolved = captionPersonaName(longName);

  it('captionPersonaName truncates on a word boundary with an ellipsis', () => {
    expect(longName.length).toBeGreaterThan(16);
    expect(resolved.length).toBeLessThanOrEqual(17); // 16 chars + '…'
    expect(resolved.endsWith('…')).toBe(true);
  });

  it('liveEmptyStateHint (listening) carries the exact resolved name', () => {
    expect(liveEmptyStateHint('listening', false, resolved)).toBe(
      `Go ahead — ${resolved} is listening.`,
    );
  });

  it('liveEmptyStateHint (speaking) and liveStatusLabel (footer) agree on the exact resolved name', () => {
    expect(liveEmptyStateHint('speaking', false, resolved)).toBe(`${resolved} is speaking.`);
    expect(liveStatusLabel('speaking', resolved)).toBe(`${resolved} is speaking…`);
  });
});
