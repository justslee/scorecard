// Persona resolution + display adapter tests (agentic caddie P1).
// The point of this module: the caddie must run with REAL backend persona ids
// (classic/strategist/hype/professor/custom-…) — never the cosmetic CADDIES
// list ("steve") that silently fell back to 'classic' server-side.

import { describe, it, expect } from 'vitest';
import {
  personaToCaddy,
  resolvePersonaId,
  shortPersonaName,
  captionPersonaName,
  BUILTIN_PERSONAS,
  DEFAULT_PERSONA_ID,
} from './persona';

describe('resolvePersonaId', () => {
  it('prefers the server profile preference over local + default', () => {
    expect(resolvePersonaId('strategist', 'hype')).toBe('strategist');
  });

  it('falls back to the local selection when the server has none', () => {
    expect(resolvePersonaId(null, 'professor')).toBe('professor');
    expect(resolvePersonaId(undefined, 'hype')).toBe('hype');
  });

  it('floors at classic when nothing is set', () => {
    expect(resolvePersonaId(null, null)).toBe(DEFAULT_PERSONA_ID);
    expect(resolvePersonaId('', '')).toBe('classic');
  });
});

describe('personaToCaddy', () => {
  it('adapts a backend persona to the yardage-book Caddy shape', () => {
    const caddy = personaToCaddy({
      id: 'strategist',
      name: 'The Strategist',
      description: 'Data-driven, DECADE-style.',
      avatar: '📊',
      response_style: 'brief',
      traits: [],
    });
    expect(caddy).toEqual({
      id: 'strategist',
      name: 'The Strategist',
      initial: 'S', // "The " prefix stripped for the medallion
      tag: 'Data-driven, DECADE-style.',
    });
  });

  it('handles custom personas without a "The" prefix', () => {
    const caddy = personaToCaddy({
      id: 'custom-bones-a1b2c3d4',
      name: 'bones',
      description: 'My custom looper',
      avatar: '⛳️',
      response_style: 'conversational',
      traits: [],
    });
    expect(caddy.initial).toBe('B');
    expect(caddy.id).toBe('custom-bones-a1b2c3d4');
  });
});

describe('shortPersonaName', () => {
  it('strips a leading "The " article, case-insensitively', () => {
    expect(shortPersonaName('The Hype Man')).toBe('Hype Man');
    expect(shortPersonaName('the Strategist')).toBe('Strategist');
  });

  it('leaves names without the article untouched', () => {
    expect(shortPersonaName('bones')).toBe('bones');
    expect(shortPersonaName('Theodore')).toBe('Theodore'); // not "The " — no space
  });
});

describe('captionPersonaName', () => {
  it('passes the built-in short names through untouched (all ≤ 10 chars)', () => {
    expect(captionPersonaName('The Hype Man')).toBe('Hype Man');
    expect(captionPersonaName('The Strategist')).toBe('Strategist');
    expect(captionPersonaName('The Professor')).toBe('Professor');
  });

  it('truncates a long custom name on a WORD boundary, never mid-word', () => {
    // "The Sunday Money Maker" → "Sunday Money Maker" (18) → cap 16 lands
    // inside "Maker"; the fix backs up to the last space so no word is severed.
    expect(captionPersonaName('The Sunday Money Maker')).toBe('Sunday Money…');
    expect(captionPersonaName('The Sunday Money Maker')).not.toContain('Mak…');
  });

  it('hard-cuts a single overlong word with no usable space', () => {
    expect(captionPersonaName('Supercalifragilistic')).toBe('Supercalifragili…');
  });

  it('respects a custom max', () => {
    expect(captionPersonaName('Hype Man', 4)).toBe('Hype…');
  });
});

describe('BUILTIN_PERSONAS', () => {
  it('mirrors the four backend built-in ids exactly', () => {
    expect(BUILTIN_PERSONAS.map((p) => p.id).sort()).toEqual([
      'classic',
      'hype',
      'professor',
      'strategist',
    ]);
  });

  it('never contains the old cosmetic ids that broke persona selection', () => {
    const ids = BUILTIN_PERSONAS.map((p) => p.id);
    for (const bad of ['steve', 'fluff', 'uncle', 'caddy']) {
      expect(ids).not.toContain(bad);
    }
  });
});
