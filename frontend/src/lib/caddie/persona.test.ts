// Persona resolution + display adapter tests (agentic caddie P1).
// The point of this module: the caddie must run with REAL backend persona ids
// (classic/strategist/hype/professor/custom-…) — never the cosmetic CADDIES
// list ("steve") that silently fell back to 'classic' server-side.

import { describe, it, expect } from 'vitest';
import {
  personaToCaddy,
  resolvePersonaId,
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
