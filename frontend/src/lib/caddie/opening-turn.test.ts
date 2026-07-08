/**
 * Unit tests for buildHoleContextText (lib/caddie/opening-turn.ts).
 *
 * specs/caddie-stale-hole-live-plan.md §3.2/§7 — pure, DOM-free, network-free.
 * Kept separate from opening-shot.test.ts (which pins resolveOpeningShotDistance
 * branch logic and stays untouched by this plan).
 */

import { describe, it, expect } from 'vitest';
import { buildHoleContextText, buildOpeningTurnText } from './opening-turn';

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
});

describe('buildOpeningTurnText — unchanged by this plan (sanity check only)', () => {
  it('still produces the natural spoken line, no hole identity baked in', () => {
    expect(buildOpeningTurnText({ distanceYards: 150 })).toBe(
      "I'm about 150 yards from the pin. What should I hit or do on this next shot?",
    );
    expect(buildOpeningTurnText({ distanceYards: 231, fromTee: true })).toBe(
      "I'm on the tee, about 231 yards to the pin. What should I hit off the tee?",
    );
  });
});
