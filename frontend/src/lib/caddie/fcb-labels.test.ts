/**
 * Unit tests for fcbSourceCaption, playsSubLabel, and lineVsCardHint
 * (lib/caddie/fcb-labels.ts).
 *
 * These run headless (no React, no browser) via vitest node environment.
 * Coverage targets:
 *   - fcbSourceCaption: both source states ("you" / "tee")
 *   - playsSubLabel: all 8 hasWind/hasElev/isLive branches
 *   - lineVsCardHint: the >5% boundary (just under / at / over), null/NaN/0
 *
 * DO NOT modify lib/caddie/fcb-labels.ts to make tests pass; fix the logic.
 */

import { describe, it, expect } from 'vitest';
import { fcbSourceCaption, playsSubLabel, lineVsCardHint } from './fcb-labels';

// ---------------------------------------------------------------------------
// fcbSourceCaption
// ---------------------------------------------------------------------------

describe('fcbSourceCaption', () => {
  it('source "you" → live caption with accent dot', () => {
    expect(fcbSourceCaption('you')).toEqual({
      text: '● from where you stand',
      isLive: true,
    });
  });

  it('source "tee" → non-live caption, no accent dot', () => {
    expect(fcbSourceCaption('tee')).toEqual({
      text: 'from the tee',
      isLive: false,
    });
  });

  it('source "card" → the honest fallback caption, no accent dot (multi-tee-anchor-reconciliation §fix.5)', () => {
    expect(fcbSourceCaption('card')).toEqual({
      text: 'from the card',
      isLive: false,
    });
  });
});

// ---------------------------------------------------------------------------
// playsSubLabel
// ---------------------------------------------------------------------------

describe('playsSubLabel', () => {
  it('wind + elev + live → "wind+elev · you" (physics-tiles-coherence: the newly-possible live+elev state)', () => {
    expect(playsSubLabel({ hasWind: true, hasElev: true, isLive: true })).toBe(
      'wind+elev · you',
    );
  });

  it('wind + no elev + live → "wind from you"', () => {
    expect(playsSubLabel({ hasWind: true, hasElev: false, isLive: true })).toBe(
      'wind from you',
    );
  });

  it('wind + elev + not live → "wind+elev" (the renamed branch)', () => {
    expect(playsSubLabel({ hasWind: true, hasElev: true, isLive: false })).toBe(
      'wind+elev',
    );
  });

  it('wind + no elev + not live → "wind-adj"', () => {
    expect(playsSubLabel({ hasWind: true, hasElev: false, isLive: false })).toBe(
      'wind-adj',
    );
  });

  it('no wind + elev + not live → "elev-adj"', () => {
    expect(playsSubLabel({ hasWind: false, hasElev: true, isLive: false })).toBe(
      'elev-adj',
    );
  });

  it('no wind + elev + live → "elev from you" (physics-tiles-coherence: newly-possible live+elev state)', () => {
    expect(playsSubLabel({ hasWind: false, hasElev: true, isLive: true })).toBe(
      'elev from you',
    );
  });

  it('no wind + no elev + live → "from you"', () => {
    expect(playsSubLabel({ hasWind: false, hasElev: false, isLive: true })).toBe(
      'from you',
    );
  });

  it('no wind + no elev + not live → "from tee"', () => {
    expect(playsSubLabel({ hasWind: false, hasElev: false, isLive: false })).toBe(
      'from tee',
    );
  });

  it('fromCard + no wind → "from card" (honest card-only fallback)', () => {
    expect(playsSubLabel({ hasWind: false, hasElev: false, isLive: false, fromCard: true })).toBe(
      'from card',
    );
  });

  it('fromCard + wind → "wind on card"', () => {
    expect(playsSubLabel({ hasWind: true, hasElev: false, isLive: false, fromCard: true })).toBe(
      'wind on card',
    );
  });

  it('fromCard + wind + elev → still "wind on card" — NEVER claims elev on unusable geometry', () => {
    expect(playsSubLabel({ hasWind: true, hasElev: true, isLive: false, fromCard: true })).toBe(
      'wind on card',
    );
  });

  it('fromCard takes precedence even when isLive is true (defensive — should never co-occur in practice)', () => {
    expect(playsSubLabel({ hasWind: false, hasElev: false, isLive: true, fromCard: true })).toBe(
      'from card',
    );
  });
});

// ---------------------------------------------------------------------------
// lineVsCardHint
// ---------------------------------------------------------------------------

describe('lineVsCardHint', () => {
  it('just under 5% (4.4%) → hidden', () => {
    expect(lineVsCardHint(522, 500)).toEqual({ show: false, text: '' });
  });

  it('exactly 5% → hidden (strictly >)', () => {
    expect(lineVsCardHint(525, 500)).toEqual({ show: false, text: '' });
  });

  it('just over 5% (5.2%) → shown, "line"', () => {
    expect(lineVsCardHint(526, 500)).toEqual({ show: true, text: 'line' });
  });

  it('shorter side over 5% (6%) → shown, "line"', () => {
    expect(lineVsCardHint(470, 500)).toEqual({ show: true, text: 'line' });
  });

  it('null center → hidden', () => {
    expect(lineVsCardHint(null, 500)).toEqual({ show: false, text: '' });
  });

  it('undefined center → hidden', () => {
    expect(lineVsCardHint(undefined, 500)).toEqual({ show: false, text: '' });
  });

  it('NaN center → hidden', () => {
    expect(lineVsCardHint(NaN, 500)).toEqual({ show: false, text: '' });
  });

  it('cardYards 0 → hidden (no divide-by-zero)', () => {
    expect(lineVsCardHint(522, 0)).toEqual({ show: false, text: '' });
  });
});
