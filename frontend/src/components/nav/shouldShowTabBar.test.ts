import { describe, it, expect } from 'vitest';
import { shouldShowTabBar } from './shouldShowTabBar';

describe('shouldShowTabBar', () => {
  // Hub routes (exact)
  it.each(['/', '/players', '/profile', '/tee-time'])(
    'returns true for hub route %s',
    (path) => {
      expect(shouldShowTabBar(path)).toBe(true);
    }
  );

  // Trailing-slash variants of non-root hub routes
  it.each(['/players/', '/profile/', '/tee-time/'])(
    'returns true for trailing-slash variant %s',
    (path) => {
      expect(shouldShowTabBar(path)).toBe(true);
    }
  );

  // Non-hub routes — bar must not appear
  it.each([
    '/round/new',
    '/round/abc123',
    '/round/123/view',
    '/tournament/x',
    '/settings',
    '/sign-in',
    '/sign-up',
    '',
    '/unknown',
    '/playerss',
  ])('returns false for non-hub route %s', (path) => {
    expect(shouldShowTabBar(path)).toBe(false);
  });
});
