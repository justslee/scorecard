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
    '/onboarding',
    '/onboarding/',
    '',
  ])('returns false for %s', (path) => {
    expect(shouldEnableBackSwipe(path)).toBe(false);
  });

  // F4 (login-onboarding-epic-polish-review §4) — auth routes: AuthGate
  // passes these through ungated, so a left-edge swipe there would
  // router.back() into a gated route and immediately bounce back.
  it.each([
    '/sign-in',
    '/sign-in/',
    '/sign-in/sso-callback',
    '/sign-up',
    '/sign-up/',
    '/sign-up/verify',
    '/sso-callback',
    '/sso-callback/',
  ])('returns false for auth route %s', (path) => {
    expect(shouldEnableBackSwipe(path)).toBe(false);
  });
});
