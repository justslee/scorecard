/**
 * Unit tests for buildHoleContextText (lib/caddie/opening-turn.ts).
 *
 * specs/caddie-stale-hole-live-plan.md §3.2/§7 — pure, DOM-free, network-free.
 * Kept separate from opening-shot.test.ts (which pins resolveOpeningShotDistance
 * branch logic and stays untouched by this plan).
 */

import { describe, it, expect } from 'vitest';
import { buildHoleContextText, buildOpeningGreetingText, buildOpeningGreetingInstruction } from './opening-turn';

describe('buildHoleContextText', () => {
  it('states the hole, par, and yards as ground truth, and directs tool calls to that hole', () => {
    const text = buildHoleContextText({ holeNumber: 3, par: 3, yards: 178 });
    expect(text).toContain('hole 3');
    expect(text).toContain('par 3');
    expect(text).toContain('178');
    expect(text).toContain('hole_number 3');
    expect(text.toLowerCase()).toContain('disregard any earlier hole');
  });

  it('never answers from a previous hole — explicit instruction present', () => {
    const text = buildHoleContextText({ holeNumber: 7, par: 4, yards: 402 });
    expect(text.toLowerCase()).toContain('never answer from a previous hole');
    expect(text).toContain('hole 7');
    expect(text).toContain('par 4');
    expect(text).toContain('402');
  });

  it('is a single tight sentence-flow string (no line breaks) — safe for a silent context item', () => {
    const text = buildHoleContextText({ holeNumber: 1, par: 5, yards: 540 });
    expect(text).not.toContain('\n');
  });

  it('null yards (nothing honest known yet) omits a fabricated number — never falls back to a guess', () => {
    const text = buildHoleContextText({ holeNumber: 3, par: 3, yards: null });
    expect(text).toContain('yardage not yet known');
    expect(text).not.toMatch(/\d+ yards/);
  });

  it('gps basis labels provenance — "GPS from where the player stands NOW"', () => {
    const text = buildHoleContextText({ holeNumber: 3, par: 3, yards: 204, basis: 'gps' });
    expect(text).toContain('204 yards');
    expect(text).toContain('GPS from where the player stands NOW');
  });

  it('tee-card/tee-geom basis with a teeName labels "from the {tee} tees"', () => {
    const text = buildHoleContextText({
      holeNumber: 3, par: 3, yards: 231, basis: 'tee-card', teeName: 'Black',
    });
    expect(text).toContain('231 yards from the Black tees');
  });

  it('tee-card basis WITHOUT a teeName falls back to a bare number — never claims a tee it can\'t name', () => {
    const text = buildHoleContextText({ holeNumber: 3, par: 3, yards: 231, basis: 'tee-card', teeName: null });
    expect(text).toContain('231 yards');
    expect(text).not.toContain('from the');
  });
});

describe('buildOpeningGreetingText — caddie-authored opener', () => {
  it('produces the non-tee greeting, in the caddie\'s own voice', () => {
    expect(buildOpeningGreetingText({ distanceYards: 150 })).toBe(
      'About 150 to the pin from here. Want a read on the shot?',
    );
  });

  it('produces the tee greeting, in the caddie\'s own voice', () => {
    expect(buildOpeningGreetingText({ distanceYards: 231, fromTee: true })).toBe(
      "You're on the tee — about 231 to the pin. Want a read on the tee shot?",
    );
  });

  it('authorship lock: never fabricates a first-person player line', () => {
    expect(buildOpeningGreetingText({ distanceYards: 150 })).not.toContain("I'm");
    expect(buildOpeningGreetingText({ distanceYards: 231, fromTee: true })).not.toContain("I'm");
  });

  it('always includes the distance', () => {
    expect(buildOpeningGreetingText({ distanceYards: 150 })).toContain('150');
    expect(buildOpeningGreetingText({ distanceYards: 231, fromTee: true })).toContain('231');
  });
});

describe('buildOpeningGreetingInstruction — live-mode wrapper', () => {
  it('contains the greeting verbatim (single-source-of-truth lock)', () => {
    const shot = { distanceYards: 150 };
    expect(buildOpeningGreetingInstruction(shot)).toContain(buildOpeningGreetingText(shot));
  });

  it('contains the tee greeting verbatim', () => {
    const shot = { distanceYards: 231, fromTee: true };
    expect(buildOpeningGreetingInstruction(shot)).toContain(buildOpeningGreetingText(shot));
  });

  it('instructs the model to speak in its own voice', () => {
    expect(buildOpeningGreetingInstruction({ distanceYards: 150 })).toMatch(/your own voice/i);
  });

  it('states the player has not spoken yet', () => {
    expect(buildOpeningGreetingInstruction({ distanceYards: 150 })).toMatch(/has not said anything/i);
  });

  it('differs between tee and non-tee only via the embedded greeting', () => {
    const nonTee = buildOpeningGreetingInstruction({ distanceYards: 150 });
    const tee = buildOpeningGreetingInstruction({ distanceYards: 150, fromTee: true });
    expect(nonTee).not.toBe(tee);
    expect(nonTee.replace(buildOpeningGreetingText({ distanceYards: 150 }), '')).toBe(
      tee.replace(buildOpeningGreetingText({ distanceYards: 150, fromTee: true }), ''),
    );
  });
});
