import { describe, it, expect } from 'vitest';
import { shouldShowCaddieOrb, isSetupCtaRoute } from './shouldShowCaddieOrb';

describe('shouldShowCaddieOrb', () => {
  it.each(['/', '/courses', '/players', '/profile', '/tee-time', '/settings'])(
    'returns true for exact SHOW route %s',
    (path) => {
      expect(shouldShowCaddieOrb(path)).toBe(true);
    }
  );

  it.each([
    ['/courses/pebble-beach', true], // course detail: SHOWs, resolves to the general converse fallback
    ['/players/42', true],
    ['/tournament/xyz', true],
    ['/round/abc123', false],
    // S3: /round/new now has a registered "round-setup" surface (opens the
    // same VoiceRoundSetupRealtime the removed bespoke mic used to) — SHOWS.
    ['/round/new', true],
    ['/round/new/', true],
    // S3: /tournament/new now has a registered "tournament-setup" task —
    // SHOWS (sticky-CTA overlap solved by orb clearance, not by hiding it).
    ['/tournament/new', true],
  ] as const)('dynamic route %s -> %s', (path, expected) => {
    expect(shouldShowCaddieOrb(path)).toBe(expected);
  });

  it.each(['/map', '/sign-in', '/sign-up'])('returns false for HIDE route %s', (path) => {
    expect(shouldShowCaddieOrb(path)).toBe(false);
  });

  it.each(['', '/unknown', '/round', '/tournament'])(
    'defaults to false for unlisted route %s',
    (path) => {
      expect(shouldShowCaddieOrb(path)).toBe(false);
    }
  );

  it('trailing-slash variants normalize the same as the exact route', () => {
    expect(shouldShowCaddieOrb('/courses/')).toBe(true);
    expect(shouldShowCaddieOrb('/tee-time/')).toBe(true);
  });
});

describe('isSetupCtaRoute', () => {
  it.each(['/round/new', '/round/new/', '/tournament/new', '/tournament/new/'])(
    'returns true for setup CTA route %s',
    (path) => {
      expect(isSetupCtaRoute(path)).toBe(true);
    }
  );

  it.each(['/round/abc123', '/tournament/xyz', '/', '/courses', ''])(
    'returns false for non-setup route %s',
    (path) => {
      expect(isSetupCtaRoute(path)).toBe(false);
    }
  );
});
