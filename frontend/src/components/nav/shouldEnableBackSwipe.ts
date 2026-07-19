// Route gate for the global left-edge back-swipe (specs/universal-swipe-back-plan.md).
// Sibling of shouldShowTabBar.ts — same trailing-slash normalization.
import { normalizePath } from './shouldShowTabBar';

export function shouldEnableBackSwipe(pathname: string): boolean {
  if (!pathname) return false;
  const p = normalizePath(pathname);

  // /round/new is SETUP (no hole swipe) — back-swipe ON. Must be checked before
  // the broader /round/ prefix rule (same carve-out as shouldShowCaddieOrb).
  if (p === '/round/new') return true;

  // The in-round yardage book: horizontal swipe = prev/next hole there. Covers
  // BOTH deep-link forms — /round/<uuid> and /round/view (?id= carried in the
  // query; pathname is what we match — see lib/round-url.ts).
  if (p.startsWith('/round/')) return false;

  // Full-screen native map owns the left edge for panning and already has its
  // own back button (map/course/page.tsx handleBack → router.back()).
  if (p === '/map/course') return false;

  // Onboarding (specs/onboarding-shell-and-gate-plan.md §2.15) has no "back" —
  // a left-edge swipe would router.back() to '/' and bounce straight back
  // through the gate, a pointless flash.
  if (p === '/onboarding') return false;

  return true;
}
