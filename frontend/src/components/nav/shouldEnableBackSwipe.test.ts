import { describe, it, expect } from 'vitest';
import { shouldEnableBackSwipe } from './shouldEnableBackSwipe';

describe('shouldEnableBackSwipe', () => {
  it.each([
    '/',
    '/tee-time',
    '/courses',
    '/players/abc',
    '/profile',
    '/settings',
    '/tournament/view',
    '/tournament/new',
    '/round/new',
    '/round/new/', // trailing slash
  ])('returns true for %s', (path) => {
    expect(shouldEnableBackSwipe(path)).toBe(true);
  });

  it.each([
    '/round/view',
    '/round/view/',
    '/round/8b1f2c3a-1234-5678-9abc-def012345678',
    '/map/course',
    '/map/course/',
    '',
  ])('returns false for %s', (path) => {
    expect(shouldEnableBackSwipe(path)).toBe(false);
  });
});
