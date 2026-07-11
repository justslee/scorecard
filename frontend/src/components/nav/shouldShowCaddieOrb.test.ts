import { describe, it, expect } from 'vitest';
import { shouldShowCaddieOrb } from './shouldShowCaddieOrb';

describe('shouldShowCaddieOrb', () => {
  it.each(['/', '/courses', '/players', '/profile', '/tee-time', '/settings'])(
    'returns true for exact SHOW route %s',
    (path) => {
      expect(shouldShowCaddieOrb(path)).toBe(true);
    }
  );

  it.each([
    ['/courses/pebble-beach', false], // dead mic today: no listener on course detail — deferred to S2
    ['/players/42', true],
    ['/tournament/xyz', true],
    ['/round/abc123', false],
    // forked mic: /round/new has its own bespoke voice-setup mic + sticky
    // "Tee off" CTA — deferred to S3, which unifies them
    ['/round/new', false],
    ['/tournament/new', false], // sticky "Create tournament" CTA collision
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
